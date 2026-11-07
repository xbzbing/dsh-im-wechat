/**
 * 入站消息的稳定标识。
 *
 * iLink 的 `getUpdates` 是至少一次投递：同一帧可能被重复推一次。桥要把重复帧
 * 挡在核心之前，核心也要按 `(bridge, messageId)` 去重，所以这里给每条消息一个
 * 稳定、唯一的身份串，字段优先级与官方实现一致：
 *
 * `message_id` → `client_id` → `seq` → 各 item 的 `msg_id` 摘要 → 正文 + 时间摘要。
 *
 * 最后一级只在前四级都没有时使用（个别帧什么都没带）；只按发送者做键会
 * 把同一人前后的不同消息误判成同一条，绝不采用。
 */

import { createHash } from 'node:crypto';

import { MessageItemType } from './types.ts';
import type { WeixinItem, WeixinMessage } from './types.ts';

/** 协议允许的十进制整数（`-0` 归一成 `0`）。 */
const DECIMAL_INTEGER = /^-?(?:0|[1-9]\d*)$/;

function normalizeMessageId(value: string | number | undefined): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!DECIMAL_INTEGER.test(trimmed)) return null;
    return trimmed === '-0' ? '0' : trimmed;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

/** 各 item 的 `msg_id`，排序后作为媒体身份的一部分。 */
export function itemMessageIds(itemList: readonly WeixinItem[] | undefined): string[] {
  if (!itemList?.length) return [];
  const ids: string[] = [];
  for (const item of itemList) {
    const id = normalizeMessageId(item?.msg_id);
    if (id) ids.push(id);
  }
  return ids.sort();
}

/** 取消息的文本正文：优先 TEXT，其次语音转文字。 */
export function messageText(itemList: readonly WeixinItem[] | undefined): string {
  if (!itemList?.length) return '';
  for (const item of itemList) {
    if (item?.type === MessageItemType.TEXT && typeof item.text_item?.text === 'string') {
      return item.text_item.text;
    }
    if (item?.type === MessageItemType.VOICE && typeof item.voice_item?.text === 'string') {
      return item.voice_item.text;
    }
  }
  return '';
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 16);
}

/** 稳定身份；一条消息连正文都没有时返回 null（不该被采纳）。 */
export function messageIdentity(account: string, message: WeixinMessage): string | null {
  const from = typeof message.from_user_id === 'string' ? message.from_user_id : '';
  if (account === '') return null;
  const prefix = `weixin:v1:${account}:${from}`;

  const messageId = normalizeMessageId(message.message_id);
  if (messageId !== null) return `${prefix}:mid:${messageId}`;

  const clientId = typeof message.client_id === 'string' ? message.client_id.trim() : '';
  if (clientId !== '') return `${prefix}:cid:${clientId}`;

  if (typeof message.seq === 'number' && Number.isFinite(message.seq)) {
    return `${prefix}:seq:${message.seq}`;
  }

  const itemIds = itemMessageIds(message.item_list);
  if (itemIds.length > 0) return `${prefix}:items:${digest(itemIds)}`;

  const body = messageText(message.item_list);
  if (body === '' && itemIds.length === 0) {
    // 只有媒体、又没有传输 id 的帧：退回「有没有图」的粗粒度摘要仍可能撞车，
    // 宁可不采纳也不要制造错误的去重。
    const hasMedia = (message.item_list ?? []).some(
      (item) => item?.type === MessageItemType.IMAGE || item?.type === MessageItemType.FILE,
    );
    if (hasMedia) {
      const time = typeof message.create_time_ms === 'number' ? message.create_time_ms : 0;
      return `${prefix}:media:${digest([String(time), String(message.item_list?.length ?? 0)])}`;
    }
    return null;
  }
  const time = typeof message.create_time_ms === 'number' ? message.create_time_ms : 0;
  return `${prefix}:body:${digest([body, String(time)])}`;
}
