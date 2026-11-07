import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LongTaskNotifier, longTaskText, textFromAssistantMessage } from '../../src/host/long-tasks.ts';
import { RootAgents } from '../../src/host/host-agents.ts';

const THRESHOLD = 10 * 60_000;

function event(type: string, data: Record<string, unknown> = {}, time = 0): Record<string, unknown> {
  return { type, seq: 1, time, data };
}

/** `session/event.data` 的形状：助手消息在 `message.content` 里。 */
function assistant(text: string): Record<string, unknown> {
  return { message: { content: [{ type: 'text', text }, { type: 'reasoning', text: '不想被看到' }] } };
}

function assistantMessage(text: string): { content: unknown[] } {
  return { content: [{ type: 'text', text }, { type: 'reasoning', text: '不想被看到' }] };
}

function harness(options: { sendOk?: boolean; root?: boolean } = {}) {
  const sent: string[] = [];
  let clock = 0;
  const notifier = new LongTaskNotifier({
    send: async (text) => {
      sent.push(text);
      return options.sendOk !== false;
    },
    recipient: () => 'owner-1',
    isRoot: () => options.root !== false,
    titleOf: (id) => (id === 's1' ? '重构设置页' : null),
    now: () => clock,
    thresholdMs: THRESHOLD,
  });
  notifier.configure(true);
  return { notifier, sent, advance: (ms: number) => { clock += ms; } };
}

test('超过阈值的回合结束时发提醒，正文含标题/耗时/结论', async () => {
  const h = harness();
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('assistant/message', assistant('改完了，3 个文件。'), 1_000));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 11 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /长任务提醒 · 重构设置页/);
  assert.match(h.sent[0], /耗时：11分0秒/);
  assert.match(h.sent[0], /结果：已完成/);
  assert.match(h.sent[0], /改完了，3 个文件。/);
  assert.equal(h.sent[0].includes('不想被看到'), false);
  assert.equal(h.notifier.tracking, 0);
});

test('没超过阈值不发提醒', async () => {
  const h = harness();
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 0);
});

test('回合里主人插过话就不算无人值守，不发提醒', async () => {
  const h = harness();
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('user/message', { source: { kind: 'user' } }, 1_000));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 20 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 0);
});

test('子会话的回合不提醒', async () => {
  const h = harness({ root: false });
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 20 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 0);
});

test('停用后不再跟踪，也不发提醒', async () => {
  const h = harness();
  h.notifier.configure(false);
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 20 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 0);
  assert.equal(h.notifier.tracking, 0);
});

test('失败回合标注执行失败；没有标题时用「未命名会话」', async () => {
  const h = harness();
  h.notifier.handleEvent('s2', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s2', event('turn/end', { turn: 1, error: { message: 'boom' } }, 15 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /未命名会话/);
  assert.match(h.sent[0], /结果：执行失败/);
});

test('超长结论截断而不是整条丢弃', () => {
  const text = longTaskText({
    title: '任务',
    durationMs: 12 * 60_000,
    failed: false,
    answer: 'x'.repeat(3_000),
    maxChars: 100,
  });
  assert.equal(text.length, 100);
  assert.match(text, /…$/);
});

test('只取可见文本块', () => {
  assert.equal(textFromAssistantMessage(assistantMessage('可见')), '可见');
  assert.equal(textFromAssistantMessage({ content: [{ type: 'tool', text: 'x' }] }), '');
  assert.equal(textFromAssistantMessage(null), '');
});

test('根会话识别：未知服务放行，已知服务按 roots 判断', () => {
  const roots = new RootAgents();
  assert.equal(roots.isRoot('any'), true);
  roots.attach({ roots: () => [{ id: 's1' }] });
  assert.equal(roots.isRoot('s1'), true);
  assert.equal(roots.isRoot('s2'), false);
  assert.equal(roots.isRoot(null), false);
  roots.attach(null);
  assert.equal(roots.isRoot('s2'), true);
});

test('agents 服务抛错时退化成放行而不是崩溃', () => {
  const roots = new RootAgents();
  roots.attach({
    roots: () => {
      throw new Error('boom');
    },
  });
  assert.equal(roots.isRoot('x'), true);
});
