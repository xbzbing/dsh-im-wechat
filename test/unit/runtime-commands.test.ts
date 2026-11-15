import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WeixinRuntime } from '../../src/host/runtime.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import { ACCOUNT, LOGIN, OWNER, fakeApi, waitFor, withDir } from './helpers/runtime-harness.ts';

/** 一条主人发的文字消息。 */
function textBatch(id: string, text: string) {
  return {
    message_id: id,
    from_user_id: OWNER,
    item_list: [{ type: 1, text_item: { text } }],
  };
}

/** 独立模式接上宿主会话服务：只记账，不建真会话。 */
function fakeSession() {
  const prompts: { sessionId: string; content: readonly PromptPart[] }[] = [];
  return {
    prompts,
    controller: {
      async create() {
        return { sessionId: 'sess-1' };
      },
      async prompt(request: { sessionId: string; content: readonly PromptPart[] }) {
        prompts.push({ sessionId: request.sessionId, content: request.content });
        return { accepted: true };
      },
      async list() {
        return {
          items: [{
            sessionId: 'session-12345678',
            updatedAt: 1_760_000_000_000,
            running: false,
            cwd: '/tmp/another-workspace',
            projections: { values: { title: '别的会话' } },
          }],
        };
      },
    },
  };
}

test('独立模式：/help 与 /sessions 在微信里直接回答，不建会话', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();

    const api = fakeApi({ batches: [[textBatch('9501', '/help'), textBatch('9502', '/sessions')]] });
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => api.record.sent.length >= 2, '两条命令都回了');
    assert.match(api.record.sent[0]!, /微信命令/);
    assert.match(api.record.sent[1]!, /最近会话\*\*（共 1 个）/);
    assert.match(api.record.sent[1]!, /别的会话/);
    assert.match(api.record.sent[1]!, /12345678/);
    assert.deepEqual(session.prompts, [], '命令不进会话');
    await runtime.stop();
  });
});

test('独立模式：/send 到别的会话，回答经会话事件推回微信', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();

    const api = fakeApi({ batches: [[textBatch('9601', '/sessions'), textBatch('9602', '/send 1 你好')]] });
    const session = fakeSession();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
    });
    runtime.attachSessionController(session.controller);
    await runtime.start();

    await waitFor(() => api.record.sent.length >= 2, '命令回执都发了');
    // 目标会话不是绑定的那个：观察者仍要收到它的事件。
    runtime.handleSessionEvent('session-12345678', { type: 'turn/start', data: { turn: 1 } });
    runtime.handleSessionEvent('session-12345678', {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] },
    });
    runtime.handleSessionEvent('session-12345678', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '这是回答' }] } },
    });
    runtime.handleSessionEvent('session-12345678', { type: 'turn/end', data: { reason: { kind: 'completed' } } });

    await waitFor(() => api.record.sent.length >= 3, '回答发回微信');
    assert.match(api.record.sent[2]!, /来自会话「别的会话」/);
    assert.match(api.record.sent[2]!, /这是回答/);
    await runtime.stop();
  });
});

test('独立模式：/trace 任意会话，每轮结束推提问与回答', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();

    const api = fakeApi({ batches: [[textBatch('9701', '/sessions'), textBatch('9702', '/trace 1 30')]] });
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, superagent: false },
      createApi: api.createApi,
    });
    runtime.attachSessionController(fakeSession().controller);
    await runtime.start();

    await waitFor(() => api.record.sent.length >= 2, '跟踪回执发了');
    runtime.handleSessionEvent('session-12345678', { type: 'turn/start', data: { turn: 1 } });
    runtime.handleSessionEvent('session-12345678', {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '在跑什么' }] },
    });
    runtime.handleSessionEvent('session-12345678', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '在跑测试' }] } },
    });
    runtime.handleSessionEvent('session-12345678', { type: 'turn/end', data: { reason: { kind: 'completed' } } });

    await waitFor(() => api.record.sent.length >= 3, '跟踪推送发了');
    assert.match(api.record.sent[2]!, /跟踪 ·「别的会话」/);
    assert.match(api.record.sent[2]!, /> 在跑什么/);
    assert.match(api.record.sent[2]!, /在跑测试/);
    await runtime.stop();
  });
});
