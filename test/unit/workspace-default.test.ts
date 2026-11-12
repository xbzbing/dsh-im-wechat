import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { WeixinRuntime } from '../../src/host/runtime.ts';
import type { WorkspaceRegistry } from '../../src/host/runtime-status.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import { LOGIN, OWNER, fakeApi, waitFor, withDir } from './helpers/runtime-harness.ts';

interface FakeRegistry extends WorkspaceRegistry {
  created: { path: string; title?: string }[];
  setFailing(value: boolean): void;
}

/** 按 `workspaceRegistry.create` 的真实语义：同一路径再次创建复用已有工作区。 */
function fakeRegistry(): FakeRegistry {
  const items: { id: string; title: string; path: string }[] = [];
  const created: { path: string; title?: string }[] = [];
  let failing = false;
  return {
    created,
    list: () => items,
    async create(path: string, title?: string) {
      created.push({ path, ...(title !== undefined ? { title } : {}) });
      if (failing) throw new Error('创建失败');
      const existing = items.find((item) => item.path === path);
      if (existing) return existing;
      const workspace = { id: `ws-${items.length + 1}`, title: title ?? path, path };
      items.push(workspace);
      return workspace;
    },
    setFailing(value: boolean) {
      failing = value;
    },
  };
}

function fakeSession() {
  const created: { workspaceId?: string }[] = [];
  const prompts: { sessionId: string; content: readonly unknown[] }[] = [];
  return {
    created,
    prompts,
    controller: {
      async create(request: { workspaceId?: string }) {
        created.push(request);
        return { sessionId: 'sess-1' };
      },
      async prompt(request: { sessionId: string; content: readonly unknown[] }) {
        prompts.push({ sessionId: request.sessionId, content: request.content });
        return { accepted: true };
      },
    },
  };
}

test('独立模式：插件在数据目录自动建「微信会话」工作区，并作为默认工作区', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const registry = fakeRegistry();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    await runtime.start();

    await waitFor(() => registry.created.length > 0, '自动建工作区');
    assert.deepEqual(registry.created[0], { path: dir, title: '微信会话' });
    await waitFor(() => runtime.status().direct.workspaceId === 'ws-1', '默认工作区生效');

    // 面板读工作区列表前要等建好，否则下拉里看不到「微信会话」。
    const catalog = await runtime.workspacesView();
    assert.equal(catalog.available, true);
    assert.deepEqual(catalog.items, [{ id: 'ws-1', title: '微信会话', path: dir }]);
    await runtime.stop();
  });
});

test('独立模式：首条消息在默认的「微信会话」工作区建会话', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{
        message_id: '9301',
        from_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: '你好' } }],
      }]],
    });
    const registry = fakeRegistry();
    const session = fakeSession();
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => session.prompts.length > 0, '消息交给会话');
    assert.deepEqual(session.created, [{ workspaceId: 'ws-1' }]);
    await runtime.stop();
  });
});

test('独立模式：清空工作区选择后回到默认的「微信会话」', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const registry = fakeRegistry();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    await runtime.start();
    await waitFor(() => runtime.status().direct.workspaceId === 'ws-1', '默认工作区生效');

    const cleared = await runtime.setDirect({ workspaceId: '' });
    assert.equal(cleared.direct.workspaceId, 'ws-1');
    await runtime.stop();
  });
});

test('独立模式：自动建工作区失败时记账，并退回宿主默认位置', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const registry = fakeRegistry();
    registry.setFailing(true);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    await runtime.start();

    await waitFor(() => (runtime.status().lastError?.message ?? '').includes('自动创建工作区'), '失败记账');
    assert.equal(runtime.status().direct.workspaceId, '');
    await runtime.stop();
  });
});

test('独立模式：面板保存默认工作区时落成空值，重建后仍跟随默认', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const registry = fakeRegistry();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    await runtime.start();
    await waitFor(() => runtime.status().direct.workspaceId === 'ws-1', '默认工作区生效');

    const saved = await runtime.setDirect({ workspaceId: 'ws-1' });
    assert.equal(saved.direct.workspaceId, 'ws-1');
    const stored = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    assert.equal(stored.directWorkspaceId, '', '默认工作区不写成显式 id，换 id 后仍跟随默认');
    await runtime.stop();
  });
});

test('独立模式：工作区服务重新接入后重新登记默认工作区', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const first = fakeRegistry();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(first);
    await runtime.start();
    await waitFor(() => runtime.status().direct.workspaceId === 'ws-1', '默认工作区生效');

    // 宿主重建服务、工作区换了 id：解挂后再接入必须重新登记，不能沿用旧 id。
    const second = fakeRegistry();
    runtime.attachWorkspaceRegistry(null);
    runtime.attachWorkspaceRegistry(second);
    await waitFor(() => runtime.status().direct.workspaceId === 'ws-1', '重新登记');
    assert.equal(second.created.length, 1);
    await runtime.stop();
  });
});

test('独立模式：工作区服务一直不返回时，提交不会永远挂着', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[{
        message_id: '9302',
        from_user_id: OWNER,
        item_list: [{ type: 1, text_item: { text: '你好' } }],
      }]],
    });
    const registry = fakeRegistry();
    // 模拟宿主 create 永不落地：到点要能继续往下走（退回宿主默认位置）。
    registry.create = () => new Promise(() => {});
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
      workspaceTimeoutMs: 50,
    });
    runtime.attachWorkspaceRegistry(registry);
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => session.created.length > 0, '超时后仍建会话');
    assert.deepEqual(session.created, [{}], '拿不到默认工作区时落到宿主默认位置');
    await runtime.stop();
  });
});

test('独立模式：一批消息共用一个默认工作区，不重复登记', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({
      batches: [[
        { message_id: '9303', from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: '第一条' } }] },
        { message_id: '9304', from_user_id: OWNER, item_list: [{ type: 1, text_item: { text: '第二条' } }] },
      ]],
    });
    const registry = fakeRegistry();
    const session = fakeSession();
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => session.prompts.length === 2, '两条消息都交给会话');
    assert.equal(registry.created.length, 1, '默认工作区只登记一次');
    assert.deepEqual(session.created, [{ workspaceId: 'ws-1' }], '同一个会话复用，不重复建');
    await runtime.stop();
  });
});

test('独立模式：建工作区恢复成功后清掉之前那条失败记录', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi();
    const registry = fakeRegistry();
    registry.setFailing(true);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: api.createApi });
    runtime.attachWorkspaceRegistry(registry);
    await runtime.start();
    await waitFor(() => (runtime.status().lastError?.message ?? '').includes('自动创建工作区'), '失败记账');

    // 服务恢复后重新接入：默认工作区建成功，旧的失败横幅要跟着消失。
    registry.setFailing(false);
    runtime.attachWorkspaceRegistry(registry);
    await waitFor(() => runtime.status().direct.workspaceId === 'ws-1', '重新登记成功');
    assert.equal(runtime.status().lastError, undefined);
    await runtime.stop();
  });
});
