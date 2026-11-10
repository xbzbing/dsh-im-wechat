/**
 * 运行期：把登录态、协议客户端、轮询、桥与面板串起来（ADR-0001 的装配点）。
 *
 * 生命周期只有两条路径：**有登录态** → 建客户端、注册桥、起轮询；
 * **没有登录态** → 停在「未登录」，等面板发起扫码。登录成功、登出、启停都走
 * 同一套 `#connect` / `#disconnect`，避免出现半连接状态。
 *
 * 这里不解析任何命令、不判断身份：入站消息转换成草稿后原样交给核心（AGENTS.md）。
 */

import { DEFAULT_CDN_BASE_URL, createApi } from './ilink/api.ts';
import type { ILinkApi } from './ilink/api.ts';
import { LoginController } from './ilink/login.ts';
import type { LoginSnapshot } from './ilink/login.ts';
import { PollLoop } from './ilink/poll.ts';
import type { PollHealth } from './ilink/poll.ts';
import { SessionGuard } from './ilink/session-guard.ts';
import { toOwnerMessageDraft } from './inbound.ts';
import { messageText } from './ilink/identity.ts';
import type { WeixinMessage } from './ilink/types.ts';
import { messageOf } from './host-context.ts';
import { OwnerChannel } from './owner-channel.ts';
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
import {
  DEFAULT_DIRECT_BUSY_MODE,
  LocalConfigStore,
  defaultBotAgent,
  normalizeBusyMode,
  normalizePluginConfig,
  resolveConfigDir,
} from './config.ts';
import type { BusyMode, PluginConfig } from './config.ts';
import { CHANNEL_VERSION, PLUGIN_VERSION } from '../shared/version.ts';

/** 面板 RPC 契约版本：加端点或改返回结构时必须递增。 */
export const HOST_CONTRACT = 3;

const MAX_ERRORS = 5;

/** 宿主 `workspaceRegistry` 里本插件用到的部分（结构类型）。 */
export interface WorkspaceRegistry {
  list(): readonly { id?: unknown; title?: unknown; path?: unknown }[];
}

export interface RuntimeLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
  error?(...args: unknown[]): unknown;
}

export interface RuntimeStatus {
  contract: number;
  version: string;
  enabled: boolean;
  /** 是否接入「我的超级助理」。关掉后插件自带的问题与长任务提醒接管。 */
  superagent: boolean;
  /** 自有功能（问题提醒、长任务提醒）是否生效。 */
  ownFeatures: boolean;
  /** 登录态里是否记录了扫码的微信用户（没记录就无法确认主人，自有提醒会静默失效）。 */
  ownerKnown: boolean;
  /** 等待主人作答的问题数。 */
  pendingQuestions: number;
  /** 正在跟踪的回合数（长任务提醒用）。 */
  trackingTasks: number;
  /** 长任务提醒阈值（分钟）：回合超过它才提醒。 */
  longTaskThresholdMinutes: number;
  /** 独立模式（未接入核心）的直连会话状态（ADR-0009）。 */
  direct: {
    bound: boolean;
    sessionId?: string;
    workspaceId: string;
    busyMode: BusyMode;
    running: boolean;
    available: boolean;
  };
  loggedIn: boolean;
  accountTail?: string;
  /** 上次扫码成功的时间；面板的「登录时间」用它。 */
  loggedInAt?: number;
  login: LoginSnapshot;
  health: BridgeHealth;
  bridge: { registered: boolean; id?: string; features: string[] };
  lastError?: { at: number; message: string };
}

export interface RuntimeDeps {
  config?: unknown;
  logger?: RuntimeLogger;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** 测试注入：造协议客户端。 */
  createApi?: (options: { baseUrl: string; token?: string }) => ILinkApi;
}

export class WeixinRuntime {
  readonly #config: PluginConfig;
  readonly #dir: string;
  readonly #logger: RuntimeLogger;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch | undefined;
  readonly #createApi: (options: { baseUrl: string; token?: string }) => ILinkApi;
  readonly #loginStore: LoginStateStore;
  readonly #cursorStore: SyncCursorStore;
  readonly #tokenStore: ContextTokenStore;
  readonly #localConfig: LocalConfigStore;
  readonly #guard: SessionGuard;
  readonly #loginController: LoginController;
  readonly #owner: OwnerChannel;
  readonly #typing: TypingIndicator;

