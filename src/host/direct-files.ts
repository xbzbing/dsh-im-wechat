/**
 * 直连会话的附件层（ADR-0027）：文件先交给宿主的附件暂存换回执，以及附件被丢掉时
 * 的那几句微信提示。
 *
 * 提示只出现在微信侧，必须是中文：宿主给的英文细节（模型名、路径、DOMException）只进
 * 日志，不转给主人。
 */

import { messageOf } from './host-context.ts';
import type { DroppedFile, InboundFile } from './inbound.ts';
import type { PromptPart } from './prompt-parts.ts';

/** 宿主 `fileUploads` 里本模块用到的那一个方法（结构类型，不 import 宿主包）。 */
export interface HostFileUploader {
  uploadStream(request: {
    readonly sessionId: string;
    readonly data: AsyncIterable<Uint8Array>;
    readonly signal?: AbortSignal;
    readonly name?: string;
  }): Promise<{ readonly receiptId: string }>;
}

interface FileLogger {
  warn?(...args: unknown[]): unknown;
}

const UPLOAD_UNAVAILABLE = '宿主没有文件上传服务';

/** 全部文件都没能进会话：宿主没有上传服务时的结果（原因与日志只在这里产生）。 */
export function unsentFiles(files: readonly InboundFile[], logger?: FileLogger): DroppedFile[] {
  if (files.length > 0) logger?.warn?.('宿主没有 fileUploads 服务，入站文件收不下');
  return files.map((file) => ({ name: file.name, reason: UPLOAD_UNAVAILABLE }));
}

/**
 * 把文件交给宿主的附件暂存，换回执 part。
 *
 * 单个文件失败只丢那一个，原因（中文）随结果返回；已经换到回执的照常提交。
 */
export async function uploadOwnerFiles(options: {
  uploader: HostFileUploader | null;
  sessionId: string;
  files: readonly InboundFile[];
  signal: AbortSignal;
  logger?: FileLogger;
}): Promise<{ parts: PromptPart[]; dropped: DroppedFile[] }> {
  const parts: PromptPart[] = [];
  const { uploader, files } = options;
  if (files.length === 0) return { parts, dropped: [] };
  if (!uploader) return { parts, dropped: unsentFiles(files, options.logger) };
  const dropped: DroppedFile[] = [];
  for (const file of files) {
    try {
      const receipt = await uploader.uploadStream({
        sessionId: options.sessionId,
        data: chunksOf(file.bytes),
        signal: options.signal,
        name: file.name,
      });
      parts.push({ type: 'file', receiptId: receipt.receiptId });
    } catch (error) {
      // 细节只进日志：微信那头只说「上传失败」或「提交超时」。
      options.logger?.warn?.('微信文件没有传进会话', messageOf(error));
      dropped.push({ name: file.name, reason: abortReason(options.signal) });
    }
  }
  return { parts, dropped };
}

/** 中止原因是我们的提交预算到期，还是插件被停掉：前者回「提交超时」，后者只说已取消。 */
function abortReason(signal: AbortSignal): string {
  if (!signal.aborted) return '上传失败';
  return (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError' ? '提交超时' : '已取消';
}

/** 宿主按流消费；文件字节已经在内存里，一次交出整段。 */
async function* chunksOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

/** 没接上的文件合成一条提示：名字 + 原因；名字截短，避免一条提示过长。 */
export function fileDropNotice(dropped: readonly DroppedFile[]): string {
  const items = dropped.map((file) => `${shortName(file.name)}（${file.reason}）`);
  return `文件没有收进会话：${items.join('；')}`;
}

/** 提示里的文件名截到 40 字：主人认得出来就够。 */
function shortName(name: string): string {
  const chars = Array.from(name);
  return chars.length <= 40 ? name : `${chars.slice(0, 40).join('')}…`;
}

/** 附件（图片/文件）被明确拒收后，去掉附件重发文字时的那几句提示。 */
export type DroppedKind = 'image' | 'file' | 'both';

const DROPPED_SUFFIX: Record<DroppedKind, string> = {
  image: '（图片没有发出去，已按文字发送）',
  file: '（文件没有发出去，已按文字发送）',
  both: '（附件没有发出去，已按文字发送）',
};
const DROPPED_NOTICE: Record<DroppedKind, string> = {
  image: '图片没有发出去（当前会话的模型可能不支持看图），已按文字发送。',
  file: '文件没有发出去，已按文字发送。',
  both: '附件没有发出去，已按文字发送。',
};
const ONLY_REJECTED: Record<DroppedKind, string> = {
  image: '图片没有发出去：当前会话的模型可能不支持看图，换个模型或改用文字再发一次。',
  file: '文件没有发出去：会话没有接受这个附件，请重发或改用文字再发一次。',
  both: '附件没有发出去：会话没有接受这些附件，请重发或改用文字再发一次。',
};

/** 排队/插话回执后面追加一句「附件没发出去」。 */
export function withDropped(notice: string, kind: DroppedKind | null): string {
  return kind === null ? notice : `${notice}${DROPPED_SUFFIX[kind]}`;
}

/** 附件被拒收、只剩文字可发时的专门提示。 */
export function droppedNotice(kind: DroppedKind): string {
  return DROPPED_NOTICE[kind];
}

/** 附件被拒收、连文字都没有时的专门提示。 */
export function onlyRejected(kind: DroppedKind): string {
  return ONLY_REJECTED[kind];
}

/** 内容里带了哪类附件；没有附件返回 null（决定重发与提示用哪一句）。 */
export function attachmentKind(parts: readonly PromptPart[]): DroppedKind | null {
  const image = parts.some((part) => part.type === 'image');
  const file = parts.some((part) => part.type === 'file');
  if (image && file) return 'both';
  if (file) return 'file';
  if (image) return 'image';
  return null;
}
