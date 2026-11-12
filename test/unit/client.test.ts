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
  isHttpsUrl,
  isLoginActive,
  qrImageUrl,
  placeMenu,
  unwrapResult,
  validateMinutes,
  workspaceOptions,
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

test('二维码链接只接受 https（防 javascript: 注入）', () => {
  assert.equal(isHttpsUrl('https://weixin.qq.com/x/abc'), true);
  assert.equal(isHttpsUrl('javascript:alert(1)'), false);
  assert.equal(isHttpsUrl('http://weixin.qq.com/x'), false);
  assert.equal(isHttpsUrl(''), false);
  assert.equal(isHttpsUrl(null), false);
});

test('下拉定位：正常情况落在触发器下方，宽度不足用最小宽度', () => {
  const placed = placeMenu({ top: 100, left: 40, bottom: 130, width: 180 }, { width: 1000, height: 800 },
    { minWidth: 240, maxHeight: 320, gap: 4, padding: 12 });
  assert.deepEqual(placed, { top: 134, left: 40, width: 240, maxHeight: 320 });
});

test('下拉定位：右侧放不下时向左夹回视口内', () => {
  const placed = placeMenu({ top: 100, left: 900, bottom: 130, width: 300 }, { width: 1000, height: 800 },
    { minWidth: 240, maxHeight: 320, gap: 4, padding: 12 });
  assert.equal(placed.left, 688);
  assert.equal(placed.width, 300);
});

test('下拉定位：下方空间不够时向上翻转，并按空间压缩高度', () => {
  const placed = placeMenu({ top: 500, left: 40, bottom: 530, width: 240 }, { width: 1000, height: 560 },
    { minWidth: 240, maxHeight: 320, gap: 4, padding: 12 });
  assert.equal(placed.maxHeight, 320);
  assert.equal(placed.top, 176);
});

test('下拉定位：上下都不够时压到视口内，顶边不越界', () => {
  const placed = placeMenu({ top: 4, left: 4, bottom: 34, width: 240 }, { width: 400, height: 120 },
    { minWidth: 240, maxHeight: 320, gap: 4, padding: 12 });
  assert.equal(placed.top, 12);
  assert.equal(placed.maxHeight, 96);
  assert.equal(placed.top + placed.maxHeight <= 120 - 12, true);
});

test('工作区下拉：把宿主快照转成选项，缺省时补一条默认项', () => {
  assert.deepEqual(workspaceOptions([
    { id: 'ws-1', title: '微信会话', path: '/Users/a/.dsh/dsh-im-wechat' },
    { id: 'ws-2', title: '  项目  ', path: '/repo' },
    { id: 'ws-1', title: '重复', path: '/x' },
    { title: '没有 id' },
  ], 'ws-1', '默认（微信会话）'), [
    { value: 'ws-1', label: '微信会话', hint: '/Users/a/.dsh/dsh-im-wechat' },
    { value: 'ws-2', label: '项目', hint: '/repo' },
  ]);
  assert.deepEqual(workspaceOptions([], '', '默认（微信会话）'), [{ value: '', label: '默认（微信会话）' }]);
  assert.deepEqual(workspaceOptions([{ id: 'ws-1', title: '微信会话', path: '' }], '', '默认（微信会话）'), [
    { value: '', label: '默认（微信会话）' },
    { value: 'ws-1', label: '微信会话' },
  ]);
});

test('时间格式化与错误描述', () => {
  assert.match(formatTime(1_760_000_000_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatTime('x'), '');
  assert.deepEqual(describeError(new Error('boom')), { message: 'boom', code: '' });
  assert.deepEqual(describeError({ message: '', code: 'x' }), { message: '操作失败', code: 'x' });
});

/** 面板源码里 `t('…')` / `t("…")` 引用到的文案键。 */
function usedKeys(files: string[]): Set<string> {
  const used = new Set<string>();
  for (const file of files) {
    const source = readFileSync(new URL(`../../src/client/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)) used.add(match[2]);
  }
  return used;
}

/** 运行期产出、同样要送进 `t()` 的文案（源码里没有字面量，只能从函数推导）。 */
function dynamicLabels(): string[] {
  const labels: string[] = [];
  for (const phase of ['waiting', 'scanned', 'need-verify-code', 'confirmed', 'binded', 'failed']) {
    labels.push(describeLoginPhase(phase));
  }
  for (const health of [{ state: 'ok' }, { state: 'degraded' }, { state: 'down' }, null]) {
    labels.push(describeHealth(health));
  }
  labels.push(describeError({ message: '', code: 'x' }).message);
  const rejected = validateMinutes('0');
  if (!rejected.ok) labels.push(rejected.message);
  return labels;
}

test('文案：两种语言键集一致', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('文案：面板用到的文案都有翻译，且没有未使用的文案', () => {
  const used = usedKeys(['panel.ts', 'sections.ts']);
  for (const label of dynamicLabels()) used.add(label);
  for (const label of used) {
    assert.equal(Object.hasOwn(en, label), true, `缺少文案：${label}`);
  }
  for (const label of Object.keys(en)) {
    assert.equal(used.has(label), true, `未使用的文案：${label}`);
  }
});

test('状态翻译与错误描述都包在 t() 内，英文界面不半中半英', () => {
  for (const file of ['panel.ts', 'sections.ts']) {
    const source = readFileSync(new URL(`../../src/client/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bdescribe(?:Health|LoginPhase|Error)\(/g)) {
      const before = source.slice(0, match.index ?? 0).trimEnd();
      assert.ok(before.endsWith('t('), `${file} 里 ${match[0]} 的调用点没有包在 t() 内`);
    }
  }
});

test('阈值校验：1 到 1440 的整数分钟才通过，其余给出可翻译的报错', () => {
  assert.deepEqual(validateMinutes('30'), { ok: true, value: 30 });
  assert.deepEqual(validateMinutes(' 1 '), { ok: true, value: 1 });
  assert.deepEqual(validateMinutes('1440'), { ok: true, value: 1440 });
  for (const raw of ['', '  ', '0', '1441', '-5', '30.4', 'abc', 'Infinity', 'NaN']) {
    const result = validateMinutes(raw);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw)}`);
    if (!result.ok) assert.equal(typeof result.message, 'string');
  }
  // 报错文案是翻译键，必须进字典。
  const rejected = validateMinutes('0');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(Object.hasOwn(en, rejected.message), true, `缺少文案：${rejected.message}`);
});
