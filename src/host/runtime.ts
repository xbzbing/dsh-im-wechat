/**
 * 运行期：把登录态、协议客户端、轮询、桥与面板串起来（ADR-0001 的装配点）。
 *
 * 生命周期只有两条路径：**有登录态** → 建客户端、注册桥、起轮询；
 * **没有登录态** → 停在「未登录」，等面板发起扫码。登录成功、登出、启停都走
 * 同一套 `#connect` / `#disconnect`，避免出现半连接状态。
 *
 * 这里不解析任何命令、不判断身份：入站消息转换成草稿后原样交给核心（AGENTS.md）。
 *
 * 本文件只留生命周期与装配；收消息流水线在 `inbound-pipeline.ts`，状态视图与
 * 契约版本在 `runtime-status.ts`（AGENTS.md 文件规模规则）。
 */

import { DEFAULT_CDN_BASE_URL, createApi } from './ilink/api.ts';
import type { ILinkApi } from './ilink/api.ts';
import { LoginController } from './ilink/login.ts';
import type { LoginSnapshot } from './ilink/login.ts';
import { SessionGuard } from './ilink/session-guard.ts';
import { messageOf } from './host-context.ts';
import { OwnerChannel } from './owner-channel.ts';
import { forwardPresentedImages } from './present-images.ts';
import { dispatchSessionEvent, type SessionEventDeps } from './session-events.ts';
import { InboundPipeline } from './inbound-pipeline.ts';
import { buildStatus, listWorkspaces } from './runtime-status.ts';
import { DefaultWorkspace, WORKSPACE_ERROR_PREFIX } from './workspace-default.ts';
import type { RuntimeDeps, RuntimeLogger, RuntimeStatus, WorkspaceCatalog, WorkspaceRegistry } from './runtime-status.ts';
import { TypingIndicator } from './typing.ts';
import { QuestionBroker } from './questions.ts';
import type { QuestionNext, QuestionRequest } from './questions.ts';
import { DEFAULT_LONG_TASK_MINUTES, LongTaskNotifier, normalizeLongTaskMinutes } from './long-tasks.ts';
import { RootAgents } from './host-agents.ts';
import type { HostAgents } from './host-agents.ts';
import { DirectChat } from './direct.ts';
import type { DirectController } from './direct.ts';
import { WeixinBridge } from './superagent/bridge.ts';
import type { BridgeHealth } from './superagent/protocol.ts';
import { BridgeBinder } from './superagent/link.ts';
import { ContextTokenStore } from './state/context-tokens.ts';
import { LoginStateStore, accountTail } from './state/login-state.ts';
import type { LoginState } from './state/login-state.ts';
import { DirectBindingStore } from './state/direct-binding.ts';
import { SyncCursorStore } from './state/sync-cursor.ts';
import { resolveWorkspaceDir } from './state/paths.ts';
import {
  DEFAULT_DIRECT_BUSY_MODE,
  LocalConfigStore,
  normalizeBusyMode,
  normalizePluginConfig,
  resolveConfigDir,
} from './config.ts';
import type { BusyMode, PluginConfig } from './config.ts';
import { BotAgentStore, resolveBotAgent } from './bot-agent.ts';
import { CHANNEL_VERSION, PLUGIN_VERSION } from '../shared/version.ts';

const MAX_ERRORS = 5;

export class WeixinRuntime {
  readonly #config: PluginConfig;
  readonly #dir: string;
  readonly #logger: RuntimeLogger;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #createApi: (options: { baseUrl: string; token?: string; botAgent: string }) => ILinkApi;
  readonly #loginStore: LoginStateStore;
  readonly #cursorStore: SyncCursorStore;
  readonly #tokenStore: ContextTokenStore;
  readonly #localConfig: LocalConfigStore;
  readonly #botAgent: string;
  readonly #botAgentStore: BotAgentStore;
  readonly #guard: SessionGuard;
  readonly #loginController: LoginController;
  readonly #owner: OwnerChannel;
  readonly #typing: TypingIndicator;
  readonly #pipeline: InboundPipeline;

  #binder: BridgeBinder | null = null;
  #bridge: WeixinBridge | null = null;
  #api: ILinkApi | null = null;
  #loginState: LoginState | null = null;
  #health: BridgeHealth = { state: 'down', code: 'auth-expired', reason: '尚未登录微信' };
  #errors: { at: number; message: string }[] = [];
  #enabled = true;
  #superagent = true;
  #started = false;
  readonly #roots = new RootAgents();
  readonly #questions: QuestionBroker;
  readonly #longTasks: LongTaskNotifier;
  readonly #directStore: DirectBindingStore;
  readonly #direct: DirectChat;
  #sessionController: DirectController | null = null;
  #workspaceRegistry: WorkspaceRegistry | null = null;
  #directWorkspaceId = '';
  #directBusyMode: BusyMode = DEFAULT_DIRECT_BUSY_MODE;
  readonly #defaultWorkspace: DefaultWorkspace;
  readonly #sessionEvents: SessionEventDeps;
  #stopped = false;

