import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { DirectController } from '../../src/host/direct.ts';
import { DirectBindingStore } from '../../src/host/state/direct-binding.ts';
import { DirectStack } from '../../src/host/standalone/stack.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-stack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stack(dir: string, options: { list?: DirectController['list']; send?: (text: string) => Promise<boolean> } = {}) {
  const controller = {
    async create() {
      return { sessionId: 's-new' };
    },
    async prompt() {
      return { accepted: true };
    },
    ...(options.list === undefined ? {} : { list: options.list }),
  } as unknown as DirectController;
  return new DirectStack({
    dir,
    controller: () => controller,
    agents: () => null,
    send: options.send ?? (async () => true),
    isOwner: () => true,
    ownerLabel: () => 'abc123',
    defaultWorkspaceId: () => '',
    model: null,
    workspaceId: '',
    busyMode: 'queue',
    now: () => 1_700_000_000_000,
  });
}

test('独立模式装配：启动时给旧绑定补上会话标题', async (t) => {
  const dir = tempDir(t);
  // 旧版本落盘的 direct.json 只有 sessionId/workspaceId。
  const store = new DirectBindingStore({ dir });
  await store.hydrate();
  await store.set('session-0e2d5e91', '');

  const built = stack(dir, {
    list: async () => ({
      items: [{
        sessionId: 'session-0e2d5e91',
        projections: { values: { title: '微信 · o9cq…@im.wechat' } },
      }],
    }),
  });
  await built.hydrate();
  const status = built.status();
  assert.equal(status.bound, true);
  assert.equal(status.sessionId, 'session-0e2d5e91');
  assert.equal(status.sessionTitle, '微信 · o9cq…@im.wechat');
});

test('独立模式装配：读不到列表时保留绑定，不把标题写成空', async (t) => {
  const dir = tempDir(t);
  const store = new DirectBindingStore({ dir });
  await store.hydrate();
  await store.set('session-old', '', '微信 · 旧标题');

  const built = stack(dir, {
    list: async () => {
      throw new Error('boom');
    },
  });
  await built.hydrate();
  assert.equal(built.status().sessionTitle, '微信 · 旧标题');
});

test('独立模式装配：命令经同一层分发，未知命令不消费', async (t) => {
  const dir = tempDir(t);
  const sent: string[] = [];
  const built = stack(dir, {
    send: async (text) => {
      sent.push(text);
      return true;
    },
  });
  await built.hydrate();
  assert.equal(await built.runCommand({ text: '普通消息', hasImages: false, images: [] }), false);
  assert.equal(await built.runCommand({ text: '/help', hasImages: false, images: [] }), true);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /微信命令/);
});
