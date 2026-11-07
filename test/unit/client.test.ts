import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { en, zh } from '../../src/client/locales.ts';
import {
  createRpcCall,
  describeError,
  describeHealth,
  describeLoginPhase,
  formatTime,
  isHostOlder,
  isLoginActive,
  qrImageUrl,
  unwrapResult,
} from '../../src/client/logic.ts';

test('RPC 信封：成功取 value，失败抛带错误码的 Error', () => {
  assert.deepEqual(unwrapResult({ result: { ok: true, value: { a: 1 } } }), { a: 1 });
  assert.deepEqual(unwrapResult({ ok: true, value: 'x' }), 'x');
  assert.throws(
    () => unwrapResult({ result: { ok: false, error: { code: 'invalid-code', message: '验证码不能为空' } } }),
    (error: unknown) => error instanceof Error
      && error.message === '验证码不能为空'
      && (error as { code?: string }).code === 'invalid-code',
  );
  assert.throws(() => unwrapResult(null), /无法识别/);
});

test('rpcCall 走宿主 connection 的 /api 路由并拆信封', async () => {
  const calls: unknown[][] = [];
  const connection = {
    rpc: {
      async call(...args: unknown[]) {
        calls.push(args);
        return { result: { ok: true, value: { loggedIn: false } } };
      },
    },
  };
  const rpcCall = createRpcCall(connection);
  const value = await rpcCall('status', { x: 1 });
  assert.deepEqual(value, { loggedIn: false });
  assert.equal(calls[0][0], '/api');
  assert.equal(calls[0][1], 'dsh-im-wechat');
  assert.deepEqual(calls[0][2], { method: 'status', payload: { x: 1 } });
});

test('没有 connection 时给出可读错误', async () => {
  const rpcCall = createRpcCall(undefined);
  await assert.rejects(rpcCall('status'), /没有可用的 Host 连接/);
});

test('健康与扫码阶段翻译成中文原文', () => {
  assert.equal(describeHealth({ state: 'ok' }), '连接正常');
  assert.equal(describeHealth({ state: 'degraded' }), '连接异常');
  assert.equal(describeHealth({ state: 'down', reason: '尚未登录微信' }), '尚未登录微信');
  assert.equal(describeHealth(undefined), '未登录');
  assert.equal(describeLoginPhase('need-verify-code'), '需要在手机上输入验证码');
  assert.equal(describeLoginPhase('confirmed'), '登录成功');
  assert.equal(describeLoginPhase('idle'), '');
  assert.equal(isLoginActive('waiting'), true);
  assert.equal(isLoginActive('confirmed'), false);
});

test('契约版本对不上时判定为 Host 落后', () => {
  assert.equal(isHostOlder({ contract: 0 }, 1), true);
  assert.equal(isHostOlder({ contract: 1 }, 1), false);
  assert.equal(isHostOlder({ contract: 9 }, 1), false);
  assert.equal(isHostOlder(null, 1), false);
});

test('二维码渲染：正常内容出 data URL，超长内容退回 null', () => {
  const url = qrImageUrl('https://weixin.qq.com/x/abc');
  assert.match(url ?? '', /^data:image\/svg\+xml;charset=utf-8,/);
  assert.equal(qrImageUrl('x'.repeat(2_000)), null);
  assert.equal(qrImageUrl(''), null);
});

test('时间格式化与错误描述', () => {
  assert.match(formatTime(1_760_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatTime('x'), '');
  assert.deepEqual(describeError(new Error('boom')), { message: 'boom', code: '' });
  assert.deepEqual(describeError({ message: '', code: 'x' }), { message: '操作失败', code: 'x' });
});

test('文案：两种语言键集一致，面板里用到的文案都有翻译', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const source = readFileSync(new URL('../../src/client/panel.ts', import.meta.url), 'utf8');
  const used = new Set([...source.matchAll(/\bt\('([^']+)'\)/g)].map((match) => match[1]));
  for (const label of used) {
    assert.equal(Object.hasOwn(en, label), true, `缺少文案：${label}`);
  }
  // 状态翻译函数返回的也是送进 `t()` 的文案，同样必须有条目。
  for (const phase of ['waiting', 'scanned', 'need-verify-code', 'confirmed', 'binded', 'failed']) {
    const label = describeLoginPhase(phase);
    assert.equal(Object.hasOwn(en, label), true, `缺少文案：${label}`);
  }
  for (const health of [{ state: 'ok' }, { state: 'degraded' }, { state: 'down' }, null]) {
    const label = describeHealth(health);
    assert.equal(Object.hasOwn(en, label), true, `缺少文案：${label}`);
  }
});
