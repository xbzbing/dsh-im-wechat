/**
 * 把桥接进核心：`mySuperagent` 服务在才注册，核心卸载时随之撤销。
 *
 * 用子 fiber 的 `ctx.inject` 而不是顶层 `inject`：顶层写进去会让没装核心的
 * 组合整个插件不激活，连带面板也打不开（ADR-0003）。核心不存在时插件照常
 * 独立工作——只是不注册桥。
 *
 * 注册要**延后**：桥 id 是 `platform:account`，而 `account` 是扫码之后才知道的
 * `ilink_bot_id`。所以这里做一个绑定器——服务与桥谁先就绪都行，两者齐了才注册；
 * 登出时解绑，重新登录后再绑。
 */

import type { BridgeHandle, MySuperagentService, OwnerMessageDraft } from './protocol.ts';
import type { AcceptResult } from './protocol.ts';
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

export interface RegisteredBridge {
  id: string;
  features: readonly string[];
  dispose(): void;
}

export class BridgeBinder {
  readonly #logger: LinkLogger | undefined;
  #service: MySuperagentService | null = null;
  #bridge: WeixinBridge | null = null;
  #registration: RegisteredBridge | null = null;
  #handle: BridgeHandle | null = null;

  constructor(options: { logger?: LinkLogger } = {}) {
    this.#logger = options.logger;
  }

  /** 核心服务就绪（子 fiber 注入回调）。 */
  attach(scope: SuperagentScope): void {
    this.#service = scope.mySuperagent ?? null;
    if (!this.#service) return;
    this.#tryRegister();
    scope.effect?.(() => () => this.detach(), 'dsh-im-wechat: 撤销微信桥注册');
  }

  /** 核心服务撤销或插件停用。 */
  detach(): void {
    this.#registration?.dispose();
    this.#registration = null;
    this.#handle = null;
    this.#service = null;
    this.#bridge?.detachHandle();
  }

  /** 把一条入站消息交给核心；桥还没注册（没有核心）时返回 null。 */
  async receive(draft: OwnerMessageDraft): Promise<AcceptResult | null> {
    if (!this.#handle) return null;
    return this.#handle.receive(draft);
  }

  /** 桥就绪（登录成功）或失效（登出）时调用；服务未就绪则挂起。 */
  bind(bridge: WeixinBridge | null): void {
    this.#registration?.dispose();
    this.#registration = null;
    this.#bridge = bridge;
    this.#tryRegister();
  }

  get registered(): boolean {
    return this.#registration !== null;
  }

  get id(): string | undefined {
    return this.#registration?.id;
  }

  get features(): readonly string[] {
    return this.#registration?.features ?? [];
  }

  #tryRegister(): void {
    if (!this.#service || !this.#bridge || this.#registration) return;
    const bridge = this.#bridge;
    try {
      const handle = this.#service.bridges.register(bridge);
      const features = this.#service.protocol?.features ?? [];
      bridge.attachHandle(handle, features);
      this.#handle = handle;
      this.#registration = {
        id: handle.id,
        features: [...features],
        dispose: () => {
          bridge.detachHandle();
          this.#handle = null;
          handle.dispose();
        },
      };
      this.#logger?.info?.(`微信桥已注册：${handle.id}`);
    } catch (error) {
      // 同一机器人账号已有桥（account-already-bridged）等失败不该让插件崩掉。
      this.#logger?.warn?.(
        `微信桥注册失败：${error instanceof Error ? error.message : '未知错误'}`,
      );
      bridge.detachHandle();
    }
  }
}

/** 把绑定器挂到插件上下文上：核心服务出现时自动接上。 */
export function installBridgeBinder(ctx: SuperagentScope, binder: BridgeBinder): void {
  if (typeof ctx.inject === 'function') {
    ctx.inject(['mySuperagent'], (scope: SuperagentScope) => binder.attach(scope));
    return;
  }
  binder.attach(ctx);
}
