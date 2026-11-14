/**
 * 提问与审批提醒的装配点：两个 broker + 面板上的开关与等待时间。
 *
 * 从 `runtime.ts` 拆出（AGENTS.md 文件规模规则）。这里只做三件事：
 * 1. 把宿主的 `user-questions/request` 与 `approval/request` 转给两个 broker；
 * 2. 入站文本按「最后发的那条提醒」决定归属（提问的自由输入会吞掉一切）；
 * 3. 保存开关与等待时间，关掉时把在等的请求交回 Web。
 */

import { ApprovalBroker } from './approvals.ts';
import type { ApprovalNext, ApprovalRequest } from './approvals.ts';
import { QuestionBroker } from './questions.ts';
import type { QuestionLogger, QuestionNext, QuestionRequest } from './questions.ts';
import { DEFAULT_QUESTION_DELAY_MINUTES } from './config.ts';

export interface ReminderCenterOptions {
  send: (text: string) => Promise<boolean>;
  recipient: () => string | null;
  /** 提醒类根会话判据（提问）：拿不准时放行。 */
  isRoot: (agent: unknown) => boolean;
  /** 授权类根会话判据：拿不准时拒绝（失败关闭）。 */
  canApprove: (agent: unknown) => boolean;
  isActive: () => boolean;
  logger?: QuestionLogger;
  now: () => number;
  /** 启动时的设置（面板值或静态配置）；缺省开、等 5 分钟。 */
  enabled?: boolean;
  delayMinutes?: number;
}

export class ReminderCenter {
  readonly #questions: QuestionBroker;
  readonly #approvals: ApprovalBroker;
  #enabled: boolean;
  #delayMinutes: number;

  constructor(options: ReminderCenterOptions) {
    this.#enabled = options.enabled ?? true;
    this.#delayMinutes = options.delayMinutes ?? DEFAULT_QUESTION_DELAY_MINUTES;
    const shared = {
      send: options.send,
      recipient: options.recipient,
      isActive: options.isActive,
      enabled: () => this.#enabled,
      delayMs: () => this.#delayMinutes * 60_000,
      logger: options.logger,
      now: options.now,
    };
    this.#questions = new QuestionBroker({ ...shared, isRoot: options.isRoot });
    this.#approvals = new ApprovalBroker({ ...shared, canApprove: options.canApprove });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get delayMinutes(): number {
    return this.#delayMinutes;
  }

  status(): { pendingQuestions: number; pendingApprovals: number } {
    return {
      pendingQuestions: this.#questions.snapshot().pending,
      pendingApprovals: this.#approvals.snapshot().pending,
    };
  }

  handleQuestion(request: QuestionRequest, next: QuestionNext, active: boolean): Promise<unknown> {
    return this.#questions.handle(request, next, active);
  }

  handleApproval(request: ApprovalRequest, next: ApprovalNext, active: boolean): Promise<unknown> {
    return this.#approvals.handle(request, next, active);
  }

  /**
   * 入站文本先认最后发的那条提醒。
   *
   * 单题提问认任意文本（自由输入），不按时间排序的话，审批的「批准」会被它吞掉。
   */
  reply(text: string): boolean {
    if (this.#approvals.lastSentSeq() > this.#questions.lastSentSeq()) {
      return this.#approvals.reply(text) || this.#questions.reply(text);
    }
    return this.#questions.reply(text) || this.#approvals.reply(text);
  }

  /** 更新设置；关掉时把在等的请求交回 Web，别挂到超时。 */
  configure(patch: { enabled?: boolean; delayMinutes?: number }): void {
    if (typeof patch.enabled === 'boolean') this.#enabled = patch.enabled;
    if (typeof patch.delayMinutes === 'number' && Number.isFinite(patch.delayMinutes)) {
      this.#delayMinutes = Math.max(0, Math.round(patch.delayMinutes));
    }
    if (!this.#enabled) this.cancelAll('问题提醒已关闭，交回 Web 端');
  }

  /** 停机/切换接入：把在等的提问与审批按真实原因交回 Web。 */
  cancelAll(reason: string): void {
    this.#questions.cancelAll(reason);
    this.#approvals.cancelAll(reason);
  }

  close(): void {
    this.#questions.close();
    this.#approvals.close();
  }
}
