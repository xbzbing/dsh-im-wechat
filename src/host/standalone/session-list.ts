/**
 * 独立模式的会话目录：把宿主的会话列表收成命令与标题展示用的形状。
 *
 * 只读宿主的 `sessionController.list`（不 resume 冷会话）。过滤规则：
 * - 子代理会话（`origin === 'subagent'`／有 `parentSessionId`）不列，主人不该从微信接管子任务；
 * - 从未用过的空会话（`blank`）不列，选中它问一句才有内容；
 * - 当前绑定的会话不列——`/send` 给它没有意义，`/trace` 它又会被直连回复重复推一遍。
 */

import { basename } from 'node:path';

import type { DirectController, HostSessionRow } from '../direct.ts';

/** 列表超时：宿主读盘慢时宁可报「读不到」，也不把长轮询卡住。 */
const LIST_TIMEOUT_MS = 5_000;

export interface SessionSummary {
  sessionId: string;
  /** 宿主记下的标题；没有时是空串，由渲染层补「未命名会话」。 */
  title: string;
  updatedAt: number;
  running: boolean;
  /** 工作区目录名（宿主给的是 cwd）；没有时为空串。 */
  workspace: string;
}

export interface SessionCatalog {
  sessions: SessionSummary[];
  available: boolean;
  reason?: string;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 标题在投影汇总里；形状不认识就按「没有标题」处理。 */
export function rowTitle(row: HostSessionRow): string {
  const title = row.projections?.values?.title;
  return typeof title === 'string' ? title.trim() : '';
}

/** 工作区只显示目录名：完整路径对微信表格太宽，也带着主人本机路径。 */
function rowWorkspace(row: HostSessionRow): string {
  const cwd = asText(row.cwd);
  if (cwd === '') return '';
  const name = basename(cwd);
  return name === '' ? cwd : name;
}

/** 一行摘要 → 可列出的会话；不满足条件的返回 null。 */
function toSummary(row: HostSessionRow, exclude: string): SessionSummary | null {
  const sessionId = asText(row.sessionId);
  if (sessionId === '' || sessionId === exclude) return null;
  if (asText(row.origin) === 'subagent' || asText(row.parentSessionId) !== '') return null;
  if (row.blank === true) return null;
  return {
    sessionId,
    title: rowTitle(row),
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    running: row.running === true,
    workspace: rowWorkspace(row),
  };
}

export class SessionLister {
  readonly #controller: () => DirectController | null;
  readonly #exclude: () => string;

  constructor(options: { controller: () => DirectController | null; exclude: () => string }) {
    this.#controller = options.controller;
    this.#exclude = options.exclude;
  }

  async list(): Promise<SessionCatalog> {
    const controller = this.#controller();
    if (controller === null || typeof controller.list !== 'function') {
      return { sessions: [], available: false, reason: '宿主不提供会话列表' };
    }
    try {
      const value = await controller.list({}, AbortSignal.timeout(LIST_TIMEOUT_MS));
      const items = Array.isArray(value?.items) ? value.items : [];
      const exclude = this.#exclude();
      const sessions: SessionSummary[] = [];
      for (const row of items) {
        const summary = toSummary(row ?? {}, exclude);
        if (summary !== null) sessions.push(summary);
      }
      return { sessions, available: true };
    } catch (error) {
      return {
        sessions: [],
        available: false,
        reason: `读取会话列表失败：${error instanceof Error ? error.message : '未知错误'}`,
      };
    }
  }
}
