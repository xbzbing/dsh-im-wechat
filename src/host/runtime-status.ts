/**
 * 运行期的对外状态视图：契约版本、状态结构与工作区候选的纯取值逻辑。
 *
 * 从 `runtime.ts` 拆出（AGENTS.md 文件规模规则）：装配层只留生命周期与接线，
 * 「状态长什么样」集中在这一份，面板契约（`HOST_CONTRACT`）也在这里定版。
 */

import type { ILinkApi } from './ilink/api.ts';
import type { LoginSnapshot } from './ilink/login.ts';
import type { BridgeHealth } from './superagent/protocol.ts';
import type { BusyMode } from './config.ts';

/** 面板 RPC 契约版本：加端点或改返回结构时必须递增。 */
export const HOST_CONTRACT = 3;

/** 宿主 `workspaceRegistry` 里本插件用到的部分（结构类型）。 */
export interface WorkspaceRegistry {
  list(): readonly { id?: unknown; title?: unknown; path?: unknown }[];
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

export interface RuntimeDeps {
  config?: unknown;
  logger?: RuntimeLogger;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** 测试注入：造协议客户端。 */
  createApi?: (options: { baseUrl: string; token?: string }) => ILinkApi;
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
