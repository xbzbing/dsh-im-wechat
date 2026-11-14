import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DirectChat } from '../../src/host/direct.ts';
import type { DirectController } from '../../src/host/direct.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import { DirectBindingStore } from '../../src/host/state/direct-binding.ts';

/** 只有一段文字的内容（组装与提示由 prompt-parts 负责）。 */
function text(value: string): PromptPart[] {
  return [{ type: 'text', text: value }];
}

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
  prompts: { requestId: string; sessionId: string; mode: string; text: string; content: readonly PromptPart[] }[];
  renames: string[];
  setRunning(value: boolean): void;
}

function fakeController(): FakeController {
  const created: { workspaceId?: string }[] = [];
  const prompts: { requestId: string; sessionId: string; mode: string; text: string; content: readonly PromptPart[] }[] = [];
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
      const text = request.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text, content: request.content });
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
  options: {
    workspaceId?: string;
    busyMode?: 'queue' | 'steer';
    controller?: FakeController | null;
    submitTimeoutMs?: number;
  } = {},
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
    ...(options.submitTimeoutMs !== undefined ? { submitTimeoutMs: options.submitTimeoutMs } : {}),
  });
  return { chat, store, sent, controller };
}

test('独立模式：非主人消息直接忽略，不建会话也不提交', async (t) => {
  const { chat, controller, sent } = await setup(t);
  assert.equal(await chat.submit('stranger', text('你好')), 'ignored');
  assert.deepEqual((controller as FakeController).created, []);
  assert.deepEqual((controller as FakeController).prompts, []);
  assert.deepEqual(sent, []);
});

test('独立模式：第一条消息按工作区建会话并绑定，之后复用同一个会话', async (t) => {
  const { chat, controller, store, sent } = await setup(t, { workspaceId: 'ws-a' });
  assert.equal(await chat.submit('owner-1', text('第一条')), 'queued');
  assert.equal(await chat.submit('owner-1', text('第二条')), 'queued');
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
  assert.equal(await chat.submit('owner-1', text('顺便看下日志')), 'steered');
  assert.deepEqual(fake.prompts.map((item) => item.mode), ['steer']);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /插进/);
});

test('独立模式：回合在跑但保持排队时用 queue 提交并提示在等这一轮', async (t) => {
  const { chat, controller, sent } = await setup(t, { busyMode: 'queue' });
  const fake = controller as FakeController;
  fake.setRunning(true);
  assert.equal(await chat.submit('owner-1', text('再补一句')), 'queued');
  assert.deepEqual(fake.prompts.map((item) => item.mode), ['queue']);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /结束/);
});

test('独立模式：本轮回答在 turn/end 时发回微信，只认绑定的会话', async (t) => {
  const { chat, sent } = await setup(t);
  await chat.submit('owner-1', text('开始'));
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
  await chat.submit('owner-1', text('开始'));
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
  await chat.submit('owner-1', text('第一条'));
  await chat.reset();
  assert.equal(store.get(), null);
  chat.handleEvent('s-1', { type: 'turn/end', data: { turn: 1 } });
  assert.equal(await chat.submit('owner-1', text('第二条')), 'queued');
  assert.deepEqual((controller as FakeController).created.length, 2);
});

test('独立模式：宿主没有会话服务时如实返回不可用', async (t) => {
  const { chat } = await setup(t, { controller: null });
  assert.equal(await chat.submit('owner-1', text('在吗')), 'unavailable');
  assert.equal(chat.status().available, false);
});

test('独立模式：宿主拒收时回一条失败提示', async (t) => {
  const controller = fakeController();
  controller.prompt = async () => {
    throw new Error('窗口已关闭');
  };
  const { chat, sent } = await setup(t, { controller });
  assert.equal(await chat.submit('owner-1', text('在吗')), 'failed');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /没能把消息交给会话/);
});

test('独立模式：图片作为附件交给会话，没写字时补一句提示', async (t) => {
  const { chat, controller } = await setup(t);
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'weixin-a.png' };
  assert.equal(await chat.submit('owner-1', [image]), 'queued');
  const content = (controller as FakeController).prompts[0]?.content ?? [];
  assert.deepEqual(content[0], { type: 'text', text: '请看这张图' });
  assert.deepEqual(content[1], image);
});

test('独立模式：文字与图片一起提交时文字在前，base64 原样透传', async (t) => {
  const { chat, controller } = await setup(t);
  const image = { type: 'image' as const, mediaType: 'image/jpeg' as const, data: '/9j/4AAQ', name: 'weixin-b.jpg' };
  assert.equal(await chat.submit('owner-1', [{ type: 'text', text: '这张图里的报错' }, image]), 'queued');
  const content = (controller as FakeController).prompts[0]?.content ?? [];
  assert.deepEqual(content, [{ type: 'text', text: '这张图里的报错' }, image]);
});

