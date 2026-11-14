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

function harness(
  options: {
    sent?: boolean;
    root?: boolean;
    recipient?: string | null;
    waitMs?: number;
    delayMs?: number;
    enabled?: boolean;
  } = {},
) {
  const sent: string[] = [];
  const broker = new QuestionBroker({
    send: async (text) => {
      sent.push(text);
      return options.sent !== false;
    },
    recipient: () => (options.recipient === undefined ? 'owner-1' : options.recipient),
    isRoot: () => options.root !== false,
    now: () => 1_000,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    ...(options.delayMs !== undefined ? { delayMs: () => options.delayMs! } : {}),
    ...(options.enabled !== undefined ? { enabled: () => options.enabled! } : {}),
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

test('待答期间：单题自由输入按提示语认领，多题整段自由输入不认领', async () => {
  const { broker } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = { questions: SINGLE };
  const controller = new AbortController();
  request.signal = controller.signal;
  const result = broker.handle(request, async () => new Promise(() => {}), true);
  await new Promise((resolve) => setImmediate(resolve));

  // 提示语写着「或直接回复文字作答」：单题自由输入必须认领，否则会落进普通消息
  // 路径被当成新提示词提交，问题本身挂到超时。
  assert.equal(broker.reply('都不想吃'), true);
  assert.deepEqual(await result, { answers: [{ id: 'q1', selected: [], custom: '都不想吃' }] });
  assert.equal(broker.snapshot().pending, 0);
});

test('多题：整段自由输入不认领（交普通消息路径），分段可解析才认领', async () => {
  const multi = [
    { id: 'a', question: 'A', options: [{ label: '甲' }] },
    { id: 'b', question: 'B', options: [{ label: '乙' }] },
  ];
  const { broker } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = {
    questions: multi,
    signal: new AbortController().signal,
  };
  const result = broker.handle(request, async () => new Promise(() => {}), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(broker.reply('我自己决定'), false);
  assert.equal(broker.snapshot().pending, 1);

  assert.equal(broker.reply('1；1'), true);
  const answer = (await result) as { answers: { id: string }[] };
  assert.deepEqual(answer.answers.map((item) => item.id), ['a', 'b']);
});

test('计划审阅：批准/继续之外的自由输入认领为修改意见', async () => {
  const plan = [{
    id: 'plan',
    question: '是否批准',
    intent: { kind: 'plan-review' },
    options: [{ label: '批准' }, { label: '继续规划' }],
  }];
  const { broker } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = {
    questions: plan,
    signal: new AbortController().signal,
  };
  const result = broker.handle(request, async () => new Promise(() => {}), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(broker.reply('先别动第三步'), true);
  assert.deepEqual(await result, {
    answers: [{ id: 'plan', selected: ['继续规划'], custom: '先别动第三步' }],
  });
});

test('微信超时只放弃微信这一路：Web 还在就交回 Web 接着等', async () => {
  const { broker } = harness({ waitMs: 20 });
  const request: { questions: unknown; signal?: AbortSignal } = {
    questions: SINGLE,
    signal: new AbortController().signal,
  };
  const result = broker.handle(
    request,
    () => new Promise((resolve) => {
      // Web 端过一会儿才答出来：超时后 handle 必须继续等它，而不是整体 reject。
      setTimeout(() => resolve({ answers: [{ id: 'q1', selected: ['饭'] }] }), 60);
    }),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(broker.snapshot().pending, 0, '超时后不再接受微信作答');
  assert.equal(broker.reply('1'), false, '微信这路已放弃');
  assert.deepEqual(await result, { answers: [{ id: 'q1', selected: ['饭'] }] });
});

test('微信超时且 Web 不在：按超时拒绝，文案不自称已交回', async () => {
  const { broker } = harness({ waitMs: 20 });
  const request: { questions: unknown; signal?: AbortSignal } = {
    questions: SINGLE,
    signal: new AbortController().signal,
  };
  const result = broker.handle(
    request,
    async () => {
      throw Object.assign(new Error('no provider'), { code: 'NO_PROVIDER' });
    },
    true,
  );
  await assert.rejects(result, (error: unknown) => {
    assert.match(String((error as Error).message), /等待微信作答超时/);
    assert.equal(String((error as Error).message).includes('已交回'), false);
    return true;
  });
});

test('多条待答时最后一条提醒优先被认领', async () => {
  const { broker } = harness();
  const first = broker.handle(
    { questions: [{ id: 'a', question: 'A', options: [{ label: '甲' }] }], signal: new AbortController().signal },
    async () => new Promise(() => {}),
    true,
  );
  const second = broker.handle(
    { questions: [{ id: 'b', question: 'B', options: [{ label: '乙' }] }], signal: new AbortController().signal },
    async () => new Promise(() => {}),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(broker.snapshot().pending, 2);

  // 主人在微信里看到的是最后一条提醒：回「1」应落在它身上，而不是最老的那条。
  assert.equal(broker.reply('1'), true);
  assert.equal(broker.snapshot().pending, 1, '认领并结掉了一条');
  broker.cancelAll('测试收尾');
  const firstOutcome = await first.then((value) => ({ value }), (error) => ({ error }));
  const secondOutcome = await second.then((value) => ({ value }), (error) => ({ error }));
  assert.ok('error' in firstOutcome, '先到的没被认领，被取消交回');
  assert.ok('value' in secondOutcome, '后到的（主人刚看到的那条）被认领');
});

test('cancelAll 会 abort 本地信号，Web 端的投递随之收缩', async () => {
  const { broker } = harness();
  const request: { questions: unknown; signal?: AbortSignal } = { questions: SINGLE };
  request.signal = new AbortController().signal;
  let observed: string | null = null;
  const result = broker.handle(request, async () => new Promise((_resolve, reject) => {
    // 宿主看到的 union signal：本地 abort 时要能看到原因。
    request.signal?.addEventListener('abort', () => {
      observed = String((request.signal?.reason as Error | undefined)?.message ?? '');
      reject(request.signal?.reason);
    }, { once: true });
  }), true);
  await new Promise((resolve) => setImmediate(resolve));
  broker.cancelAll('插件已停止');
  await assert.rejects(result, /插件已停止/);
  assert.equal(observed, '插件已停止');
  assert.equal(broker.snapshot().pending, 0);
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

test('发送提醒期间关闭插件：发送返回后不再挂待答，直接交回 Web', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const broker = new QuestionBroker({
    send: async () => {
      await gate;
      return true;
    },
    recipient: () => 'owner-1',
    isRoot: () => true,
  });
  let nextCalls = 0;
  const result = broker.handle(
    { questions: SINGLE },
    async () => {
      nextCalls += 1;
      return { answers: [{ id: 'q1', selected: [] }] };
    },
    true,
  );
  // 让 handle 走到 await send；此时还没有 pending。
  await new Promise((resolve) => setImmediate(resolve));
  broker.close();
  release();

  assert.deepEqual(await result, { answers: [{ id: 'q1', selected: [] }] });
  assert.equal(nextCalls, 1, '交回 Web 端');
  assert.equal(broker.snapshot().pending, 0, '没有留下永远等不到的待答');
});

test('等待窗口内 Web 先答：一条微信都不发', async () => {
  const { broker, sent } = harness({ delayMs: 50 });
  const answer = await broker.handle(
    { questions: SINGLE },
    async () => ({ answers: [{ id: 'q1', selected: ['面'] }] }),
    true,
  );
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['面'] }] });
  assert.deepEqual(sent, []);
  assert.equal(broker.snapshot().pending, 0);
});

test('等待到点还没人答：发提醒，之后微信作答生效', async () => {
  const { broker, sent } = harness({ delayMs: 10 });
  const result = broker.handle({ questions: SINGLE }, async () => new Promise(() => {}), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /去哪吃饭/);
  assert.equal(broker.reply('1'), true);
  assert.deepEqual(await result, { answers: [{ id: 'q1', selected: ['面'] }] });
});

test('提醒开关关掉：完全不接管，直接交回 Web', async () => {
  const { broker, sent } = harness({ enabled: false });
  let calls = 0;
  const answer = await broker.handle(
    { questions: SINGLE },
    async () => {
      calls += 1;
      return { answers: [] };
    },
    true,
  );
  assert.deepEqual(answer, { answers: [] });
  assert.equal(calls, 1);
  assert.deepEqual(sent, []);
});
