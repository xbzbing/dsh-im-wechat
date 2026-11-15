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
  /** 会话标题（宿主 `session/title` 的最后一次）；面板用它显示完整会话名。 */
  title?: string;
  /** 绑定时间，仅用于排障。 */
  boundAt: number;
}

/** 标题只用于展示：超长截断，避免异常事件把状态文件撑大。 */
const MAX_TITLE = 200;

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
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  return {
    sessionId: entry.sessionId,
    workspaceId: typeof entry.workspaceId === 'string' ? entry.workspaceId : '',
    ...(title !== '' ? { title: title.slice(0, MAX_TITLE) } : {}),
    boundAt: typeof entry.boundAt === 'number' && Number.isFinite(entry.boundAt) ? entry.boundAt : 0,
  };
}

export class DirectBindingStore {
  readonly #dir: string;
  readonly #logger: StateLogger | undefined;
  readonly #now: () => number;
  #binding: DirectBinding | null = null;
  /** 写链：`set` 与 `setTitle` 都排队，先发起的先落盘，后发起的不会先写。 */
  #writes: Promise<void> = Promise.resolve();

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

  async set(sessionId: string, workspaceId: string, title?: string): Promise<DirectBinding> {
    const trimmed = title?.trim() ?? '';
    const binding: DirectBinding = {
      sessionId,
      workspaceId,
      ...(trimmed !== '' ? { title: trimmed.slice(0, MAX_TITLE) } : {}),
      boundAt: this.#now(),
    };
    this.#binding = binding;
    await this.#persist();
    return binding;
  }

  /** 宿主改过标题（面板、Web 端、`session/title` 事件）：变了才落盘，返回是否已变。 */
  async setTitle(title: string): Promise<boolean> {
    const binding = this.#binding;
    const trimmed = title.trim();
    if (binding === null || trimmed === '') return false;
    const next = trimmed.slice(0, MAX_TITLE);
    if (binding.title === next) return false;
    binding.title = next;
    await this.#persist();
    return true;
  }

  async clear(): Promise<void> {
    this.#binding = null;
    await this.#persist();
  }

  /** 等挂起的写盘完成（标题事件是异步落盘，测试与停机时用它对齐）。 */
  flush(): Promise<void> {
    return this.#writes;
  }

  #persist(): Promise<void> {
    const payload: FileShape = { version: 1, ...(this.#binding ? { binding: this.#binding } : {}) };
    const text = `${JSON.stringify(payload)}\n`;
    const write = this.#writes.then(() => writePrivateFile(this.path(), text));
    // 链本身不能因一次失败断掉：调用方拿到的仍是会 reject 的那次写。
    this.#writes = write.catch(() => undefined);
    return write;
  }
}
