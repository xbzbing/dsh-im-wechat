import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { LocalConfigStore, normalizePluginConfig } from '../../src/host/config.ts';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-config-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('独立模式的工作区与提交方式：只认合法值，非法值丢掉交给默认', () => {
  const config = normalizePluginConfig({ directWorkspaceId: 'ws-a', directBusyMode: 'steer' });
  assert.equal(config.directWorkspaceId, 'ws-a');
  assert.equal(config.directBusyMode, 'steer');
  assert.equal(normalizePluginConfig({ directBusyMode: 'interrupt' }).directBusyMode, undefined);
  assert.equal(normalizePluginConfig({ directWorkspaceId: '  ' }).directWorkspaceId, undefined);
  assert.equal(normalizePluginConfig({ directBusyMode: 'queue' }).directBusyMode, 'queue');
});

test('verifyPin 只认布尔值，默认不开启', () => {
  assert.equal(normalizePluginConfig({ verifyPin: true }).verifyPin, true);
  assert.equal(normalizePluginConfig({ verifyPin: false }).verifyPin, false);
  assert.equal('verifyPin' in normalizePluginConfig({ verifyPin: 'true' }), false);
  assert.equal('verifyPin' in normalizePluginConfig({}), false);
});

test('面板改的独立模式设置会落盘并在下次加载时读回', async () => {
  await withDir(async (dir) => {
    const store = new LocalConfigStore({ dir });
    await store.load();
    await store.save({ directWorkspaceId: 'ws-b', directBusyMode: 'steer' });
    const reloaded = new LocalConfigStore({ dir });
    const document = await reloaded.load();
    assert.equal(document.directWorkspaceId, 'ws-b');
    assert.equal(document.directBusyMode, 'steer');
    // 只改其中一项时，另一项要保留。
    await reloaded.save({ directBusyMode: 'queue' });
    const again = await new LocalConfigStore({ dir }).load();
    assert.equal(again.directWorkspaceId, 'ws-b');
    assert.equal(again.directBusyMode, 'queue');
  });
});

test('profile 配置里的长任务阈值收窄到 1–1440 分钟，非法值直接丢掉（交给默认 30）', () => {
  assert.deepEqual(normalizePluginConfig({ longTaskThresholdMinutes: 45 }).longTaskThresholdMinutes, 45);
  assert.equal(normalizePluginConfig({ longTaskThresholdMinutes: 0 }).longTaskThresholdMinutes, 1);
  assert.equal(normalizePluginConfig({ longTaskThresholdMinutes: 1e9 }).longTaskThresholdMinutes, 1_440);
  assert.equal('longTaskThresholdMinutes' in normalizePluginConfig({ longTaskThresholdMinutes: '45' }), false);
  assert.equal('longTaskThresholdMinutes' in normalizePluginConfig({}), false);
});

test('面板设置合并保存：三项互不覆盖，读回仍生效', async () => {
  await withDir(async (dir) => {
    const store = new LocalConfigStore({ dir });
    await store.load();
    await store.save({ enabled: false });
    await store.save({ longTaskThresholdMinutes: 45 });
    assert.deepEqual(await store.load(), {
      version: 1,
      enabled: false,
      longTaskThresholdMinutes: 45,
    });

    const restarted = new LocalConfigStore({ dir });
    assert.deepEqual(await restarted.load(), {
      version: 1,
      enabled: false,
      longTaskThresholdMinutes: 45,
    });
  });
});

test('磁盘上的阈值越界或不是数字时按边界收窄，不让插件起不来', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'config.json');
    await writeFile(path, `${JSON.stringify({ version: 1, longTaskThresholdMinutes: 99_999 })}\n`);
    assert.equal((await new LocalConfigStore({ dir }).load()).longTaskThresholdMinutes, 1_440);

    await writeFile(path, `${JSON.stringify({ version: 1, longTaskThresholdMinutes: 'abc' })}\n`);
    const loaded = await new LocalConfigStore({ dir }).load();
    assert.equal('longTaskThresholdMinutes' in loaded, false);
  });
});

