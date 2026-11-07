/**
 * Cordis 插件入口（骨架）。
 *
 * 只负责装配与接线：iLink 协议客户端在 `ilink/`，超级助理桥适配在
 * `superagent/`，Web 面板 RPC 后续落在 `panel-rpc.ts`。结构与
 * dsh-im-infoflow 同构（ADR-0001），业务里程碑逐步填充。
 */

export const name = 'dsh-im-wechat';

export const inject: string[] = [];

/** 宿主上下文用最小结构类型描述，不 import 宿主包（AGENTS.md「工程约定」）。 */
export interface PluginContext {
  logger?(...args: unknown[]): unknown;
  effect?(execute: () => unknown, label?: string): unknown;
}

/** 插件配置（骨架预留：登录态目录、启用开关等，随里程碑补 Schema）。 */
export interface PluginConfig {
  enabled?: boolean;
}

/** 骨架阶段无行为；各里程碑在子 fiber 里装配并随 ctx 生命周期启停。 */
export function apply(_ctx: PluginContext, _config: PluginConfig = {}): void {
  // 装配点：协议客户端、桥注册、面板 RPC 都在这里接线（见 AGENTS.md）。
}
