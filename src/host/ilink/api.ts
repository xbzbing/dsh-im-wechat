/**
 * iLink HTTP 客户端。
 *
 * 端点、请求头与请求体字段以腾讯官方 `openclaw-weixin` 3.3.2（MIT）的
 * `src/api/api.ts` 为参考自写（ADR-0001）；这里只保留跑通桥所需的部分：
 * 扫码登录、长轮询、发送文本、读机器人配置、启停通知。
 *
 * 约定：
 * - 所有 POST 都带 `base_info`；GET（仅在扫码轮询里用）只带公共头，与官方一致。
 * - `X-WECHAT-UIN` 每次请求重新随机，是协议要求的「客户端实例号」，不是身份。
 * - 失败一律抛 `ILinkError`：`kind` 区分 HTTP 状态、业务 `ret/errcode`、超时与网络，
 *   上层据此决定重试、暂停还是回 `window-closed`（ADR-0002 与 M2 的回执映射）。
 * - 不记录请求体、响应体、token；日志里只允许出现端点名与状态码。
 */

import { randomBytes } from 'node:crypto';

import { parseJsonKeepIntegers } from './json.ts';
import type {
  BaseInfo,
  GenericResponse,
  GetConfigResponse,
  GetUpdatesResponse,
  OutboundMessage,
  QrCodeResponse,
  QrStatusResponse,
} from './types.ts';

/** 扫码与 API 共用的默认域名；登录成功后以服务端返回的 `baseurl` 为准。 */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** 媒体 CDN 基址。 */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** `iLink-App-Id` 对机器人接入方固定为 `bot`。 */
export const ILINK_APP_ID = 'bot';

/**
 * `iLink-App-ClientVersion`：`0x00MMNNPP`。
 *
 * 取官方 3.3.x 客户端的编码值（(3<<16)|(3<<8)|2 = 197378）。服务端按这个值
 * 判断客户端能力，跟着我们自己的包版本走会让它以为是个更老的客户端。
 */
export const ILINK_APP_CLIENT_VERSION = 197378;

export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
export const DEFAULT_API_TIMEOUT_MS = 15_000;
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/** 登录二维码的 `bot_type`，与官方实现一致。 */
export const DEFAULT_BOT_TYPE = '3';

export type ILinkErrorKind = 'http' | 'api' | 'timeout' | 'network';

/** 协议层统一错误。`kind` 是分派依据，其余字段只在对应 kind 下有值。 */
export class ILinkError extends Error {
  readonly kind: ILinkErrorKind;
  readonly status: number | undefined;
  readonly ret: number | undefined;
  readonly errcode: number | undefined;
  readonly reason: string | undefined;

  constructor(
    kind: ILinkErrorKind,
    message: string,
    extra: { status?: number; ret?: number; errcode?: number; reason?: string } = {},
  ) {
    super(message);
    this.name = 'ILinkError';
    this.kind = kind;
    this.status = extra.status;
    this.ret = extra.ret;
    this.errcode = extra.errcode;
    this.reason = extra.reason;
  }
}

/** 外部取消导致的失败：调用方据此安静退出，不当错误上报。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** `0x00MMNNPP` 编码，单测钉住 3.3.2 → 197378。 */
export function encodeClientVersion(version: string): number {
  const [major = 0, minor = 0, patch = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/**
 * 响应必须是 JSON 对象。
 *
 * 网关 200 返回一段 HTML、或空 body 解析出标量时，不能按「成功」处理——
 * `sendMessage` 尤其危险：核心会据此认为交付已送达。
 */
function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ILinkError('api', `${label} 响应结构异常`);
  }
  return value as Record<string, unknown>;
}

/** 带凭据的 API 只允许打到腾讯域名（ADR-0002）。 */
export function isAllowedApiUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com');
}

