/**
 * 入站图片：从 CDN 取密文、解密、按文件头认类型（ADR-0004）。
 *
 * 协议事实（官方 openclaw-weixin 的图片入站路径）：
 * - 图片本体在 CDN 上，AES-128-ECB / PKCS#7；
 * - 密钥可能给在 `image_item.aeskey`（十六进制），优先级高于 `media.aes_key`；
 * - `media.aes_key` 有两种编码：base64(16 字节裸密钥) 或 base64(32 个十六进制字符)；
 * - `media.full_url` 有时直接给可下载直链。
 *
 * 这里是插件唯一主动访问第三方地址的地方，所以边界写死：只允许 https、主机必须在
 * 微信域名白名单内、禁跟随重定向、限大小与时限；任何一项不满足都当作「这条没有图」。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { classifyNetworkFailure } from './api.ts';
import type { CdnMedia, ImageItem } from './types.ts';

/** 单张上限：密文与明文各判一次。 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 15_000;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/** CDN 直链只允许落在微信自家域名下。 */
export function isAllowedMediaUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'qq.com' || host.endsWith('.qq.com');
}

/** 按文件头认类型；只认核心接受的四种。 */
export function sniffImageType(buffer: Buffer): ImageMediaType | null {
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
    && buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6
    && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46
    && buffer[3] === 0x38 && (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61) {
    return 'image/gif';
  }
  if (buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** 十六进制密钥（`image_item.aeskey`）→ 16 字节。 */
export function parseHexKey(aeskey: string | undefined): Buffer | null {
  if (typeof aeskey !== 'string') return null;
  const cleaned = aeskey.trim();
  if (!/^[0-9a-fA-F]{32}$/.test(cleaned)) return null;
  return Buffer.from(cleaned, 'hex');
}

/**
 * `media.aes_key` 的两种编码 → 16 字节密钥。
 *
 * base64 解码后可能是 16 字节裸密钥，也可能是 32 个十六进制字符。
 */
export function parseBase64Key(aesKey: string | undefined): Buffer | null {
  if (typeof aesKey !== 'string' || aesKey.trim() === '') return null;
  const decoded = Buffer.from(aesKey.trim(), 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  return null;
}

/** AES-128-ECB + PKCS#7（Node 默认自动去填充）。 */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB + PKCS#7 加密（出站上传用，ADR-0010）。 */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** 加密后的密文大小：PKCS#7 补齐到 16 的倍数（总是补，整倍数也补一整块）。 */
export function aesEcbPaddedSize(rawSize: number): number {
  return rawSize + 16 - (rawSize % 16);
}

/** 小写十六进制 MD5：`getuploadurl` 的 `rawfilemd5` 字段。 */
export function md5Hex(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex');
}

/** 十六进制密钥 → `media.aes_key` 的 base64(32 个十六进制字符) 编码。 */
export function base64AesKeyFromHex(hex: string): string {
  return Buffer.from(hex, 'ascii').toString('base64');
}

/** 随机十六进制密钥（32 个字符 = 16 字节）。 */
export function randomHexKey(randomBytes: (size: number) => Buffer = randomBytesDefault): string {
  return randomBytes(16).toString('hex');
}

function randomBytesDefault(size: number): Buffer {
  return randomBytes(size);
}

export type ImageDownloadResult =
  | { ok: true; mediaType: ImageMediaType; data: Buffer }
  | { ok: false; reason: string };

export interface ImageDownloadOptions {
  cdnBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** 外部取消（停机/停轮询）：立刻中断在途下载。 */
  signal?: AbortSignal;
}

function fail(reason: string): ImageDownloadResult {
  return { ok: false, reason };
}

/** 未消费的 body 不放回连接池，失败路径必须显式丢弃（undici 约束）。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 已经读不动了就随它去。
  }
}

/** CDN 兜底地址：直链不可用时按 `encrypt_query_param` 拼。 */
function fallbackUrl(cdnBaseUrl: string, encryptQueryParam: string): string {
  const base = cdnBaseUrl.endsWith('/') ? cdnBaseUrl.slice(0, -1) : cdnBaseUrl;
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/** 选出可用的下载地址：优先白名单内直链，否则用 CDN 拼。 */
export function resolveMediaUrl(media: CdnMedia, cdnBaseUrl: string): string | null {
  const fullUrl = typeof media.full_url === 'string' ? media.full_url.trim() : '';
  if (fullUrl !== '' && isAllowedMediaUrl(fullUrl)) return fullUrl;
  const param = typeof media.encrypt_query_param === 'string' ? media.encrypt_query_param.trim() : '';
  if (param === '') return null;
  const url = fallbackUrl(cdnBaseUrl, param);
  return isAllowedMediaUrl(url) ? url : null;
}

/** 读出响应体，超过上限立刻放弃（不把整段灌进内存再判）。 */
async function readLimited(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > maxBytes ? null : buffer;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * 下载并解密一张图片。
 *
 * 失败一律返回原因字符串，由调用方记一条不含 URL 与密钥的日志；这条消息的其余
 * 部分照常处理。
 */
export async function downloadImage(
  item: ImageItem,
  options: ImageDownloadOptions,
): Promise<ImageDownloadResult> {
  const media = item.media;
  if (!media) return fail('缺少 media 引用');
  const url = resolveMediaUrl(media, options.cdnBaseUrl);
  if (url === null) return fail('没有可用的下载地址');

  const key = parseHexKey(item.aeskey) ?? parseBase64Key(media.aes_key);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  let response: Response | null = null;
  let ciphertext: Buffer | null = null;
  try {
    response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      await discardBody(response);
      return fail(`CDN 返回重定向 ${response.status}`);
    }
    if (!response.ok) {
      await discardBody(response);
      return fail(`CDN 返回 ${response.status}`);
    }
    ciphertext = await readLimited(response, maxBytes);
  } catch (error) {
    // 只回分类码：底层异常的 message 会带完整 URL（直链有签名参数），不能进日志。
    if (options.signal?.aborted) return fail('下载被取消');
    return fail(`下载失败（${classifyNetworkFailure(error)}）`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
  if (ciphertext === null) return fail(`图片超过 ${maxBytes} 字节上限`);

  let plaintext = ciphertext;
  if (key) {
    try {
      plaintext = decryptAesEcb(ciphertext, key);
    } catch {
      // AES 解密的底层错误只说明「密钥或密文不对」，没有更多信息可取。
      return fail('解密失败');
    }
    if (plaintext.length > maxBytes) return fail(`解密后超过 ${maxBytes} 字节上限`);
  }

  const mediaType = sniffImageType(plaintext);
  if (!mediaType) return fail('解密后不是 png/jpeg/webp/gif');
  return { ok: true, mediaType, data: plaintext };
}
