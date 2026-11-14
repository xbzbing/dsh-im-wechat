import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { WeixinRuntime } from '../../src/host/runtime.ts';
import { saveDirect } from '../../src/host/panel-actions.ts';
import { LocalConfigStore } from '../../src/host/config.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import { ACCOUNT, LOGIN, OWNER, fakeApi, uploadFetch, waitFor, withDir } from './helpers/runtime-harness.ts';
import { imageFetch, imageMessage, imageOnlyMessage } from './helpers/inbound-fixtures.ts';

/** 独立模式接上宿主会话服务：只记账，不建真会话。 */
function fakeSession(options: { catalog?: unknown } = {}) {
  const prompts: { sessionId: string; content: readonly PromptPart[] }[] = [];
  return {
    prompts,
    controller: {
      async create() {
        return { sessionId: 'sess-image' };
      },
      async prompt(request: { sessionId: string; content: readonly PromptPart[] }) {
        prompts.push({ sessionId: request.sessionId, content: request.content });
        return { accepted: true };
      },
      ...(options.catalog === undefined ? {} : { async modelCatalog() { return options.catalog; } }),
    },
  };
}

/** 宿主的 agents 服务：记录模型选择落在哪个会话上（不建真 Agent）。 */
function fakeAgents(onSelect: () => void = () => undefined) {
  const selected: { sessionId: string; provider: string; model: string }[] = [];
  return {
    selected,
    service: {
      get(id: string) {
        return {
          id,
          model: {
            select(selection: { provider: string; model: string }) {
              selected.push({ sessionId: id, ...selection });
              onSelect();
            },
          },
        };
      },
    },
  };
}

/** 一条主人发的文字消息。 */
function textBatch(id: string, text: string) {
  return {
    message_id: id,
    from_user_id: OWNER,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

/** 带一个共享事件日志的会话：用来断言「先钉模型、再提交」。 */
function loggingSession(events: string[]) {
  const prompts: { sessionId: string; content: readonly PromptPart[] }[] = [];
  return {
    prompts,
    controller: {
      async create() {
        return { sessionId: 'sess-image' };
      },
      async prompt(request: { sessionId: string; content: readonly PromptPart[] }) {
        events.push('prompt');
        prompts.push({ sessionId: request.sessionId, content: request.content });
        return { accepted: true };
      },
    },
  };
}

test('独立模式：主人发的图片按附件交给绑定的会话', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const built = imageOnlyMessage();
    const api = fakeApi({ batches: [[{ ...built.message, from_user_id: OWNER, message_id: '9101' }]] });
    const fetch = imageFetch([built.payload]);
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
      fetch: fetch.impl,
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => session.prompts.length > 0, '图片交给会话');
    const content = session.prompts[0]?.content ?? [];
    assert.deepEqual(content[0], { type: 'text', text: '请看这张图' });
    assert.equal(content[1]?.type, 'image');
    assert.equal(content[1]?.type === 'image' ? content[1].mediaType : '', 'image/png');
    assert.equal(fetch.calls(), 1);
    await runtime.stop();
  });
});

test('独立模式：非主人发的图片不下载也不提交给会话', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const built = imageOnlyMessage();
    const api = fakeApi({ batches: [[{ ...built.message, from_user_id: 'stranger', message_id: '9102' }]] });
    const fetch = imageFetch([built.payload]);
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
      fetch: fetch.impl,
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => api.record.getUpdatesCalls > 1, '消息已处理');
    assert.deepEqual(session.prompts, []);
    assert.equal(fetch.calls(), 0);
    await runtime.stop();
  });
});

