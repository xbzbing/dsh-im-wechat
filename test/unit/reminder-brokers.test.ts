import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApprovalBroker } from '../../src/host/approvals.ts';
import { QuestionBroker } from '../../src/host/questions.ts';

/**
 * 两个 broker 的行为矩阵。
 *
 * 提问与审批的骨架相同、结局映射不同（提问超时抛 ASK_ABORTED，审批交回 Web；
 * 提问的「Web 不在」是 NO_PROVIDER，审批是解析值 unavailable）。这里只锁两边
 * **必须一致**的那几条，语义差异由各自的测试文件覆盖。
 */
interface Broker {
  handle(request: never, next: () => Promise<unknown>, active: boolean): Promise<unknown>;
  reply(text: string): boolean;
  cancelAll(reason?: string): void;
  snapshot(): { pending: number };
}

interface Case {
  name: string;
  make: (options: { sent?: boolean; delayMs?: number; enabled?: boolean }) => { broker: Broker; sent: string[]; absent: () => Promise<unknown> };
}

const QUESTION = { id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] };
const ROOT = { id: 'root-1', session: { header: {} } };

const cases: Case[] = [
  {
    name: '提问',
    make: (options) => {
      const sent: string[] = [];
      const broker = new QuestionBroker({
        send: async (text) => {
          sent.push(text);
          return options.sent !== false;
        },
        recipient: () => 'owner-1',
        isRoot: () => true,
        ...(options.delayMs !== undefined ? { delayMs: () => options.delayMs! } : {}),
        ...(options.enabled !== undefined ? { enabled: () => options.enabled! } : {}),
      });
      return {
        broker: broker as unknown as Broker,
        sent,
        // Web 不在：提问的 waterfall 兜底是抛 NO_PROVIDER。
        absent: async () => {
          throw Object.assign(new Error('no answerer'), { code: 'NO_PROVIDER' });
        },
      };
    },
  },
  {
    name: '审批',
    make: (options) => {
      const sent: string[] = [];
      const broker = new ApprovalBroker({
        send: async (text) => {
          sent.push(text);
          return options.sent !== false;
        },
        recipient: () => 'owner-1',
        canApprove: () => true,
        ...(options.delayMs !== undefined ? { delayMs: () => options.delayMs! } : {}),
        ...(options.enabled !== undefined ? { enabled: () => options.enabled! } : {}),
      });
      return {
        broker: broker as unknown as Broker,
        sent,
        // Web 不在：审批的 waterfall 兜底是解析成 unavailable。
        absent: async () => 'unavailable',
      };
    },
  },
];

function requestFor(name: string) {
  return (name === '提问' ? { questions: [QUESTION], agent: ROOT } : { toolName: 'bash', agent: ROOT }) as never;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

for (const { name, make } of cases) {
  test(`${name}：窗口内 Web 先答，一条提醒都不发`, async () => {
    const { broker, sent } = make({ delayMs: 5_000 });
    const outcome = await broker.handle(requestFor(name), async () => 'web-answer', true);
    assert.equal(outcome, 'web-answer');
    assert.deepEqual(sent, []);
  });

  test(`${name}：Web 不在时仍然发提醒并等主人`, async () => {
    const { broker, sent, absent } = make({ delayMs: 5 });
    const pending = broker.handle(requestFor(name), absent, true);
    await sleep(20);
    assert.equal(sent.length, 1);
    assert.equal(broker.snapshot().pending, 1);
    broker.cancelAll('测试结束');
    assert.equal(broker.snapshot().pending, 0);
    // 提问取消会 reject（带 ASK_ABORTED），审批是交回 Web；两边都不该留下未处理的 rejection。
    pending.catch(() => {});
  });

  test(`${name}：窗口到点才提醒`, async () => {
    const { broker, sent } = make({ delayMs: 5 });
    const pending = broker.handle(requestFor(name), () => new Promise(() => {}), true);
    await sleep(20);
    assert.equal(sent.length, 1);
    broker.cancelAll('测试结束');
    // 提问取消会 reject（带 ASK_ABORTED），审批是交回 Web；两边都不该留下未处理的 rejection。
    pending.catch(() => {});
  });

  test(`${name}：开关关掉时完全不接管`, async () => {
    const { broker, sent } = make({ enabled: false });
    const outcome = await broker.handle(requestFor(name), async () => 'web-answer', true);
    assert.equal(outcome, 'web-answer');
    assert.deepEqual(sent, []);
    assert.equal(broker.snapshot().pending, 0);
  });

  test(`${name}：提醒发不出去就不挂待答`, async () => {
    const { broker, sent } = make({ delayMs: 0, sent: false });
    const outcome = await broker.handle(requestFor(name), async () => 'web-answer', true);
    assert.equal(outcome, 'web-answer');
    assert.equal(sent.length, 1);
    assert.equal(broker.snapshot().pending, 0);
  });

  test(`${name}：不是作答的文本不被消费`, async () => {
    const { broker } = make({ delayMs: 0 });
    const pending = broker.handle(requestFor(name), () => new Promise(() => {}), true);
    await sleep(20);
    assert.equal(broker.reply('你看着办'), name === '提问' ? true : false);
    broker.cancelAll('测试结束');
    // 提问取消会 reject（带 ASK_ABORTED），审批是交回 Web；两边都不该留下未处理的 rejection。
    pending.catch(() => {});
  });
}