/** 解析响应体；不是合法 JSON 时按 api 类错误抛出，不把 SyntaxError 漏给上层。 */
function parseJson(text: string, label: string): unknown {
  try {
    return parseJsonKeepIntegers(text);
  } catch {
    throw new ILinkError('api', `${label} 响应不是合法 JSON`);
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

/**
 * 网络层失败的分类：只用于日志与健康状态，不作为重试策略的唯一依据。
 *
 * 导出给媒体下载用：底层异常的 message 可能带完整 URL（CDN 直链有签名参数），
 * 只允许把分类码写进日志。
 */
export function classifyNetworkFailure(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  const text = `${code} ${String(cause?.message ?? '')} ${String((error as Error | null)?.message ?? '')}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'dns';
  if (/ECONNREFUSED/i.test(text)) return 'tcp';
  if (/UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH/i.test(text)) return 'tcp';
  if (/UND_ERR_SOCKET|SSL|TLS|CERT/i.test(text)) return 'tls';
  return 'unknown';
}

export interface ILinkApiOptions {
  baseUrl: string;
  /** 登录前没有 token。 */
  token?: string;
  fetch?: typeof globalThis.fetch;
  appId?: string;
  clientVersion?: number;
  channelVersion: string;
  botAgent: string;
  /** 测试注入：`X-WECHAT-UIN` 的随机源。 */
  randomUint32?: () => number;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  endpoint: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 带 token 的请求；扫码接口不带。 */
  authenticated?: boolean;
  /** 覆盖 baseUrl（扫码轮询会跟着 IDC 重定向换域名）。 */
  baseUrl?: string;
}

/** `getuploadurl` 的请求（字段名照协议，全小写无下划线）。 */
export interface UploadUrlRequest {
  filekey: string;
  media_type: number;
  to_user_id: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  no_need_thumb: boolean;
  aeskey: string;
}

export interface UploadUrlResponse {
  uploadParam?: string;
  uploadFullUrl?: string;
}

export class ILinkApi {
  readonly #fetch: typeof globalThis.fetch;
  readonly #baseUrl: string;
  readonly #token: string | undefined;
  readonly #appId: string;
  readonly #clientVersion: number;
  readonly #channelVersion: string;
  readonly #botAgent: string;
  readonly #randomUint32: () => number;

  constructor(options: ILinkApiOptions) {
    this.#baseUrl = options.baseUrl;
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#appId = options.appId ?? ILINK_APP_ID;
    this.#clientVersion = options.clientVersion ?? ILINK_APP_CLIENT_VERSION;
    this.#channelVersion = options.channelVersion;
    this.#botAgent = options.botAgent;
    this.#randomUint32 = options.randomUint32 ?? (() => randomBytes(4).readUInt32BE(0));
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get hasToken(): boolean {
    return this.#token !== undefined && this.#token !== '';
  }

  /** 所有请求都带的客户端信息。 */
  baseInfo(): BaseInfo {
    return { channel_version: this.#channelVersion, bot_agent: this.#botAgent };
  }

  #commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': this.#appId,
      'iLink-App-ClientVersion': String(this.#clientVersion),
    };
  }

  #postHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(this.#randomUint32()), 'utf8').toString('base64'),
      ...this.#commonHeaders(),
    };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  /** 发一次请求并返回原始文本；失败抛 `ILinkError`。 */
  async #request(options: RequestOptions): Promise<string> {
    const base = ensureTrailingSlash(options.baseUrl ?? this.#baseUrl);
    const url = new URL(options.endpoint, base);
    const headers =
      options.method === 'POST' ? this.#postHeaders() : this.#commonHeaders();

    const timeoutMs = options.timeoutMs;
    const controller = timeoutMs !== undefined ? new AbortController() : null;
    const timer =
      controller && timeoutMs !== undefined ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    const external = options.signal;
    const onExternalAbort = (): void => controller?.abort();
    if (controller && external) {
      if (external.aborted) controller.abort();
      else external.addEventListener('abort', onExternalAbort, { once: true });
    }

    try {
      const response = await this.#fetch(url, {
        method: options.method,
        headers,
        ...(options.method === 'POST' ? { body: JSON.stringify(options.body ?? {}) } : {}),
        ...(controller ? { signal: controller.signal } : external ? { signal: external } : {}),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ILinkError('http', `${options.endpoint} 返回 ${response.status}`, { status: response.status });
      }
      return text;
    } catch (error) {
      if (error instanceof ILinkError) throw error;
      // 外部取消原样抛回：轮询循环靠它安静退出。
      if (external?.aborted) throw error;
      if (isAbortError(error)) {
        throw new ILinkError('timeout', `${options.endpoint} 请求超时`, { reason: 'timeout' });
      }
      throw new ILinkError('network', `${options.endpoint} 网络失败：${(error as Error)?.message ?? '未知'}`, {
        reason: classifyNetworkFailure(error),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
  }

  async #post<T>(endpoint: string, body: unknown, options: Partial<RequestOptions> = {}): Promise<T> {
    const text = await this.#request({ method: 'POST', endpoint, body, ...options });
    return parseJson(text, endpoint) as T;
  }

  /** POST + 对象校验：`getupdates` / `sendmessage` 这类关键响应不接受非对象。 */
  async #postObject(endpoint: string, body: unknown, options: Partial<RequestOptions> = {}): Promise<Record<string, unknown>> {
    const text = await this.#request({ method: 'POST', endpoint, body, ...options });
    return expectObject(parseJson(text, endpoint), endpoint);
  }

  /** 长轮询收消息。客户端的超时是正常控制流，返回空响应让调用方直接再轮。 */
  async getUpdates(params: {
    cursor: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<GetUpdatesResponse> {
    const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    try {
      const response = await this.#postObject(
        'ilink/bot/getupdates',
        { get_updates_buf: params.cursor, base_info: this.baseInfo() },
        { timeoutMs, signal: params.signal },
      );
      if (response.msgs !== undefined && !Array.isArray(response.msgs)) {
        throw new ILinkError('api', 'getupdates 响应 msgs 不是数组');
      }
      return response as GetUpdatesResponse;
    } catch (error) {
      if (error instanceof ILinkError && error.kind === 'timeout' && !params.signal?.aborted) {
        return { ret: 0, msgs: [], get_updates_buf: params.cursor };
      }
      throw error;
    }
  }

  /** 发送一条消息（文本或已上传的媒体项）。业务失败抛 `api` 类错误并带上 `ret`。 */
  /**
   * 取 CDN 上传参数（`ilink/bot/getuploadurl`）。拿到后由 `upload.ts` 加密并 POST 到 CDN，
   * 再从响应头 `x-encrypted-param` 取回下载参数，最后发一条 `image_item` 消息（ADR-0010）。
   */
  async getUploadUrl(request: UploadUrlRequest, options: { timeoutMs?: number } = {}): Promise<UploadUrlResponse> {
    const response = await this.#postObject(
      'ilink/bot/getuploadurl',
      { ...request, base_info: this.baseInfo() },
      { timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS },
    );
    const ret = typeof response.ret === 'number' ? response.ret : undefined;
    if (ret !== undefined && ret !== 0) {
      throw new ILinkError('api', `getuploadurl 失败 ret=${ret}`, { ret });
    }
    const uploadParam = typeof response.upload_param === 'string' ? response.upload_param : undefined;
    const uploadFullUrl = typeof response.upload_full_url === 'string' ? response.upload_full_url : undefined;
    if ((uploadParam === undefined || uploadParam === '') && (uploadFullUrl === undefined || uploadFullUrl === '')) {
      throw new ILinkError('api', 'getuploadurl 没有回上传参数');
    }
    return { ...(uploadParam === undefined ? {} : { uploadParam }), ...(uploadFullUrl === undefined ? {} : { uploadFullUrl }) };
  }

  async sendMessage(message: OutboundMessage, options: { timeoutMs?: number } = {}): Promise<void> {
    const response = await this.#postObject(
      'ilink/bot/sendmessage',
      { msg: message, base_info: this.baseInfo() },
      { timeoutMs: options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS },
    );
    const ret = typeof response.ret === 'number' ? response.ret : undefined;
    if (ret !== undefined && ret !== 0) {
      throw new ILinkError('api', `sendmessage 失败 ret=${ret}`, { ret });
    }
    const errcode = typeof response.errcode === 'number' ? response.errcode : undefined;
    if (errcode !== undefined && errcode !== 0) {
      throw new ILinkError('api', `sendmessage 失败 errcode=${errcode}`, { errcode });
    }
  }

  /** 读机器人在某个主人上的配置（目前只用 `typing_ticket`，保留能力）。 */
  async getConfig(params: {
    userId: string;
    contextToken: string;
  }): Promise<GetConfigResponse> {
    return this.#post<GetConfigResponse>(
      'ilink/bot/getconfig',
      {
        ilink_user_id: params.userId,
        context_token: params.contextToken,
        base_info: this.baseInfo(),
      },
      { timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS },
    );
  }

  /**
   * 发「正在输入」状态（`TypingStatus.TYPING` / `CANCEL`）。
   *
   * 与官方实现一致：只看 HTTP 状态，不解析业务 `ret`——这是尽力而为的
   * 呈现层信号，失败由调用方记日志，不该影响收发（ADR-0007）。
   */
  async sendTyping(params: {
    userId: string;
    typingTicket: string;
    status: number;
    timeoutMs?: number;
  }): Promise<void> {
    await this.#request({
      method: 'POST',
      endpoint: 'ilink/bot/sendtyping',
      body: {
        ilink_user_id: params.userId,
        typing_ticket: params.typingTicket,
        status: params.status,
        base_info: this.baseInfo(),
      },
      timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    });
  }

  /** 通知服务端「本客户端已上线」。失败不影响收消息，由调用方吞掉。 */
  async notifyStart(): Promise<void> {
    await this.#post<GenericResponse>(
      'ilink/bot/msg/notifystart',
      { base_info: this.baseInfo() },
      { timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS },
    );
  }

  /** 通知服务端「本客户端已下线」。 */
  async notifyStop(): Promise<void> {
    await this.#post<GenericResponse>(
      'ilink/bot/msg/notifystop',
      { base_info: this.baseInfo() },
      { timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS },
    );
  }

  /**
   * 取登录二维码。
   *
   * `localTokenList` 是「本机已有的机器人 token」，服务端据此判断是否已绑定过，
   * 与官方行为一致。扫码接口不带 Authorization。
   */
  async getBotQrCode(params: {
    botType?: string;
    localTokenList?: readonly string[];
    timeoutMs?: number;
  } = {}): Promise<QrCodeResponse> {
    const botType = params.botType ?? DEFAULT_BOT_TYPE;
    return this.#post<QrCodeResponse>(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      { local_token_list: params.localTokenList ?? [] },
      { timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS },
    );
  }

  /**
   * 长轮询扫码状态。
   *
   * 客户端超时与网关错误都返回 `wait`：扫码是个房间，等就是正常状态，不该中断。
   */
  async getQrStatus(params: {
    qrcode: string;
    verifyCode?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    baseUrl?: string;
  }): Promise<QrStatusResponse> {
    let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(params.qrcode)}`;
    if (params.verifyCode) endpoint += `&verify_code=${encodeURIComponent(params.verifyCode)}`;
    try {
      const text = await this.#request({
        method: 'GET',
        endpoint,
        timeoutMs: params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
        signal: params.signal,
        baseUrl: params.baseUrl,
      });
      return expectObject(parseJson(text, 'get_qrcode_status'), 'get_qrcode_status') as QrStatusResponse;
    } catch (error) {
      // 只有客户端超时是「服务端还没扫完」的正常等待；网络与 HTTP 失败必须上抛，
      // 否则 DNS 断了也显示「等待扫码」，面板看不出任何异常。
      if (error instanceof ILinkError && error.kind === 'timeout' && !params.signal?.aborted) {
        return { status: 'wait' };
      }
      throw error;
    }
  }
}

/** 造客户端的便捷函数：把版本与 agent 的默认值收在一处。 */
export function createApi(options: {
  baseUrl: string;
  token?: string;
  channelVersion: string;
  botAgent: string;
  fetch?: typeof globalThis.fetch;
  randomUint32?: () => number;
}): ILinkApi {
  return new ILinkApi(options);
}
