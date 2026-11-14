/**
 * 工具授权（`approval/request`）的微信提醒与作答。
 *
 * 宿主把审批交给 waterfall 的监听器，监听器返回四个结局之一；缺省（`next()` 走到底）
 * 是 `unavailable`——**失败关闭**。所以这里只在主人明确回「批准」时才给 `allowed-once`，
 * 其余一律不动：到点没答就把请求交回 Web，由 Web 或宿主的默认值收尾。
 *
 * 与提问的两处差别：
 * - 审批**没有**自由文本作答：回复只认批准/拒绝两类词（可带编号），模糊的话不认领；
 * - 审批的「Web 不在」不是异常，而是 `next()` 解析成 `unavailable`（提问那边是抛
 *   `NO_PROVIDER`）。两者都按「没人接」处理，继续等主人。
 *
 * 只在独立模式（未接入核心）下接管，接入核心后由核心提醒（ADR-0006）。
 */

import { deferred } from './questions.ts';
import type { QuestionLogger, WebOutcome } from './questions.ts';

export interface ApprovalRequest {
  agent?: unknown;
  toolName?: unknown;
  callId?: unknown;
  reason?: unknown;
  signal?: AbortSignal;
}

export type ApprovalNext = () => Promise<unknown>;

/** 微信能给出的两个决定；其余结局都由宿主或 Web 端收尾。 */
export type ApprovalDecision = 'allowed-once' | 'rejected';

export interface ApprovalBrokerOptions {
  send: (text: string) => Promise<boolean>;
  recipient: () => string | null;
  /** 授权只认根会话；**拿不到来源时拒绝**（安全边界，缺省失败关闭）。 */
  canApprove: (agent: unknown) => boolean;
  /** 当前是否仍然允许接管；发送提醒期间可能被停用/切到核心。 */
  isActive?: () => boolean;
  /** 面板上的「问题与审批提醒」开关：关掉后一律交回 Web。 */
  enabled?: () => boolean;
  /** 提醒前的等待时间（毫秒）：这段时间在 Web 端处理完就不打扰。 */
  delayMs?: () => number;
  /** 发出提醒后通知协调者：入站文本该先给这一路认领。 */
  onSent?: () => void;
  logger?: QuestionLogger;
  /** 单次提醒最多等多久（到点后交回 Web，不再接受微信作答）。 */
  waitMs?: number;
}

interface Pending {
  readonly id: string;
  /** 提醒编号：主人回「批准 3」时用它指定这一条。 */
  readonly no: number;
  readonly tool: string;
  readonly resolve: (outcome: ApprovalDecision) => void;
  /** 交回 Web：不抛错、不 abort，让下游链继续等 Web 的答案。 */
  readonly release: () => void;
}

/** 提醒那一路的默认窗口；审批只提醒不代答，窗口与提问一致即可。 */
const DEFAULT_WAIT_MS = 30 * 60_000;
const PENDING_MAX = 20;
/** 原因只发这么多字符：它来自宿主，可能带路径/命令片段，也可能很长。 */
const REASON_MAX = 200;

/**
 * 明确的批准/拒绝词，可带提醒编号（`批准 3`、`拒绝#2`）。
 *
 * 只认整句：多一个字就不算同意。**不收单字母 y/n**——那是一次真实授权，
 * 手滑或语音转文字不该有机会命中。
 */
