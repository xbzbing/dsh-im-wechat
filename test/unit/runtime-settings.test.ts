import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { WeixinRuntime } from '../../src/host/runtime.ts';
import { saveEnabled, saveLongTask, saveSuperagent } from '../../src/host/panel-actions.ts';
import { BridgeBinder } from '../../src/host/superagent/link.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import { LOGIN, fakeApi, fakeSuperagent, waitFor, withDir } from './helpers/runtime-harness.ts';

test('关掉「接入我的超级助理」会注销桥，并让自有功能生效', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const superagent = fakeSuperagent();
    const binder = new BridgeBinder();
    binder.attach(superagent.scope);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
    runtime.attachBinder(binder);
    await runtime.start();
    await waitFor(() => runtime.status().bridge.registered, '桥注册');
    assert.equal(runtime.status().superagent, true);
    assert.equal(runtime.status().ownFeatures, false);

    const status = await saveSuperagent(runtime.panelActions(), false);
    assert.equal(status.superagent, false);
    assert.equal(status.bridge.registered, false);
    assert.equal(status.ownFeatures, true);

    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as { superagent?: boolean };
    assert.equal(persisted.superagent, false);

    // 重新打开后桥回来。
    const again = await saveSuperagent(runtime.panelActions(), true);
    assert.equal(again.bridge.registered, true);
    assert.equal(again.ownFeatures, false);
    await runtime.stop();
  });
});

test('两项面板开关互不覆盖（合并保存）', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
    await runtime.start();
    await saveEnabled(runtime.panelActions(), false);
    await saveSuperagent(runtime.panelActions(), false);
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
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
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
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
    await runtime.start();
    assert.equal(runtime.status().longTaskThresholdMinutes, 30);

    const status = await saveLongTask(runtime.panelActions(), 45);
    assert.equal(status.longTaskThresholdMinutes, 45);
    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')) as {
      longTaskThresholdMinutes?: number;
    };
    assert.equal(persisted.longTaskThresholdMinutes, 45);

    const restarted = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
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
    await saveLongTask(runtime.panelActions(), 45);
    const restarted = new WeixinRuntime({
      config: { dataDir: dir, longTaskThresholdMinutes: 5 },
      createApi: fakeApi().createApi,
    });
    await restarted.start();
    assert.equal(restarted.status().longTaskThresholdMinutes, 45);
    await restarted.stop();

    // 越界值收窄到 1–1440，而不是把提醒阈值设成 0（等于每条回合都提醒）。
    assert.equal((await saveLongTask(runtime.panelActions(), 0)).longTaskThresholdMinutes, 1);
    assert.equal((await saveLongTask(runtime.panelActions(), 1e9)).longTaskThresholdMinutes, 1_440);
    await runtime.stop();
  });
});
