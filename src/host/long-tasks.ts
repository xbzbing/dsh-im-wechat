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
 * 关掉面板后仍然收不到；阈值默认 30 分钟，单位全程是**分钟**（配置、面板、状态
 * 都同一个数），由 `setThresholdMinutes` 改，改完对已经在跟踪的回合也生效。
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
  /** 超过这么多分钟才算「长任务」；默认 30。 */
  thresholdMinutes?: number;
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
  /** 是否已经见过本回合的第一条用户消息（开头那条 prompt 不算插话）。 */
  promptSeen: boolean;
}

/** 长任务阈值（分钟）：默认半小时；低于 1 分钟没有意义，上限一天。 */
export const DEFAULT_LONG_TASK_MINUTES = 30;
export const MIN_LONG_TASK_MINUTES = 1;
export const MAX_LONG_TASK_MINUTES = 24 * 60;

const UNTITLED_SESSION = '未命名会话';
const MINUTE_MS = 60_000;
const DEFAULT_MAX_CHARS = 1_800;
const TRACKED_MAX = 100;

/** 把外部给的分钟数收窄到可用区间；不是数字就返回 undefined（交给默认值）。 */
export function normalizeLongTaskMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_LONG_TASK_MINUTES, Math.max(MIN_LONG_TASK_MINUTES, Math.round(value)));
}

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
  #thresholdMinutes: number;
  readonly #maxChars: number;
  readonly #records = new Map<string, SessionRecord>();
  /** 目标先于回合到达时暂存，`turn/start` 时带上。 */
  readonly #objectives = new Map<string, string>();
  #enabled = false;

  constructor(options: LongTaskNotifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#thresholdMinutes = options.thresholdMinutes ?? DEFAULT_LONG_TASK_MINUTES;
    this.#maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  }

  /** 自有功能生效时才打开；关掉时丢弃已有跟踪。 */
  configure(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) this.clear();
  }

  get tracking(): number {
    return this.#records.size;
  }

  /** 当前阈值（分钟）：状态快照直接读它，避免运行期再存一份可能分叉的数。 */
  get thresholdMinutes(): number {
    return this.#thresholdMinutes;
  }

  /** 改阈值：面板保存后立即生效，不重建跟踪器（已跟踪的回合按新阈值判定）。 */
  setThresholdMinutes(minutes: number): void {
    this.#thresholdMinutes = minutes;
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
        if (operation === 'clear' || objective === '') {
          // 目标被清掉：记录里也不能留旧目标，否则后续提醒继续显示已经不存在的目标。
          this.#objectives.delete(sessionId);
          const current = this.#records.get(sessionId);
          if (current) current.objective = '';
          return;
        }
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
        // 回合开头的 prompt 本身就是用户消息（agent-loop 先 turn/start 再 append），
        // 不能算「插话」，否则每个主人发起的回合都会被判成被打断、提醒永不触发。
        const record = this.#records.get(sessionId);
        if (!record) return;
        const source = asRecord(data.source);
        if (source?.kind === 'user-question-reply') {
          record.interacted = true;
          return;
        }
        if (source?.kind !== 'user') return;
        if (!record.promptSeen) record.promptSeen = true;
        else record.interacted = true;
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
    this.#records.set(sessionId, {
      startedAt: at,
      turn,
      answer: '',
      running: true,
      interacted: false,
      objective,
      promptSeen: false,
    });
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
    // 宿主的 turn/end 是 `{turn, reason}`，reason 恒定是对象；失败要读 `reason.kind`。
    const reason = asRecord(data.reason);
    const kind = typeof reason?.kind === 'string' ? reason.kind : '';
    const failed = kind !== '' && kind !== 'completed' && kind !== 'max-tokens';
    if (record.interacted || duration <= this.#thresholdMinutes * MINUTE_MS) {
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
