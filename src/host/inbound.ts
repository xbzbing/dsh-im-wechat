/**
 * 入站转换：iLink 消息 → `OwnerMessageDraft`，以及图片下载的统一入口。
 *
 * 桥在这里**只做搬运**：文本原样交出去，命令匹配由核心做（AGENTS.md「安全红线」）。
 * 唯一有立场的地方是图片——下载有边界（ADR-0004）：核心模式要核心声明 `owner-images`
 * 并判明发送者是主人，独立模式没有核心可声明，用登录态判明的主人（ADR-0017）。
 */

import { DEFAULT_CDN_BASE_URL } from './ilink/api.ts';
import { MessageItemType } from './ilink/types.ts';
import type { ImageItem, WeixinItem, WeixinMessage } from './ilink/types.ts';
import { messageIdentity, messageText } from './ilink/identity.ts';
import { downloadImage } from './ilink/media.ts';
import {
  OWNER_IMAGE_DATA_MAX,
  OWNER_IMAGE_NAME_MAX,
  OWNER_IMAGES_MAX,
} from './superagent/protocol.ts';
import type { OwnerImage, OwnerMessageDraft } from './superagent/protocol.ts';

export interface InboundLogger {
  warn?(...args: unknown[]): unknown;
}

/** 下载入站图片的选项：调用方用 `senderIsOwner` 声明「这条消息的图可以下载」。 */
export interface ImageDownloadOptions {
  cdnBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /** 停机/停轮询时取消在途的下载。 */
  signal?: AbortSignal;
  logger?: InboundLogger;
  maxImageBytes?: number;
  /** 主人才下载：核心模式由 `owner-lookup` 判，独立模式由登录态判（ADR-0004、ADR-0017）。 */
  senderIsOwner: (sender: string) => boolean;
}

export interface InboundOptions extends Omit<ImageDownloadOptions, 'senderIsOwner'> {
  /** 机器人账号，参与消息身份的构造。 */
  account: string;
  /** 核心声明了 `owner-images` 才下载图片。 */
  imagesEnabled?: boolean;
  /** 核心声明了 `owner-lookup` 时传入；不传或判不了则不下载，图片按纯文本处理（ADR-0004）。 */
  senderIsOwner?: (sender: string) => boolean;
  now?: () => number;
}

const EXTENSION: Record<OwnerImage['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** 图片条目与它的 `msg_id` 一起取出：两者必须一一对应，单独过滤会错位。 */
function imageItems(itemList: readonly WeixinItem[] | undefined): { item: ImageItem; itemId?: string | number }[] {
  if (!itemList?.length) return [];
  const out: { item: ImageItem; itemId?: string | number }[] = [];
  for (const entry of itemList) {
    if (entry?.type !== MessageItemType.IMAGE || !entry.image_item) continue;
    out.push({ item: entry.image_item, ...(entry.msg_id !== undefined ? { itemId: entry.msg_id } : {}) });
  }
  return out;
}

/** `name` 只用于核心侧展示：带扩展名、截到 200 字以内。 */
function imageName(index: number, mediaType: OwnerImage['mediaType'], itemId: string | undefined): string {
  const stem = itemId && /^[A-Za-z0-9_-]+$/.test(itemId) ? itemId : String(index + 1);
  return `weixin-${stem}.${EXTENSION[mediaType]}`.slice(0, OWNER_IMAGE_NAME_MAX);
}

/**
 * 把一条 iLink 消息转成核心的草稿。
 *
 * 返回 `null` 表示「这条没有可交付的内容」：既没有文本也没有可用的图片。
 */
export async function toOwnerMessageDraft(
  message: WeixinMessage,
  options: InboundOptions,
): Promise<OwnerMessageDraft | null> {
  const messageId = messageIdentity(options.account, message);
  if (messageId === null) return null;

  const sender = typeof message.from_user_id === 'string' ? message.from_user_id : '';
  const text = messageText(message.item_list);
  const images = await collectImages(message, options);
  if (text.trim() === '' && images.length === 0) return null;

  const at = typeof message.create_time_ms === 'number' && Number.isFinite(message.create_time_ms)
    ? message.create_time_ms
    : (options.now ?? Date.now)();

  return {
    messageId,
    sender,
    text,
    at,
    ...(images.length > 0 ? { images } : {}),
  };
}

async function collectImages(message: WeixinMessage, options: InboundOptions): Promise<OwnerImage[]> {
  const { senderIsOwner } = options;
  if (options.imagesEnabled !== true || !senderIsOwner) return [];
  // 核心声明缺席（或判不了身份）与判出非主人一样整条不下载（ADR-0004）：
  // fail-open 会让任意微信用户发图就驱动本机出站下载。
  return downloadOwnerImages(message, { ...options, senderIsOwner });
}

/**
 * 下载主人这条消息里的图片，组装成核心草稿用的 `OwnerImage`（独立模式再由
 * `prompt-parts` 转成会话的 prompt part）。
 *
 * 准入只有一道闸：`senderIsOwner`。核心模式在调用前还要过 `owner-images` 声明
 * （`collectImages`），独立模式没有核心可声明，主人身份由登录态给定（ADR-0017）。
 * 不是通用下载器：任何新调用点都得先能证明「发送者是主人」。
 */
export async function downloadOwnerImages(
  message: WeixinMessage,
  options: ImageDownloadOptions,
): Promise<OwnerImage[]> {
  if (!options.senderIsOwner(message.from_user_id ?? '')) return [];

  const items = imageItems(message.item_list);
  if (items.length > OWNER_IMAGES_MAX) {
    options.logger?.warn?.(`一条消息带 ${items.length} 张图，只取前 ${OWNER_IMAGES_MAX} 张`);
  }
  const selected = items.slice(0, OWNER_IMAGES_MAX);
  if (selected.length === 0) return [];

  // 并发下载：串行 9 张每张 15s 上限会把长轮询卡死 135 秒；并发后整条消息
  // 的图片阶段最多耗时一张的超时。顺序按 index 对齐，失败的项跳过不挪位。
  const results = await Promise.all(selected.map(async ({ item, itemId }, index) => {
    const result = await downloadImage(item, {
      cdnBaseUrl: options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxImageBytes !== undefined ? { maxBytes: options.maxImageBytes } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!result.ok) {
      // 只记分类后的 reason：不带 URL、不带密钥、不带字节。
      options.logger?.warn?.(`微信图片未采用：${result.reason}`);
      return null;
    }
    const data = result.data.toString('base64');
    if (data.length > OWNER_IMAGE_DATA_MAX) {
      options.logger?.warn?.(`微信图片超过 ${OWNER_IMAGE_DATA_MAX} 字符上限，已丢弃`);
      return null;
    }
    const image: OwnerImage = {
      mediaType: result.mediaType,
      data,
      name: imageName(index, result.mediaType, itemId === undefined ? undefined : String(itemId)),
    };
    return image;
  }));
  return results.filter((image): image is OwnerImage => image !== null);
}
