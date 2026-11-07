/**
 * 把桥接进核心：`mySuperagent` 服务在才注册，核心卸载时随之撤销。
 *
 * 用子 fiber 的 `ctx.inject` 而不是顶层 `inject`：顶层写进去会让没装核心的
 * 组合整个插件不激活，连带面板也打不开（ADR-0003）。核心不存在时插件照常
 * 独立工作——只是不注册桥。
 */

import type { MySuperagentService } from './protocol.ts';
import type { WeixinBridge } from './bridge.ts';

/** 宿主上下文的最小结构描述：不 import 宿主包（AGENTS.md）。 */
export interface SuperagentScope {
  mySuperagent?: MySuperagentService;
  effect?(execute: () => () => void, label?: string): unknown;
  inject?(services: string[], install: (scope: SuperagentScope) => void): unknown;
}

export interface LinkLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface RegisterBridgeOptions {
  bridge: WeixinBridge;
  logger?: LinkLogger;
}

export interface RegisteredBridge {
  /** 桥 id：`platform:account`。 */
  id: string;
  /** 核心声明的能力（`protocol.features`）。 */
  features: readonly string[];
  /** 撤销注册（服务卸载或插件停用时调用）。 */
  dispose(): void;
}

function installBridge(scope: SuperagentScope, options: RegisterBridgeOptions): RegisteredBridge | null {
  const service = scope.mySuperagent;
  if (!service) return null;
  try {
    const handle = service.bridges.register(options.bridge);
    const features = service.protocol?.features ?? [];
    options.bridge.attachHandle(handle, features);
    options.logger?.info?.(`微信桥已注册：${handle.id}`);
    return {
      id: handle.id,
      features: [...features],
      dispose: () => {
        options.bridge.detachHandle();
        handle.dispose();
      },
    };
  } catch (error) {
    // 重复注册（同一机器人账号已有桥）等失败不该让插件崩掉：面板与日志里说清楚。
    options.logger?.warn?.(
      `微信桥注册失败：${error instanceof Error ? error.message : '未知错误'}`,
    );
    return null;
  }
}

/**
 * 注册桥并把它绑到插件生命周期上。
 *
 * 返回的函数用于撤销（插件卸载时为幂等操作）。
 */
export function registerBridge(ctx: SuperagentScope, options: RegisterBridgeOptions): () => void {
  let registration: RegisteredBridge | null = null;

  const install = (scope: SuperagentScope): void => {
    registration = installBridge(scope, options);
    if (!registration) return;
    // 子 fiber 撤销时释放桥；不写 effect 的宿主（测试替身）靠返回的函数兜底。
    scope.effect?.(() => () => {
      registration?.dispose();
      registration = null;
    }, 'dsh-im-wechat: 撤销微信桥注册');
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['mySuperagent'], install);
  } else {
    install(ctx);
  }

  return () => {
    registration?.dispose();
    registration = null;
  };
}
