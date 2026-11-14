/**
 * 运行期的对外状态视图：契约版本、状态结构与工作区候选的纯取值逻辑。
 *
 * 从 `runtime.ts` 拆出（AGENTS.md 文件规模规则）：装配层只留生命周期与接线，
 * 「状态长什么样」集中在这一份，面板契约（`HOST_CONTRACT`）也在这里定版。
 */

import { accountTail } from './state/login-state.ts';
import type { LoginState } from './state/login-state.ts';
import type { ILinkApi } from './ilink/api.ts';
import type { LoginSnapshot } from './ilink/login.ts';
import type { BridgeHealth } from './superagent/protocol.ts';
import type { BusyMode } from './config.ts';
import type { ModelRef } from '../shared/models.ts';

/** 面板 RPC 契约版本：加端点或改返回结构时必须递增。 */
export const HOST_CONTRACT = 5;

/** 宿主 `workspaceRegistry` 里本插件用到的部分（结构类型）。 */
export interface WorkspaceRegistry {
  list(): readonly { id?: unknown; title?: unknown; path?: unknown }[];
  /** 建或复用一个工作区（同一路径幂等）；老宿主没有这个方法时只读列表。 */
  create?(path: string, title?: string): Promise<{ id?: unknown }>;
}

export interface RuntimeLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
  error?(...args: unknown[]): unknown;
}

export interface RuntimeStatus {
  contract: number;
  version: string;
  enabled: boolean;
  /** 是否接入「我的超级助理」。关掉后插件自带的问题与长任务提醒接管。 */
  superagent: boolean;
  /** 自有功能（问题提醒、长任务提醒）是否生效。 */
  ownFeatures: boolean;
  /** 登录态里是否记录了扫码的微信用户（没记录就无法确认主人，自有提醒会静默失效）。 */
  ownerKnown: boolean;
  /** 等待主人作答的问题数。 */
  pendingQuestions: number;
  /** 等待主人决定的工具授权数。 */
  pendingApprovals: number;
  /** 面板上的「问题与审批提醒」开关。 */
  questionReminders: boolean;
  /** 提醒前等多久（分钟）：这段时间在 Web 端答完就不打扰。 */
  questionDelayMinutes: number;
  /** 正在跟踪的回合数（长任务提醒用）。 */
  trackingTasks: number;
  /** 长任务提醒阈值（分钟）：回合超过它才提醒。 */
  longTaskThresholdMinutes: number;
  /** 独立模式（未接入核心）的直连会话状态（ADR-0009）。 */
  direct: {
    bound: boolean;
    sessionId?: string;
    workspaceId: string;
    busyMode: BusyMode;
    running: boolean;
    available: boolean;
    /** 直连会话用哪个模型；`null` 表示跟随 DSH 的默认模型（ADR-0025）。 */
    model: ModelRef | null;
  };
  loggedIn: boolean;
  accountTail?: string;
  /** 上次扫码成功的时间；面板的「登录时间」用它。 */
  loggedInAt?: number;
  login: LoginSnapshot;
  health: BridgeHealth;
  bridge: { registered: boolean; id?: string; features: string[] };
  lastError?: { at: number; message: string };
}

/** `status()` 的输入：装配层把自己持有的可变状态收成视图要的形状。 */
export interface StatusInput {
  version: string;
  enabled: boolean;
  superagent: boolean;
  ownFeatures: boolean;
  pendingQuestions: number;
  pendingApprovals: number;
  questionReminders: boolean;
  questionDelayMinutes: number;
  trackingTasks: number;
  direct: RuntimeStatus['direct'];
  longTaskThresholdMinutes: number;
  login: LoginState | null;
  loginSnapshot: LoginSnapshot;
  health: BridgeHealth;
  /** 已注册的桥；核心不在时为空。 */
  bridge: { registered: boolean; id?: string; features: readonly string[] } | null;
  errors: readonly { at: number; message: string }[];
}

