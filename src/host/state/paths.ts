/**
 * 状态目录：`$DSH_HOME/.dsh-im-wechat`（ADR-0021）。
 *
 * 与 DSH 的其它插件一致，`DSH_HOME` 缺省 `~/.dsh`。名字带前导点是为了让它跟
 * `~/.dsh` 下的框架目录（`profiles`、`storages`、`sessions`）区分开：这是本插件
 * 自己的私有状态。目录里放登录态、长轮询游标、context_token 缓存、面板设置与独立
 * 模式绑定；都是本机私有、不入库、不随包发布（ADR-0002）。
 *
 * **状态目录与默认工作区是两个目录**（ADR-0021）：工作区是会话的 cwd，会话里的
 * 文件工具能读它；把含 `botToken` 的状态放进去，一次提示注入就能把凭据读走。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 状态目录名：前导点，与宿主自己的目录区分。 */
export const STATE_DIR_NAME = '.dsh-im-wechat';

/** 默认工作区目录名：不带点，和状态目录分开（ADR-0021）。 */
export const WORKSPACE_DIR_NAME = 'dsh-im-wechat';

function dshHome(env: NodeJS.ProcessEnv, home: string): string {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return configured !== '' ? configured : join(home, '.dsh');
}

/** 解析插件状态目录。`env` 与 `home` 可注入，便于测试不碰真实家目录。 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(dshHome(env, home), STATE_DIR_NAME);
}

/** 解析独立模式默认工作区的目录（会话 cwd，不含任何凭据）。 */
export function resolveWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(dshHome(env, home), WORKSPACE_DIR_NAME);
}

/** 登录态文件。 */
export function loginStatePath(dir: string): string {
  return join(dir, 'login.json');
}

/** 长轮询游标文件（按机器人账号分文件）。 */
export function syncCursorPath(dir: string, account: string): string {
  return join(dir, `cursor-${safeSegment(account)}.json`);
}

/** context_token 缓存文件（按机器人账号分文件）。 */
export function contextTokenPath(dir: string, account: string): string {
  return join(dir, `context-tokens-${safeSegment(account)}.json`);
}

/**
 * 账号 id 来自服务端（`ilink_bot_id`），拼进文件名前必须收窄：
 * 只保留 ASCII 字母数字与少量安全符号，其余一律换成下划线。
 */
export function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120);
  return cleaned === '' ? 'unknown' : cleaned;
}
