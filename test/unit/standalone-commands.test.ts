import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COMMAND_NAMES,
  StandaloneCommands,
  parseCommand,
} from '../../src/host/standalone/commands.ts';
import { HELP_TEXT } from '../../src/host/standalone/command-text.ts';
import type { SessionCatalog, SessionLister } from '../../src/host/standalone/session-list.ts';
import type { SessionWatcher } from '../../src/host/standalone/session-watch.ts';
import type { ListingEntry, TraceEntry } from '../../src/host/state/standalone-commands.ts';

const NOW = 1_700_000_000_000;

interface Harness {
  commands: StandaloneCommands;
  sent: string[];
  listing: ListingEntry[];
  delivered: { sessionId: string; content: readonly { type: string; text?: string }[] }[];
  watchCalls: unknown[][];
  catalog: SessionCatalog;
  resetCalls: number[];
  bound: boolean;
}

function harness(options: {
  catalog?: SessionCatalog;
  attachedImages?: boolean;
  queued?: boolean;
  deliverFails?: boolean;
} = {}): Harness {
  const sent: string[] = [];
  const listing: ListingEntry[] = [];
  const delivered: Harness['delivered'] = [];
  const watchCalls: unknown[][] = [];
  const resetCalls: number[] = [];
  const traces: TraceEntry[] = [];
  const state: Harness = {
    commands: null as unknown as StandaloneCommands,
    sent,
    listing,
    delivered,
    watchCalls,
    catalog: options.catalog ?? { sessions: [], available: true },
    resetCalls,
    bound: true,
  };
  const watcher = {
    list: () => traces,
    removeSend: (sessionId: string) => {
      watchCalls.push(['removeSend', sessionId]);
    },
    add: async (...args: unknown[]) => {
      watchCalls.push(['add', ...args]);
      return 'added';
    },
    remove: async (target: string) => {
      watchCalls.push(['remove', target]);
      return target === '' ? traces.splice(0) : [{ sessionId: target, title: '删掉的', since: NOW, until: NOW + 60_000 }];
    },
    trackSend: (...args: unknown[]) => {
      watchCalls.push(['trackSend', ...args]);
    },
  } as unknown as SessionWatcher;
  state.commands = new StandaloneCommands({
    lister: { list: async () => state.catalog } as unknown as SessionLister,
    watcher,
    store: {
      listing: () => listing,
      setListing: async (next) => {
        listing.splice(0, listing.length, ...next);
      },
    },
    reset: async () => {
      resetCalls.push(1);
      state.bound = false;
    },
    bound: () => state.bound,
    deliver: async (sessionId, content, onAdmitted) => {
      delivered.push({ sessionId, content: content as { type: string; text?: string }[] });
      onAdmitted({ queued: options.queued ?? false });
      if (options.deliverFails === true) throw new Error('宿主拒绝了这条消息');
    },
    send: async (text) => {
      sent.push(text);
      return true;
    },
    now: () => NOW,
  });
  return state;
}

const plain = { text: '', hasImages: false, images: [] as never[] };

test('命令解析：只认命令名后跟空白或结尾，参数原样留下', () => {
  assert.deepEqual(parseCommand('/help'), { name: 'help', rest: '' });
  assert.deepEqual(parseCommand('/sessions 2'), { name: 'sessions', rest: '2' });
  assert.deepEqual(parseCommand('/trace stop 1'), { name: 'trace', rest: 'stop 1' });
  assert.deepEqual(parseCommand('/SEND 1 你好'), { name: 'send', rest: '1 你好' });
  assert.equal(parseCommand('/new-thing'), null);
  assert.equal(parseCommand('/status'), null);
  assert.equal(parseCommand('帮我 /help'), null);
});

test('帮助里写的命令都被真正识别，命令名集合没有漏', () => {
  for (const name of COMMAND_NAMES) {
    assert.match(HELP_TEXT, new RegExp(`\`/${name}`), `帮助里缺少 /${name}`);
  }
  assert.deepEqual([...COMMAND_NAMES].sort(), ['help', 'list', 'new', 'reset', 'send', 'sessions', 'trace']);
});

