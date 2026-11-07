/**
 * 状态目录：`$DSH_HOME/dsh-im-wechat`。
 *
 * 与 DSH 的其它插件一致，`DSH_HOME` 缺省 `~/.dsh`。目录里只放三样东西：
 * 登录态、长轮询游标、context_token 缓存；都是本机私有、不入库、不随包发布
 * （ADR-0002）。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 解析插件数据目录。`env` 与 `home` 可注入，便于测试不碰真实家目录。 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  const root = configured !== '' ? configured : join(home, '.dsh');
  return join(root, 'dsh-im-wechat');
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
