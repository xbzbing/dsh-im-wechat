import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { apply, inject, name } from '../../index.ts';
import type { PanelRoute, PluginContext } from '../../src/host/host-context.ts';

test('插件名与 cordis.patch.yml 的 id 一致', () => {
  assert.equal(name, 'dsh-im-wechat');
});

test('顶层没有硬依赖：核心与面板服务都按需接入', () => {
  assert.deepEqual(inject, []);
});

test('apply 返回 void —— 返回值会被 Cordis 当成 effect，返回对象会让插件 failed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-entry-'));
  try {
    const result = await apply({}, { dataDir: dir });
    assert.equal(result, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('装配时挂上面板 RPC 路由', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-entry-'));
  const routes: PanelRoute[] = [];
  const cleanups: (() => void)[] = [];
  const ctx: PluginContext = {
    effect: (execute: () => unknown) => {
      const dispose = execute();
      if (typeof dispose === 'function') cleanups.push(dispose as () => void);
      return undefined;
    },
    connection: {
      fetch: {
        register: (route: PanelRoute) => {
          routes.push(route);
          return () => undefined;
        },
      },
    },
  };
  try {
    await apply(ctx, { dataDir: dir });
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, '/api/dsh-im-wechat');
    assert.deepEqual(routes[0].methods, ['POST']);
    for (const cleanup of cleanups) cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺 connection 服务时只记一条告警，不抛', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-entry-'));
  const warnings: unknown[] = [];
  try {
    await apply({ logger: { warn: (...args: unknown[]) => warnings.push(args) } }, { dataDir: dir });
    assert.equal(warnings.length > 0, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
