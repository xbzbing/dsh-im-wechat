import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeixinRuntime } from '../../src/host/runtime.ts';
import { BridgeBinder } from '../../src/host/superagent/link.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import { LOGIN, OWNER, fakeApi, fakeSuperagent, waitFor, withDir } from './helpers/runtime-harness.ts';

test('核心受理入站后显示正在输入，交付进入投递就取消', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      typingTicket: 'tt-7',
      batches: [[{
        message_id: '7001',
        from_user_id: OWNER,
        create_time_ms: 1_760_000_000_000,
        item_list: [{ type: 1, text_item: { text: '帮我看看' } }],
      }]],
    });
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: api.createApi });
    runtime.attachBinder(binder);
    await runtime.start();

    await waitFor(() => api.record.typing.some((call) => call.status === 1), '输入状态开启');
    const started = api.record.typing.find((call) => call.status === 1);
    assert.equal(started?.userId, OWNER);
    assert.equal(started?.typingTicket, 'tt-7');

    // 交付一进投递流程就取消输入状态。
    await superagent.providers[0].deliver({
      protocol: 'my-superagent/v1',
      id: 'd-1',
      recipient: OWNER,
      intent: 'result',
      title: '完成',
      body: '好了',
    });
    await waitFor(() => api.record.typing.some((call) => call.status === 2), '输入状态取消');
    await runtime.stop();
    assert.equal(api.record.typing.filter((call) => call.status === 2).length >= 1, true);
  });
});

test('核心拒收入站时不开启输入状态', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      typingTicket: 'tt-8',
      batches: [[{
        message_id: '7002',
        from_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }]],
    });
    const superagent = fakeSuperagent({ rejectReason: 'not-owner' });
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: api.createApi });
    runtime.attachBinder(binder);
    await runtime.start();

    await waitFor(() => superagent.received.length > 0, '入站交给核心');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(api.record.typing.length, 0, '拒收后不该出现输入状态');
    await runtime.stop();
  });
});

test('桥注册持续失败时入站记账，不静默消失', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{
        message_id: '8001',
        from_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }]],
    });
    const superagent = fakeSuperagent({ failRegister: Number.POSITIVE_INFINITY });
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: api.createApi });
    runtime.attachBinder(binder);
    await runtime.start();

    // 核心服务在、但桥没注册上：必须在面板可见，而不是每条消息无声丢掉。
    await waitFor(
      () => (runtime.status().lastError?.message ?? '').includes('注册核心失败'),
      '注册失败记账',
    );
    assert.equal(runtime.status().bridge.registered, false);
    assert.equal(superagent.received.length, 0);
    assert.equal(api.record.typing.length, 0, '没受理就不开输入状态');
    await runtime.stop();
  });
});

test('桥注册失败后，下次入站自动补注册并当条交付', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{
        message_id: '8002',
        from_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: 'hi' } }],
      }]],
    });
    // bind 注册失败一次（attach 时桥还没绑定，不尝试），入站触发的懒重试成功。
    const superagent = fakeSuperagent({ failRegister: 1 });
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: api.createApi });
    runtime.attachBinder(binder);
    await runtime.start();

    await waitFor(() => superagent.received.length > 0, '补注册后交付');
    assert.equal(runtime.status().bridge.registered, true);
    assert.equal(runtime.status().lastError, undefined, '补注册成功不该留下错误');
    await runtime.stop();
  });
});
