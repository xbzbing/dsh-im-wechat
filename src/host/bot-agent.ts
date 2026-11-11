/**
 * `bot_agent`：iLink 每个请求 `base_info` 里的观测标识，UA 形态，不是 LLM agent
 * （官方 README：仅用于观测，不参与鉴权与路由）。
 *
 * 官方规范：一个或多个 `Name/Version` token 空格分隔，每个可跟 ` (comment)`；
 * 仅 ASCII，总长 ≤256 字节；不合规的片段在清洗时静默丢弃，清洗后为空回退产品默认。
 *
 * 有效值会落盘（`bot-agent.json`）给同机的 `dsh-wechat-send` 读，保证插件与命令发出
 * 同一个 UA：命令是独立进程，读不到宿主 profile 里的插件配置。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './state/files.ts';
import type { StateLogger } from './state/files.ts';
import { PLUGIN_VERSION } from '../shared/version.ts';

/** 官方规范的总长上限。 */
export const BOT_AGENT_MAX_BYTES = 256;

/** 默认 `bot_agent`：`产品名/版本`，符合协议的 UA 形态。 */
export function defaultBotAgent(): string {
  return `dsh-im-wechat/${PLUGIN_VERSION}`;
}

/**
 * 一个 UA token：`Name/Version`，可选 ` (comment)`。
 * 前后必须是串边界或空白，避免把 URL、路径里的片段当成 token。
 */
const TOKEN = /(?:^|\s)([A-Za-z0-9][A-Za-z0-9._+-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*)(\s*\([^()]*\))?(?=\s|$)/g;

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/** 按官方规范清洗；清洗后为空返回空串，由调用方决定回退。 */
export function sanitizeBotAgent(raw: string | undefined): string {
  if (typeof raw !== 'string') return '';
  const tokens: string[] = [];
  for (const match of raw.matchAll(TOKEN)) {
    const product = match[1]!;
    const comment = match[2]?.trim();
    tokens.push(comment !== undefined && comment !== '' && isAscii(comment) ? `${product} ${comment}` : product);
  }
  let kept = '';
  for (const token of tokens) {
    const next = kept === '' ? token : `${kept} ${token}`;
    // 超长的从尾部丢：保留前面的 token 比整条丢弃更有用。
    if (Buffer.byteLength(next, 'utf8') > BOT_AGENT_MAX_BYTES) break;
    kept = next;
  }
  return kept;
}

/** 实际发出去的 `bot_agent`：清洗后的配置，空则产品默认。 */
export function resolveBotAgent(raw?: string): string {
  const cleaned = sanitizeBotAgent(raw);
  return cleaned === '' ? defaultBotAgent() : cleaned;
}

/** 有效值的跨进程传递：插件启动时写，命令启动时读。 */
export class BotAgentStore {
  readonly #path: string;
  readonly #logger: StateLogger | undefined;

  constructor(options: { dir: string; logger?: StateLogger }) {
    this.#path = join(options.dir, 'bot-agent.json');
    this.#logger = options.logger;
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<string | undefined> {
    const raw = await readJsonIfPresent(this.#path, { logger: this.#logger });
    if (raw === null || typeof raw !== 'object') return undefined;
    const agent = (raw as Record<string, unknown>).agent;
    if (typeof agent !== 'string') return undefined;
    const cleaned = sanitizeBotAgent(agent);
    return cleaned === '' ? undefined : cleaned;
  }

  /** 写失败只记日志：UA 是观测信息，不值得让启动失败。 */
  async save(agent: string): Promise<void> {
    const cleaned = sanitizeBotAgent(agent);
    if (cleaned === '') return;
    try {
      await writePrivateFile(this.#path, `${JSON.stringify({ agent: cleaned }, null, 2)}\n`);
    } catch (error) {
      this.#logger?.warn?.('bot_agent 落盘失败', (error as Error)?.message);
    }
  }
}
