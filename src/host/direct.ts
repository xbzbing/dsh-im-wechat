/**
 * 独立模式的直连会话（ADR-0009）：未接入超级助理时，微信消息直接落到一个 DSH 会话。
 *
 * 与接入核心时的分工：
 * - 接入核心：核心做主人判定、命令解析、选模型与派发，本插件只呈现与转发；
 * - 独立模式：插件自己把消息提交给绑定的会话，再把这一轮的回复发回微信。接入核心后
 *   这条链路整体沉默（ADR-0006 的同一套判据：`ownFeaturesActive`），不会两边都回话。
 *
 * 会话选择只有一条规则：**第一次发消息时按配置的工作区新建，之后一直用它**。
 * 工作区是绝对路径（与 dsh-im-infoflow 的独立模式一致），空表示宿主默认位置；绑定
 * 落在 `direct.json`，重启沿用。文字与图片都交给会话：图片由本插件按 ADR-0004 的
 * 边界下载解密，再作为附件 part 交给宿主（ADR-0017）。
 */

import { randomUUID } from 'node:crypto';

import { textFromAssistantMessage } from './long-tasks.ts';
import { messageOf } from './host-context.ts';
import { textContent, withImageHint } from './prompt-parts.ts';
import type { PromptPart } from './prompt-parts.ts';
import type { DirectBinding, DirectBindingStore } from './state/direct-binding.ts';
import { MAX_TEXT_CHARS, splitText, toWeChatMarkdown } from './superagent/render.ts';

/** 提交方式：与 DSH 的 `InputSubmitMode` 同一套取值。 */
export type BusyMode = 'queue' | 'steer';

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
  ): Promise<{ items?: readonly { sessionId?: string; running?: boolean }[] }>;
}

export interface DirectLogger {
  info?(...args: unknown[]): unknown;
  warn?(...args: unknown[]): unknown;
}

export interface DirectChatOptions {
  /** 取宿主会话控制器；没有注入时返回 null（组合里没有 sessionController）。 */
  controller: () => DirectController | null;
  store: DirectBindingStore;
  /** 配置：会话要加入的工作区 id，空表示宿主默认位置。 */
  workspaceId: () => string;
  /** 配置：回合在跑时再来一条消息的提交方式。 */
  busyMode: () => BusyMode;
  /** 发回微信（走主人的收件通道）；返回是否发出。 */
  send: (text: string) => Promise<boolean>;
  /** 发送者是不是已确认的主人（扫码登录的那个微信用户）。 */
  isOwner: (sender: string) => boolean;
  /** 建会话用的标题后缀（主人账号尾号）。 */
  ownerLabel: () => string;
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
const IMAGE_DROPPED_NOTICE = '图片没有发出去（当前会话的模型可能不支持看图），已按文字发送。';
const IMAGE_DROPPED_SUFFIX = '（图片没有发出去，已按文字发送）';
const IMAGE_ONLY_REJECTED = '图片没有发出去：当前会话的模型可能不支持看图，换个模型或改用文字再发一次。';

export class DirectChat {
  readonly #controller: () => DirectController | null;
  readonly #store: DirectBindingStore;
  readonly #workspaceId: () => string;
  readonly #busyMode: () => BusyMode;
  readonly #send: (text: string) => Promise<boolean>;
  readonly #isOwner: (sender: string) => boolean;
  readonly #ownerLabel: () => string;
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

  constructor(options: DirectChatOptions) {
    this.#controller = options.controller;
    this.#store = options.store;
    this.#workspaceId = options.workspaceId;
    this.#busyMode = options.busyMode;
    this.#send = options.send;
    this.#isOwner = options.isOwner;
    this.#ownerLabel = options.ownerLabel;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#maxText = options.maxText ?? MAX_TEXT_CHARS;
    this.#submitTimeoutMs = options.submitTimeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS;
  }

