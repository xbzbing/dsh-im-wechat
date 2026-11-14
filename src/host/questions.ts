/**
 * 用户问题提醒（文本版）。
 *
 * DSH 的 `user-questions/request` 是 Cordis waterfall：监听器返回答案，或者 `next()`
 * 把请求交给下一个监听器（Web 端也在链上）。桥注册在链首，做三件事：
 *
 * 1. 把题目渲染成文字发到微信；
 * 2. 与 Web 端**竞答**：谁先答用谁——先把 `request.signal` 换成「原信号 ∪ 本地信号」，
 *    微信先答就 abort 本地这一份，Web 的投递随之作废；
 * 3. 主人在微信里回的那句话，按与核心一致的规则匹配成结构化答案交回宿主。
 *
 * 只在「没有接入超级助理」时启用（接入了核心就由核心发交付，ADR-0006）。
 */

import { answerFromText, normalizeQuestions, questionsToInteraction } from './answer-text.ts';
import { PendingTable, abortReason, deferred, whenAborted } from './reply-pending.ts';
import { renderInteraction } from '../shared/question-text.ts';
import type { AskQuestion, Answer } from './answer-text.ts';

export interface QuestionLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

/** waterfall 的请求对象：`signal` 要原地替换，不能是 readonly。 */
export interface QuestionRequest {
  questions?: unknown;
  agent?: { id?: unknown } | null;
  signal?: AbortSignal;
  wait?: { callId?: unknown; timed?: unknown };
}

export type QuestionNext = () => Promise<unknown>;

export interface QuestionBrokerOptions {
  /** 把提醒文本发给主人；返回是否发出去了。 */
  send: (text: string) => Promise<boolean>;
  /** 收件人（主人）；未登录/停用时应返回 null，此时完全不接管。 */
  recipient: () => string | null;
  /** 只提醒根会话（子代理的提问不打扰主人）；拿不到来源时放行。 */
  isRoot: (agent: unknown) => boolean;
  /** 当前是否仍然允许接管；发送提醒期间可能被停用/切到核心。 */
  isActive?: () => boolean;
  /** 面板上的「问题与审批提醒」开关：关掉后一律交回 Web。 */
  enabled?: () => boolean;
  /** 提醒前的等待时间（毫秒）：这段时间在 Web 端答完就不打扰。 */
  delayMs?: () => number;
  /** 发出提醒后通知协调者：入站文本该先给这一路认领。 */
  onSent?: () => void;
  now?: () => number;
  newId?: () => string;
  logger?: QuestionLogger;
  /** 单次提醒最多等多久（到点后交回 Web，不再接受微信作答）。 */
  waitMs?: number;
}

interface Pending {
  readonly id: string;
  readonly questions: AskQuestion[];
  /** 本地取消器：abort 会连带 abort 宿主看到的 union signal，Web 端据此收起卡片。 */
  readonly cancel: AbortController;
  resolve(answer: Answer): void;
  reject(error: unknown): void;
}

/** 「没有监听者」：说明 Web 端根本不在，不算作答，继续等微信。 */
function isNoProvider(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'NO_PROVIDER';
}

const DEFAULT_WAIT_MS = 30 * 60_000;
const PENDING_MAX = 50;

export interface QuestionSnapshot {
  pending: number;
  lastError?: { at: number; message: string };
}

export class QuestionBroker {
  readonly #options: QuestionBrokerOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #waitMs: number;
  readonly #pending = new PendingTable<Pending>(PENDING_MAX);
  #lastError: { at: number; message: string } | undefined;
  #closed = false;

  constructor(options: QuestionBrokerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    let counter = 0;
    this.#newId = options.newId ?? (() => `wx-q-${++counter}`);
    this.#waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  snapshot(): QuestionSnapshot {
    return {
      pending: this.#pending.size,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
    };
  }

