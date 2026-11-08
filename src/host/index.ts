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
import { registerWeixinCommand } from './command.ts';
import { errorDetail, injectOptional } from './host-context.ts';
import type { PluginContext } from './host-context.ts';
import type { HostAgents } from './host-agents.ts';
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

/**
 * 插件入口。
 *
 * **必须返回 void。** Cordis 会把 `apply` 的返回值当作 effect 注册：返回一个普通
 * 对象会抛 `Invalid effect`，整个 fiber 直接 failed（插件加载不上、面板 RPC 404）。
 * 运行期的启停一律交给 `ctx.effect` 注册的清理函数。
 */
export async function apply(
  ctx: PluginContext,
  config: PluginConfig | unknown = {},
): Promise<void> {
  const logger = ctx.logger ?? {};
  const binder = new BridgeBinder({ logger });
  const runtime = new WeixinRuntime({ config: normalizePluginConfig(config), logger });

  runtime.attachBinder(binder);
  installBridgeBinder(ctx, binder);

  // 独立模式的工作区选择用宿主的工作区目录（面板下拉），没有这个服务时面板给出原因。
  injectOptional(ctx, 'workspaceRegistry', (scope) => {
    runtime.attachWorkspaceRegistry((scope as { workspaceRegistry?: unknown }).workspaceRegistry as never ?? null);
    scope.effect?.(() => () => runtime.attachWorkspaceRegistry(null), 'dsh-im-wechat: 解挂 workspaceRegistry');
  });

  // 独立模式（未接入核心）要往会话里提交消息：宿主有 sessionController 才可用（ADR-0009）。
  injectOptional(ctx, 'sessionController', (scope) => {
    runtime.attachSessionController((scope as { sessionController?: unknown }).sessionController as never ?? null);
    scope.effect?.(() => () => runtime.attachSessionController(null), 'dsh-im-wechat: 解挂 sessionController');
  });

  // 根会话识别：子代理的提问与回合不打扰主人。
  injectOptional(ctx, 'agents', (scope) => {
    runtime.attachAgents((scope as { agents?: HostAgents }).agents ?? null);
    scope.effect?.(() => () => runtime.attachAgents(null), 'dsh-im-wechat: 解挂 agents');
  });

  registerHostListeners(ctx, runtime);
  registerPanelRpc(ctx, { runtime, logger });
  // `/wechat`：主人在输入框里自己发（命令不经过模型，ADR-0012）。
  registerWeixinCommand(ctx, { dir: runtime.dir });
  ctx.effect?.(() => () => {
    void runtime.stop();
  }, 'dsh-im-wechat: 停止运行期');

  await runtime.start().catch((error: unknown) => {
    logger.error?.('微信插件启动失败', errorDetail(error));
  });
}

/**
 * 宿主事件监听：问题提醒与长任务提醒。
 *
 * 提问必须 `prepend`：Web 端的转发监听器在 Host 启动时就注册了，排在它后面永远轮不到
 * 我们（与如流桥同一处坑）。`session/event` 要 `global`：所有会话的事件都要收到。
 */
function registerHostListeners(ctx: PluginContext, runtime: WeixinRuntime): void {
  if (typeof ctx.on !== 'function') return;
  type QuestionNext = () => Promise<unknown>;
  ctx.on('user-questions/request', ((request: unknown, next: QuestionNext) =>
    runtime.handleQuestion(request as Parameters<WeixinRuntime['handleQuestion']>[0], next)) as (...args: never[]) => unknown, { prepend: true });
  ctx.on('session/event', ((session: unknown, event: unknown) =>
    runtime.handleSessionEvent(session, event)) as (...args: never[]) => unknown, { global: true });
  ctx.on('agent/created', (() => runtime.refreshRoots()) as (...args: never[]) => unknown, { global: true });
  ctx.on('agent/disposed', (() => runtime.refreshRoots()) as (...args: never[]) => unknown, { global: true });
}
