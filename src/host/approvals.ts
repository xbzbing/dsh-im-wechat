/**
 * 工具授权（`approval/request`）的微信提醒与作答。
 *
 * 宿主把审批交给 waterfall 的监听器，监听器返回四个结局之一；缺省（`next()` 走到底）
 * 是 `unavailable`——**失败关闭**。所以这里只在主人明确回「批准」时才给 `allowed-once`，
 * 其余一律不动：到点没答就把请求交回 Web，由 Web 或宿主的默认值收尾。
 *
 * 与提问的差别：审批**没有**「自由文本」这一说，回复只认批准/拒绝两类词；也不做代答。
 * 只在独立模式（未接入核心）下接管，接入核心后由核心提醒（ADR-0006）。
 */

import { deferred } from './questions.ts';
import type { WebOutcome } from './questions.ts';
import type { QuestionLogger } from './questions.ts';

export interface ApprovalRequest {
  agent?: { id?: unknown } | null;
  toolName?: unknown;
  callId?: unknown;
  reason?: unknown;
  signal?: AbortSignal;
}

export type ApprovalNext = () => Promise<unknown>;

export interface ApprovalBrokerOptions {
  send: (text: string) => Promise<boolean>;
  recipient: () => string | null;
  isRoot: (agentId: string | null) => boolean;
  isActive?: () => boolean;
  enabled?: () => boolean;
  delayMs?: () => number;
  now?: () => number;
  logger?: QuestionLogger;
  waitMs?: number;
}

interface Pending {
  readonly id: string;
  readonly createdAt: number;
  readonly resolve: (outcome: 'allowed-once' | 'rejected') => void;
  readonly reject: (error: unknown) => void;
}

/** 提问那一路的默认窗口；审批只提醒不代答，窗口与提问一致即可。 */
const DEFAULT_WAIT_MS = 30 * 60_000;
const PENDING_MAX = 20;
const PENDING_TTL_MS = 60 * 60_000;

/** 明确的批准词。只认整句，不做包含式匹配：多一个字就不算同意。 */
const APPROVE = /^(批准|同意|允许|通过|approve|allow|yes|y)$/i;
/** 明确的拒绝词。 */
const REJECT = /^(拒绝|不允许|不批准|不同意|deny|reject|no|n)$/i;

function trimmed(text: string): string {
  return text.trim().replace(/[。.!！?？]+$/, '').trim();
}

export class ApprovalBroker {
  readonly #options: ApprovalBrokerOptions;
  readonly #now: () => number;
  readonly #waitMs: number;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  #seq = 0;
  #lastSent = 0;

