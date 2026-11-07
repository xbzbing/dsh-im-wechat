import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { WeixinRuntime } from '../../src/host/runtime.ts';
import { BridgeBinder } from '../../src/host/superagent/link.ts';
import type { BridgeProvider, OwnerMessageDraft } from '../../src/host/superagent/protocol.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import type { WeixinMessage } from '../../src/host/ilink/types.ts';

const ACCOUNT = 'bot@im.bot';
const OWNER = 'owner-1';
const LOGIN = {
  botToken: 'tok',
  account: ACCOUNT,
  userId: OWNER,
  baseUrl: 'https://ilinkai.weixin.qq.com',
  loggedInAt: 1_760_000_000_000,
};

/** 假客户端：按脚本回放入站消息，其余调用只记账。 */
function fakeApi(options: { batches?: WeixinMessage[][]; qrStatus?: Record<string, unknown>[] } = {}) {
  const batches = [...(options.batches ?? [])];
  const qrStatus = [...(options.qrStatus ?? [{ status: 'confirmed', ...LOGIN, bot_token: LOGIN.botToken, ilink_bot_id: ACCOUNT }])];
  const record = {
    getUpdatesCalls: 0,
    tokens: [] as (string | undefined)[],
    sent: [] as string[],
    notifyStart: 0,
    notifyStop: 0,
    qrCodeCalls: 0,
    qrStatusCalls: 0,
  };
  let index = 0;
  const impl = (options2: { token?: string }): ILinkApi => {
    record.tokens.push(options2.token);
    return {
      async getUpdates(params: { signal?: AbortSignal }) {
        record.getUpdatesCalls += 1;
        const batch = batches.shift();
        if (batch) return { ret: 0, msgs: batch, get_updates_buf: `cursor-${index}` };
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      },
      async sendMessage(message: { item_list?: { text_item?: { text?: string } }[] }) {
        record.sent.push(message.item_list?.[0]?.text_item?.text ?? '');
      },
      async notifyStart() {
        record.notifyStart += 1;
      },
      async notifyStop() {
        record.notifyStop += 1;
      },
      async getBotQrCode() {
        record.qrCodeCalls += 1;
        return { qrcode: 'qr-1', qrcode_img_content: 'https://weixin.qq.com/x/qr-1' };
      },
      async getQrStatus() {
        record.qrStatusCalls += 1;
        index += 1;
        return qrStatus.shift() ?? { status: 'wait' };
      },
      async getConfig() {
        return {};
      },
    } as unknown as ILinkApi;
  };
  return { createApi: impl, record };
}

function fakeSuperagent(options: { features?: string[] } = {}) {
  const providers: BridgeProvider[] = [];
  const received: OwnerMessageDraft[] = [];
  const cleanups: (() => void)[] = [];
  const service = {
    protocol: { versions: ['my-superagent/v1'], features: options.features ?? ['owner-images', 'owner-lookup'] },
    bridges: {
      register(provider: BridgeProvider) {
        providers.push(provider);
        return {
          id: `weixin:${provider.account}`,
          protocol: 'my-superagent/v1',
          async receive(draft: OwnerMessageDraft) {
            received.push(draft);
            return { accepted: true as const };
          },
          async answer() {
            return { accepted: true as const };
          },
          update() {},
          commands: () => [],
          isOwner: (sender: string) => sender === OWNER,
          dispose() {},
        };
      },
    },
  };
  const scope = {
    mySuperagent: service,
    effect: (execute: () => () => void) => {
      cleanups.push(execute());
      return undefined;
    },
  };
  return { service, scope, providers, received, cleanups };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`等待超时：${label}`);
}

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-runtime-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('没有登录态时停在未登录，不起轮询', async () => {
  await withDir(async (dir) => {
    const api = fakeApi();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    await runtime.start();
    const status = runtime.status();
    assert.equal(status.loggedIn, false);
    assert.equal(status.health.code, 'auth-expired');
    assert.equal(api.record.getUpdatesCalls, 0);
    await runtime.stop();
  });
});

