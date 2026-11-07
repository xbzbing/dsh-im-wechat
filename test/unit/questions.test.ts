import assert from 'node:assert/strict';
import { test } from 'node:test';

import { answerFromText, normalizeQuestions, questionsToInteraction } from '../../src/host/answer-text.ts';
import { QuestionBroker } from '../../src/host/questions.ts';

const SINGLE = [{
  id: 'q1',
  question: '去哪吃饭',
  options: [{ label: '面' }, { label: '饭' }],
}];

test('题目收窄：丢掉没有 id/题干的项，选项缺 label 也丢掉', () => {
  const questions = normalizeQuestions([
    { id: 'a', question: 'A', options: [{ label: 'x' }, { description: 'no label' }] },
    { id: '', question: 'B' },
    { id: 'c' },
    null,
    'x',
  ]);
  assert.deepEqual(questions, [{ id: 'a', question: 'A', options: [{ label: 'x' }] }]);
  assert.deepEqual(normalizeQuestions(undefined), []);
});

test('单题：序号、选项文字、自由输入', () => {
  assert.deepEqual(answerFromText(SINGLE, '1'), { answers: [{ id: 'q1', selected: ['面'] }] });
  assert.deepEqual(answerFromText(SINGLE, '饭'), { answers: [{ id: 'q1', selected: ['饭'] }] });
  assert.deepEqual(answerFromText(SINGLE, '都不想吃'), {
    answers: [{ id: 'q1', selected: [], custom: '都不想吃' }],
  });
});

test('多选：逗号分隔的序号都能解析', () => {
  const questions = [{ id: 'q', question: '选几个', multiSelect: true, options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }] }];
  assert.deepEqual(answerFromText(questions, '1,3'), { answers: [{ id: 'q', selected: ['甲', '丙'] }] });
});

test('多题：分段数对得上就一段一题，对不上整段当自由输入', () => {
  const questions = [
    { id: 'a', question: 'A', options: [{ label: '甲' }] },
    { id: 'b', question: 'B', options: [{ label: '乙' }] },
  ];
  assert.deepEqual(answerFromText(questions, '1；1'), {
    answers: [{ id: 'a', selected: ['甲'] }, { id: 'b', selected: ['乙'] }],
  });
  assert.deepEqual(answerFromText(questions, '我自己决定'), {
    answers: [
      { id: 'a', selected: [], custom: '我自己决定' },
      { id: 'b', selected: [], custom: '我自己决定' },
    ],
  });
});

test('计划审阅：批准词与继续规划', () => {
  const questions = [{
    id: 'plan',
    question: '是否批准',
    intent: { kind: 'plan-review', approve: '开工' },
    options: [{ label: '开工' }, { label: '继续规划' }],
  }];
  assert.deepEqual(answerFromText(questions, '批准'), { answers: [{ id: 'plan', selected: ['开工'] }] });
  assert.deepEqual(answerFromText(questions, '继续规划'), { answers: [{ id: 'plan', selected: ['继续规划'] }] });
  assert.deepEqual(answerFromText(questions, '先别动第三步'), {
    answers: [{ id: 'plan', selected: ['继续规划'], custom: '先别动第三步' }],
  });
});

test('空输入不当作答', () => {
  assert.equal(answerFromText(SINGLE, '   '), null);
  assert.equal(answerFromText([], '1'), null);
});

test('题目转交互形状时保留 plan-review 意图', () => {
  const interaction = questionsToInteraction([
    { id: 'p', question: '计划', intent: { kind: 'plan-review', approve: '批准' }, options: [{ label: '批准' }] },
  ]);
  assert.equal(interaction.questions[0].intent, 'plan-review');
});

// ---------------------------------------------------------------- broker

function harness(options: { sent?: boolean; root?: boolean; recipient?: string | null } = {}) {
  const sent: string[] = [];
  const broker = new QuestionBroker({
    send: async (text) => {
      sent.push(text);
      return options.sent !== false;
    },
    recipient: () => (options.recipient === undefined ? 'owner-1' : options.recipient),
    isRoot: () => options.root !== false,
    now: () => 1_000,
  });
  return { broker, sent };
}

test('发不出提醒就交回 Web，不接管', async () => {
  const { broker, sent } = harness({ sent: false });
  let called = 0;
  const answer = await broker.handle(
    { questions: SINGLE },
    async () => {
      called += 1;
      return { answers: [] };
    },
    true,
  );
  assert.deepEqual(answer, { answers: [] });
  assert.equal(called, 1);
  assert.equal(sent.length, 1);
});

test('插件未启用/非根会话时直接交给下一个监听器', async () => {
  const { broker } = harness();
  let calls = 0;
  const next = async (): Promise<unknown> => {
    calls += 1;
    return { answers: [{ id: 'q1', selected: ['面'] }] };
  };
  await broker.handle({ questions: SINGLE }, next, false);
  await harness({ root: false }).broker.handle({ questions: SINGLE }, next, true);
  assert.equal(calls, 2);
});

test('主人回答后返回结构化答案，并摘掉待答', async () => {
  const { broker, sent } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = { questions: SINGLE };
  const controller = new AbortController();
  request.signal = controller.signal;

  const web = new Promise((_resolve, reject) => {
    // Web 端一直不答，直到信号被 abort。
    const signal = request.signal;
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ASK_ABORTED' })), { once: true });
  });

  const result = broker.handle(request, () => web as Promise<unknown>, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.snapshot().pending, 1);
  assert.equal(broker.reply('1'), true);
  const answer = await result;
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['面'] }] });
  assert.equal(broker.snapshot().pending, 0);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /去哪吃饭/);
});

test('不是作答的文本不被消费（交给普通消息路径）', async () => {
  const broker = new QuestionBroker({
    send: async () => true,
    recipient: () => 'owner-1',
    isRoot: () => true,
  });
  assert.equal(broker.reply('/status'), false);
  assert.equal(broker.snapshot().pending, 0);
});

test('Web 不在（NO_PROVIDER）时继续等微信作答', async () => {
  const { broker } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = { questions: SINGLE };
  const controller = new AbortController();
  request.signal = controller.signal;
  const result = broker.handle(
    request,
    async () => {
      throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' });
    },
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.snapshot().pending, 1);
  broker.reply('饭');
  assert.deepEqual(await result, { answers: [{ id: 'q1', selected: ['饭'] }] });
});

test('停机时把待答请求交回，不永久挂住', async () => {
  const { broker } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = { questions: SINGLE };
  const controller = new AbortController();
  request.signal = controller.signal;
  const result = broker.handle(request, async () => new Promise(() => {}), true);
  await new Promise((resolve) => setImmediate(resolve));
  broker.cancelAll();
  await assert.rejects(result, /插件已停止/);
  assert.equal(broker.snapshot().pending, 0);
  broker.close();
});
