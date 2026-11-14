import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ModelCatalogView } from '../../src/shared/models.ts';
import {
  catalogModels,
  catalogProviders,
  effortForModel,
  effortOptions,
  modelForProvider,
  modelOptions,
  modelRowId,
  modelSaveable,
  modelSelectionOf,
  providerOptions,
} from '../../src/client/model-route.ts';

const MODEL_CATALOG: ModelCatalogView = {
  available: true,
  default: { provider: 'deepseek-account', model: 'deepseek-chat' },
  items: [
    {
      provider: 'deepseek-account',
      model: 'deepseek-chat',
      label: 'DeepSeek Chat',
      providerName: 'DeepSeek 账号',
      efforts: [],
    },
    {
      provider: 'deepseek-account',
      model: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner',
      providerName: 'DeepSeek 账号',
      efforts: [{ id: 'low', label: '低' }, { id: 'high', label: '高' }],
      defaultEffort: 'low',
    },
    {
      provider: 'openrouter',
      model: 'x/y',
      label: 'X Y',
      providerName: 'OpenRouter',
      efforts: [{ id: 'medium', label: '中' }],
    },
  ],
  unavailableProviders: [],
};

const MODEL_LABELS = {
  followDefault: '跟随 DSH 默认',
  placeholder: '选择模型',
  default: '模型默认',
  missing: '已下架',
  unverified: '未校验',
};

test('模型三级：provider 下拉按目录顺序列出，第一项跟随 DSH 默认', () => {
  assert.deepEqual(providerOptions(MODEL_CATALOG, '', MODEL_LABELS), [
    { value: '', label: '跟随 DSH 默认', hint: 'deepseek-account/deepseek-chat' },
    { value: 'deepseek-account', label: 'DeepSeek 账号' },
    { value: 'openrouter', label: 'OpenRouter' },
  ]);
  assert.deepEqual(
    providerOptions(MODEL_CATALOG, 'openrouter', MODEL_LABELS).find((option) => option.value === 'openrouter'),
    { value: 'openrouter', label: 'OpenRouter' },
  );
});

test('模型三级：跟随默认的说明带出默认模型的推理等级名', () => {
  const withEffort = {
    ...MODEL_CATALOG,
    default: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
  };
  assert.equal(providerOptions(withEffort, '', MODEL_LABELS)[0]?.hint, 'deepseek-account/deepseek-reasoner · 高');
  // 默认模型不在目录里时退回强度 id，不猜。
  const unknown = { ...MODEL_CATALOG, default: { provider: 'gone', model: 'm', reasoningEffort: 'ultra' } };
  assert.equal(providerOptions(unknown, '', MODEL_LABELS)[0]?.hint, 'gone/m · ultra');
});

test('模型三级：别的 provider 读失败时，这一家的下架仍标已下架', () => {
  const gone = modelRowId('deepseek-account', 'gone');
  const otherFailed = { ...MODEL_CATALOG, unavailableProviders: ['other'] };
  assert.equal(modelOptions(otherFailed, 'deepseek-account', gone, MODEL_LABELS).at(-1)?.hint, '已下架');
  assert.equal(
    effortOptions(otherFailed, 'deepseek-account', 'deepseek-reasoner', 'ultra', MODEL_LABELS).at(-1)?.hint,
    '已下架',
  );
  // 只有这一家自己读失败，才轮到「未校验」。
  const ownFailed = { ...MODEL_CATALOG, unavailableProviders: ['deepseek-account'] };
  assert.equal(modelOptions(ownFailed, 'deepseek-account', gone, MODEL_LABELS).at(-1)?.hint, '未校验');
  assert.equal(
    effortOptions(ownFailed, 'deepseek-account', 'deepseek-reasoner', 'ultra', MODEL_LABELS).at(-1)?.hint,
    '未校验',
  );
});

test('模型三级：provider 不在目录里时补一行原文，按目录是否读全标已下架/未校验', () => {
  assert.deepEqual(providerOptions(null, 'gone', MODEL_LABELS).at(-1), {
    value: 'gone',
    label: 'gone',
    hint: '未校验',
  });
  assert.deepEqual(providerOptions(MODEL_CATALOG, 'gone', MODEL_LABELS).at(-1), {
    value: 'gone',
    label: 'gone',
    hint: '已下架',
  });
  const partial = { ...MODEL_CATALOG, unavailableProviders: ['gone'] };
  assert.deepEqual(providerOptions(partial, 'gone', MODEL_LABELS).at(-1)?.hint, '未校验');
});

test('模型三级：模型下拉只列当前 provider 的模型，行键里带 / 也能回查', () => {
  assert.deepEqual(modelOptions(MODEL_CATALOG, 'deepseek-account', '', MODEL_LABELS), [
    { value: '', label: '选择模型' },
    { value: modelRowId('deepseek-account', 'deepseek-chat'), label: 'DeepSeek Chat', hint: 'deepseek-chat' },
    { value: modelRowId('deepseek-account', 'deepseek-reasoner'), label: 'DeepSeek Reasoner', hint: 'deepseek-reasoner' },
  ]);
  // provider 换了就只看到它自己的模型。
  assert.deepEqual(modelOptions(MODEL_CATALOG, 'openrouter', '', MODEL_LABELS), [
    { value: '', label: '选择模型' },
    { value: modelRowId('openrouter', 'x/y'), label: 'X Y', hint: 'x/y' },
  ]);
  // provider 还没选时没有候选。
  assert.deepEqual(modelOptions(MODEL_CATALOG, '', '', MODEL_LABELS), [{ value: '', label: '选择模型' }]);
});

