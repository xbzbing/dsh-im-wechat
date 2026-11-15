/**
 * 独立模式的文字命令：`/help` `/new` `/sessions` `/list` `/send` `/trace` `/stop` `/status`。
 *
 * 只在没有接入核心时生效（接入后命令由核心解析，AGENTS.md 的安全红线）；只有主人
 * 的文本能走到这里。命令本身不进会话、不经过模型，回复也直接发回微信。
 *
 * 语义与核心侧同一套习惯：序号按最近一次
 * `/sessions` 的快照解释，序号在下次重新列出之前不变；`/send` 与 `/trace` 都用
 * 序号或会话 id（完整或唯一前缀）定位。
 */

import { messageOf } from '../host-context.ts';
import { buildPromptContent, withAttachmentHint } from '../prompt-parts.ts';
import type { PromptPart } from '../prompt-parts.ts';
import { splitText, toWeChatMarkdown } from '../superagent/render.ts';
import type { OwnerImage } from '../superagent/protocol.ts';
import {
  HELP_TEXT,
  SESSION_PAGE_SIZE,
  renderSessionList,
  renderStatus,
  sessionIdMatches,
  renderTraceList,
} from './command-text.ts';
import type { StatusView } from './command-text.ts';
import type { SessionLister, SessionSummary } from './session-list.ts';
import {
  DEFAULT_TRACE_MINUTES,
  MAX_TRACE_MINUTES,
} from './session-watch.ts';
import type { SessionWatcher } from './session-watch.ts';
import { MAX_LISTING, MAX_TRACES } from '../state/standalone-commands.ts';
import type { ListingEntry } from '../state/standalone-commands.ts';
import type { ModelRef } from '../../shared/models.ts';

/** 可识别的命令名（不含 `/`）；帮助文案与解析规则都以它为准。 */
export const COMMAND_NAMES: readonly string[] = Object.freeze([
  'new', 'reset', 'sessions', 'list', 'send', 'trace', 'stop', 'status', 'help',
]);

// 命令名后面必须是空白或结尾：`/new-thing`、`/sendabc` 是普通文本，不能被当成命令。
const COMMAND_PATTERN = new RegExp(`^/(${COMMAND_NAMES.join('|')})(?=\\s|$)`, 'i');

export interface ParsedCommand {
  name: string;
  /** 命令名之后的参数（已 trim，可能为空）。 */
  rest: string;
}

export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  const match = COMMAND_PATTERN.exec(trimmed);
  if (match === null) return null;
  return { name: match[1]!.toLowerCase(), rest: trimmed.slice(match[0].length).trim() };
}

export interface CommandInput {
  text: string;
  hasImages: boolean;
  images: readonly OwnerImage[];
}

/** 命令要读的运行态（装配层从完整 status 里挑出来）。 */
export interface CommandStatusView {
  loggedIn: boolean;
  accountTail?: string;
  health: { state?: string; reason?: string };
  pendingQuestions: number;
  pendingApprovals: number;
  direct: {
    bound: boolean;
    sessionId?: string;
    sessionTitle?: string;
    running: boolean;
    busyMode: 'queue' | 'steer';
    model: ModelRef | null;
  };
}

/** 命令运行需要的端口；装配层给实现，测试给假实现。 */
export interface CommandPorts {
  lister: SessionLister;
  watcher: SessionWatcher;
  store: {
    listing(): readonly ListingEntry[];
    setListing(entries: readonly ListingEntry[]): Promise<unknown>;
  };
  /** 丢掉直连会话的绑定，下次发消息新建。 */
  reset: () => Promise<void>;
  /** 当前有没有绑定直连会话（`/new` 的回执要区分「已重置」与「还没有」）。 */
  bound: () => boolean;
  /**
   * 往指定会话提交一条消息。`onAdmitted` 在提交前同步调用，携带这一轮是排队还是
   * 插话——观察者要在这个时间点登记，晚了会漏掉宿主紧接着发出的回合事件。
   */
  deliver: (
    sessionId: string,
    content: readonly PromptPart[],
    onAdmitted: (info: { queued: boolean }) => void,
  ) => Promise<void>;
  send: (text: string) => Promise<boolean>;
  /** 运行态快照（`/status` 用）。 */
  status: () => CommandStatusView;
  /** 停止当前绑定的回合；由装配层判断「没有绑定 / 没在跑 / 宿主不支持」。 */
  stop: () => Promise<'stopped' | 'idle' | 'unsupported' | 'failed'>;
  now?: () => number;
  maxText?: number;
  logger?: { warn?(...args: unknown[]): unknown };
}

