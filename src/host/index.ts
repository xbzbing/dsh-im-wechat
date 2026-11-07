/**
 * Cordis 插件入口：只装配与接线。
 *
 * - 协议客户端在 `ilink/`，入站转换在 `inbound.ts`，桥适配在 `superagent/`，
 *   配置与状态在 `config.ts` / `state/`，运行期编排在 `runtime.ts`，
 *   面板 RPC 在 `panel-rpc.ts`。
 * - 桥的注册是延后的：`account` 要扫码之后才知道，`BridgeBinder` 负责「服务与桥
 *   谁先就绪都行」。
 * - `mySuperagent`、`connection` 都不写进顶层 `inject`：缺它们的组合里插件仍应
 *   照常加载（ADR-0003）。所以这里 `inject` 为空。
 */

import { normalizePluginConfig } from './config.ts';
import type { PluginConfig } from './config.ts';
import { errorDetail } from './host-context.ts';
import type { PluginContext } from './host-context.ts';
import { registerPanelRpc } from './panel-rpc.ts';
import { WeixinRuntime } from './runtime.ts';
import type { RuntimeStatus } from './runtime.ts';
import { BridgeBinder, installBridgeBinder } from './superagent/link.ts';

export type { LoginStateView } from './state/login-state.ts';
export type { PluginConfig, PluginContext };
export type { RuntimeStatus };
export { HOST_CONTRACT } from './runtime.ts';
export { ENDPOINTS, RPC_PATH } from './panel-rpc.ts';

export const name = 'dsh-im-wechat';

/** 没有硬依赖：核心、面板连接服务都按需接入。 */
export const inject: string[] = [];

export interface AppliedPlugin {
  runtime: WeixinRuntime;
  /** 停机（测试与优雅退出用；正常由 ctx 生命周期驱动）。 */
  stop(): Promise<void>;
}

export async function apply(
  ctx: PluginContext,
  config: PluginConfig | unknown = {},
): Promise<AppliedPlugin> {
  const logger = ctx.logger ?? {};
  const binder = new BridgeBinder({ logger });
  const runtime = new WeixinRuntime({ config: normalizePluginConfig(config), logger });

  runtime.attachBinder(binder);
  installBridgeBinder(ctx, binder);
  registerPanelRpc(ctx, { runtime, logger });
  ctx.effect?.(() => () => {
    void runtime.stop();
  }, 'dsh-im-wechat: 停止运行期');

  await runtime.start().catch((error: unknown) => {
    logger.error?.('微信插件启动失败', errorDetail(error));
  });
  return { runtime, stop: () => runtime.stop() };
}
