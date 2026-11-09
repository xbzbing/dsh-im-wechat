/**
 * iLink 协议的线上形状。
 *
 * 出处：腾讯官方 `openclaw-weixin` 3.0.0-beta-0（MIT）里的 proto 映射（`GetUpdatesReq/Resp`、
 * `WeixinMessage`、`SendMessageReq`）与 JSON-over-HTTP 约定：字节字段在 JSON 里是
 * base64 字符串。这里只按形状描述，不含任何官方实现代码；端点与请求头见 `api.ts`。
 *
 * 两个容易踩的点：
 * - `message_id` / `msg_id` 是 64 位整数，超出 `Number.MAX_SAFE_INTEGER` 时会被 JSON
 *   解析静默取整，两条不同的消息会撞成同一个 id（见 `json.ts`）；
 * - 数值字段（`type` 等）在协议里是 proto 枚举，官方实现用常量表表达，这里同样用
 *   `as const` 表——`erasableSyntaxOnly` 下不能用 enum。
 */

/** proto: MessageType */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** proto: MessageItemType */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** proto: MessageState */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

/** 每条请求都带的客户端信息。 */
export interface BaseInfo {
  channel_version: string;
  bot_agent: string;
}

/** CDN 媒体引用：密文参数、密钥与（可选的）直链。 */
export interface CdnMedia {
  encrypt_query_param?: string;
  /** 两种编码都见过：base64(16 字节裸密钥) 或 base64(32 个十六进制字符)。 */
  aes_key?: string;
  encrypt_type?: number;
  /** 部分帧直接给可下载直链。 */
  full_url?: string;
}

export interface TextItem {
  text?: string;
}

export interface RefMessage {
  title?: string;
  message_item?: WeixinItem;
}

export interface ImageItem {
  media?: CdnMedia;
  /** 密文大小。 */
  mid_size?: number;
  /** 十六进制密钥，存在时优先于 `media.aes_key`。 */
  aeskey?: string;
  thumb_media?: CdnMedia;
}

export interface VoiceItem {
  media?: CdnMedia;
  /** 语音转文字结果。 */
  text?: string;
}

export interface FileItem {
  media?: CdnMedia;
  file_name?: string;
  len?: string;
}

export interface VideoItem {
  media?: CdnMedia;
  video_size?: number;
}

/** 一条消息里的一个内容块（文本、图片、语音……）。 */
export interface WeixinItem {
  type?: number;
  msg_id?: string | number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}

/** 入站消息（getUpdates 的 `msgs[]`）。 */
export interface WeixinMessage {
  message_id?: string | number;
  client_id?: string;
  seq?: number;
  create_time_ms?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  message_type?: number;
  message_state?: number;
  run_id?: string;
  item_list?: WeixinItem[];
}

/** `ilink/bot/getupdates` 的响应。 */
export interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  /** 长轮询游标，原样回传。 */
  get_updates_buf?: string;
  /** 服务端建议的下一次长轮询超时。 */
  longpolling_timeout_ms?: number;
}

/** 出站消息体（`ilink/bot/sendmessage` 的 `msg`）。 */
export interface OutboundMessage {
  from_user_id: string;
  to_user_id: string;
  client_id: string;
  message_type: number;
  message_state: number;
  item_list?: WeixinItem[];
  /** 主人最近一条消息带回来的令牌；没有它就发不出去（ADR-0002）。 */
  context_token?: string;
  run_id?: string;
}

/** `ilink/bot/get_bot_qrcode` 的响应。 */
export interface QrCodeResponse {
  /** 轮询状态用的标识。 */
  qrcode?: string;
  /** 二维码要编码的内容，同时是一个可打开的链接。 */
  qrcode_img_content?: string;
}

/** `ilink/bot/get_qrcode_status` 的响应。 */
export interface QrStatusResponse {
  status?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  /** 登录后应使用的 API 域名。 */
  baseurl?: string;
  /** `scaned_but_redirect` 时给出的轮询域名。 */
  redirect_host?: string;
}

/** `ilink/bot/getconfig` 的响应。 */
export interface GetConfigResponse {
  ret?: number;
  errcode?: number;
  typing_ticket?: string;
}

/** `sendtyping` 的状态：1=正在输入，2=取消（官方 TypingStatus）。 */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

/** 协议里的通用应答（`ret` / `errcode` 非 0 即失败）。 */
export interface GenericResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}
