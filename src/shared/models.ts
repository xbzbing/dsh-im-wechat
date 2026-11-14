/**
 * 两半共用的模型契约（纯类型）。
 *
 * 面板把宿主返回的目录渲染成三级下拉（provider → model → 推理等级），宿主组织同一份
 * 快照；形状只在这里定义一次，免得 client 半用 `any` 手抄字段名（与 `media.ts` 同一种
 * 用法：共享的只有类型与纯值）。
 */

/** 一次模型选择：宿主 provider 路由 + 该 provider 下的模型 id + 可选的推理等级。 */
export interface ModelRef {
  provider: string;
  model: string;
  /**
   * 适配器给的推理等级 id；缺省表示用该模型自己的默认推理等级。
   *
   * 名字跟宿主的 `ModelSelection.reasoningEffort` 一致：落盘、面板 RPC 与会话事件不用
   * 再翻译一层（ADR-0026）。
   */
  reasoningEffort?: string;
}

/** 某个模型声明的一档推理等级。 */
export interface ModelCatalogEffort {
  id: string;
  label: string;
}

/** 下拉里的一行；`providerName` 是 provider 下拉的显示名。 */
export interface ModelCatalogItem {
  provider: string;
  model: string;
  label: string;
  providerName: string;
  /** 该模型声明的推理等级；空数组表示模型不提供推理等级选择。 */
  efforts: ModelCatalogEffort[];
  /** 适配器声称的默认推理等级 id；面板用它给「模型默认」那行写说明。 */
  defaultEffort?: string;
}

/** 面板契约里的模型目录：不可用时留原因，不伪装成空目录。 */
export interface ModelCatalogView {
  available: boolean;
  reason?: string;
  /** 宿主的默认模型；独立模式没选模型时跟随它。 */
  default: ModelRef | null;
  items: ModelCatalogItem[];
  /**
   * 目录读失败的 provider id。
   *
   * 宿主对单个 provider 的读取失败只把该 provider 放进 failures，整体仍算可用；这些
   * provider 下的模型不能当成「已下架」，面板按「目录不完整、未校验」呈现。
   */
  unavailableProviders: string[];
}
