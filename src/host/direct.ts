/**
 * 独立模式的直连会话（ADR-0009）：未接入超级助理时，微信消息直接落到一个 DSH 会话。
 *
 * 与接入核心时的分工：
 * - 接入核心：核心做主人判定、命令解析、选模型与派发，本插件只呈现与转发；
 * - 独立模式：插件自己把消息提交给绑定的会话，再把这一轮的回复发回微信。接入核心后
 *   这条链路整体沉默（ADR-0006 的同一套判据：`ownFeaturesActive`），不会两边都回话。
 *
 * 会话选择只有一条规则：**第一次发消息时按所选工作区新建，之后一直用它**。
 * 工作区由 `workspaceId` 决定（默认是自动创建的「微信会话」，ADR-0018；为空只在
 * 默认工作区建不出来时出现，表示宿主默认位置），绑定落在 `direct.json`，重启沿用。
 * 文字、图片与文件都交给会话：图片由本插件按 ADR-0004 的边界下载解密，作为 base64
 * 附件 part 交给宿主（ADR-0017）；文件换一条路——先由宿主 `fileUploads` 在同一个会话下
 * 暂存，再把换回来的回执作为 part 提交（ADR-0028）。
 */

import { randomUUID } from 'node:crypto';

import { textFromAssistantMessage } from './long-tasks.ts';
import { messageOf } from './host-context.ts';
import { textContent, withAttachmentHint } from './prompt-parts.ts';
import type { PromptPart } from './prompt-parts.ts';
import { NO_FILES } from './inbound.ts';
import type { InboundFiles } from './inbound.ts';
import { attachmentKind, droppedNotice, fileDropNotice, onlyRejected, unsentFiles, uploadOwnerFiles, withDropped } from './direct-files.ts';
import type { DroppedKind, HostFileUploader } from './direct-files.ts';
import type { DirectBinding, DirectBindingStore } from './state/direct-binding.ts';
import { MAX_TEXT_BYTES, toWeChatMarkdown } from './superagent/render.ts';
import { ReplyMeter, composeReplyParts, formatReplyStatus } from './reply-status.ts';
import type { ReplyStatusParts } from './reply-status.ts';

export type { HostFileUploader } from './direct-files.ts';

/** 提交方式：与 DSH 的 `InputSubmitMode` 同一套取值。 */
export type BusyMode = 'queue' | 'steer';

/** 宿主会话列表的一行（`sessionController.list` 的摘要，只取本插件用到的字段）。 */
export interface HostSessionRow {
  sessionId?: unknown;
  running?: unknown;
  updatedAt?: unknown;
  cwd?: unknown;
  blank?: unknown;
  origin?: unknown;
  parentSessionId?: unknown;
  /** 投影汇总：标题在 `projections.values.title`（宿主 `dsh-session-title`）。 */
  projections?: { values?: Record<string, unknown> } | null;
}

/** 宿主 `sessionController` 里本模块用到的那几个方法（结构类型，不 import 宿主包）。 */
export interface DirectController {
  create(request: { workspaceId?: string }): Promise<{ sessionId: string }>;
  prompt(
    request: { requestId: string; sessionId: string; mode: BusyMode; content: readonly PromptPart[]; clientTimeZone?: string },
    signal: AbortSignal,
  ): Promise<{ accepted?: boolean }>;
  rename?(request: { sessionId: string; title: string }): Promise<unknown>;
  list?(
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ items?: readonly HostSessionRow[] }>;
  /** 读宿主的模型目录（面板下拉与模型校验用；老宿主没有这个方法）。 */
  modelCatalog?(): Promise<unknown>;
  /** 取消会话当前回合（`/stop`；宿主没有这个方法时命令说「不支持」）。 */
  cancel?(request: { sessionId: string }): { accepted?: boolean } | Promise<{ accepted?: boolean }>;
}

