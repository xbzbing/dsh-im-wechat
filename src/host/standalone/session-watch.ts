/**
 * 独立模式的会话观察者：`/send` 等一轮回答、`/trace` 跟踪任意会话。
 *
 * 事件来自宿主的 `session/event`（每条持久化事件同步回调一次），不为每个会话开
 * `follow()` 流：一个监听器覆盖所有会话，不会因订阅而激活冷会话。代价是只看得到
 * 监听器注册之后、且会话处于活跃状态时写入的事件——`/send` 与 `/trace` 都从这个
 * 时间点开始折叠，够用了。
 *
 * 回调里只做状态折叠（同步、不抛），发送放进按会话串行的队列。
 */

import { textFromAssistantMessage } from '../long-tasks.ts';
import { MAX_TEXT_BYTES, splitText, toWeChatMarkdown } from '../superagent/render.ts';
import { sessionIdMatches } from './command-text.ts';
import { MAX_TRACES } from '../state/standalone-commands.ts';
import type { TraceEntry } from '../state/standalone-commands.ts';

/** `/trace` 不写时长时跟踪多少分钟。 */
export const DEFAULT_TRACE_MINUTES = 30;

/** 单次跟踪的时长上限（分钟）。 */
export const MAX_TRACE_MINUTES = 1_440;

/** `/send` 等一轮回答的上限：超时就不再等，避免表里一直挂着一条。 */
const SEND_TIMEOUT_MS = 30 * 60_000;

/** 推送里提问摘要的最大字数。 */
const PROMPT_PREVIEW_MAX = 100;

const UNTITLED = '未命名会话';

export interface SessionWatchStore {
  traces(): readonly TraceEntry[];
  setTraces(entries: readonly TraceEntry[]): Promise<unknown>;
}

