/**
 * 独立模式的装配：绑定、模型与直连会话收在一起。
 *
 * 从 `runtime.ts` 拆出（AGENTS.md 文件规模规则）：运行期只保留生命周期与接线，独立模式
 * 这一摊自己的状态（用哪个工作区、哪个模型、绑定到哪个会话）与对外视图留在这一份，
 * 以后加命令、加跟踪也往这层接，不再把 `runtime.ts` 撑大。
 */

import { DirectChat } from '../direct.ts';
import type { DirectController, DirectLogger, SubmitResult } from '../direct.ts';
import { DirectModelChoice } from '../direct-model.ts';
import type { AgentModelLookup } from '../direct-model.ts';
import { DirectBindingStore } from '../state/direct-binding.ts';
import type { DirectBinding } from '../state/direct-binding.ts';
import type { PromptPart } from '../prompt-parts.ts';
import type { RuntimeStatus } from '../runtime-status.ts';
import type { ModelRef } from '../../shared/models.ts';
import type { BusyMode } from '../config.ts';

export interface DirectStackOptions {
  /** 状态目录（`direct.json` 与命令快照都在这里）。 */
  dir: string;
  controller: () => DirectController | null;
  agents: () => AgentModelLookup | null;
  send: (text: string) => Promise<boolean>;
  isOwner: (sender: string) => boolean;
  /** 建会话标题里的主人标识（账号尾号）。 */
  ownerLabel: () => string;
  /** 没有显式选择时落到哪个工作区（自动创建的「微信会话」）。 */
  defaultWorkspaceId: () => string;
  /** 初始值：插件配置；`start()` 后由本地配置覆盖。 */
  model: ModelRef | null;
  workspaceId: string;
  busyMode: BusyMode;
  logger?: DirectLogger;
  now?: () => number;
  maxText?: number;
}

/** 独立模式的运行态与操作：运行期与面板都只经由它。 */
export class DirectStack {
  readonly model: DirectModelChoice;
  readonly #store: DirectBindingStore;
  readonly #chat: DirectChat;
  readonly #defaultWorkspaceId: () => string;
  #workspaceId: string;
  #busyMode: BusyMode;

  constructor(options: DirectStackOptions) {
    this.#defaultWorkspaceId = options.defaultWorkspaceId;
    this.#workspaceId = options.workspaceId;
    this.#busyMode = options.busyMode;
    // 两个对象互相要读对方（模型钉在会话上，会话绑定读模型），先建绑定仓库。
    this.#store = new DirectBindingStore({
      dir: options.dir,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.model = new DirectModelChoice({
      initial: options.model,
      agents: options.agents,
      boundSession: () => this.#store.get()?.sessionId,
      catalog: options.controller,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.#chat = new DirectChat({
      controller: options.controller,
      store: this.#store,
      workspaceId: () => this.effectiveWorkspaceId(),
      busyMode: () => this.#busyMode,
      applyModel: (sessionId) => this.model.applyToSession(sessionId),
      send: options.send,
      isOwner: options.isOwner,
      ownerLabel: options.ownerLabel,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.maxText !== undefined ? { maxText: options.maxText } : {}),
    });
  }

  /** 读回落盘的绑定（启动时调一次）。 */
  async hydrate(): Promise<void> {
    await this.#store.hydrate();
  }

  /** 等挂起的绑定写盘完成（停机时调用）。 */
  flush(): Promise<void> {
    return this.#store.flush();
  }

  /** 面板/启动时换模型；`null` 表示跟随 DSH 默认（ADR-0025）。 */
  useModel(value: ModelRef | null): void {
    this.model.use(value);
  }

  setWorkspaceId(value: string): void {
    this.#workspaceId = value;
  }

  setBusyMode(value: BusyMode): void {
    this.#busyMode = value;
  }

  /** 实际建会话用的工作区：显式选择优先，否则落到自动创建的默认工作区。 */
  effectiveWorkspaceId(): string {
    const chosen = this.#workspaceId.trim();
    return chosen !== '' ? chosen : this.#defaultWorkspaceId();
  }

  status(): RuntimeStatus['direct'] {
    return {
      ...this.#chat.status(),
      model: this.model.snapshot(),
      ...(this.#store.get()?.title ? { sessionTitle: this.#store.get()?.title } : {}),
    };
  }

  binding(): DirectBinding | null {
    return this.#store.get();
  }

  submit(sender: string, content: readonly PromptPart[]): Promise<SubmitResult> {
    return this.#chat.submit(sender, content);
  }

  async reset(): Promise<void> {
    await this.#chat.reset();
  }

  /** 会话事件：直连会话的回合与标题。 */
  handleEvent(sessionId: string, event: unknown): void {
    this.#chat.handleEvent(sessionId, event);
  }
}
