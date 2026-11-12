/**
 * 独立模式的会话绑定（ADR-0009）。
 *
 * 未接入超级助理时，微信里发的消息直接落到一个 DSH 会话上：第一次发消息按配置的
 * 工作区新建，之后所有消息都进同一个会话。绑定关系落盘，重启/重装后沿用；会话被
 * 删掉（宿主回 session/not-found）时由调用方清掉重建。
 *
 * 文件 `direct.json`：目录 `0700`、文件 `0600`，原子写（与其它状态一致）。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './files.ts';
import type { StateLogger } from './files.ts';

export interface DirectBinding {
  sessionId: string;
  /** 建会话时用的工作区 id（空表示默认工作区建不出来，用了宿主默认位置）。 */
  workspaceId: string;
  /** 绑定时间，仅用于排障。 */
  boundAt: number;
}

export interface DirectBindingStoreOptions {
  dir: string;
  logger?: StateLogger;
  now?: () => number;
}

interface FileShape {
  version: number;
  binding?: DirectBinding;
}

/** 逐字段校验：文件是外部输入，形状不对就整份作废。 */
export function parseBinding(value: unknown): DirectBinding | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const binding = record.binding;
  if (binding === null || typeof binding !== 'object') return null;
  const entry = binding as Record<string, unknown>;
  if (typeof entry.sessionId !== 'string' || entry.sessionId.trim() === '') return null;
  return {
    sessionId: entry.sessionId,
    workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : '',
    boundAt: typeof entry.boundAt === 'number' && Number.isFinite(entry.boundAt) ? entry.boundAt : 0,
  };
}

export class DirectBindingStore {
  readonly #dir: string;
  readonly #logger: StateLogger | undefined;
  readonly #now: () => number;
  #binding: DirectBinding | null = null;

  constructor(options: DirectBindingStoreOptions) {
    this.#dir = options.dir;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  path(): string {
    return join(this.#dir, 'direct.json');
  }

  async hydrate(): Promise<void> {
    const value = await readJsonIfPresent(this.path(), {
      now: this.#now,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
    this.#binding = parseBinding(value);
  }

  get(): DirectBinding | null {
    return this.#binding;
  }

  async set(sessionId: string, workspaceId: string): Promise<DirectBinding> {
    const binding: DirectBinding = { sessionId, workspaceId, boundAt: this.#now() };
    this.#binding = binding;
    await this.#persist();
    return binding;
  }

  async clear(): Promise<void> {
    this.#binding = null;
    await this.#persist();
  }

  async #persist(): Promise<void> {
    const payload: FileShape = { version: 1, ...(this.#binding ? { binding: this.#binding } : {}) };
    await writePrivateFile(this.path(), `${JSON.stringify(payload)}\n`);
  }
}
