/**
 * 面板常量：端点名、槽位、刷新间隔与两半契约版本。
 *
 * 与 host 半的 `RPC_PATH` / `HOST_CONTRACT` 必须一致：浏览器刷新就能拿到新的
 * client.js，而 host 半要重装才更新，所以两边先对契约版本（ADR-0002）。
 */

import { PACKAGE_NAME, PLUGIN_VERSION } from '../shared/version.ts';

export { PACKAGE_NAME, PLUGIN_VERSION };

/** 与 host 半 `panel-rpc.ts` 的 RPC_PATH 一致。 */
export const RPC_PATH = 'dsh-im-wechat';

/** 设置页的完整面板槽位。 */
export const SLOT_NAME = 'settings.section';

export const PANEL_ID = 'dsh-im-wechat';

/** 插件页的包配置槽位：keyed，页面按 key 分发。 */
export const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config';

/** 与 host 半 `HOST_CONTRACT` 一致；对不上就提示重启。 */
export const REQUIRED_CONTRACT = 5;

/** 静默时的自动刷新周期。 */
export const REFRESH_INTERVAL_MS = 15_000;

/** 扫码进行中的轮询周期（要等主人扫码，不能等 15 秒）。 */
export const LOGIN_POLL_INTERVAL_MS = 2_000;

/** 单次面板 RPC 的保底超时：宿主 rpc.call 自身不带超时。 */
export const RPC_TIMEOUT_MS = 20_000;

/** 长任务阈值的合法区间：与 host 半 `long-tasks.ts` 的 `normalizeLongTaskMinutes` 一致。 */
export const MIN_LONG_TASK_MINUTES = 1;
export const MAX_LONG_TASK_MINUTES = 24 * 60;

/** 提醒等待时间的合法区间：与 host 半 `normalizeQuestionDelayMinutes` 一致。 */
export const MIN_QUESTION_DELAY_MINUTES = 0;
export const MAX_QUESTION_DELAY_MINUTES = 120;

export const ENDPOINTS = Object.freeze({
  status: 'status',
  loginStart: 'login.start',
  loginCode: 'login.code',
  loginCancel: 'login.cancel',
  logout: 'logout',
  setEnabled: 'enabled.set',
  setSuperagent: 'superagent.set',
  setLongTask: 'longtask.set',
  setQuestion: 'question.set',
  setDirect: 'direct.set',
  workspaces: 'workspaces.list',
  models: 'models.list',
} as const);
