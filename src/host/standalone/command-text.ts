/**
 * 独立模式文字命令的文案：`/help`、`/sessions` 与 `/trace` 的 Markdown。
 *
 * 纯函数，不碰发送与状态。微信客户端能渲染 Markdown 表格（ADR-0008），所以列表直接
 * 出表格；超过一条微信消息的正文由调用方按 UTF-8 上限分条。
 */

import type { SessionSummary } from './session-list.ts';
import type { TraceEntry } from '../state/standalone-commands.ts';

/** `/sessions` 每页几个会话。 */
export const SESSION_PAGE_SIZE = 10;

/** 表格里显示的会话 id 位数：够唯一定位，又不把表撑宽。 */
export const SESSION_ID_SHOWN = 8;

/** 表格里会话标题的最大字数：微信表格单元格不换行，过长的标题会把整张表撑宽。 */
export const SESSION_TITLE_MAX = 32;

/**
 * `/help` 的正文。
 *
 * 这是命令的唯一说明来源：命令清单与解析规则都以 `COMMAND_NAMES` 为准，测试会校验
 * 帮助里写的命令都被真正识别，避免「帮助里有、实际不认」或反过来。
 */
export const HELP_TEXT = [
  '**微信命令**（独立模式）',
  '',
  '| 命令 | 作用 |',
  '| --- | --- |',
  '| `/new`（或 `/reset`） | 开新会话，旧对话仍留在 DSH 历史里 |',
  `| \`/sessions [页码]\`（或 \`/list\`） | 列出最近活跃的会话，每页 ${SESSION_PAGE_SIZE} 个；序号在你下次发 \`/sessions\` 之前不变 |`,
  '| `/send <序号或会话 id> <内容>` | 往指定会话发消息（可以附图，附图时可以不写内容），并把那一轮回答发回微信 |',
  '| `/trace <序号或会话 id> [分钟]` | 跟踪一个会话（默认 30 分钟）：它每轮结束把提问和回答发给你 |',
  '| `/trace` | 列出正在跟踪的会话；`/trace stop [序号或会话 id]` 停止一个或全部（序号按 `/sessions` 快照） |',
  '| `/help` | 显示这份说明 |',
  '',
  '**使用说明**',
  '',
  '- 直接发文字就是提问；回合进行中再发消息默认插进当前回合（可在面板改为排队）。',
  '- 直接发图片也可以，会作为附件交给会话。',
  '- 换模型、切工作区、压缩上下文、看历史请在 DSH 网页端做。',
  '- 这些命令只在未接入「我的超级助理」时生效；接入后命令由核心处理。',
].join('\n');

/** 相对时间：命令里不把 13 位时间戳丢给用户看。 */
export function describeAge(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '时间未知';
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 距到期还有多久，不足一分钟按一分钟算。 */
export function describeRemaining(until: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
}

/** 表格单元格：换行压成空格、`|` 转义（否则会被当成列分隔），过长截断。 */
export function tableCell(value: unknown, max = Infinity): string {
  const flat = String(value ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped.replace(/\|/g, '\\|');
}

/** 宿主会话 id 的前缀：表格里去掉它，否则每行都是同一个 `session-`。 */
const SESSION_PREFIX = 'session-';

/** 表格里显示的短 id：去掉 `session-` 后取前 8 位，仍够唯一定位。 */
export function shortSessionId(sessionId: string): string {
  const cleaned = sessionId.startsWith(SESSION_PREFIX) ? sessionId.slice(SESSION_PREFIX.length) : sessionId;
  return tableCell(cleaned.slice(0, SESSION_ID_SHOWN));
}

/**
 * 会话 id 是否匹配命令行里给的完整 id 或前缀。
 *
 * 表格里显示的是去掉 `session-` 的短 id，主人照着抄回来时也要能定位，所以两种写法都认。
 */
export function sessionIdMatches(sessionId: string, token: string): boolean {
  const id = sessionId.trim();
  const value = token.trim();
  if (id === '' || value === '') return false;
  if (id === value || id.startsWith(value)) return true;
  return id.startsWith(SESSION_PREFIX) && id.slice(SESSION_PREFIX.length).startsWith(value);
}

function sessionState(running: boolean): string {
  return running ? '**运行中**' : '空闲';
}

/** `/sessions` 一页的内容；序号按整份快照算，第 2 页从 11 开始。 */
export interface SessionPageView {
  rows: readonly SessionSummary[];
  page: number;
  pages: number;
  /** 本页第一行在快照里的下标。 */
  offset: number;
  /** 快照里的会话数（翻页能翻到的）。 */
  listed: number;
  now: number;
  /** 宿主的会话比快照多，后面的没有列出。 */
  truncated?: boolean;
}

/** `/sessions` 的 Markdown：一张表，表头说总数和页码，表尾给翻页与用法。 */
export function renderSessionList(view: SessionPageView): string {
  const rows = view.rows.map((row, index) => [
    String(view.offset + index + 1),
    tableCell(row.title, SESSION_TITLE_MAX) || '未命名会话',
    shortSessionId(row.sessionId),
    sessionState(row.running),
    describeAge(row.updatedAt, view.now),
    row.workspace ? tableCell(row.workspace) : '—',
  ].join(' | '));
  const lines = [
    view.pages > 1 ? `**最近会话**（共 ${view.listed} 个，第 ${view.page}/${view.pages} 页）` : `**最近会话**（共 ${view.listed} 个）`,
    '',
    '| # | 会话 | id | 状态 | 最后活动 | 工作区 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '',
  ];
  if (view.page < view.pages) lines.push(`发 \`/sessions ${view.page + 1}\` 看下一页。`, '');
  if (view.truncated === true) lines.push(`只列出最近 ${view.listed} 个，其余请到 DSH 网页端查看。`, '');
  lines.push(
    '发 `/send <序号> <内容>` 往会话发消息，`/trace <序号>` 跟踪它；也可以用 id 代替序号。',
    '序号在你下次发 `/sessions` 之前不变。',
  );
  return lines.join('\n');
}

/**
 * `/trace` 的跟踪列表；序号跟最近一次 `/sessions` 的快照一致，不在快照里的显示 `—`。
 *
 * `/trace stop <序号>` 也按这份编号解释，主人不用在两套序号之间换算。
 */
export function renderTraceList(
  entries: readonly TraceEntry[],
  now: number,
  listing: readonly { sessionId: string }[] = [],
): string {
  const numberOf = (sessionId: string): string => {
    const index = listing.findIndex((row) => row.sessionId === sessionId);
    return index >= 0 ? String(index + 1) : '—';
  };
  return [
    `**正在跟踪**（${entries.length} 个）`,
    '',
    '| # | 会话 | id | 开始跟踪 | 剩余 |',
    '| --- | --- | --- | --- | --- |',
    ...entries.map((entry) => `| ${numberOf(entry.sessionId)} | ${tableCell(entry.title, SESSION_TITLE_MAX) || '未命名会话'} | ${shortSessionId(entry.sessionId)} | ${describeAge(entry.since, now)} | ${describeRemaining(entry.until, now)} |`),
    '',
    '序号跟最近一次 `/sessions` 的快照一致；不在快照里的会话用 id 前几位停止。',
    '发 `/trace stop <序号或会话 id>` 停止其中一个，`/trace stop` 全部停止。',
  ].join('\n');
}
