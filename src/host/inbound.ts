/**
 * 入站转换：iLink 消息 → `OwnerMessageDraft`，以及附件下载的统一入口。
 *
 * 桥在这里**只做搬运**：文本原样交出去，命令匹配由核心做（AGENTS.md「安全红线」）。
 * 唯一有立场的地方是附件——下载有边界（ADR-0004）：核心模式要核心声明 `owner-images`
 * 并判明发送者是主人，独立模式没有核心可声明，用登录态判明的主人（ADR-0017）。
 * 文件走独立模式自己的路（ADR-0028）：不进核心草稿，由 `downloadOwnerFiles` 下载后
 * 交给直连会话换成宿主的暂存回执。
 */

import { DEFAULT_CDN_BASE_URL } from './ilink/api.ts';
import { MessageItemType } from './ilink/types.ts';
import type { FileItem, ImageItem, WeixinItem, WeixinMessage } from './ilink/types.ts';
import { messageIdentity, messageText } from './ilink/identity.ts';
import { MAX_FILE_BYTES, downloadFile, downloadImage } from './ilink/media.ts';
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

/** 下载入站文件的选项；与图片同一道准入，多一份总量预算。 */
export interface FileDownloadOptions {
  cdnBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  logger?: InboundLogger;
  /** 单条消息的文件总量上限（默认 `MAX_FILE_BYTES`；测试注入更小的值）。 */
  maxBytes?: number;
  /** 主人才下载（ADR-0028：与图片同一道闸）。 */
  senderIsOwner: (sender: string) => boolean;
}

/** 一条消息最多收几个文件：再多也只是没人看的附件（ADR-0028）。 */
export const OWNER_FILES_MAX = 3;

/** 文件名的字节上限；宿主按 UTF-8 255 字节再清洗一次叶子名，这里留出余量。 */
const FILE_NAME_MAX_BYTES = 200;

/** 文件阶段的总时限：3 个文件各自 15 秒会把长轮询卡到 45 秒（图片是并发，最多一张的超时）。 */
const FILE_PHASE_MS = 20_000;

/** 文件名里不能留的字符：路径分隔符、控制字符与客户端不接受的符号。 */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;

/** 已收下、还没交给宿主暂存的文件。 */
export interface InboundFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 没收下的文件：名字与原因（原因会拼进微信提示，必须是人话）。 */
export interface DroppedFile {
  readonly name: string;
  readonly reason: string;
}

/** 一条消息里的文件：收下的与没收下的分开交给提交层。 */
export interface InboundFiles {
  readonly files: readonly InboundFile[];
  readonly dropped: readonly DroppedFile[];
}

/** 没有文件时的空结果：默认参数与提前返回共用一份（冻结，避免下游误改）。 */
export const NO_FILES: InboundFiles = Object.freeze({ files: [], dropped: [] });

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

// 平台 id 统一入口：字符串 trim，数字转字符串，空与非法值都当没有。
function platformId(value: string | number | undefined): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

// 用户引用了一条消息时，被引用消息的平台 id 在这里；核心靠它认回是哪次交付。
// 新版客户端只带 `svr_id`（优先），旧版带 `message_item.msg_id`。
function replyTo(message: WeixinMessage): string | undefined {
  for (const item of message.item_list ?? []) {
    const ref = item.ref_msg;
    if (ref === undefined) continue;
    const id = platformId(ref.svr_id) ?? platformId(ref.message_item?.msg_id);
    if (id !== undefined) return id;
  }
  return undefined;
}

/**
 * 把一条 iLink 消息转成核心的草稿。
 *
 * 返回 `null` 表示「这条没有可交付的内容」：既没有文本也没有可用的图片。
 * 文件不在草稿里（核心协议没有文件能力，ADR-0028）：接入核心时 `file_item` 照旧不处理。
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

  const quoted = replyTo(message);
  return {
    messageId,
    sender,
    text,
    at,
    ...(quoted ? { replyTo: quoted } : {}),
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

/** 文件条目与它的 `msg_id` 无关：文件名与字节都由 `file_item` 给，顺序即 item 顺序。 */
function fileItems(itemList: readonly WeixinItem[] | undefined): FileItem[] {
  if (!itemList?.length) return [];
  const out: FileItem[] = [];
  for (const entry of itemList) {
    if (entry?.type !== MessageItemType.FILE || !entry.file_item) continue;
    out.push(entry.file_item);
  }
  return out;
}

