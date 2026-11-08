/**
 * 出站命令的单元测试（ADR-0012）。
 *
 * 覆盖三类：参数解析、图片前置校验、发送分支与提示文案。真机路径（上传、加密、
 * 发送）由 `ilink-*` 的测试覆盖；这里用假端口，所以不联网、不碰真实登录态。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CLI_MAX_IMAGES,
  CliError,
  createPorts,
  parseArgs,
  prepareImages,
  runCli,
} from '../../src/host/cli.ts';
import type { CliPorts, PreparedImage } from '../../src/host/cli.ts';
import type { LoginState } from '../../src/host/state/login-state.ts';

/** 最小可用的 PNG 头，够 `sniffImageType` 认出来。 */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function fakeState(overrides: Partial<LoginState> = {}): LoginState {
  return {
    version: 1,
    botToken: 'bot-token',
    account: 'b0f5860fdecb@im.bot',
    userId: 'owner@im.wechat',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    loggedInAt: 1_760_000_000_000,
    ...overrides,
  };
}

function collector() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    out: (line: string) => lines.push(line),
    err: (line: string) => errors.push(line),
    lines,
    errors,
  };
}

test('parseArgs：help、status、text、image 的形状', () => {
  assert.deepEqual(parseArgs([]), { kind: 'help' });
  assert.deepEqual(parseArgs(['help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['--help']), { kind: 'help' });
  assert.deepEqual(parseArgs(['status']), { kind: 'status', json: false });
  assert.deepEqual(parseArgs(['status', '--json']), { kind: 'status', json: true });
  assert.deepEqual(parseArgs(['text', '你好', '世界']), { kind: 'text', text: '你好 世界' });
  assert.deepEqual(parseArgs(['image', 'a.png']), { kind: 'image', files: ['a.png'], text: undefined });
  assert.deepEqual(
    parseArgs(['image', 'a.png', 'b.png', '--text', '四张头像']),
    { kind: 'image', files: ['a.png', 'b.png'], text: '四张头像' },
  );
});

test('parseArgs：错误一律是用法错误（退出码 2）', () => {
  const cases: Array<[string[], RegExp]> = [
    [['nope'], /不认识的子命令/],
    [['text'], /需要一段正文/],
    [['text', '   '], /需要一段正文/],
    [['image'], /至少一个文件/],
    [['image', '--text', 'x'], /至少一个文件/],
    [['image', 'a.png', '--text'], /--text 需要一个值/],
    [['image', 'a.png', '--nope'], /不认识参数/],
    [['status', '--nope'], /不认识参数/],
  ];
  for (const [argv, pattern] of cases) {
    assert.throws(() => parseArgs(argv), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.exitCode, 2);
      assert.match(error.message, pattern);
      return true;
    });
  }
});

test('parseArgs：张数与正文长度有上限', () => {
  const tooMany = Array.from({ length: CLI_MAX_IMAGES + 1 }, (_, index) => `i${index}.png`);
  assert.throws(() => parseArgs(['image', ...tooMany]), /一次最多 10 张/);
  assert.throws(() => parseArgs(['text', 'x'.repeat(4_001)]), /超过 4000 字符/);
});

test('prepareImages：按文件头认类型，坏图与超限先拦下', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'));
  try {
    const good = join(dir, 'good.png');
    await writeFile(good, PNG_BYTES);
    const prepared = await prepareImages([good]);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0]!.path, good);

    const text = join(dir, 'fake.png');
    await writeFile(text, Buffer.from('not an image'));
    await assert.rejects(prepareImages([text]), /不是支持的图片/);

    await assert.rejects(prepareImages([join(dir, 'missing.png')]), /找不到文件/);

    const empty = join(dir, 'empty.png');
    await writeFile(empty, Buffer.alloc(0));
    await assert.rejects(prepareImages([empty]), /文件是空的/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('status：未登录时给出扫码提示并返回非 0', async () => {
  const sink = collector();
  const ports: CliPorts = {
    loadAuth: async () => ({ kind: 'not-logged-in' }),
    sendText: async () => undefined,
    sendImages: async () => undefined,
  };
  const code = await runCli(['status'], { ...sink, ports });
  assert.equal(code, 1);
  assert.match(sink.lines.join('\n'), /未登录微信/);
});

test('status：缺 context_token 时说明要先给机器人发消息', async () => {
  const sink = collector();
  const ports: CliPorts = {
    loadAuth: async () => ({ kind: 'missing-token', state: fakeState() }),
    sendText: async () => undefined,
    sendImages: async () => undefined,
  };
  const code = await runCli(['status'], { ...sink, ports });
  assert.equal(code, 1);
  const text = sink.lines.join('\n');
  assert.match(text, /缺少 context_token/);
  assert.match(text, /发一条消息/);
});

test('status --json 输出机器可读结果', async () => {
  const sink = collector();
  const ports: CliPorts = {
    loadAuth: async () => ({ kind: 'ok', state: fakeState(), token: 'ctx' }),
    sendText: async () => undefined,
    sendImages: async () => undefined,
  };
  const code = await runCli(['status', '--json'], { ...sink, ports });
  assert.equal(code, 0);
  const parsed = JSON.parse(sink.lines.join('\n'));
  assert.equal(parsed.loggedIn, true);
  assert.equal(parsed.contextToken, true);
});

test('text：发送成功后打印已发送；前置条件失败不调用端口', async () => {
  const sink = collector();
  const sent: string[] = [];
  const ports: CliPorts = {
    loadAuth: async () => ({ kind: 'ok', state: fakeState(), token: 'ctx' }),
    sendText: async (text) => { sent.push(text); },
    sendImages: async () => undefined,
  };
  assert.equal(await runCli(['text', '你好'], { ...sink, ports }), 0);
  assert.deepEqual(sent, ['你好']);
  assert.match(sink.lines.join('\n'), /已发送/);

  const missing: CliPorts = {
    loadAuth: async () => ({ kind: 'missing-token', state: fakeState() }),
    sendText: async () => { throw new Error('不该被调用'); },
    sendImages: async () => { throw new Error('不该被调用'); },
  };
  const sink2 = collector();
  assert.equal(await runCli(['text', '你好'], { ...sink2, ports: missing }), 1);
  assert.match(sink2.errors.join('\n'), /context_token/);
});

test('image：先发图再发说明，顺序与桥一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'));
  try {
    const one = join(dir, '1.png');
    await writeFile(one, PNG_BYTES);
    const order: string[] = [];
    const ports: CliPorts = {
      loadAuth: async () => ({ kind: 'ok', state: fakeState(), token: 'ctx' }),
      sendText: async () => { order.push('text'); },
      sendImages: async (images: readonly PreparedImage[]) => { order.push(`images:${images.length}`); },
    };
    const sink = collector();
    const code = await runCli(['image', one, '--text', '四张头像'], { ...sink, ports });
    assert.equal(code, 0);
    assert.deepEqual(order, ['images:1', 'text']);
    assert.match(sink.lines.join('\n'), /已发送图片 1 张/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('发送失败给出原因并非 0 退出', async () => {
  const sink = collector();
  const ports: CliPorts = {
    loadAuth: async () => ({ kind: 'ok', state: fakeState(), token: 'ctx' }),
    sendText: async () => { throw new Error('ret=-2 context_token 过期'); },
    sendImages: async () => undefined,
  };
  assert.equal(await runCli(['text', 'x'], { ...sink, ports }), 1);
  assert.match(sink.errors.join('\n'), /发送失败：ret=-2/);
});

test('用法错误额外打印用法说明', async () => {
  const sink = collector();
  const code = await runCli(['nope'], { ...sink, ports: {
    loadAuth: async () => ({ kind: 'not-logged-in' }),
    sendText: async () => undefined,
    sendImages: async () => undefined,
  } });
  assert.equal(code, 2);
  assert.match(sink.errors.join('\n'), /不认识的子命令/);
  assert.match(sink.errors.join('\n'), /用法/);
});

test('createPorts：无登录态时报告 not-logged-in，不联网', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'));
  try {
    const ports = createPorts({ dir });
    assert.equal((await ports.loadAuth()).kind, 'not-logged-in');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
