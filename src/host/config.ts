/**
 * 插件配置：Cordis 传入的配置 + 面板自己能改的那一项。
 *
 * 配置分两层：
 * - **静态配置**来自 profile 的 patch（`enabled`、`dataDir`、`maxText` 等），改了要重启；
 * - **运行开关**是面板上的「接入微信」，落在 `$DSH_HOME/dsh-im-wechat/config.json`，
 *   与登录态同一个目录，卸载重装后沿用（与如流桥的开关语义一致）。
 *
 * 外部输入（宿主给的配置对象、磁盘上的 JSON）在这里收窄成确定形状，领域内部
 * 不再做防御式判空（AGENTS.md）。
 */

import { join } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './state/files.ts';
import type { StateLogger } from './state/files.ts';
import { resolveDataDir } from './state/paths.ts';
import { PLUGIN_VERSION } from '../shared/version.ts';

export interface PluginConfig {
  /** 静态默认开关。 */
  enabled?: boolean;
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
}

export const STORED_CONFIG_VERSION = 1;

/** 面板开关的持久化：只存 `enabled`，其余配置归 profile 管。 */
export class LocalConfigStore {
  readonly #path: string;
  readonly #logger: StateLogger | undefined;

  constructor(options: { dir: string; logger?: StateLogger }) {
    this.#path = join(options.dir, 'config.json');
    this.#logger = options.logger;
  }

  get path(): string {
    return this.#path;
  }

  async load(): Promise<StoredConfig> {
    const raw = await readJsonIfPresent(this.#path, { logger: this.#logger });
    if (raw === null || typeof raw !== 'object') return { version: STORED_CONFIG_VERSION };
    const record = raw as Record<string, unknown>;
    const enabled = asBoolean(record.enabled);
    return {
      version: STORED_CONFIG_VERSION,
      ...(enabled !== undefined ? { enabled } : {}),
    };
  }

  async save(patch: { enabled?: boolean }): Promise<StoredConfig> {
    const next: StoredConfig = { version: STORED_CONFIG_VERSION, ...patch };
    await writePrivateFile(this.#path, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }
}
