/**
 * 核心缺席时的接入语义：没装（或没启用）`mySuperagent` 只能走独立模式。
 *
 * 回归的是「面板能打开接入、但入站交给不存在的消费方 → 微信沉默」：判据必须同时
 * 看开关与核心服务，且核心晚到/撤销都要能自动重判。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WeixinRuntime } from '../../src/host/runtime.ts';
import { saveSuperagent } from '../../src/host/panel-actions.ts';
import { BridgeBinder } from '../../src/host/superagent/link.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import { LOGIN, OWNER, fakeApi, fakeSuperagent, waitFor, withDir } from './helpers/runtime-harness.ts';

/** 独立模式的会话服务：只记账，不建真会话。 */
function fakeSession() {
  const prompts: { sessionId: string; content: readonly PromptPart[] }[] = [];
  return {
    prompts,
    controller: {
      async create() { return { sessionId: 'sess-standalone' }; },
      async prompt(request: { sessionId: string; content: readonly PromptPart[] }) {
        prompts.push({ sessionId: request.sessionId, content: request.content });
        return { accepted: true };
      },
    },
  };
}

test('没装核心时：开关即使存着 true 也不算数，host 拒绝打开', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    // 绑定器没接上服务：模拟没装核心（或装了没启用）。
    const binder = new BridgeBinder();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: true },
      workspaceDir: dir,
      createApi: fakeApi().createApi,
    });
    runtime.attachBinder(binder);
    await runtime.start();

    const status = runtime.status();
    assert.equal(status.superagentAvailable, false);
    assert.equal(status.superagent, false, '没核心可交，开关不能算数');
    assert.equal(status.ownFeatures, true, '自有功能接管');
    assert.equal(status.bridge.registered, false);

    // 面板已禁用开关；旧面板或直接调用也必须被 host 挡住。
    await assert.rejects(
      () => saveSuperagent(runtime.panelActions(), true),
      (error: { code?: string }) => error.code === 'superagent-unavailable',
    );
    assert.equal(runtime.status().superagent, false);
    await runtime.stop();
  });
});

test('核心晚到会自动注册桥；核心撤销后退回独立模式', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
    runtime.attachBinder(binder);
    // 插件加载顺序：本插件先起，核心后到。
    await runtime.start();
    assert.equal(runtime.status().superagentAvailable, false);
    assert.equal(runtime.status().ownFeatures, true);

    binder.attach(superagent.scope);
    await waitFor(() => runtime.status().bridge.registered, '核心出现后补注册');
    assert.equal(runtime.status().superagent, true);
    assert.equal(runtime.status().ownFeatures, false);

    for (const cleanup of superagent.cleanups) cleanup();
    assert.equal(runtime.status().superagentAvailable, false);
    assert.equal(runtime.status().superagent, false);
    assert.equal(runtime.status().bridge.registered, false);
    assert.equal(runtime.status().ownFeatures, true);
    await runtime.stop();
  });
});
test('没装核心但开关存着 true：入站仍交给直连会话，不沉默', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{
        message_id: '9201',
        from_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: '在吗' } }],
      }]],
    });
    const session = fakeSession();
    const binder = new BridgeBinder();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: true },
      workspaceDir: dir,
      createApi: api.createApi,
    });
    runtime.attachBinder(binder);
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => session.prompts.length > 0, '消息交给直连会话');
    assert.deepEqual(session.prompts[0]?.content[0], { type: 'text', text: '在吗' });
    await runtime.stop();
  });
});