  #binder: BridgeBinder | null = null;
  #bridge: WeixinBridge | null = null;
  #api: ILinkApi | null = null;
  #loginState: LoginState | null = null;
  #pollAbort: AbortController | null = null;
  #pollTask: Promise<void> | null = null;
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
  #stopped = false;

  constructor(deps: RuntimeDeps = {}) {
    this.#config = normalizePluginConfig(deps.config);
    this.#dir = resolveConfigDir(this.#config);
    this.#logger = deps.logger ?? {};
    this.#now = deps.now ?? Date.now;
    this.#fetch = deps.fetch;
    const agent = this.#config.botAgent ?? defaultBotAgent();
    this.#createApi = deps.createApi ?? ((options) => createApi({
      baseUrl: options.baseUrl,
      ...(options.token !== undefined ? { token: options.token } : {}),
      channelVersion: CHANNEL_VERSION,
      botAgent: agent,
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
      workspaceId: () => this.#directWorkspaceId,
      busyMode: () => this.#directBusyMode,
      send: (text) => this.#owner.send(text),
      isOwner: (sender) => this.#owner.isOwner(sender),
      ownerLabel: () => accountTail(this.#loginState?.userId ?? ''),
      logger: this.#logger,
      now: this.#now,
      ...(this.#config.maxText !== undefined ? { maxText: this.#config.maxText } : {}),
    });
    this.#loginController = new LoginController({
      apiFactory: (baseUrl) => this.#createApi({ baseUrl }),
      store: this.#loginStore,
      localTokenList: () => (this.#loginState ? [this.#loginState.botToken] : []),
      logger: this.#logger,
      now: this.#now,
      verifyPin: this.#config.verifyPin === true,
      onConfirmed: (state) => this.#handleConfirmed(state),
    });
  }

  get dir(): string {
    return this.#dir;
  }

  get bridge(): WeixinBridge | null {
    return this.#bridge;
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
  }

  /** 面板的工作区候选；宿主没有这个服务时 available=false，面板显示原因。 */
  workspaces(): { items: { id: string; title: string; path: string }[]; available: boolean; reason?: string } {
    const registry = this.#workspaceRegistry;
    if (!registry || typeof registry.list !== 'function') {
      return { items: [], available: false, reason: '宿主不提供工作区服务' };
    }
    try {
      const items = registry.list().flatMap((workspace) => {
        const id = typeof workspace?.id === 'string' ? workspace.id : '';
        if (id === '') return [];
        const title = typeof workspace.title === 'string' && workspace.title.trim() !== '' ? workspace.title.trim() : id;
        const path = typeof workspace.path === 'string' ? workspace.path : '';
        return [{ id, title, path }];
      });
      return { items, available: true };
    } catch {
      return { items: [], available: false, reason: '读取宿主工作区失败' };
    }
  }

  /** `user-questions/request` 监听器。 */
  handleQuestion(request: QuestionRequest, next: QuestionNext): Promise<unknown> {
    return this.#questions.handle(request, next, this.#ownFeaturesActive());
  }

  /** `session/event` 监听器：长任务提醒。 */
  handleSessionEvent(session: unknown, event: unknown): void {
    if (!this.#ownFeaturesActive()) return;
    const sessionId = typeof session === 'string'
      ? session
      : typeof (session as { id?: unknown } | null)?.id === 'string'
        ? String((session as { id: string }).id)
        : '';
    if (sessionId === '') return;
    this.#longTasks.handleEvent(sessionId, event);
    // 独立模式：只跟踪绑定的那个会话；接入核心后这条链路整段沉默。
    const binding = this.#direct.binding();
    if (binding !== null && binding.sessionId === sessionId) {
      const type = (event as { type?: unknown } | null)?.type;
      if (type === 'turn/end') this.#typing.stop(this.#loginState?.userId ?? '');
      this.#direct.handleEvent(sessionId, event);
    }
  }

  attachBinder(binder: BridgeBinder): void {
    this.#binder = binder;
    if (this.#bridge) binder.bind(this.#superagent ? this.#bridge : null);
  }

  /** 读登录态、按需连接。失败不抛：面板要能看到「为什么没连上」。 */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
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
    this.#syncOwnFeatures();
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
    await this.#stopPolling();
    this.#api = null;
    this.#binder?.bind(null);
    this.#bridge = null;
    await this.#tokenStore.flush();
    if (api) await api.notifyStop().catch(() => undefined);
  }

  status(): RuntimeStatus {
    const bridge = this.#bridge;
    const login = this.#loginState;
    const lastError = this.#errors[this.#errors.length - 1];
    return {
      contract: HOST_CONTRACT,
      version: PLUGIN_VERSION,
      enabled: this.#enabled,
      superagent: this.#superagent,
      ownFeatures: this.#ownFeaturesActive(),
      ownerKnown: typeof login?.userId === 'string' && login.userId !== '',
      pendingQuestions: this.#questions.snapshot().pending,
      trackingTasks: this.#longTasks.tracking,
      direct: this.#direct.status(),
      longTaskThresholdMinutes: this.#longTasks.thresholdMinutes,
      loggedIn: login !== null,
      ...(login ? { accountTail: accountTail(login.account), loggedInAt: login.loggedInAt } : {}),
      login: this.#loginController.snapshot(),
      health: bridge?.health() ?? this.#health,
      bridge: {
        registered: this.#binder?.registered ?? false,
        ...(this.#binder?.id ? { id: this.#binder.id } : {}),
        features: [...(this.#binder?.features ?? [])],
      },
      ...(lastError ? { lastError } : {}),
    };
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
   * 关掉时把在等的问题交回：`open` 时说明是「切换到接入超级助理」，让工具调用拿到
   * 可读的原因而不是挂在那里（Web 那边本来也在等同一份请求）。
   */
  #syncOwnFeatures(): void {
    const active = this.#ownFeaturesActive();
    this.#longTasks.configure(active);
    if (!active) this.#questions.cancelAll('已切换为接入我的超级助理，提问交回 Web 端');
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
    await this.#stopPolling();
    this.#typing.stopAll();
    this.#api = null;
    this.#bridge = null;
    this.#binder?.bind(null);
    this.#loginState = null;
    this.#syncOwnFeatures();
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
    this.#syncOwnFeatures();
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
      const catalog = this.workspaces();
      if (catalog.available && !catalog.items.some((item) => item.id === workspaceId)) {
        throw Object.assign(new Error('所选工作区已不存在，请重新选择'), { code: 'invalid-config' });
      }
    }
    const busyMode = normalizeBusyMode(patch.busyMode);
    if (workspaceId !== undefined) this.#directWorkspaceId = workspaceId;
    if (busyMode !== undefined) this.#directBusyMode = busyMode;
    if (patch.reset === true) await this.#direct.reset();
    await this.#localConfig.save({
      ...(workspaceId !== undefined ? { directWorkspaceId: workspaceId } : {}),
      ...(busyMode !== undefined ? { directBusyMode: busyMode } : {}),
    });
    return this.status();
  }

  /** 面板开关：停用后不再收消息，桥也向核心报告不可用。 */
  async setEnabled(enabled: boolean): Promise<RuntimeStatus> {
    this.#enabled = enabled;
    await this.#localConfig.save({ enabled });
    if (enabled) this.#startPolling();
    else {
      await this.#stopPolling();
      this.#typing.stopAll();
    }
    this.#syncOwnFeatures();
    return this.status();
  }

  async #handleConfirmed(state: LoginState): Promise<void> {
    if (this.#stopped) return;
    this.#errors = [];
    this.#loginState = state;
    await this.#tokenStore.hydrate(state.account);
    await this.#stopPolling();
    this.#connect(state);
  }

  #connect(state: LoginState): void {
    if (this.#stopped) return;
    // 基址白名单已在状态边界（parseLoginState）与登录写入时各验一次，这里不再复检。
    this.#api = this.#createApi({ baseUrl: state.baseUrl, token: state.botToken });
    this.#guard.resume(state.account);
    this.#bridge = new WeixinBridge({
      account: state.account,
      api: () => this.#api,
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
    this.#startPolling();
    this.#syncOwnFeatures();
  }

  #startPolling(): void {
    if (this.#stopped) return;
    const api = this.#api;
    const state = this.#loginState;
    if (!this.#enabled || !api || !state || this.#pollTask) return;
    const abort = new AbortController();
    this.#pollAbort = abort;
    const loop = new PollLoop({
      api,
      account: state.account,
      cursor: this.#cursorStore,
      contextTokens: this.#tokenStore,
      guard: this.#guard,
      onMessage: (message) => this.#handleInbound(message, abort.signal),
      onHealth: (health) => this.#handlePollHealth(health),
      logger: this.#logger,
    });
    this.#pollTask = loop
      .run(abort.signal)
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        this.#noteError(`轮询异常退出：${messageOf(error)}`);
        this.#health = { state: 'down', code: 'other', reason: messageOf(error) };
      })
      .finally(() => {
        this.#pollTask = null;
        this.#pollAbort = null;
      });
    void api.notifyStart().catch(() => undefined);
    this.#health = { state: 'ok' };
  }

  async #stopPolling(): Promise<void> {
    this.#pollAbort?.abort();
    await this.#pollTask;
    this.#pollTask = null;
    this.#pollAbort = null;
  }

  /** 入站：转换成草稿后交给核心；核心不在就不回话，也不丢弃登录态。 */
  async #handleInbound(message: WeixinMessage, signal: AbortSignal): Promise<void> {
    const bridge = this.#bridge;
    const binder = this.#binder;
    if (!bridge) return;
    const sender = typeof message.from_user_id === 'string' ? message.from_user_id : '';

    // 自有功能先认领：这条文本可能是主人在回答微信里的问题。
    // 只认已确认主人的消息——陌生人的文本绝不能把主人的问题答掉。
    if (this.#ownFeaturesActive() && this.#owner.isOwner(sender)) {
      const text = messageText(message.item_list);
      if (text.trim() !== '' && this.#questions.reply(text)) return;
    }

    // 没有接入核心（或核心不在）：独立模式把消息直接交给绑定的会话（ADR-0009）；
    // 没配会话控制器、或不是主人时照旧到此为止。
    if (!this.#superagent || !binder) {
      if (!this.#ownFeaturesActive()) return;
      if (!this.#owner.isOwner(sender)) return;
      const text = messageText(message.item_list);
      if (text.trim() === '') return;
      this.#typing.start(sender);
      void this.#direct.submit(sender, text).catch((error: unknown) => {
        this.#logger.warn?.('独立模式处理失败', messageOf(error));
      });
      return;
    }
    const ownerLookup = bridge.ownerLookup;
    const draft = await toOwnerMessageDraft(message, {
      account: bridge.account,
      cdnBaseUrl: this.#config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      imagesEnabled: bridge.imagesEnabled,
      ...(ownerLookup ? { senderIsOwner: ownerLookup } : {}),
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
      signal,
      logger: this.#logger,
      now: this.#now,
    });
    if (!draft) return;
    const result = await binder.receive(draft);
    if (result && result.accepted === false) {
      // 拒收原因是核心的判断（不是主人、格式不合法……），桥只记账不回话。
      this.#noteError(`核心拒收入站消息：${result.reason}`);
      return;
    }
    // 核心受理了：大模型开始思考，微信那头显示「正在输入」（ADR-0007）。
    // 拒收（非主人、格式不合法）不开启——陌生人触发不了机器人状态。
    if (result) this.#typing.start(sender);
  }

  #handlePollHealth(health: PollHealth): void {
    this.#health = health.state === 'ok'
      ? { state: 'ok' }
      : {
        state: health.state,
        ...(health.code ? { code: health.code } : {}),
        ...(health.reason ? { reason: health.reason } : {}),
      };
    if (health.state !== 'ok' && health.reason) this.#noteError(health.reason);
  }

  #noteError(message: string): void {
    this.#errors.push({ at: this.#now(), message });
    if (this.#errors.length > MAX_ERRORS) this.#errors.shift();
  }
}
