/**
 * 斜杠命令 `/wechat`（ADR-0012）。
 *
 * 命令是**给人用的**通道：`ctx.commands.register` 的 handler 直接执行，不经过
 * 模型（`dsh-commands` 的契约写的是「execute without sending the command to the
 * model」），模型也没有对应工具。所以这里只服务「主人在输入框里自己发」；
 * 模型主动发走同目录的 `cli.ts`，两者共用一套参数解析与发送端口。
 *
 * 附件按宿主 `attachments` 服务读字节：命令声明 `input.attachments` 之后，
 * 输入框里拖进来的图片会随调用一起送到；没有该服务时明确报错，不假装成功。
 */

import { CliError, USAGE, createPorts, parseArgs, prepareImages, runCli } from './cli.ts';
import type { CliPorts, PreparedImage } from './cli.ts';
import { injectOptional, messageOf } from './host-context.ts';
import type { PluginContext } from './host-context.ts';

/** 命令能拿到的宿主侧最小形状。 */
export interface CommandScope extends PluginContext {
  commands?: {
    register(definition: {
      name: string;
      description: string;
      input?: { hint: string; attachments?: boolean };
      recordInput?: boolean;
      handler: (invocation: CommandInvocation) => Promise<CommandOutcome> | CommandOutcome;
    }): () => void;
  };
  attachments?: {
    readImage(ref: unknown, signal?: AbortSignal): Promise<{ data: Uint8Array }>;
  };
}

/** 宿主派发进来的一次调用。 */
export interface CommandInvocation {
  rawInput: string;
  attachments?: readonly MessageAttachment[];
  signal?: AbortSignal;
}

/** 宿主消息里的图片块（只取用得到的字段）。 */
export interface MessageAttachment {
  type?: string;
  attachment?: unknown;
}

/** 命令结果：宿主直接渲染文本，不进模型上下文。 */
export interface CommandOutcome {
  kind: 'success' | 'error';
  text: string;
}

/** 命令的输入意图。 */
export type CommandPlan =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'text'; text: string }
  | { kind: 'image'; files: string[]; text: string | undefined }
  | { kind: 'attachments'; text: string | undefined };

/**
 * 把输入框里的一行解析成意图。
 *
 * 与 CLI 的差别只有一条：裸文本也算发正文（`/wechat 你好` 比 `/wechat text 你好` 顺手），
 * 带附件且没写子命令时按「发附件」处理。
 */
export function planCommand(rawInput: string, hasAttachments: boolean): CommandPlan {
  const input = rawInput.trim();
  if (input === '') {
    if (hasAttachments) return { kind: 'attachments', text: undefined };
    return { kind: 'help' };
  }
  const [first] = input.split(/\s+/, 1);
  if (first === 'status') return { kind: 'status' };
  if (first === 'text') {
    const text = input.slice(first.length).trim();
    if (text === '') throw new CliError('text 需要一段正文');
    return { kind: 'text', text };
  }
  if (first === 'image') {
    const parsed = parseArgs(['image', ...input.slice(first.length).trim().split(/\s+/).filter((part) => part !== '')]);
    if (parsed.kind !== 'image') throw new CliError('image 参数不合法');
    return { kind: 'image', files: parsed.files, text: parsed.text };
  }
  if (hasAttachments) return { kind: 'attachments', text: input };
  return { kind: 'text', text: input };
}

/** 命令用法（输入框里 `/wechat` 不带参数时显示）。 */
export const COMMAND_HELP = `用法：
/wechat status                      查看登录态与能不能发
/wechat <正文>                       发一条文本
/wechat image <路径…> [--text 说明]   发本地图片
/wechat <说明> + 拖入图片            发输入框里的图片`;

export interface CommandDeps {
  /** 发送端口；默认按数据目录读状态后直连 iLink。 */
  ports?: CliPorts;
  /** 读输入框附件；缺省时带附件的调用直接报错。 */
  readAttachments?: () => Promise<PreparedImage[]>;
}

