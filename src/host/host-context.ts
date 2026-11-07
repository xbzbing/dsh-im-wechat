/**
 * 宿主上下文的最小结构描述与接入助手。
 *
 * 不 import 宿主包（AGENTS.md「工程约定」）：Cordis 的上下文与面板 RPC 路由都
 * 按结构描述，运行期满足即可。
 */

export interface PluginLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
  error?(...args: unknown[]): unknown;
}

/** 面板 RPC 路由：`connection.fetch.register` 接受的形状。 */
export interface PanelRoute {
  path: string;
  methods: string[];
  requestBody?: string;
  fetch(request: Request): Promise<Response>;
}

export interface ConnectionFace {
  fetch?: { register(route: PanelRoute): unknown };
}

export interface PluginContext {
  logger?: PluginLogger;
  effect?(execute: () => unknown, label?: string): unknown;
  inject?(services: string[], install: (scope: PluginContext) => void): unknown;
  connection?: ConnectionFace;
  /** Cordis 事件：`prepend` 抢链首，`global` 收所有会话的事件。 */
  on?(event: string, listener: (...args: never[]) => unknown, options?: { prepend?: boolean; global?: boolean }): unknown;
}

/** 日志里的错误展示：Error 取 message，其它原样交给 logger。 */
export function errorDetail(error: unknown): unknown {
  return error instanceof Error ? error.message : error;
}

/**
 * 按需接入一个可选宿主服务。
 *
 * 必须走子 fiber 的 `inject`：Cordis 里没在 inject 声明的服务，属性访问会直接
 * 抛错而不是返回 undefined。同时也不写进顶层 `inject`——缺 `connection` 的组合
 * （没有 web 面板）里，插件仍应照常收发消息。
 */
export function injectOptional(
  ctx: PluginContext,
  service: string,
  install: (scope: PluginContext) => void,
): void {
  if (typeof ctx.inject === 'function') {
    ctx.inject([service], install);
    return;
  }
  install(ctx);
}
