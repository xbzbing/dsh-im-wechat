/**
 * 独立模式的默认工作区（ADR-0018）：插件数据目录（`$DSH_HOME/dsh-im-wechat`）下的
 * 「微信会话」。
 *
 * 宿主 `workspaceRegistry.create(path, title)` 对同一路径幂等，标题只在首次创建时生效；
 * 会话按 `workspaceId` 建，宿主据此把 cwd 定到该目录。建不出来（老宿主没有 `create`、
 * 目录不可写、宿主一直不返回）时退回空串，行为回到「宿主默认位置」。
 */

import { messageOf } from './host-context.ts';
import { ensurePrivateDir } from './state/files.ts';
import type { WorkspaceRegistry } from './runtime-status.ts';

/** 默认工作区标题：面板与宿主工作区列表里显示的名字。 */
export const DEFAULT_WORKSPACE_TITLE = '微信会话';

/** 失败进面板「最近错误」时的前缀：恢复成功后按它把旧记录清掉。 */
export const WORKSPACE_ERROR_PREFIX = '自动创建工作区失败';

const DEFAULT_ENSURE_TIMEOUT_MS = 5_000;

export interface DefaultWorkspaceOptions {
  /** 工作区目录，同时是插件数据目录。 */
  dir: string;
  /** 取宿主工作区服务；服务晚到或缺失时返回 null。 */
  registry: () => WorkspaceRegistry | null;
  /** 失败进面板的「最近错误」。 */
  noteError: (message: string) => void;
  /** 建好后清掉之前那条失败记录：瞬时失败不该留成常驻错误。 */
  clearError?: () => void;
  logger?: { warn?(...args: unknown[]): unknown };
  /** 等宿主建工作区的上限；超时当失败，下次调用重试。 */
  timeoutMs?: number;
}

export class DefaultWorkspace {
  readonly #options: DefaultWorkspaceOptions;
  #id = '';
  #ensuring: Promise<string> | null = null;
  /** 失败只记一次面板错误：后续调用继续重试，但不刷屏。 */
  #errorNoted = false;
  /** 服务重新接入时自增：在途的旧请求回来后不再写进新状态。 */
  #generation = 0;

  constructor(options: DefaultWorkspaceOptions) {
    this.#options = options;
  }

  /** 已建好的默认工作区 id；没建好（或建不出来）时为空串。 */
  get id(): string {
    return this.#id;
  }

  /** 宿主工作区服务换了（重建/解挂）：丢掉旧 id，下次调用重新登记。 */
  reset(): void {
    this.#generation += 1;
    this.#id = '';
    this.#errorNoted = false;
    this.#ensuring = null;
  }

  /** 建或复用默认工作区；并发调用共用同一个请求。 */
  async ensure(): Promise<string> {
    if (this.#id !== '') return this.#id;
    if (this.#ensuring) return this.#ensuring;
    const registry = this.#options.registry();
    const create = registry?.create;
    if (!registry || typeof create !== 'function') return '';
    const generation = this.#generation;
    const timeoutMs = this.#options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
    const task = (async () => {
      try {
        // 工作区路径必须是已存在的绝对目录。
        await ensurePrivateDir(this.#options.dir);
        const workspace = await withTimeout(
          create.call(registry, this.#options.dir, DEFAULT_WORKSPACE_TITLE),
          timeoutMs,
          `等宿主创建工作区超过 ${timeoutMs}ms`,
        );
        const id = typeof workspace?.id === 'string' ? workspace.id : '';
        if (id === '') throw new Error('宿主没有返回工作区 id');
        if (generation !== this.#generation) return '';
        this.#id = id;
        this.#errorNoted = false;
        this.#options.clearError?.();
        return id;
      } catch (error) {
        if (generation !== this.#generation) return '';
        if (!this.#errorNoted) {
          this.#errorNoted = true;
          this.#options.noteError(`${WORKSPACE_ERROR_PREFIX}：${messageOf(error)}`);
        }
        this.#options.logger?.warn?.(WORKSPACE_ERROR_PREFIX, messageOf(error));
        return '';
      } finally {
        if (generation === this.#generation) this.#ensuring = null;
      }
    })();
    this.#ensuring = task;
    return task;
  }
}

/** 超时后拒绝，但保留原请求的结局处理：晚到的成功/失败不会再抛未处理 rejection。 */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
