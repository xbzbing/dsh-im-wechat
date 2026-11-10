/**
 * 扫码登录状态机。
 *
 * 由 host 半驱动：`start()` 取到二维码就返回，后台继续长轮询扫码状态；面板只读
 * 快照、必要时提交验证码（ADR-0002）。因此面板刷新、切走、关掉都不会中断扫码。
 *
 * 状态与状态码取自协议：`wait` / `scaned` / `need_verifycode` / `expired` /
 * `verify_code_blocked` / `binded_redirect` / `scaned_but_redirect` / `confirmed`。
 * 3.0.0 起服务端还会返回 `confirmed_but_need_verifycode`：绑定已确认，但安全
 * 要求先补一次 PIN。判断规则是「状态名里包含 `need_verifycode`」，不要只认
 * 旧状态名，否则会一直轮询到超时。语义按官方实现对齐：`binded_redirect` 是
 * 「本来就绑定过」，不是失败。
 */

import type { ILinkApi } from './api.ts';
import { DEFAULT_BASE_URL, isAllowedApiUrl } from './api.ts';
import type { QrStatusResponse } from './types.ts';
import type { LoginState } from '../state/login-state.ts';
import type { LoginStateStore } from '../state/login-state.ts';

export type LoginPhase =
  | 'idle'
  | 'waiting'
  | 'scanned'
  | 'need-verify-code'
  | 'confirmed'
  | 'binded'
  | 'failed'
  | 'cancelled';

/**
 * 是否需要主人补 PIN。
 *
 * `need_verifycode` 是旧状态；3.0.0 新增 `confirmed_but_need_verifycode`。
 * 协议约定按子串判断，后续再出现同族状态也能接住。
 */
export function statusNeedsVerifyCode(status: string | undefined): boolean {
  return typeof status === 'string' && status.includes('need_verifycode');
}

/** 面板读到的登录快照。`qrContent` 是二维码内容，同时是可打开的链接。 */
export interface LoginSnapshot {
  phase: LoginPhase;
  qrContent?: string;
  startedAt?: number;
  refreshed: number;
  error?: string;
}

export interface LoginTimings {
  /** 二维码有效期，过期前主动换一张。 */
  qrTtlMs: number;
  /** 过期 / 验证码被锁后最多刷新几次。 */
  maxRefreshes: number;
  /** 扫码状态长轮询的单次超时。 */
  pollTimeoutMs: number;
  /** 整次登录的总时限。 */
  overallTimeoutMs: number;
  /** 两次轮询之间的间隔（服务端立刻返回时避免打转）。 */
  pollGapMs: number;
  /** 等待主人输入验证码的最长时间。 */
  verifyWaitMs: number;
  /** 扫码状态轮询连续失败多少次判定登录失败。 */
  maxPollFailures: number;
}

export const DEFAULT_LOGIN_TIMINGS: LoginTimings = {
  qrTtlMs: 5 * 60_000,
  maxRefreshes: 3,
  pollTimeoutMs: 35_000,
  overallTimeoutMs: 8 * 60_000,
  pollGapMs: 1_000,
  verifyWaitMs: 120_000,
  maxPollFailures: 5,
};

