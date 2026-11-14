/**
 * 独立模式会话的模型（ADR-0025）：面板下拉的候选来自宿主的模型目录，选中的模型钉在
 * 直连会话自己身上。
 *
 * 钉模型用 Agent 自己的 `model.select`——它只往这个会话追加一条 `model/selection` 事件，
 * **不是** `sessionController.selectModel`：后者会把选择顺带写成 DSH 的全局默认模型，
 * 主人 Web 端新建的会话会跟着换（否决方案见 ADR-0025）。模型从目录里消失时不做兜底，
 * 面板会把已保存的值标成不可用，让主人重选。
 */

import { messageOf } from './host-context.ts';
import type { HostAgentModel } from './host-agents.ts';
import type { ModelCatalogItem, ModelCatalogView, ModelRef } from '../shared/models.ts';

/** provider 与 model id 的长度上限：面板是外部输入，落盘前给个硬边界。 */
const MAX_MODEL_PART = 200;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 收窄一次模型选择；缺任一半、只有空白或超长都算没配（跟随 DSH 默认）。
 *
 * 只取 `provider` 与 `model` 两个字段：将来宿主给选择加上 `reasoningEffort` 之类，
 * 这里也不会把它悄悄带进配置（真要支持得显式加字段）。
 */
export function normalizeModelRef(value: unknown): ModelRef | undefined {
  const record = asRecord(value);
  if (record === null) return undefined;
  const provider = asText(record.provider);
  const model = asText(record.model);
  if (provider === '' || model === '') return undefined;
  if (provider.length > MAX_MODEL_PART || model.length > MAX_MODEL_PART) return undefined;
  return { provider, model };
}

/** 两次选择是否同一条路由；`null`（不选）与任何值都不相等。 */
export function sameModelRef(left: ModelRef | null, right: ModelRef | null): boolean {
  return left !== null && right !== null && left.provider === right.provider && left.model === right.model;
}

/** 宿主 `sessionController` 里读模型目录的方法（结构类型，不 import 宿主包）。 */
export interface ModelCatalogSource {
  modelCatalog?(): Promise<unknown>;
}

/** 宿主 `agents` 服务里本模块用到的部分：按会话 id 取回活着的 Agent。 */
export interface AgentModelLookup {
  get?(sessionId: string): { readonly model?: HostAgentModel | null } | undefined;
}

export function unavailableModels(reason: string): ModelCatalogView {
  return { available: false, reason, default: null, items: [], unavailableProviders: [] };
}

/**
 * 把 `sessionController.modelCatalog()` 的返回拍平成下拉行。
 *
 * 读不出来的分组（宿主的 `failures`）不进下拉，但把它们的 id 记进
 * `unavailableProviders`：这些 provider 下的模型不能被当成「已下架」。
 */
