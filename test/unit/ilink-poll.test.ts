import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ILinkError } from '../../src/host/ilink/api.ts';
import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { PollLoop } from '../../src/host/ilink/poll.ts';
import type { PollHealth } from '../../src/host/ilink/poll.ts';
import { SessionGuard } from '../../src/host/ilink/session-guard.ts';
import { messageIdentity } from '../../src/host/ilink/identity.ts';
import type { GetUpdatesResponse, WeixinMessage } from '../../src/host/ilink/types.ts';
import { SyncCursorStore } from '../../src/host/state/sync-cursor.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';

interface Step {
  response?: GetUpdatesResponse;
  error?: Error;
}

interface Harness {
  dir: string;
  loop: PollLoop;
  messages: WeixinMessage[];
  health: PollHealth[];
  delays: number[];
  timeouts: number[];
  cursors: string[];
  guard: SessionGuard;
  contextTokens: ContextTokenStore;
  cursor: SyncCursorStore;
  controller: AbortController;
}

/**
 * 按脚本回放 `getUpdates`；脚本放完后主动取消，让循环正常退出。
 *
 * 注入的 `sleep` 立刻返回并记录时长：退避逻辑可断言，测试也不用真等 30 秒。
 */
async function harness(steps: Step[], options: { timings?: Record<string, number> } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-poll-'));
  const cursor = new SyncCursorStore({ dir });
  const contextTokens = new ContextTokenStore({ dir });
  const guard = new SessionGuard();
  const controller = new AbortController();
  const messages: WeixinMessage[] = [];
  const health: PollHealth[] = [];
  const delays: number[] = [];
  const timeouts: number[] = [];
  const cursors: string[] = [];
  let index = 0;

  const api = {
    async getUpdates(params: { cursor: string; timeoutMs?: number }) {
      cursors.push(params.cursor);
      timeouts.push(params.timeoutMs ?? 0);
      const step = steps[index];
      index += 1;
      if (!step) {
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      if (step.error) throw step.error;
      return step.response ?? {};
    },
  } as unknown as ILinkApi;

  const loop = new PollLoop({
    api,
    account: 'bot@im.bot',
    cursor,
    contextTokens,
    guard,
    onMessage: (message) => {
      messages.push(message);
    },
    onHealth: (snapshot) => {
      health.push(snapshot);
    },
    sleep: async (ms) => {
      delays.push(ms);
    },
    ...(options.timings ? { timings: options.timings } : { timings: { minPollGapMs: 0 } }),
  });

  return { dir, loop, messages, health, delays, timeouts, cursors, guard, contextTokens, cursor, controller };
}

function message(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: '1001',
    from_user_id: 'owner-1',
    create_time_ms: 1_760_000_000_000,
    context_token: 'ctx-1',
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  };
}

test('收到消息：交出去、记下 context_token、落盘游标', async () => {
  const h = await harness([
    { response: { ret: 0, msgs: [message()], get_updates_buf: 'CURSOR-1' } },
  ]);
  try {
    await h.loop.run(h.controller.signal);
    assert.equal(h.messages.length, 1);
    assert.equal(h.contextTokens.get('bot@im.bot', 'owner-1'), 'ctx-1');
    assert.equal(await h.cursor.load('bot@im.bot'), 'CURSOR-1');
    assert.deepEqual(h.cursors, ['', 'CURSOR-1']);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('投递失败时不推进游标，重投成功后才落盘', async () => {
  const h = await harness([]);
  const controller = new AbortController();
  let attempts = 0;
  const api = {
    async getUpdates() {
      attempts += 1;
      if (attempts > 3) {
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      // 同一批每次都回来：投递失败时游标不推进，所以拿到的还是同一批。
      return { ret: 0, msgs: [message()], get_updates_buf: 'C1' };
    },
  } as unknown as ILinkApi;
  const loop = new PollLoop({
    api,
    account: 'bot@im.bot',
    cursor: h.cursor,
    contextTokens: h.contextTokens,
    guard: h.guard,
    onMessage: () => {
      if (attempts < 3) throw new Error('core down');
    },
    sleep: async () => {},
    timings: { minPollGapMs: 0, maxDeliveryAttempts: 3 },
  });
  try {
    await loop.run(controller.signal);
    assert.equal(attempts >= 3, true);
    // 前两次失败，游标没落盘；第三次成功后才写入。
    assert.equal(await h.cursor.load('bot@im.bot'), 'C1');
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('同一帧重复推送只交出一遍', async () => {
  const h = await harness([
    { response: { ret: 0, msgs: [message(), message()] } },
  ]);
  try {
    await h.loop.run(h.controller.signal);
    assert.equal(h.messages.length, 1);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('服务端建议的长轮询超时用于下一次请求', async () => {
  const h = await harness([
    { response: { ret: 0, msgs: [], longpolling_timeout_ms: 12_000 } },
  ]);
  try {
    await h.loop.run(h.controller.signal);
    assert.deepEqual(h.timeouts.slice(0, 2), [35_000, 12_000]);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('单次失败退避 2 秒，连续三次后退避 30 秒', async () => {
  const boom = () => new ILinkError('http', 'boom', { status: 500 });
  const h = await harness([{ error: boom() }, { error: boom() }, { error: boom() }]);
  try {
    await h.loop.run(h.controller.signal);
    assert.deepEqual(h.delays, [2_000, 2_000, 30_000]);
    assert.equal(h.health.some((item) => item.state === 'degraded'), true);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('-14 进闸门并报 auth-expired', async () => {
  const h = await harness([{ response: { ret: -14 } }]);
  try {
    await h.loop.run(h.controller.signal);
    assert.equal(h.guard.isPaused('bot@im.bot'), true);
    assert.deepEqual(
      h.health.filter((item) => item.state === 'down').map((item) => item.code),
      ['auth-expired'],
    );
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('取消后循环退出，不再发请求', async () => {
  const h = await harness([{ response: { ret: 0, msgs: [] } }, { response: { ret: 0, msgs: [] } }]);
  const running = h.loop.run(h.controller.signal);
  h.controller.abort();
  await running;
  assert.equal(h.messages.length, 0);
});

test('消息身份按 message_id > client_id > seq > item 摘要 > 正文兜底', () => {
  const account = 'bot';
  assert.equal(messageIdentity(account, message({ message_id: '9' })), 'weixin:v1:bot:owner-1:mid:9');
  assert.equal(
    messageIdentity(account, { client_id: 'c1', from_user_id: 'owner-1' }),
    'weixin:v1:bot:owner-1:cid:c1',
  );
  assert.equal(
    messageIdentity(account, { seq: 7, from_user_id: 'owner-1' }),
    'weixin:v1:bot:owner-1:seq:7',
  );
  const byItems = messageIdentity(account, {
    from_user_id: 'owner-1',
    item_list: [{ type: 2, msg_id: '11' }, { type: 2, msg_id: '10' }],
  });
  assert.match(byItems ?? '', /^weixin:v1:bot:owner-1:items:[0-9a-f]{16}$/);
  const again = messageIdentity(account, {
    from_user_id: 'owner-1',
    item_list: [{ type: 2, msg_id: '10' }, { type: 2, msg_id: '11' }],
  });
  assert.equal(byItems, again);
  assert.match(
    messageIdentity(account, { from_user_id: 'owner-1', create_time_ms: 5, item_list: [{ type: 1, text_item: { text: 'x' } }] }) ?? '',
    /^weixin:v1:bot:owner-1:body:[0-9a-f]{16}$/,
  );
  assert.equal(messageIdentity(account, { from_user_id: 'owner-1' }), null);
  assert.equal(messageIdentity('', message()), null);
});
