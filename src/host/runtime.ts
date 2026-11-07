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
import type { WeixinMessage } from './ilink/types.ts';
import { WeixinBridge } from './superagent/bridge.ts';
import type { BridgeHealth } from './superagent/protocol.ts';
import { BridgeBinder } from './superagent/link.ts';
import { ContextTokenStore } from './state/context-tokens.ts';
import { LoginStateStore, accountTail } from './state/login-state.ts';
import type { LoginState } from './state/login-state.ts';
import { SyncCursorStore } from './state/sync-cursor.ts';
import {
  LocalConfigStore,
  defaultBotAgent,
  normalizePluginConfig,
  resolveConfigDir,
} from './config.ts';
import type { PluginConfig } from './config.ts';
import { PLUGIN_VERSION } from '../shared/version.ts';

/** 面板 RPC 契约版本：加端点或改返回结构时必须递增。 */
export const HOST_CONTRACT = 1;

const MAX_ERRORS = 5;

export interface RuntimeLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
  error?(...args: unknown[]): unknown;
}

export interface RuntimeStatus {
  contract: number;
  version: string;
  enabled: boolean;
  loggedIn: boolean;
  accountTail?: string;
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

  #binder: BridgeBinder | null = null;
  #bridge: WeixinBridge | null = null;
  #api: ILinkApi | null = null;
  #loginState: LoginState | null = null;
  #pollAbort: AbortController | null = null;
  #pollTask: Promise<void> | null = null;
  #health: BridgeHealth = { state: 'down', code: 'auth-expired', reason: '尚未登录微信' };
  #errors: { at: number; message: string }[] = [];
  #enabled = true;
  #started = false;
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
      channelVersion: PLUGIN_VERSION,
      botAgent: agent,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    }));
    this.#loginStore = new LoginStateStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#cursorStore = new SyncCursorStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#tokenStore = new ContextTokenStore({ dir: this.#dir, logger: this.#logger, now: this.#now });
    this.#localConfig = new LocalConfigStore({ dir: this.#dir, logger: this.#logger });
    this.#guard = new SessionGuard({ now: this.#now });
    this.#loginController = new LoginController({
      apiFactory: (baseUrl) => this.#createApi({ baseUrl }),
      store: this.#loginStore,
      localTokenList: () => (this.#loginState ? [this.#loginState.botToken] : []),
      logger: this.#logger,
      now: this.#now,
      onConfirmed: (state) => this.#handleConfirmed(state),
    });
  }

  get dir(): string {
    return this.#dir;
  }

  get bridge(): WeixinBridge | null {
    return this.#bridge;
  }

  attachBinder(binder: BridgeBinder): void {
    this.#binder = binder;
    if (this.#bridge) binder.bind(this.#bridge);
  }

  /** 读登录态、按需连接。失败不抛：面板要能看到「为什么没连上」。 */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const stored = await this.#localConfig.load();
    this.#enabled = stored.enabled ?? this.#config.enabled ?? true;
    this.#loginState = await this.#loginStore.load();
    if (!this.#loginState) {
      this.#health = { state: 'down', code: 'auth-expired', reason: '尚未登录微信' };
      return;
    }
    await this.#tokenStore.hydrate(this.#loginState.account);
    this.#connect(this.#loginState);
  }

  /** 停机：停轮询、通知服务端、解绑桥。 */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const api = this.#api;
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
      loggedIn: login !== null,
      ...(login ? { accountTail: accountTail(login.account) } : {}),
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
    await this.#stopPolling();
    this.#api = null;
    this.#bridge = null;
    this.#binder?.bind(null);
    this.#loginState = null;
    this.#health = { state: 'down', code: 'auth-expired', reason: '已登出' };
    await this.#loginStore.clear();
    if (account) await this.#tokenStore.clearAccount(account);
    return this.status();
  }

  /** 面板开关：停用后不再收消息，桥也向核心报告不可用。 */
  async setEnabled(enabled: boolean): Promise<RuntimeStatus> {
    this.#enabled = enabled;
    await this.#localConfig.save({ enabled });
    if (enabled) this.#startPolling();
    else await this.#stopPolling();
    return this.status();
  }

  async #handleConfirmed(state: LoginState): Promise<void> {
    this.#errors = [];
    this.#loginState = state;
    await this.#tokenStore.hydrate(state.account);
    await this.#stopPolling();
    this.#connect(state);
  }

  #connect(state: LoginState): void {
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
    });
    this.#binder?.bind(this.#bridge);
    this.#startPolling();
  }

  #startPolling(): void {
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
      onMessage: (message) => this.#handleInbound(message),
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
  async #handleInbound(message: WeixinMessage): Promise<void> {
    const bridge = this.#bridge;
    const binder = this.#binder;
    if (!bridge || !binder) return;
    const ownerLookup = bridge.ownerLookup;
    const draft = await toOwnerMessageDraft(message, {
      account: bridge.account,
      cdnBaseUrl: this.#config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      imagesEnabled: bridge.imagesEnabled,
      ...(ownerLookup ? { senderIsOwner: ownerLookup } : {}),
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
      logger: this.#logger,
      now: this.#now,
    });
    if (!draft) return;
    const result = await binder.receive(draft);
    if (result && result.accepted === false) {
      // 拒收原因是核心的判断（不是主人、格式不合法……），桥只记账不回话。
      this.#noteError(`核心拒收入站消息：${result.reason}`);
    }
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}
