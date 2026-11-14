import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReminderCenter } from '../../src/host/reminder-center.ts';

const QUESTION = { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] };
const ROOT = { id: 'root-1', session: { header: {} } };

function harness(options: { delayMinutes?: number; enabled?: boolean } = {}) {
  const sent: string[] = [];
  const center = new ReminderCenter({
    send: async (text) => {
      sent.push(text);
      return true;
    },
    recipient: () => 'owner-1',
    isRoot: () => true,
    canApprove: () => true,
    isActive: () => true,
    now: () => 1_000,
    ...(options.delayMinutes !== undefined ? { delayMinutes: options.delayMinutes } : {}),
    ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
  });
  return { center, sent };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function ready(center: ReminderCenter, questions: number, approvals: number): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    const status = center.status();
    if (status.pendingQuestions >= questions && status.pendingApprovals >= approvals) return;
    await tick();
  }
}

/** 提醒一直不发答案的 next：模拟「Web 端在，但没人处理」。 */
const silent = () => new Promise(() => {});

test('默认设置：开、等 5 分钟', () => {
  const { center } = harness();
  assert.equal(center.enabled, true);
  assert.equal(center.delayMinutes, 5);
});

test('归属：提问先提醒、审批后提醒（各一条）时，「批准」落在审批上', async () => {
  const { center } = harness({ delayMinutes: 0 });
  const question = center.handleQuestion({ questions: [QUESTION], agent: ROOT }, silent, true);
  await ready(center, 1, 0);
  const approval = center.handleApproval({ toolName: 'bash', agent: ROOT }, silent, true);
  await ready(center, 1, 1);

  // 两个 broker 各自计数时这里是 1:1，提问会把「批准」吞成自由作答。
  assert.equal(center.reply('批准'), true);
  assert.equal(await approval, 'allowed-once');
  assert.equal(center.status().pendingQuestions, 1);
  center.cancelAll('测试结束');
  await assert.rejects(question, /测试结束/);
});

test('归属：提问发过两条后，审批的一条提醒仍然优先', async () => {
  const { center } = harness({ delayMinutes: 0 });
  const first = center.handleQuestion({ questions: [QUESTION], agent: ROOT }, silent, true);
  await ready(center, 1, 0);
  const second = center.handleQuestion({ questions: [{ ...QUESTION, id: 'q2' }], agent: ROOT }, silent, true);
  await ready(center, 2, 0);
  const approval = center.handleApproval({ toolName: 'bash', agent: ROOT }, silent, true);
  await ready(center, 2, 1);

  assert.equal(center.reply('批准'), true);
  assert.equal(await approval, 'allowed-once');
  assert.equal(center.status().pendingApprovals, 0);
  center.cancelAll('测试结束');
  await assert.rejects(first, /测试结束/);
  await assert.rejects(second, /测试结束/);
});

test('归属：审批先提醒、提问后提醒时，「批准」由提问认领（最后一条优先）', async () => {
  const { center } = harness({ delayMinutes: 0 });
  const approval = center.handleApproval({ toolName: 'bash', agent: ROOT }, silent, true);
  await ready(center, 0, 1);
  center.handleQuestion({ questions: [QUESTION], agent: ROOT }, silent, true);
  await ready(center, 1, 1);

  assert.equal(center.reply('批准'), true);
  // 单题提问认任意文本，这条「批准」成为它的自由作答。
  assert.equal(center.status().pendingQuestions, 0);
  assert.equal(center.status().pendingApprovals, 1);
  center.cancelAll('测试结束');
  void approval;
});

test('关掉开关：两个 broker 的待答都交回，不挂到超时', async () => {
  const { center } = harness({ delayMinutes: 0 });
  const question = center.handleQuestion({ questions: [QUESTION], agent: ROOT }, silent, true);
  await ready(center, 1, 0);
  center.handleApproval({ toolName: 'bash', agent: ROOT }, silent, true);
  await ready(center, 1, 1);

  center.configure({ enabled: false });
  assert.equal(center.enabled, false);
  assert.deepEqual(center.status(), { pendingQuestions: 0, pendingApprovals: 0 });
  await assert.rejects(question, /提醒已关闭/);
});

test('等待时间收窄到 0–120 分钟', () => {
  const { center } = harness();
  center.configure({ delayMinutes: 1e6 });
  assert.equal(center.delayMinutes, 120);
  center.configure({ delayMinutes: -3 });
  assert.equal(center.delayMinutes, 0);
  center.configure({ delayMinutes: Number.NaN });
  assert.equal(center.delayMinutes, 0);
  center.configure({ delayMinutes: 12.4 });
  assert.equal(center.delayMinutes, 12);
});

test('提醒文案带编号：两条待授权时回「批准 1」指定先发的那条', async () => {
  const { center, sent } = harness({ delayMinutes: 0 });
  const first = center.handleApproval({ toolName: 'bash', agent: ROOT }, silent, true);
  await ready(center, 0, 1);
  const second = center.handleApproval({ toolName: 'write', agent: ROOT }, silent, true);
  await ready(center, 0, 2);
  assert.match(sent[0]!, /需要你授权 #1：bash/);
  assert.match(sent[1]!, /需要你授权 #2：write/);

  assert.equal(center.reply('批准 1'), true);
  assert.equal(await first, 'allowed-once');
  assert.equal(center.status().pendingApprovals, 1);
  center.cancelAll('测试结束');
  void second;
});

test('提醒期间超过上限：最老的被交回，新来的仍在', async () => {
  const { center } = harness({ delayMinutes: 0 });
  const settled: Promise<unknown>[] = [];
  for (let i = 0; i < 22; i += 1) {
    settled.push(center.handleApproval({ toolName: `tool-${i}`, agent: ROOT }, silent, true));
    await sleep(2);
  }
  assert.equal(center.status().pendingApprovals, 20);
  center.cancelAll('测试结束');
  void settled;
});
