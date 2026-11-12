import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { WeixinRuntime } from '../../src/host/runtime.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import { ACCOUNT, LOGIN, OWNER, fakeApi, uploadFetch, waitFor, withDir } from './helpers/runtime-harness.ts';
import { imageFetch, imageMessage, imageOnlyMessage } from './helpers/inbound-fixtures.ts';

/** 独立模式接上宿主会话服务：只记账，不建真会话。 */
function fakeSession() {
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