test('独立模式：空内容既不建会话也不提交', async (t) => {
  const { chat, controller, sent } = await setup(t);
  assert.equal(await chat.submit('owner-1', []), 'ignored');
  assert.deepEqual((controller as FakeController).prompts, []);
  assert.deepEqual((controller as FakeController).created, []);
  assert.deepEqual(sent, []);
});

test('独立模式：模型不支持看图时去掉图片用同一个 requestId 重发文字', async (t) => {
  const controller = fakeController();
  const seen: { requestId: string; hasImage: boolean; text: string }[] = [];
  controller.prompt = async (request) => {
    const hasImage = request.content.some((part) => part.type === 'image');
    const text = request.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    seen.push({ requestId: request.requestId, hasImage, text });
    if (hasImage) throw new Error('Model "text-only" does not support image input.');
    return { accepted: true };
  };
  const { chat, sent } = await setup(t, { controller });
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'weixin-a.png' };

  assert.equal(await chat.submit('owner-1', [{ type: 'text', text: '这张图里的报错' }, image]), 'queued');

  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.hasImage, true);
  assert.equal(seen[1]?.hasImage, false);
  assert.equal(seen[1]?.text, '这张图里的报错', '重发只带真实文字，不带补的提示');
  assert.equal(seen[0]?.requestId, seen[1]?.requestId, '同一个 requestId 让宿主去重');
  assert.match(sent.join('\n'), /图片没有发出去/);
});

test('独立模式：只有图片被拒收时不重发，直接说图片没发出去', async (t) => {
  const controller = fakeController();
  const seen: { hasImage: boolean }[] = [];
  controller.prompt = async (request) => {
    seen.push({ hasImage: request.content.some((part) => part.type === 'image') });
    throw new Error('Image batch exceeds the configured image-count limit.');
  };
  const { chat, sent } = await setup(t, { controller });
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'weixin-a.png' };

  assert.equal(await chat.submit('owner-1', [image]), 'failed');

  assert.equal(seen.length, 1, '没有文字可重发');
  assert.match(sent.join('\n'), /图片没有发出去/);
});

test('独立模式：只有文字被拒收时照旧报错，不做任何重发', async (t) => {
  const controller = fakeController();
  let calls = 0;
  controller.prompt = async () => {
    calls += 1;
    throw new Error('窗口已关闭');
  };
  const { chat, sent } = await setup(t, { controller });

  assert.equal(await chat.submit('owner-1', text('在吗')), 'failed');

  assert.equal(calls, 1);
  assert.match(sent.join('\n'), /没能把消息交给会话/);
});

test('独立模式：我们自己超时后不重发，只说可能已进入会话', async (t) => {
  const controller = fakeController();
  let calls = 0;
  controller.prompt = (_request, signal) => new Promise((_resolve, reject) => {
    calls += 1;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const { chat, sent } = await setup(t, { controller, submitTimeoutMs: 20 });
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'weixin-a.png' };

  assert.equal(await chat.submit('owner-1', [{ type: 'text', text: '看图' }, image]), 'failed');

  assert.equal(calls, 1, '超时后不再用文字重发');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /提交超时/);
  assert.match(sent[0]!, /可能已经进入会话/);
  // 微信侧只看到中文提示，不把宿主的英文异常原文发出去。
  assert.doesNotMatch(sent[0]!, /TimeoutError|aborted|The operation/);
});

test('独立模式：去掉图片重发也失败时，只报一次失败、不再说已按文字发送', async (t) => {
  const controller = fakeController();
  const seen: { hasImage: boolean }[] = [];
  controller.prompt = async (request) => {
    seen.push({ hasImage: request.content.some((part) => part.type === 'image') });
    throw new Error('窗口已关闭');
  };
  const { chat, sent } = await setup(t, { controller });
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'weixin-a.png' };

  assert.equal(await chat.submit('owner-1', [{ type: 'text', text: '看图' }, image]), 'failed');

  assert.deepEqual(seen, [{ hasImage: true }, { hasImage: false }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /没能把消息交给会话/);
  assert.doesNotMatch(sent[0]!, /已按文字发送/);
});

test('独立模式：排队时图片被拒，说明并进同一条回执，不连发两条', async (t) => {
  const controller = fakeController();
  let attempts = 0;
  controller.prompt = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Model "text-only" does not support image input.');
    return { accepted: true };
  };
  controller.setRunning(true);
  const { chat, sent } = await setup(t, { controller, busyMode: 'queue' });
  const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'iVBORw0KGgo=', name: 'weixin-a.png' };

  assert.equal(await chat.submit('owner-1', [{ type: 'text', text: '看图' }, image]), 'queued');

  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /交给会话/);
  assert.match(sent[0]!, /图片没有发出去/);
});
