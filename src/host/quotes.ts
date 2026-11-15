/**
 * 引用还原（ADR-0029）：把入站消息的 `ref_msg` 变成一行中文标头。
 *
 * 微信的引用只保证给「被引用那条消息的服务端 id」：新版客户端既不重复正文，也不带附件名
 * （`docs/protocol/ilink-消息与媒体.md`）。所以这里在内存里记一份「平台消息 id → 这条消息
 * 带了什么」，引用到来时按 id 查回来；查不到就退回 `ref_msg.title`。
 *
 * 索引只在内存、按条数兜住：引用是一次性的，文件名与正文片段不该进磁盘。代价是插件重启后
 * 只能靠标题——这是 ADR-0029 选定的取舍，不是遗漏。
 */

import { normalizeMessageId, refIdOf } from './ilink/identity.ts';
import { MessageItemType } from './ilink/types.ts';
import type { WeixinItem, WeixinMessage } from './ilink/types.ts';

/** 一条消息里值得被引用的内容；只留「认得出是哪一份」所需的最小信息。 */
export type QuotedKind = 'text' | 'image' | 'file';

export interface QuotedContent {
  readonly kind: QuotedKind;
  readonly name?: string;
  readonly text?: string;
}

/** 引用指向的东西：平台消息 id、客户端给的展示摘要，以及偶尔一并带来的被引用内容。 */
export interface QuoteRef {
  readonly messageId?: string;
  readonly title?: string;
  readonly inline: readonly QuotedContent[];
}

/**
 * 最多记多少条消息。
 *
 * 一条摘要几百字节（文件名、图片张数、截断过的正文），200 条也就几十 KB；超过就挤掉最早
 * 记的那条。不设时效：主人引用一小时前发的那份文件时，这条记录仍然有用。
 */
export const QUOTE_MAX_ENTRIES = 200;
/** 正文摘要与标题的截断长度。 */
const QUOTE_TEXT_MAX = 40;

/**
 * 从一条入站消息里取它的引用：id 优先 `svr_id`（新版客户端只带它），其次
 * `message_item.msg_id`（旧版形态）；`title` 只是展示文案，救不了 id 缺失的引用。
 */
export function quoteOf(message: WeixinMessage): QuoteRef | undefined {
  for (const item of message.item_list ?? []) {
    const ref = item.ref_msg;
    if (ref === undefined) continue;
    const messageId = normalizeMessageId(refIdOf(ref)) ?? undefined;
    const title = typeof ref.title === 'string' ? ref.title.trim() : '';
    const inline = contentOfItem(ref.message_item);
    if (messageId === undefined && title === '' && inline.length === 0) continue;
    return {
      ...(messageId === undefined ? {} : { messageId }),
      ...(title === '' ? {} : { title }),
      inline,
    };
  }
  return undefined;
}

/** 一条待记的消息带了什么：文件按收到的顺序在前，其次图片，最后正文。 */
export function quotedContent(input: {
  readonly text: string;
  readonly images: number;
  readonly files: readonly string[];
}): QuotedContent[] {
  const content: QuotedContent[] = input.files.map((name) => ({ kind: 'file', name }));
  for (let index = 0; index < input.images; index += 1) content.push({ kind: 'image' });
  // 正文只留标头会用到的那一小段：原文没有第二次用途，多留没有道理。
  if (input.text.trim() !== '') content.push({ kind: 'text', text: clip(input.text) });
  return content;
}

/** 「这条消息带了什么」的内存索引：按条数淘汰，进程内一直有效。 */
export class QuoteMemory {
  readonly #entries = new Map<string, readonly QuotedContent[]>();

  /** 记下一条消息带了什么；没有平台 id 或没有内容时不记——引用它本来也无处可查。 */
  remember(messageId: string | undefined, content: readonly QuotedContent[]): void {
    if (messageId === undefined || content.length === 0) return;
    // 重投的同一帧会重新记一次：删了再插，淘汰顺序按最新一次排。
    this.#entries.delete(messageId);
    this.#entries.set(messageId, content);
    while (this.#entries.size > QUOTE_MAX_ENTRIES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      this.#entries.delete(oldest.value);
    }
  }

  /** 还原成一行中文标头；认不出引用的是哪条时返回 undefined（不猜）。 */
  line(quote: QuoteRef): string | undefined {
    const body = describeQuote(this.#lookup(quote.messageId) ?? quote.inline)
      ?? describeTitle(quote.title);
    return body === undefined ? undefined : `[引用：${body}]`;
  }

  #lookup(messageId: string | undefined): readonly QuotedContent[] | undefined {
    return messageId === undefined ? undefined : this.#entries.get(messageId);
  }
}

/** 标头正文：文件最优先（主人问「这个文件」时指的就是它），其次图片，最后正文摘要。 */
function describeQuote(content: readonly QuotedContent[]): string | undefined {
  const names = content
    .filter((entry) => entry.kind === 'file')
    .map((entry) => clip(entry.name ?? ''))
    .filter((name) => name !== '');
  if (names.length > 0) return `文件 ${names.join('、')}`;
  const images = content.filter((entry) => entry.kind === 'image').length;
  if (images > 0) return images === 1 ? '图片' : `图片 ${images} 张`;
  const text = content.find((entry) => entry.kind === 'text')?.text ?? '';
  return text.trim() === '' ? undefined : `「${clip(text)}」`;
}

function describeTitle(title: string | undefined): string | undefined {
  const text = (title ?? '').trim();
  return text === '' ? undefined : `「${clip(text)}」`;
}

/** 一条引用标头不该比它指的东西还长：压掉换行，超出长度截断。 */
function clip(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= QUOTE_TEXT_MAX ? chars.join('') : `${chars.slice(0, QUOTE_TEXT_MAX).join('')}…`;
}

/** 客户端偶尔会把被引用条目的内容一并带来：有就用，没有就等索引。 */
function contentOfItem(item: WeixinItem | undefined): QuotedContent[] {
  if (item === undefined) return [];
  const text = typeof item.text_item?.text === 'string'
    ? item.text_item.text
    : typeof item.voice_item?.text === 'string' ? item.voice_item.text : '';
  if (text.trim() !== '') return [{ kind: 'text', text }];
  if (item.type === MessageItemType.IMAGE) return [{ kind: 'image' }];
  const name = typeof item.file_item?.file_name === 'string' ? item.file_item.file_name.trim() : '';
  return name === '' ? [] : [{ kind: 'file', name }];
}