export interface SessionWatchOptions {
  /** 发回主人的微信；返回是否发出。 */
  send: (text: string) => Promise<boolean>;
  store: SessionWatchStore;
  now?: () => number;
  logger?: { warn?(...args: unknown[]): unknown };
  maxText?: number;
  /** 测试注入的定时器（生产用 `setTimeout().unref()`）。 */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface TurnState {
  prompt: string;
  answer: string;
  sawPrompt: boolean;
}

interface SendWatch {
  title: string;
  until: number;
  /**
   * 提交时目标会话正在跑、且用的是排队：我们这条还没轮到，先到的 `turn/end` 属于
   * 上一轮，不能当成「这一轮的回答」发回去。
   */
  pendingStart: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** 用户消息里的可见文本（跳过图片、附件）。 */
function promptText(message: Record<string, unknown>): string {
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .map((block) => {
      const item = asRecord(block);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('')
    .trim();
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_PREVIEW_MAX ? `${flat.slice(0, PROMPT_PREVIEW_MAX - 1)}…` : flat;
}

function defaultSetTimer(callback: () => void, ms: number): unknown {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return handle;
}

function defaultClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

export class SessionWatcher {
  readonly #send: (text: string) => Promise<boolean>;
  readonly #store: SessionWatchStore;
  readonly #now: () => number;
  readonly #logger: SessionWatchOptions['logger'];
  readonly #maxText: number;
  readonly #setTimer: (callback: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  #traces: TraceEntry[];
  readonly #sends = new Map<string, SendWatch>();
  readonly #turns = new Map<string, TurnState>();
  readonly #timers = new Map<string, unknown>();
  readonly #sendTimers = new Map<string, unknown>();
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: SessionWatchOptions) {
    this.#send = options.send;
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
    this.#logger = options.logger;
    this.#maxText = options.maxText ?? MAX_TEXT_BYTES;
    this.#setTimer = options.setTimer ?? defaultSetTimer;
    this.#clearTimer = options.clearTimer ?? defaultClearTimer;
    this.#traces = [...this.#store.traces()];
  }

  /** 启动：从持久态重读跟踪（构造时 store 还没 hydrate），丢掉到期的并排定时器。 */
  start(): number {
    this.#traces = [...this.#store.traces()];
    const now = this.#now();
    const kept = this.#traces.filter((entry) => entry.until > now);
    const dropped = this.#traces.length - kept.length;
    if (dropped > 0) this.#persist(kept);
    this.#traces = kept;
    for (const entry of kept) this.#schedule(entry);
    return dropped;
  }

  /** 停机：只收定时器，跟踪列表保留（下次启动继续计时）。 */
  stop(): void {
    for (const handle of this.#timers.values()) this.#clearTimer(handle);
    this.#timers.clear();
    for (const handle of this.#sendTimers.values()) this.#clearTimer(handle);
    this.#sendTimers.clear();
  }

  /** 未到期的跟踪；序号即 `/trace stop <序号>` 用的序号。 */
  list(now = this.#now()): TraceEntry[] {
    return this.#traces.filter((entry) => entry.until > now).map((entry) => ({ ...entry }));
  }

  /** 跟踪 `minutes` 分钟；已在跟踪的从现在起重新计时（`renewed`），超过上限返回 `full`。 */
  async add(sessionId: string, title: string, minutes = DEFAULT_TRACE_MINUTES): Promise<'added' | 'renewed' | 'full'> {
    const now = this.#now();
    const until = now + minutes * 60_000;
    const existing = this.#traces.find((entry) => entry.sessionId === sessionId);
    if (existing) {
      existing.until = until;
      existing.title = title;
      await this.#persist([...this.#traces]);
      this.#schedule(existing);
      return 'renewed';
    }
    if (this.#traces.length >= MAX_TRACES) return 'full';
    const entry: TraceEntry = { sessionId, title, since: now, until };
    this.#traces = [...this.#traces, entry];
    await this.#persist([...this.#traces]);
    this.#schedule(entry);
    return 'added';
  }

  /**
   * 停止跟踪。`target` 为空停全部；否则按会话 id（完整或唯一前缀）找一个，
   * 找不到或前缀有歧义时什么都不停。返回停掉的条目。
   *
   * 序号不在这里解释：编号来自 `/sessions` 快照，由命令层先定位成 sessionId
   * 再传进来，避免「跟踪列表序号」与「会话列表序号」两套编号。
   */
  async remove(target = ''): Promise<TraceEntry[]> {
    const entries = this.list();
    const token = target.trim();
    let removed: TraceEntry[];
    if (token === '') {
      removed = entries;
    } else {
      const prefixed = entries.filter((entry) => sessionIdMatches(entry.sessionId, token));
      removed = prefixed.length === 1 ? prefixed : [];
    }
    if (removed.length === 0) return [];
    const kept = entries.filter((entry) => !removed.includes(entry));
    this.#traces = kept;
    await this.#persist(kept);
    for (const entry of removed) this.#unschedule(entry.sessionId);
    return removed;
  }

  /** `/send` 受理后开始等目标会话这一轮结束。 */
  trackSend(sessionId: string, title: string, prompt: string, queued = false): void {
    this.#clearSendTimer(sessionId);
    const until = this.#now() + SEND_TIMEOUT_MS;
    this.#sends.set(sessionId, { title, until, pendingStart: queued });
    const handle = this.#setTimer(() => this.#expireSend(sessionId, until), SEND_TIMEOUT_MS);
    this.#sendTimers.set(sessionId, handle);
    // 插话（steer）时这一轮已经开始了，等不到 turn/start：先把提问记下来。
    this.#turns.set(sessionId, { prompt: prompt.trim(), answer: '', sawPrompt: true });
  }

  /** 提交失败时撤销刚登记的观察（不留下一个永远等不到的条目）。 */
  removeSend(sessionId: string): void {
    if (!this.#sends.delete(sessionId)) return;
    this.#clearSendTimer(sessionId);
    if (!this.#traces.some((entry) => entry.sessionId === sessionId)) this.#turns.delete(sessionId);
  }

  /** `session/event` 回调：同步折叠，不抛错。 */
  handleEvent(sessionId: string, event: unknown): void {
    try {
      this.#apply(sessionId, asRecord(event));
    } catch (error) {
      this.#logger?.warn?.(`独立模式命令事件处理失败：${error instanceof Error ? error.message : error}`);
    }
  }

  /** 等所有排队中的推送发完（测试与停止时用）。 */
  async drain(): Promise<void> {
    await Promise.all([...this.#queues.values()]);
  }

  #apply(sessionId: string, event: Record<string, unknown> | null): void {
    if (!event || typeof event.type !== 'string') return;
    const trace = this.#traces.find((entry) => entry.sessionId === sessionId);
    const send = this.#sends.get(sessionId);
    if (event.type === 'session/title') {
      const title = typeof event.data === 'object' && event.data !== null
        ? (event.data as Record<string, unknown>).title
        : undefined;
      if (typeof title === 'string' && title.trim() !== '') this.#retitle(sessionId, title.trim());
      return;
    }
    if (!trace && !send) {
      // 没有观察者时只清理可能残留的折叠状态，不做别的。
      return;
    }
    if (send !== undefined && this.#now() >= send.until) {
      this.#sends.delete(sessionId);
      // 同一会话还在跟踪时，这一轮的收尾仍归跟踪推送，不能把折叠状态一起丢掉。
      if (!trace) this.#turns.delete(sessionId);
      this.#enqueue(sessionId, () => this.#deliver(`「${send.title || UNTITLED}」这一轮没有在 30 分钟内结束，不再等它了。`));
      if (!trace) return;
    }

    const data = asRecord(event.data) ?? {};
    const current = this.#sends.get(sessionId);
    let skipSend = false;
    if (current?.pendingStart === true) {
      if (event.type === 'turn/start') {
        current.pendingStart = false;
      } else if (event.type === 'turn/end') {
        // 排队期间结束的是上一轮：不把它发回 /send；同一会话若在跟踪，这一轮仍归
        // 跟踪推送，所以继续往下折叠。
        current.pendingStart = false;
        skipSend = true;
      }
    }
    if (event.type === 'turn/start') {
      this.#turns.set(sessionId, { prompt: '', answer: '', sawPrompt: false });
      return;
    }
    // 开始时回合可能已在跑：没看到 turn/start 也照样折叠，回答从这里往后收。
    let turn = this.#turns.get(sessionId);
    if (!turn) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') return;
      turn = { prompt: '', answer: '', sawPrompt: false };
      this.#turns.set(sessionId, turn);
    }

    if (event.type === 'user/message') {
      const source = asRecord(data.source);
      if (source?.kind === 'user' && !turn.sawPrompt) {
        turn.sawPrompt = true;
        turn.prompt = promptText(data);
      }
      return;
    }

    if (event.type === 'assistant/message') {
      const text = textFromAssistantMessage(data.message);
      if (text !== '') turn.answer = text;
      return;
    }

    if (event.type !== 'turn/end') return;
    this.#turns.delete(sessionId);
    const currentSend = this.#sends.get(sessionId);
    // 排队跳过的那一轮不能把观察一起删掉：我们这条还在队列里，等它自己的回合。
    if (currentSend !== undefined && !skipSend) {
      this.#sends.delete(sessionId);
      this.#clearSendTimer(sessionId);
    }
    const currentTrace = this.#traces.find((entry) => entry.sessionId === sessionId);
    if (currentSend === undefined && currentTrace === undefined) return;
    const snapshot: TurnState = { ...turn };
    const reason = asRecord(data.reason);
    // 同一会话既被跟踪又有 /send 时只推一条：跟踪那条已经带着提问与回答，再发一遍
    // 「来自会话……」只会让同一轮的两个副本挤在一起。
    if (currentTrace !== undefined) {
      this.#enqueue(sessionId, () => this.#deliverTrace(currentTrace.title || UNTITLED, snapshot, reason));
    } else if (currentSend !== undefined && !skipSend) {
      this.#enqueue(sessionId, () => this.#deliverSend(currentSend.title || UNTITLED, snapshot, reason));
    }
  }

  #clearSendTimer(sessionId: string): void {
    const handle = this.#sendTimers.get(sessionId);
    if (handle !== undefined) this.#clearTimer(handle);
    this.#sendTimers.delete(sessionId);
  }

  #expireSend(sessionId: string, until: number): void {
    const watch = this.#sends.get(sessionId);
    if (watch === undefined || watch.until !== until) return;
    this.#sends.delete(sessionId);
    this.#sendTimers.delete(sessionId);
    if (!this.#traces.some((entry) => entry.sessionId === sessionId)) this.#turns.delete(sessionId);
    this.#enqueue(sessionId, () => this.#deliver(
      `「${watch.title || UNTITLED}」这一轮没有在 ${Math.round(SEND_TIMEOUT_MS / 60_000)} 分钟内结束，不再等它了。`,
    ));
  }

  #retitle(sessionId: string, title: string): void {
    let changed = false;
    for (const entry of this.#traces) {
      if (entry.sessionId === sessionId && entry.title !== title) {
        entry.title = title;
        changed = true;
      }
    }
    const send = this.#sends.get(sessionId);
    if (send !== undefined) send.title = title;
    if (changed) void this.#persist([...this.#traces]);
  }

  #schedule(entry: TraceEntry): void {
    this.#unschedule(entry.sessionId);
    const delay = Math.max(0, entry.until - this.#now());
    const until = entry.until;
    let handle: unknown;
    handle = this.#setTimer(() => {
      void this.#expire(entry.sessionId, until, handle);
    }, delay);
    this.#timers.set(entry.sessionId, handle);
  }

  #unschedule(sessionId: string): void {
    const handle = this.#timers.get(sessionId);
    if (handle !== undefined) this.#clearTimer(handle);
    this.#timers.delete(sessionId);
  }

