/**
 * 面板能改的运行时设置：开关、长任务阈值、提醒等待时间、独立模式选择。
 *
 * 这里只写「校验 → 落盘 → 生效 → 交回状态」的顺序；具体状态与副作用由装配层通过
 * `PanelActionHost` 注入，端口是单向的（读走 `status()`/`catalog()`，写走 setter）。
 */

import {
  DEFAULT_QUESTION_DELAY_MINUTES,
  normalizeBusyMode,
  normalizeQuestionDelayMinutes,
} from './config.ts';
import type { BusyMode, StoredConfig } from './config.ts';
import { DEFAULT_LONG_TASK_MINUTES, normalizeLongTaskMinutes } from './long-tasks.ts';
import { sameModelRef } from './direct-model.ts';
import type { ModelCatalogView, ModelRef } from '../shared/models.ts';
import type { RuntimeStatus, WorkspaceCatalog } from './runtime-status.ts';
import type { ReminderCenter } from './reminder-center.ts';
import type { LongTaskNotifier } from './long-tasks.ts';

/** 面板动作需要的运行时端口：装配层用闭包实现，避免把这些状态变成公开字段。 */
export interface PanelActionHost {
  status(): RuntimeStatus;
  save(patch: Partial<StoredConfig>): Promise<unknown>;
  reminders(): ReminderCenter;
  longTasks(): LongTaskNotifier;
  setEnabled(value: boolean): void;
  setSuperagent(value: boolean): void;
  startPipeline(): void;
  stopPipeline(): Promise<void>;
  stopTyping(): void;
  /** 按当前「接入我的超级助理」开关决定桥是否向核心注册。 */
  bindBridge(): void;
  syncOwnFeatures(reason: string): void;
  catalog(): WorkspaceCatalog;
  defaultWorkspaceId(): string;
  setDirectWorkspaceId(value: string): void;
  setDirectBusyMode(value: BusyMode): void;
  setDirectModel(value: ModelRef | null): void;
  /** 把刚保存的模型钉到已绑定的会话上（没有绑定或已清空时什么都不做）。 */
  applyDirectModel(): void;
  /** 宿主的模型目录：保存前校验，读不到时不可用（不拦保存）。 */
  models(): Promise<ModelCatalogView>;
  resetDirect(): Promise<void>;
}

/** 面板开关：停用后不再收消息，桥也向核心报告不可用。 */
export async function saveEnabled(host: PanelActionHost, enabled: boolean): Promise<RuntimeStatus> {
  host.setEnabled(enabled);
  await host.save({ enabled });
  if (enabled) host.startPipeline();
  else {
    await host.stopPipeline();
    host.stopTyping();
  }
  host.syncOwnFeatures(enabled ? '插件已启用，提问交回 Web 端' : '插件已停用，提问交回 Web 端');
  return host.status();
}

/** 保存「接入我的超级助理」开关：立即切换，不重连微信。 */
export async function saveSuperagent(host: PanelActionHost, enabled: boolean): Promise<RuntimeStatus> {
  host.setSuperagent(enabled);
  // 切出核心接入后不会再有交付进来收尾，先把在途的输入状态取消。
  if (!enabled) host.stopTyping();
  await host.save({ superagent: enabled });
  host.bindBridge();
  host.syncOwnFeatures('已切换为接入我的超级助理，提问交回 Web 端');
  return host.status();
}

/** 保存长任务阈值（分钟）：就地生效，不重连微信。 */
export async function saveLongTask(host: PanelActionHost, minutes: number): Promise<RuntimeStatus> {
  const next = normalizeLongTaskMinutes(minutes) ?? DEFAULT_LONG_TASK_MINUTES;
  host.longTasks().setThresholdMinutes(next);
  await host.save({ longTaskThresholdMinutes: next });
  return host.status();
}

/** 保存提醒开关与等待时间：立即生效；关掉时把在等的请求交回 Web。 */
export async function saveQuestionSettings(
  host: PanelActionHost,
  patch: { enabled?: boolean; delayMinutes?: number },
): Promise<RuntimeStatus> {
  const delayMinutes = patch.delayMinutes === undefined
    ? undefined
    : normalizeQuestionDelayMinutes(patch.delayMinutes) ?? DEFAULT_QUESTION_DELAY_MINUTES;
  host.reminders().configure({
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(delayMinutes !== undefined ? { delayMinutes } : {}),
  });
  await host.save({
    questionReminders: host.reminders().enabled,
    questionDelayMinutes: host.reminders().delayMinutes,
  });
  return host.status();
}

/**
 * 保存独立模式设置：工作区、提交方式、模型，或重置绑定（ADR-0009、ADR-0025）。
 *
 * `model: null` 是「跟随 DSH 默认」，不是「没改」——两者靠 `undefined` 区分。
 */
export async function saveDirect(
  host: PanelActionHost,
  patch: { workspaceId?: string; busyMode?: BusyMode; reset?: boolean; model?: ModelRef | null },
): Promise<RuntimeStatus> {
  const workspaceId = typeof patch.workspaceId === 'string' ? patch.workspaceId.trim() : undefined;
  // 工作区是外部输入：宿主能列出来就必须是其中的一个，避免绑定一个不存在的 id。
  if (workspaceId !== undefined && workspaceId !== '') {
    const catalog = host.catalog();
    if (catalog.available && !catalog.items.some((item) => item.id === workspaceId)) {
      throw Object.assign(new Error('所选工作区已不存在，请重新选择'), { code: 'invalid-config' });
    }
  }
  const busyMode = normalizeBusyMode(patch.busyMode);
  // 选中的就是自动创建的默认工作区时落成空值：宿主重建工作区换了 id 也仍跟随默认。
  const chosen = workspaceId !== undefined && workspaceId === host.defaultWorkspaceId() && workspaceId !== ''
    ? ''
    : workspaceId;
  if (chosen !== undefined) host.setDirectWorkspaceId(chosen);
  if (busyMode !== undefined) host.setDirectBusyMode(busyMode);
  if (patch.model !== undefined) {
    await assertModel(host, patch.model);
    host.setDirectModel(patch.model);
  }
  if (patch.reset === true) await host.resetDirect();
  await host.save({
    ...(chosen !== undefined ? { directWorkspaceId: chosen } : {}),
    ...(busyMode !== undefined ? { directBusyMode: busyMode } : {}),
    ...(patch.model !== undefined ? { directModel: patch.model } : {}),
  });
  // 值已经落盘才去钉会话：钉不上（会话没起）只是这次没换，配置本身仍然有效。
  if (patch.model !== undefined) host.applyDirectModel();
  return host.status();
}

/**
 * 模型与工作区同一条规矩：宿主能列出目录时，选中的必须是其中之一。
 *
 * 两种情况放行：目录整体读不到，以及这个 provider 自己读失败（宿主只把失败的 provider
 * 放进 failures，整体仍算可用）——那时「目录里没有」不代表模型已下架，拦下来只会把
 * 一次无害的保存变成误报。
 */
async function assertModel(host: PanelActionHost, model: ModelRef | null): Promise<void> {
  if (model === null) return;
  const catalog = await host.models();
  if (!catalog.available) return;
  if (catalog.unavailableProviders.includes(model.provider)) return;
  if (!catalog.items.some((item) => sameModelRef(item, model))) {
    throw Object.assign(new Error('所选模型已不在宿主的模型目录里，请重新选择'), { code: 'invalid-config' });
  }
}
