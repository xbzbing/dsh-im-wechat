/**
 * 状态文件的读写原语。
 *
 * 安全边界（ADR-0002）：目录 `0700`、文件 `0600`；写入走「临时文件 + rename」，
 * 半写状态不会留在最终路径上。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface StateLogger {
  warn?(...args: unknown[]): unknown;
}

/** 建目录并收紧权限。`mkdir` 的 mode 受 umask 影响，已存在的目录也要显式改。 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
}

/** 原子写入一个仅当前用户可读的文件。 */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, { mode: FILE_MODE });
  await rename(temp, path);
  await chmod(path, FILE_MODE);
}

export function isFileNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * 读并解析 JSON；文件不存在返回 `undefined`。
 *
 * 解析失败或读失败一律交出 `undefined` 并把原文件改名隔离：坏掉的状态文件
 * 只能退回「未配置」，绝不能让插件起不来。调用方据此走空状态分支。
 */
export async function readJsonIfPresent(
  path: string,
  options: { now?: () => number; logger?: StateLogger } = {},
): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    options.logger?.warn?.('读取状态文件失败', (error as Error)?.message);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    await quarantineFile(path, options.now);
    options.logger?.warn?.('状态文件无法解析，已隔离');
    return undefined;
  }
}

/** 把坏文件改名留档，避免下一次启动反复读到同一份垃圾。 */
export async function quarantineFile(path: string, now: () => number = Date.now): Promise<void> {
  try {
    await rename(path, `${path}.corrupt-${now()}`);
  } catch {
    // 改名失败不影响主流程：坏文件还在，下一次读只会再被隔离一次。
  }
}
