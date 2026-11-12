/**
 * `my-superagent/v1` 协议里桥用到的形状。
 *
 * 只按结构描述，不 import `dsh-my-superagent` 的包：服务在运行期经 Cordis 注入，
 * 对象结构满足即可，插件保持零运行时依赖（ADR-0001）。字段与核心
 * `docs/design/03-协议与扩展点.md` 第 3 节一致。
 */

import type { ImageMediaType } from '../../shared/media.ts';

export const PROTOCOL_V1 = 'my-superagent/v1';

/** 核心声明它时才会接受 `OwnerMessageDraft.images`（ADR-0004）。 */
export const FEATURE_OWNER_IMAGES = 'owner-images';
/** 核心声明它时才提供 `BridgeHandle.isOwner`，桥据此只为主人下载图片。 */
export const FEATURE_OWNER_LOOKUP = 'owner-lookup';

/** 与核心 Schema 一致：最多 9 张。 */
export const OWNER_IMAGES_MAX = 9;
/** 与核心 Schema 一致：单张 base64 不超过 14,000,000 字符。 */
export const OWNER_IMAGE_DATA_MAX = 14_000_000;
/** 与核心 Schema 一致：文件名不超过 200 字。 */
export const OWNER_IMAGE_NAME_MAX = 200;

export interface InteractionOption {
  readonly label: string;
  readonly description?: string;
}

export interface InteractionQuestion {
  readonly id: string;
  readonly question: string;
  readonly detail?: string;
  readonly header?: string;
  readonly options?: readonly InteractionOption[];
  readonly multiSelect?: boolean;
  readonly intent?: 'plan-review' | 'approval';
}

export interface InteractionAnswerItem {
  readonly id: string;
  readonly selected: string[];
  readonly custom?: string;
}

export interface Interaction {
  readonly questions: readonly InteractionQuestion[];
  readonly suggested?: readonly InteractionAnswerItem[];
  readonly rationale?: string;
}

export interface DeliveryStream {
  readonly id: string;
  readonly revision: number;
  readonly final: boolean;
}

export interface Delivery {
  readonly protocol: string;
  readonly id: string;
  readonly recipient: string;
  readonly intent: 'action' | 'confirm' | 'result' | 'progress' | 'digest';
  readonly title: string;
  readonly body: string;
  readonly detail?: string;
  readonly interaction?: Interaction;
  readonly refs?: readonly unknown[];
  readonly expiresAt?: number;
  readonly supersedes?: string;
  readonly stream?: DeliveryStream;
  readonly inReplyTo?: string;
  /** 出站图片（核心 ADR-0067）：桥在 capabilities.outbound.images 里声明能收，核心才会发。 */
  readonly images?: readonly DeliveryImage[];
}

/** 与核心 Schema 一致：最多 4 张，单张 base64 不超过 14,000,000 字符。 */
export const DELIVERY_IMAGES_MAX = 4;

export interface DeliveryImage {
  readonly mediaType: ImageMediaType;
  readonly data: string;
  readonly name?: string;
}

export type ReceiptErrorCode = 'window-closed' | 'rate-limited' | 'auth-expired' | 'too-long' | 'other';

export interface Receipt {
  deliveryId: string;
  status: 'sent' | 'failed' | 'uncertain';
  bridgeMessageId?: string;
  // 这条交付实际占用了平台多少条主动消息（分条发送时大于 1）：核心据此算窗口内的条数额度。
  messagesSent?: number;
  error?: string;
  errorCode?: ReceiptErrorCode;
}

export interface BridgeCapabilities {
  markdown: 'none' | 'basic' | 'full';
  maxText: { max: number; unit: 'char' | 'utf8-byte' };
  interaction?: {
    choice: boolean;
    multiChoice: boolean;
    freeText: boolean;
    maxOptions: number;
    maxQuestions: number;
    updateAfterAnswer: 'any' | 'immediate' | 'none';
  };
  edit?: { scope: 'any' | 'reply'; minIntervalMs: number; maxLifetimeMs?: number };
  detail: boolean;
  nativeCommands: boolean;
  quotas?: { scope: 'bot' | 'conversation'; max: number; windowMs: number }[];
  outbound: { requiresPriorInbound: boolean; windowMs?: number; maxMessagesPerWindow?: number; images?: boolean };
}

export interface BridgeHealth {
  state: 'ok' | 'degraded' | 'down';
  code?: 'auth-expired' | 'kicked' | 'rate-limited' | 'network' | 'other';
  reason?: string;
}

export interface BridgeProvider {
  readonly platform: string;
  readonly account: string;
  readonly protocol: readonly string[];
  readonly capabilities: BridgeCapabilities;
  deliver(delivery: Delivery): Promise<Receipt>;
  health(): BridgeHealth;
}

export interface OwnerImage {
  mediaType: ImageMediaType;
  /** 规范 base64（带填充，长度为 4 的倍数）。 */
  data: string;
  name?: string;
}

export interface OwnerMessageDraft {
  messageId: string;
  sender: string;
  /** 有图时可以是空串。 */
  text: string;
  at: number;
  replyTo?: string;
  /** 只在核心声明 `owner-images` 时携带。 */
  images?: OwnerImage[];
}

export interface InteractionAnswerDraft {
  deliveryId: string;
  sender: string;
  answers: InteractionAnswerItem[];
  at: number;
}

/** 核心 `receive` / `answer` 的拒绝原因。 */
export const REJECT_REASONS = Object.freeze([
  'invalid',
  'not-owner',
  'unknown',
  'settled',
  'expired',
  'wrong-bridge',
  'not-delivered',
  'not-allowed',
  'invalid-answer',
] as const);

export type RejectReason = (typeof REJECT_REASONS)[number];

export type AcceptResult =
  | { accepted: true }
  | { accepted: false; reason: RejectReason; detail?: string };

export interface CommandInfo {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
}

export interface BridgeHandle {
  readonly id: string;
  readonly protocol: string;
  receive(message: OwnerMessageDraft): Promise<AcceptResult>;
  answer(answer: InteractionAnswerDraft): Promise<AcceptResult>;
  update(capabilities: BridgeCapabilities): void;
  commands(): readonly CommandInfo[];
  isOwner?(sender: string): boolean;
  dispose(): void;
}

/** 核心以 Cordis 服务 `mySuperagent` 提供的注册表。 */
export interface MySuperagentService {
  readonly protocol?: { readonly versions?: readonly string[]; readonly features?: readonly string[] };
  readonly bridges: { register(provider: BridgeProvider): BridgeHandle };
}
