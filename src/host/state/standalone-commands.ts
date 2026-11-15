/**
 * 独立模式文字命令的持久态：`/sessions` 的序号快照与 `/trace` 的跟踪列表。
 *
 * 序号只在主人重新发 `/sessions` 时换一份（见 `commands.ts`），所以要落盘——重启后
 * 再用旧序号时不会指向另一个会话。跟踪列表同样落盘，启动时把已到期的丢掉。
 *
 * 文件 `commands.json`：目录 `0700`、文件 `0600`、原子写（与其它状态一致）。
 */

import { join } from 'node:path';

import { MAX_TITLE_LENGTH } from '../../shared/limits.ts';
import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';

/** 一份快照最多记多少个会话：命令只列最近活跃的，超出部分到 Web 端看。 */
export const MAX_LISTING = 100;

/** 同时跟踪的会话上限（与 `/trace` 的提示一致）。 */
export const MAX_TRACES = 10;

const MAX_TITLE = MAX_TITLE_LENGTH;

export interface ListingEntry {
  sessionId: string;
  title: string;
}

export interface TraceEntry {
  sessionId: string;
  title: string;
  /** 开始跟踪的时间。 */
  since: number;
  /** 到期时间。 */
  until: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 逐条校验快照：坏条目丢掉，不因一个字段把整份作废。 */
export function parseListing(value: unknown): ListingEntry[] {
  const rows = Array.isArray(value) ? value : [];
  const out: ListingEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const entry = asRecord(raw);
    const sessionId = text(entry?.sessionId);
    if (sessionId === '' || seen.has(sessionId) || out.length >= MAX_LISTING) continue;
    seen.add(sessionId);
    out.push({ sessionId, title: text(entry?.title).slice(0, MAX_TITLE) });
  }
  return out;
}

/** 逐条校验跟踪：缺开始/到期时间或已倒挂的条目丢掉。 */
export function parseTraces(value: unknown): TraceEntry[] {
  const rows = Array.isArray(value) ? value : [];
  const out: TraceEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const entry = asRecord(raw);
    const sessionId = text(entry?.sessionId);
    const since = finite(entry?.since);
    const until = finite(entry?.until);
    if (sessionId === '' || since === null || until === null || until <= since) continue;
    if (seen.has(sessionId) || out.length >= MAX_TRACES) continue;
    seen.add(sessionId);
    out.push({ sessionId, title: text(entry?.title).slice(0, MAX_TITLE), since, until });
  }
  return out;
}

export interface StandaloneCommandStoreOptions {
  dir: string;
  logger?: StateLogger;
  now?: () => number;
}

/** 命令快照与跟踪列表：内存里是当前值，写盘串行排队。 */
export class StandaloneCommandStore {
  readonly #dir: string;
  readonly #logger: StateLogger | undefined;
  readonly #now: () => number;
  #listing: ListingEntry[] = [];
  #traces: TraceEntry[] = [];
  #writes: Promise<void> = Promise.resolve();

  constructor(options: StandaloneCommandStoreOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  path(): string {
    return join(this.#dir, 'commands.json');
  }

  async hydrate(): Promise<void> {
    const value = await readJsonIfPresent(this.path(), {
      now: this.#now,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
    const record = asRecord(value);
    this.#listing = parseListing(record?.listing);
    this.#traces = parseTraces(record?.traces);
  }

  listing(): readonly ListingEntry[] {
    return this.#listing;
  }

  traces(): readonly TraceEntry[] {
    return this.#traces;
  }

  async setListing(entries: readonly ListingEntry[]): Promise<void> {
    this.#listing = entries.slice(0, MAX_LISTING).map((entry) => ({ ...entry }));
    await this.#persist();
  }

  async setTraces(entries: readonly TraceEntry[]): Promise<void> {
    this.#traces = entries.slice(0, MAX_TRACES).map((entry) => ({ ...entry }));
    await this.#persist();
  }

  /** 等挂起的写盘完成（停机与测试对齐用）。 */
  flush(): Promise<void> {
    return this.#writes;
  }

  #persist(): Promise<void> {
    const payload = JSON.stringify({ version: 1, listing: this.#listing, traces: this.#traces });
    const write = this.#writes.then(() => writePrivateFile(this.path(), `${payload}\n`));
    this.#writes = write.catch(() => undefined);
    return write;
  }
}