const APPROVE = /^(批准|同意|approve|yes)(?:\s*[#第]?\s*(\d+)\s*[条号]?)?$/i;
const REJECT = /^(拒绝|不批准|不同意|deny|reject|no)(?:\s*[#第]?\s*(\d+)\s*[条号]?)?$/i;

/** 去掉首尾引号（主人常把文案里的「批准」连引号一起抄回来）与句末标点。 */
function trimmed(text: string): string {
  return text.trim()
    .replace(/^[「『“"']+/, '')
    .replace(/[」』”"']+$/, '')
    .replace(/[。.!！?？]+$/, '')
    .trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export interface Decision {
  outcome: ApprovalDecision;
  /** 指定的提醒编号；没带编号时由 broker 认最后一条。 */
  no?: number;
}

/** 解析一条入站文本；不是明确决定时返回 null（交给普通消息路径）。 */
export function parseDecision(text: string): Decision | null {
  const value = trimmed(text);
  if (value === '') return null;
  const approve = APPROVE.exec(value);
  if (approve) return decisionOf('allowed-once', approve[2]);
  const reject = REJECT.exec(value);
  if (reject) return decisionOf('rejected', reject[2]);
  return null;
}

/** 带了编号就必须是有效编号：`批准 0` 这类输入一律不认（失败关闭）。 */
function decisionOf(outcome: ApprovalDecision, raw: string | undefined): Decision | null {
  if (raw === undefined) return { outcome };
  const no = Number(raw);
  return Number.isSafeInteger(no) && no > 0 ? { outcome, no } : null;
}

export class ApprovalBroker {
  readonly #options: ApprovalBrokerOptions;
  readonly #waitMs: number;
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  #reminded = 0;

  constructor(options: ApprovalBrokerOptions) {
    this.#options = options;
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  snapshot(): { pending: number } {
    return { pending: this.#pending.size };
  }

  /** `approval/request` 的监听器实现；不接管时原样 `next()`。 */
  async handle(request: ApprovalRequest, next: ApprovalNext, active: boolean): Promise<unknown> {
    if (!active || this.#closed || !this.#takesOver()) return next();
    if (this.#options.recipient() === null) return next();
    if (!this.#options.canApprove(request.agent)) return next();

    const original = request.signal;
    const local = new AbortController();
    request.signal = original ? AbortSignal.any([original, local.signal]) : local.signal;
    const web = next();
    // `unavailable` 是宿主的「没人接」兜底（不是答案）；按「Web 不在」继续等微信。
    const webSettled: Promise<WebOutcome> = web.then(
      (value) => (value === 'unavailable' ? { kind: 'none' } : { kind: 'web', value }),
      (error: unknown) => ({ kind: 'web-error', error }),
    );
    const aborted = whenAborted(request.signal);

    const delay = this.#delayMs();
    const waited = deferred<void>();
    const delayTimer = delay > 0 ? setTimeout(() => waited.resolve(), delay) : null;
    delayTimer?.unref?.();

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

      const text = reminderText(request, this.#reminded + 1);
      const sent = await this.#options.send(text).catch(() => false);
      // 发送是异步的：这期间可能已经停用/切到核心，cancelAll 看不到尚不存在的 pending。
      if (this.#closed || (this.#options.isActive !== undefined && !this.#options.isActive())) return web;
      if (!sent) return web;
      // 发送期间 Web 已经处理完（或请求已取消）：别再挂一条过时的提醒。
      const late = await Promise.race([
        webSettled,
        aborted.promise.then(() => ({ kind: 'aborted' as const })),
        Promise.resolve({ kind: 'continue' as const }),
      ]);
      if (late.kind === 'web') return late.value;
      if (late.kind === 'web-error') throw late.error;
      if (late.kind === 'aborted') return 'cancelled';

      const no = ++this.#reminded;
      const pendingId = `wx-approval-${no}`;
      const outcome = deferred<ApprovalDecision>();
      const released = deferred<{ kind: 'release' }>();
      const pending: Pending = {
        id: pendingId,
        no,
        tool: toolNameOf(request),
        resolve: (value) => outcome.resolve(value),
        release: () => released.resolve({ kind: 'release' }),
      };
      this.#pending.set(pendingId, pending);
      this.#sweep();
      this.#options.onSent?.();

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
          released.promise,
        ]);
        if (result.kind === 'none') {
          // Web 不在：只等主人作答、请求取消、交回或超时。
          result = await Promise.race([
            im,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
            timeout.promise,
            released.promise,
          ]);
        }
        if (result.kind === 'im') {
          // abort 本地信号：Web 端的同一张卡片随之收起。
          local.abort(new Error('已在微信处理'));
          this.#options.logger?.info?.(`授权请求已在微信处理：${String(result.value)}`);
          return result.value;
        }
        if (result.kind === 'web') return result.value;
        if (result.kind === 'web-error' || result.kind === 'im-error') throw result.error;
        if (result.kind === 'release') return web;
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
   * 带编号时认指定那条，不带编号认**最后一条**（主人看到的是最近发出的提醒）。
   * 审批是安全边界：模糊的话一律交回普通消息路径，绝不猜。
   */
  reply(text: string): boolean {
    const decision = parseDecision(text);
    if (decision === null) return false;
    const pending = decision.no === undefined ? this.#newest() : this.#byNo(decision.no);
    if (pending === undefined) return false;
    pending.resolve(decision.outcome);
    this.#pending.delete(pending.id);
    // 回执尽力而为：不阻塞入站流水线，也不因为回执失败改变已经做出的决定。
    void this.#options.send(receipt(pending, decision.outcome)).catch(() => {});
    return true;
  }

  /** 停机/停用：把等待中的审批交回 Web（不吞掉请求，也不把它变成拒绝）。 */
  cancelAll(reason = '插件已停止'): void {
    if (this.#pending.size > 0) this.#options.logger?.info?.(`审批交回 Web：${reason}`);
    for (const pending of this.#pending.values()) pending.release();
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.cancelAll();
  }

  /** 面板开关：关掉就完全不接管，与没装插件一致。 */
  #takesOver(): boolean {
    return this.#options.enabled === undefined || this.#options.enabled();
  }

  /** 提醒前的等待时间；非法值当作不等。 */
  #delayMs(): number {
    const value = this.#options.delayMs?.() ?? 0;
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  /** 上限在插入之后收口：表里最多 `PENDING_MAX` 条。 */
  #sweep(): void {
    while (this.#pending.size > PENDING_MAX) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.get(oldest.value)?.release();
      this.#pending.delete(oldest.value);
    }
  }

  #newest(): Pending | undefined {
    let last: Pending | undefined;
    for (const pending of this.#pending.values()) last = pending;
    return last;
  }

  #byNo(no: number): Pending | undefined {
    for (const pending of this.#pending.values()) {
      if (pending.no === no) return pending;
    }
    return undefined;
  }
}

/** 提醒文案：带编号，原因单行截断；其余提示说明怎么指定多条中的某一条。 */
export function reminderText(request: ApprovalRequest, no: number): string {
  const lines = [`需要你授权 #${no}：${toolNameOf(request)}`];
  const reason = reasonOf(request);
  if (reason !== '') lines.push(reason);
  lines.push('回复「批准」或「拒绝」；多个在等时加编号（如「批准 3」）。不回复就到 Web 端处理。');
  return lines.join('\n');
}

function toolNameOf(request: ApprovalRequest): string {
  return typeof request.toolName === 'string' && request.toolName.trim() !== ''
    ? request.toolName.trim()
    : '某个工具';
}

function reasonOf(request: ApprovalRequest): string {
  if (typeof request.reason !== 'string') return '';
  const text = oneLine(request.reason);
  if (text === '') return '';
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX)}…` : text;
}

function receipt(pending: Pending, outcome: ApprovalDecision): string {
  return `${outcome === 'allowed-once' ? '已批准' : '已拒绝'}：${pending.tool}（#${pending.no}）`;
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
