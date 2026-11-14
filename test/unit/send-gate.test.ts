import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ReminderGate } from '../../src/host/send-gate.ts';

function harness(now = 0) {
  let clock = now;
  const gate = new ReminderGate({ now: () => clock, perMinute: 3, minGapMs: 1_000 });
  return { gate, advance: (ms: number) => { clock += ms; } };
}

test('每分钟预算用完就不再发', () => {
  const { gate, advance } = harness();
  assert.equal(gate.tryTake(), true);
  advance(1_000);
  assert.equal(gate.tryTake(), true);
  advance(1_000);
  assert.equal(gate.tryTake(), true);
  advance(1_000);
  assert.equal(gate.tryTake(), false);
  // 窗口滑过第一条之后腾出一个位置。
  advance(58_000);
  assert.equal(gate.tryTake(), true);
});

test('两条之间留最小间隔，连发会被挡', () => {
  const { gate, advance } = harness();
  assert.equal(gate.tryTake(), true);
  advance(500);
  assert.equal(gate.tryTake(), false);
  advance(500);
  assert.equal(gate.tryTake(), true);
});

test('被挡掉的尝试不记账：等够了仍然能发满预算', () => {
  const { gate, advance } = harness();
  assert.equal(gate.tryTake(), true);
  for (let i = 0; i < 5; i += 1) assert.equal(gate.tryTake(), false);
  advance(1_000);
  assert.equal(gate.tryTake(), true);
  advance(1_000);
  assert.equal(gate.tryTake(), true);
  advance(1_000);
  assert.equal(gate.tryTake(), false);
});
