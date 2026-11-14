/**
 * 插件配置：Cordis 传入的配置 + 面板自己能改的那几项。
 *
 * 配置分两层：
 * - **静态配置**来自 profile 的 patch（`enabled`、`dataDir`、`maxText`、长任务阈值等），
 *   改了要重启；
 * - **运行设置**是面板上的「接入微信」「接入我的超级助理」与长任务阈值，落在
 *   `$DSH_HOME/.dsh-im-wechat/config.json`，与登录态同一个目录，卸载重装后沿用
 *   （与如流桥的开关语义一致）。面板值优先于静态配置。
 *
 * 外部输入（宿主给的配置对象、磁盘上的 JSON）在这里收窄成确定形状，领域内部
 * 不再做防御式判空（AGENTS.md）。
 */

import { join, resolve } from 'node:path';

import { readJsonIfPresent, writePrivateFile } from './state/files.ts';
import type { StateLogger } from './state/files.ts';
import { resolveDataDir } from './state/paths.ts';
import { normalizeLongTaskMinutes } from './long-tasks.ts';

export interface PluginConfig {
  /** 静态默认开关：是否接入微信（收发）。 */
  enabled?: boolean;
  /** 静态默认开关：是否接入「我的超级助理」。 */
  superagent?: boolean;
  /** 覆盖状态目录（默认 `$DSH_HOME/.dsh-im-wechat`）；不影响默认工作区目录（ADR-0021）。 */
  dataDir?: string;
  /** 覆盖 API 域名。 */
  baseUrl?: string;
  /** 覆盖 CDN 基址。 */
  cdnBaseUrl?: string;
  /** 单条消息上限，按 UTF-8 字节计（约 500 个中文字；默认 1500）。 */
  maxText?: number;
  /** `base_info.bot_agent`。 */
  botAgent?: string;
  /** 长任务提醒阈值（分钟）：回合超过它才提醒，默认 30；面板可覆盖。 */
  longTaskThresholdMinutes?: number;
  /** 是否发「正在输入」状态，默认开；真机行为不符预期时可关（ADR-0007）。 */
  typingIndicator?: boolean;
  /**
   * 问题与审批提醒：默认开。
   *
   * 关掉后 `user-questions/request` 与 `approval/request` 一律 `next()`，全部交回 Web 端，
   * 与没装插件一致；不影响收消息与交付。
   */
  questionReminders?: boolean;
  /**
   * 提醒前的等待时间（分钟），默认 5。
   *
   * 这段时间里主人在 Web 端答完就完全不打扰；到点还没答才推到微信。
   * 0 表示立刻提醒。
   */
  questionDelayMinutes?: number;
  /**
   * 取码时要求服务端强制出 PIN，仅用于提前验证 PIN 交互（3.0.0 起）。
   * 默认关闭；关闭它不能阻止服务端自行要求 PIN。
   */
  verifyPin?: boolean;
  /** 独立模式建会话的工作区 id；空表示自动创建的默认工作区「微信会话」（ADR-0018）。 */
  directWorkspaceId?: string;
  /** 独立模式里回合正在跑时又来一条消息的提交方式：插话（默认，见 DEFAULT_DIRECT_BUSY_MODE）或排队（ADR-0009）。 */
  directBusyMode?: BusyMode;
}

const MIN_MAX_TEXT = 200;
// 上限必须小于客户端折叠阈值：4000 字节约 1333 中文字，会落回「984 字只显示前几条」的区间。
const MAX_MAX_TEXT = 2_048;

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

/** 独立模式的提交方式；与宿主 `InputSubmitMode` 同一套取值。 */
export type BusyMode = 'queue' | 'steer';

export const DEFAULT_DIRECT_BUSY_MODE: BusyMode = 'steer';

/** 提醒前的默认等待时间：够主人在 Web 端答完，又不至于让提问等太久。 */
export const DEFAULT_QUESTION_DELAY_MINUTES = 5;
export const MIN_QUESTION_DELAY_MINUTES = 0;
export const MAX_QUESTION_DELAY_MINUTES = 120;

/** 等待时间收窄到 0–120 分钟；非数字交给调用方回落到默认值。 */
export function normalizeQuestionDelayMinutes(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(MAX_QUESTION_DELAY_MINUTES, Math.max(MIN_QUESTION_DELAY_MINUTES, Math.round(value)));
}

