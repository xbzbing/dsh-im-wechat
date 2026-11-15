/**
 * 独立模式回复末尾的状态信息：模型、推理等级、这一轮消耗的 token 与发送时间。
 *
 * 只服务独立模式：接入核心时由核心在交付里附自己的状态行（模型、思考、上下文、用时），
 * 本插件不再加一行，免得同一条回复挂两套统计。
 *
 * 口径：
 * - 模型取助手消息自己记录的来源——`model/selection` 只说明「准备用哪个」，不能证明真正
 *   产出这条消息的是它；
 * - 推理等级只在记录的选择模型与本轮消息模型一致时才显示：选择变了但事件没到（接入核心
 *   期间漏收、`/new` 换了会话）时宁可省略，也不挂上一个别的模型的等级；
 * - token 按回合累加：落库的助手消息，加上失败/重试那些没落消息的尝试（`assistant/attempt`，
 *   每一次都真的产生了计费）。压缩与子代理会话不在本会话事件里，不计入。
 *
 * 输出是纯文本（不包 Markdown 强调标记）：IM 客户端的渲染能力不一，`---` 之后的一行
 * 即使被拍平也仍然可读。
 */

import { splitText, textBytes } from './superagent/render.ts';

/** 一个回合里可展示的统计项；拿不到的项不出现。 */
export interface ReplyStatusParts {
  model?: string;
  effort?: string;
  tokens?: number;
}

/** 展示用的标识（模型 id、推理等级 id）压成一行：外部输入不能破坏「只加一行」的承诺。 */
const MAX_LABEL_LENGTH = 80;
// 控制字符与换行、制表都算进来：一行里出现它们会把状态行拆成两行，甚至改写后面的 Markdown。
const CONTROL = /[\u0000-\u001f\u007f]/;

