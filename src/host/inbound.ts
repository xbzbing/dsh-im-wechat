/**
 * 入站转换：iLink 消息 → `OwnerMessageDraft`。
 *
 * 桥在这里**只做搬运**：文本原样交出去，命令匹配、主人判定都由核心做（AGENTS.md
 * 「安全红线」）。唯一有立场的地方是图片——下载有边界（ADR-0004），所以要先问
 * 核心「这条消息的发送者是不是主人」。
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

export interface InboundOptions {
  /** 机器人账号，参与消息身份的构造。 */
  account: string;
  cdnBaseUrl?: string;
  /** 核心声明了 `owner-images` 才下载图片。 */
  imagesEnabled?: boolean;
  /** 核心声明了 `owner-lookup` 时传入；不传则不判定，按允许处理。 */
  senderIsOwner?: (sender: string) => boolean;
  fetch?: typeof globalThis.fetch;
  logger?: InboundLogger;
  now?: () => number;
  maxImageBytes?: number;
}

const EXTENSION: Record<OwnerImage['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function imageItems(itemList: readonly WeixinItem[] | undefined): ImageItem[] {
  if (!itemList?.length) return [];
  return itemList
    .filter((item) => item?.type === MessageItemType.IMAGE && item.image_item)
    .map((item) => item.image_item as ImageItem);
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
  if (options.imagesEnabled !== true) return [];
  // 不是主人就整条不下载（ADR-0004）：图片是主人内容里最敏感的部分。
  if (options.senderIsOwner && !options.senderIsOwner(message.from_user_id ?? '')) return [];

  const items = imageItems(message.item_list);
  if (items.length === 0) return [];

  const sourceItems = (message.item_list ?? []).filter((item) => item?.type === MessageItemType.IMAGE);
  const images: OwnerImage[] = [];
  for (let index = 0; index < items.length && images.length < OWNER_IMAGES_MAX; index += 1) {
    const item = items[index];
    const result = await downloadImage(item, {
      cdnBaseUrl: options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.maxImageBytes !== undefined ? { maxBytes: options.maxImageBytes } : {}),
    });
    if (!result.ok) {
      // 只记原因：不带 URL、不带密钥、不带字节。
      options.logger?.warn?.(`微信图片未采用：${result.reason}`);
      continue;
    }
    const data = result.data.toString('base64');
    if (data.length > OWNER_IMAGE_DATA_MAX) {
      options.logger?.warn?.(`微信图片超过 ${OWNER_IMAGE_DATA_MAX} 字符上限，已丢弃`);
      continue;
    }
    const itemId = sourceItems[index]?.msg_id;
    images.push({
      mediaType: result.mediaType,
      data,
      name: imageName(index, result.mediaType, itemId === undefined ? undefined : String(itemId)),
    });
  }
  return images;
}