test('有登录态时连接并发起轮询，登录令牌只从状态文件来', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    await runtime.start();
    await waitFor(() => api.record.getUpdatesCalls > 0, '轮询启动');
    assert.equal(runtime.status().loggedIn, true);
    assert.equal(api.record.tokens.includes(LOGIN.botToken), true);
    await runtime.stop();
    assert.equal(api.record.notifyStop > 0, true);
  });
});

test('扫码确认后落盘登录态并接上桥', async () => {
  await withDir(async (dir) => {
    const api = fakeApi();
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachBinder(binder);
    binder.attach(superagent.scope);
    await runtime.start();

    await runtime.startLogin();
    await runtime.waitForLoginSettled();

    const status = runtime.status();
    assert.equal(status.loggedIn, true);
    assert.equal(status.login.phase, 'confirmed');
    assert.equal(status.accountTail, 'bot…@im.bot');
    const saved = await new LoginStateStore({ dir }).load();
    assert.equal(saved?.account, ACCOUNT);
    assert.equal(superagent.providers.length, 1);
    assert.equal(status.bridge.registered, true);
    await runtime.stop();
  });
});

test('入站消息转成草稿交给核心，主人判定由核心的能力声明决定', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{
        message_id: '9001',
        from_user_id: OWNER,
        create_time_ms: 1_760_000_000_000,
        item_list: [{ type: 1, text_item: { text: '/status' } }],
      }]],
    });
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachBinder(binder);
    await runtime.start();

    await waitFor(() => superagent.received.length > 0, '入站交给核心');
    assert.deepEqual(superagent.received[0], {
      messageId: `weixin:v1:${ACCOUNT}:${OWNER}:mid:9001`,
      sender: OWNER,
      text: '/status',
      at: 1_760_000_000_000,
    });
    await runtime.stop();
  });
});

test('核心不在时不注册桥，入站不报错也不回话', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{ message_id: '1', from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: 'hi' } }] }]],
    });
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    await runtime.start();
    await waitFor(() => api.record.getUpdatesCalls > 0, '轮询启动');
    const status = runtime.status();
    assert.equal(status.bridge.registered, false);
    assert.equal(api.record.sent.length, 0);
    await runtime.stop();
  });
});

test('停用开关会停轮询并持久化，重启后沿用', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    await runtime.start();
    await waitFor(() => api.record.getUpdatesCalls > 0, '轮询启动');

    const status = await runtime.setEnabled(false);
    assert.equal(status.enabled, false);
    assert.equal(status.health.state, 'down');
    const callsAfterDisable = api.record.getUpdatesCalls;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(api.record.getUpdatesCalls, callsAfterDisable);

    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { enabled?: boolean };
    assert.equal(persisted.enabled, false);

    const restarted = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    await restarted.start();
    assert.equal(restarted.status().enabled, false);
    await restarted.stop();
    await runtime.stop();
  });
});

test('stop() 会取消进行中的扫码登录，确认后不再连回', async () => {
  await withDir(async (dir) => {
    // 扫码永远停在 waiting：只有 stop() 主动取消才会结束。
    const api = fakeApi({ qrStatus: [{ status: 'wait' }, { status: 'wait' }, { status: 'wait' }] });
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachBinder(binder);
    await runtime.start();
    await runtime.startLogin();
    assert.equal(runtime.status().login.phase, 'waiting');

    await runtime.stop();
    assert.equal(runtime.status().login.phase, 'cancelled');
    // 停机之后桥不该被重新注册进来。
    assert.equal(superagent.providers.length, 0);
  });
});

