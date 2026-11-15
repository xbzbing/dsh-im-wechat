/**
 * 入站管道：长轮询 → 身份/图片转换 → 自有功能认领 → 独立模式直连 → 核心交付。
 *
 * 「收消息」半边：轮询的 `onMessage` 只有入站路由这一个消费者，两者是同一条流水线，
 * 放一起装配层才不会越长越胖（AGENTS.md 规模规则）。
 * 状态（`#api`/`#bridge`/`#health`）仍归装配层所有，本类只通过 deps 读写，
 * 不自己持有连接生命周期之外的东西。
 */

import type { SubmitResult } from './direct.ts';
import type { ILinkApi } from './ilink/api.ts';
import { PollLoop } from './ilink/poll.ts';
import type { PollHealth } from './ilink/poll.ts';
import type { SessionGuard } from './ilink/session-guard.ts';
import { MessageItemType } from './ilink/types.ts';
import type { WeixinMessage } from './ilink/types.ts';
import { messageIdentity, messageText, normalizeMessageId } from './ilink/identity.ts';
import { downloadOwnerFiles, downloadOwnerImages, toOwnerMessageDraft } from './inbound.ts';
import type { InboundFiles } from './inbound.ts';
import { buildPromptContent, withQuote } from './prompt-parts.ts';
import type { PromptPart } from './prompt-parts.ts';
import { QuoteMemory, quoteOf, quotedContent } from './quotes.ts';
import { parseCommand } from './standalone/commands.ts';
import type { CommandInput } from './standalone/commands.ts';
import { messageOf } from './host-context.ts';
import type { WeixinBridge } from './superagent/bridge.ts';
import type { BridgeBinder } from './superagent/link.ts';
import type { BridgeHealth } from './superagent/protocol.ts';
import type { ContextTokenStore } from './state/context-tokens.ts';
import type { SyncCursorStore } from './state/sync-cursor.ts';
import type { RuntimeLogger } from './runtime-status.ts';

export interface InboundPipelineDeps {
  /** 轮询闸门：插件启用才收消息。 */
  enabled(): boolean;
  /** 已停机就绝不再起新轮询。 */
  stopped(): boolean;
  /** 已连接才起得来（api 与登录态同时在）。 */
  connection(): { api: ILinkApi; account: string } | null;
  cursor: SyncCursorStore;
  contextTokens: ContextTokenStore;
  guard: SessionGuard;
  logger: RuntimeLogger;
  now: () => number;
  fetch: typeof globalThis.fetch | undefined;
  cdnBaseUrl: string;
  bridge(): WeixinBridge | null;
  binder(): BridgeBinder | null;
  /** 自有功能是否生效（启用 + 未接入核心 + 已登录 + 未停机）。 */
  ownFeaturesActive(): boolean;
  isOwner(sender: string): boolean;
  /** 主人这条文本是不是在回答挂着的提醒；是就交给提醒中心。 */
  replyQuestion(text: string, identity: string | null): boolean;
  superagentEnabled(): boolean;
  /** 独立模式有没有可用的会话服务（宿主没提供时不必下载图片）。 */
  directAvailable(): boolean;
  typingStart(sender: string): void;
  typingStop(sender: string): void;
  /** 交给独立模式的会话；返回值决定「正在输入」要不要自己收尾。 */
  submitDirect(sender: string, content: readonly PromptPart[], files: InboundFiles): Promise<SubmitResult>;
  /** 独立模式的文字命令；返回 true 表示这条消息已被命令消费。 */
  runCommand(input: CommandInput): Promise<boolean>;
  setHealth(health: BridgeHealth): void;
  noteError(message: string): void;
}

/** 收消息的整条流水线：起停长轮询，把每条消息按上面的顺序送到该去的地方。 */
export class InboundPipeline {
  readonly #deps: InboundPipelineDeps;
  /** 「这条消息带了什么」：引用还原用（ADR-0029），只在内存里，随插件起停。 */
  readonly #quotes = new QuoteMemory();
  #abort: AbortController | null = null;
  #task: Promise<void> | null = null;

