import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { en, fallbackTranslate, zh } from '../../src/client/locales.ts';
import { MAX_LONG_TASK_MINUTES, MIN_LONG_TASK_MINUTES } from '../../src/client/constants.ts';
import {
  createRpcCall,
  describeError,
  describeHealth,
  describeLoginPhase,
  errorText,
  formatTime,
  healthText,
  isHostOlder,
  isHttpsUrl,
  isLoginActive,
  qrImageUrl,
  MENU_SURFACE_CLASS,
  MENU_Z_INDEX,
  menuSurfaceStyle,
  placeMenu,
  standaloneSettingsLocked,
  unwrapResult,
  validateMinutes,
  validateQuestionDelay,
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

test('健康与扫码阶段映射到文案键，宿主原因保持原文', () => {
  assert.deepEqual(describeHealth({ state: 'ok' }), { key: 'health.ok' });
  assert.deepEqual(describeHealth({ state: 'degraded' }), { key: 'health.degraded' });
  assert.deepEqual(describeHealth({ state: 'down', reason: '尚未登录微信' }), { text: '尚未登录微信' });
  assert.deepEqual(describeHealth({ state: 'down' }), { key: 'health.down' });
  assert.deepEqual(describeHealth(undefined), { key: 'health.unknown' });
  assert.equal(healthText(fallbackTranslate, { state: 'ok' }), '连接正常');
  assert.equal(healthText(fallbackTranslate, { state: 'down', reason: 'token 已失效' }), 'token 已失效');
  assert.equal(describeLoginPhase('need-verify-code'), 'login.phase.needCode');
  assert.equal(describeLoginPhase('confirmed'), 'login.phase.confirmed');
  // 网络失败、缺 bot_token 等都会落到 failed：不能再说成「二维码已过期」。
  assert.equal(describeLoginPhase('failed'), 'login.phase.failed');
  assert.equal(describeLoginPhase('expired'), 'login.phase.expired');
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

test('只属于独立模式的设置：接入核心后一律锁住', () => {
  // 接入核心后提醒由核心按自己的设置发，本插件的值与直连设置都不再参与；
  // 留着可改等于让人改完发现没反应。
  assert.equal(standaloneSettingsLocked({ superagent: true, hostOlder: false, busy: '' }), true);
  assert.equal(standaloneSettingsLocked({ superagent: false, hostOlder: false, busy: '' }), false);
  // 另外两个锁：宿主版本对不上（不确定端点是否在）与有动作在跑。
  assert.equal(standaloneSettingsLocked({ superagent: false, hostOlder: true, busy: '' }), true);
  assert.equal(standaloneSettingsLocked({ superagent: false, hostOlder: false, busy: 'enabled' }), true);
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

test('下拉浮层用固定定位，落点写进内联样式', () => {
  const placed = placeMenu({ top: 100, left: 40, bottom: 130, width: 180 }, { width: 1000, height: 800 },
    { minWidth: 240, maxHeight: 320, gap: 4, padding: 12 });
  assert.deepEqual(menuSurfaceStyle(placed), {
    position: 'fixed',
    zIndex: MENU_Z_INDEX,
    top: 134,
    left: 40,
    width: 240,
    maxHeight: 320,
  });
});

test('下拉浮层没有落点时先藏起来，不闪一个 0,0 的框', () => {
  assert.deepEqual(menuSurfaceStyle(null), { position: 'fixed', top: 0, left: 0, visibility: 'hidden' });
});

test('下拉浮层的类名在样式表里存在，并且挂在 MenuSurface 上', () => {
  const css = readFileSync(new URL('../../src/client/styles.ts', import.meta.url), 'utf8');
  const rule = css.match(new RegExp(`\\.${MENU_SURFACE_CLASS}\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `styles.ts 里没有 .${MENU_SURFACE_CLASS} 规则`);
  assert.match(rule[1] ?? '', /position:\s*fixed/);
  assert.match(rule[1] ?? '', new RegExp(`z-index:\\s*${MENU_Z_INDEX}`));
  const ui = readFileSync(new URL('../../src/client/ui.ts', import.meta.url), 'utf8');
  assert.match(ui, /className:\s*MENU_SURFACE_CLASS/, 'ui.ts 没把类名交给 MenuSurface，浮层会没有材质与层级');
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
  assert.deepEqual(describeError({ message: '', code: 'x' }), { message: '', code: 'x' });
  assert.equal(errorText(fallbackTranslate, new Error('boom')), 'boom');
  assert.equal(errorText(fallbackTranslate, { message: '', code: 'x' }), '操作失败');
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

/** 运行期产出、同样要过 `t()` 的键（源码里没有字面量，只能从函数推导）。 */
function dynamicLabels(): string[] {
  const labels: string[] = [];
  for (const phase of ['waiting', 'scanned', 'need-verify-code', 'confirmed', 'binded', 'expired', 'failed']) {
    const key = describeLoginPhase(phase);
    if (key !== '') labels.push(key);
  }
  for (const health of [{ state: 'ok' }, { state: 'degraded' }, { state: 'down' }, null]) {
    const label = describeHealth(health);
    if ('key' in label) labels.push(label.key);
  }
  const rejected = validateMinutes('0');
  if (!rejected.ok) labels.push(rejected.key);
  return labels;
}

test('文案：两种语言键集一致', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
});

test('文案：面板用到的文案都有翻译，且没有未使用的文案', () => {
  const used = usedKeys(['index.ts', 'panel.ts', 'sections.ts']);
  for (const label of dynamicLabels()) used.add(label);
  for (const label of used) {
    assert.equal(Object.hasOwn(en, label), true, `缺少文案：${label}`);
  }
  for (const label of Object.keys(en)) {
    assert.equal(used.has(label), true, `未使用的文案：${label}`);
  }
});

test('文案：没有 Host 文案服务时回落到中文，占位符按宿主规则替换', () => {
  assert.equal(fallbackTranslate('panel.title'), '微信');
  assert.equal(fallbackTranslate('login.phase.waiting'), '等待扫码');
  assert.equal(
    fallbackTranslate('reminder.invalid', { min: MIN_LONG_TASK_MINUTES, max: MAX_LONG_TASK_MINUTES }),
    '需为 1 到 1440 的整数分钟',
  );
  assert.equal(
    fallbackTranslate('reminder.thresholdValue', { value: 30, unit: fallbackTranslate('common.minutes') }),
    '当前阈值：30 分钟',
  );
  // 缺参数时保留占位符，与宿主的插值实现一致。
  assert.equal(fallbackTranslate('reminder.invalid', { min: 1 }), '需为 1 到 {max} 的整数分钟');
});

test('动态文案先落到字典键或宿主原文，不把运行期文本当键', () => {
  for (const phase of ['waiting', 'scanned', 'need-verify-code', 'confirmed', 'binded', 'expired', 'failed']) {
    const key = describeLoginPhase(phase);
    assert.equal(Object.hasOwn(en, key), true, `缺少文案：${key}`);
  }
  for (const health of [{ state: 'ok' }, { state: 'degraded' }, { state: 'down' }, null]) {
    const label = describeHealth(health);
    if ('key' in label) assert.equal(Object.hasOwn(en, label.key), true, `缺少文案：${label.key}`);
  }
  // 宿主给的原因与报错是运行期文本，原样展示，不查字典。
  assert.equal(healthText(fallbackTranslate, { state: 'down', reason: 'token 已失效' }), 'token 已失效');
  assert.equal(errorText(fallbackTranslate, new Error('boom')), 'boom');
  for (const file of ['panel.ts', 'sections.ts']) {
    const source = readFileSync(new URL(`../../src/client/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bt\(\s*String\(/, `${file} 把运行期文本当成了文案键`);
    assert.doesNotMatch(source, /\bt\(\s*describeError\(/, `${file} 把宿主报错当成了文案键`);
  }
});

test('阈值校验：1 到 1440 的整数分钟才通过，其余给出可翻译的报错', () => {
  assert.deepEqual(validateMinutes('30'), { ok: true, value: 30 });
  assert.deepEqual(validateMinutes(' 1 '), { ok: true, value: 1 });
  assert.deepEqual(validateMinutes('1440'), { ok: true, value: 1440 });
  for (const raw of ['', '  ', '0', '1441', '-5', '30.4', 'abc', 'Infinity', 'NaN']) {
    const result = validateMinutes(raw);
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(raw)}`);
    if (!result.ok) {
      assert.equal(result.key, 'reminder.invalid');
      assert.deepEqual(result.params, { min: MIN_LONG_TASK_MINUTES, max: MAX_LONG_TASK_MINUTES });
    }
  }
  // 报错键必须在字典里，插值参数由常量提供。
  const rejected = validateMinutes('0');
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(Object.hasOwn(en, rejected.key), true, `缺少文案：${rejected.key}`);
});

test('提醒等待时间：0 到 120 的整数分钟才通过，其余给出可翻译的报错', () => {
  assert.deepEqual(validateQuestionDelay('5'), { ok: true, value: 5 });
  assert.deepEqual(validateQuestionDelay('0'), { ok: true, value: 0 });
  assert.deepEqual(validateQuestionDelay('120'), { ok: true, value: 120 });
  for (const bad of ['-1', '121', '1.5', 'soon', '']) {
    const result = validateQuestionDelay(bad);
    assert.equal(result.ok, false, bad);
    if (!result.ok) assert.deepEqual(result.params, { min: 0, max: 120 });
  }
});
