import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MAX_TRACES } from '../../src/host/state/standalone-commands.ts';
import type { TraceEntry } from '../../src/host/state/standalone-commands.ts';
import { SessionWatcher } from '../../src/host/standalone/session-watch.ts';

interface Harness {
  watcher: SessionWatcher;
  sent: string[];
  traces: TraceEntry[];
  clock: { now: number };
  timers: Map<number, { callback: () => void; ms: number }>;
  runTimer(id: number): Promise<void>;
}

function harness(options: { sendOk?: boolean; now?: number } = {}): Harness {
  const sent: string[] = [];
  const traces: TraceEntry[] = [];
  const clock = { now: options.now ?? 1_700_000_000_000 };
  const timers = new Map<number, { callback: () => void; ms: number }>();
  let seq = 0;
  const watcher = new SessionWatcher({
    send: async (text: string) => {
      sent.push(text);
      return options.sendOk ?? true;
    },
    store: {
      traces: () => traces,
      setTraces: async (next) => {
        traces.splice(0, traces.length, ...next);
      },
    },
    now: () => clock.now,
    setTimer: (callback, ms) => {
      seq += 1;
      timers.set(seq, { callback, ms });
      return seq;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });
  return {
    watcher,
    sent,
    traces,
    clock,
    timers,
    async runTimer(id: number) {
      timers.get(id)?.callback();
      await watcher.drain();
    },
  };
}

function fold(
  watcher: SessionWatcher,
  sessionId: string,
  turn: { prompt?: string; answer?: string; reason?: Record<string, unknown> },
): void {
  watcher.handleEvent(sessionId, { type: 'turn/start', data: { turn: 1 } });
  if (turn.prompt !== undefined) {
    watcher.handleEvent(sessionId, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: turn.prompt }] },
    });
  }
  if (turn.answer !== undefined) {
    watcher.handleEvent(sessionId, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: turn.answer }] } },
    });
  }
  watcher.handleEvent(sessionId, { type: 'turn/end', data: { reason: turn.reason ?? { kind: 'completed' } } });
}

test('跟踪：一轮结束把提问与回答推给主人', async () => {
  const h = harness();
  assert.equal(await h.watcher.add('s-1', '会话一', 30), 'added');
  fold(h.watcher, 's-1', { prompt: '这是提问', answer: '这是回答' });
  await h.watcher.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /跟踪 ·「会话一」/);
  assert.match(h.sent[0]!, /> 这是提问/);
  assert.match(h.sent[0]!, /这是回答/);
  assert.equal(h.traces.length, 1);
});

test('跟踪：中止、被拦下与失败各有收尾文案，空回答不装作有内容', async () => {
  const h = harness();
  await h.watcher.add('s-1', '会话一', 30);
  fold(h.watcher, 's-1', { prompt: '问', answer: '答', reason: { kind: 'aborted' } });
  fold(h.watcher, 's-1', { prompt: '问', answer: '答', reason: { kind: 'blocked' } });
  fold(h.watcher, 's-1', { prompt: '问', answer: '答', reason: { kind: 'failed', error: { message: '额度用尽' } } });
  fold(h.watcher, 's-1', { prompt: '问' });
  await h.watcher.drain();
  assert.deepEqual(h.sent, [
    '跟踪 ·「会话一」这一轮被中止了。',
    '跟踪 ·「会话一」这一轮被拦下了（可能在等审批），请到 Web 端处理。',
    '跟踪 ·「会话一」这一轮失败：额度用尽',
    '跟踪 ·「会话一」这一轮结束了，没有可发送的文本。',
  ]);
});

test('跟踪：列表按剩余时长过滤，到期后推送一次并落盘', async () => {
  const h = harness();
  await h.watcher.add('s-1', '会话一', 30);
  assert.equal(h.watcher.list().length, 1);
  // 定时器按 30 分钟排。
  const [id, timer] = [...h.timers.entries()][0]!;
  assert.equal(timer.ms, 30 * 60_000);

  h.clock.now += 30 * 60_000;
  assert.equal(h.watcher.list().length, 0);
  await h.runTimer(id);
  assert.equal(h.traces.length, 0);
  assert.match(h.sent[0]!, /已到期，已停止/);
});

test('跟踪：重新跟踪顺延时间，超过上限拒绝新增', async () => {
  const h = harness();
  await h.watcher.add('s-1', '会话一', 10);
  const first = h.traces[0]!.until;
  assert.equal(await h.watcher.add('s-1', '会话一', 20), 'renewed');
  assert.equal(h.traces[0]!.until, first + 10 * 60_000);
  for (let index = 2; index <= MAX_TRACES; index += 1) {
    assert.equal(await h.watcher.add(`s-${index}`, `会话${index}`, 10), 'added');
  }
  assert.equal(await h.watcher.add('s-extra', '多出来的', 10), 'full');
});

test('跟踪：按 id 前缀停止，歧义前缀与数字都不在这里解释', async () => {
  const h = harness();
  await h.watcher.add('session-aaa', 'A', 30);
  await h.watcher.add('session-bbb', 'B', 30);
  // `session` 前缀匹配两条，歧义：不停。
  assert.deepEqual(await h.watcher.remove('session'), []);
  // 数字是 /sessions 快照的编号，由命令层先定位；观察者不认识数字。
  assert.deepEqual(await h.watcher.remove('1'), []);
  assert.deepEqual((await h.watcher.remove('session-aaa')).map((entry) => entry.sessionId), ['session-aaa']);
  assert.deepEqual((await h.watcher.remove('session-bbb')).map((entry) => entry.sessionId), ['session-bbb']);
  assert.equal(h.traces.length, 0);
  assert.equal(h.watcher.list().length, 0);
});