  constructor(deps: InboundPipelineDeps) {
    this.#deps = deps;
  }

  /** 起长轮询；闸门不满足（未启用/未登录/已在跑/已停机）就静默返回。 */
  start(): void {
    const deps = this.#deps;
    if (deps.stopped()) return;
    const connection = deps.connection();
    if (!deps.enabled() || !connection || this.#task) return;
    const abort = new AbortController();
    this.#abort = abort;
    const loop = new PollLoop({
      api: connection.api,
      account: connection.account,
      cursor: deps.cursor,
      contextTokens: deps.contextTokens,
      guard: deps.guard,
      onMessage: (message) => this.route(message, abort.signal),
      onHealth: (health) => this.#handlePollHealth(health),
      // 发送只认扫码登录的主人，其他发送者的 token 没有任何消费者，不落盘。
      isOwner: (sender) => deps.isOwner(sender),
      logger: deps.logger,
    });
    this.#task = loop
      .run(abort.signal)
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        const detail = messageOf(error);
        deps.noteError(`轮询异常退出：${detail}`);
        deps.setHealth({ state: 'down', code: 'other', reason: detail });
      })
      .finally(() => {
        this.#task = null;
        this.#abort = null;
      });
    void connection.api.notifyStart().catch(() => undefined);
    deps.setHealth({ state: 'ok' });
  }

  /** 停轮询：先 abort 再等收尾，半帧不会写进状态。 */
  async stop(): Promise<void> {
    this.#abort?.abort();
    await this.#task;
    this.#task = null;
    this.#abort = null;
  }

  /** 入站：转换成草稿后交给核心；核心不在就不回话，也不丢弃登录态。 */
  async route(message: WeixinMessage, signal: AbortSignal): Promise<void> {
    const deps = this.#deps;
    const bridge = deps.bridge();
    const binder = deps.binder();
    if (!bridge) return;
    const sender = typeof message.from_user_id === 'string' ? message.from_user_id : '';

    const ownerMessage = deps.ownFeaturesActive() && deps.isOwner(sender);
    const standalone = !deps.superagentEnabled() || !binder;
    const text = messageText(message.item_list);

    // 命令先于「回答问题」与图片下载：一条待答的问题不能把 /help 之类的命令吞成答案；
    // 只有 /send 收图，其余命令先回一句「图没有发出」。只在独立模式解析（AGENTS.md）。
    if (ownerMessage && standalone) {
      const parsed = parseCommand(text);
      if (parsed !== null) {
        const hasImages = message.item_list?.some((item) => item?.type === MessageItemType.IMAGE) === true;
        const images = parsed.name === 'send' && hasImages
          ? await downloadOwnerImages(message, {
            cdnBaseUrl: deps.cdnBaseUrl,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
            signal,
            logger: deps.logger,
            senderIsOwner: deps.isOwner,
          })
          : [];
        if (await deps.runCommand({ text, hasImages, images })) return;
      }
    }

    // 自有功能认领：这条文本可能是主人在回答微信里的问题。
    // 只认已确认主人的消息——陌生人的文本绝不能把主人的问题答掉。
    if (ownerMessage) {
      // 身份用于跨重启去重：同一条重投的「批准」不能再批一次（见 consumed-replies.ts）。
      const identity = messageIdentity(deps.connection()?.account ?? '', message);
      if (text.trim() !== '' && deps.replyQuestion(text, identity)) return;
    }

    // 没有接入核心（或核心不在）：独立模式把消息直接交给绑定的会话（ADR-0009）；
    // 没配会话控制器、或不是主人时照旧到此为止。主人发的图片按 ADR-0017 下载成
    // 附件 part 与文字一起交给会话（下载失败的图当这条没有图）；文件按 ADR-0028
    // 下载后单独交给提交层，由它换成宿主的暂存回执。
    if (standalone) {
      if (!deps.ownFeaturesActive()) return;
      if (!deps.isOwner(sender)) return;
      // 宿主没有会话服务时独立模式接不了：先判，别白白下载附件、开输入状态。
      if (!deps.directAvailable()) return;
      const images = await downloadOwnerImages(message, {
        cdnBaseUrl: deps.cdnBaseUrl,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        signal,
        logger: deps.logger,
        senderIsOwner: deps.isOwner,
      });
      const files = await downloadOwnerFiles(message, {
        cdnBaseUrl: deps.cdnBaseUrl,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        signal,
        logger: deps.logger,
        senderIsOwner: deps.isOwner,
      });
      // 引用还原（ADR-0029）：先记下这条消息带了什么，再把它的引用还原成一行标头。
      // 引用说的「这个文件」在会话里可能有多个候选，不指认清楚模型只能挑最近那个。
      const now = deps.now();
      this.#quotes.remember(
        normalizeMessageId(message.message_id) ?? undefined,
        quotedContent({ text, images: images.length, files: files.files.map((file) => file.name) }),
        now,
      );
      const quote = quoteOf(message);
      // 只有引用、没有别的可交付内容时不提交：标头不单独成一条消息（与加这一行之前一致）。
      const deliverable = text.trim() !== '' || images.length > 0 || files.files.length > 0;
      const quoted = quote === undefined || !deliverable ? undefined : this.#quotes.line(quote, now);
      const content = withQuote(buildPromptContent(text, images), quoted);
      // 附件阶段等了十几秒，这里按同一个判据重新看一眼：这期间停用、登出、停机或
      // 打开「接入超级助理」都会让独立模式失效，不能再开新提交。
      if (!deps.ownFeaturesActive()) return;
      // 没有可提交的内容（只剩没收下的文件）：交给提交层回一句原因，不开输入状态。
      if (content.length === 0 && files.files.length === 0) {
        if (files.dropped.length > 0) await deps.submitDirect(sender, content, files);
        return;
      }
      // 附件下载完才开「正在输入」：一个都没成、又没有文字时不能留下一直闪的输入状态。
      deps.typingStart(sender);
      const result = await deps.submitDirect(sender, content, files);
      // 进了会话就等回合结束再取消（turn/end 会停）；被拒、无服务时没有回合，自己收尾。
      // 输入状态按用户只留一份：这里收尾可能提前关掉上一轮的，但比挂着十分钟好。
      if (result !== 'queued' && result !== 'steered') deps.typingStop(sender);
      return;
    }
    const ownerLookup = bridge.ownerLookup;
    const draft = await toOwnerMessageDraft(message, {
      account: bridge.account,
      cdnBaseUrl: deps.cdnBaseUrl,
      imagesEnabled: bridge.imagesEnabled,
      ...(ownerLookup ? { senderIsOwner: ownerLookup } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      signal,
      logger: deps.logger,
      now: deps.now,
    });
    if (!draft) return;
    const result = await binder.receive(draft);
    if (result === null) {
      // 「核心不在」是独立安装的常态，不记账；「服务在但桥没注册上」必须记账，
      // 否则核心已装已开时每条消息都无声消失（registrationError 是唯一线索）。
      const failure = binder.registrationError;
      if (failure !== undefined) deps.noteError(`微信桥注册核心失败，入站暂未交付：${failure}`);
      return;
    }
    if (result.accepted === false) {
      // 拒收原因是核心的判断（不是主人、格式不合法……），桥只记账不回话。
      deps.noteError(`核心拒收入站消息：${result.reason}`);
      return;
    }
    // 核心受理了：大模型开始思考，微信那头显示「正在输入」（ADR-0007）。
    // 拒收（非主人、格式不合法）不开启——陌生人触发不了机器人状态。
    deps.typingStart(sender);
  }

  #handlePollHealth(health: PollHealth): void {
    const deps = this.#deps;
    deps.setHealth(health.state === 'ok'
      ? { state: 'ok' }
      : {
        state: health.state,
        ...(health.code ? { code: health.code } : {}),
        ...(health.reason ? { reason: health.reason } : {}),
      });
    if (health.state !== 'ok' && health.reason) deps.noteError(health.reason);
  }
}
