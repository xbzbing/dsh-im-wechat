/**
 * 发送侧的健康映射：把一次失败的分类翻译成 `BridgeHealth`。
 *
 * 轮询循环维护的是连接状态；发送被 429/401 拒绝同样说明桥现在不能正常工作，
 * 但只写日志核心看不到，仍会照常投递与重试。这里把两类状态合到同一个读数里。
 */

import { ILinkError } from '../ilink/api.ts';
import { CdnUploadError } from '../ilink/upload.ts';
import type { SendFailure } from '../ilink/send.ts';
import type { BridgeHealth } from './protocol.ts';

export function healthWeight(state: BridgeHealth['state']): number {
  return state === 'down' ? 2 : state === 'degraded' ? 1 : 0;
}

/** 失败的严重度与恢复时间；`undefined` 表示不值得改变健康状态。 */
export function sendHealthFor(
  error: unknown,
  failure: SendFailure,
): { health: BridgeHealth; ttlMs?: number } | undefined {
  // 内容超限是这次交付的问题，不是桥的状态。
  if (failure.code === 'too-long') return undefined;
  if (failure.code === 'auth-expired') {
    return { health: { state: 'down', code: 'auth-expired', reason: '发送被拒：登录态失效' } };
  }
  if (failure.code === 'rate-limited') {
    return { health: { state: 'degraded', code: 'rate-limited', reason: '平台限流' }, ttlMs: 60_000 };
  }
  if (error instanceof CdnUploadError) {
    return { health: { state: 'degraded', code: 'other', reason: '图片上传失败' }, ttlMs: 120_000 };
  }
  if (error instanceof ILinkError && (error.kind === 'timeout' || error.kind === 'network')) {
    return { health: { state: 'degraded', code: 'network', reason: '发送网络异常' }, ttlMs: 120_000 };
  }
  if (failure.code === 'window-closed') {
    return { health: { state: 'degraded', code: 'other', reason: '24 小时窗口已关闭' }, ttlMs: 300_000 };
  }
  return { health: { state: 'degraded', code: 'other', reason: '发送失败' }, ttlMs: 120_000 };
}
