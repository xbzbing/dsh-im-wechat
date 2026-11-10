/**
 * `/wechat` 命令的单元测试（ADR-0012）。
 *
 * 命令是给人用的通道，handler 直接执行、不进模型上下文；这里用假端口验证
 * 「输入框里怎么敲 → 发什么 → 回什么文案」，真机发送由 `ilink-*` 覆盖。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  COMMAND_HELP,
  planCommand,
  registerWeixinCommand,
  runWeixinCommand,
} from '../../src/host/command.ts';
import type { CommandScope } from '../../src/host/command.ts';
import type { CliPorts, PreparedImage } from '../../src/host/cli.ts';
import type { LoginState } from '../../src/host/state/login-state.ts';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeState(): LoginState {
  return {
    version: 1,
    botToken: 'bot-token',
    account: 'b0f5860fdecb@im.bot',
    userId: 'owner@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    loggedInAt: 1_760_000_000_000,
  };
}

function ports(overrides: Partial<CliPorts> = {}): CliPorts & { texts: string[]; images: number[] } {
  const texts: string[] = [];
  const images: number[] = [];
  return {
    texts,
    images,
    loadAuth: async () => ({ kind: 'ok', state: fakeState(), token: 'ctx' }),
    sendText: async (text: string) => { texts.push(text); },
    sendImages: async (list: readonly PreparedImage[]) => { images.push(list.length); },
    ...overrides,
  };
}

test('planCommand：裸文本、子命令与附件', () => {
  assert.deepEqual(planCommand('', false), { kind: 'help' });
  assert.deepEqual(planCommand('   ', false), { kind: 'help' });
  assert.deepEqual(planCommand('你好', false), { kind: 'text', text: '你好' });
  assert.deepEqual(planCommand('status', false), { kind: 'status' });
  assert.deepEqual(planCommand('text 你好 世界', false), { kind: 'text', text: '你好 世界' });
  assert.deepEqual(planCommand('image a.png b.png', false), {
    kind: 'image',
    files: ['a.png', 'b.png'],
    text: undefined,
  });
  assert.deepEqual(planCommand('image a.png --text 说明', false), {
    kind: 'image',
    files: ['a.png'],
    text: '说明',
  });
  assert.deepEqual(planCommand('', true), { kind: 'attachments', text: undefined });
  assert.deepEqual(planCommand('四张头像', true), { kind: 'attachments', text: '四张头像' });
});

test('planCommand：空正文与坏参数照旧报错', () => {
  assert.throws(() => planCommand('text   ', false), /需要一段正文/);
  assert.throws(() => planCommand('image', false), /至少一个文件/);
});

test('空输入回用法，不发送', async () => {
  const fake = ports();
  const outcome = await runWeixinCommand({ rawInput: '' }, { ports: fake });
  assert.equal(outcome.kind, 'success');
  assert.equal(outcome.text, COMMAND_HELP);
  assert.deepEqual(fake.texts, []);
});

test('裸文本发正文，回「已发送」', async () => {
  const fake = ports();
  const outcome = await runWeixinCommand({ rawInput: '代码已提交' }, { ports: fake });
  assert.equal(outcome.kind, 'success');
  assert.deepEqual(fake.texts, ['代码已提交']);
});

test('未登录与缺 token 各有明确提示，且不调用发送', async () => {
  const noLogin = ports({ loadAuth: async () => ({ kind: 'not-logged-in' }) });
  const first = await runWeixinCommand({ rawInput: '你好' }, { ports: noLogin });
  assert.equal(first.kind, 'error');
  assert.match(first.text, /未登录微信/);
  assert.deepEqual(noLogin.texts, []);

  const noToken = ports({ loadAuth: async () => ({ kind: 'missing-token', state: fakeState() }) });
  const second = await runWeixinCommand({ rawInput: '你好' }, { ports: noToken });
  assert.equal(second.kind, 'error');
  assert.match(second.text, /context_token/);
  assert.deepEqual(noToken.texts, []);
});

test('status 只回报状态，不发消息', async () => {
  const fake = ports();
  const outcome = await runWeixinCommand({ rawInput: 'status' }, { ports: fake });
  assert.equal(outcome.kind, 'success');
  assert.match(outcome.text, /可以发送/);
  assert.deepEqual(fake.texts, []);
  assert.deepEqual(fake.images, []);
});

test('image 子命令：先发图再发说明', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-cmd-'));
  try {
    const file = join(dir, 'a.png');
    await writeFile(file, PNG_BYTES);
    const fake = ports();
    const outcome = await runWeixinCommand({ rawInput: `image ${file} --text 头像` }, { ports: fake });
    assert.equal(outcome.kind, 'success');
    assert.deepEqual(fake.images, [1]);
    assert.deepEqual(fake.texts, ['头像']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('附件：按 readAttachments 读出的字节发送，缺能力时明确报错', async () => {
  const fake = ports();
  const outcome = await runWeixinCommand(
    { rawInput: '四张头像', attachments: [{ type: 'image' }, { type: 'image' }] },
    { ports: fake, readAttachments: async () => [
      { path: 'a', data: PNG_BYTES },
      { path: 'b', data: PNG_BYTES },
    ] },
  );
  assert.equal(outcome.kind, 'success');
  assert.deepEqual(fake.images, [2]);
  assert.deepEqual(fake.texts, ['四张头像']);

  const unsupported = await runWeixinCommand(
    { rawInput: '', attachments: [{ type: 'image' }] },
    { ports: fake },
  );
  assert.equal(unsupported.kind, 'error');
  assert.match(unsupported.text, /不支持读取输入框附件/);
});

test('发送异常转成 error 结果，不抛给 UI', async () => {
  const fake = ports({ sendText: async () => { throw new Error('ret=-2 窗口关闭'); } });
  const outcome = await runWeixinCommand({ rawInput: '你好' }, { ports: fake });
  assert.equal(outcome.kind, 'error');
  assert.match(outcome.text, /ret=-2/);
});

test('registerWeixinCommand：注册 /wechat 并申请附件能力', () => {
  const registered: any[] = [];
  const disposers: Array<() => void> = [];
  const scope = {
    commands: {
      register(definition: any) {
        registered.push(definition);
        const dispose = () => undefined;
        disposers.push(dispose);
        return dispose;
      },
    },
    effect(execute: () => unknown) { execute(); },
  } as unknown as CommandScope;

  registerWeixinCommand(scope, { dir: '/tmp/does-not-matter' });
  assert.equal(registered.length, 1);
  const definition = registered[0]!;
  assert.equal(definition.name, 'wechat');
  assert.equal(definition.input.attachments, true);
  assert.equal(typeof definition.handler, 'function');
  assert.equal(disposers.length, 1);
});

test('registerWeixinCommand：没有 commands 服务时安静跳过', () => {
  const scope = { effect(execute: () => unknown) { execute(); } } as unknown as CommandScope;
  assert.doesNotThrow(() => registerWeixinCommand(scope, { dir: '/tmp/x' }));
});

test('热重载重叠：/wechat 重复注册不炸，先离场的实例不摘命令', () => {
  const warnings: unknown[][] = [];
  let registrations = 0;
  let disposed = 0;
  const face = {
    register() {
      // 只计成功：第二次是尝试注册并被良性捕获（真实宿主对同名命令抛错）。
      if (registrations >= 1) throw new Error('command already registered');
      registrations += 1;
      return () => {
        disposed += 1;
      };
    },
  };
  const makeCtx = () => {
    const cleanups: (() => void)[] = [];
    const scope = {
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      commands: face,
      effect(execute: () => unknown) {
        const dispose = execute();
        if (typeof dispose === 'function') cleanups.push(dispose as () => void);
      },
    } as unknown as CommandScope;
    registerWeixinCommand(scope, { dir: '/tmp/x' });
    return { cleanups };
  };

  const first = makeCtx();
  const second = makeCtx();
  assert.equal(registrations, 1, '同名命令只该注册一次');
  assert.equal(warnings.some((args) => String(args[0]).includes('接管')), true);

  // 重叠期旧实例先清理：命令不能被摘掉（原 bug：先离场的把后到的资源清没了）。
  for (const cleanup of first.cleanups) cleanup();
  assert.equal(disposed, 0);

  // 后到的实例才是最后离场的：它清理后命令真正注销。
  for (const cleanup of second.cleanups) cleanup();
  assert.equal(disposed, 1);
});