test('/help 发一份命令说明', async () => {
  const h = harness();
  assert.equal(await h.commands.run({ ...plain, text: '/help' }), true);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0]!, /微信命令/);
  assert.match(h.sent[0]!, /\/sessions/);
});

test('/new 清掉绑定；没有会话时只说明下一条消息会新建', async () => {
  const h = harness();
  await h.commands.run({ ...plain, text: '/new' });
  assert.equal(h.resetCalls.length, 1);
  assert.match(h.sent[0]!, /已为你开启新会话/);

  h.bound = false;
  await h.commands.run({ ...plain, text: '/reset' });
  assert.equal(h.resetCalls.length, 2);
  assert.match(h.sent[1]!, /还没有会话/);
});

test('/sessions 建快照并分页；序号在重新列出之前不随实时列表变化', async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    sessionId: `session-${String(index + 1).padStart(3, '0')}`,
    title: `会话 ${index + 1}`,
    updatedAt: NOW - index * 60_000,
    running: index === 0,
    workspace: 'dsh-im-wechat',
  }));
  const h = harness({ catalog: { sessions, available: true } });
  await h.commands.run({ ...plain, text: '/sessions' });
  assert.equal(h.listing.length, 12);
  assert.match(h.sent[0]!, /共 12 个，第 1\/2 页/);
  assert.match(h.sent[0]!, /会话 1/);
  assert.doesNotMatch(h.sent[0]!, /会话 11/);

  // 实时列表换了顺序/内容：第 2 页仍按旧快照编号。
  h.catalog = { sessions: [...sessions].reverse(), available: true };
  await h.commands.run({ ...plain, text: '/sessions 2' });
  assert.match(h.sent[1]!, /第 2\/2 页/);
  assert.match(h.sent[1]!, /会话 11/);
  assert.doesNotMatch(h.sent[1]!, /会话 1 \|/);
});

test('/sessions 页码越界与列表不可用都说清楚', async () => {
  const h = harness({
    catalog: {
      sessions: [{ sessionId: 's-1', title: '一', updatedAt: NOW, running: false, workspace: '' }],
      available: true,
    },
  });
  await h.commands.run({ ...plain, text: '/sessions 3' });
  assert.match(h.sent[0]!, /只有 1 页/);

  h.catalog = { sessions: [], available: false, reason: '宿主不提供会话列表' };
  await h.commands.run({ ...plain, text: '/sessions' });
  assert.match(h.sent[1]!, /读取会话列表失败：宿主不提供会话列表/);
});

test('/sessions 没有可列出的会话时给一句话，不装作列过', async () => {
  const h = harness();
  await h.commands.run({ ...plain, text: '/list' });
  assert.deepEqual(h.sent, ['当前没有可用的会话。']);
  assert.equal(h.listing.length, 0);
});

test('/send 按序号找到会话、提交内容并开始等这一轮', async () => {
  const h = harness({
    catalog: {
      sessions: [{ sessionId: 'session-aaa', title: '目标会话', updatedAt: NOW, running: false, workspace: '' }],
      available: true,
    },
    queued: true,
  });
  // 先建立序号快照。
  await h.commands.run({ ...plain, text: '/sessions' });
  h.sent.length = 0;
  await h.commands.run({ ...plain, text: '/send 1 帮我看下这个' });
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0]!.sessionId, 'session-aaa');
  assert.deepEqual(h.delivered[0]!.content.map((part) => part.text), ['帮我看下这个']);
  assert.deepEqual(h.watchCalls[0], ['trackSend', 'session-aaa', '目标会话', '帮我看下这个', true]);
  assert.match(h.sent[0]!, /已交给会话「目标会话」/);
});

test('/send 支持会话 id 前缀，附图可以只发图', async () => {
  const h = harness({
    catalog: {
      sessions: [{ sessionId: 'session-bbb', title: '目标', updatedAt: NOW, running: false, workspace: '' }],
      available: true,
    },
  });
  await h.commands.run({
    text: '/send session-b 看这张',
    hasImages: true,
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
  });
  assert.equal(h.delivered[0]!.sessionId, 'session-bbb');
  assert.equal(h.delivered[0]!.content[0]!.type, 'text');
  assert.equal(h.delivered[0]!.content[1]!.type, 'image');
});

