/**
 * 两半共用的模型契约（纯类型）。
 *
 * 面板把宿主返回的目录渲染成下拉，宿主组织同一份快照；形状只在这里定义一次，免得
 * client 半用 `any` 手抄字段名（与 `media.ts` 同一种用法：共享的只有类型与纯值）。
 */

/** 一次模型选择：宿主 provider 路由 + 该 provider 下的模型 id。 */
export interface ModelRef {
  provider: string;
  model: string;
}

/** 下拉里的一行；`providerName` 给面板当说明文字（同名模型分得清是谁家的）。 */
export interface ModelCatalogItem {
  provider: string;
  model: string;
  label: string;
  providerName: string;
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
