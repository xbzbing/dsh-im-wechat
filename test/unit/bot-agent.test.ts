/**
 * `bot_agent` 的清洗与跨进程一致：CLI 与插件必须发出同一个 UA。
 *
 * 官方规范是 UA 形态：`Name/Version` 空格分隔、可带 ` (comment)`、仅 ASCII、总长 ≤256 字节，
 * 不合规的片段静默丢弃。我们照它清洗；清洗后为空就用产品默认值。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  BOT_AGENT_MAX_BYTES,
  BotAgentStore,
  resolveBotAgent,
  sanitizeBotAgent,
} from '../../src/host/bot-agent.ts';
import { createPorts } from '../../src/host/cli.ts';
import { WeixinRuntime } from '../../src/host/runtime.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import { PLUGIN_VERSION } from '../../src/shared/version.ts';
import { ACCOUNT, LOGIN, OWNER, fakeApi, withDir } from './helpers/runtime-harness.ts';

const DEFAULT = `dsh-im-wechat/${PLUGIN_VERSION}`;

test('清洗：合规的 UA 原样保留', () => {
  assert.equal(sanitizeBotAgent('MyBot/1.2.0'), 'MyBot/1.2.0');
  assert.equal(sanitizeBotAgent('MyBot/1.2.0 LangChain/0.3.5'), 'MyBot/1.2.0 LangChain/0.3.5');
  assert.equal(sanitizeBotAgent('MyBot/1.2.0 (region=cn;env=prod)'), 'MyBot/1.2.0 (region=cn;env=prod)');
  assert.equal(sanitizeBotAgent('MyBot/1.2.0-rc.1+build.5'), 'MyBot/1.2.0-rc.1+build.5');
  assert.equal(sanitizeBotAgent('  MyBot/1.2.0  '), 'MyBot/1.2.0');
});

test('清洗：不合规的片段静默丢弃', () => {
  assert.equal(sanitizeBotAgent('我的机器人/1.0'), '');
  assert.equal(sanitizeBotAgent('MyBot'), '');
  assert.equal(sanitizeBotAgent('MyBot/'), '');
  assert.equal(sanitizeBotAgent('MyBot/1.2.0 垃圾'), 'MyBot/1.2.0');
  assert.equal(sanitizeBotAgent('MyBot/1.2.0 (中文说明)'), 'MyBot/1.2.0');
  assert.equal(sanitizeBotAgent('https://example.com/x'), '');
  assert.equal(sanitizeBotAgent('   '), '');
  assert.equal(sanitizeBotAgent(undefined), '');
  assert.equal(sanitizeBotAgent(''), '');
});

test('清洗：总长不超过 256 字节，超了从尾部丢 token', () => {
  const many = Array.from({ length: 60 }, (_, index) => `Agent${index}/1.0`).join(' ');
  const cleaned = sanitizeBotAgent(many);
  assert.ok(Buffer.byteLength(cleaned, 'utf8') <= BOT_AGENT_MAX_BYTES);
  assert.ok(cleaned.startsWith('Agent0/1.0'));
  assert.equal(cleaned.includes('Agent59/1.0'), false);
});

test('有效值：清洗为空时回退产品默认', () => {
  assert.equal(resolveBotAgent(), DEFAULT);
  assert.equal(resolveBotAgent('   '), DEFAULT);
  assert.equal(resolveBotAgent('我的机器人/1.0'), DEFAULT);
  assert.equal(resolveBotAgent('MyBot/1.2.0'), 'MyBot/1.2.0');
});

test('落盘：写入后可读回，且只存清洗后的值', async () => {
  await withDir(async (dir) => {
    const store = new BotAgentStore({ dir });
    await store.save('MyBot/1.2.0 (中文说明)');
    assert.equal(await store.load(), 'MyBot/1.2.0');
  });
});

test('落盘：文件缺失或损坏都当作没有值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wa-'));
  try {
    const store = new BotAgentStore({ dir });
    assert.equal(await store.load(), undefined);
    await writeFile(join(dir, 'bot-agent.json'), '{ 坏掉的');
    assert.equal(await store.load(), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('插件启动把有效 UA 落盘，供 CLI 读同一个值', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, botAgent: 'MyBot/1.2.0' },
      createApi: api.createApi,
    });
    await runtime.start();
    await runtime.stop();
    assert.equal(await new BotAgentStore({ dir }).load(), 'MyBot/1.2.0');
  });
});

test('没有配置时插件落盘的是产品默认 UA', async () => {
  await withDir(async (dir) => {
    const api = fakeApi();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    await runtime.start();
    await runtime.stop();
    assert.equal(await new BotAgentStore({ dir }).load(), DEFAULT);
  });
});

/** 造一份能发消息的状态：登录态 + 主人 token。 */
async function seedSendable(dir: string): Promise<void> {
  await new LoginStateStore({ dir }).save(LOGIN);
  const tokens = new ContextTokenStore({ dir });
  tokens.set(ACCOUNT, OWNER, 'context-token');
  await tokens.flush();
}

test('CLI 发出的 base_info.bot_agent 与插件落盘的一致', async () => {
  await withDir(async (dir) => {
    await seedSendable(dir);
    await new BotAgentStore({ dir }).save('MyBot/1.2.0');
    const bodies: unknown[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
      return new Response(JSON.stringify({ ret: 0, message_id: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const ports = createPorts({ dir, fetch });
    await ports.sendText('你好');

    const sent = bodies.at(-1) as { base_info?: { bot_agent?: string } };
    assert.equal(sent.base_info?.bot_agent, 'MyBot/1.2.0');
  });
});

test('插件没落过盘时 CLI 用产品默认 UA', async () => {
  await withDir(async (dir) => {
    await seedSendable(dir);
    const bodies: unknown[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body);
      return new Response(JSON.stringify({ ret: 0, message_id: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const ports = createPorts({ dir, fetch });
    await ports.sendText('你好');

    const sent = bodies.at(-1) as { base_info?: { bot_agent?: string } };
    assert.equal(sent.base_info?.bot_agent, DEFAULT);
  });
});

test('落盘文件只给本人读', async () => {
  await withDir(async (dir) => {
    const store = new BotAgentStore({ dir });
    await store.save('MyBot/1.2.0');
    const mode = (await (await import('node:fs/promises')).stat(join(dir, 'bot-agent.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
    const raw = JSON.parse(await readFile(join(dir, 'bot-agent.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), ['agent']);
  });
});