/** 文件名只留展示用的部分：去掉路径分隔符与控制字符，清空后给一个默认名。 */
function fileDisplayName(raw: string | undefined, index: number): string {
  const cleaned = (typeof raw === 'string' ? raw : '')
    .replace(UNSAFE_FILE_CHARS, '_')
    .replace(/^[._\s]+/, '')
    .trim();
  return truncateName(cleaned === '' ? `weixin-file-${index + 1}` : cleaned);
}

/** 按字节截断，保留扩展名：多字节字符不切半，也不把 `.pdf` 一起切掉。 */
function truncateName(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= FILE_NAME_MAX_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  const stem = ext === '' ? name : name.slice(0, dot);
  const extBytes = Buffer.byteLength(ext, 'utf8');
  let out = '';
  let bytes = 0;
  for (const char of stem) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size + extBytes > FILE_NAME_MAX_BYTES) break;
    out += char;
    bytes += size;
  }
  return `${out}${ext}`;
}

/** 下载层的原因翻成微信里的人话：不带分类码与裸字节数。 */
function fileReason(reason: string, limitText: string): string {
  if (reason.includes('上限')) return `超过 ${limitText} 上限`;
  if (reason === '下载超时' || reason === '下载被取消') return '下载超时';
  if (reason.startsWith('下载失败')) return '下载失败';
  return reason;
}

/**
 * 下载主人这条消息里的文件（独立模式，ADR-0028）。
 *
 * 准入只有一道闸：`senderIsOwner`。文件数量与总量都有限：最多 `OWNER_FILES_MAX` 个、
 * 合计 `MAX_FILE_BYTES` 字节，按顺序下载并共享同一份预算（处理完一个再下一个，
 * 内存峰值是已收下的明文加上当前这一个文件的密文）。单个文件失败只跳过它，原因随结果
 * 返回，由提交层拼成一条微信提示——文件不像图片那样可以静默少一张。
 */
export async function downloadOwnerFiles(
  message: WeixinMessage,
  options: FileDownloadOptions,
): Promise<InboundFiles> {
  if (!options.senderIsOwner(message.from_user_id ?? '')) return NO_FILES;

  const items = fileItems(message.item_list);
  if (items.length === 0) return NO_FILES;

  const total = options.maxBytes ?? MAX_FILE_BYTES;
  const limitText = `${Math.max(1, Math.round(total / (1024 * 1024)))} MB`;
  const files: InboundFile[] = [];
  const dropped: DroppedFile[] = [];
  let remaining = total;
  const selected = items.slice(0, OWNER_FILES_MAX);
  // 超出的部分要明说：主人发了 5 个只送 3 个，静默丢掉会让他以为都在。
  if (items.length > selected.length) {
    dropped.push({ name: `其余 ${items.length - selected.length} 个文件`, reason: `单条消息最多 ${OWNER_FILES_MAX} 个` });
  }
  // 整段下载共享一个时限：单个文件最多 15 秒是逐次超时，3 个串行是 45 秒。
  const deadline = Date.now() + FILE_PHASE_MS;

  for (const [index, item] of selected.entries()) {
    const name = fileDisplayName(item.file_name, index);
    const budgetLeft = deadline - Date.now();
    if (budgetLeft <= 0) {
      dropped.push({ name, reason: '下载超时' });
      continue;
    }
    const declared = Number.parseInt(item.len ?? '', 10);
    // `len` 是明文大小：够判断就不必先拉一遍密文（大文件可以到 GB 级）。
    if (Number.isFinite(declared) && declared > remaining) {
      dropped.push({ name, reason: `超过 ${limitText} 上限` });
      continue;
    }
    const result = await downloadFile(item, {
      cdnBaseUrl: options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: budgetLeft,
      // 密文比明文最多多补一个 AES 块：给下载留出这点余量，扣预算按明文算。
      maxBytes: remaining + 16,
    });
    if (!result.ok) {
      // 日志只记分类后的 reason：不带 URL、不带密钥、不带字节。
      options.logger?.warn?.(`微信文件未采用：${result.reason}`);
      dropped.push({ name, reason: fileReason(result.reason, limitText) });
      continue;
    }
    if (result.data.length > remaining) {
      dropped.push({ name, reason: `超过 ${limitText} 上限` });
      continue;
    }
    files.push({ name, bytes: result.data });
    remaining -= result.data.length;
  }
  return { files, dropped };
}
