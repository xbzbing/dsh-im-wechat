/**
 * 出站快捷命令 `dsh-wechat-send`（ADR-0012）。
 *
 * 这里只做三件事：解析参数、把状态读成「能不能发」、按顺序调用 `ilink/` 的发送
 * 实现。协议、加密、上传、失败分类全在 `ilink/` 里，命令不复制一份——否则协议
 * 一改就悄悄漂移（历史坑：`image_item` 的 `encrypt_type` 与顶层 `aeskey`）。
 *
 * 依赖以结构类型注入（`CliPorts`），命令本体不碰磁盘与网络：测试用假端口就能
 * 跑完全部分支，真机路径由 `ilink` 自己的测试覆盖。
 */

import { readFile, stat } from 'node:fs/promises';

import { DEFAULT_CDN_BASE_URL, createApi } from './ilink/api.ts';
import { MAX_IMAGE_BYTES, sniffImageType } from './ilink/media.ts';
import { sendImage, sendText } from './ilink/send.ts';
import { uploadImage } from './ilink/upload.ts';
import { ContextTokenStore } from './state/context-tokens.ts';
import { LoginStateStore, accountTail } from './state/login-state.ts';
import type { LoginState } from './state/login-state.ts';
import { resolveDataDir } from './state/paths.ts';
import { PLUGIN_VERSION } from '../shared/version.ts';

/** 单次最多发几张：与交付扫描的上限同量级，避免一次刷屏。 */
export const CLI_MAX_IMAGES = 10;

/** 单条正文上限，与 `send.ts` 的硬上限一致。 */
export const CLI_MAX_TEXT = 4_000;

/** 用法错误的退出码；区分「参数写错」与「发失败」。 */
const USAGE_EXIT = 2;
const FAILURE_EXIT = 1;

/** 参数或前置条件不满足：消息是给人看的，退出码决定调用方怎么处理。 */
export class CliError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number = USAGE_EXIT) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export type CliCommand =
  | { kind: 'help' }
  | { kind: 'status'; json: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'image'; files: string[]; text: string | undefined };

export const USAGE = `dsh-wechat-send — 把文本或图片发到主人的微信

用法：
  dsh-wechat-send status [--json]          查看登录态、收件人与 context_token 是否可用
  dsh-wechat-send text <正文>              发一条文本
  dsh-wechat-send image <文件…> [--text 说明]  发图片（可多张），可附一句说明

说明：
  · 收件人固定是扫码登录的那个微信用户，不支持指定别人。
  · 图片先发、正文后发。
  · 需要主人最近给机器人发过消息（iLink 的 context_token 窗口），否则发不出去。
  · 支持 png / jpeg / webp / gif，单张 ≤ 10 MiB，一次 ≤ ${CLI_MAX_IMAGES} 张。

退出码：0 成功；1 发送或前置条件失败；2 参数写错。
`;

/** 解析命令行。只认文档里写过的形状，其余一律按用法错误处理。 */
export function parseArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    return { kind: 'help' };
  }
  if (first === 'status') {
    const unknown = rest.filter((arg) => arg !== '--json');
    if (unknown.length > 0) throw new CliError(`status 不认识参数：${unknown.join(' ')}`);
    return { kind: 'status', json: rest.includes('--json') };
  }
  if (first === 'text') {
    const text = rest.join(' ').trim();
    if (text === '') throw new CliError('text 需要一段正文');
    if (Array.from(text).length > CLI_MAX_TEXT) {
      throw new CliError(`正文超过 ${CLI_MAX_TEXT} 字符，请拆成多条或用 --text 只发说明`);
    }
    return { kind: 'text', text };
  }
  if (first === 'image') {
    const files: string[] = [];
    let text: string | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const arg = rest[index]!;
      if (arg === '--text') {
        const value = rest[index + 1];
        if (value === undefined || value === '') throw new CliError('--text 需要一个值');
        text = value;
        index += 1;
        continue;
      }
      if (arg.startsWith('--')) throw new CliError(`image 不认识参数：${arg}`);
      files.push(arg);
    }
    if (files.length === 0) throw new CliError('image 需要至少一个文件');
    if (files.length > CLI_MAX_IMAGES) {
      throw new CliError(`一次最多 ${CLI_MAX_IMAGES} 张，收到 ${files.length} 张`);
    }
    if (text !== undefined && Array.from(text).length > CLI_MAX_TEXT) {
      throw new CliError(`说明超过 ${CLI_MAX_TEXT} 字符`);
    }
    return { kind: 'image', files, text };
  }
  throw new CliError(`不认识的子命令：${first}`);
}

export interface PreparedImage {
  path: string;
  data: Buffer;
}

/**
 * 载入并校验待发图片。
 *
 * 按文件头认类型而不是看扩展名：微信客户端遇到它解不了的图只显示一个灰块，
 * 没有任何报错，所以在本地先拦下来。
 */
export async function prepareImages(paths: readonly string[]): Promise<PreparedImage[]> {
  const prepared: PreparedImage[] = [];
  for (const path of paths) {
    let info;
    try {
      info = await stat(path);
    } catch {
      throw new CliError(`找不到文件：${path}`);
    }
    if (!info.isFile()) throw new CliError(`不是普通文件：${path}`);
    if (info.size === 0) throw new CliError(`文件是空的：${path}`);
    if (info.size > MAX_IMAGE_BYTES) {
      throw new CliError(`${path} 超过 10 MiB（${Math.round(info.size / 1024)} KiB）`);
    }
    const data = await readFile(path);
    if (sniffImageType(data) === null) {
      throw new CliError(`${path} 不是支持的图片（png / jpeg / webp / gif）`);
    }
    prepared.push({ path, data });
  }
  return prepared;
}

