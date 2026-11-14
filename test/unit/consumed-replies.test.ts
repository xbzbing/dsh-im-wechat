import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ConsumedReplies, consumedRepliesPath } from '../../src/host/state/consumed-replies.ts';
import { ReminderCenter } from '../../src/host/reminder-center.ts';

async function withDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-consumed-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('记住的回复身份会落盘，重启后仍然认得', async () => {
  await withDir(async (dir) => {
    const first = new ConsumedReplies({ dir, now: () => 1_000 });
    await first.load();
    assert.equal(first.has('weixin:v1:a:mid:1'), false);
    await first.remember('weixin:v1:a:mid:1');

    const second = new ConsumedReplies({ dir, now: () => 2_000 });
    await second.load();
    assert.equal(second.has('weixin:v1:a:mid:1'), true);
    // 文件是合法 JSON 且不含正文，只有身份与时间。
    const text = await readFile(consumedRepliesPath(dir), 'utf8');
    assert.deepEqual(JSON.parse(text), [{ id: 'weixin:v1:a:mid:1', at: 1_000 }]);
  });
});

test('超过容量淘汰最旧的；空身份不记', async () => {
  await withDir(async (dir) => {
    const store = new ConsumedReplies({ dir, capacity: 2 });
    await store.remember('a');
    await store.remember('b');
    await store.remember('c');
    assert.equal(store.has('a'), false);
    assert.equal(store.has('b'), true);
    assert.equal(store.has('c'), true);
    await store.remember(null);
    await store.remember('');
    assert.equal(store.has(null), false);
  });
});

test('状态文件坏掉时按空处理，不让插件起不来', async () => {
  await withDir(async (dir) => {
    await writeFile(consumedRepliesPath(dir), '{not json');
    const store = new ConsumedReplies({ dir });
    await store.load();
    assert.equal(store.has('a'), false);
  });
});

test('同一条重投的「批准」在重启后不会再批一次新授权', async () => {
  await withDir(async (dir) => {
    const sent: string[] = [];
    const identity = 'weixin:v1:a:mid:42';
    // 每次给一份新的请求对象：broker 会原地替换 `signal`，复用会把上一次的取消带过来。
    const approval = () => ({ toolName: 'bash', agent: { id: 'root-1', session: { header: {} } } });

    const before = new ConsumedReplies({ dir });
    await before.load();
    const center = new ReminderCenter({
      send: async (text) => {
        sent.push(text);
        return true;
      },
      recipient: () => 'owner-1',
      isRoot: () => true,
      canApprove: () => true,
      isActive: () => true,
      consumed: before,
      now: () => 1_000,
      delayMinutes: 0,
    });
    const first = center.handleApproval(approval(), () => new Promise(() => {}), true);
    for (let i = 0; i < 40 && center.status().pendingApprovals === 0; i += 1) await new Promise((r) => setImmediate(r));
    assert.equal(center.reply('批准', identity), true);
    assert.equal(await first, 'allowed-once');
    await before.remember(identity);

    // 重启：新的运行期读回同一个状态目录，又有一个待授权。
    const after = new ConsumedReplies({ dir });
    await after.load();
    const restarted = new ReminderCenter({
      send: async (text) => {
        sent.push(text);
        return true;
      },
      recipient: () => 'owner-1',
      isRoot: () => true,
      canApprove: () => true,
      isActive: () => true,
      consumed: after,
      now: () => 2_000,
      delayMinutes: 0,
    });
    restarted.handleApproval(approval(), () => new Promise(() => {}), true);
    for (let i = 0; i < 40 && restarted.status().pendingApprovals === 0; i += 1) await new Promise((r) => setImmediate(r));

    assert.equal(restarted.reply('批准', identity), false);
    assert.equal(restarted.status().pendingApprovals, 1);
    restarted.cancelAll('测试结束');
  });
});
