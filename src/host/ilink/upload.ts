/**
 * 出站图片上传（ADR-0010）：`getuploadurl` → AES-128-ECB 加密 → POST 到 CDN → 取回下载参数。
 *
 * 协议事实来自官方 `openclaw-weixin` 的 `cdn/upload.ts`（同 Dart SDK 的 `CdnMediaUploader`）：
 * 1. `filekey` 与 `aeskey` 各是 16 字节随机数的十六进制（32 字符）；
 * 2. 请求带明文大小 `rawsize`、明文 MD5 `rawfilemd5`、密文大小 `filesize`、`no_need_thumb: true`；
 * 3. 上传地址优先用响应里的 `upload_full_url`，否则按 `{cdnBaseUrl}/upload?encrypted_query_param=…&filekey=…` 拼；
 * 4. 请求体是密文字节，`Content-Type: application/octet-stream`；成功时下载参数在响应头 `x-encrypted-param`；
 * 5. 4xx 立即失败不重试，5xx 与网络错误最多试 3 次。
 *
 * 这是插件第二处主动访问第三方地址的地方，边界与下载一致：只允许 https、主机必须落在微信域名内。
 */

import type { ILinkApi } from './api.ts';
import { aesEcbPaddedSize, encryptAesEcb, md5Hex, randomHexKey } from './media.ts';

export const UPLOAD_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
/** proto: UploadMediaType，图片是 1。 */
export const UPLOAD_MEDIA_TYPE_IMAGE = 1;

export class CdnUploadError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'CdnUploadError';
    this.status = status;
  }
}

export interface UploadedMedia {
  /** 发消息时 `media.encrypt_query_param` 用这个。 */
  encryptQueryParam: string;
  /** `media.aes_key` 用 base64(32 个十六进制字符)，同时顶层 `image_item.aeskey` 放原始十六进制。 */
  aesKeyHex: string;
  ciphertextSize: number;
  rawMd5: string;
}

export interface UploadImageOptions {
  cdnBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  timeoutFn?: (ms: number) => AbortSignal;
}

/** 上传地址只允许微信自家域名。 */
export function isAllowedUploadUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com') || host === 'qq.com' || host.endsWith('.qq.com');
}

/** 错误文案里的主机名：地址本身不可解析时也不能再抛一次 TypeError。 */
function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '非法地址';
  }
}

function buildUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  const base = cdnBaseUrl.endsWith('/') ? cdnBaseUrl.slice(0, -1) : cdnBaseUrl;
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 读不动就随它去。
  }
}

async function postCiphertext(url: string, ciphertext: Buffer, options: UploadImageOptions): Promise<string> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: CdnUploadError | undefined;
  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: controller.signal,
      });
      const status = response.status;
      if (status >= 400 && status < 500) {
        const detail = response.headers.get('x-error-message') ?? (await response.text()).slice(0, 200);
        await discardBody(response);
        // 客户端错误不重试：重试只会再撞一次墙。
        throw new CdnUploadError(`CDN 上传客户端错误 ${status}：${detail}`, status);
      }
      if (status !== 200) {
        const detail = response.headers.get('x-error-message') ?? `status ${status}`;
        await discardBody(response);
        lastError = new CdnUploadError(`CDN 上传服务端错误：${detail}`, status);
        continue;
      }
      const param = response.headers.get('x-encrypted-param');
      await discardBody(response);
      if (param === null || param === '') {
        lastError = new CdnUploadError('CDN 上传响应缺少 x-encrypted-param 头', status);
        continue;
      }
      return param;
    } catch (error) {
      if (error instanceof CdnUploadError) {
        if (error.status !== undefined && error.status >= 400 && error.status < 500) throw error;
        lastError = error;
        continue;
      }
      lastError = new CdnUploadError(`CDN 上传失败：${(error as Error)?.message ?? '未知'}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new CdnUploadError('CDN 上传失败');
}

/** 把一张图片上传到 CDN，返回发消息要用的引用。 */
export async function uploadImage(
  api: Pick<ILinkApi, 'getUploadUrl'>,
  params: { data: Buffer; toUserId: string },
  options: UploadImageOptions,
): Promise<UploadedMedia> {
  const raw = params.data;
  const rawMd5 = md5Hex(raw);
  const ciphertextSize = aesEcbPaddedSize(raw.length);
  const filekey = randomHexKey();
  const aesKeyHex = randomHexKey();
  const response = await api.getUploadUrl({
    filekey,
    media_type: UPLOAD_MEDIA_TYPE_IMAGE,
    to_user_id: params.toUserId,
    rawsize: raw.length,
    rawfilemd5: rawMd5,
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aesKeyHex,
  });
  const full = response.uploadFullUrl?.trim();
  const url = full !== undefined && full !== '' ? full : buildUploadUrl(options.cdnBaseUrl, response.uploadParam ?? '', filekey);
  if (!isAllowedUploadUrl(url)) throw new CdnUploadError(`上传地址不在微信域名内：${safeHostname(url)}`);
  const ciphertext = encryptAesEcb(raw, Buffer.from(aesKeyHex, 'hex'));
  const encryptQueryParam = await postCiphertext(url, ciphertext, options);
  return { encryptQueryParam, aesKeyHex, ciphertextSize, rawMd5 };
}
