/**
 * context_token 缓存：`context-tokens-<账号>.json`。
 *
 * 协议要求每条出站消息都回传收件人最近一条消息带回来的 `context_token`；
 * 它由 `getupdates` 逐条下发，所以既要在内存里能被发送路径同步读到，也要
 * 落盘——否则重启后要等主人再开口才能发言（ADR-0002 的「窗口」语义）。
 *
 * token 是凭据级数据：不进日志、不进面板快照；键按账号 + 用户 id（小写归一，
 * 因为入站与出站两边的 id 大小写并不稳定）。
 */

import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';
import { contextTokenPath } from './paths.ts';

export interface ContextTokenStoreOptions {
  dir: string;
  logger?: StateLogger;
  now?: () => number;
}

function key(userId: string): string {
  return userId.trim().toLowerCase();
}

/** 文件形状：`{ tokens: { <userId>: <token> } }`。 */
export function parseContextTokens(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  const tokens = record.tokens;
  if (tokens === null || typeof tokens !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [userId, token] of Object.entries(tokens as Record<string, unknown>)) {
    if (typeof token === 'string' && token !== '' && userId.trim() !== '') {
      out[key(userId)] = token;
    }
  }
  return out;
}

export class ContextTokenStore {
  readonly #dir: string;
  readonly #logger: StateLogger | undefined;
  readonly #now: () => number;
  #cache = new Map<string, string>();
  /** token 接收时刻，只在内存：拒信里报年龄用；落盘不带时间，重启后未知。 */
  #receivedAt = new Map<string, number>();
  /** 串行化的写链：入站消息可能连发，不能并发写同一个文件。 */
  #writes: Promise<void> = Promise.resolve();

  constructor(options: ContextTokenStoreOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  path(account: string): string {
    return contextTokenPath(this.#dir, account);
  }

  /** 把落盘的 token 灌进内存；启动时调一次。 */
  async hydrate(account: string): Promise<void> {
    const raw = await readJsonIfPresent(this.path(account), { now: this.#now, logger: this.#logger });
    const tokens = parseContextTokens(raw);
    for (const [userId, token] of Object.entries(tokens)) {
      this.#cache.set(this.#cacheKey(account, userId), token);
    }
  }

  get(account: string, userId: string): string | undefined {
    return this.#cache.get(this.#cacheKey(account, userId));
  }

  /** 这个 token 收到多久了；从磁盘灌进来的（重启前收到的）返回 undefined。 */
  age(account: string, userId: string, now = this.#now()): number | undefined {
    const at = this.#receivedAt.get(this.#cacheKey(account, userId));
    return at === undefined ? undefined : Math.max(0, now - at);
  }

  /** 记一条 token；写盘异步排队，发送路径不需要等它。 */
  set(account: string, userId: string, token: string): void {
    const cleaned = token.trim();
    if (cleaned === '') return;
    const normalizedUser = key(userId);
    if (normalizedUser === '') return;
    const cacheKey = this.#cacheKey(account, normalizedUser);
    this.#cache.set(cacheKey, cleaned);
    this.#receivedAt.set(cacheKey, this.#now());
    this.#writes = this.#writes
      .then(() => this.#persist(account))
      .catch((error: unknown) => {
        this.#logger?.warn?.('context_token 落盘失败', (error as Error)?.message);
      });
  }

  async clearAccount(account: string): Promise<void> {
    const prefix = `${account}\u0000`;
    for (const cacheKey of [...this.#cache.keys()]) {
      if (cacheKey.startsWith(prefix)) this.#cache.delete(cacheKey);
    }
    for (const cacheKey of [...this.#receivedAt.keys()]) {
      if (cacheKey.startsWith(prefix)) this.#receivedAt.delete(cacheKey);
    }
    await writePrivateFile(this.path(account), `${JSON.stringify({ tokens: {} })}\n`);
  }

  /** 等待挂起的写盘完成（测试与优雅停机用）。 */
  async flush(): Promise<void> {
    await this.#writes;
  }

  #cacheKey(account: string, userId: string): string {
    return `${account}\u0000${key(userId)}`;
  }

  async #persist(account: string): Promise<void> {
    const prefix = `${account}\u0000`;
    const tokens: Record<string, string> = {};
    for (const [cacheKey, token] of this.#cache) {
      if (cacheKey.startsWith(prefix)) tokens[cacheKey.slice(prefix.length)] = token;
    }
    await writePrivateFile(this.path(account), `${JSON.stringify({ tokens })}\n`);
  }
}