test('独立模式：文字与图片一起交给会话，文字在前', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const built = imageMessage(1);
    const api = fakeApi({ batches: [[built.message]] });
    const fetch = imageFetch([built.payload]);
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
      fetch: fetch.impl,
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => session.prompts.length > 0, '文字与图片一起交给会话');
    const content = session.prompts[0]?.content ?? [];
    assert.deepEqual(content[0], { type: 'text', text: '看这张' });
    assert.equal(content.filter((part) => part.type === 'image').length, 1);
    await runtime.stop();
  });
});

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test('独立模式：会话里 present 的图片自动发到主人的微信', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();
    const shot = join(dir, 'shot.png');
    await writeFile(shot, PNG_HEAD);

    const api = fakeApi({ batches: [[{
      message_id: '9401',
      from_user_id: OWNER,
      item_list: [{ type: 1, text_item: { text: '把刚才那张图发回来' } }],
    }]] });
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
      fetch: uploadFetch(),
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();
    await waitFor(() => session.prompts.length > 0, '建好绑定会话');

    runtime.handleSessionEvent('sess-image', {
      type: 'deliverables/presented',
      data: { turn: 1, files: [{ path: shot, description: '截图' }] },
    });
    await waitFor(() => api.record.images.length === 1, '图片发到微信');
    await runtime.stop();
  });
});

test('独立模式：present 的非图片文件不往微信发', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();
    const notes = join(dir, 'notes.txt');
    await writeFile(notes, 'hello');

    const api = fakeApi({ batches: [[{
      message_id: '9402',
      from_user_id: OWNER,
      item_list: [{ type: 1, text_item: { text: '看一下' } }],
    }]] });
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
      fetch: uploadFetch(),
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();
    await waitFor(() => session.prompts.length > 0, '建好绑定会话');

    runtime.handleSessionEvent('sess-image', {
      type: 'deliverables/presented',
      data: { turn: 1, files: [{ path: notes }] },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(api.record.images, []);
    assert.deepEqual(api.record.sent, []);
    await runtime.stop();
  });
});

test('独立模式：回合在跑时的新消息默认插队，面板改过就按改的来', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: fakeApi().createApi });
    assert.equal(runtime.status().direct?.busyMode, 'steer');
    await saveDirect(runtime.panelActions(), { busyMode: 'queue' });
    assert.equal(runtime.status().direct?.busyMode, 'queue');
    await runtime.stop();
  });
});

test('独立模式：配了模型就钉在新建的会话上', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({ batches: [[textBatch('9201', '你好')]] });
    const events: string[] = [];
    const session = loggingSession(events);
    const agents = fakeAgents(() => events.push('select'));
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false, directModel: { provider: 'p1', model: 'm1' } },
      createApi: api.createApi,
    });
    runtime.attachSessionController(session.controller);
    runtime.attachAgents(agents.service);
    await runtime.start();

    await waitFor(() => session.prompts.length > 0, '消息交给会话');
    assert.deepEqual(agents.selected, [{ sessionId: 'sess-image', provider: 'p1', model: 'm1' }]);
    // 模型必须在第一条消息之前钉上：顺序反了，这一轮就还用 DSH 默认模型。
    assert.deepEqual(events, ['select', 'prompt']);
    await runtime.stop();
  });
});

test('独立模式：没配模型就不碰会话自己的模型选择', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({ batches: [[textBatch('9202', '你好')]] });
    const session = fakeSession();
    const agents = fakeAgents();
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: api.createApi });
    runtime.attachSessionController(session.controller);
    runtime.attachAgents(agents.service);
    await runtime.start();

    await waitFor(() => session.prompts.length > 0, '消息交给会话');
    assert.deepEqual(agents.selected, []);
    assert.equal(runtime.status().direct.model, null);
    await runtime.stop();
  });
});

test('面板选模型：已绑定的会话立刻换过去，并落盘等重启沿用', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const api = fakeApi({ batches: [[textBatch('9203', '你好')]] });
    const session = fakeSession();
    const agents = fakeAgents();
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: api.createApi });
    runtime.attachSessionController(session.controller);
    runtime.attachAgents(agents.service);
    await runtime.start();
    await waitFor(() => session.prompts.length > 0, '建好绑定会话');

    await saveDirect(runtime.panelActions(), { model: { provider: 'p2', model: 'm2' } });
    assert.deepEqual(agents.selected, [{ sessionId: 'sess-image', provider: 'p2', model: 'm2' }]);
    assert.deepEqual(runtime.status().direct.model, { provider: 'p2', model: 'm2' });
    assert.deepEqual((await new LocalConfigStore({ dir }).load()).directModel, { provider: 'p2', model: 'm2' });
    await runtime.stop();
  });
});

