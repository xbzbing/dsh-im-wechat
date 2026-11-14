import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApprovalBroker, reminderText } from '../../src/host/approvals.ts';

/** 每次调用给一份新的请求对象：broker 会原地替换 `signal`，复用同一个对象会把上一次的取消带过来。 */
function request() {
  return { toolName: 'bash', reason: '需要写文件', agent: { id: 'root-1' } };
}

function harness(options: { sent?: boolean; delayMs?: number; enabled?: boolean; waitMs?: number } = {}) {
  const sent: string[] = [];
  const broker = new ApprovalBroker({
    send: async (text) => {
      sent.push(text);
      return options.sent !== false;
    },
    recipient: () => 'owner-1',
    canApprove: () => true,
    now: () => 1_000,
    ...(options.delayMs !== undefined ? { delayMs: () => options.delayMs! } : {}),
    ...(options.enabled !== undefined ? { enabled: () => options.enabled! } : {}),
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
  });
  return { broker, sent };
}

/** 等 broker 把 pending 注册好（提醒发送是异步的）。 */
async function ready(broker: ApprovalBroker): Promise<void> {
  for (let i = 0; i < 20 && broker.snapshot().pending === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('提醒文案带工具名与原因，并说明怎么回复', () => {
  const text = reminderText(request());
  assert.match(text, /需要你授权：bash/);
  assert.match(text, /需要写文件/);
  assert.match(text, /「批准」或「拒绝」/);
  // 缺工具名时也给一句能读的话，不出现 undefined。
  assert.match(reminderText({}), /某个工具/);
});

test('回复「批准」给 allowed-once，回复「拒绝」给 rejected', async () => {
  const first = harness();
  // Web 一直不答：等主人从微信回。
  const approved = first.broker.handle(request(), async () => new Promise(() => {}), true);
  await ready(first.broker);
  assert.equal(first.broker.reply('批准'), true);
  assert.equal(await approved, 'allowed-once');

  const second = harness();
  const rejected = second.broker.handle(request(), async () => new Promise(() => {}), true);
  await ready(second.broker);
  assert.equal(second.broker.reply('拒绝。'), true);
  assert.equal(await rejected, 'rejected');
});

test('模糊的话不算决定：不认领，交回普通消息路径', async () => {
  const { broker } = harness();
  const pending = broker.handle(request(), async () => new Promise(() => {}), true);
  await ready(broker);
  assert.equal(broker.reply('你看着办'), false);
  assert.equal(broker.reply('批准一下'), false);
  assert.equal(broker.snapshot().pending, 1);
  broker.cancelAll();
  await assert.rejects(pending, /插件已停止/);
});

test('Web 端先处理：不发提醒，原样返回 Web 的结局', async () => {
  const { broker, sent } = harness({ delayMs: 5_000 });
  const outcome = await broker.handle(request(), async () => 'rejected', true);
  assert.equal(outcome, 'rejected');
  assert.deepEqual(sent, []);
});

test('等待到点才提醒；提醒发出后 Web 端仍能收尾', async () => {
  const { broker, sent } = harness({ delayMs: 5 });
  const result = broker.handle(request(), async () => new Promise(() => {}), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 1);
  // 到点没人答就交回 Web：这里 Web 一直不答，取消后按 stopped 收尾。
  broker.cancelAll();
  await assert.rejects(result, /插件已停止/);
});

test('审批提醒关掉：直接交给 Web，一条都不发', async () => {
  const { broker, sent } = harness({ enabled: false });
  const outcome = await broker.handle(request(), async () => 'allowed-once', true);
  assert.equal(outcome, 'allowed-once');
  assert.deepEqual(sent, []);
  assert.equal(broker.snapshot().pending, 0);
});

test('非根会话不接管', async () => {
  const sent: string[] = [];
  const broker = new ApprovalBroker({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'owner-1',
    canApprove: () => false,
  });
  const outcome = await broker.handle(request(), async () => 'unavailable', true);
  assert.equal(outcome, 'unavailable');
  assert.deepEqual(sent, []);
});