export interface DirectLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface DirectChatOptions {
  /** 取宿主会话控制器；没有注入时返回 null（组合里没有 sessionController）。 */
  controller: () => DirectController | null;
  store: DirectBindingStore;
  /** 会话要加入的工作区 id；空表示默认工作区建不出来，退回宿主默认位置。 */
  workspaceId: () => string;
  /** 配置：回合在跑时再来一条消息的提交方式。 */
  busyMode: () => BusyMode;
  /** 发回微信（走主人的收件通道）；返回是否发出。 */
  send: (text: string) => Promise<boolean>;
  /** 发送者是不是已确认的主人（扫码登录的那个微信用户）。 */
  isOwner: (sender: string) => boolean;
  /** 是否在回复末尾附加模型、推理等级、消耗与时间（独立模式专用，面板开关）。 */
  replyStatus?: () => boolean;
  /** 建会话用的标题后缀（主人账号尾号）。 */
  ownerLabel: () => string;
  /**
   * 提交前钉上配置的模型（ADR-0025）：新建会话与已绑定的会话都走这条，必须在
   * `prompt` 之前——宿主按会话记着的选择决定这一轮用哪个模型。同一个会话同一个值
   * 只钉一次（幂等交给回调实现）。回调不抛错。
   */
  applyModel?: (sessionId: string) => void;
  logger?: DirectLogger;
  now?: () => number;
  maxText?: number;
  /**
   * 提交超时：只保证「受理前不再排队」——宿主开始处理后的解码/归一化不会再中断，
   * 所以这不是整条消息的硬上限（宿主只在自己的受理点前看这个 signal）。
   */
  submitTimeoutMs?: number;
}

export type SubmitResult = 'ignored' | 'unavailable' | 'queued' | 'steered' | 'failed';

const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
const QUEUE_NOTICE = '已交给会话，这一轮结束后把回答发给你。';
const STEER_NOTICE = '已插进正在跑的这一轮，本轮回答仍由原回合送回。';
/**
 * 连续插话的提示间隔：两条消息挨得太近（小于这个间隔）时不重复提示。
 *
 * 主人连发几条补充说明时，每条都回一句「已插进本轮」会刷屏；只有隔了一会儿、
 * 前一轮还在思考时才值得确认一次。
 */
export const STEER_NOTICE_MIN_GAP_MS = 30_000;
/**
 * 提交在我们自己的超时预算内没拿到回执。
 *
 * 宿主可能已经受理，只是回执没回来；不能说“没交出去”诱导主人重发，也不该把
 * 英文 DOMException 原文发到微信。先让主人别重复发送，回合真跑完时回答仍会送回。
 */
const SUBMIT_TIMEOUT_NOTICE = '提交超时，可能已经进入会话；先别重复发送，回答会照常发给你。';
/** 文件暂存吃满了提交预算：这条消息根本没提交，措辞不能沿用上面那句。 */
const UPLOAD_TIMEOUT_NOTICE = '附件暂存超时，这条消息没有提交，请重发一次。';

export class DirectChat {
  readonly #controller: () => DirectController | null;
  readonly #store: DirectBindingStore;
  readonly #workspaceId: () => string;
  readonly #busyMode: () => BusyMode;
  readonly #send: (text: string) => Promise<boolean>;
  readonly #isOwner: (sender: string) => boolean;
  readonly #replyStatus: () => boolean;
  readonly #meter = new ReplyMeter();
  readonly #ownerLabel: () => string;
  readonly #applyModel: ((sessionId: string) => void) | undefined;
  readonly #logger: DirectLogger | undefined;
  readonly #now: () => number;
  readonly #maxText: number;
  readonly #submitTimeoutMs: number;
  /** 绑定会话是否有一轮在跑（来自 turn/start、turn/end 事件）。 */
  #running = false;
  /** 本轮的可见回答（同一个回合里有多条 assistant 消息时取最后一条）。 */
  #answer = '';
  /** 建会话进行中，避免连发两条建出两个会话。 */
  #creating: Promise<string> | null = null;
  /** 上一次受理成功的时间（任意提交方式），用来决定插话提示要不要发。 */
  #lastSubmitAt = 0;
  /** 宿主 `fileUploads` 服务；没接入时文件收得下但进不了会话（会给一句提示）。 */
  #uploader: HostFileUploader | null = null;

