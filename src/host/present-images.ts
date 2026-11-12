/**
 * 把会话里 `present` 的本地图片发到主人的微信（ADR-0019）。
 *
 * 独立模式下模型常用 `present` 交付文件：这在本机/Web 端是对的，微信那头却什么都看不到
 * （出站图片只有 CLI 与命令两条路，模型并不知道）。这里把「present 的图片」接到出站通道：
 * 只发图片、只发主人、只发绑定会话；非图片、不存在、超限的文件静默跳过。
 */

import { readFile, stat } from 'node:fs/promises';

import type { ILinkApi } from './ilink/api.ts';
import { MAX_IMAGE_BYTES, sniffImageType } from './ilink/media.ts';
import { sendImage } from './ilink/send.ts';
import { uploadImage } from './ilink/upload.ts';

/** 一次 present 最多发几张：与 CLI 同量级，避免一次刷屏。 */
export const PRESENT_IMAGES_MAX = 10;

export interface PresentImageOptions {
  api: ILinkApi;
  to: string;
  contextToken: string;
  cdnBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  logger?: { warn?(...args: unknown[]): unknown };
  max?: number;
}

export interface PresentImageResult {
  sent: number;
  /** 不是图片、不存在、超限的文件。 */
  skipped: number;
  failed: { path: string; reason: string }[];
}

/** `deliverables/presented` 事件里的文件路径（只取有 path 的条目）。 */
export function presentedPaths(event: unknown): string[] {
  const files = (event as { data?: { files?: unknown } } | null)?.data?.files;
  if (!Array.isArray(files)) return [];
  const paths: string[] = [];
  for (const file of files) {
    const path = (file as { path?: unknown } | null)?.path;
    if (typeof path === 'string' && path.trim() !== '') paths.push(path.trim());
  }
  return paths;
}

/** 逐张上传并发送；单张失败只记账，不影响其余图片与整条会话事件。 */
export async function sendPresentedImages(
  paths: readonly string[],
  options: PresentImageOptions,
): Promise<PresentImageResult> {
  const result: PresentImageResult = { sent: 0, skipped: 0, failed: [] };
  const max = options.max ?? PRESENT_IMAGES_MAX;
  let considered = 0;
  for (const path of paths) {
    if (considered >= max) break;
    const data = await readImageFile(path);
    if (data === null) {
      result.skipped += 1;
      continue;
    }
    considered += 1;
    try {
      const upload = await uploadImage(
        options.api,
        { data, toUserId: options.to },
        { cdnBaseUrl: options.cdnBaseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) },
      );
      await sendImage(options.api, { to: options.to, upload, contextToken: options.contextToken });
      result.sent += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '未知错误';
      options.logger?.warn?.('present 图片发送失败', reason);
      result.failed.push({ path, reason });
    }
  }
  return result;
}

/** 事件 → 发送：类型不是 present、没有文件、或调用方不在独立模式时什么都不做。 */
export function forwardPresentedImages(
  event: unknown,
  sink: { sendImages(paths: readonly string[]): Promise<boolean> },
  logger?: { warn?(...args: unknown[]): unknown },
): void {
  const paths = presentedPaths(event);
  if (paths.length === 0) return;
  void sink.sendImages(paths).catch((error: unknown) => {
    logger?.warn?.('present 图片转发失败', error instanceof Error ? error.message : error);
  });
}

/** 只读、限大小、按文件头认图片；任何一步不满足都当「不是要发的图」。 */
async function readImageFile(path: string): Promise<Buffer | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return null;
    const data = await readFile(path);
    return sniffImageType(data) === null ? null : data;
  } catch {
    return null;
  }
}