  /**
   * `user-questions/request` 的监听器实现。
   *
   * 不接管时（插件停用、没登录、不是根会话）原样 `next()`，行为与没装插件一致。
   */
  async handle(request: QuestionRequest, next: QuestionNext, active: boolean): Promise<unknown> {
    if (!active || this.#closed || !this.#takesOver()) return next();
    const questions = normalizeQuestions(request.questions);
    if (questions.length === 0) return next();
    const recipient = this.#options.recipient();
    if (recipient === null) return next();
    if (!this.#options.isRoot(request.agent)) return next();

    // 先把信号换成 union：Web 端与宿主拿到的是同一个可被我们撤销的信号。
    const original = request.signal;
    const local = new AbortController();
    request.signal = original ? AbortSignal.any([original, local.signal]) : local.signal;
    // Web 端先拿到请求：等待窗口内答完就一条微信都不发。
    const web = next();
    const webSettled: Promise<WebOutcome> = web.then(
      (value) => ({ kind: 'web', value }),
      (error: unknown) => (isNoProvider(error) ? { kind: 'none' } : { kind: 'web-error', error }),
    );
    const aborted = whenAborted(request.signal);

    const delay = this.#delayMs();
    const waited = deferred<void>();
    const delayTimer = delay > 0 ? setTimeout(() => waited.resolve(), delay) : null;
    delayTimer?.unref?.();
    const text = renderInteraction(questionsToInteraction(questions));

    try {
      if (delay > 0) {
        const early = await Promise.race([
          webSettled,
          aborted.promise.then(() => ({ kind: 'aborted' as const })),
          waited.promise.then(() => ({ kind: 'go' as const })),
        ]);
        if (early.kind === 'web') return early.value;
        if (early.kind === 'web-error') throw early.error;
        // Web 不在（none）或等到点：继续发提醒，不白等满窗口。
        if (early.kind === 'aborted') throw cancellation(request);
      }

      const sent = await this.#options.send(text).catch(() => false);
      // 发送是异步的；这期间可能已经停用/切到核心，cancelAll 看不到尚不存在的 pending。
      // 这里再判一次，避免给已关闭的插件挂一条待答。
      if (this.#closed || (this.#options.isActive !== undefined && !this.#options.isActive())) {
        this.#noteError('问题提醒发送期间插件状态已变化，已交回 Web 端');
        return web;
      }
      if (!sent) {
        // 发不出去就别接管：交给 Web，主人在 Web 端作答。
        this.#noteError('问题提醒发送失败，已交回 Web 端');
        return web;
      }
      // 发送期间 Web 已经答完（或请求已取消）：别再挂一条过时的提醒。
      const late = await Promise.race([
        webSettled,
        aborted.promise.then(() => ({ kind: 'aborted' as const })),
        Promise.resolve({ kind: 'continue' as const }),
      ]);
      if (late.kind === 'web') return late.value;
      if (late.kind === 'web-error') throw late.error;
      if (late.kind === 'aborted') throw cancellation(request);

      const pendingId = this.#newId();
      const answer = deferred<Answer>();
      const pending: Pending = {
        id: pendingId,
        questions,
        cancel: local,
        resolve: (value) => answer.resolve(value),
        reject: (error) => answer.reject(error),
      };
      this.#pending.add(pending);
      for (const dropped of this.#pending.sweep()) this.#drop(dropped);
      this.#options.onSent?.();
      const im: Promise<{ kind: 'im'; value: Answer } | { kind: 'im-error'; error: unknown }> = answer.promise.then(
        (value) => ({ kind: 'im', value }),
        (error: unknown) => ({ kind: 'im-error', error }),
      );
      const timeout = deferred<{ kind: 'wechat-timeout' }>();

      // 超时只放弃微信这一路：不动 union signal，Web 端还等着，交回给它继续等。
      const timer = setTimeout(() => {
        this.#pending.delete(pendingId);
        timeout.resolve({ kind: 'wechat-timeout' });
      }, this.#waitMs);
      timer.unref?.();

      try {
        let outcome = await Promise.race([
          webSettled,
          im,
          aborted.promise.then(() => ({ kind: 'aborted' as const })),
          timeout.promise,
        ]);
        if (outcome.kind === 'none') {
          // Web 不在：只等主人作答、请求取消或超时。
          outcome = await Promise.race([
            im,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
            timeout.promise,
          ]);
        }
        if (outcome.kind === 'im') {
          local.abort(abortReason('已在微信作答'));
          this.#options.logger?.info?.('问题已在微信作答，Web 端投递作废');
          return outcome.value;
        }
        if (outcome.kind === 'web') return outcome.value;
        if (outcome.kind === 'web-error' || outcome.kind === 'im-error') throw outcome.error;
        if (outcome.kind === 'wechat-timeout') {
          // 微信这路到点放弃：Web 还在就真正交回，由它接着等作答。
          const webOutcome = await Promise.race([
            webSettled,
            aborted.promise.then(() => ({ kind: 'aborted' as const })),
          ]);
          if (webOutcome.kind === 'web') return webOutcome.value;
          if (webOutcome.kind === 'web-error') throw webOutcome.error;
          if (webOutcome.kind === 'none') throw abortReason('等待微信作答超时');
        }
        // 带上取消方的原因：停机、切换接入方式、宿主自己取消，各自有可读的话。
        throw cancellation(request);
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
   * 入站文本尝试当作作答；返回 true 表示这条消息已被消化（不再进普通消息路径）。
   *
   * 多条待答时认**最后一条**：主人在微信里看到的是最近发出的那条提醒。
   */
  reply(text: string): boolean {
    for (const pending of this.#pending.newestFirst()) {
      // 单题（含计划审阅）认自由输入——提示语与 answerFromText 都这么承诺；
      // 多题只认分段可解析的作答，整段自由输入交给普通消息路径（前一轮评审裁决）。
      if (!looksLikeAnswer(pending.questions, text)) continue;
      const answer = answerFromText(pending.questions, text);
      if (!answer) continue;
      pending.resolve(answer);
      this.#pending.delete(pending.id);
      return true;
    }
    return false;
  }

  /** 停机/停用：把所有等待中的提问交回 Web（abort 本地信号，不吞掉请求）。 */
  cancelAll(reason = '插件已停止'): void {
    for (const pending of this.#pending.values()) {
      // abort 本地信号：宿主看到的 union signal 随之 abort，Web 端的问题卡片才会收起。
      pending.cancel.abort(abortReason(reason));
      pending.reject(abortReason(reason));
    }
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
  /** 被挤掉的待答按「提问过多」收尾：abort 本地信号，Web 端随之收起。 */
  #drop(pending: Pending): void {
    pending.cancel.abort(abortReason('提问过多'));
    pending.reject(abortReason('提问过多'));
  }

  #noteError(message: string): void {
    this.#lastError = { at: this.#now(), message };
  }
}

/**
 * 文本是否「像」一个答案。
 *
 * 只用来决定要不要认领；真正的解析仍交给 `answerFromText`。单题（含计划审阅）
 * 认任意非空文本——提示语写着「或其他文字即作为修改意见」「或直接回复文字作答」，
 * answerFromText 也把自由输入落成 custom；多题要求分段都落到选项/序号上，
 * 整段自由输入不认领，交给普通消息路径。
 */
export function looksLikeAnswer(questions: readonly AskQuestion[], text: string): boolean {
  const reply = text.trim();
  if (reply === '' || questions.length === 0) return false;
  if (questions.length === 1) return true;

  const segments = reply.split(/[；;。\n]+/).map((segment) => segment.trim()).filter(Boolean);
  // 多题：分段数对上，且每段都能落到选项/序号上才算作答。
  if (segments.length !== questions.length) return false;
  return segments.every((segment, index) => resolvesToOption(questions[index], segment));
}

function resolvesToOption(question: AskQuestion, reply: string): boolean {
  const options = question.options ?? [];
  if (options.length === 0) return false;
  if (options.some((option) => option.label.toLowerCase() === reply.toLowerCase())) return true;
  const tokens = reply.split(/[\s,，、]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => {
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      return index >= 0 && index < options.length;
    }
    return options.some((option) => option.label.toLowerCase() === token.toLowerCase());
  });
}

/** Web 端那一路的结果：答了、没有监听者、或者它自己出错。 */
export type WebOutcome =
  | { kind: 'web'; value: unknown }
  | { kind: 'none' }
  | { kind: 'web-error'; error: unknown };

/** 取消原因：优先用请求信号上那句可读的话（停机、切换接入方式、宿主取消）。 */
export function cancellation(request: { signal?: AbortSignal }): Error {
  const reason = request.signal?.reason as unknown;
  return reason instanceof Error ? reason : abortReason('提问已取消');
}
