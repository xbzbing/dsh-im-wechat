/**
 * 长轮询游标：`cursor-<账号>.json`。
 *
 * `getUpdates` 的 `get_updates_buf` 是 opaque 游标，原样回传即可；持久化它才能
 * 在重启后从上次的位置继续，而不是把历史消息重新拉一遍。游标不是凭据，但它
 * 属于「本机状态」，同样按 0600 落盘。
 */

import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';
import { syncCursorPath } from './paths.ts';

export interface SyncCursorStoreOptions {
  dir: string;
  logger?: StateLogger;
  now?: () => number;
}

/** 游标文件的形状；只认字符串，其余一律当空游标。 */
export function parseCursor(value: unknown): string {
  if (value === null || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  return typeof record.get_updates_buf === 'string' ? record.get_updates_buf : '';
}

export class SyncCursorStore {
  readonly #dir: string;
  readonly #logger: StateLogger | undefined;
  readonly #now: () => number;

  constructor(options: SyncCursorStoreOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  path(account: string): string {
    return syncCursorPath(this.#dir, account);
  }

  async load(account: string): Promise<string> {
    const path = this.path(account);
    const raw = await readJsonIfPresent(path, { now: this.#now, logger: this.#logger });
    return parseCursor(raw);
  }

  /** 空游标不落盘：首次登录时没有游标，不必造一个空文件。 */
  async save(account: string, cursor: string): Promise<void> {
    if (cursor === '') return;
    await writePrivateFile(this.path(account), `${JSON.stringify({ get_updates_buf: cursor })}\n`);
  }
}