/** 装配状态 → 面板契约里的状态视图（字段合并逻辑集中在这里，配一层好测）。 */
export function buildStatus(input: StatusInput): RuntimeStatus {
  const { login } = input;
  const lastError = input.errors[input.errors.length - 1];
  return {
    contract: HOST_CONTRACT,
    version: input.version,
    enabled: input.enabled,
    superagent: input.superagent,
    ownFeatures: input.ownFeatures,
    ownerKnown: typeof login?.userId === 'string' && login.userId !== '',
    pendingQuestions: input.pendingQuestions,
    pendingApprovals: input.pendingApprovals,
    questionReminders: input.questionReminders,
    questionDelayMinutes: input.questionDelayMinutes,
    trackingTasks: input.trackingTasks,
    direct: input.direct,
    longTaskThresholdMinutes: input.longTaskThresholdMinutes,
    loggedIn: login !== null,
    ...(login ? { accountTail: accountTail(login.account), loggedInAt: login.loggedInAt } : {}),
    login: input.loginSnapshot,
    health: input.health,
    bridge: bridgeView(input.bridge),
    ...(lastError ? { lastError } : {}),
  };
}

/** 面板展示的一条最近错误。 */
export interface RecentError {
  at: number;
  message: string;
}

/**
 * 最近错误的环形缓冲：面板只显示最后几条。
 *
 * 唯一的消费者是面板的 `status.lastError`，容量规则放这里而不是散在运行期里；运行期
 * 只负责 `add`，清空与按前缀清理由调用点说明原因。
 */
export class RecentErrors {
  readonly #max: number;
  #items: RecentError[] = [];

  constructor(max = 5) {
    this.#max = max;
  }

  add(at: number, message: string): void {
    this.#items.push({ at, message });
    if (this.#items.length > this.#max) this.#items.shift();
  }

  /** 清掉满足条件的记录（工作区恢复成功后清掉旧的失败横幅，别的错误留着）。 */
  clearWhere(predicate: (message: string) => boolean): void {
    this.#items = this.#items.filter((item) => !predicate(item.message));
  }

  clear(): void {
    this.#items = [];
  }

  list(): readonly RecentError[] {
    return this.#items;
  }
}

/** 已注册的桥 → 状态视图里的那一项；没注册时给「未注册」。 */
export function bridgeView(
  bridge: { registered: boolean; id?: string; features: readonly string[] } | null,
): RuntimeStatus['bridge'] {
  return bridge === null
    ? { registered: false, features: [] }
    : { registered: bridge.registered, ...(bridge.id ? { id: bridge.id } : {}), features: [...bridge.features] };
}

export interface RuntimeDeps {
  config?: unknown;
  logger?: RuntimeLogger;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** 测试注入：造协议客户端。 */
  createApi?: (options: { baseUrl: string; token?: string }) => ILinkApi;
  /** 测试注入：等宿主建默认工作区的上限（默认 5 秒）。 */
  workspaceTimeoutMs?: number;
  /** 测试注入：默认工作区目录（默认 `$DSH_HOME/dsh-im-wechat`，与状态目录分开）。 */
  workspaceDir?: string;
}

/** 面板的工作区候选；宿主没有这个服务时 available=false，面板显示原因。 */
export interface WorkspaceCatalog {
  items: { id: string; title: string; path: string }[];
  available: boolean;
  reason?: string;
}

export function listWorkspaces(registry: WorkspaceRegistry | null): WorkspaceCatalog {
  if (!registry || typeof registry.list !== 'function') {
    return { items: [], available: false, reason: '宿主不提供工作区服务' };
  }
  try {
    const items = registry.list().flatMap((workspace) => {
      const id = typeof workspace?.id === 'string' ? workspace.id : '';
      if (id === '') return [];
      const title = typeof workspace.title === 'string' && workspace.title.trim() !== '' ? workspace.title.trim() : id;
      const path = typeof workspace.path === 'string' ? workspace.path : '';
      return [{ id, title, path }];
    });
    return { items, available: true };
  } catch {
    return { items: [], available: false, reason: '读取宿主工作区失败' };
  }
}