/** 执行一次命令调用。异常一律转成 `error` 结果，不把栈丢给 UI。 */
export async function runWeixinCommand(
  invocation: CommandInvocation,
  deps: CommandDeps,
): Promise<CommandOutcome> {
  let plan: CommandPlan;
  try {
    const attachments = invocation.attachments ?? [];
    plan = planCommand(invocation.rawInput, attachments.length > 0);
  } catch (error) {
    return { kind: 'error', text: messageOf(error) };
  }

  if (plan.kind === 'help') return { kind: 'success', text: COMMAND_HELP };

  const ports = deps.ports;
  if (!ports) return { kind: 'error', text: '发送端口不可用' };

  try {
    const loaded = await ports.loadAuth();
    if (loaded.kind === 'not-logged-in') {
      return { kind: 'error', text: '未登录微信：先在设置面板扫码登录。' };
    }
    if (loaded.kind === 'missing-token') {
      return {
        kind: 'error',
        text: '缺少 context_token：先用微信给机器人发一条消息，再执行。',
      };
    }

    if (plan.kind === 'status') {
      return { kind: 'success', text: `已登录：${loaded.state.userId ?? ''}\n可以发送。` };
    }

    if (plan.kind === 'attachments') {
      if (!deps.readAttachments) {
        return { kind: 'error', text: '当前宿主不支持读取输入框附件，请改用 image <路径>' };
      }
      const images = await deps.readAttachments();
      if (images.length === 0) return { kind: 'error', text: '没有可发送的图片' };
      await ports.sendImages(images);
      if (plan.text !== undefined) await ports.sendText(plan.text);
      return { kind: 'success', text: `已发送图片 ${images.length} 张${plan.text !== undefined ? '，并发送说明' : ''}` };
    }

    if (plan.kind === 'image') {
      const images = await prepareImages(plan.files);
      await ports.sendImages(images);
      if (plan.text !== undefined) await ports.sendText(plan.text);
      return { kind: 'success', text: `已发送图片 ${images.length} 张${plan.text !== undefined ? '，并发送说明' : ''}` };
    }

    await ports.sendText(plan.text);
    return { kind: 'success', text: '已发送' };
  } catch (error) {
    return { kind: 'error', text: error instanceof CliError ? error.message : `发送失败：${messageOf(error)}` };
  }
}

/**
 * 把 `/wechat` 注册到宿主。
 *
 * 走 `injectOptional`：没有 `commands` 服务（headless 之类）时插件照常加载，
 * 只是没有这条命令（ADR-0003 的同一套取舍）。
 */
export function registerWeixinCommand(ctx: PluginContext, options: { dir: string }): void {
  injectOptional(ctx, 'commands', (base) => {
    const scope = base as CommandScope;
    const commands = scope.commands;
    if (!commands || typeof commands.register !== 'function') return;

    const readAttachmentsFrom = async (
      attachments: readonly MessageAttachment[],
      signal: AbortSignal | undefined,
    ): Promise<PreparedImage[]> => {
      const store = scope.attachments;
      if (!store || typeof store.readImage !== 'function') {
        throw new CliError('当前宿主不支持读取输入框附件，请改用 image <路径>');
      }
      const prepared: PreparedImage[] = [];
      for (const block of attachments) {
        if (block.type !== 'image' || block.attachment === undefined) continue;
        const stored = await store.readImage(block.attachment, signal);
        prepared.push({ path: 'attachment', data: Buffer.from(stored.data) });
      }
      return prepared;
    };

    scope.effect?.(() => commands.register({
      name: 'wechat',
      description: '把文本或图片发到你的微信（收件人固定是扫码登录的主人）',
      input: { hint: '正文｜status｜image <路径…>｜直接拖入图片', attachments: true },
      recordInput: true,
      handler: (invocation: CommandInvocation) => {
        const attachments = invocation.attachments ?? [];
        return runWeixinCommand(invocation, {
          ports: createPorts({ dir: options.dir }),
          ...(attachments.length > 0
            ? { readAttachments: () => readAttachmentsFrom(attachments, invocation.signal) }
            : {}),
        });
      },
    }), 'dsh-im-wechat: /wechat 命令');
  });
}

/** 供 CLI 复用：没有命令上下文时也能打印同一份用法。 */
export function commandUsage(): string {
  return `${COMMAND_HELP}\n\n命令行用法：\n${USAGE.trimEnd()}`;
}

/** 仅为保持与 CLI 一致的导出面（测试与调试用）。 */
export { runCli };
