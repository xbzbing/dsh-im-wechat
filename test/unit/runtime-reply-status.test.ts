import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { LocalConfigStore } from '../../src/host/config.ts';
import { saveDirect } from '../../src/host/panel-actions.ts';
import { WeixinRuntime } from '../../src/host/runtime.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import { LOGIN, fakeApi, withDir } from './helpers/runtime-harness.ts';

test('状态信息开关：静态配置是默认值，面板保存后落盘并立即生效', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false, replyStatus: true } });
    await runtime.start();
    assert.equal(runtime.status().direct.replyStatus, true);

    // 面板关掉：状态立刻变，落盘留给下一次启动。
    await saveDirect(runtime.panelActions(), { replyStatus: false });
    assert.equal(runtime.status().direct.replyStatus, false);
    assert.equal((await new LocalConfigStore({ dir }).load()).replyStatus, false);

    // 重启后以落盘的值为准，静态配置只在没有落盘值时兜底。
    const restarted = new WeixinRuntime({ config: { dataDir: dir, superagent: false, replyStatus: true } });
    await restarted.start();
    assert.equal(restarted.status().direct.replyStatus, false);
    await restarted.stop();
    await runtime.stop();
  });
});

test('状态信息开关：没有静态配置也没有落盘值时默认关', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false } });
    await runtime.start();
    assert.equal(runtime.status().direct.replyStatus, false);
    await runtime.stop();
  });
});

test('状态信息开关：落盘的值优先于静态配置', async () => {
  await withDir(async (dir) => {
    await new LocalConfigStore({ dir }).save({ replyStatus: true });
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false, replyStatus: false } });
    await runtime.start();
    assert.equal(runtime.status().direct.replyStatus, true);
    await runtime.stop();
  });
});

test('接入核心时独立模式整段不进：会话事件不会给回复附加状态行', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    // 已绑定一个会话：证明「没有回复」是接入方式决定的，不是没绑定。
    await writeFile(
      join(dir, 'direct.json'),
      `${JSON.stringify({ version: 1, binding: { sessionId: 'sess-bound', workspaceId: '', boundAt: 1 } })}\n`,
    );
    const api = fakeApi();
    // superagent 默认开，且没有核心服务被撤（serviceAvailable 为真）：算接入核心。
    const runtime = new WeixinRuntime({ config: { dataDir: dir, replyStatus: true }, createApi: api.createApi });
    await runtime.start();
    assert.equal(runtime.status().superagent, true);

    runtime.handleSessionEvent({ id: 'sess-bound' }, { type: 'turn/start', data: { turn: 1 } });
    runtime.handleSessionEvent({ id: 'sess-bound' }, {
      type: 'assistant/message',
      data: { message: { source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: '答案' }] }, usage: { totalTokens: 7 } },
    });
    runtime.handleSessionEvent({ id: 'sess-bound' }, { type: 'turn/end', data: { turn: 1 } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(api.record.sent, [], '接核心时由核心回话，插件不再发一条带状态行的回复');
    await runtime.stop();
  });
});