test('文件是 0600、内容是合法 JSON', async () => {
  await withDir(async (dir) => {
    const store = new LocalConfigStore({ dir });
    await store.save({ longTaskThresholdMinutes: 30 });
    const text = await readFile(store.path, 'utf8');
    assert.deepEqual(JSON.parse(text), { version: 1, longTaskThresholdMinutes: 30 });
    assert.match(text, /\n$/);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  });
});

test('typingIndicator 只收布尔值，缺省视为开启', () => {
  assert.equal(normalizePluginConfig({ typingIndicator: false }).typingIndicator, false);
  assert.equal(normalizePluginConfig({ typingIndicator: true }).typingIndicator, true);
  assert.equal('typingIndicator' in normalizePluginConfig({ typingIndicator: 'no' }), false);
  assert.equal('typingIndicator' in normalizePluginConfig({}), false);
});

test('提醒开关与等待时间：收窄到 0–120 分钟，非数字丢掉交给默认', () => {
  assert.equal(normalizePluginConfig({ questionReminders: false }).questionReminders, false);
  // 写坏的开关按「关」处理：不因为配置错误静默恢复「微信可批授权」。
  assert.equal(normalizePluginConfig({ questionReminders: 'no' }).questionReminders, false);
  assert.equal(normalizePluginConfig({ questionReminders: null }).questionReminders, false);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: 5 }).questionDelayMinutes, 5);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: 0 }).questionDelayMinutes, 0);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: -3 }).questionDelayMinutes, 0);
  assert.equal(normalizePluginConfig({ questionDelayMinutes: 1e6 }).questionDelayMinutes, 120);
  assert.equal('questionDelayMinutes' in normalizePluginConfig({ questionDelayMinutes: '5' }), false);
});

test('面板改的提醒设置会落盘并在下次加载时读回', async () => {
  await withDir(async (dir) => {
    const store = new LocalConfigStore({ dir });
    await store.load();
    await store.save({ questionReminders: false, questionDelayMinutes: 12 });
    const reloaded = await new LocalConfigStore({ dir }).load();
    assert.equal(reloaded.questionReminders, false);
    assert.equal(reloaded.questionDelayMinutes, 12);
    // 只改开关时，等待时间要保留（先 load 再 save，与运行期一致）。
    const partial = new LocalConfigStore({ dir });
    await partial.load();
    await partial.save({ questionReminders: true });
    const again = await new LocalConfigStore({ dir }).load();
    assert.equal(again.questionReminders, true);
    assert.equal(again.questionDelayMinutes, 12);
  });
});

test('独立模式的模型：只认 provider 与 model 两个非空字符串，写坏就当没配', () => {
  const config = normalizePluginConfig({ directModel: { provider: 'deepseek-account', model: 'deepseek-chat' } });
  assert.deepEqual(config.directModel, { provider: 'deepseek-account', model: 'deepseek-chat' });
  assert.equal('directModel' in normalizePluginConfig({ directModel: { provider: 'a' } }), false);
  assert.equal('directModel' in normalizePluginConfig({ directModel: { provider: '', model: 'b' } }), false);
  assert.equal('directModel' in normalizePluginConfig({ directModel: 'a/b' }), false);
  assert.equal('directModel' in normalizePluginConfig({}), false);
});

test('面板选的模型落盘；清空后写 null，读回来不回落成 profile 配置', async () => {
  await withDir(async (dir) => {
    const store = new LocalConfigStore({ dir });
    await store.load();
    await store.save({ directModel: { provider: 'p', model: 'm' } });
    assert.deepEqual((await new LocalConfigStore({ dir }).load()).directModel, { provider: 'p', model: 'm' });

    const clearing = new LocalConfigStore({ dir });
    await clearing.load();
    await clearing.save({ directModel: null });
    const document = await new LocalConfigStore({ dir }).load();
    // 显式的 null 与「文件里没有这个字段」是两件事：前者表示主人清掉了配置。
    assert.equal(document.directModel, null);
    assert.equal(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).directModel, null);
  });
});
