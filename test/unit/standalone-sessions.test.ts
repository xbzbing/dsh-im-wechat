import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  SESSION_PAGE_SIZE,
  renderSessionList,
  renderTraceList,
  sessionIdMatches,
  shortSessionId,
  tableCell,
} from '../../src/host/standalone/command-text.ts';
import { SessionLister } from '../../src/host/standalone/session-list.ts';
import { MAX_LISTING, MAX_TRACES, StandaloneCommandStore } from '../../src/host/state/standalone-commands.ts';
import type { DirectController, HostSessionRow } from '../../src/host/direct.ts';

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-cmd-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lister(rows: HostSessionRow[] | null, exclude = ''): SessionLister {
  const controller = rows === null ? null : {
    list: async () => ({ items: rows }),
  } as unknown as DirectController;
  return new SessionLister({ controller: () => controller, exclude: () => exclude });
}

test('会话目录：标题取投影、工作区只留目录名、过滤子代理与空会话和当前会话', async () => {
  const catalog = await lister([
    {
      sessionId: 's-1',
      updatedAt: 10,
      running: true,
      cwd: '/Users/me/.dsh/dsh-im-wechat',
      projections: { values: { title: '微信 · o9cq' } },
    },
    { sessionId: 's-2', blank: true },
    { sessionId: 's-3', origin: 'subagent', projections: { values: { title: '子代理' } } },
    { sessionId: 's-4', parentSessionId: 's-1', projections: { values: { title: '子任务' } } },
    { sessionId: 's-5', projections: { values: { title: null } } },
    { sessionId: 's-6', projections: { values: { title: '当前' } } },
    { sessionId: '' },
  ], 's-6').list();
  assert.equal(catalog.available, true);
  assert.deepEqual(catalog.sessions.map((row) => row.sessionId), ['s-1', 's-5']);
  assert.equal(catalog.sessions[0]!.title, '微信 · o9cq');
  assert.equal(catalog.sessions[0]!.workspace, 'dsh-im-wechat');
  assert.equal(catalog.sessions[0]!.running, true);
  // 没有标题时留空串，由渲染层补「未命名会话」；不在数据层编一个假名字。
  assert.equal(catalog.sessions[1]!.title, '');
  assert.equal(catalog.sessions[1]!.updatedAt, 0);
});

test('会话目录：宿主没有 list 或读失败时给「不可用 + 原因」', async () => {
  const missing = await lister(null).list();
  assert.equal(missing.available, false);
  assert.match(missing.reason ?? '', /不提供会话列表/);

  const broken = new SessionLister({
    controller: () => ({ list: async () => { throw new Error('boom'); } } as unknown as DirectController),
    exclude: () => '',
  });
  const result = await broken.list();
  assert.equal(result.available, false);
  assert.match(result.reason ?? '', /读取会话列表失败：boom/);
});

test('会话表格：单元格转义竖线、压掉换行、长标题截断', () => {
  assert.equal(tableCell('a | b\nc'), 'a \\| b c');
  assert.equal(tableCell('x'.repeat(40), 10).length, 10);
  assert.match(tableCell('x'.repeat(40), 10), /…$/);
  const catalog = {
    rows: [{ sessionId: 'session-1234567890', title: '标题', updatedAt: 0, running: false, workspace: 'ws' }],
    page: 1,
    pages: 1,
    offset: 0,
    listed: 1,
    now: 0,
  };
  const markdown = renderSessionList(catalog);
  assert.match(markdown, /\| 1 \| 标题 \| 12345678 \| 空闲 \| 时间未知 \| ws \|/);
  assert.equal(SESSION_PAGE_SIZE, 10);
  assert.match(renderTraceList([{ sessionId: 'session-1', title: '', since: 0, until: 60_000 }], 0), /未命名会话/);
});

test('短 id：去掉 session- 前缀，表格里的写法能直接用来定位', () => {
  assert.equal(shortSessionId('session-0e2d5e91-2d20-44b4'), '0e2d5e91');
  assert.equal(shortSessionId('abc123'), 'abc123');
  assert.equal(sessionIdMatches('session-0e2d5e91-2d20', '0e2d5e91'), true);
  assert.equal(sessionIdMatches('session-0e2d5e91-2d20', 'session-0e2d'), true);
  assert.equal(sessionIdMatches('session-0e2d5e91-2d20', '0e2d5e92'), false);
  assert.equal(sessionIdMatches('session-0e2d5e91-2d20', ''), false);
});

test('命令状态：落盘后能读回快照与跟踪，坏条目丢掉而不整份作废', async (t) => {
  const dir = tempDir(t);
  const store = new StandaloneCommandStore({ dir });
  await store.hydrate();
  assert.deepEqual(store.listing(), []);
  assert.deepEqual(store.traces(), []);

  await store.setListing([{ sessionId: 's-1', title: '一' }]);
  await store.setTraces([{ sessionId: 's-1', title: '一', since: 1, until: 2 }]);
  await store.flush();

  const reloaded = new StandaloneCommandStore({ dir });
  await reloaded.hydrate();
  assert.deepEqual(reloaded.listing(), [{ sessionId: 's-1', title: '一' }]);
  assert.deepEqual(reloaded.traces(), [{ sessionId: 's-1', title: '一', since: 1, until: 2 }]);

  // 手工写坏一半：坏条目丢掉，其余照读。
  const file = reloaded.path();
  const current = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  current.listing = [{ sessionId: 's-2', title: '二' }, { sessionId: '' }, { sessionId: 's-2', title: '重复' }];
  current.traces = [{ sessionId: 's-1', since: 5, until: 3 }, { sessionId: 's-1', title: '坏', since: 1, until: 2 }];
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, `${JSON.stringify(current)}\n`);

  const repaired = new StandaloneCommandStore({ dir });
  await repaired.hydrate();
  assert.deepEqual(repaired.listing(), [{ sessionId: 's-2', title: '二' }]);
  assert.deepEqual(repaired.traces(), [{ sessionId: 's-1', title: '坏', since: 1, until: 2 }]);
});

test('命令状态：快照与跟踪都有硬上限', async (t) => {
  const dir = tempDir(t);
  const store = new StandaloneCommandStore({ dir });
  await store.hydrate();
  await store.setListing(Array.from({ length: MAX_LISTING + 5 }, (_, index) => ({ sessionId: `s-${index}`, title: '' })));
  await store.setTraces(Array.from({ length: MAX_TRACES + 5 }, (_, index) => ({
    sessionId: `s-${index}`,
    title: '',
    since: 1,
    until: 2,
  })));
  assert.equal(store.listing().length, MAX_LISTING);
  assert.equal(store.traces().length, MAX_TRACES);
});