export function parseModelCatalog(value: unknown): ModelCatalogView {
  const record = asRecord(value);
  const items: ModelCatalogItem[] = [];
  const seen = new Set<string>();
  const groups = Array.isArray(record?.groups) ? record.groups : [];
  for (const group of groups) {
    const entry = asRecord(group);
    const provider = asText(entry?.id);
    if (provider === '') continue;
    const providerName = asText(entry?.name) || provider;
    const models = Array.isArray(entry?.models) ? entry.models : [];
    for (const row of models) {
      const model = asRecord(row);
      const id = asText(model?.id);
      if (id === '') continue;
      // 行键只用 provider/model 拼：同一个 provider 声称两遍同一个模型时只留第一条。
      const key = `${provider}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ provider, model: id, label: asText(model?.name) || id, providerName });
    }
  }
  const failures = Array.isArray(record?.failures) ? record.failures : [];
  const unavailableProviders = failures
    .map((failure) => asText(asRecord(failure)?.id))
    .filter((provider) => provider !== '');
  return {
    available: true,
    default: normalizeModelRef(record?.default) ?? null,
    items,
    unavailableProviders,
  };
}

/** 读宿主的模型目录：没有服务或读失败都降级成「不可用 + 原因」，面板据此禁用下拉。 */
export async function readModelCatalog(source: ModelCatalogSource | null): Promise<ModelCatalogView> {
  if (source === null || typeof source.modelCatalog !== 'function') {
    return unavailableModels('宿主不提供模型目录（没有会话服务）');
  }
  try {
    return parseModelCatalog(await source.modelCatalog());
  } catch (error) {
    return unavailableModels(`读取宿主模型目录失败：${messageOf(error)}`);
  }
}

/** 装配层要给的东西：宿主服务按需取，绑定的会话 id 现读。 */
export interface DirectModelOptions {
  /** 初始值：静态配置或上次落盘的设置。 */
  initial: ModelRef | null;
  /** 宿主 `agents` 服务（钉模型时按会话 id 取活着的 Agent）。 */
  agents: () => AgentModelLookup | null;
  /** 当前绑定的直连会话 id；还没绑定会话时返回 undefined。 */
  boundSession: () => string | undefined;
  /** 宿主 `sessionController`（读模型目录）。 */
  catalog: () => ModelCatalogSource | null;
  logger?: { warn?(...args: unknown[]): unknown };
}

/**
 * 独立模式的模型设置：当前值、钉到会话上的时机、面板下拉的目录。
 *
 * 值本身不落盘（落盘归 `config.ts`），这里只管「用哪个模型」与「什么时候生效」：
 * **每次提交前**钉一次（新建会话、以及宿主重启后还没 resume 的绑定会话都在这里补上），
 * 面板改完再立刻试一次。同一个会话与同一个值钉成功过就不再重复，所以既不会覆盖主人
 * 在 Web 端对这个会话做的 `/model` 切换，也不会每来一条消息就写一条事件。
 *
 * 清空（跟随 DSH 默认）只影响以后新建的会话——会话里记下的选择撤不回来（ADR-0025）。
 */
export class DirectModelChoice {
  readonly #options: DirectModelOptions;
  #ref: ModelRef | null;
  /** 上一次钉成功的会话与值：提交前补钉时用它去重。 */
  #applied: ({ sessionId: string } & ModelRef) | null = null;

  constructor(options: DirectModelOptions) {
    this.#options = options;
    this.#ref = options.initial;
  }

  /** 面板/启动时换值：`null` 表示跟随 DSH 的默认模型。 */
  use(value: ModelRef | null): void {
    this.#ref = value;
    // 新值需要重新钉一次；旧值的「已钉」记录不再作数。
    this.#applied = null;
  }

  /** 对外快照：返回副本，调用方改不到内部状态。 */
  snapshot(): ModelRef | null {
    return this.#ref === null ? null : { ...this.#ref };
  }

  /** 面板下拉的候选目录。 */
  async view(): Promise<ModelCatalogView> {
    return await readModelCatalog(this.#options.catalog());
  }

  /**
   * 提交前钉模型（新建会话与已绑定会话都走这条）；返回这次是否已经钉上。
   *
   * 失败不是错误：宿主还没 resume 那个会话时钉不进去，下一次提交会再试。
   */
  applyToSession(sessionId: string): boolean {
    const ref = this.#ref;
    if (ref === null || sessionId === '') return false;
    const applied = this.#applied;
    if (applied !== null && applied.sessionId === sessionId && sameModelRef(applied, ref)) return true;
    if (!applySessionModel(this.#options.agents(), sessionId, ref)) return false;
    this.#applied = { sessionId, provider: ref.provider, model: ref.model };
    return true;
  }

  /** 面板改完模型：已绑定的会话立刻换过去；钉不上只记日志，下一条消息会再试。 */
  applyToBoundSession(): void {
    const sessionId = this.#options.boundSession();
    if (sessionId === undefined) return;
    if (!this.applyToSession(sessionId)) {
      this.#options.logger?.warn?.(
        `独立模式没能把模型换到会话 ${sessionId} 上（会话还没起），下一条消息会再试`,
      );
    }
  }
}

/**
 * 把配置的模型钉到会话上；返回是否真的钉上了。
 *
 * 只对**活着**的 Agent 生效：Agent 没起（宿主还没 resume 那个会话）时什么都不做，
 * 由调用方在下一次提交时再试。失败一律返回 false，由调用方决定要不要记日志——这条
 * 路径在消息收发里，不抛错。
 */
export function applySessionModel(
  lookup: AgentModelLookup | null,
  sessionId: string,
  ref: ModelRef | null,
): boolean {
  if (ref === null || sessionId === '') return false;
  if (lookup === null || typeof lookup.get !== 'function') return false;
  let agent: { readonly model?: HostAgentModel | null } | undefined;
  try {
    agent = lookup.get(sessionId);
  } catch {
    return false;
  }
  const model = agent?.model;
  if (model === undefined || model === null || typeof model.select !== 'function') return false;
  try {
    model.select({ provider: ref.provider, model: ref.model });
    return true;
  } catch {
    return false;
  }
}
