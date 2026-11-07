/**
 * 插件配置：Cordis 传入的配置 + 面板自己能改的那几项。
 *
 * 配置分两层：
 * - **静态配置**来自 profile 的 patch（`enabled`、`dataDir`、`maxText`、长任务阈值等），
 *   改了要重启；
 * - **运行设置**是面板上的「接入微信」「接入我的超级助理」与长任务阈值，落在
 *   `$DSH_HOME/dsh-im-wechat/config.json`，与登录态同一个目录，卸载重装后沿用
 *   （与如流桥的开关语义一致）。面板值优先于静态配置。
 *
 * 外部输入（宿主给的配置对象、磁盘上的 JSON）在这里收窄成确定形状，领域内部
 * 不再做防御式判空（AGENTS.md）。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './state/files.ts';
import type { StateLogger } from './state/files.ts';
import { resolveDataDir } from './state/paths.ts';
import { normalizeLongTaskMinutes } from './long-tasks.ts';
import { PLUGIN_VERSION } from '../shared/version.ts';

export interface PluginConfig {
  /** 静态默认开关：是否接入微信（收发）。 */
  enabled?: boolean;
  /** 静态默认开关：是否接入「我的超级助理」。 */
  superagent?: boolean;
  /** 覆盖数据目录（默认 `$DSH_HOME/dsh-im-wechat`）。 */
  dataDir?: string;
  /** 覆盖 API 域名。 */
  baseUrl?: string;
  /** 覆盖 CDN 基址。 */
  cdnBaseUrl?: string;
  /** 单条消息字符上限。 */
  maxText?: number;
  /** `base_info.bot_agent`。 */
  botAgent?: string;
  /** 长任务提醒阈值（分钟）：回合超过它才提醒，默认 30；面板可覆盖。 */
  longTaskThresholdMinutes?: number;
  /** 是否发「正在输入」状态，默认开；真机行为不符预期时可关（ADR-0007）。 */
  typingIndicator?: boolean;
}

const MIN_MAX_TEXT = 200;
const MAX_MAX_TEXT = 4_000;

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asMaxText(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_MAX_TEXT, Math.max(MIN_MAX_TEXT, Math.round(value)));
}

/** 把宿主给的配置收窄；未知字段忽略，非法值退回默认。 */
export function normalizePluginConfig(input: unknown): PluginConfig {
  const record = (input !== null && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const config: PluginConfig = {};
  const enabled = asBoolean(record.enabled);
  if (enabled !== undefined) config.enabled = enabled;
  const superagent = asBoolean(record.superagent);
  if (superagent !== undefined) config.superagent = superagent;
  const dataDir = asString(record.dataDir);
  if (dataDir !== undefined) config.dataDir = dataDir;
  const baseUrl = asString(record.baseUrl);
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  const cdnBaseUrl = asString(record.cdnBaseUrl);
  if (cdnBaseUrl !== undefined) config.cdnBaseUrl = cdnBaseUrl;
  const maxText = asMaxText(record.maxText);
  if (maxText !== undefined) config.maxText = maxText;
  const botAgent = asString(record.botAgent);
  if (botAgent !== undefined) config.botAgent = botAgent;
  const longTaskMinutes = normalizeLongTaskMinutes(record.longTaskThresholdMinutes);
  if (longTaskMinutes !== undefined) config.longTaskThresholdMinutes = longTaskMinutes;
  const typingIndicator = asBoolean(record.typingIndicator);
  if (typingIndicator !== undefined) config.typingIndicator = typingIndicator;
  return config;
}

/** 解析数据目录：配置优先，其次 `$DSH_HOME/dsh-im-wechat`。 */
export function resolveConfigDir(config: PluginConfig): string {
  return config.dataDir ?? resolveDataDir();
}

/** 默认 `bot_agent`：`产品名/版本`，符合协议的 UA 形态。 */
export function defaultBotAgent(): string {
  return `dsh-im-wechat/${PLUGIN_VERSION}`;
}

export interface StoredConfig {
  version: number;
  enabled?: boolean;
  /** 是否接入「我的超级助理」；缺省视为接入。 */
  superagent?: boolean;
  /** 面板上改的长任务阈值（分钟）；缺省用静态配置或默认值。 */
  longTaskThresholdMinutes?: number;
}

export const STORED_CONFIG_VERSION = 1;

/** 面板设置的持久化：只存面板能改的三项，其余配置归 profile 管。 */
export class LocalConfigStore {
  readonly #path: string;
  readonly #logger: StateLogger | undefined;
  /** 已落盘的文档：保存单项时合并，避免把另一项抹掉。 */
  #document: StoredConfig = { version: STORED_CONFIG_VERSION };

  constructor(options: { dir: string; logger?: StateLogger }) {
    this.#path = join(options.dir, 'config.json');
    this.#logger = options.logger;
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<StoredConfig> {
    const raw = await readJsonIfPresent(this.#path, { logger: this.#logger });
    if (raw === null || typeof raw !== 'object') {
      this.#document = { version: STORED_CONFIG_VERSION };
      return this.#document;
    }
    const record = raw as Record<string, unknown>;
    const enabled = asBoolean(record.enabled);
    const superagent = asBoolean(record.superagent);
    const longTaskMinutes = normalizeLongTaskMinutes(record.longTaskThresholdMinutes);
    this.#document = {
      version: STORED_CONFIG_VERSION,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(superagent !== undefined ? { superagent } : {}),
      ...(longTaskMinutes !== undefined ? { longTaskThresholdMinutes: longTaskMinutes } : {}),
    };
    return this.#document;
  }

  /** 合并保存：没给的字段沿用上一次落盘的值。 */
  async save(patch: {
    enabled?: boolean;
    superagent?: boolean;
    longTaskThresholdMinutes?: number;
  }): Promise<StoredConfig> {
    this.#document = { ...this.#document, ...patch, version: STORED_CONFIG_VERSION };
    await writePrivateFile(this.#path, `${JSON.stringify(this.#document, null, 2)}\n`);
    return { ...this.#document };
  }
}
