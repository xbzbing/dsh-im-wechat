/**
 * 长程任务提醒（文本版）。
 *
 * 订阅宿主的 `session/event`，跟踪每个根会话的回合：`turn/start` 记开始时间，
 * `assistant/message` 攒最后一段可见文本，`turn/end` 判定成败；**耗时超过阈值**
 * 的回合结束时，把「标题 + 耗时 + 结论」发到微信。
 *
 * 为什么不复用核心的通知：核心接管后（接入我的超级助理）提醒由核心发交付，
 * 这里必须停掉，否则同一条提醒会来两遍（ADR-0006）。所以只在自有功能生效时工作。
 *
 * 与如流实现的差别：只用文本、不发卡片；不做「安静期」（用完即发），避免主人
 * 关掉面板后仍然收不到；阈值可配。
 */

export interface LongTaskLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface SessionEvent {
  type?: unknown;
  seq?: unknown;
  time?: unknown;
  data?: unknown;
}

export interface LongTaskNotifierOptions {
  /** 发提醒（文本）；返回是否发出。 */
  send: (text: string) => Promise<boolean>;
  /** 收件人；未登录/停用时返回 null。 */
  recipient: () => string | null;
  /** 只提醒根会话。 */
  isRoot: (sessionId: string) => boolean;
  /** 会话标题（提醒里显示人看得懂的名字）；取不到时用「未命名会话」。 */
  titleOf?: (sessionId: string) => string | null;
  now?: () => number;
  logger?: LongTaskLogger;
  /** 超过这个时长才算「长任务」。 */
  thresholdMs?: number;
  /** 单条提醒的字符上限，超长截断（不丢结论的头）。 */
  maxChars?: number;
  /** 同时跟踪的会话上限。 */
  maxTracked?: number;
}

interface SessionRecord {
  startedAt: number;
  turn: number | undefined;
  answer: string;
  running: boolean;
  /** 本回合里是否问过问题（问过就不再发长任务提醒，问题提醒已经打扰过）。 */
  interacted: boolean;
  /** 目标的一句话描述：提醒里说清「这是在干什么」。 */
  objective: string;
}

const UNTITLED_SESSION = '未命名会话';
const DEFAULT_THRESHOLD_MS = 10 * 60_000;
const DEFAULT_MAX_CHARS = 1_800;
const TRACKED_MAX = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 只取可见文本块，跳过 reasoning / 图片 / 工具块。 */
export function textFromAssistantMessage(message: unknown): string {
  const content = asRecord(message)?.content;
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  for (const block of blocks) {
    const item = asRecord(block);
    if (item && item.type === 'text' && typeof item.text === 'string') text += item.text;
  }
  return text;
}

function durationText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

/** 提醒正文：标题、耗时、结果，空一行再给结论。 */
export function longTaskText(params: {
  title: string;
  objective?: string;
  durationMs: number;
  failed: boolean;
  answer: string;
  maxChars: number;
}): string {
  const heading = `长任务提醒 · ${params.title}`;
  const meta = [
    `耗时：${durationText(params.durationMs)}`,
    params.objective ? `目标：${params.objective.slice(0, 120)}` : '',
    `结果：${params.failed ? '执行失败' : '已完成'}`,
  ].filter(Boolean).join('\n');
  const body = params.answer.trim();
  const text = body === '' ? `${heading}\n\n${meta}\n\n没有可提取的文本结论，请到 Web 查看。` : `${heading}\n\n${meta}\n\n${body}`;
  return text.length <= params.maxChars ? text : `${text.slice(0, Math.max(0, params.maxChars - 1))}…`;
}

export class LongTaskNotifier {
  readonly #options: LongTaskNotifierOptions;
  readonly #now: () => number;
  readonly #thresholdMs: number;
  readonly #maxChars: number;
  readonly #records = new Map<string, SessionRecord>();
  /** 目标先于回合到达时暂存，`turn/start` 时带上。 */
  readonly #objectives = new Map<string, string>();
  #enabled = false;

