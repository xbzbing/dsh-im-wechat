/**
 * `session/event` 的分发：谁的事件归谁处理。
 *
 * 从 `runtime.ts` 拆出（文件规模规则）：这里只按「根会话/绑定会话」分流，不持有状态。
 * 接入核心时整段不进（`ownFeaturesActive` 为假），提醒与输入状态由核心负责（ADR-0006）。
 */

import type { DirectBinding } from './state/direct-binding.ts';

export interface SessionEventDeps {
  /** 启用 + 未接入核心 + 已登录 + 未停机。 */
  ownFeaturesActive(): boolean;
  longTasks: { handleEvent(sessionId: string, event: unknown): void };
  /** 独立模式绑定的会话。 */
  binding(): DirectBinding | null;
  /** 扫码登录的主人 id；输入状态按它取消。 */
  ownerUserId(): string;
  typingStop(userId: string): void;
  /** present 的图片发到微信（ADR-0019）。 */
  forwardPresented(event: unknown): void;
  directHandle(sessionId: string, event: unknown): void;
}

/** `session/event` 监听器：长任务提醒、输入状态收尾、present 图片转发出站、直连会话跟踪。 */
export function dispatchSessionEvent(deps: SessionEventDeps, session: unknown, event: unknown): void {
  if (!deps.ownFeaturesActive()) return;
  const sessionId = typeof session === 'string'
    ? session
    : typeof (session as { id?: unknown } | null)?.id === 'string'
      ? String((session as { id: string }).id)
      : '';
  if (sessionId === '') return;
  deps.longTasks.handleEvent(sessionId, event);
  const binding = deps.binding();
  if (binding === null || binding.sessionId !== sessionId) return;
  const type = (event as { type?: unknown } | null)?.type;
  if (type === 'turn/end') deps.typingStop(deps.ownerUserId());
  if (type === 'deliverables/presented') deps.forwardPresented(event);
  deps.directHandle(sessionId, event);
}