test('面板清空模型：写 null 表示跟随 DSH 默认，不回落到 profile 配置', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false, directModel: { provider: 'p1', model: 'm1' } },
      createApi: fakeApi().createApi,
    });
    await runtime.start();
    assert.deepEqual(runtime.status().direct.model, { provider: 'p1', model: 'm1' });

    await saveDirect(runtime.panelActions(), { model: null });
    assert.equal(runtime.status().direct.model, null);
    assert.equal((await new LocalConfigStore({ dir }).load()).directModel, null);
    await runtime.stop();
  });
});

test('面板选模型：目录里没有的组合拒绝保存，目录里有才写', async () => {
  await withDir(async (dir) => {
    const session = fakeSession({
      catalog: { groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }] },
    });
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: fakeApi().createApi });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await assert.rejects(
      () => saveDirect(runtime.panelActions(), { model: { provider: 'p9', model: 'm9' } }),
      (error: unknown) => (error as { code?: string }).code === 'invalid-config',
    );
    assert.equal(runtime.status().direct.model, null);

    await saveDirect(runtime.panelActions(), { model: { provider: 'p1', model: 'm1' } });
    assert.deepEqual(runtime.status().direct.model, { provider: 'p1', model: 'm1' });
    await runtime.stop();
  });
});

test('模型目录：没有会话服务时标成不可用并给出原因', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    const view = await runtime.panelActions().models();
    assert.equal(view.available, false);
    assert.match(view.reason ?? '', /模型目录/);
    await runtime.stop();
  });
});

test('模型目录：读得到就拍平成下拉行', async () => {
  await withDir(async (dir) => {
    const session = fakeSession({
      catalog: {
        default: { provider: 'p1', model: 'm1' },
        groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }],
      },
    });
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, createApi: fakeApi().createApi });
    runtime.attachSessionController(session.controller);
    const view = await runtime.panelActions().models();
    assert.equal(view.available, true);
    assert.deepEqual(view.default, { provider: 'p1', model: 'm1' });
    assert.deepEqual(view.items.map((item) => `${item.provider}/${item.model}`), ['p1/m1', 'p1/m2']);
    await runtime.stop();
  });
});

test('独立模式：模型目录读不到时照样能保存模型（不误拦）', async () => {
  await withDir(async (dir) => {
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: fakeApi().createApi });
    await runtime.start();
    assert.equal((await runtime.panelActions().models()).available, false);

    await saveDirect(runtime.panelActions(), { model: { provider: 'p1', model: 'm1' } });
    assert.deepEqual(runtime.status().direct.model, { provider: 'p1', model: 'm1' });
    await runtime.stop();
  });
});

test('独立模式：某个 provider 的目录读失败时，它的模型不算已下架', async () => {
  await withDir(async (dir) => {
    const session = fakeSession({
      catalog: {
        groups: [{ id: 'p1', name: 'P1', models: [{ id: 'm1', name: 'M1' }] }],
        failures: [{ id: 'p2', name: 'P2', message: 'no key' }],
      },
    });
    const runtime = new WeixinRuntime({ config: { dataDir: dir, superagent: false }, createApi: fakeApi().createApi });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    const view = await runtime.panelActions().models();
    assert.deepEqual(view.unavailableProviders, ['p2']);
    // p2 只是没读到，不能因此拒掉保存。
    await saveDirect(runtime.panelActions(), { model: { provider: 'p2', model: 'm2' } });
    assert.deepEqual(runtime.status().direct.model, { provider: 'p2', model: 'm2' });
    await runtime.stop();
  });
});