const USAGE_SEND = '用法：`/send <序号或会话 id> <内容>`。先发 `/sessions` 看有哪些会话。';
const USAGE_TRACE = '用法：`/trace <序号或会话 id> [分钟]`，或 `/trace stop [序号]`。先发 `/sessions` 看序号。';
const COMMAND_WITH_IMAGES = '转发命令时不能同时附图；命令和图都没有发出。';

export class StandaloneCommands {
  readonly #ports: CommandPorts;

  constructor(ports: CommandPorts) {
    this.#ports = ports;
  }

  /** 执行一条命令；不是已知命令时返回 false（调用方把它当普通文字交给会话）。 */
  async run(input: CommandInput): Promise<boolean> {
    const parsed = parseCommand(input.text);
    if (parsed === null) return false;
    // 只有 /send 收图：其余命令先说清楚图没有发出，命令照常执行。
    if (input.hasImages && parsed.name !== 'send') {
      await this.#say(`${this.#token(input.text)} 命令不带图片，图没有发出。`);
    }
    switch (parsed.name) {
      case 'new':
      case 'reset':
        await this.#new();
        return true;
      case 'sessions':
      case 'list':
        await this.#sessions(parsed.rest);
        return true;
      case 'send':
        await this.#send(parsed.rest, input);
        return true;
      case 'trace':
        await this.#trace(parsed.rest);
        return true;
      case 'stop':
        await this.#stop();
        return true;
      case 'status':
        await this.#status();
        return true;
      case 'help':
        await this.#say(HELP_TEXT);
        return true;
      default:
        return false;
    }
  }

