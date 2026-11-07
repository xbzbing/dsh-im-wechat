import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, inject, name } from '../../index.ts';

test('插件名与 cordis.patch.yml 的 id 一致', () => {
  assert.equal(name, 'dsh-im-wechat');
});

test('顶层没有硬依赖：核心与面板服务都按需接入', () => {
  assert.deepEqual(inject, []);
});

test('没有登录态时装配成功并停在未登录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-entry-'));
  try {
    const applied = await apply({}, { dataDir: dir });
    const status = applied.runtime.status();
    assert.equal(status.loggedIn, false);
    assert.equal(status.login.phase, 'idle');
    assert.equal(status.health.code, 'auth-expired');
    await applied.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺 connection 服务时只记一条告警，不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-entry-'));
  const warnings: unknown[] = [];
  try {
    const applied = await apply({ logger: { warn: (...args: unknown[]) => warnings.push(args) } }, { dataDir: dir });
    await applied.stop();
    assert.equal(warnings.length > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