  /** 面板展示用：绑定情况与运行态。 */
  status(): { bound: boolean; sessionId?: string; workspaceId: string; busyMode: BusyMode; running: boolean; available: boolean } {
    const binding = this.#store.get();
    return {
      bound: binding !== null,
      ...(binding ? { sessionId: binding.sessionId } : {}),
      workspaceId: binding?.workspaceId ?? this.#workspaceId(),
      busyMode: this.#busyMode(),
      running: this.#running,
      available: this.#controller() !== null,
    };
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
   * 空白内容直接丢弃，不建会话。
   */
  async submit(sender: string, content: readonly PromptPart[]): Promise<SubmitResult> {
    if (content.length === 0) return 'ignored';
    if (!this.#isOwner(sender)) return 'ignored';
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
    const busy = await this.#isBusy(controller, sessionId);
    const mode: BusyMode = busy && this.#busyMode() === 'steer' ? 'steer' : 'queue';
    const requestId = randomUUID();
    // 一次入站只给一个提交预算：被拒后的重发沿用同一个 signal，不再多等一个超时。
    const signal = AbortSignal.timeout(this.#submitTimeoutMs);
    let imageDropped = false;
    try {
      await this.#submitTo(controller, { requestId, sessionId, mode, content: withImageHint(content) }, signal);
    } catch (error) {
      if (!(await this.#retryTextOnly(controller, { requestId, sessionId, mode }, content, signal, error))) {
        return 'failed';
      }
      imageDropped = true;
    }
    if (mode === 'steer') {
      await this.#send(withImageDropped(STEER_NOTICE, imageDropped));
      return 'steered';
    }
    // 排队的回合开跑前宿主可能还在处理上一条，提示只在「当前确实在跑」时给，
    // 平淡的一句排队提示会变成每条消息都多一条噪音。
    if (busy) await this.#send(withImageDropped(QUEUE_NOTICE, imageDropped));
    else if (imageDropped) await this.#send(IMAGE_DROPPED_NOTICE);
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
      case 'turn/start':
        this.#running = true;
        this.#answer = '';
        return;
      case 'assistant/message': {
        const text = textFromAssistantMessage(data.message);
        if (text.trim() !== '') this.#answer = text;
        return;
      }
      case 'turn/end': {
        this.#running = false;
        const answer = this.#answer.trim();
        this.#answer = '';
        if (answer !== '') void this.#reply(answer);
        return;
      }
      default:
        return;
    }
  }

  async #reply(answer: string): Promise<void> {
    const rendered = toWeChatMarkdown(answer);
    for (const part of splitText(rendered, this.#maxText)) {
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
      await this.#store.set(sessionId, workspaceId);
      const title = `微信 · ${this.#ownerLabel()}`.trim();
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
      { ...request, clientTimeZone: timeZone() },
      signal,
    );
    if (result.accepted !== true) throw new Error('会话没有接受这条消息');
    // 记一笔：宿主事件一定会来，但在它来之前再发一条消息时，busy 判定不会漏。
    if (request.mode === 'queue') this.#running = true;
  }

  /**
   * 提交被明确拒收时，去掉图片用**同一个 requestId** 重发一次纯文字。
   *
   * 宿主按 requestId 去重（同一条请求再提交直接回 `accepted`，不会重复入队），所以重发
   * 不会让主人收到两遍；拒收发生在建用户消息之前，图片超限、模型不支持看图都落到这里。
   *
   * 三种情况不重试、照旧报错：没有图片（与改动前一致）、没有真实文字（只剩补的提示，
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
    const hasImage = content.some((part) => part.type === 'image');
    if (!hasImage || text.trim() === '' || signal.aborted) {
      await this.#reportSubmitFailure(content, error);
      return false;
    }
    try {
      // 沿用原 signal：总预算仍是一次提交的时长，不为重发多等一轮。
      await this.#submitTo(controller, { ...request, content: [{ type: 'text', text }] }, signal);
      return true;
    } catch (retryError) {
      await this.#reportSubmitFailure(content, retryError);
      return false;
    }
  }

  async #reportSubmitFailure(content: readonly PromptPart[], error: unknown): Promise<void> {
    const detail = messageOf(error);
    this.#logger?.warn?.('独立模式提交失败', detail);
    // 微信那头只发中文：宿主给的是英文技术细节（模型名、限额），留在日志里排障。
    const imageOnly = content.every((part) => part.type === 'image');
    await this.#send(imageOnly ? IMAGE_ONLY_REJECTED : `没能把消息交给会话：${detail}`);
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

function withImageDropped(notice: string, imageDropped: boolean): string {
  return imageDropped ? `${notice}${IMAGE_DROPPED_SUFFIX}` : notice;
}

function timeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}