  async #stop(): Promise<void> {
    const result = await this.#ports.stop();
    const text = result === 'stopped'
      ? '已请求停止当前任务。'
      : result === 'idle'
        ? '当前没有正在运行的会话。'
        : result === 'unsupported'
          ? '宿主不支持停止当前回合。'
          : '停止失败，请到 Web 端处理。';
    await this.#say(text);
  }

  /** `/status`：连接、当前会话、模型、待答/待审批、跟踪、其它运行中的会话。 */
  async #status(): Promise<void> {
    const runtime = this.#ports.status();
    const catalog = await this.#ports.lister.list();
    const traces = this.#ports.watcher.list(this.#now());
    const byId = new Map(catalog.sessions.map((row) => [row.sessionId, row]));
    const running = catalog.available
      ? catalog.sessions.filter((row) => row.running)
      : `读取失败：${catalog.reason ?? '未知错误'}`;
    const direct = runtime.direct;
    const view: StatusView = {
      now: this.#now(),
      loggedIn: runtime.loggedIn,
      ...(runtime.accountTail === undefined ? {} : { accountTail: runtime.accountTail }),
      health: runtime.health,
      current: direct.bound && direct.sessionId !== undefined
        ? { sessionId: direct.sessionId, title: direct.sessionTitle ?? '', running: direct.running }
        : null,
      model: direct.model,
      busyMode: direct.busyMode,
      pendingQuestions: runtime.pendingQuestions,
      pendingApprovals: runtime.pendingApprovals,
      traces: traces.map((trace) => ({ ...trace, running: byId.get(trace.sessionId)?.running ?? null })),
      running: typeof running === 'string'
        ? running
        : running.map((row) => ({ title: row.title, updatedAt: row.updatedAt, workspace: row.workspace })),
      listing: this.#ports.store.listing(),
    };
    await this.#say(renderStatus(view));
  }

  async #new(): Promise<void> {
    const had = this.#ports.bound();
    await this.#ports.reset();
    await this.#say(had
      ? '已为你开启新会话，之前的对话记录仍保留在 DSH 历史里。'
      : '当前还没有会话，直接发消息就会创建新会话。');
  }

  async #sessions(rest: string): Promise<void> {
    const arg = rest.split(/\s+/)[0] ?? '';
    const requested = /^\d+$/.test(arg) ? Number.parseInt(arg, 10) : 0;
    const catalog = await this.#ports.lister.list();
    if (!catalog.available) {
      await this.#say(`读取会话列表失败：${catalog.reason ?? '未知错误'}`);
      return;
    }
    // 快照能存多少就列多少：先展示 150 行再只落盘 100 行，序号 101+ 是寻址不到的。
    const visible = catalog.sessions.slice(0, MAX_LISTING);
    const truncated = catalog.sessions.length > visible.length;
    let listing: readonly ListingEntry[] | null = requested > 0 ? this.#ports.store.listing() : null;
    if (listing === null || listing.length === 0) {
      if (visible.length === 0) {
        await this.#say('当前没有可用的会话。');
        return;
      }
      listing = visible.map((row) => ({ sessionId: row.sessionId, title: row.title }));
      await this.#ports.store.setListing(listing);
    }
    const pages = Math.max(1, Math.ceil(listing.length / SESSION_PAGE_SIZE));
    const page = requested > 0 ? requested : 1;
    if (page > pages) {
      await this.#say(`只有 ${pages} 页，发 \`/sessions ${pages}\` 看最后一页，发 \`/sessions\` 重新列出。`);
      return;
    }
    const offset = (page - 1) * SESSION_PAGE_SIZE;
    const rows = listing.slice(offset, offset + SESSION_PAGE_SIZE).map((entry) => {
      const fresh = visible.find((row) => row.sessionId === entry.sessionId);
      return fresh ?? {
        sessionId: entry.sessionId,
        title: entry.title,
        updatedAt: 0,
        running: false,
        workspace: '',
      } satisfies SessionSummary;
    });
    await this.#say(renderSessionList({
      rows,
      page,
      pages,
      offset,
      listed: listing.length,
      now: this.#now(),
      truncated,
    }));
  }

  async #send(rest: string, input: CommandInput): Promise<void> {
    const match = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
    const target = match?.[1] ?? '';
    const body = (match?.[2] ?? '').trim();
    if (target === '' || (input.images.length === 0 && body === '')) {
      if (input.hasImages && input.images.length === 0) {
        await this.#say('图片没有下载到，不能只发图片；请重发文字或图片。');
        return;
      }
      await this.#say(USAGE_SEND);
      return;
    }
    if (input.images.length > 0 && body.startsWith('/')) {
      await this.#say(COMMAND_WITH_IMAGES);
      return;
    }
    const picked = await this.#pick(target);
    if ('miss' in picked) {
      await this.#say(picked.miss);
      return;
    }
    const content = withAttachmentHint(buildPromptContent(body, input.images));
    try {
      await this.#ports.deliver(picked.sessionId, content, (info) => {
        this.#ports.watcher.trackSend(picked.sessionId, picked.title, body, info.queued);
      });
      const dropped = input.hasImages && input.images.length === 0 ? '（图片没有发出）' : '';
      await this.#say(`已交给会话「${picked.title || '未命名会话'}」${dropped}，这一轮结束后把回答发给你。`);
    } catch (error) {
      this.#ports.watcher.removeSend(picked.sessionId);
      this.#ports.logger?.warn?.('独立模式 /send 失败', messageOf(error));
      await this.#say(`没能把消息交给会话：${messageOf(error)}`);
    }
  }

  async #trace(rest: string): Promise<void> {
    const args = rest.split(/\s+/).filter((item) => item !== '');
    const watcher = this.#ports.watcher;
    if (args.length === 0) {
      const entries = watcher.list(this.#now());
      if (entries.length === 0) {
        await this.#say('当前没有跟踪的会话。发 `/trace <序号>` 开始跟踪，序号见 `/sessions`。');
        return;
      }
      await this.#say(renderTraceList(entries, this.#now(), this.#ports.store.listing()));
      return;
    }

    if (args[0]!.toLowerCase() === 'stop') {
      const target = args.slice(1).join(' ');
      // 序号按 `/sessions` 快照定位；id 前缀不在快照里时（会话已删）再用原串找跟踪。
      let resolved = target;
      if (target !== '') {
        const picked = await this.#pick(target);
        if (!('miss' in picked)) resolved = picked.sessionId;
      }
      const removed = await watcher.remove(resolved);
      if (removed.length === 0) {
        await this.#say(target === ''
          ? '当前没有跟踪的会话。'
          : `找不到「${target}」对应的跟踪，发 \`/trace\` 看序号。`);
        return;
      }
      await this.#say(removed.length === 1
        ? `已停止跟踪「${removed[0]!.title || removed[0]!.sessionId}」。`
        : `已停止跟踪 ${removed.length} 个会话。`);
      return;
    }

    let minutes = DEFAULT_TRACE_MINUTES;
    if (args.length > 2) {
      await this.#say(USAGE_TRACE);
      return;
    }
    if (args.length === 2) {
      const parsed = /^\d+$/.test(args[1]!) ? Number.parseInt(args[1]!, 10) : 0;
      if (parsed < 1 || parsed > MAX_TRACE_MINUTES) {
        await this.#say(`时长写分钟数，1 到 ${MAX_TRACE_MINUTES} 之间，例如 \`/trace ${args[0]} 60\`。`);
        return;
      }
      minutes = parsed;
    }
    const picked = await this.#pick(args[0]!);
    if ('miss' in picked) {
      await this.#say(picked.miss);
      return;
    }
    const result = await watcher.add(picked.sessionId, picked.title, minutes);
    if (result === 'full') {
      await this.#say(`最多同时跟踪 ${MAX_TRACES} 个会话，先 \`/trace stop\` 停掉一个。`);
      return;
    }
    const name = picked.title || picked.sessionId;
    await this.#say(result === 'renewed'
      ? `已重新计时跟踪「${name}」（${minutes} 分钟）。`
      : `已开始跟踪「${name}」（${minutes} 分钟）：它每轮结束把提问和回答发给你。`);
  }

  /**
   * 按序号或会话 id 定位。
   *
   * 序号只按最近一次 `/sessions` 的快照解释，不拿实时列表兜底：没列过的序号是盲猜。
   * 会话 id（完整或唯一前缀）按当前列表找；不足 4 位的纯数字只当序号。
   */
  async #pick(target: string): Promise<{ sessionId: string; title: string } | { miss: string }> {
    const token = target.trim();
    if (token === '') return { miss: USAGE_SEND };
    if (/^\d+$/.test(token)) {
      const listing = this.#ports.store.listing();
      const index = Number.parseInt(token, 10);
      if (listing.length > 0 && index >= 1 && index <= listing.length) {
        const entry = listing[index - 1]!;
        return { sessionId: entry.sessionId, title: entry.title };
      }
      if (token.length < 4) {
        return {
          miss: listing.length > 0
            ? `序号 ${token} 不在你上次 /sessions 的列表里（共 ${listing.length} 个），发 /sessions 重新列出。`
            : '还没列过会话：先发 /sessions 看序号，或直接用会话 id 的前几位。',
        };
      }
    }
    const catalog = await this.#ports.lister.list();
    if (!catalog.available) return { miss: `读取会话列表失败：${catalog.reason ?? '未知错误'}` };
    const prefixed = catalog.sessions.filter((row) => sessionIdMatches(row.sessionId, token));
    const picked = prefixed.length === 1 ? prefixed[0] : undefined;
    return picked ?? {
      miss: `找不到「${token}」对应的会话，先发 /sessions 看一眼序号（也可以用会话 id 的前几位）。`,
    };
  }

  #token(text: string): string {
    return text.trim().split(/\s+/)[0] ?? '';
  }

  #now(): number {
    return this.#ports.now?.() ?? Date.now();
  }

  async #say(text: string): Promise<void> {
    const rendered = toWeChatMarkdown(text);
    for (const part of splitText(rendered, this.#ports.maxText)) {
      const ok = await this.#ports.send(part);
      if (!ok) return;
    }
  }
}
