import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DirectModelChoice,
  applySessionModel,
  parseModelCatalog,
  normalizeModelRef,
  readModelCatalog,
  sameModelRef,
} from '../../src/host/direct-model.ts';

test('独立模式的模型：只认 provider 与 model 两个非空字符串', () => {
  assert.deepEqual(
    normalizeModelRef({ provider: 'deepseek-account', model: 'deepseek-chat' }),
    { provider: 'deepseek-account', model: 'deepseek-chat' },
  );
  // 前后空白去掉；两边都空就没有配置，跟随 DSH 默认。
  assert.deepEqual(normalizeModelRef({ provider: ' a ', model: ' b ' }), { provider: 'a', model: 'b' });
  assert.equal(normalizeModelRef({ provider: 'a' }), undefined);
  assert.equal(normalizeModelRef({ model: 'b' }), undefined);
  assert.equal(normalizeModelRef({ provider: 'a', model: '  ' }), undefined);
  assert.equal(normalizeModelRef({ provider: 1, model: 'b' }), undefined);
  assert.equal(normalizeModelRef({ provider: 'a', model: null }), undefined);
  assert.equal(normalizeModelRef('a/b'), undefined);
  assert.equal(normalizeModelRef(undefined), undefined);
  // 超长的部分是外部输入给的，超出边界就当没配，不写进配置文件。
  assert.equal(normalizeModelRef({ provider: 'p'.repeat(201), model: 'm' }), undefined);
  assert.equal(normalizeModelRef({ provider: 'p', model: 'm'.repeat(201) }), undefined);
  assert.deepEqual(normalizeModelRef({ provider: 'p'.repeat(200), model: 'm'.repeat(200) }), {
    provider: 'p'.repeat(200),
    model: 'm'.repeat(200),
  });
  // 只取这两个字段：将来的 reasoningEffort 之类不会被悄悄带进配置。
  assert.deepEqual(normalizeModelRef({ provider: 'p', model: 'm', reasoningEffort: 'high' }), { provider: 'p', model: 'm' });
});

test('独立模式的模型：比较只看 provider 与 model', () => {
  assert.equal(sameModelRef({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), true);
  assert.equal(sameModelRef({ provider: 'p', model: 'm' }, { provider: 'p', model: 'n' }), false);
  assert.equal(sameModelRef({ provider: 'p', model: 'm' }, null), false);
  assert.equal(sameModelRef(null, null), false);
});

test('模型目录：provider 分组拍平成下拉行，保留宿主的默认模型', () => {
  const view = parseModelCatalog({
    default: { provider: 'deepseek-account', model: 'deepseek-chat' },
    routableProviders: ['deepseek-account', 'openrouter'],
    groups: [
      {
        id: 'deepseek-account',
        name: 'DeepSeek 账号',
        models: [
          { id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ],
      },
      { id: 'openrouter', name: 'OpenRouter', models: [{ id: 'x/y', name: 'X Y' }] },
    ],
    failures: [{ id: 'broken', name: 'Broken', message: 'no key' }],
  });
  assert.equal(view.available, true);
  assert.deepEqual(view.default, { provider: 'deepseek-account', model: 'deepseek-chat' });
  // provider 读失败只标成「目录不完整」，不是「模型已下架」。
  assert.deepEqual(view.unavailableProviders, ['broken']);
  assert.deepEqual(view.items, [
    { provider: 'deepseek-account', model: 'deepseek-chat', label: 'DeepSeek Chat', providerName: 'DeepSeek 账号' },
    { provider: 'deepseek-account', model: 'deepseek-reasoner', label: 'DeepSeek Reasoner', providerName: 'DeepSeek 账号' },
    { provider: 'openrouter', model: 'x/y', label: 'X Y', providerName: 'OpenRouter' },
  ]);
});

test('模型目录：形状不对的行丢掉，缺名字时退回 id，重复行只留一条', () => {
  const view = parseModelCatalog({
    groups: [
      { id: 'p1', models: [{ id: 'm1' }, { id: 'm1', name: '重复' }, { name: '没有 id' }, null] },
      { models: [{ id: 'm2' }] },
      { id: 'p2', models: [] },
      null,
    ],
  });
  assert.deepEqual(view.items, [{ provider: 'p1', model: 'm1', label: 'm1', providerName: 'p1' }]);
  assert.equal(view.default, null);
  assert.deepEqual(view.unavailableProviders, []);
});

test('模型目录：不是对象、没有分组都算空目录，不是不可用', () => {
  const empty = { available: true, default: null, items: [], unavailableProviders: [] };
  assert.deepEqual(parseModelCatalog(null), empty);
  assert.deepEqual(parseModelCatalog({ groups: 'nope' }), empty);
});

test('模型目录：宿主的默认模型形状不对就当没有默认', () => {
  assert.equal(parseModelCatalog({ groups: [], default: { provider: 'p' } }).default, null);
});

test('模型目录：没有会话服务时不可用并给出原因，不当成空目录', async () => {
  const view = await readModelCatalog(null);
  assert.equal(view.available, false);
  assert.match(view.reason ?? '', /模型目录/);
  assert.deepEqual(view.items, []);
  assert.deepEqual(view.unavailableProviders, []);
  assert.equal((await readModelCatalog({})).available, false);
});

test('模型目录：读失败不抛，标成不可用并带上原因', async () => {
  const view = await readModelCatalog({
    async modelCatalog() {
      throw new Error('provider offline');
    },
  });
  assert.equal(view.available, false);
  assert.match(view.reason ?? '', /provider offline/);
});

test('模型目录：读成功就按目录拍平', async () => {
  const view = await readModelCatalog({
    async modelCatalog() {
      return { groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }] };
    },
  });
  assert.equal(view.available, true);
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0]?.model, 'm');
});