  constructor(options: ApprovalBrokerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  snapshot(): { pending: number } {
    return { pending: this.#pending.size };
  }

  lastSentSeq(): number {
    return this.#lastSent;
  }

  /** `approval/request` 的监听器实现；不接管时原样 `next()`。 */
  async handle(request: ApprovalRequest, next: ApprovalNext, active: boolean): Promise<unknown> {
    if (!active || this.#closed || !this.#takesOver()) return next();
    if (this.#options.recipient() === null) return next();
    const agentId = typeof request.agent?.id === 'string' ? request.agent.id : null;
    if (!this.#options.isRoot(agentId)) return next();

    const original = request.signal;
    const local = new AbortController();
    request.signal = original ? AbortSignal.any([original, local.signal]) : local.signal;
    const web = next();
    const webSettled: Promise<WebOutcome> = web.then(
      (value) => ({ kind: 'web', value }),
      (error: unknown) => ({ kind: 'web-error', error }),
    );
    const aborted = whenAborted(request.signal);

    const delay = this.#delayMs();
    const waited = deferred<void>();
    const delayTimer = delay > 0 ? setTimeout(() => waited.resolve(), delay) : null;
    delayTimer?.unref?.();
    const text = reminderText(request);

    try {
      if (delay > 0) {
        const early = await Promise.race([
          webSettled,
          aborted.promise.then(() => ({ kind: 'aborted' as const })),
          waited.promise.then(() => ({ kind: 'go' as const })),
        ]);
        if (early.kind === 'web') return early.value;
        if (early.kind === 'web-error') throw early.error;
        if (early.kind === 'aborted') return 'cancelled';
      }

      const sent = await this.#send(text).catch(() => false);
      if (this.#closed || (this.#options.isActive !== undefined && !this.#options.isActive())) return web;
      if (!sent) return web;

      this.#sweep();
      const pendingId = `wx-approval-${this.#pending.size + 1}-${this.#now()}`;
      const outcome = deferred<'allowed-once' | 'rejected'>();
      const pending: Pending = {
        id: pendingId,
        createdAt: this.#now(),
        resolve: (value) => outcome.resolve(value),
        reject: (error) => outcome.reject(error),
      };
      this.#pending.set(pendingId, pending);
      this.#lastSent = ++this.#seq;

      const im = outcome.promise.then(
        (value) => ({ kind: 'im' as const, value }),
        (error: unknown) => ({ kind: 'im-error' as const, error }),
      );
      const timeout = deferred<{ kind: 'wechat-timeout' }>();
      const timer = setTimeout(() => {
        this.#pending.delete(pendingId);
        timeout.resolve({ kind: 'wechat-timeout' });
      }, this.#waitMs);
      timer.unref?.();

      try {
        let result = await Promise.race([
          webSettled,
          im,
          aborted.promise.then(() => ({ kind: 'aborted' as const })),
          timeout.promise,
        ]);
        if (result.kind === 'none') {
          result = await Promise.race([
            im,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
            timeout.promise,
          ]);
        }
        if (result.kind === 'im') {
          local.abort(new Error('已在微信处理'));
          this.#options.logger?.info?.(`授权请求已在微信处理：${String(result.value)}`);
          return result.value;
        }
        if (result.kind === 'web') return result.value;
        if (result.kind === 'web-error' || result.kind === 'im-error') throw result.error;
        if (result.kind === 'wechat-timeout') {
          const webOutcome = await Promise.race([
            webSettled,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
          ]);
          if (webOutcome.kind === 'web') return webOutcome.value;
          if (webOutcome.kind === 'web-error') throw webOutcome.error;
          return 'unavailable';
        }
        return 'cancelled';
      } finally {
        clearTimeout(timer);
        this.#pending.delete(pendingId);
      }
    } finally {
      if (delayTimer !== null) clearTimeout(delayTimer);
      aborted.dispose();
    }
  }

  /**
   * 入站文本尝试当作审批决定；返回 true 表示这条消息已被消化。
   *
   * 只认明确的批准/拒绝词：审批是安全边界，模糊的话交回普通消息路径，绝不猜。
   */
  reply(text: string): boolean {
    const value = trimmed(text);
    if (value === '') return false;
    const outcome = APPROVE.test(value) ? 'allowed-once' : REJECT.test(value) ? 'rejected' : undefined;
    if (!outcome) return false;
    const pendingList = [...this.#pending.values()];
    const pending = pendingList[0];
    if (!pending) return false;
    pending.resolve(outcome);
    this.#pending.delete(pending.id);
    return true;
  }

  /** 停机/停用：把等待中的审批交回 Web（不吞掉请求）。 */
  cancelAll(reason = '插件已停止'): void {
    for (const pending of this.#pending.values()) pending.reject(new Error(reason));
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.cancelAll();
  }

  async #send(text: string): Promise<boolean> {
    return this.#options.send(text);
  }

  #takesOver(): boolean {
    return this.#options.enabled === undefined || this.#options.enabled();
  }

  #delayMs(): number {
    const value = this.#options.delayMs?.() ?? 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  #sweep(): void {
    const deadline = this.#now() - PENDING_TTL_MS;
    for (const [id, pending] of this.#pending) {
      if (pending.createdAt < deadline) {
        pending.reject(new Error('授权等待超时'));
        this.#pending.delete(id);
      }
    }
    while (this.#pending.size > PENDING_MAX) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.get(oldest.value)?.reject(new Error('授权过多'));
      this.#pending.delete(oldest.value);
    }
  }
}

/** 提醒文案：工具名与原因都来自宿主，原样呈现，不加工。 */
export function reminderText(request: ApprovalRequest): string {
  const tool = typeof request.toolName === 'string' && request.toolName.trim() !== ''
    ? request.toolName.trim()
    : '某个工具';
  const reason = typeof request.reason === 'string' ? request.reason.trim() : '';
  const lines = [`需要你授权：${tool}`];
  if (reason !== '') lines.push(reason);
  lines.push('回复「批准」或「拒绝」；不回复就到 Web 端处理。');
  return lines.join('\n');
}

function whenAborted(signal: AbortSignal | undefined): { promise: Promise<void>; dispose(): void } {
  let dispose = (): void => {};
  const promise = new Promise<void>((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => resolve();
    signal.addEventListener('abort', onAbort, { once: true });
    dispose = () => signal.removeEventListener('abort', onAbort);
  });
  return { promise, dispose };
}
