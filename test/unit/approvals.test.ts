import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApprovalBroker, parseDecision, reminderText } from '../../src/host/approvals.ts';

/** 每次调用给一份新的请求对象：broker 会原地替换 `signal`，复用同一个对象会把上一次的取消带过来。 */
function request() {
  return { toolName: 'bash', reason: '需要写文件', agent: { id: 'root-1', session: { header: {} } } };
}

function harness(options: {
  sent?: boolean;
  delayMs?: number;
  enabled?: boolean;
  waitMs?: number;
  canApprove?: boolean;
} = {}) {
  const sent: string[] = [];
  const broker = new ApprovalBroker({
    send: async (text) => {
      sent.push(text);
      return options.sent !== false;
    },
    recipient: () => 'owner-1',
    canApprove: () => options.canApprove ?? true,
    ...(options.delayMs !== undefined ? { delayMs: () => options.delayMs! } : {}),
    ...(options.enabled !== undefined ? { enabled: () => options.enabled! } : {}),
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
  return { broker, sent };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 等 broker 把 pending 注册好（提醒发送与两次竞速都是异步的）。 */
async function ready(broker: ApprovalBroker, count = 1): Promise<void> {
  for (let i = 0; i < 40 && broker.snapshot().pending < count; i += 1) await tick();
}

test('提醒文案带编号与工具名，原因压成一行并截断', () => {
  const text = reminderText({ toolName: 'bash', reason: '需要写文件\n第二行' }, 3);
  assert.match(text, /需要你授权 #3：bash/);
  assert.match(text, /需要写文件 第二行/);
  assert.match(text, /「批准 3」/);
  // 原因来自宿主，可能很长：截断后仍是一条能发出去的提醒。
  const long = reminderText({ toolName: 'bash', reason: 'x'.repeat(500) }, 1);
  assert.ok(long.length < 400, `提醒过长：${long.length}`);
  assert.match(long, /…/);
  assert.match(reminderText({}, 1), /某个工具/);
});

test('回复「批准」给 allowed-once 并回执，回复「拒绝」给 rejected', async () => {
  const first = harness();
  const approved = first.broker.handle(request(), () => new Promise(() => {}), true);
  await ready(first.broker);
  assert.equal(first.broker.reply('批准'), true);
  assert.equal(await approved, 'allowed-once');
  await tick();
  assert.match(first.sent.at(-1)!, /已批准：bash（#1）/);

  const second = harness();
  const rejected = second.broker.handle(request(), () => new Promise(() => {}), true);
  await ready(second.broker);
  assert.equal(second.broker.reply('拒绝。'), true);
  assert.equal(await rejected, 'rejected');
  await tick();
  assert.match(second.sent.at(-1)!, /已拒绝：bash（#1）/);
});

test('模糊或过宽的话不算决定：不认领，交回普通消息路径', async () => {
  const { broker } = harness();
  broker.handle(request(), () => new Promise(() => {}), true);
  await ready(broker);
  for (const text of ['你看着办', '批准一下', 'y', 'n', '通过', '允许', 'ok']) {
    assert.equal(broker.reply(text), false, text);
  }
  assert.equal(broker.snapshot().pending, 1);
  broker.cancelAll();
  assert.equal(broker.snapshot().pending, 0);
});

test('文案里的「批准」连引号一起回也能认', () => {
  assert.deepEqual(parseDecision('「批准」'), { outcome: 'allowed-once' });
  assert.deepEqual(parseDecision('“拒绝”'), { outcome: 'rejected' });
  assert.deepEqual(parseDecision('批准 3'), { outcome: 'allowed-once', no: 3 });
  assert.deepEqual(parseDecision('拒绝#2'), { outcome: 'rejected', no: 2 });
  assert.equal(parseDecision('批准 0'), null);
});

test('Web 没人接（unavailable）时照发提醒', async () => {
  const { broker, sent } = harness({ delayMs: 5 });
  const outcome = broker.handle(request(), async () => 'unavailable', true);
  await sleep(20);
  assert.equal(sent.length, 1);
  // 交回时 Web 的结局就是 unavailable，不是我们自己编的。
  broker.cancelAll();
  assert.equal(await outcome, 'unavailable');
});

test('Web 端先处理：不发提醒，原样返回 Web 的结局', async () => {
  const { broker, sent } = harness({ delayMs: 5_000 });
  const outcome = await broker.handle(request(), async () => 'rejected', true);
  assert.equal(outcome, 'rejected');
  assert.deepEqual(sent, []);
});

test('停用/关闭时交回 Web：返回 Web 后来的答案，而不是把它变成拒绝', async () => {
  const { broker } = harness({ delayMs: 0 });
  const answer = deferred<unknown>();
  const pending = broker.handle(request(), () => answer.promise, true);
  await ready(broker);
  broker.cancelAll('插件已停止');
  assert.equal(broker.snapshot().pending, 0);
  answer.resolve('allowed-once');
  assert.equal(await pending, 'allowed-once');
});

test('多条待答时认最后一条；带编号时认指定那条', async () => {
  const { broker } = harness({ delayMs: 0 });
  const first = broker.handle(request(), () => new Promise(() => {}), true);
  await ready(broker);
  const second = broker.handle({ ...request(), toolName: 'write' }, () => new Promise(() => {}), true);
  await ready(broker, 2);

  assert.equal(broker.reply('批准'), true);
  assert.equal(await second, 'allowed-once');
  assert.equal(broker.snapshot().pending, 1);

  assert.equal(broker.reply('拒绝 1'), true);
  assert.equal(await first, 'rejected');
  assert.equal(broker.snapshot().pending, 0);
});

test('宿主取消请求：不发提醒，直接 cancelled', async () => {
  const { broker, sent } = harness({ delayMs: 50 });
  const controller = new AbortController();
  const pending = broker.handle({ ...request(), signal: controller.signal }, () => new Promise(() => {}), true);
  await sleep(5);
  controller.abort();
  assert.equal(await pending, 'cancelled');
  assert.deepEqual(sent, []);
});

test('微信一直没答：窗口到点交回 Web，由它收尾', async () => {
  const { broker, sent } = harness({ delayMs: 0, waitMs: 20 });
  const answer = deferred<unknown>();
  const pending = broker.handle(request(), () => answer.promise, true);
  await sleep(40);
  assert.equal(sent.length, 1);
  assert.equal(broker.snapshot().pending, 0);
  answer.resolve('rejected');
  assert.equal(await pending, 'rejected');
});

test('提醒发不出去：不接管，交回 Web', async () => {
  const { broker, sent } = harness({ delayMs: 0, sent: false });
  const outcome = await broker.handle(request(), async () => 'unavailable', true);
  assert.equal(sent.length, 1);
  assert.equal(outcome, 'unavailable');
  assert.equal(broker.snapshot().pending, 0);
});

test('审批提醒关掉：直接交给 Web，一条都不发', async () => {
  const { broker, sent } = harness({ enabled: false });
  const outcome = await broker.handle(request(), async () => 'allowed-once', true);
  assert.equal(outcome, 'allowed-once');
  assert.deepEqual(sent, []);
  assert.equal(broker.snapshot().pending, 0);
});

test('非根会话不接管（授权走严格判据）', async () => {
  const { broker, sent } = harness({ canApprove: false });
  const outcome = await broker.handle(request(), async () => 'unavailable', true);
  assert.equal(outcome, 'unavailable');
  assert.deepEqual(sent, []);
});
