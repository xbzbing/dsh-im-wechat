import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { TypingIndicator } from '../../src/host/typing.ts';

interface TypingCall {
  userId: string;
  typingTicket: string;
  status: number;
}

/** 假客户端：getconfig 回固定 ticket，sendtyping 只记账。 */
function fakeApi(options: { ticket?: string; failConfig?: boolean; failTyping?: boolean } = {}) {
  const configCalls: { userId: string; contextToken: string }[] = [];
  const typingCalls: TypingCall[] = [];
  const api = {
    async getConfig(params: { userId: string; contextToken: string }) {
      configCalls.push(params);
      if (options.failConfig) throw new Error('网络断了');
      return { ret: 0, typing_ticket: options.ticket ?? 'tt-1' };
    },
    async sendTyping(params: TypingCall) {
      typingCalls.push(params);
      if (options.failTyping) throw new Error('sendtyping 挂了');
    },
  } as unknown as ILinkApi;
  return { api, configCalls, typingCalls };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`等待超时：${label}`);
}

function makeTyping(overrides: {
  api?: ILinkApi | null;
  contextToken?: string;
  enabled?: boolean;
  keepaliveMs?: number;
  maxDurationMs?: number;
} = {}) {
  const errors: string[] = [];
  const state = { now: 1_760_000_000_000 };
  const indicator = new TypingIndicator({
    api: () => overrides.api ?? null,
    contextToken: () => overrides.contextToken ?? 'ctx-1',
    enabled: () => overrides.enabled !== false,
    logger: { warn: (message: unknown) => errors.push(String(message)) },
    now: () => state.now,
    keepaliveMs: overrides.keepaliveMs ?? 10,
    maxDurationMs: overrides.maxDurationMs ?? 60_000,
  });
  return { indicator, errors, state };
}

test('受理后开始输入：取 ticket 并发 status=1，keepalive 保活，stop 发 status=2', async () => {
  const { api, configCalls, typingCalls } = fakeApi();
  const { indicator } = makeTyping({ api });

  indicator.start('Owner-1');
  await waitFor(() => typingCalls.length >= 1, '第一条输入状态');
  assert.deepEqual(configCalls, [{ userId: 'Owner-1', contextToken: 'ctx-1' }]);
  assert.deepEqual(typingCalls[0], { userId: 'Owner-1', typingTicket: 'tt-1', status: 1 });

  // keepalive：思考期间每过一个间隔就重发一次 status=1。
  await waitFor(() => typingCalls.length >= 2, 'keepalive 重发');
  assert.equal(typingCalls[1].status, 1);

  indicator.stop('owner-1');
  await waitFor(() => typingCalls.at(-1)?.status === 2, '取消输入状态');
  const settled = typingCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(typingCalls.length, settled, 'stop 之后 keepalive 不再发');
  assert.equal(configCalls.length, 1, 'ticket 只取一次');
});

test('取不到 ticket（getconfig 失败）时不发状态，退避期内不重复请求', async () => {
  const { api, configCalls, typingCalls } = fakeApi({ failConfig: true });
  const { indicator, state } = makeTyping({ api });

  indicator.start('owner-1');
  await waitFor(() => configCalls.length >= 1, '第一次取 ticket');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(typingCalls.length, 0, '没有 ticket 就不发');

  // 退避期内再 start 也不重复打 getconfig。
  indicator.start('owner-1');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(configCalls.length, 1);

  // 退避期过后重试。
  state.now += 3_000;
  indicator.start('owner-1');
  await waitFor(() => configCalls.length >= 2, '退避后重试');
  assert.equal(typingCalls.length, 0);
  indicator.stop('owner-1');
});

test('没有可用客户端或未启用时什么也不发', async () => {
  const noClient = makeTyping({ api: null });
  noClient.indicator.start('owner-1');
  const disabled = makeTyping({ api: fakeApi().api, enabled: false });
  disabled.indicator.start('owner-1');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disabled.errors.length, 0);
  noClient.indicator.stopAll();
  disabled.indicator.stopAll();
});

test('超时兜底：核心一直没有交付时到点自动取消输入状态', async () => {
  const { api, typingCalls } = fakeApi();
  const { indicator } = makeTyping({ api, maxDurationMs: 30 });

  indicator.start('owner-1');
  await waitFor(() => typingCalls.at(-1)?.status === 2, '到点自动取消');
  const settled = typingCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(typingCalls.length, settled, '超时后不再保活');
});

test('发送失败只记日志，不把异常抛给调用方', async () => {
  const { api } = fakeApi({ failTyping: true });
  const { indicator, errors } = makeTyping({ api });

  indicator.start('owner-1');
  await waitFor(() => errors.length >= 1, '记下发送失败');
  assert.match(errors[0] ?? '', /输入状态发送失败/);
  // stop 同样吞错，不抛。
  indicator.stop('owner-1');
  await new Promise((resolve) => setTimeout(resolve, 10));
});

test('重复 start 不开第二份会话，stopAll 取消全部', async () => {
  const { api, configCalls, typingCalls } = fakeApi();
  const { indicator } = makeTyping({ api });

  indicator.start('owner-1');
  indicator.start('OWNER-1');
  await waitFor(() => typingCalls.length >= 1, '第一条输入状态');
  assert.equal(configCalls.length, 1, '同一用户只取一次 ticket');

  indicator.start('owner-2');
  await waitFor(() => typingCalls.some((call) => call.userId === 'owner-2'), '第二个用户');
  indicator.stopAll();
  await waitFor(() => typingCalls.filter((call) => call.status === 2).length >= 2, '全部取消');
  const settled = typingCalls.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(typingCalls.length, settled, 'stopAll 之后不再保活');
});