test('关掉「接入我的超级助理」会注销桥，并让自有功能生效', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    runtime.attachBinder(binder);
    await runtime.start();
    await waitFor(() => runtime.status().bridge.registered, '桥注册');
    assert.equal(runtime.status().superagent, true);
    assert.equal(runtime.status().ownFeatures, false);

    const status = await runtime.setSuperagent(false);
    assert.equal(status.superagent, false);
    assert.equal(status.bridge.registered, false);
    assert.equal(status.ownFeatures, true);

    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { superagent?: boolean };
    assert.equal(persisted.superagent, false);

    // 重新打开后桥回来。
    const again = await runtime.setSuperagent(true);
    assert.equal(again.bridge.registered, true);
    assert.equal(again.ownFeatures, false);
    await runtime.stop();
  });
});

test('两项面板开关互不覆盖（合并保存）', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    await runtime.start();
    await runtime.setEnabled(false);
    await runtime.setSuperagent(false);
    const stored = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(stored.enabled, false);
    assert.equal(stored.superagent, false);
    await runtime.stop();
  });
});

test('登出清掉登录态与桥注册', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    runtime.attachBinder(binder);
    await runtime.start();
    await waitFor(() => runtime.status().bridge.registered, '桥注册');

    const status = await runtime.logout();
    assert.equal(status.loggedIn, false);
    assert.equal(status.bridge.registered, false);
    assert.equal(await new LoginStateStore({ dir }).load(), null);
    await runtime.stop();
  });
});

test('长任务阈值默认 30 分钟，面板改的值落盘并在重启后沿用', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    await runtime.start();
    assert.equal(runtime.status().longTaskThresholdMinutes, 30);

    const status = await runtime.setLongTaskThreshold(45);
    assert.equal(status.longTaskThresholdMinutes, 45);
    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as {
      longTaskThresholdMinutes?: number;
    };
    assert.equal(persisted.longTaskThresholdMinutes, 45);

    const restarted = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    await restarted.start();
    assert.equal(restarted.status().longTaskThresholdMinutes, 45);
    await restarted.stop();
    await runtime.stop();
  });
});

test('profile 配置可以改阈值，面板值优先，越界按边界收窄', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, longTaskThresholdMinutes: 5 },
      createApi: fakeApi().createApi,
    });
    await runtime.start();
    assert.equal(runtime.status().longTaskThresholdMinutes, 5);

    // 面板值盖住 profile 的静态默认，重启后仍是面板值。
    await runtime.setLongTaskThreshold(45);
    const restarted = new WeixinRuntime({
      config: { dataDir: dir, longTaskThresholdMinutes: 5 },
      createApi: fakeApi().createApi,
    });
    await restarted.start();
    assert.equal(restarted.status().longTaskThresholdMinutes, 45);
    await restarted.stop();

    // 越界值收窄到 1–1440，而不是把提醒阈值设成 0（等于每条回合都提醒）。
    assert.equal((await runtime.setLongTaskThreshold(0)).longTaskThresholdMinutes, 1);
    assert.equal((await runtime.setLongTaskThreshold(1e9)).longTaskThresholdMinutes, 1_440);
    await runtime.stop();
  });
});

test('未接入核心时长任务提醒按配置阈值发到主人微信', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    // 主人的 context_token 由入站消息带来，这里直接落盘，省掉一轮轮询。
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();

    const api = fakeApi();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, longTaskThresholdMinutes: 5 },
      createApi: api.createApi,
    });
    await runtime.start();
    await runtime.setSuperagent(false);

    const turn = (endAt: number) => {
      runtime.handleSessionEvent('sess-1', { type: 'turn/start', seq: 1, time: 0, data: { turn: 1 } });
      runtime.handleSessionEvent('sess-1', {
        type: 'turn/end', seq: 2, time: endAt, data: { turn: 1, reason: { kind: 'completed' } },
      });
    };

    turn(4 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(api.record.sent, []);

    turn(6 * 60_000);
    await waitFor(() => api.record.sent.length > 0, '长任务提醒发出');
    assert.match(api.record.sent[0], /长任务提醒/);
    assert.match(api.record.sent[0], /耗时：6分0秒/);
    await runtime.stop();
  });
});