function label(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text.slice(0, MAX_LABEL_LENGTH);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 一条助手消息的 token 用量。
 *
 * 优先用适配器给的全量总数（已经是完整一次调用的提示 + 输出）；没有时按输入、输出与
 * 缓存读写相加，缓存字段缺席按 0 处理（当前两个适配器里缺席就等于 0）。给了非法值就整条
 * 作废——半个数字比没有更容易误导。
 */
export function usageTotal(usage: unknown): number | undefined {
  const record = recordOf(usage);
  if (!record) return undefined;
  const total = count(record.totalTokens);
  if (total !== undefined) return total;
  const input = count(record.inputTokens);
  const output = count(record.outputTokens);
  if (input === undefined || output === undefined) return undefined;
  const cacheRead = record.cacheReadTokens === undefined ? 0 : count(record.cacheReadTokens);
  const cacheWrite = record.cacheWriteTokens === undefined ? 0 : count(record.cacheWriteTokens);
  if (cacheRead === undefined || cacheWrite === undefined) return undefined;
  return input + output + cacheRead + cacheWrite;
}

/** 助手消息自己记录的模型 id；没有来源（或形状不对）时返回 undefined。 */
function modelOf(message: unknown): string | undefined {
  return label(recordOf(recordOf(message)?.source)?.model);
}

/**
 * 没落成消息的那次尝试用掉的 token。
 *
 * `assistant/attempt` 只在失败、被中止、被重试时出现（成功的那次落成 `assistant/message`），
 * 所以两边相加不会重复计数。用量在压缩后的流里是 `{ type: 'chunk', chunk: { type: 'usage' } }`。
 */
function attemptTokens(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined;
  let total: number | undefined;
  for (const entry of stream) {
    const record = recordOf(entry);
    if (record?.type !== 'chunk') continue;
    const chunk = recordOf(record.chunk);
    if (chunk?.type !== 'usage') continue;
    const tokens = usageTotal(chunk.usage);
    if (tokens !== undefined) total = (total ?? 0) + tokens;
  }
  return total;
}

/**
 * 按回合攒统计：`turn/start` 归零，助手消息与失败的尝试累加用量，`turn/end` 取走。
 *
 * 模型与 token 是「本回合的事实」，取走即清零；选择记忆另存一份，跨回合沿用，但只在它
 * 记的模型与本回合消息一致时才拿出来——那是「这一轮确实是它」的证据。
 */
export class ReplyMeter {
  #model: string | undefined;
  #tokens: number | undefined;
  #selection: { model: string; effort?: string } | undefined;

  /** 新回合：上一轮的模型与消耗都不再属于这一轮。 */
  startTurn(): void {
    this.#model = undefined;
    this.#tokens = undefined;
  }

  /** `model/selection`：记下当前是「哪个模型、哪档推理」。 */
  observeSelection(data: unknown): void {
    const record = recordOf(data);
    const model = label(record?.model);
    // 连模型都没有的记录对不上任何消息，留着只会挂错等级。
    if (model === undefined) {
      this.#selection = undefined;
      return;
    }
    const effort = label(record?.reasoningEffort);
    this.#selection = { model, ...(effort !== undefined ? { effort } : {}) };
  }

  /** `assistant/message`：模型来源与这一步的用量。 */
  observeAssistant(data: unknown): void {
    const record = recordOf(data);
    if (record === undefined) return;
    const model = modelOf(record.message);
    if (model !== undefined) this.#model = model;
    this.#addTokens(usageTotal(record.usage));
  }

  /** `assistant/attempt`：失败或被重试的那次调用。 */
  observeAttempt(data: unknown): void {
    this.#addTokens(attemptTokens(recordOf(data)?.stream));
  }

  /** 取走这一轮的统计（取完清零；选择记忆留着给下一轮核对模型）。 */
  take(): ReplyStatusParts {
    const selection = this.#selection;
    const effort = selection !== undefined && selection.model === this.#model ? selection.effort : undefined;
    const parts: ReplyStatusParts = {
      ...(this.#model !== undefined ? { model: this.#model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(this.#tokens !== undefined ? { tokens: this.#tokens } : {}),
    };
    this.#model = undefined;
    this.#tokens = undefined;
    return parts;
  }

  #addTokens(tokens: number | undefined): void {
    if (tokens !== undefined) this.#tokens = (this.#tokens ?? 0) + tokens;
  }
}

/**
 * token 数按人读的写法收窄：千位取整，百万位最多一位小数。
 *
 * 取整后到了 1000K 就进位成 1M（999999 显示成「1000K」会像个错误）；百万位去掉多余的
 * `.0`，免得同一量级出现「1M」与「1.0M」两种写法。
 */
export function formatTokenCount(tokens: number): string {
  // 一位小数四舍五入：1.01M 落成 1M，不留「1.0M」。
  if (tokens >= 1_000_000) return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
  if (tokens < 1000) return String(tokens);
  const thousands = Math.round(tokens / 1000);
  return thousands >= 1000 ? '1M' : `${thousands}K`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 发送时间的本机时区展示：`MM-DD HH:mm`；时间戳不可用时省略。 */
export function formatClock(at: number): string | undefined {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * 拼成回复末尾的一段：「---」分隔线加一行统计。
 *
 * 一项可报告的都没有时返回 undefined：只写一个时间对主人没有信息量，不值得再加一个分隔线。
 */
export function formatReplyStatus(parts: ReplyStatusParts, at: number): string | undefined {
  const items: string[] = [];
  if (parts.model !== undefined) items.push(`模型 ${parts.model}`);
  if (parts.effort !== undefined) items.push(`推理 ${parts.effort}`);
  if (parts.tokens !== undefined) items.push(`消耗 ${formatTokenCount(parts.tokens)} tokens`);
  // 时间是固定项：只有它还留着时不值得单独挂一行分隔线与时间。
  if (items.length === 0) return undefined;
  const clock = formatClock(at);
  if (clock !== undefined) items.push(`时间 ${clock}`);
  return `---\n${items.join(' · ')}`;
}

/**
 * 渲染好的回答 → 要发的若干条，状态行只接在最后一条上。
 *
 * 状态行也算进单条上限：切分前先扣掉它的字节数，否则「带状态行的那一条」正好会顶破
 * `maxText`（主人按这个上限理解分条）。扣完剩不下多少（阈值配得极小、模型 id 又很长）
 * 就不扣：宁可最后一条略超，也不把正文拆成碎片。
 */
export function composeReplyParts(rendered: string, maxText: number, footer: string | undefined): string[] {
  const reserved = footer === undefined ? 0 : textBytes(`\n\n${footer}`);
  const limit = reserved > 0 && reserved * 2 <= maxText ? maxText - reserved : maxText;
  const parts = splitText(rendered, limit);
  if (footer === undefined || parts.length === 0) return parts;
  parts[parts.length - 1] = `${parts[parts.length - 1]}\n\n${footer}`;
  return parts;
}
