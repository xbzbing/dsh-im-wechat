/**
 * 文本发送与失败分类。
 *
 * 协议侧的两个硬事实：
 * 1. `context_token` 必须回传主人最近一条消息带来的那一个；没有就**不发**——
 *    官方实现明确拒绝发送，因为服务端会静默丢弃（既没送达也没有可诊断的错误）。
 * 2. `sendmessage` 的业务失败是 `ret`/`errcode` 非 0，`ret=-2` 最常见的原因就是
 *    `context_token` 过期（主人长时间没说话）。
 *
 * 回执映射按 `my-superagent/v1` 的语义：能确定没送出去的才回 `failed`（核心会重试），
 * 结果未知的回 `uncertain`（核心不重发，避免重复打扰）。
 */

import { randomUUID } from 'node:crypto';

import { ILinkError } from './api.ts';
import type { ILinkApi } from './api.ts';
import { MessageItemType, MessageState, MessageType } from './types.ts';

/**
 * 发送失败的分类。取值与 `my-superagent/v1` 的 `Receipt.errorCode` 一致，
 * 但类型留在协议层这边：`ilink/` 不该知道超级助理的存在（AGENTS.md 的依赖方向）。
 */
export type SendErrorCode = 'window-closed' | 'rate-limited' | 'auth-expired' | 'too-long' | 'other';

/** 发送前的本地失败：协议层不该发、或发了也不会被接受。 */
export class SendError extends Error {
  readonly code: SendErrorCode;

  constructor(code: SendErrorCode, message: string) {
    super(message);
    this.name = 'SendError';
    this.code = code;
  }
}

export interface SendTextParams {
  /** 收件人的 iLink 用户 id（主人）。 */
  to: string;
  text: string;
  /** 主人最近一条消息带回来的令牌。 */
  contextToken: string | undefined;
  runId?: string;
  clientId?: string;
  timeoutMs?: number;
}

/** 单条消息的字符上限由桥上层的 `maxText` 保证，这里只兜住明显超限的异常。 */
export const HARD_TEXT_LIMIT = 4_000;

function newClientId(): string {
  return `dsh-im-wechat:${randomUUID()}`;
}

/**
 * 发一条文本。
 *
 * 返回 `clientId`：它是这条消息在协议里的客户端标识，也是 `bridgeMessageId`。
 */
export async function sendText(api: ILinkApi, params: SendTextParams): Promise<{ clientId: string }> {
  const contextToken = (params.contextToken ?? '').trim();
  if (contextToken === '') {
    throw new SendError('window-closed', '缺少 context_token：主人最近没有发过消息');
  }
  if (params.to.trim() === '') {
    throw new SendError('other', '缺少收件人');
  }
  // 与 splitText 同单位：默认按 UTF-8 字节，分条后每片都不超上限；
  // maxText=4000 时每个分片都可能「超限」，回执永远 failed 且重试无解。
  if (Array.from(params.text).length > HARD_TEXT_LIMIT) {
    throw new SendError('too-long', `文本超过 ${HARD_TEXT_LIMIT} 字符`);
  }
  const clientId = params.clientId ?? newClientId();
  await api.sendMessage(
    {
      from_user_id: '',
      to_user_id: params.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: params.text === '' ? undefined : [{ type: MessageItemType.TEXT, text_item: { text: params.text } }],
      context_token: contextToken,
      ...(params.runId ? { run_id: params.runId } : {}),
    },
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {},
  );
  return { clientId };
}

export interface SendImageParams {
  to: string;
  /** 上传后的 CDN 引用（`upload.ts` 的 `UploadedMedia`）。 */
  upload: { encryptQueryParam: string; aesKeyHex: string; ciphertextSize: number };
  contextToken: string | undefined;
  runId?: string;
  clientId?: string;
  timeoutMs?: number;
}

/**
 * 发一条图片（ADR-0010）。
 *
 * `image_item` 只放 `media`（下载参数 + base64 的十六进制密钥 + `encrypt_type`）与
 * `mid_size`（密文大小），就这三样。多带的字段客户端会当真：顶层 `aeskey` 是原始十六进制，
 * 客户端按它解密就得到一坨乱码，现象是聊天里一个灰块，而不是任何报错；
 * `media.encrypt_type` 缺省时客户端不按「带缩略图元数据」解，同样渲染不出来。
 */
export async function sendImage(api: ILinkApi, params: SendImageParams): Promise<{ clientId: string }> {
  const contextToken = (params.contextToken ?? '').trim();
  if (contextToken === '') {
    throw new SendError('window-closed', '缺少 context_token：主人最近没有发过消息');
  }
  if (params.to.trim() === '') throw new SendError('other', '缺少收件人');
  const clientId = params.clientId ?? newClientId();
  await api.sendMessage(
    {
      from_user_id: '',
      to_user_id: params.to,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: [{
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: params.upload.encryptQueryParam,
            aes_key: Buffer.from(params.upload.aesKeyHex, 'ascii').toString('base64'),
            encrypt_type: 1,
          },
          mid_size: params.upload.ciphertextSize,
        },
      }],
      context_token: contextToken,
      ...(params.runId ? { run_id: params.runId } : {}),
    },
    params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {},
  );
  return { clientId };
}

export interface SendFailure {
  code: SendErrorCode;
  /** `failed`：确定没送达，核心会重试；`uncertain`：结果未知，核心不重发。 */
  certainty: 'failed' | 'uncertain';
  message: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

/** 把发送失败翻译成回执字段。 */
export function classifySendFailure(error: unknown): SendFailure {
  if (error instanceof SendError) {
    return { code: error.code, certainty: 'failed', message: error.message };
  }
  if (error instanceof ILinkError) {
    if (error.kind === 'timeout') {
      // 客户端超时时请求可能已经到了服务端。
      return { code: 'other', certainty: 'uncertain', message: error.message };
    }
    if (error.kind === 'network') {
      // DNS 解析失败一定没发出去；其余（连接中断等）无法判断，按未知处理。
      const certainty = error.reason === 'dns' ? 'failed' : 'uncertain';
      return { code: 'other', certainty, message: error.message };
    }
    if (error.kind === 'http') {
      if (error.status === 401 || error.status === 403) {
        return { code: 'auth-expired', certainty: 'failed', message: error.message };
      }
      if (error.status === 429) {
        return { code: 'rate-limited', certainty: 'failed', message: error.message };
      }
      return { code: 'other', certainty: 'failed', message: error.message };
    }
    if (error.ret === -14 || error.errcode === -14) {
      return { code: 'auth-expired', certainty: 'failed', message: error.message };
    }
    if (error.ret === -2) {
      return { code: 'window-closed', certainty: 'failed', message: error.message };
    }
    return { code: 'other', certainty: 'failed', message: error.message };
  }
  return { code: 'other', certainty: 'failed', message: messageOf(error) };
}