/** 命令依赖的端口：真实实现读本机状态与 iLink，测试给假实现。 */
export interface CliPorts {
  /** 读登录态与 context_token；返回结构化结果，让命令决定提示什么。 */
  loadAuth(): Promise<
    | { kind: 'ok'; state: LoginState; token: string }
    | { kind: 'not-logged-in' }
    | { kind: 'missing-token'; state: LoginState }
  >;
  sendText(text: string): Promise<void>;
  sendImages(images: readonly PreparedImage[]): Promise<void>;
}

export interface CliDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  ports?: CliPorts;
  /** 覆盖数据目录（测试用）。 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  fetch?: typeof globalThis.fetch;
}

/** 真实端口：登录态与 token 只读不写，与宿主内运行期共享同一份状态。 */
export function createPorts(options: { dir: string; fetch?: typeof globalThis.fetch }): CliPorts {
  const { dir } = options;
  let cached: { state: LoginState; token: string } | null = null;

  const resolveAuth = async (): Promise<Awaited<ReturnType<CliPorts['loadAuth']>>> => {
    const state = await new LoginStateStore({ dir }).load();
    if (!state) return { kind: 'not-logged-in' };
    const recipient = (state.userId ?? '').trim();
    if (recipient === '') return { kind: 'not-logged-in' };
    const tokens = new ContextTokenStore({ dir });
    await tokens.hydrate(state.account);
    const token = tokens.get(state.account, recipient);
    if (token === undefined || token.trim() === '') return { kind: 'missing-token', state };
    cached = { state, token };
    return { kind: 'ok', state, token };
  };

  const auth = async (): Promise<{ state: LoginState; token: string }> => {
    if (cached) return cached;
    const loaded = await resolveAuth();
    if (loaded.kind !== 'ok') throw new CliError('登录态不可用', FAILURE_EXIT);
    return loaded;
  };

  const api = async () => {
    const { state } = await auth();
    return createApi({
      baseUrl: state.baseUrl,
      token: state.botToken,
      channelVersion: PLUGIN_VERSION,
      botAgent: `dsh-im-wechat/${PLUGIN_VERSION}`,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  };

  return {
    loadAuth: resolveAuth,
    async sendText(text: string): Promise<void> {
      const { state, token } = await auth();
      await sendText(await api(), {
        to: (state.userId ?? '').trim(),
        text,
        contextToken: token,
      });
    },
    async sendImages(images: readonly PreparedImage[]): Promise<void> {
      const { state, token } = await auth();
      const client = await api();
      const to = (state.userId ?? '').trim();
      for (const image of images) {
        const upload = await uploadImage(
          client,
          { data: image.data, toUserId: to },
          { cdnBaseUrl: DEFAULT_CDN_BASE_URL },
        );
        await sendImage(client, { to, upload, contextToken: token });
      }
    },
  };
}

/** 状态文案：只给主人看，不含 token。 */
function describeAuth(
  loaded: Awaited<ReturnType<CliPorts['loadAuth']>>,
): { lines: string[]; json: Record<string, unknown> } {
  if (loaded.kind === 'not-logged-in') {
    return {
      lines: ['未登录微信：先在设置面板扫码登录。'],
      json: { loggedIn: false },
    };
  }
  const tail = accountTail(loaded.state.account);
  const loggedInAt = new Date(loaded.state.loggedInAt).toISOString();
  if (loaded.kind === 'missing-token') {
    return {
      lines: [
        `已登录：${tail}（${loggedInAt}）`,
        '还不能发：缺少 context_token。',
        '处理：用主人的微信给机器人发一条消息，再重新执行。',
      ],
      json: { loggedIn: true, accountTail: tail, contextToken: false },
    };
  }
  return {
    lines: [
      `已登录：${tail}（${loggedInAt}）`,
      `收件人：${(loaded.state.userId ?? '').trim()}`,
      'context_token：可用',
      '可以发送。',
    ],
    json: { loggedIn: true, accountTail: tail, contextToken: true },
  };
}

/** 命令主入口：返回退出码，不直接退出进程，方便测试。 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));

  let command: CliCommand;
  try {
    command = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliError) {
      err(error.message);
      err('');
      err(USAGE.trimEnd());
      return error.exitCode;
    }
    throw error;
  }

  if (command.kind === 'help') {
    out(USAGE.trimEnd());
    return 0;
  }

  const dir = deps.dataDir ?? resolveDataDir(deps.env ?? process.env, deps.home);
  const ports = deps.ports ?? createPorts({ dir, ...(deps.fetch ? { fetch: deps.fetch } : {}) });

  if (command.kind === 'status') {
    const loaded = await ports.loadAuth();
    const described = describeAuth(loaded);
    if (command.json) out(JSON.stringify(described.json));
    else for (const line of described.lines) out(line);
    return loaded.kind === 'ok' ? 0 : FAILURE_EXIT;
  }

  try {
    const loaded = await ports.loadAuth();
    if (loaded.kind === 'not-logged-in') {
      throw new CliError('未登录微信：先在设置面板扫码登录，再重新执行。', FAILURE_EXIT);
    }
    if (loaded.kind === 'missing-token') {
      throw new CliError(
        '缺少 context_token：用主人的微信给机器人发一条消息，再重新执行。',
        FAILURE_EXIT,
      );
    }

    if (command.kind === 'image') {
      const images = await prepareImages(command.files);
      await ports.sendImages(images);
      out(`已发送图片 ${images.length} 张`);
      if (command.text !== undefined) {
        await ports.sendText(command.text);
        out('已发送说明');
      }
      return 0;
    }

    await ports.sendText(command.text);
    out('已发送');
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      err(error.message);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    err(`发送失败：${message}`);
    return FAILURE_EXIT;
  }
}
