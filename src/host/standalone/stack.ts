/**
 * 独立模式的装配：绑定、模型与直连会话收在一起。
 *
 * 从 `runtime.ts` 拆出（AGENTS.md 文件规模规则）：运行期只保留生命周期与接线，独立模式
 * 这一摊自己的状态（用哪个工作区、哪个模型、绑定到哪个会话）与对外视图留在这一份，
 * 以后加命令、加跟踪也往这层接，不再把 `runtime.ts` 撑大。
 */

import { randomUUID } from 'node:crypto';

import { DirectChat, clientTimeZone } from '../direct.ts';
import type { DirectController, DirectLogger, HostSessionRow, SubmitResult } from '../direct.ts';
import { DirectModelChoice } from '../direct-model.ts';
import type { AgentModelLookup } from '../direct-model.ts';
import { DirectBindingStore } from '../state/direct-binding.ts';
import type { DirectBinding } from '../state/direct-binding.ts';
import type { PromptPart } from '../prompt-parts.ts';
import type { RuntimeStatus } from '../runtime-status.ts';
import type { ModelRef } from '../../shared/models.ts';
import type { BusyMode } from '../config.ts';
import { StandaloneCommandStore } from '../state/standalone-commands.ts';
import { StandaloneCommands } from './commands.ts';
import type { CommandInput } from './commands.ts';
import { SessionLister, rowTitle } from './session-list.ts';
import { SessionWatcher } from './session-watch.ts';
import { MAX_TEXT_BYTES } from '../superagent/render.ts';

/** 往任意会话提交时的受理预算（与直连会话一致）。 */
const DELIVER_TIMEOUT_MS = 30_000;
/** 读目标会话运行态的超时：读不到就按空闲处理。 */
const BUSY_TIMEOUT_MS = 3_000;

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
  readonly #controller: () => DirectController | null;
  readonly #commands: StandaloneCommands;
  readonly #watcher: SessionWatcher;
  readonly #commandStore: StandaloneCommandStore;
  readonly #defaultWorkspaceId: () => string;
  #workspaceId: string;
  #busyMode: BusyMode;

  constructor(options: DirectStackOptions) {
    this.#defaultWorkspaceId = options.defaultWorkspaceId;
    this.#controller = options.controller;
    this.#workspaceId = options.workspaceId;
    this.#busyMode = options.busyMode;
    const maxText = options.maxText ?? MAX_TEXT_BYTES;
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
    this.#commandStore = new StandaloneCommandStore({
      dir: options.dir,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    const lister = new SessionLister({
      controller: options.controller,
      exclude: () => this.#store.get()?.sessionId ?? '',
    });
    this.#watcher = new SessionWatcher({
      send: options.send,
      store: this.#commandStore,
      maxText,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.#commands = new StandaloneCommands({
      lister,
      watcher: this.#watcher,
      store: this.#commandStore,
      reset: () => this.#chat.reset(),
      bound: () => this.#store.get() !== null,
      deliver: (sessionId, content) => this.#deliver(sessionId, content),
      send: options.send,
      maxText,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
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
    await this.#commandStore.hydrate();
    this.#watcher.start();
    // 旧版本落盘的绑定没有标题：启动时从宿主列表补一次，面板不用等下一次改名。
    await this.refreshTitle();
  }

  /** 等挂起的写盘与推送完成（停机时调用）。 */
  async flush(): Promise<void> {
    await this.#store.flush();
    await this.#commandStore.flush();
    await this.#watcher.drain();
  }

  /** 停止跟踪定时器（停机时调用；跟踪列表本身保留）。 */
  stop(): void {
    this.#watcher.stop();
  }

  /** 独立模式的文字命令；不是已知命令时返回 false。 */
  runCommand(input: CommandInput): Promise<boolean> {
    return this.#commands.run(input);
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

  /** 会话事件：直连会话的回合与标题、命令跟踪的会话。 */
  handleEvent(sessionId: string, event: unknown): void {
    this.#chat.handleEvent(sessionId, event);
    this.#watcher.handleEvent(sessionId, event);
  }

  /**
   * 往任意会话提交（`/send`）：不钉面板里的模型——目标会话的模型可能是主人在 Web
   * 端挑过的，从微信发一句话就改掉是越权。
   */
  async #deliver(sessionId: string, content: readonly PromptPart[]): Promise<{ queued: boolean }> {
    const controller = this.#controller();
    if (controller === null) throw new Error('宿主未提供会话服务');
    const busy = await this.#isBusy(controller, sessionId);
    const mode: BusyMode = busy && this.#busyMode === 'steer' ? 'steer' : 'queue';
    const result = await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode,
      content,
      clientTimeZone: clientTimeZone(),
    }, AbortSignal.timeout(DELIVER_TIMEOUT_MS));
    if (result.accepted !== true) throw new Error('会话没有接受这条消息');
    return { queued: busy && mode === 'queue' };
  }

  /** 从宿主列表补一次绑定会话的标题；没有绑定或宿主读不到时什么都不做。 */
  async refreshTitle(): Promise<void> {
    const binding = this.#store.get();
    const controller = this.#controller();
    if (binding === null || controller === null || typeof controller.list !== 'function') return;
    try {
      const value = await controller.list({}, AbortSignal.timeout(BUSY_TIMEOUT_MS));
      const row = value.items?.find((item) => item.sessionId === binding.sessionId);
      const title = row === undefined ? '' : rowTitle(row);
      if (title !== '') await this.#store.setTitle(title);
    } catch {
      // 读不到标题不影响绑定与会话；下一次 session/title 事件还会补。
    }
  }

  async #isBusy(controller: DirectController, sessionId: string): Promise<boolean> {
    if (typeof controller.list !== 'function') return false;
    try {
      const value = await controller.list({}, AbortSignal.timeout(BUSY_TIMEOUT_MS));
      const row: HostSessionRow | undefined = value.items?.find((item) => item.sessionId === sessionId);
      return row?.running === true;
    } catch {
      return false;
    }
  }
}
