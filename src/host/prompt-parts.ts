/**
 * 提交给会话的 prompt 内容（ADR-0017、ADR-0028）。
 *
 * 独立模式把微信消息直接交给 DSH 会话，宿主 `sessionController.prompt` 接受三种 part：
 * 文字；`{ type: 'image', mediaType, data, name? }`（`data` 是规范 base64，宿主自己校验
 * 字节并转存附件）；以及 `{ type: 'file', receiptId }`——文件必须先由宿主的
 * `fileUploads` 在同一个会话下暂存，回执才是 part 的内容。图片由本插件按 ADR-0004 的
 * 边界从 CDN 下载解密后以 base64 直接交给宿主，**不落盘**；文件同理，落库归宿主。
 */

import type { ImageMediaType } from '../shared/media.ts';

export type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }
  | { readonly type: 'file'; readonly receiptId: string };

/** 只有图片没有文字时补的提示：模型拿到一张没有任何说明的图，会先猜主人想问什么。 */
export const DEFAULT_IMAGE_PROMPT = '请看这张图';
/** 只有文件没有文字时的提示。 */
export const DEFAULT_FILE_PROMPT = '请看这个文件';
/** 图片与文件都有、但没有文字时的提示。 */
export const DEFAULT_ATTACHMENT_PROMPT = '请看这些附件';

/** 交给 `buildPromptContent` 的图片：与核心草稿的 `OwnerImage` 同形（`src/shared/media.ts`）。 */
export interface PromptImage {
  readonly mediaType: ImageMediaType;
  readonly data: string;
  readonly name?: string;
}

/**
 * 文字（去掉首尾空白）在前、图片按收到的顺序在后；文件不在这里——它们要等会话 id
 * 才能换成回执（ADR-0028），由提交层追加。
 *
 * 不补默认提示：调用方要先拿到「主人到底写了什么」，才能决定提交失败后要不要按
 * 纯文字重发（`textContent`）；提示由 `withAttachmentHint` 在提交前补上。
 */
export function buildPromptContent(text: string, images: readonly PromptImage[]): PromptPart[] {
  const parts: PromptPart[] = [];
  const body = text.trim();
  if (body !== '') parts.push({ type: 'text', text: body });
  for (const image of images) {
    parts.push({
      type: 'image',
      mediaType: image.mediaType,
      data: image.data,
      ...(image.name !== undefined ? { name: image.name } : {}),
    });
  }
  return parts;
}

/** 有附件没文字时补一句提示；其余内容原样返回。 */
export function withAttachmentHint(parts: readonly PromptPart[]): PromptPart[] {
  if (parts.length === 0) return [];
  const hasImage = parts.some((part) => part.type === 'image');
  const hasFile = parts.some((part) => part.type === 'file');
  const hasText = parts.some((part) => part.type === 'text');
  if (hasText || (!hasImage && !hasFile)) return [...parts];
  const hint = hasImage && hasFile
    ? DEFAULT_ATTACHMENT_PROMPT
    : hasFile ? DEFAULT_FILE_PROMPT : DEFAULT_IMAGE_PROMPT;
  return [{ type: 'text', text: hint }, ...parts];
}

/** 内容里的真实文字（不含补的提示）：重试纯文字只发这一段。 */
export function textContent(parts: readonly PromptPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') texts.push(part.text);
  }
  return texts.join('\n');
}