/** 只认 queue / steer；其余一律回落到默认（插队）。 */
export function normalizeBusyMode(value: unknown): BusyMode | undefined {
  return value === 'queue' || value === 'steer' ? value : undefined;
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
  const directWorkspaceId = asString(record.directWorkspaceId);
  if (directWorkspaceId !== undefined) config.directWorkspaceId = directWorkspaceId;
  const directBusyMode = normalizeBusyMode(record.directBusyMode);
  if (directBusyMode !== undefined) config.directBusyMode = directBusyMode;
  const longTaskMinutes = normalizeLongTaskMinutes(record.longTaskThresholdMinutes);
  if (longTaskMinutes !== undefined) config.longTaskThresholdMinutes = longTaskMinutes;
  const typingIndicator = asBoolean(record.typingIndicator);
  if (typingIndicator !== undefined) config.typingIndicator = typingIndicator;
  // 这个开关决定「微信消息能否批一次工具授权」：写坏了按关处理，不静默恢复。
  if (record.questionReminders !== undefined) {
    config.questionReminders = asBoolean(record.questionReminders) ?? false;
  }
  const questionDelay = normalizeQuestionDelayMinutes(record.questionDelayMinutes);
  if (questionDelay !== undefined) config.questionDelayMinutes = questionDelay;
  const verifyPin = asBoolean(record.verifyPin);
  if (verifyPin !== undefined) config.verifyPin = verifyPin;
  return config;
}

/** 解析状态目录：配置优先，其次 `$DSH_HOME/.dsh-im-wechat`。 */
export function resolveConfigDir(config: PluginConfig): string {
  // 只放状态（登录态、面板设置、绑定）。默认工作区是另一个目录（ADR-0021），
  // 相对路径在 `dataDir` 上仍然按当前目录解析成绝对路径。
  return config.dataDir === undefined ? resolveDataDir() : resolve(config.dataDir);
}

export interface StoredConfig {
  version: number;
  enabled?: boolean;
  /** 是否接入「我的超级助理」；缺省视为接入。 */
  superagent?: boolean;
  /** 面板上改的长任务阈值（分钟）；缺省用静态配置或默认值。 */
  longTaskThresholdMinutes?: number;
  /** 面板上改的问题与审批提醒开关；缺省视为开。 */
  questionReminders?: boolean;
  /** 面板上改的提醒等待时间（分钟）；缺省用静态配置或默认值。 */
  questionDelayMinutes?: number;
  /** 面板上改的独立模式工作区 id；空串表示默认的「微信会话」工作区。 */
  directWorkspaceId?: string;
  /** 面板上改的独立模式提交方式。 */
  directBusyMode?: BusyMode;
}

export const STORED_CONFIG_VERSION = 1;

/** 面板设置的持久化：只存面板能改的几项，其余配置归 profile 管。 */
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
    const questionReminders = record.questionReminders === undefined
      ? undefined
      : asBoolean(record.questionReminders) ?? false;
    const questionDelay = normalizeQuestionDelayMinutes(record.questionDelayMinutes);
    const directWorkspaceId = asString(record.directWorkspaceId);
    const directBusyMode = normalizeBusyMode(record.directBusyMode);
    this.#document = {
      version: STORED_CONFIG_VERSION,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(superagent !== undefined ? { superagent } : {}),
      ...(longTaskMinutes !== undefined ? { longTaskThresholdMinutes: longTaskMinutes } : {}),
      ...(questionReminders !== undefined ? { questionReminders } : {}),
      ...(questionDelay !== undefined ? { questionDelayMinutes: questionDelay } : {}),
      ...(directWorkspaceId !== undefined ? { directWorkspaceId } : {}),
      ...(directBusyMode !== undefined ? { directBusyMode } : {}),
    };
    return this.#document;
  }

  /** 合并保存：没给的字段沿用上一次落盘的值。 */
  async save(patch: {
    enabled?: boolean;
    superagent?: boolean;
    longTaskThresholdMinutes?: number;
    questionReminders?: boolean;
    questionDelayMinutes?: number;
    directWorkspaceId?: string;
    directBusyMode?: BusyMode;
  }): Promise<StoredConfig> {
    this.#document = { ...this.#document, ...patch, version: STORED_CONFIG_VERSION };
    await writePrivateFile(this.#path, `${JSON.stringify(this.#document, null, 2)}\n`);
    return { ...this.#document };
  }
}