  constructor(options: LongTaskNotifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.#maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  /** 自有功能生效时才打开；关掉时丢弃已有跟踪。 */
  configure(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.#records.clear();
  }

  get tracking(): number {
    return this.#records.size;
  }

  /** `session/event` 监听器实现。 */
  handleEvent(sessionId: unknown, event: unknown): void {
    if (!this.#enabled) return;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    const entry = asRecord(event) as SessionEvent | null;
    if (!entry || typeof entry.type !== 'string') return;
    if (!this.#isRoot(sessionId)) return;

    const data = asRecord(entry.data) ?? {};
    const at = typeof entry.time === 'number' && Number.isFinite(entry.time) ? entry.time : this.#now();

    switch (entry.type) {
      case 'goal/change': {
        // 目标变化时记下 objective，提醒里带上；clear 就忘掉。
        const operation = typeof data.operation === 'string' ? data.operation : '';
        const goal = asRecord(data.goal);
        const objective = typeof goal?.objective === 'string' ? goal.objective.trim() : '';
        if (operation === 'clear' || objective === '') return;
        const record = this.#records.get(sessionId);
        if (record) record.objective = objective;
        else this.#objectives.set(sessionId, objective);
        return;
      }
      case 'turn/start':
        this.#start(sessionId, typeof data.turn === 'number' ? data.turn : undefined, at);
        return;
      case 'assistant/message': {
        const record = this.#records.get(sessionId);
        const text = textFromAssistantMessage(data.message);
        if (record && text !== '') record.answer = text;
        return;
      }
      case 'user/message': {
        // 主人在本回合里答过问题/插过话：这段时间不算「无人值守的长任务」。
        const record = this.#records.get(sessionId);
        const source = asRecord(data.source);
        if (record && (source?.kind === 'user' || source?.kind === 'user-question-reply')) record.interacted = true;
        return;
      }
      case 'turn/end':
        this.#end(sessionId, data, at);
        return;
      default:
        return;
    }
  }

  /** 会话被销毁时清掉跟踪。 */
  clearSession(sessionId: string): void {
    this.#records.delete(sessionId);
    this.#objectives.delete(sessionId);
  }

  clear(): void {
    this.#records.clear();
    this.#objectives.clear();
  }

  #isRoot(sessionId: string): boolean {
    try {
      return this.#options.isRoot(sessionId) === true;
    } catch {
      return false;
    }
  }

  #start(sessionId: string, turn: number | undefined, at: number): void {
    const existing = this.#records.get(sessionId);
    if (existing?.running && existing.turn === turn) return;
    const objective = this.#objectives.get(sessionId) ?? '';
    this.#records.set(sessionId, { startedAt: at, turn, answer: '', running: true, interacted: false, objective });
    while (this.#records.size > TRACKED_MAX) {
      const oldest = this.#records.keys().next();
      if (oldest.done) break;
      this.#records.delete(oldest.value);
    }
  }

  #end(sessionId: string, data: Record<string, unknown>, at: number): void {
    const record = this.#records.get(sessionId);
    if (!record?.running) return;
    record.running = false;
    const duration = at - record.startedAt;
    const failed = Boolean(asRecord(data.error) ?? data.reason);
    if (record.interacted || duration <= this.#thresholdMs) {
      this.#records.delete(sessionId);
      return;
    }
    const recipient = this.#options.recipient();
    if (recipient === null) {
      this.#records.delete(sessionId);
      return;
    }
    const title = this.#title(sessionId);
    const text = longTaskText({
      title,
      ...(record.objective !== '' ? { objective: record.objective } : {}),
      durationMs: duration,
      failed,
      answer: record.answer,
      maxChars: this.#maxChars,
    });
    this.#records.delete(sessionId);
    void this.#options.send(text).catch((error: unknown) => {
      this.#options.logger?.warn?.('长任务提醒发送失败', (error as Error)?.message);
    });
  }

  #title(sessionId: string): string {
    try {
      const title = this.#options.titleOf?.(sessionId);
      return title && title.trim() !== '' ? title.trim() : UNTITLED_SESSION;
    } catch {
      return UNTITLED_SESSION;
    }
  }
}