  async #expire(sessionId: string, until: number, handle: unknown): Promise<void> {
    const entry = this.#traces.find((row) => row.sessionId === sessionId);
    // 到期前被重新跟踪过（`until` 已变）：这次到期作废，新定时器负责。
    if (entry === undefined || entry.until !== until) {
      if (this.#timers.get(sessionId) === handle) this.#timers.delete(sessionId);
      return;
    }
    const kept = this.#traces.filter((row) => row.sessionId !== sessionId);
    this.#traces = kept;
    if (this.#timers.get(sessionId) === handle) this.#timers.delete(sessionId);
    await this.#persist(kept);
    this.#enqueue(sessionId, () => this.#deliver(
      `跟踪「${entry.title || UNTITLED}」已到期，已停止。要继续跟踪请再发 /trace <序号> [分钟]。`,
    ));
  }

  async #persist(entries: readonly TraceEntry[]): Promise<void> {
    try {
      await this.#store.setTraces(entries);
    } catch (error) {
      this.#logger?.warn?.('跟踪列表落盘失败', error instanceof Error ? error.message : error);
    }
  }

  /** 同一会话的推送串行：先结束的回合先发，不乱序。 */
  #enqueue(sessionId: string, task: () => Promise<void>): void {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.#logger?.warn?.('独立模式命令推送失败', error instanceof Error ? error.message : error);
    });
    this.#queues.set(sessionId, next);
    void next.finally(() => {
      if (this.#queues.get(sessionId) === next) this.#queues.delete(sessionId);
    });
  }

  /** 一轮的结局：`completed` 之外的收尾文案。 */
  #reasonText(reason: Record<string, unknown> | null): { kind: 'ok' | 'aborted' | 'blocked' | 'failed'; detail: string } {
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed';
    if (kind === 'aborted') return { kind: 'aborted', detail: '' };
    if (kind === 'blocked') return { kind: 'blocked', detail: '' };
    if (kind === 'completed' || kind === 'max-tokens') return { kind: 'ok', detail: '' };
    const error = asRecord(reason?.error);
    const detail = typeof error?.message === 'string' ? error.message : '模型或工具报错';
    return { kind: 'failed', detail: detail.slice(0, 300) };
  }

  async #deliverSend(title: string, turn: TurnState, reason: Record<string, unknown> | null): Promise<void> {
    const outcome = this.#reasonText(reason);
    if (outcome.kind === 'aborted') return this.#deliver(`「${title}」这一轮被中止了。`);
    if (outcome.kind === 'blocked') {
      return this.#deliver(`「${title}」这一轮被拦下了（可能在等审批），请到 Web 端处理。`);
    }
    if (outcome.kind === 'failed') return this.#deliver(`「${title}」这一轮失败：${outcome.detail}`);
    const answer = toWeChatMarkdown(turn.answer).trim();
    if (answer === '') return this.#deliver(`「${title}」这一轮结束了，没有可发送的文本。`);
    await this.#deliver(`来自会话「${title}」：\n\n${answer}`);
  }

  async #deliverTrace(title: string, turn: TurnState, reason: Record<string, unknown> | null): Promise<void> {
    const outcome = this.#reasonText(reason);
    if (outcome.kind === 'aborted') return this.#deliver(`跟踪 ·「${title}」这一轮被中止了。`);
    if (outcome.kind === 'blocked') {
      return this.#deliver(`跟踪 ·「${title}」这一轮被拦下了（可能在等审批），请到 Web 端处理。`);
    }
    if (outcome.kind === 'failed') return this.#deliver(`跟踪 ·「${title}」这一轮失败：${outcome.detail}`);
    const answer = toWeChatMarkdown(turn.answer).trim();
    if (answer === '') return this.#deliver(`跟踪 ·「${title}」这一轮结束了，没有可发送的文本。`);
    const quote = turn.prompt !== '' ? `\n> ${preview(turn.prompt)}` : '';
    await this.#deliver(`**跟踪 ·「${title}」**${quote}\n\n${answer}`);
  }

  async #deliver(text: string): Promise<void> {
    const rendered = toWeChatMarkdown(text);
    for (const part of splitText(rendered, this.#maxText)) {
      const ok = await this.#send(part).catch((error: unknown) => {
        this.#logger?.warn?.('独立模式命令推送发送失败', error instanceof Error ? error.message : error);
        return false;
      });
      if (!ok) return;
    }
  }
}
