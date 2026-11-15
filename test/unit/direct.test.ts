import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { DirectChat } from '../../src/host/direct.ts';
import { DirectBindingStore } from '../../src/host/state/direct-binding.ts';
import type { FakeController } from './helpers/direct-fixtures.ts';
import { fakeController, flush, setup, tempDir, text } from './helpers/direct-fixtures.ts';

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

test('独立模式：钉模型在提交之前，新建的会话与已绑定的会话都走这条', async (t) => {
  // 顺序与「补钉」都是行为：宿主按会话记着的模型选择决定这一轮用哪个模型。
  const events: string[] = [];
  const dir = tempDir(t);
  const base = fakeController();
  const controller: FakeController = {
    ...base,
    created: base.created,
    prompts: base.prompts,
    renames: base.renames,
    setRunning: base.setRunning,
    async prompt(request, signal) {
      events.push(`prompt:${request.sessionId}`);
      return base.prompt(request, signal);
    },
  };
  const chat = new DirectChat({
    controller: () => controller,
    store: new DirectBindingStore({ dir }),
    workspaceId: () => '',
    busyMode: () => 'queue',
    send: async () => true,
    isOwner: (sender) => sender === 'owner-1',
    ownerLabel: () => 'abc123',
    applyModel: (sessionId) => events.push(`model:${sessionId}`),
  });

  assert.equal(await chat.submit('owner-1', text('第一条')), 'queued');
  assert.equal(await chat.submit('owner-1', text('第二条')), 'queued');
  // 新建会话那条也是「先钉模型、再提交」；第二条走的是已绑定的会话，同样提交前补钉。
  assert.deepEqual(events, ['model:s-1', 'prompt:s-1', 'model:s-1', 'prompt:s-1']);
});

test('独立模式：已有绑定时也会在提交前补钉（宿主重启后会话还没 resume 的情况）', async (t) => {
  const applied: string[] = [];
  const { chat, controller, store } = await setup(t, { applyModel: (sessionId) => applied.push(sessionId) });
  await store.set('s-bound', '');
  assert.equal(await chat.submit('owner-1', text('第一条')), 'queued');
  // 幂等交给回调实现（同一个会话同一个值只钉一次），这里只保证「提交前调过」。
  assert.deepEqual(applied, ['s-bound']);
  assert.deepEqual((controller as FakeController).prompts.map((item) => item.sessionId), ['s-bound']);
});

test('独立模式：绑定记下会话标题，宿主改名后跟着更新并落盘', async (t) => {
  const { chat, store } = await setup(t);
  await chat.submit('owner-1', text('第一条'));
  assert.equal(store.get()?.title, '微信 · abc123');

  chat.handleEvent('s-1', { type: 'session/title', data: { title: '改过的名字' } });
  assert.equal(store.get()?.title, '改过的名字');

  // 标题落盘是异步的（事件回调不阻塞）：等写链清空再重读。
  await store.flush();
  // 重新读盘：标题不是只在内存里，重启后面板仍显示完整会话名。
  const reloaded = new DirectBindingStore({ dir: join((store as unknown as { path(): string }).path(), '..') });
  await reloaded.hydrate();
  assert.equal(reloaded.get()?.title, '改过的名字');
});

test('独立模式：连续插话只在间隔超过 30 秒时提示一次', async (t) => {
  // 连发几条补充说明时，每条都回一句「已插进本轮」会刷屏。
  let clock = 1_700_000_000_000;
  const controller = fakeController();
  controller.setRunning(true);
  const { chat, sent } = await setup(t, { controller, busyMode: 'steer', now: () => clock });

  assert.equal(await chat.submit('owner-1', text('第一条')), 'steered');
  assert.equal(sent.length, 1);
  clock += 5_000;
  assert.equal(await chat.submit('owner-1', text('第二条')), 'steered');
  assert.equal(sent.length, 1, '5 秒后的连发不再提示');
  clock += 20_000;
  assert.equal(await chat.submit('owner-1', text('第三条')), 'steered');
  assert.equal(sent.length, 1, '距上一条 20 秒仍算连发');
  clock += 30_000;
  assert.equal(await chat.submit('owner-1', text('第四条')), 'steered');
  assert.equal(sent.length, 2, '隔了 30 秒、前一轮还在跑，才再确认一次');
  assert.match(sent[1]!, /已插进正在跑的这一轮/);
});

/** 跑一回合：可选的模型选择、助手消息与失败的尝试，最后 turn/end。 */
async function runTurn(
  chat: DirectChat,
  options: {
    text?: string;
    model?: string;
    usage?: Record<string, number>;
    selection?: { model: string; reasoningEffort?: string };
    attempts?: Record<string, number>[];
    sessionId?: string;
  } = {},
) {
  const sessionId = options.sessionId ?? 's-1';
  chat.handleEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
  if (options.selection) {
    chat.handleEvent(sessionId, { type: 'model/selection', data: { provider: 'p', ...options.selection } });
  }
  for (const usage of options.attempts ?? []) {
    chat.handleEvent(sessionId, {
      type: 'assistant/attempt',
      data: { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }] },
    });
  }
  if (options.text !== undefined) {
    const message = { source: { provider: 'p', model: options.model ?? 'm' }, content: [{ type: 'text', text: options.text }] };
    chat.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message, ...(options.usage !== undefined ? { usage: options.usage } : {}) },
    });
  }
  chat.handleEvent(sessionId, { type: 'turn/end', data: { turn: 1 } });
  await flush();
}

