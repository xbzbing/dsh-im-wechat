/**
 * 登录态：`login.json`。
 *
 * 存的只有「能接着收消息」所需的最小集合：机器人 token、机器人账号、主人 id、
 * 运行域名与登录时间。面板与日志只看 `describe()` 的视图，视图里没有 token
 * （ADR-0002）。
 */

import { rm } from 'node:fs/promises';

import { isAllowedApiUrl } from '../ilink/api.ts';
import { loginStatePath } from './paths.ts';
import { quarantineFile, readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';

export const LOGIN_STATE_VERSION = 1;

export interface LoginState {
  version: number;
  botToken: string;
  /** `ilink_bot_id`，桥的 `account` 就是它。 */
  account: string;
  /** `ilink_user_id`：扫码的微信用户，用于面板展示绑定关系。 */
  userId?: string;
  baseUrl: string;
  loggedInAt: number;
}

/** 面板可见的登录视图：永不包含 token。 */
export interface LoginStateView {
  loggedIn: boolean;
  accountTail?: string;
  userId?: string;
  baseUrl?: string;
  loggedInAt?: number;
}

export interface LoginStateStoreOptions {
  dir: string;
  logger?: StateLogger;
  now?: () => number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 逐字段校验：文件是外部输入，形状不对就整份作废。 */
export function parseLoginState(value: unknown): LoginState | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.version !== LOGIN_STATE_VERSION) return null;
  if (!isNonEmptyString(record.botToken)) return null;
  if (!isNonEmptyString(record.account)) return null;
  if (!isNonEmptyString(record.baseUrl)) return null;
  // baseUrl 是带 token 请求的目标，白名单只在这一处验：所有消费方（运行期、CLI）自动继承。
  if (!isAllowedApiUrl(record.baseUrl.trim())) return null;
  if (typeof record.loggedInAt !== 'number' || !Number.isFinite(record.loggedInAt)) return null;
  return {
    version: LOGIN_STATE_VERSION,
    botToken: record.botToken.trim(),
    account: record.account.trim(),
    ...(isNonEmptyString(record.userId) ? { userId: record.userId.trim() } : {}),
    baseUrl: record.baseUrl.trim(),
    loggedInAt: record.loggedInAt,
  };
}

/**
 * 账号的脱敏展示：面板只要「是哪个机器人」，不需要露出完整 id。
 *
 * `ilink_bot_id` 形如 `b0f5860fdecb@im.bot`，所以保留域名、把本地部分截到 4 位；
 * 不是这种形状时退回尾 4 位。
 */
export function accountTail(account: string): string {
  const cleaned = account.trim();
  const at = cleaned.lastIndexOf('@');
  if (at > 0) return `${cleaned.slice(0, Math.min(4, at))}…${cleaned.slice(at)}`;
  if (cleaned.length <= 4) return cleaned;
  return `…${cleaned.slice(-4)}`;
}

export function describeLoginState(state: LoginState | null): LoginStateView {
  if (!state) return { loggedIn: false };
  return {
    loggedIn: true,
    accountTail: accountTail(state.account),
    ...(state.userId ? { userId: state.userId } : {}),
    baseUrl: state.baseUrl,
    loggedInAt: state.loggedInAt,
  };
}

export class LoginStateStore {
  readonly #path: string;
  readonly #logger: StateLogger | undefined;
  readonly #now: () => number;

  constructor(options: LoginStateStoreOptions) {
    this.#path = loginStatePath(options.dir);
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<LoginState | null> {
    const raw = await readJsonIfPresent(this.#path, { now: this.#now, logger: this.#logger });
    if (raw === undefined) return null;
    const parsed = parseLoginState(raw);
    if (!parsed) {
      await quarantineFile(this.#path, this.#now);
      this.#logger?.warn?.('登录态字段非法，已隔离并要求重新扫码');
    }
    return parsed;
  }

  async save(state: Omit<LoginState, 'version'>): Promise<LoginState> {
    const value: LoginState = { version: LOGIN_STATE_VERSION, ...state };
    await writePrivateFile(this.#path, `${JSON.stringify(value, null, 2)}\n`);
    return value;
  }

  /** 登出：直接删掉，不留给下一个进程「读到一半就登录失败」的机会。 */
  async clear(): Promise<void> {
    await rm(this.#path, { force: true });
  }
}