  constructor(deps: RuntimeDeps = {}) {
    this.#config = normalizePluginConfig(deps.config);
    this.#dir = resolveConfigDir(this.#config);
    this.#logger = deps.logger ?? {};
    this.#now = deps.now ?? Date.now;
    this.#fetch = deps.fetch;
    this.#botAgent = resolveBotAgent(this.#config.botAgent);
    this.#botAgentStore = new BotAgentStore({ dir: this.#dir, logger: this.#logger });
    this.#createApi = deps.createApi ?? ((options) => createApi({
      baseUrl: options.baseUrl,
      ...(options.token !== undefined ? { token: options.token } : {}),
      channelVersion: CHANNEL_VERSION,
      botAgent: options.botAgent,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    }));
    this.#loginStore = new LoginStateStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#cursorStore = new SyncCursorStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#tokenStore = new ContextTokenStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#localConfig = new LocalConfigStore({ dir: this.#dir, logger: this.#logger });
    this.#guard = new SessionGuard({ now: this.#now });
    this.#owner = new OwnerChannel({
      active: () => this.#ownFeaturesActive(),
      api: () => this.#api,
      account: () => this.#loginState?.account,
      ownerId: () => this.#loginState?.userId,
      token: (account, to) => this.#tokenStore.get(account, to),
      noteError: (message) => this.#noteError(message),
      cdnBaseUrl: () => this.#config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      fetch: () => this.#fetch,
      logger: this.#logger,
    });
    this.#typing = new TypingIndicator({
      api: () => this.#api,
      contextToken: (userId) => {
        const account = this.#loginState?.account;
        return account ? this.#tokenStore.get(account, userId) : undefined;
      },
      enabled: () => this.#config.typingIndicator ?? true,
      logger: this.#logger,
      now: this.#now,
    });
    this.#questions = new QuestionBroker({
      send: (text) => this.#owner.send(text),
      recipient: () => this.#owner.recipient(),
      isRoot: (agentId) => this.#roots.isRoot(agentId),
      logger: this.#logger,
      now: this.#now,
    });
    this.#longTasks = new LongTaskNotifier({
      send: (text) => this.#owner.send(text),
      recipient: () => this.#owner.recipient(),
      isRoot: (sessionId) => this.#roots.isRoot(sessionId),
      now: this.#now,
      logger: this.#logger,
      thresholdMinutes: this.#config.longTaskThresholdMinutes ?? DEFAULT_LONG_TASK_MINUTES,
    });
    this.#directWorkspaceId = this.#config.directWorkspaceId ?? '';
    this.#directBusyMode = this.#config.directBusyMode ?? DEFAULT_DIRECT_BUSY_MODE;
    this.#directStore = new DirectBindingStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#direct = new DirectChat({
      controller: () => this.#sessionController,
      store: this.#directStore,
      workspaceId: () => (this.#directWorkspaceId.trim() !== '' ? this.#directWorkspaceId : this.#defaultWorkspace.id),
      busyMode: () => this.#directBusyMode,
      send: (text) => this.#owner.send(text),
      isOwner: (sender) => this.#owner.isOwner(sender),
      ownerLabel: () => accountTail(this.#loginState?.userId ?? ''),
      logger: this.#logger,
      now: this.#now,
      ...(this.#config.maxText !== undefined ? { maxText: this.#config.maxText } : {}),
    });
    this.#loginController = new LoginController({
      apiFactory: (baseUrl) => this.#createApi({ baseUrl, botAgent: this.#botAgent }),
      store: this.#loginStore,
      localTokenList: () => (this.#loginState ? [this.#loginState.botToken] : []),
      logger: this.#logger,
      now: this.#now,
      verifyPin: this.#config.verifyPin === true,
      onConfirmed: (state) => this.#handleConfirmed(state),
    });
    this.#defaultWorkspace = new DefaultWorkspace({
      // 工作区与状态目录分开（ADR-0021）：会话 cwd 里不能有 login.json。
      path: deps.workspaceDir ?? resolveWorkspaceDir(),
      registry: () => this.#workspaceRegistry,
      noteError: (message) => this.#noteError(message),
      // 恢复成功后把旧的失败横幅清掉，否则一次瞬时失败会挂到下次扫码。
      clearError: () => { this.#errors = this.#errors.filter((item) => !item.message.startsWith(WORKSPACE_ERROR_PREFIX)); },
      logger: this.#logger,
      ...(deps.workspaceTimeoutMs !== undefined ? { timeoutMs: deps.workspaceTimeoutMs } : {}),
    });
    this.#sessionEvents = {
      ownFeaturesActive: () => this.#ownFeaturesActive(),
      longTasks: this.#longTasks,
      binding: () => this.#direct.binding(),
      ownerUserId: () => this.#loginState?.userId ?? '',
      typingStop: (userId) => this.#typing.stop(userId),
      forwardPresented: (event) => forwardPresentedImages(event, this.#owner, this.#logger),
      directHandle: (sessionId, event) => this.#direct.handleEvent(sessionId, event),
    };
    this.#pipeline = new InboundPipeline({
      enabled: () => this.#enabled,
      stopped: () => this.#stopped,
      connection: () => {
        const api = this.#api;
        const state = this.#loginState;
        return api !== null && state !== null ? { api, account: state.account } : null;
      },
      cursor: this.#cursorStore,
      contextTokens: this.#tokenStore,
      guard: this.#guard,
      logger: this.#logger,
      now: this.#now,
      fetch: this.#fetch,
      cdnBaseUrl: this.#config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      bridge: () => this.#bridge,
      binder: () => this.#binder,
      ownFeaturesActive: () => this.#ownFeaturesActive(),
      isOwner: (sender) => this.#owner.isOwner(sender),
      replyQuestion: (text) => this.#questions.reply(text),
      superagentEnabled: () => this.#superagent,
      directAvailable: () => this.#direct.status().available,
      typingStart: (sender) => this.#typing.start(sender),
      typingStop: (sender) => this.#typing.stop(sender),
      submitDirect: async (sender, content) => {
        // 默认工作区没建好就建会话，会落到宿主默认位置：先确保它在这里。
        await this.#defaultWorkspace.ensure();
        return this.#direct.submit(sender, content).catch((error: unknown) => {
          this.#logger.warn?.('独立模式处理失败', messageOf(error));
          return 'failed' as const;
        });
      },
      setHealth: (health) => {
        this.#health = health;
      },
      noteError: (message) => this.#noteError(message),
    });
  }

  get dir(): string {
    return this.#dir;
  }

  /** `agents` 服务接入（index.ts 的子 fiber）：根会话集合随服务就绪与 agent 生命周期刷新。 */
  attachAgents(agents: HostAgents | null): void {
    this.#roots.attach(agents);
  }

  refreshRoots(): void {
    this.#roots.refresh();
  }

  /** `sessionController` 服务接入（index.ts 的子 fiber）：独立模式直接往会话里提交消息。 */
  attachSessionController(controller: DirectController | null): void {
    this.#sessionController = controller;
  }

  /** `workspaceRegistry` 服务接入：面板用官方工作区列表选会话要加入哪个工作区。 */
  attachWorkspaceRegistry(registry: WorkspaceRegistry | null): void {
    this.#workspaceRegistry = registry;
    // 服务换了（重建/解挂）就不能再沿用旧 id；服务一到就把默认工作区建出来。
    this.#defaultWorkspace.reset();
    if (registry) void this.#defaultWorkspace.ensure();
  }

  /** 面板的工作区候选：先等默认工作区建好，否则第一次打开下拉看不到「微信会话」。 */
  async workspacesView(): Promise<WorkspaceCatalog> {
    await this.#defaultWorkspace.ensure();
    return listWorkspaces(this.#workspaceRegistry);
  }

  /** `user-questions/request` 监听器。 */
  handleQuestion(request: QuestionRequest, next: QuestionNext): Promise<unknown> {
    return this.#questions.handle(request, next, this.#ownFeaturesActive());
  }

  handleSessionEvent(session: unknown, event: unknown): void {
    dispatchSessionEvent(this.#sessionEvents, session, event);
  }

  attachBinder(binder: BridgeBinder): void {
    this.#binder = binder;
    if (this.#bridge) binder.bind(this.#superagent ? this.#bridge : null);
  }

  /** 读登录态、按需连接。失败不抛：面板要能看到「为什么没连上」。 */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    // 有效 UA 落盘给同机的 dsh-wechat-send：命令读不到宿主 profile 里的插件配置。
    await this.#botAgentStore.save(this.#botAgent);
    const stored = await this.#localConfig.load();
    this.#enabled = stored.enabled ?? this.#config.enabled ?? true;
    this.#superagent = stored.superagent ?? this.#config.superagent ?? true;
    this.#longTasks.setThresholdMinutes(
      stored.longTaskThresholdMinutes ?? this.#config.longTaskThresholdMinutes ?? DEFAULT_LONG_TASK_MINUTES,
    );
    this.#directWorkspaceId = stored.directWorkspaceId ?? this.#config.directWorkspaceId ?? '';
    this.#directBusyMode = stored.directBusyMode ?? this.#config.directBusyMode ?? DEFAULT_DIRECT_BUSY_MODE;
    await this.#directStore.hydrate();
    this.#loginState = await this.#loginStore.load();
    if (!this.#loginState) {
      this.#health = { state: 'down', code: 'auth-expired', reason: '尚未登录微信' };
      return;
    }
    await this.#tokenStore.hydrate(this.#loginState.account);
    this.#connect(this.#loginState);
    this.#syncOwnFeatures('插件已启动，提问交回 Web 端');
  }

  /** 停机：收敛登录状态机、停轮询、通知服务端、解绑桥。 */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    // 登录状态机独立于轮询在跑（最长 8 分钟）；不停掉它，卸载重装后一旦
    // 扫码确认就会重写 login.json 并在插件已 dispose 之后重新建桥。
    await this.#loginController.cancel();
    const api = this.#api;
    this.#typing.stopAll();
    this.#questions.close();
    this.#longTasks.configure(false);
    await this.#pipeline.stop();
    this.#api = null;
    this.#binder?.bind(null);
    this.#bridge = null;
    await this.#tokenStore.flush();
    if (api) await api.notifyStop().catch(() => undefined);
  }

  status(): RuntimeStatus {
    return buildStatus({
      version: PLUGIN_VERSION,
      enabled: this.#enabled,
      superagent: this.#superagent,
      ownFeatures: this.#ownFeaturesActive(),
      pendingQuestions: this.#questions.snapshot().pending,
      trackingTasks: this.#longTasks.tracking,
      direct: this.#direct.status(),
      longTaskThresholdMinutes: this.#longTasks.thresholdMinutes,
      login: this.#loginState,
      loginSnapshot: this.#loginController.snapshot(),
      health: this.#bridge?.health() ?? this.#health,
      bridge: this.#binder
        ? { registered: this.#binder.registered, ...(this.#binder.id ? { id: this.#binder.id } : {}), features: this.#binder.features }
        : null,
      errors: this.#errors,
    });
  }

  /**
   * 自有功能是否生效：插件在跑（启用 + 已登录）且**没有**接入超级助理。
   *
   * 与如流桥同一套语义：核心接管后，问题与长任务提醒由核心发交付，插件自己那份要停掉，
   * 否则同一条提醒会来两遍。
   */
  #ownFeaturesActive(): boolean {
    return this.#enabled && !this.#superagent && this.#loginState !== null && !this.#stopped;
  }

  /**
   * 自有功能的开合跟着启停/登录/接入开关走。
   *
   * 关掉时把在等的问题交回，`reason` 由调用点给出真实原因（登出、停用、切出接入），
   * 让工具调用拿到可读的话而不是挂在那里（Web 那边本来也在等同一份请求）。
   */
  #syncOwnFeatures(reason: string): void {
    const active = this.#ownFeaturesActive();
    this.#longTasks.configure(active);
    if (!active) this.#questions.cancelAll(reason);
  }

  /** 开始扫码登录；返回初始快照（含二维码内容）。 */
  async startLogin(): Promise<LoginSnapshot> {
    return this.#loginController.start();
  }

  /** 等扫码状态机结束（测试与停机用）。 */
  async waitForLoginSettled(): Promise<void> {
    await this.#loginController.waitForSettled();
  }

  submitLoginCode(code: string): LoginSnapshot {
    this.#loginController.submitVerifyCode(code);
    return this.#loginController.snapshot();
  }

  async cancelLogin(): Promise<LoginSnapshot> {
    await this.#loginController.cancel();
    return this.#loginController.snapshot();
  }

  /** 登出：清登录态与该账号的 context_token，桥随之解绑。 */
  async logout(): Promise<RuntimeStatus> {
    const account = this.#loginState?.account;
    await this.#loginController.cancel();
    await this.#pipeline.stop();
    this.#typing.stopAll();
    this.#api = null;
    this.#bridge = null;
    this.#binder?.bind(null);
    this.#loginState = null;
    this.#syncOwnFeatures('已登出微信，提问交回 Web 端');
    this.#health = { state: 'down', code: 'auth-expired', reason: '已登出' };
    await this.#loginStore.clear();
    if (account) await this.#tokenStore.clearAccount(account);
    return this.status();
  }

  /** 保存「接入我的超级助理」开关：立即切换，不重连微信。 */
  async setSuperagent(enabled: boolean): Promise<RuntimeStatus> {
    this.#superagent = enabled;
    // 切出核心接入后不会再有交付进来收尾，先把在途的输入状态取消。
    if (!enabled) this.#typing.stopAll();
    await this.#localConfig.save({ superagent: enabled });
    this.#binder?.bind(enabled ? this.#bridge : null);
    this.#syncOwnFeatures('已切换为接入我的超级助理，提问交回 Web 端');
    return this.status();
  }

  /** 保存长任务阈值（分钟）：就地生效，不重连微信。 */
  async setLongTaskThreshold(minutes: number): Promise<RuntimeStatus> {
    const next = normalizeLongTaskMinutes(minutes) ?? DEFAULT_LONG_TASK_MINUTES;
    this.#longTasks.setThresholdMinutes(next);
    await this.#localConfig.save({ longTaskThresholdMinutes: next });
    return this.status();
  }

  /** 面板保存独立模式设置：工作区、提交方式，或重置绑定（ADR-0009）。 */
  async setDirect(patch: { workspaceId?: string; busyMode?: BusyMode; reset?: boolean }): Promise<RuntimeStatus> {
    const workspaceId = typeof patch.workspaceId === 'string' ? patch.workspaceId.trim() : undefined;
    // 工作区是外部输入：宿主能列出来就必须是其中的一个，避免绑定一个不存在的 id。
    if (workspaceId !== undefined && workspaceId !== '') {
      const catalog = listWorkspaces(this.#workspaceRegistry);
      if (catalog.available && !catalog.items.some((item) => item.id === workspaceId)) {
        throw Object.assign(new Error('所选工作区已不存在，请重新选择'), { code: 'invalid-config' });
      }
    }
    const busyMode = normalizeBusyMode(patch.busyMode);
    // 选中的就是自动创建的默认工作区时落成空值：宿主重建工作区换了 id 也仍跟随默认。
    const chosen = workspaceId !== undefined
      && this.#defaultWorkspace.id !== ''
      && workspaceId === this.#defaultWorkspace.id
      ? ''
      : workspaceId;
    if (chosen !== undefined) this.#directWorkspaceId = chosen;
    if (busyMode !== undefined) this.#directBusyMode = busyMode;
    if (patch.reset === true) await this.#direct.reset();
    await this.#localConfig.save({
      ...(chosen !== undefined ? { directWorkspaceId: chosen } : {}),
      ...(busyMode !== undefined ? { directBusyMode: busyMode } : {}),
    });
    return this.status();
  }

  /** 面板开关：停用后不再收消息，桥也向核心报告不可用。 */
  async setEnabled(enabled: boolean): Promise<RuntimeStatus> {
    this.#enabled = enabled;
    await this.#localConfig.save({ enabled });
    if (enabled) this.#pipeline.start();
    else {
      await this.#pipeline.stop();
      this.#typing.stopAll();
    }
    this.#syncOwnFeatures(enabled ? '插件已启用，提问交回 Web 端' : '插件已停用，提问交回 Web 端');
    return this.status();
  }

  async #handleConfirmed(state: LoginState): Promise<void> {
    if (this.#stopped) return;
    this.#errors = [];
    this.#loginState = state;
    await this.#tokenStore.hydrate(state.account);
    await this.#pipeline.stop();
    this.#connect(state);
  }

  #connect(state: LoginState): void {
    if (this.#stopped) return;
    // 基址白名单已在状态边界（parseLoginState）与登录写入时各验一次，这里不再复检。
    this.#api = this.#createApi({ baseUrl: state.baseUrl, token: state.botToken, botAgent: this.#botAgent });
    this.#guard.resume(state.account);
    this.#bridge = new WeixinBridge({
      account: state.account,
      api: () => this.#api,
      ownerId: () => this.#loginState?.userId,
      contextTokens: this.#tokenStore,
      guard: this.#guard,
      logger: this.#logger,
      ...(this.#config.maxText !== undefined ? { maxText: this.#config.maxText } : {}),
      health: () => this.#health,
      isEnabled: () => this.#enabled,
      onDelivered: (recipient) => this.#typing.stop(recipient),
      cdnBaseUrl: this.#config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
    });
    this.#binder?.bind(this.#superagent ? this.#bridge : null);
    this.#pipeline.start();
    this.#syncOwnFeatures('已切换为接入我的超级助理，提问交回 Web 端');
  }

  #noteError(message: string): void {
    this.#errors.push({ at: this.#now(), message });
    if (this.#errors.length > MAX_ERRORS) this.#errors.shift();
  }
}