test('模型三级：已保存的模型不在目录里时补一行，不静默清成跟随默认', () => {
  const gone = modelRowId('gone', 'model');
  assert.deepEqual(modelOptions(null, 'gone', gone, MODEL_LABELS).at(-1), {
    value: gone,
    label: 'model',
    hint: '未校验',
  });
  assert.deepEqual(modelOptions(MODEL_CATALOG, 'gone', gone, MODEL_LABELS).at(-1), {
    value: gone,
    label: 'model',
    hint: '已下架',
  });
});

test('模型三级：推理等级下拉带默认档位说明，没有档位的模型只剩「模型默认」', () => {
  assert.deepEqual(effortOptions(MODEL_CATALOG, 'deepseek-account', 'deepseek-reasoner', '', MODEL_LABELS), [
    { value: '', label: '模型默认', hint: '低' },
    { value: 'low', label: '低' },
    { value: 'high', label: '高' },
  ]);
  assert.deepEqual(effortOptions(MODEL_CATALOG, 'deepseek-account', 'deepseek-chat', '', MODEL_LABELS), [
    { value: '', label: '模型默认' },
  ]);
  // 模型还没选时同样只有「模型默认」，第三级会被界面禁用。
  assert.deepEqual(effortOptions(MODEL_CATALOG, '', '', '', MODEL_LABELS), [{ value: '', label: '模型默认' }]);
});

test('模型三级：旧推理等级不在档位里时补一行，仍能清回模型默认', () => {
  const stale = effortOptions(MODEL_CATALOG, 'deepseek-account', 'deepseek-reasoner', 'ultra', MODEL_LABELS);
  assert.deepEqual(stale.at(-1), { value: 'ultra', label: 'ultra', hint: '已下架' });
  assert.equal(stale[0]?.value, '');
  const partial = { ...MODEL_CATALOG, unavailableProviders: ['deepseek-account'] };
  assert.deepEqual(
    effortOptions(partial, 'deepseek-account', 'deepseek-reasoner', 'ultra', MODEL_LABELS).at(-1)?.hint,
    '未校验',
  );
});

test('模型三级：换 provider 保留同名模型，换模型丢掉新模型不支持的推理等级', () => {
  assert.equal(modelForProvider(MODEL_CATALOG, 'openrouter', 'x/y'), 'x/y');
  assert.equal(modelForProvider(MODEL_CATALOG, 'openrouter', 'deepseek-chat'), '');
  assert.equal(modelForProvider(MODEL_CATALOG, '', 'x/y'), '');
  assert.equal(effortForModel(MODEL_CATALOG, 'deepseek-account', 'deepseek-reasoner', 'high'), 'high');
  assert.equal(effortForModel(MODEL_CATALOG, 'deepseek-account', 'deepseek-chat', 'high'), '');
  assert.equal(effortForModel(MODEL_CATALOG, 'deepseek-account', 'deepseek-reasoner', 'ultra'), '');
  assert.equal(effortForModel(MODEL_CATALOG, 'deepseek-account', '', 'high'), '');
});

test('模型三级：跟随默认能保存，选了 provider 但没选模型不能保存', () => {
  assert.equal(modelSaveable('', ''), true);
  assert.equal(modelSaveable('p', 'm'), true);
  assert.equal(modelSaveable('p', ''), false);
});

test('模型三级：草稿换算成保存值，缺 provider 或 model 就是跟随默认', () => {
  assert.deepEqual(modelSelectionOf('p', 'm', ''), { provider: 'p', model: 'm' });
  assert.deepEqual(modelSelectionOf('p', 'm', 'high'), { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.equal(modelSelectionOf('', 'm', 'high'), null);
  assert.equal(modelSelectionOf('p', '', 'high'), null);
  assert.equal(modelSelectionOf('', '', ''), null);
});

test('模型下拉：形状不对的行丢掉，重复行只留一条', () => {
  // 宿主返回的是外部输入：面板仍按字段类型逐行筛，脏行不该变成一行乱码。
  const options = modelOptions({
    available: true,
    default: null,
    unavailableProviders: [],
    items: [
      { provider: 'p', model: 'm', label: 'M', providerName: 'P', efforts: [] },
      { provider: 'p', model: 'm', label: '重复', providerName: 'P', efforts: [] },
      { provider: 'p' },
      { model: 'm2' },
      null,
    ],
  } as unknown as ModelCatalogView, 'p', '', MODEL_LABELS);
  assert.deepEqual(options, [
    { value: '', label: '选择模型' },
    { value: modelRowId('p', 'm'), label: 'M', hint: 'm' },
  ]);
});

test('模型三级：目录里 provider 与模型都去重，推理等级脏行丢掉', () => {
  const catalog = {
    available: true,
    default: null,
    unavailableProviders: [],
    items: [
      { provider: 'p', model: 'm', label: 'M', providerName: 'P', efforts: [{ id: 'high', label: '高' }, { id: 'high', label: '重复' }, null] },
      { provider: 'p', model: 'm2', label: 'M2', providerName: 'P', efforts: [] },
    ],
  } as unknown as ModelCatalogView;
  assert.deepEqual(catalogProviders(catalog), [{ id: 'p', name: 'P' }]);
  assert.deepEqual(catalogModels(catalog, 'p').map((item) => item.model), ['m', 'm2']);
  assert.deepEqual(effortOptions(catalog, 'p', 'm', '', MODEL_LABELS), [
    { value: '', label: '模型默认' },
    { value: 'high', label: '高' },
  ]);
});