test('独立模式：状态信息开关关着时，回复不附加状态行', async (t) => {
  const { chat, sent } = await setup(t);
  await chat.submit('owner-1', text('开始'));
  await runTurn(chat, { text: '答案', selection: { model: 'm', reasoningEffort: 'high' }, usage: { inputTokens: 9, outputTokens: 1 } });
  assert.deepEqual(sent, ['答案']);
});

test('独立模式：打开状态信息后，回复末尾追加模型、推理、消耗与时间', async (t) => {
  const at = new Date(2026, 10, 5, 9, 7).getTime();
  const { chat, sent } = await setup(t, { replyStatus: () => true, now: () => at });
  await chat.submit('owner-1', text('开始'));
  await runTurn(chat, { text: '答案', selection: { model: 'm', reasoningEffort: 'high' }, usage: { inputTokens: 9, outputTokens: 1 } });
  assert.deepEqual(sent, ['答案\n\n---\n模型 m · 推理 high · 消耗 10 tokens · 时间 11-05 09:07']);
});

test('独立模式：拿不到模型与用量时整行不出现', async (t) => {
  const { chat, sent } = await setup(t, { replyStatus: () => true });
  await chat.submit('owner-1', text('开始'));
  // 只有正文、没有来源也没有用量（老宿主或被打断的回合）。
  chat.handleEvent('s-1', { type: 'turn/start', data: { turn: 1 } });
  chat.handleEvent('s-1', { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '答案' }] } } });
  chat.handleEvent('s-1', { type: 'turn/end', data: { turn: 1 } });
  await flush();
  assert.deepEqual(sent, ['答案']);
});

test('独立模式：失败重试的那次尝试也算进消耗', async (t) => {
  const at = new Date(2026, 10, 5, 9, 7).getTime();
  const { chat, sent } = await setup(t, { replyStatus: () => true, now: () => at });
  await chat.submit('owner-1', text('开始'));
  await runTurn(chat, {
    text: '答案',
    model: 'm',
    attempts: [{ inputTokens: 40, outputTokens: 10 }],
    usage: { inputTokens: 9, outputTokens: 1 },
  });
  assert.match(sent[0]!, /消耗 60 tokens/);
});

test('独立模式：分条时状态行只跟在最后一条，且不顶破单条上限', async (t) => {
  const at = new Date(2026, 10, 5, 9, 7).getTime();
  const { chat, sent } = await setup(t, { replyStatus: () => true, now: () => at, maxText: 600 });
  await chat.submit('owner-1', text('开始'));
  await runTurn(chat, { text: '长'.repeat(500), model: 'm', usage: { inputTokens: 9, outputTokens: 1 } });
  assert.ok(sent.length > 1, '超长回答要分条');
  assert.doesNotMatch(sent.slice(0, -1).join('\n'), /---/, '前面的分条不带状态行');
  assert.match(sent.at(-1)!, /\n\n---\n模型 m · 消耗 10 tokens · 时间 11-05 09:07$/);
  for (const part of sent) assert.ok(Buffer.byteLength(part, 'utf8') <= 600, '每一条都不超过单条上限');
});

test('独立模式：状态行按回合统计，后一轮不带上一轮的 token', async (t) => {
  let clock = new Date(2026, 1, 1, 8, 0).getTime();
  const { chat, sent } = await setup(t, { replyStatus: () => true, now: () => clock });
  await chat.submit('owner-1', text('开始'));
  await runTurn(chat, { text: '第一轮', model: 'm1', usage: { inputTokens: 90, outputTokens: 10 } });
  clock += 60_000;
  await runTurn(chat, { text: '第二轮', model: 'm2', usage: { inputTokens: 4, outputTokens: 1 } });
  assert.match(sent[0]!, /模型 m1 · 消耗 100 tokens · 时间 02-01 08:00$/);
  assert.match(sent[1]!, /模型 m2 · 消耗 5 tokens · 时间 02-01 08:01$/);
});

test('独立模式：没收到 turn/start（插件中途接管）也不带出上一轮的统计', async (t) => {
  const at = new Date(2026, 1, 1, 8, 0).getTime();
  const { chat, sent } = await setup(t, { replyStatus: () => true, now: () => at });
  await chat.submit('owner-1', text('开始'));
  await runTurn(chat, { text: '第一轮', model: 'm1', usage: { inputTokens: 90, outputTokens: 10 } });
  // 只有 turn/end 与回答：上一轮的 token 已经在取走时清掉，这一轮没有可报告的。
  chat.handleEvent('s-1', { type: 'assistant/message', data: { message: { source: { provider: 'p', model: 'm2' }, content: [{ type: 'text', text: '第二轮' }] } } });
  chat.handleEvent('s-1', { type: 'turn/end', data: { turn: 1 } });
  await flush();
  assert.deepEqual(sent[1], '第二轮\n\n---\n模型 m2 · 时间 02-01 08:00');
});

test('独立模式：面板状态带着状态信息开关', async (t) => {
  const { chat } = await setup(t, { replyStatus: () => true });
  assert.equal(chat.status().replyStatus, true);
});