export interface LoginLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface LoginControllerOptions {
  apiFactory: (baseUrl: string) => ILinkApi;
  store: LoginStateStore;
  /** 本机已有的机器人 token，服务端据此判断是否已绑定过。 */
  localTokenList?: () => readonly string[];
  /**
   * 取码时要求服务端出 PIN（`bot_spam_business_data`）。默认关闭，只用于
   * 提前验证 PIN 交互；关闭它也不能阻止服务端自行要求 PIN。
   */
  verifyPin?: boolean;
  logger?: LoginLogger;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 登录成功后回调（运行期据此换用带 token 的客户端）。 */
  onConfirmed?: (state: LoginState) => void | Promise<void>;
  timings?: Partial<LoginTimings>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      finish();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class LoginController {
  readonly #options: LoginControllerOptions;
  readonly #timings: LoginTimings;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  #phase: LoginPhase = 'idle';
  #qrContent: string | undefined;
  #qrcode: string | undefined;
  #startedAt: number | undefined;
  #qrExpiresAt = 0;
  #refreshed = 0;
  #error: string | undefined;
  #verifyCode: string | undefined;
  #apiBaseUrl = DEFAULT_BASE_URL;
  #abort: AbortController | null = null;
  #running: Promise<void> | null = null;
  /** start() 的同步占位：取码要等网络，期间第二个 start 必须直接返回。 */
  #starting = false;

  constructor(options: LoginControllerOptions) {
    this.#options = options;
    this.#timings = { ...DEFAULT_LOGIN_TIMINGS, ...options.timings };
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  snapshot(): LoginSnapshot {
    return {
      phase: this.#phase,
      ...(this.#qrContent ? { qrContent: this.#qrContent } : {}),
      ...(this.#startedAt !== undefined ? { startedAt: this.#startedAt } : {}),
      refreshed: this.#refreshed,
      ...(this.#error ? { error: this.#error } : {}),
    };
  }

  /** 是否已经结束（成功、放弃或取消）。面板据此停止轮询。 */
  get done(): boolean {
    return this.#phase === 'confirmed' || this.#phase === 'binded'
      || this.#phase === 'failed' || this.#phase === 'cancelled';
  }

  /**
   * 开始一次登录：取二维码，起后台轮询。
   *
   * 已经在进行中时直接返回当前快照——面板重复点「登录」不该起两条轮询。
   */
  async start(): Promise<LoginSnapshot> {
    // 占位必须同步完成：#requestQrCode 是 await，写在它之后会让并发调用
    // （双击、多标签页）各取一次码、各起一条状态机。
    if (this.#running || this.#starting) return this.snapshot();
    this.#starting = true;
    this.#reset();
    // 取消可能落在取码的 await 里：控制器同步建好，那个窗口里的 cancel() 才打得到标；
    // 取码回来先看标，取消了就不再起状态机（否则会跑完整个登录甚至落盘）。
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const api = this.#options.apiFactory(DEFAULT_BASE_URL);
      const ready = await this.#requestQrCode(api);
      if (abort.signal.aborted) {
        this.#abort = null;
        this.#phase = 'cancelled';
        return this.snapshot();
      }
      if (!ready) {
        this.#abort = null;
        return this.snapshot();
      }
      this.#running = this.#run(api, abort.signal).finally(() => {
        this.#running = null;
        this.#abort = null;
      });
      return this.snapshot();
    } finally {
      this.#starting = false;
    }
  }

  /** 面板提交验证码；状态机在 `need-verify-code` 时取用它。 */
  submitVerifyCode(code: string): void {
    const cleaned = code.trim();
    if (cleaned === '') return;
    this.#verifyCode = cleaned;
  }

  /** 等后台轮询结束（停机与测试用；正常流程里面板只读快照）。 */
  async waitForSettled(): Promise<void> {
    await this.#running;
  }

  /** 取消进行中的登录（面板关掉或主动放弃）。 */
  async cancel(): Promise<void> {
    this.#abort?.abort();
    await this.#running;
    // idle 表示从没开始过，别把它标成 cancelled（stop() 也会走到这里）。
    if (!this.done && this.#phase !== 'idle') this.#phase = 'cancelled';
  }

  #reset(): void {
    this.#phase = 'idle';
    this.#qrContent = undefined;
    this.#qrcode = undefined;
    this.#startedAt = undefined;
    this.#qrExpiresAt = 0;
    this.#refreshed = 0;
    this.#error = undefined;
    this.#verifyCode = undefined;
    this.#apiBaseUrl = DEFAULT_BASE_URL;
  }

  async #requestQrCode(api: ILinkApi): Promise<boolean> {
    try {
      const response = await api.getBotQrCode({
        localTokenList: this.#options.localTokenList?.() ?? [],
        ...(this.#options.verifyPin === true ? { verifyPin: true } : {}),
      });
      const qrcode = typeof response.qrcode === 'string' ? response.qrcode : '';
      const content = typeof response.qrcode_img_content === 'string' ? response.qrcode_img_content : '';
      if (qrcode === '' || content === '') {
        this.#fail('二维码响应缺少 qrcode 或内容');
        return false;
      }
      this.#qrcode = qrcode;
      this.#qrContent = content;
      this.#startedAt = this.#now();
      this.#qrExpiresAt = this.#startedAt + this.#timings.qrTtlMs;
      this.#phase = 'waiting';
      this.#error = undefined;
      return true;
    } catch (error) {
      this.#fail(`取二维码失败：${(error as Error)?.message ?? '未知错误'}`);
      return false;
    }
  }

  #fail(message: string): void {
    this.#phase = 'failed';
    this.#error = message;
    this.#options.logger?.warn?.('微信扫码登录失败', message);
  }

  async #run(api: ILinkApi, signal: AbortSignal): Promise<void> {
    const deadline = this.#now() + this.#timings.overallTimeoutMs;
    let failures = 0;
    while (!signal.aborted) {
      // try 包在循环体内：包住整个 while 的话，一次网络错误就退出循环，
      // 登录停在 waiting 却再没有轮询，面板看起来「一直在等」。
      try {
        if (this.#now() > deadline) {
          this.#fail('登录超时，请重试');
          return;
        }
        if (this.#qrcode === undefined) return;
        if (this.#now() > this.#qrExpiresAt && !(await this.#refresh(api))) return;

        const verifying = this.#verifyCode;
        const response = await api.getQrStatus({
          qrcode: this.#qrcode,
          ...(verifying !== undefined ? { verifyCode: verifying } : {}),
          timeoutMs: this.#timings.pollTimeoutMs,
          signal,
          baseUrl: this.#apiBaseUrl,
        });
        if (signal.aborted) return;
        failures = 0;
        if (await this.#handleStatus(api, response)) return;
        await this.#sleep(this.#timings.pollGapMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        // 网络错误不再折成「等待」：连续失败到上限直接报具体原因，面板才看得见。
        failures += 1;
        if (failures >= this.#timings.maxPollFailures) {
          this.#fail(`登录轮询失败：${(error as Error)?.message ?? '未知错误'}`);
          return;
        }
        await this.#sleep(Math.max(this.#timings.pollGapMs, 2_000), signal);
      }
    }
  }

  /** 处理一次状态响应；返回 true 表示流程结束。 */
  async #handleStatus(api: ILinkApi, response: QrStatusResponse): Promise<boolean> {
    // 先判 PIN：`confirmed_but_need_verifycode` 的绑定状态已经确认，但仍要
    // 主人补数字；按旧逻辑落进 default 会一直等到登录总超时。
    if (statusNeedsVerifyCode(response.status)) {
      this.#phase = 'need-verify-code';
      // 上一轮的号码已经被这次响应判过，等主人重新输入；新号码会随下一次
      // 轮询提交。提交后不清空，直到 `scaned` 确认服务端已接受。
      this.#verifyCode = undefined;
      return this.#awaitVerifyCode();
    }
    switch (response.status) {
      case 'wait':
        return false;
      case 'scaned':
        this.#phase = 'scanned';
        // 服务端确认验证码正确后才允许清掉暂存值，与官方一致。
        this.#verifyCode = undefined;
        return false;
      case 'expired':
      case 'verify_code_blocked': {
        const refreshed = await this.#refresh(api);
        return !refreshed;
      }
      case 'scaned_but_redirect': {
        const host = typeof response.redirect_host === 'string' ? response.redirect_host : '';
        const candidate = host === '' ? '' : `https://${host}`;
        // 带凭据的请求只认腾讯域名（ADR-0002）；不合格就留在原域名继续轮询。
        if (candidate !== '' && isAllowedApiUrl(candidate)) this.#apiBaseUrl = candidate;
        return false;
      }
      case 'binded_redirect':
        this.#phase = 'binded';
        return true;
      case 'confirmed':
        return this.#confirm(response);
      default:
        // 未知状态按「继续等」处理：协议新增状态时不该把登录打断。
        return false;
    }
  }

  /** 等主人输入验证码；超时则判定本次登录失败。 */
  async #awaitVerifyCode(): Promise<boolean> {
    const deadline = this.#now() + this.#timings.verifyWaitMs;
    while (this.#now() < deadline) {
      if (this.#abort?.signal.aborted) return true;
      if (this.#verifyCode !== undefined) {
        this.#phase = 'waiting';
        return false;
      }
      await this.#sleep(500, this.#abort?.signal);
    }
    this.#fail('等待验证码超时，请重试');
    return true;
  }

  /** 换一张二维码；超过次数上限则失败。返回 false 表示流程应结束。 */
  async #refresh(api: ILinkApi): Promise<boolean> {
    this.#refreshed += 1;
    if (this.#refreshed > this.#timings.maxRefreshes) {
      this.#fail('二维码多次失效，登录流程已停止');
      return false;
    }
    // 换码后旧号码作废；继续带着它只会让新码的第一轮轮询被服务端判错。
    this.#verifyCode = undefined;
    this.#qrcode = undefined;
    this.#phase = 'waiting';
    return this.#requestQrCode(api);
  }

  async #confirm(response: QrStatusResponse): Promise<boolean> {
    const botToken = typeof response.bot_token === 'string' ? response.bot_token.trim() : '';
    const account = typeof response.ilink_bot_id === 'string' ? response.ilink_bot_id.trim() : '';
    if (botToken === '' || account === '') {
      this.#fail('登录确认缺少 bot_token 或 ilink_bot_id');
      return true;
    }
    const requestedBaseUrl = typeof response.baseurl === 'string' ? response.baseurl.trim() : '';
    // 服务端给的域名也要过白名单：这是带 token 请求的基址（ADR-0002）。
    const baseUrl = requestedBaseUrl !== '' && isAllowedApiUrl(requestedBaseUrl)
      ? requestedBaseUrl
      : DEFAULT_BASE_URL;
    const userId = typeof response.ilink_user_id === 'string' ? response.ilink_user_id.trim() : '';
    const state = await this.#options.store.save({
      botToken,
      account,
      ...(userId !== '' ? { userId } : {}),
      baseUrl,
      loggedInAt: this.#now(),
    });
    this.#phase = 'confirmed';
    this.#qrContent = undefined;
    this.#options.logger?.info?.('微信扫码登录成功');
    try {
      await this.#options.onConfirmed?.(state);
    } catch (error) {
      // 登录本身已经成功且落盘；连接回调失败不该把状态改写成 failed 诱导重扫。
      this.#options.logger?.warn?.(
        `登录成功但连接回调失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
    return true;
  }
}
