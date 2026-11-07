import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LoginController } from '../../src/host/ilink/login.ts';
import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { LoginStateStore } from '../../src/host/state/login-state.ts';

interface StatusCall {
  qrcode: string;
  verifyCode?: string;
  baseUrl?: string;
}

/** 按脚本回放扫码状态，并记录调用参数。 */
function scriptedApi(statuses: Array<Record<string, unknown>>): {
  api: ILinkApi;
  calls: StatusCall[];
  qrCodeCalls: number;
} {
  const calls: StatusCall[] = [];
  let qrCodeCalls = 0;
  let index = 0;
  const api = {
    async getBotQrCode() {
      qrCodeCalls += 1;
      return { qrcode: `q-${qrCodeCalls}`, qrcode_img_content: `https://weixin.qq.com/x/q-${qrCodeCalls}` };
    },
    async getQrStatus(params: StatusCall) {
      calls.push(params);
      const next = statuses[index] ?? { status: 'wait' };
      index += 1;
      return next;
    },
  } as unknown as ILinkApi;
  return { api, calls, get qrCodeCalls() { return qrCodeCalls; } } as unknown as {
    api: ILinkApi;
    calls: StatusCall[];
    qrCodeCalls: number;
  };
}

interface Harness {
  controller: LoginController;
  store: LoginStateStore;
  calls: StatusCall[];
  confirmed: string[];
  dir: string;
}

async function harness(
  statuses: Array<Record<string, unknown>>,
  options: { qrThrows?: boolean; timings?: Record<string, number> } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-login-'));
  const store = new LoginStateStore({ dir });
  const scripted = scriptedApi(statuses);
  if (options.qrThrows) {
    (scripted.api as unknown as { getBotQrCode: () => Promise<unknown> }).getBotQrCode = async () => {
      throw new Error('boom');
    };
  }
  let clock = 0;
  const confirmed: string[] = [];
  const controller = new LoginController({
    apiFactory: () => scripted.api,
    store,
    // 每读一次时间前进 1 秒：轮询循环有界，不会在「一直 wait」的脚本上打转。
    now: () => (clock += 1_000),
    // 让出宏任务：状态机的等待循环才能与测试的断言交替执行。
    sleep: async () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    onConfirmed: (state) => {
      confirmed.push(state.account);
    },
    ...(options.timings ? { timings: options.timings } : {}),
  });
  return { controller, store, calls: scripted.calls, confirmed, dir };
}

test('确认登录后落盘登录态并回调', async () => {
  const h = await harness([
    { status: 'wait' },
    { status: 'scaned' },
    { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot@im.bot', ilink_user_id: 'u1', baseurl: 'https://cn.example' },
  ]);
  try {
    const started = await h.controller.start();
    assert.equal(started.phase, 'waiting');
    assert.equal(started.qrContent, 'https://weixin.qq.com/x/q-1');
    await h.controller.waitForSettled();
    assert.equal(h.controller.snapshot().phase, 'confirmed');
    const stored = await h.store.load();
    assert.deepEqual(
      { ...stored, loggedInAt: 0 },
      {
        version: 1,
        botToken: 'tok',
        account: 'bot@im.bot',
        userId: 'u1',
        baseUrl: 'https://cn.example',
        loggedInAt: 0,
      },
    );
    assert.equal(typeof stored?.loggedInAt, 'number');
    assert.deepEqual(h.confirmed, ['bot@im.bot']);
    assert.equal(h.calls[0].qrcode, 'q-1');
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('need_verifycode 时停下等主人输入，提交后继续', async () => {
  const h = await harness([
    { status: 'need_verifycode' },
    { status: 'scaned' },
    { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot@im.bot' },
  ]);
  try {
    await h.controller.start();
    // 让出事件循环，状态机推进到「等验证码」。
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.controller.snapshot().phase, 'need-verify-code');
    h.controller.submitVerifyCode('123456');
    await h.controller.waitForSettled();
    assert.equal(h.controller.snapshot().phase, 'confirmed');
    assert.equal(h.calls.some((call) => call.verifyCode === '123456'), true);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('二维码过期会刷新，超过次数上限判定失败', async () => {
  const h = await harness([
    { status: 'expired' },
    { status: 'expired' },
    { status: 'expired' },
    { status: 'expired' },
    { status: 'expired' },
  ]);
  try {
    await h.controller.start();
    await h.controller.waitForSettled();
    const snapshot = h.controller.snapshot();
    assert.equal(snapshot.phase, 'failed');
    assert.equal(snapshot.refreshed, 4);
    assert.match(snapshot.error ?? '', /多次失效/);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('binded_redirect 视为已绑定而不是失败', async () => {
  const h = await harness([{ status: 'binded_redirect' }]);
  try {
    await h.controller.start();
    await h.controller.waitForSettled();
    assert.equal(h.controller.snapshot().phase, 'binded');
    assert.equal(await h.store.load(), null);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('scaned_but_redirect 把后续轮询切到新域名', async () => {
  const h = await harness([
    { status: 'scaned_but_redirect', redirect_host: 'idc2.ilink.weixin.qq.com' },
    { status: 'confirmed', bot_token: 'tok', ilink_bot_id: 'bot@im.bot' },
  ]);
  try {
    await h.controller.start();
    await h.controller.waitForSettled();
    assert.equal(h.calls[1].baseUrl, 'https://idc2.ilink.weixin.qq.com');
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('取二维码失败时给出失败状态而不是抛错', async () => {
  const h = await harness([], { qrThrows: true });
  try {
    const snapshot = await h.controller.start();
    assert.equal(snapshot.phase, 'failed');
    assert.match(snapshot.error ?? '', /取二维码失败/);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('取消后状态是 cancelled，且不再落盘', async () => {
  const h = await harness([{ status: 'wait' }]);
  try {
    await h.controller.start();
    await h.controller.cancel();
    assert.equal(h.controller.snapshot().phase, 'cancelled');
    assert.equal(await h.store.load(), null);
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});

test('已经在登录中时重复 start 不另起流程', async () => {
  const h = await harness([{ status: 'wait' }]);
  try {
    const first = await h.controller.start();
    const second = await h.controller.start();
    assert.deepEqual(second, first);
    await h.controller.cancel();
  } finally {
    await rm(h.dir, { recursive: true, force: true });
  }
});