test('/send：目标空闲时等它这一轮结束再发回答', async () => {
  const h = harness();
  h.watcher.trackSend('s-1', '会话一', '帮我看看这个');
  fold(h.watcher, 's-1', { prompt: '帮我看看这个', answer: '看完了' });
  await h.watcher.drain();
  assert.deepEqual(h.sent, ['来自会话「会话一」：\n\n看完了']);
  // 只等这一轮：下一轮不再推给 /send。
  fold(h.watcher, 's-1', { prompt: '再问', answer: '再答' });
  await h.watcher.drain();
  assert.equal(h.sent.length, 1);
});

test('/send：目标在跑且排队时跳过上一轮的 turn/end', async () => {
  const h = harness();
  h.watcher.trackSend('s-1', '会话一', '第二条', true);
  // 先结束的是上一轮：不能把它的回答当成我们的。
  h.watcher.handleEvent('s-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await h.watcher.drain();
  assert.deepEqual(h.sent, []);
  // 我们的这一轮随后开始并结束。
  fold(h.watcher, 's-1', { prompt: '第二条', answer: '第二条的回答' });
  await h.watcher.drain();
  assert.deepEqual(h.sent, ['来自会话「会话一」：\n\n第二条的回答']);
});

test('/send：等不到回答时只提示一次，不一直挂着', async () => {
  const h = harness();
  h.watcher.trackSend('s-1', '会话一', '问');
  h.clock.now += 30 * 60_000;
  h.watcher.handleEvent('s-1', { type: 'assistant/message', data: { message: { content: [] } } });
  await h.watcher.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /没有在 30 分钟内结束/);
});

test('会话改名：跟踪条目与 /send 的标题一起更新并落盘', async () => {
  const h = harness();
  await h.watcher.add('s-1', '旧名字', 30);
  h.watcher.trackSend('s-2', '旧名字', '问');
  h.watcher.handleEvent('s-1', { type: 'session/title', data: { title: '跟踪的新名字' } });
  h.watcher.handleEvent('s-2', { type: 'session/title', data: { title: '转发的新名字' } });
  await h.watcher.drain();
  assert.equal(h.traces[0]!.title, '跟踪的新名字');
  fold(h.watcher, 's-2', { prompt: '问', answer: '答' });
  await h.watcher.drain();
  assert.match(h.sent[0]!, /转发的新名字/);
});

test('跟踪与 /send 落在同一会话：排队跳过上一轮只影响 /send，跟踪照常推送', async () => {
  const h = harness();
  await h.watcher.add('s-1', '会话一', 30);
  h.watcher.trackSend('s-1', '会话一', '第二条', true);
  // 上一轮结束：跟踪推这一轮，/send 不推。
  h.watcher.handleEvent('s-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await h.watcher.drain();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /跟踪 ·「会话一」/);

  // 我们这一轮：两边各推一条。
  fold(h.watcher, 's-1', { prompt: '第二条', answer: '新回答' });
  await h.watcher.drain();
  // 同一轮不重复推：跟踪那条带着提问与回答，/send 不再另发一份。
  assert.equal(h.sent.length, 2);
  assert.match(h.sent[1]!, /跟踪 ·「会话一」/);
  assert.doesNotMatch(h.sent[1]!, /来自会话/);
});

test('跟踪：启动时从持久态重读，构造后才 hydrate 的条目也能恢复', async () => {
  const h = harness();
  // 模拟 store.hydrate() 在 watcher 构造之后才把条目读进来。
  h.traces.push({ sessionId: 's-1', title: '会话一', since: h.clock.now, until: h.clock.now + 60_000 });
  assert.equal(h.watcher.list().length, 0, '构造时还没有条目');
  h.watcher.start();
  assert.equal(h.watcher.list().length, 1);
  assert.equal(h.timers.size, 1);
});

test('/send：没有事件也会按定时器收尾，不留下永远等不到的条目', async () => {
  const h = harness();
  h.watcher.trackSend('s-1', '会话一', '问');
  assert.equal(h.timers.size, 1);
  h.clock.now += 30 * 60_000;
  const [id] = [...h.timers.keys()];
  await h.runTimer(id);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /没有在 30 分钟内结束/);
  // 再来一条超时提醒也不会重复发。
  h.watcher.handleEvent('s-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await h.watcher.drain();
  assert.equal(h.sent.length, 1);
});

test('/send：提交失败撤销观察，不再等回答', async () => {
  const h = harness();
  h.watcher.trackSend('s-1', '会话一', '问');
  h.watcher.removeSend('s-1');
  assert.equal(h.timers.size, 0);
  h.watcher.handleEvent('s-1', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  await h.watcher.drain();
  assert.deepEqual(h.sent, []);
});

test('跟踪：到期与重新跟踪竞态时，新计时不被旧定时器打断', async () => {
  const h = harness();
  await h.watcher.add('s-1', '会话一', 10);
  const [id, timer] = [...h.timers.entries()][0]!;
  const oldCallback = timer.callback;
  await h.watcher.add('s-1', '会话一', 20);
  // 旧定时器即便已经排队执行，也不能删掉重新计时后的条目。
  oldCallback();
  await h.watcher.drain();
  assert.equal(h.watcher.list().length, 1);
  assert.equal(h.sent.length, 0);
  // 新定时器还在。
  assert.equal(h.timers.size, 1);
  assert.notEqual([...h.timers.keys()][0], id);
});
