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
