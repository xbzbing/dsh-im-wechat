/**
 * 已消费的提醒回复（本机持久化）。
 *
 * 入站是 at-least-once：批次中途停机会刻意不推进游标（`poll.ts`），重启后同一帧
 * 可能被重投。核心在接入时按 `(bridge, messageId)` 去重兜底，但提醒回复没有核心——
 * 一条旧「批准」在新进程里可能批掉一个刚产生的授权请求。这里记住最近消费过的
 * 消息身份，重启后仍然拒绝同一条。
 *
 * 只存身份串与时间，不存消息正文；文件 `0600`，与其它状态文件同目录。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';

/** 记最近这么多条：够覆盖一次停机重投，又不会无限增长。 */
const CAPACITY = 50;

export interface ConsumedReplyEntry {
  readonly id: string;
  readonly at: number;
}

export interface ConsumedRepliesOptions {
  dir: string;
  logger?: StateLogger;
  now?: () => number;
  capacity?: number;
}

export function consumedRepliesPath(dir: string): string {
  return join(dir, 'consumed-replies.json');
}

export class ConsumedReplies {
  readonly #options: ConsumedRepliesOptions;
  readonly #now: () => number;
  readonly #capacity: number;
  readonly #path: string;
  /** Map 的插入顺序就是新旧顺序。 */
  readonly #entries = new Map<string, number>();
  #writing: Promise<void> = Promise.resolve();

  constructor(options: ConsumedRepliesOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#capacity = options.capacity ?? CAPACITY;
    this.#path = consumedRepliesPath(options.dir);
  }

  async load(): Promise<void> {
    const raw = await readJsonIfPresent(this.#path, { logger: this.#options.logger, now: this.#now });
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = entry as { id?: unknown; at?: unknown };
      if (typeof record.id !== 'string' || record.id === '') continue;
      this.#entries.set(record.id, typeof record.at === 'number' ? record.at : 0);
    }
    this.#trim();
  }

  /** 这条消息身份是否已经被某次提醒消费过。 */
  has(identity: string | null | undefined): boolean {
    return typeof identity === 'string' && identity !== '' && this.#entries.has(identity);
  }

  /** 记下一条消费；写盘失败只记日志，不影响已经做出的决定。 */
  remember(identity: string | null | undefined): Promise<void> {
    if (typeof identity !== 'string' || identity === '') return this.#writing;
    this.#entries.set(identity, this.#now());
    this.#trim();
    const snapshot = [...this.#entries.entries()].map(([id, at]) => ({ id, at }));
    // 串行写：两次快速回复不会互相覆盖（原子写只保证单次完整）。
    this.#writing = this.#writing
      .then(() => writePrivateFile(this.#path, `${JSON.stringify(snapshot, null, 2)}\n`))
      .catch((error: unknown) => {
        this.#options.logger?.warn?.('记录已消费的提醒回复失败', (error as Error)?.message);
      });
    return this.#writing;
  }

  #trim(): void {
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }
}
