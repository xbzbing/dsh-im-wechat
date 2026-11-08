import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DirectChat } from '../../src/host/direct.ts';
import type { DirectController } from '../../src/host/direct.ts';
import { DirectBindingStore } from '../../src/host/state/direct-binding.ts';

/** 回复是异步发送的：等它跑完再断言。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-direct-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface FakeController extends DirectController {
  created: { workspaceId?: string }[];
  prompts: { sessionId: string; mode: string; text: string }[];
  renames: string[];
  setRunning(value: boolean): void;
}

function fakeController(): FakeController {
  const created: { workspaceId?: string }[] = [];
  const prompts: { sessionId: string; mode: string; text: string }[] = [];
  const renames: string[] = [];
  let running = false;
  return {
    created,
    prompts,
    renames,
    setRunning(value: boolean) {
      running = value;
    },
    async create(request: { workspaceId?: string }) {
      created.push(request);
      return { sessionId: `s-${created.length}` };
    },
    async prompt(request, _signal) {
      const text = request.content.map((part) => part.text).join('');
      prompts.push({ sessionId: request.sessionId, mode: request.mode, text });
      return { accepted: true };
    },
    async rename(request: { sessionId: string; title: string }) {
      renames.push(`${request.sessionId}:${request.title}`);
    },
    async list() {
      return { items: [{ sessionId: 's-1', running }] };
    },
  };
}

async function setup(
  t: { after: (fn: () => void) => void },
  options: { workspaceId?: string; busyMode?: 'queue' | 'steer'; controller?: FakeController | null } = {},
) {
  const dir = tempDir(t);
  const store = new DirectBindingStore({ dir });
  await store.hydrate();
  const sent: string[] = [];
  const controller = options.controller === undefined ? fakeController() : options.controller;
  const chat = new DirectChat({
    controller: () => controller,
    store,
    workspaceId: () => options.workspaceId ?? '',
    busyMode: () => options.busyMode ?? 'queue',
    send: async (text: string) => {
      sent.push(text);
      return true;
    },
    isOwner: (sender) => sender === 'owner-1',
    ownerLabel: () => 'abc123',
    now: () => 1_700_000_000_000,
  });
  return { chat, store, sent, controller };
}

test('独立模式：非主人消息直接忽略，不建会话也不提交', async (t) => {
  const { chat, controller, sent } = await setup(t);
  assert.equal(await chat.submit('stranger', '你好'), 'ignored');
  assert.deepEqual((controller as FakeController).created, []);
  assert.deepEqual((controller as FakeController).prompts, []);
  assert.deepEqual(sent, []);
});

test('独立模式：第一条消息按工作区建会话并绑定，之后复用同一个会话', async (t) => {
  const { chat, controller, store, sent } = await setup(t, { workspaceId: 'ws-a' });
  assert.equal(await chat.submit('owner-1', '第一条'), 'queued');
  assert.equal(await chat.submit('owner-1', '第二条'), 'queued');
  const fake = controller as FakeController;
  assert.deepEqual(fake.created, [{ workspaceId: 'ws-a' }]);
  assert.deepEqual(fake.prompts.map((item) => item.sessionId), ['s-1', 's-1']);
  assert.deepEqual(fake.prompts.map((item) => item.mode), ['queue', 'queue']);
  assert.deepEqual(fake.renames, ['s-1:微信 · abc123']);
  assert.equal(store.get()?.sessionId, 's-1');
  // 空闲时不发「已排队」噪音提示。
  assert.deepEqual(sent, []);
});

test('独立模式：回合在跑 + 插话模式时用 steer 提交并回执一句', async (t) => {
  const { chat, controller, sent } = await setup(t, { busyMode: 'steer' });
  const fake = controller as FakeController;
  fake.setRunning(true);
  assert.equal(await chat.submit('owner-1', '顺便看下日志'), 'steered');
  assert.deepEqual(fake.prompts.map((item) => item.mode), ['steer']);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /插进/);
});

test('独立模式：回合在跑但保持排队时用 queue 提交并提示在等这一轮', async (t) => {
  const { chat, controller, sent } = await setup(t, { busyMode: 'queue' });
  const fake = controller as FakeController;
  fake.setRunning(true);
  assert.equal(await chat.submit('owner-1', '再补一句'), 'queued');
  assert.deepEqual(fake.prompts.map((item) => item.mode), ['queue']);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /结束/);
});

test('独立模式：本轮回答在 turn/end 时发回微信，只认绑定的会话', async (t) => {
  const { chat, sent } = await setup(t);
  await chat.submit('owner-1', '开始');
  chat.handleEvent('other-session', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '别的会话' }] } } });
  chat.handleEvent('s-1', { type: 'turn/start', data: { turn: 1 } });
  chat.handleEvent('s-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一段' }] } } });
  chat.handleEvent('s-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '最终回答' }] } } });
  assert.deepEqual(sent, [], '回合没结束时先不发');
  chat.handleEvent('s-1', { type: 'turn/end', data: { turn: 1 } });
  await flush();
  assert.deepEqual(sent, ['最终回答']);
});

test('独立模式：回答按 Markdown 渲染后再发，超长按段分条', async (t) => {
  const { chat, sent } = await setup(t);
  await chat.submit('owner-1', '开始');
  chat.handleEvent('s-1', { type: 'turn/start', data: { turn: 1 } });
  const answer = `**结论**\n\n${'长'.repeat(2_000)}`;
  chat.handleEvent('s-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } });
  chat.handleEvent('s-1', { type: 'turn/end', data: { turn: 1 } });
  await flush();
  assert.ok(sent.length > 1, '超过 1800 字要分条');
  assert.match(sent[0]!, /\*\*结论\*\*/);
});

test('独立模式：重置绑定后下一条消息重新建会话', async (t) => {
  const { chat, controller, store } = await setup(t);
  await chat.submit('owner-1', '第一条');
  await chat.reset();
  assert.equal(store.get(), null);
  chat.handleEvent('s-1', { type: 'turn/end', data: { turn: 1 } });
  assert.equal(await chat.submit('owner-1', '第二条'), 'queued');
  assert.deepEqual((controller as FakeController).created.length, 2);
});

test('独立模式：宿主没有会话服务时如实返回不可用', async (t) => {
  const { chat } = await setup(t, { controller: null });
  assert.equal(await chat.submit('owner-1', '在吗'), 'unavailable');
  assert.equal(chat.status().available, false);
});

test('独立模式：宿主拒收时回一条失败提示', async (t) => {
  const controller = fakeController();
  controller.prompt = async () => {
    throw new Error('窗口已关闭');
  };
  const { chat, sent } = await setup(t, { controller });
  assert.equal(await chat.submit('owner-1', '在吗'), 'failed');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /没能把消息交给会话/);
});
