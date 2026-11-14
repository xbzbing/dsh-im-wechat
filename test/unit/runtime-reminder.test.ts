import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WeixinRuntime } from '../../src/host/runtime.ts';
import { saveLongTask, saveQuestionSettings, saveSuperagent } from '../../src/host/panel-actions.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';
import { ACCOUNT, LOGIN, OWNER, fakeApi, waitFor, withDir } from './helpers/runtime-harness.ts';

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
    await saveSuperagent(runtime.panelActions(), false);

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

test('面板改阈值后判定立即用新值：调低会提醒，调高不再提醒', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();

    const api = fakeApi();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: api.createApi });
    await runtime.start();
    await saveSuperagent(runtime.panelActions(), false);
    const idle = async () => { await new Promise((resolve) => setTimeout(resolve, 10)); };

    const turn = (sessionId: string, turnNo: number, endAt: number) => {
      runtime.handleSessionEvent(sessionId, { type: 'turn/start', seq: 1, time: 0, data: { turn: turnNo } });
      runtime.handleSessionEvent(sessionId, {
        type: 'turn/end', seq: 2, time: endAt, data: { turn: turnNo, reason: { kind: 'completed' } },
      });
    };

    // 调低到 2 分钟：6 分钟的回合立刻提醒（默认 30 分钟时这条不会发）。
    await saveLongTask(runtime.panelActions(), 2);
    turn('sess-low', 1, 6 * 60_000);
    await waitFor(() => api.record.sent.length === 1, '调低阈值后提醒发出');

    // 调高到 60 分钟：40 分钟的回合不提醒（阈值没跟着变的话这条会再发一条）。
    const raised = await saveLongTask(runtime.panelActions(), 60);
    assert.equal(raised.longTaskThresholdMinutes, 60);
    turn('sess-high', 1, 40 * 60_000);
    await idle();
    assert.equal(api.record.sent.length, 1);
    await runtime.stop();
  });
});

test('登出时在等的提问按真实原因交回，不套用接入切换的文案', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();
    const api = fakeApi();
    const runtime = new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: api.createApi });
    await runtime.start();
    await saveSuperagent(runtime.panelActions(), false);
    // 默认等 5 分钟才提醒；这条用例要看的是登出时的取消，先关掉等待。
    await saveQuestionSettings(runtime.panelActions(), { delayMinutes: 0 });

    const result = runtime.handleQuestion(
      { questions: [{ id: 'q1', question: '去哪', options: [{ label: '面' }] }] },
      () => new Promise(() => {}),
    );
    await waitFor(() => runtime.status().pendingQuestions > 0, '提问被接管');
    // 先挂好结局观察，避免取消发生在 logout 的 await 点之间被判未处理 rejection。
    const settled = result.then((value) => ({ value }), (error) => ({ error }));

    await runtime.logout();
    const outcome = await settled;
    assert.ok('error' in outcome, '提问被取消交回');
    assert.match(String((outcome as { error: unknown }).error), /已登出微信/);
    await runtime.stop();
  });
});

test('提醒设置：默认等 5 分钟，保存后落盘并在重启后沿用', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const make = () => new WeixinRuntime({ config: { dataDir: dir }, workspaceDir: dir, createApi: fakeApi().createApi });
    const runtime = make();
    await runtime.start();
    const first = runtime.status();
    assert.deepEqual([first.questionReminders, first.questionDelayMinutes], [true, 5]);

    const next = await saveQuestionSettings(runtime.panelActions(), { enabled: false, delayMinutes: 12 });
    assert.deepEqual([next.questionReminders, next.questionDelayMinutes], [false, 12]);
    await runtime.stop();

    const again = make();
    await again.start();
    const second = again.status();
    assert.deepEqual([second.questionReminders, second.questionDelayMinutes], [false, 12]);
    await again.stop();
  });
});

test('接入核心后审批提醒不接管；切到独立模式才发提醒并计数', async () => {
  await withDir(async (dir) => {
    await new LoginStateStore({ dir }).save(LOGIN);
    const tokens = new ContextTokenStore({ dir });
    tokens.set(ACCOUNT, OWNER, 'ctx-owner');
    await tokens.flush();

    const api = fakeApi();
    const runtime = new WeixinRuntime({
      config: { dataDir: dir, questionDelayMinutes: 0 },
      createApi: api.createApi,
    });
    await runtime.start();
    // 默认「接入我的超级助理」：审批由核心接管，这里一条都不发。
    const request = () => ({ toolName: 'bash', agent: { id: 'sess-1', session: { header: {} } } });
    assert.equal(await runtime.handleApproval(request(), async () => 'rejected'), 'rejected');
    assert.deepEqual(api.record.sent, []);

    await saveSuperagent(runtime.panelActions(), false);
    const pending = runtime.handleApproval(request(), () => new Promise(() => {}));
    await waitFor(() => runtime.status().pendingApprovals === 1, '审批提醒发出并挂上待授权');
    assert.match(api.record.sent[0]!, /需要你授权 #1：bash/);

    await runtime.stop();
    pending.catch(() => {});
  });
});