test('/send 缺内容、找不到会话、附图转发命令都拒绝且不提交', async () => {
  const h = harness({
    catalog: {
      sessions: [{ sessionId: 'session-aaa', title: '目标', updatedAt: NOW, running: false, workspace: '' }],
      available: true,
    },
  });
  await h.commands.run({ ...plain, text: '/send 1' });
  assert.match(h.sent[0]!, /用法/);

  await h.commands.run({ ...plain, text: '/send 9 你好' });
  assert.match(h.sent[1]!, /还没列过会话|不在你上次/);

  await h.commands.run({
    text: '/send session-aaa /help',
    hasImages: true,
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
  });
  assert.match(h.sent[2]!, /不能同时附图/);
  assert.equal(h.delivered.length, 0);
});

test('非 /send 命令带图：先说明图没有发出，命令照常执行', async () => {
  const h = harness();
  await h.commands.run({
    text: '/help',
    hasImages: true,
    images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }],
  });
  assert.match(h.sent[0]!, /\/help 命令不带图片/);
  assert.match(h.sent[1]!, /微信命令/);
});

test('/trace 开始跟踪、列表与停止都走同一个序号', async () => {
  const h = harness({
    catalog: {
      sessions: [
        { sessionId: 'session-aaa', title: 'A', updatedAt: NOW, running: false, workspace: '' },
        { sessionId: 'session-bbb', title: 'B', updatedAt: NOW, running: false, workspace: '' },
      ],
      available: true,
    },
  });
  await h.commands.run({ ...plain, text: '/sessions' });
  h.sent.length = 0;
  await h.commands.run({ ...plain, text: '/trace 1 20' });
  assert.deepEqual(h.watchCalls[0], ['add', 'session-aaa', 'A', 20]);
  assert.match(h.sent[0]!, /已开始跟踪「A」（20 分钟）/);

  await h.commands.run({ ...plain, text: '/trace stop 1' });
  // 序号按 /sessions 快照解释，不把 1 原样丢给跟踪列表。
  assert.deepEqual(h.watchCalls[1], ['remove', 'session-aaa']);
  assert.match(h.sent[1]!, /已停止跟踪/);

  await h.commands.run({ ...plain, text: '/trace 1 0' });
  assert.match(h.sent[2]!, /1 到 1440 之间/);
});

test('/trace 没有跟踪时的列表与未知命令', async () => {
  const h = harness();
  await h.commands.run({ ...plain, text: '/trace' });
  assert.match(h.sent[0]!, /当前没有跟踪的会话/);
  assert.equal(await h.commands.run({ ...plain, text: '/stop' }), false);
});

test('/send 提交失败：说清原因并撤销观察，不留下等不到的条目', async () => {
  const h = harness({
    catalog: {
      sessions: [{ sessionId: 'session-aaa', title: '目标', updatedAt: NOW, running: false, workspace: '' }],
      available: true,
    },
    deliverFails: true,
  });
  await h.commands.run({ ...plain, text: '/sessions' });
  h.sent.length = 0;
  await h.commands.run({ ...plain, text: '/send 1 你好' });
  assert.match(h.sent[0]!, /没能把消息交给会话：宿主拒绝了这条消息/);
  assert.deepEqual(h.watchCalls.at(-1), ['removeSend', 'session-aaa']);
});

test('/sessions 超过快照上限时只列能存下的部分，并说明其余去哪看', async () => {
  const sessions = Array.from({ length: 150 }, (_, index) => ({
    sessionId: `session-${String(index + 1).padStart(4, '0')}`,
    title: `会话 ${index + 1}`,
    updatedAt: NOW - index * 1000,
    running: false,
    workspace: '',
  }));
  const h = harness({ catalog: { sessions, available: true } });
  await h.commands.run({ ...plain, text: '/sessions' });
  assert.equal(h.listing.length, 100);
  assert.match(h.sent[0]!, /共 100 个，第 1\/10 页/);
  assert.match(h.sent[0]!, /只列出最近 100 个/);
});