interface FakeAgent {
  selected: { provider: string; model: string }[];
  model: { select(selection: { provider: string; model: string }): void };
}

function fakeLookup(agent: FakeAgent | undefined, options: { throws?: boolean } = {}) {
  return {
    get(sessionId: string) {
      if (options.throws === true) throw new Error('service gone');
      return sessionId === 'sess-1' ? agent : undefined;
    },
  };
}

function fakeAgent(options: { throws?: boolean } = {}): FakeAgent {
  const selected: { provider: string; model: string }[] = [];
  return {
    selected,
    model: {
      select(selection) {
        if (options.throws === true) throw new Error('session closed');
        selected.push(selection);
      },
    },
  };
}

interface LoggedAgent {
  sessionId: string;
  selected: { provider: string }[];
}

function loggedLookup(events: string[], agent: LoggedAgent | undefined) {
  return {
    get(sessionId: string) {
      return sessionId === agent?.sessionId
        ? {
          model: {
            select(selection: { provider: string; model: string }) {
              events.push(`select:${sessionId}`);
              agent.selected.push(selection);
            },
          },
        }
        : undefined;
    },
  };
}

function choice(options: {
  initial: { provider: string; model: string } | null;
  agents: { get?(sessionId: string): any } | null;
  bound?: string;
}): DirectModelChoice {
  return new DirectModelChoice({
    initial: options.initial,
    agents: () => options.agents,
    boundSession: () => options.bound,
    catalog: () => null,
  });
}

test('钉模型：同一个会话同一个值只钉一次，换值或换会话再钉', () => {
  const events: string[] = [];
  const agent = { sessionId: 's-1', selected: [] as { provider: string }[] };
  const model = choice({ initial: { provider: 'p', model: 'm' }, agents: loggedLookup(events, agent), bound: 's-1' });

  assert.equal(model.applyToSession('s-1'), true);
  assert.equal(model.applyToSession('s-1'), true);
  assert.deepEqual(events, ['select:s-1']);

  // 换值：需要重新钉（面板刚改过）。
  model.use({ provider: 'p2', model: 'm2' });
  assert.equal(model.applyToSession('s-1'), true);
  assert.deepEqual(events, ['select:s-1', 'select:s-1']);

  // 换会话（重置绑定后新建）：也要钉。
  assert.equal(model.applyToSession('s-2'), false);
  assert.deepEqual(events, ['select:s-1', 'select:s-1']);
});

test('钉模型：会话还没起时不记「已钉」，下一次提交会再试一次', () => {
  const events: string[] = [];
  let lookup: { get?(sessionId: string): any } | null = null;
  const model = new DirectModelChoice({
    initial: { provider: 'p', model: 'm' },
    agents: () => lookup,
    boundSession: () => 's-1',
    catalog: () => null,
  });
  // 宿主还没 resume：钉不上，也不能记成成功，否则下次提交就永远不再试。
  assert.equal(model.applyToSession('s-1'), false);
  model.applyToBoundSession();
  assert.deepEqual(events, []);

  // 宿主 resume 之后，同一个实例的下一条消息补上。
  lookup = loggedLookup(events, { sessionId: 's-1', selected: [] });
  assert.equal(model.applyToSession('s-1'), true);
  assert.deepEqual(events, ['select:s-1']);
});

test('钉模型：清空后不再钉，也不影响已有记录', () => {
  const events: string[] = [];
  const agent = { sessionId: 's-1', selected: [] as { provider: string }[] };
  const model = choice({ initial: { provider: 'p', model: 'm' }, agents: loggedLookup(events, agent), bound: 's-1' });
  assert.equal(model.applyToSession('s-1'), true);
  model.use(null);
  assert.equal(model.applyToSession('s-1'), false);
  model.applyToBoundSession();
  assert.deepEqual(events, ['select:s-1']);
  assert.equal(model.snapshot(), null);
});

test('钉模型：活着的 Agent 上追加一条会话自己的选择', () => {
  const agent = fakeAgent();
  assert.equal(applySessionModel(fakeLookup(agent), 'sess-1', { provider: 'p', model: 'm' }), true);
  assert.deepEqual(agent.selected, [{ provider: 'p', model: 'm' }]);
});

test('钉模型：没配、会话取不到、Agent 没有模型入口时什么都不做', () => {
  const agent = fakeAgent();
  assert.equal(applySessionModel(fakeLookup(agent), 'sess-1', null), false);
  assert.equal(applySessionModel(fakeLookup(agent), 'sess-2', { provider: 'p', model: 'm' }), false);
  assert.equal(applySessionModel(null, 'sess-1', { provider: 'p', model: 'm' }), false);
  assert.equal(applySessionModel({}, 'sess-1', { provider: 'p', model: 'm' }), false);
  assert.equal(applySessionModel(fakeLookup({ selected: [], model: {} as never }), 'sess-1', { provider: 'p', model: 'm' }), false);
  assert.deepEqual(agent.selected, []);
});

test('钉模型：服务抛错不冒出来，交给调用方记日志', () => {
  assert.equal(applySessionModel(fakeLookup(fakeAgent(), { throws: true }), 'sess-1', { provider: 'p', model: 'm' }), false);
  assert.equal(applySessionModel(fakeLookup(fakeAgent({ throws: true })), 'sess-1', { provider: 'p', model: 'm' }), false);
});