  constructor(options: DirectChatOptions) {
    this.#controller = options.controller;
    this.#store = options.store;
    this.#workspaceId = options.workspaceId;
    this.#busyMode = options.busyMode;
    this.#send = options.send;
    this.#isOwner = options.isOwner;
    this.#replyStatus = options.replyStatus ?? (() => false);
    this.#ownerLabel = options.ownerLabel;
    this.#applyModel = options.applyModel;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#maxText = options.maxText ?? MAX_TEXT_BYTES;
    this.#submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  }

  /** 面板展示用：绑定情况与运行态。 */
  status(): {
    bound: boolean;
    sessionId?: string;
    workspaceId: string;
    busyMode: BusyMode;
    running: boolean;
    available: boolean;
    replyStatus: boolean;
  } {
    const binding = this.#store.get();
    return {
      bound: binding !== null,
      ...(binding ? { sessionId: binding.sessionId } : {}),
      workspaceId: binding?.workspaceId ?? this.#workspaceId(),
      busyMode: this.#busyMode(),
      running: this.#running,
      available: this.#controller() !== null,
      replyStatus: this.#replyStatus(),
    };
  }

  /** `fileUploads` 服务接入（index.ts 的可选注入）：入站文件先暂存、再换成回执提交。 */
  attachUploader(uploader: HostFileUploader | null): void {
    this.#uploader = uploader;
  }

  /** 丢掉绑定，下次发消息重新按工作区建会话。 */
  async reset(): Promise<void> {
    this.#running = false;
    this.#answer = '';
    await this.#store.clear();
  }

  /**
   * 入站消息：只有主人、且宿主提供会话控制器时才接手。
   *
   * `content` 是文字与图片 part 组成的消息（ADR-0017），由 `buildPromptContent` 组装；
   * `files` 是已经下载解密、还没交给宿主暂存的文件（ADR-0028）。空白内容直接丢弃，不建
   * 会话；一个文件都没收下、又没有别的可交付内容时只回一句原因，同样不建会话。
   */
  async submit(
    sender: string,
    content: readonly PromptPart[],
    files: InboundFiles = NO_FILES,
  ): Promise<SubmitResult> {
    if (!this.#isOwner(sender)) return 'ignored';
    // 没有可提交的东西（只有没收下的文件，或只有文件而宿主没有上传服务）：不建会话，
    // 只回一句原因——文件不像图片可以静默少一张。
    if (content.length === 0 && (files.files.length === 0 || this.#uploader === null)) {
      const dropped = [...files.dropped, ...unsentFiles(files.files, this.#logger)];
      if (dropped.length > 0) await this.#send(fileDropNotice(dropped));
      return 'ignored';
    }
    const controller = this.#controller();
    if (!controller) return 'unavailable';
    let sessionId: string;
    try {
      sessionId = await this.#ensureSession(controller);
    } catch (error) {
      this.#logger?.warn?.('独立模式建会话失败', messageOf(error));
      await this.#send(`没能建会话：${messageOf(error)}`);
      return 'failed';
    }
    // 已绑定的会话可能还没被宿主 resume（重启后第一次发消息）：提交前补钉一次模型。
    this.#applyModel?.(sessionId);
    const busy = await this.#isBusy(controller, sessionId);
    const mode: BusyMode = busy && this.#busyMode() === 'steer' ? 'steer' : 'queue';
    const requestId = randomUUID();
    // 一次入站只给一个提交预算：暂存、提交与被拒后的重发共用同一个 signal。
    const signal = AbortSignal.timeout(this.#submitTimeoutMs);
    // 文件必须等到会话 id 才能暂存：回执只对这一个会话有效（ADR-0028）。
    const uploaded = await uploadOwnerFiles({
      uploader: this.#uploader,
      sessionId,
      files: files.files,
      signal,
      ...(this.#logger ? { logger: this.#logger } : {}),
    });
    const dropped = [...files.dropped, ...uploaded.dropped];
    if (dropped.length > 0) await this.#send(fileDropNotice(dropped));
    // 暂存吃满提交预算时还没提交：这句不能说成「可能已经进入会话」。
    if (signal.aborted) {
      if (files.files.length > 0 && isSubmitTimeout(signal, undefined)) await this.#send(UPLOAD_TIMEOUT_NOTICE);
      return 'failed';
    }
    // 补提示只影响真正提交的那一份：重发判定要的是主人自己写的文字（`textContent`）。
    const parts = [...content, ...uploaded.parts];
    if (parts.length === 0) return 'ignored';
    let droppedAtSubmit: DroppedKind | null = null;
    try {
      await this.#submitTo(controller, { requestId, sessionId, mode, content: withAttachmentHint(parts) }, signal);
    } catch (error) {
      const kind = attachmentKind(parts);
      if (!(await this.#retryTextOnly(controller, { requestId, sessionId, mode }, parts, signal, error))) {
        return 'failed';
      }
      droppedAtSubmit = kind;
    }
    const submittedAt = this.#now();
    const gap = submittedAt - this.#lastSubmitAt;
    this.#lastSubmitAt = submittedAt;
    if (mode === 'steer') {
      // 连发：间隔太短就不回执，只在「隔了一会儿仍在思考」时才确认一次。
      // 第一次提交没有上一条可比，按「隔了很久」处理：会话是重启前就在跑的。
      // 附件被丢掉是另一回事：这条必须告诉主人，不能跟着回执一起省掉。
      if (droppedAtSubmit !== null || gap >= STEER_NOTICE_MIN_GAP_MS || gap < 0) {
        await this.#send(withDropped(STEER_NOTICE, droppedAtSubmit));
      }
      return 'steered';
    }
    // 排队的回合开跑前宿主可能还在处理上一条，提示只在「当前确实在跑」时给，
    // 平淡的一句排队提示会变成每条消息都多一条噪音。
    if (busy) await this.#send(withDropped(QUEUE_NOTICE, droppedAtSubmit));
    else if (droppedAtSubmit !== null) await this.#send(droppedNotice(droppedAtSubmit));
    return 'queued';
  }

  /** `session/event`：跟踪运行态并攒回答。 */
  handleEvent(sessionId: string, event: unknown): void {
    const binding = this.#store.get();
    if (!binding || binding.sessionId !== sessionId) return;
    if (event === null || typeof event !== 'object') return;
    const entry = event as { type?: unknown; data?: unknown };
    const data = (entry.data !== null && typeof entry.data === 'object' ? entry.data : {}) as Record<string, unknown>;
    switch (entry.type) {
      case 'session/title': {
        // 标题会随 Web 端改名而变：面板显示完整会话名，不要停在建会话时那一版。
        const title = typeof data.title === 'string' ? data.title : '';
        if (title.trim() !== '') {
          void this.#store.setTitle(title).catch((error: unknown) => {
            this.#logger?.warn?.('独立模式会话标题落盘失败', messageOf(error));
          });
        }
        return;
      }
      case 'turn/start':
        this.#running = true;
        this.#answer = '';
        this.#meter.startTurn();
        return;
      // 选择事件只在变化时来：推理等级跨回合沿用，新选择没有等级时清掉旧值。
      case 'model/selection':
        this.#meter.observeSelection(data);
        return;
      case 'assistant/message': {
        const text = textFromAssistantMessage(data.message);
        if (text.trim() !== '') this.#answer = text;
        this.#meter.observeAssistant(data);
        return;
      }
      // 失败/被重试的那次调用不落消息，但 token 真的产生了：口径见 reply-status.ts。
      case 'assistant/attempt':
        this.#meter.observeAttempt(data);
        return;
      case 'turn/end': {
        this.#running = false;
        const answer = this.#answer.trim();
        this.#answer = '';
        const stats = this.#meter.take();
        if (answer !== '') void this.#reply(answer, stats);
        return;
      }
      default:
        return;
    }
  }

  async #reply(answer: string, stats: ReplyStatusParts): Promise<void> {
    const footer = this.#replyStatus() ? formatReplyStatus(stats, this.#now()) : undefined;
    for (const part of composeReplyParts(toWeChatMarkdown(answer), this.#maxText, footer)) {
      const ok = await this.#send(part).catch((error: unknown) => {
        this.#logger?.warn?.('独立模式回复发送失败', messageOf(error));
        return false;
      });
      if (!ok) {
        this.#logger?.warn?.('独立模式回复没有发出去');
        return;
      }
    }
  }

  /** 取绑定会话；没有就按配置的工作区新建一个。 */
  async #ensureSession(controller: DirectController): Promise<string> {
    const existing = this.#store.get();
    if (existing) return existing.sessionId;
    if (this.#creating) return this.#creating;
    const task = (async () => {
      const workspaceId = this.#workspaceId().trim();
      const created = await controller.create(workspaceId === '' ? {} : { workspaceId });
      const sessionId = created.sessionId;
      const title = `微信 · ${this.#ownerLabel()}`.trim();
      await this.#store.set(sessionId, workspaceId, title);
      await controller.rename?.({ sessionId, title }).catch((error: unknown) => {
        this.#logger?.warn?.('独立模式会话改名失败', messageOf(error));
      });
      this.#logger?.info?.(`独立模式已绑定会话 ${sessionId}`);
      return sessionId;
    })();
    this.#creating = task;
    try {
      return await task;
    } finally {
      this.#creating = null;
    }
  }

  /** 会话是否有一轮在跑：优先问宿主（能覆盖 Web 端发起的回合），问不到就用事件推出来的状态。 */
  async #isBusy(controller: DirectController, sessionId: string): Promise<boolean> {
    if (!controller.list) return this.#running;
    try {
      const value = await controller.list({}, AbortSignal.timeout(3_000));
      const item = value.items?.find((row) => row.sessionId === sessionId);
      if (item && typeof item.running === 'boolean') {
        this.#running = item.running;
        return item.running;
      }
    } catch (error) {
      this.#logger?.warn?.('读取会话运行态失败，退回事件推断', messageOf(error));
    }
    return this.#running;
  }

  async #submitTo(
    controller: DirectController,
    request: { requestId: string; sessionId: string; mode: BusyMode; content: readonly PromptPart[] },
    signal: AbortSignal,
  ): Promise<void> {
    const result = await controller.prompt(
      { ...request, clientTimeZone: clientTimeZone() },
      signal,
    );
    if (result.accepted !== true) throw new Error('会话没有接受这条消息');
    // 记一笔：宿主事件一定会来，但在它来之前再发一条消息时，busy 判定不会漏。
    if (request.mode === 'queue') this.#running = true;
  }

  /**
   * 提交被明确拒收时，去掉附件用**同一个 requestId** 重发一次纯文字。
   *
   * 宿主按 requestId 去重（同一条请求再提交直接回 `accepted`，不会重复入队），所以重发
   * 不会让主人收到两遍；拒收发生在建用户消息之前，图片超限、模型不支持看图、文件回执
   * 失效都落到这里。
   *
   * 三种情况不重试、照旧报错：没有附件（与改动前一致）、没有真实文字（只剩补的提示，
   * 重发没有意义）、我们自己超时了（宿主可能已经受理，只是回执没回来）。
   */
  async #retryTextOnly(
    controller: DirectController,
    request: { requestId: string; sessionId: string; mode: BusyMode },
    content: readonly PromptPart[],
    signal: AbortSignal,
    error: unknown,
  ): Promise<boolean> {
    const text = textContent(content);
    if (attachmentKind(content) === null || text.trim() === '' || signal.aborted) {
      await this.#reportSubmitFailure(content, error, isSubmitTimeout(signal, error));
      return false;
    }
    try {
      // 沿用原 signal：总预算仍是一次提交的时长，不为重发多等一轮。
      await this.#submitTo(controller, { ...request, content: [{ type: 'text', text }] }, signal);
      return true;
    } catch (retryError) {
      await this.#reportSubmitFailure(content, retryError, isSubmitTimeout(signal, retryError));
      return false;
    }
  }

  async #reportSubmitFailure(content: readonly PromptPart[], error: unknown, timedOut: boolean): Promise<void> {
    const detail = messageOf(error);
    this.#logger?.warn?.('独立模式提交失败', detail);
    if (timedOut) {
      // 宿主可能已经受理：微信侧只说“可能已进入”，不把英文异常原文发出去。
      await this.#send(SUBMIT_TIMEOUT_NOTICE);
      return;
    }
    // 微信那头只发中文：宿主给的是英文技术细节（模型名、限额），留在日志里排障。
    // 连文字都没有才说「附件没发出去」：有文字而只是超时被砍的情况归上一句。
    const kind = attachmentKind(content);
    const attachmentsOnly = kind !== null && textContent(content).trim() === '';
    await this.#send(attachmentsOnly ? onlyRejected(kind) : `没能把消息交给会话：${detail}`);
  }

  /** 状态快照里的时间戳：面板显示「最近一次绑定」。 */
  boundAt(): number | undefined {
    return this.#store.get()?.boundAt ?? undefined;
  }

  /** 当前绑定（给面板展示）。 */
  binding(): DirectBinding | null {
    return this.#store.get();
  }

  /** 现在的时间（测试注入用）。 */
  nowMs(): number {
    return this.#now();
  }
}

/**
 * 这次失败是不是我们自己设的提交预算到期。
 *
 * `AbortSignal.timeout` 到点后 `signal.reason` 是 `TimeoutError`；宿主也可能把这个 reason
 * 当异常抛回来。两者都认，但不把“signal 已中止”一律当超时——调用方传入的 signal 也可能
 * 因停机被中止，那种情况照常报错。
 */
function isSubmitTimeout(signal: AbortSignal, error: unknown): boolean {
  const reasonName = (signal.reason as { name?: unknown } | null | undefined)?.name;
  const errorName = (error as { name?: unknown } | null | undefined)?.name;
  return reasonName === 'TimeoutError' || errorName === 'TimeoutError';
}

/** 提交时带的客户端时区；取不到就不带（宿主自己兜底）。 */
export function clientTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
