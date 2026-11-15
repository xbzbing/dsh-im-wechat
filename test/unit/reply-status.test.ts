import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ReplyMeter,
  composeReplyParts,
  formatClock,
  formatReplyStatus,
  formatTokenCount,
  usageTotal,
} from '../../src/host/reply-status.ts';

test('token 用量：有 totalTokens 就用总数，否则按输入、输出与缓存求和', () => {
  assert.equal(usageTotal({ inputTokens: 100, outputTokens: 20, totalTokens: 150 }), 150);
  assert.equal(usageTotal({ inputTokens: 100, outputTokens: 20 }), 120);
  assert.equal(usageTotal({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 5 }), 155);
  // 缺必填项、字段形状不对都按「这一条没有可用的用量」处理，不写进统计。
  assert.equal(usageTotal({ inputTokens: 100 }), undefined);
  assert.equal(usageTotal({ inputTokens: 100, outputTokens: 20, cacheReadTokens: -1 }), undefined);
  assert.equal(usageTotal(null), undefined);
});

test('token 数展示：千位取整，百万位最多一位小数且不带多余的 .0', () => {
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1_000), '1K');
  assert.equal(formatTokenCount(12_345), '12K');
  assert.equal(formatTokenCount(999_999), '1M');
  assert.equal(formatTokenCount(1_000_000), '1M');
  assert.equal(formatTokenCount(1_010_000), '1M');
  assert.equal(formatTokenCount(1_250_000), '1.3M');
});

test('时间：按本机时区显示 MM-DD HH:mm，非法时间戳省略', () => {
  assert.equal(formatClock(new Date(2026, 0, 2, 3, 4).getTime()), '01-02 03:04');
  assert.equal(formatClock(Number.NaN), undefined);
});

test('状态行：模型、推理等级、消耗与时间拼成一行，缺的项省略', () => {
  const at = new Date(2026, 10, 5, 9, 7).getTime();
  assert.equal(
    formatReplyStatus({ model: 'deepseek-chat', effort: 'high', tokens: 12_345 }, at),
    '---\n模型 deepseek-chat · 推理 high · 消耗 12K tokens · 时间 11-05 09:07',
  );
  assert.equal(formatReplyStatus({ model: 'm' }, at), '---\n模型 m · 时间 11-05 09:07');
  assert.equal(formatReplyStatus({}, at), undefined, '一项可报告的都没有时不加状态行');
});

test('回合统计：多步用量累加，模型取助手消息，推理等级跨回合沿用', () => {
  const meter = new ReplyMeter();
  meter.observeSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' });
  meter.startTurn();
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 100, outputTokens: 20 } });
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 50 } });
  assert.deepEqual(meter.take(), { model: 'm', effort: 'high', tokens: 400 });

  // 已取走：下一轮不会带上上一轮的消耗；选择没变时等级沿用。
  meter.startTurn();
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 10, outputTokens: 1 } });
  assert.deepEqual(meter.take(), { model: 'm', effort: 'high', tokens: 11 });
});

test('回合统计：选择记的模型与本轮消息不一致时不显示推理等级', () => {
  const meter = new ReplyMeter();
  meter.observeSelection({ provider: 'p', model: 'old', reasoningEffort: 'high' });
  // 清空选择换了会话、或接入核心期间漏收了选择事件：宁可省略，也不挂别人的等级。
  meter.startTurn();
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'other' } }, usage: { totalTokens: 5 } });
  assert.deepEqual(meter.take(), { model: 'other', tokens: 5 });

  // 新模型没有推理等级：旧值同样不能用。
  meter.observeSelection({ provider: 'p', model: 'other' });
  meter.startTurn();
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'other' } }, usage: { totalTokens: 5 } });
  assert.deepEqual(meter.take(), { model: 'other', tokens: 5 });
});

test('回合统计：没有落成消息的尝试也计入消耗，且不与消息重复', () => {
  const meter = new ReplyMeter();
  meter.startTurn();
  meter.observeAttempt({ stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } } }] });
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'm' } }, usage: { totalTokens: 100 } });
  // 两次尝试两次用量：失败那次也真的计费。
  meter.observeAttempt({ stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [1], texts: ['半句'] }] });
  assert.equal(meter.take().tokens, 135);
});

test('回合统计：取走后清零，下一轮不会累积上一轮的 token', () => {
  const meter = new ReplyMeter();
  meter.startTurn();
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 10, outputTokens: 5 } });
  assert.equal(meter.take().tokens, 15);
  // 没有 turn/start 时也不带旧值：取走即清零。
  meter.observeAssistant({ message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 2, outputTokens: 1 } });
  assert.equal(meter.take().tokens, 3);
});

test('状态行只有一行：模型 id 里的换行与控制字符被压平', () => {
  const meter = new ReplyMeter();
  meter.observeSelection({ provider: 'p', model: 'm\n恶意', reasoningEffort: 'high\n---' });
  meter.startTurn();
  meter.observeAssistant({
    message: { source: { provider: 'p', model: 'm\n恶意' } },
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const line = formatReplyStatus(meter.take(), new Date(2026, 0, 1, 8, 0).getTime());
  assert.equal(line, '---\n模型 m 恶意 · 推理 high --- · 消耗 2 tokens · 时间 01-01 08:00');
  assert.equal(line?.split('\n').length, 2, '分隔线加一行统计');
});

test('分条：状态行只跟在最后一条，且不把单条顶出上限', () => {
  const rendered = '长'.repeat(400);
  const footer = '---\n模型 deepseek-reasoner · 推理 high · 消耗 12K tokens · 时间 11-05 09:07';
  const parts = composeReplyParts(rendered, 600, footer);
  assert.ok(parts.length > 1, '400 个中文超过 600 字节，要分条');
  assert.doesNotMatch(parts.slice(0, -1).join('\n'), /---/);
  assert.match(parts.at(-1)!, /\n\n---\n模型 deepseek-reasoner/);
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part, 'utf8') <= 600, `每一条都不超过上限：${Buffer.byteLength(part, 'utf8')}`);
  }
  // 开关关着（没有状态行）时按原样分条。
  assert.deepEqual(composeReplyParts('短', 600, undefined), ['短']);
});

test('分条：上限太小、扣完状态行就没多少时，不拆正文', () => {
  const footer = '---\n模型 m';
  const parts = composeReplyParts('中'.repeat(60), 200, footer);
  assert.equal(parts.length, 1, '不为了给状态行腾地方把正文拆碎');
  assert.match(parts[0]!, /中\n\n---\n模型 m$/);
});
