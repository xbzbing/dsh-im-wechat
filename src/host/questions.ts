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
  /** 只提醒根会话（子代理的提问不打扰主人）。 */
  isRoot: (agentId: string | null) => boolean;
  now?: () => number;
  newId?: () => string;
  logger?: QuestionLogger;
  /** 单次提醒最多等多久（到点后交回 Web，不再接受微信作答）。 */
  waitMs?: number;
}

interface Pending {
  readonly id: string;
  readonly questions: AskQuestion[];
  readonly createdAt: number;
  resolve(answer: Answer): void;
  reject(error: unknown): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 「没有监听者」：说明 Web 端根本不在，不算作答，继续等微信。 */
function isNoProvider(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'NO_PROVIDER';
}

/** 一个信号 abort 时 resolve（不 reject，便于直接参与 race）。 */
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

const DEFAULT_WAIT_MS = 30 * 60_000;
const PENDING_MAX = 50;
const PENDING_TTL_MS = 60 * 60_000;

export interface QuestionSnapshot {
  pending: number;
  lastError?: { at: number; message: string };
}

export class QuestionBroker {
  readonly #options: QuestionBrokerOptions;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #waitMs: number;
  readonly #pending = new Map<string, Pending>();
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
    if (!active || this.#closed) return next();
    const questions = normalizeQuestions(request.questions);
    if (questions.length === 0) return next();
    const recipient = this.#options.recipient();
    if (recipient === null) return next();
    const agentId = typeof request.agent?.id === 'string' ? request.agent.id : null;
    if (!this.#options.isRoot(agentId)) return next();

    const text = renderInteraction(questionsToInteraction(questions));
    const sent = await this.#send(text).catch(() => false);
    if (!sent) {
      // 发不出去就别接管：交给 Web，主人在 Web 端作答。
      this.#noteError('问题提醒发送失败，已交回 Web 端');
      return next();
    }

    this.#sweep();
    const pendingId = this.#newId();
    const answer = deferred<Answer>();
    const pending: Pending = {
      id: pendingId,
      questions,
      createdAt: this.#now(),
      resolve: (value) => answer.resolve(value),
      reject: (error) => answer.reject(error),
    };
    this.#pending.set(pendingId, pending);

    const local = new AbortController();
    const original = request.signal;
    request.signal = original ? AbortSignal.any([original, local.signal]) : local.signal;
    const aborted = whenAborted(request.signal);

    const web = next();
    const webSettled: Promise<{ kind: 'web'; value: unknown } | { kind: 'none' } | { kind: 'web-error'; error: unknown }> =
      web.then(
        (value) => ({ kind: 'web', value }),
        (error: unknown) => (isNoProvider(error) ? { kind: 'none' } : { kind: 'web-error', error }),
      );
    const im: Promise<{ kind: 'im'; value: Answer } | { kind: 'im-error'; error: unknown }> = answer.promise.then(
      (value) => ({ kind: 'im', value }),
      (error: unknown) => ({ kind: 'im-error', error }),
    );

    const timer = setTimeout(() => local.abort(), this.#waitMs);

    try {
      let outcome = await Promise.race([webSettled, im, aborted.promise.then(() => ({ kind: 'aborted' as const }))]);
      if (outcome.kind === 'none') {
        // Web 不在：只等主人作答或请求取消。
        outcome = await Promise.race([im, aborted.promise.then(() => ({ kind: 'aborted' as const }))]);
      }
      if (outcome.kind === 'im') {
        local.abort(abortReason('已在微信作答'));
        this.#options.logger?.info?.('问题已在微信作答，Web 端投递作废');
        return outcome.value;
      }
      if (outcome.kind === 'web') return outcome.value;
      if (outcome.kind === 'web-error' || outcome.kind === 'im-error') throw outcome.error;
      throw abortReason('提问已取消');
    } finally {
      clearTimeout(timer);
      aborted.dispose();
      this.#pending.delete(pendingId);
    }
  }

  /**
   * 入站文本尝试当作作答；返回 true 表示这条消息已被消化（不再进普通消息路径）。
   *
   * 只匹配最早的一条待答问题：主人一次只可能在回答一个问题。
   */
  reply(text: string): boolean {
    for (const pending of this.#pending.values()) {
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
      pending.reject(abortReason(reason));
    }
    this.#pending.clear();
  }

  close(): void {
    this.#closed = true;
    this.cancelAll();
  }

  async #send(text: string): Promise<boolean> {
    return this.#options.send(text);
  }

  #sweep(): void {
    const deadline = this.#now() - PENDING_TTL_MS;
    for (const [id, pending] of this.#pending) {
      if (pending.createdAt < deadline) {
        pending.reject(abortReason('提问等待超时'));
        this.#pending.delete(id);
      }
    }
    while (this.#pending.size > PENDING_MAX) {
      const oldest = this.#pending.keys().next();
      if (oldest.done) break;
      this.#pending.get(oldest.value)?.reject(abortReason('提问过多'));
      this.#pending.delete(oldest.value);
    }
  }

  #noteError(message: string): void {
    this.#lastError = { at: this.#now(), message };
  }
}

function abortReason(message: string): Error {
  const error = new Error(message);
  error.name = 'UserQuestionError';
  (error as { code?: string }).code = 'ASK_ABORTED';
  return error;
}
