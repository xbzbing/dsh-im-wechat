import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_LONG_TASK_MINUTES,
  LongTaskNotifier,
  longTaskText,
  normalizeLongTaskMinutes,
  textFromAssistantMessage,
} from '../../src/host/long-tasks.ts';
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

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('阈值默认 30 分钟：29 分钟不发，31 分钟发', async () => {
  const sent: string[] = [];
  const notifier = new LongTaskNotifier({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'owner-1',
    isRoot: () => true,
  });
  assert.equal(DEFAULT_LONG_TASK_MINUTES, 30);
  notifier.configure(true);

  notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 29 * 60_000));
  await flush();
  assert.equal(sent.length, 0);

  notifier.handleEvent('s1', event('turn/start', { turn: 2 }, 0));
  notifier.handleEvent('s1', event('turn/end', { turn: 2 }, 31 * 60_000));
  await flush();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /耗时：31分0秒/);
});

test('改阈值后对下一个回合立即生效，不用重建跟踪器', async () => {
  const h = harness();
  // harness 的阈值是 10 分钟；面板改成 1 小时后，11 分钟的回合不再提醒。
  h.notifier.setThresholdMs(60 * 60_000);
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 11 * 60_000));
  await flush();
  assert.equal(h.sent.length, 0);

  h.notifier.setThresholdMs(5 * 60_000);
  h.notifier.handleEvent('s1', event('turn/start', { turn: 2 }, 0));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 2 }, 11 * 60_000));
  await flush();
  assert.equal(h.sent.length, 1);
});

test('分钟数收窄到 1–1440，非数字交给默认值', () => {
  assert.equal(normalizeLongTaskMinutes(45), 45);
  assert.equal(normalizeLongTaskMinutes(12.6), 13);
  assert.equal(normalizeLongTaskMinutes(0), 1);
  assert.equal(normalizeLongTaskMinutes(99_999), 1_440);
  assert.equal(normalizeLongTaskMinutes('30'), undefined);
  assert.equal(normalizeLongTaskMinutes(Number.NaN), undefined);
  assert.equal(normalizeLongTaskMinutes(Number.POSITIVE_INFINITY), undefined);
});

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

test('回合中途主人插过话就不算无人值守，不发提醒', async () => {
  const h = harness();
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  // 第一条用户消息是回合的开头 prompt，不算插话；第二条才是中途插话。
  h.notifier.handleEvent('s1', event('user/message', { source: { kind: 'user' } }, 100));
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
  h.notifier.handleEvent('s2', event('turn/end', { turn: 1, reason: { kind: 'error' } }, 15 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /未命名会话/);
  assert.match(h.sent[0], /结果：执行失败/);
});

test('目标先到、后到都能出现在提醒里', async () => {
  const h = harness();
  // 先到：goal/change 在 turn/start 之前。
  h.notifier.handleEvent('s1', { type: 'goal/change', time: 0, data: { operation: 'create', goal: { id: 'g', phase: 'active', objective: '把设置页重做' } } });
  h.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 20 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.sent[0], /目标：把设置页重做/);

  // 后到：回合进行中才建目标。
  const h2 = harness();
  h2.notifier.handleEvent('s1', event('turn/start', { turn: 1 }, 0));
  h2.notifier.handleEvent('s1', { type: 'goal/change', time: 1_000, data: { operation: 'create', goal: { id: 'g', phase: 'active', objective: '补测试' } } });
  h2.notifier.handleEvent('s1', event('turn/end', { turn: 1 }, 20 * 60_000));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h2.sent[0], /目标：补测试/);
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
