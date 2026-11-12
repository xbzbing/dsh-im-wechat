import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InboundPipeline } from '../../src/host/inbound-pipeline.ts';
import type { InboundPipelineDeps } from '../../src/host/inbound-pipeline.ts';
import type { SubmitResult } from '../../src/host/direct.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import type { WeixinBridge } from '../../src/host/superagent/bridge.ts';
import { CDN, imageFetch, imageMessage, imageOnlyMessage } from './helpers/inbound-fixtures.ts';

interface Submitted {
  sender: string;
  content: readonly PromptPart[];
}

/** 只为 `route` 用的最小依赖：轮询侧的状态用空壳占位，本组测试不碰。 */
function harness(options: {
  fetch?: typeof globalThis.fetch;
  isOwner?: (sender: string) => boolean;
  ownFeatures?: boolean | (() => boolean);
  superagent?: boolean;
  replyQuestion?: (text: string) => boolean;
  directAvailable?: boolean;
  submitResult?: SubmitResult;
} = {}) {
  const submitted: Submitted[] = [];
  const typing: string[] = [];
  const typingStopped: string[] = [];
  const pipeline = new InboundPipeline({
    enabled: () => true,
    stopped: () => false,
    connection: () => null,
    cursor: {} as InboundPipelineDeps['cursor'],
    contextTokens: {} as InboundPipelineDeps['contextTokens'],
    guard: {} as InboundPipelineDeps['guard'],
    logger: {},
    now: () => 1_760_000_000_000,
    fetch: options.fetch,
    cdnBaseUrl: CDN,
    bridge: () => ({ account: 'bot' }) as unknown as WeixinBridge,
    binder: () => null,
    ownFeaturesActive: () => (typeof options.ownFeatures === 'function' ? options.ownFeatures() : options.ownFeatures ?? true),
    isOwner: options.isOwner ?? ((sender: string) => sender === 'owner-1'),
    replyQuestion: options.replyQuestion ?? (() => false),
    superagentEnabled: () => options.superagent ?? false,
    directAvailable: () => options.directAvailable ?? true,
    typingStart: (sender) => typing.push(sender),
    typingStop: (sender) => typingStopped.push(sender),
    submitDirect: async (sender, content) => {
      submitted.push({ sender, content });
      return options.submitResult ?? 'queued';
    },
    setHealth: () => {},
    noteError: () => {},
  });
  return { pipeline, submitted, typing, typingStopped };
}

const signal = new AbortController().signal;

test('独立模式：主人只发图片时下载成附件交给会话', async () => {
  const built = imageOnlyMessage();
  const fetch = imageFetch([built.payload]);
  const { pipeline, submitted, typing, typingStopped } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.sender, 'owner-1');
  const content = submitted[0]?.content ?? [];
  assert.equal(content.length, 1, '只有图片时不替主人补文字，提示由提交层加');
  assert.equal(content[0]?.type, 'image');
  assert.equal(content[0]?.type === 'image' ? content[0].mediaType : '', 'image/png');
  assert.equal(content[0]?.type === 'image' ? content[0].name : '', 'weixin-only.png');
  assert.deepEqual(typing, ['owner-1']);
  assert.deepEqual(typingStopped, [], '进了会话就等回合结束再取消输入状态');
});

test('独立模式：文字与图片一起交给会话，文字在前', async () => {
  const built = imageMessage(2);
  const fetch = imageFetch([built.payload]);
  const { pipeline, submitted } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 2);
  const content = submitted[0]?.content ?? [];
  assert.deepEqual(content[0], { type: 'text', text: '看这张' });
  assert.equal(content.filter((part) => part.type === 'image').length, 2);
});

test('独立模式：非主人发图不下载也不提交', async () => {
  const built = imageOnlyMessage();
  const fetch = imageFetch([built.payload]);
  const { pipeline, submitted, typing } = harness({ fetch: fetch.impl, isOwner: () => false });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 0);
  assert.deepEqual(submitted, []);
  assert.deepEqual(typing, []);
});

test('独立模式：图下载失败又没有文字时整条丢弃，不留输入状态', async () => {
  const built = imageOnlyMessage();
  const fetch = imageFetch([Buffer.from('not an image')]);
  const { pipeline, submitted, typing } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 1);
  assert.deepEqual(submitted, []);
  assert.deepEqual(typing, []);
});

test('独立模式：消息在做问题作答时按文字处理，图片不下载', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([built.payload]);
  const { pipeline, submitted } = harness({ fetch: fetch.impl, replyQuestion: () => true });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 0);
  assert.deepEqual(submitted, []);
});

test('独立模式：宿主没有会话服务时不下载图片、也不开输入状态', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([built.payload]);
  const { pipeline, submitted, typing } = harness({ fetch: fetch.impl, directAvailable: false });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 0);
  assert.deepEqual(submitted, []);
  assert.deepEqual(typing, []);
});

test('独立模式：提交被拒后自己取消输入状态，不等回合事件', async () => {
  const built = imageOnlyMessage();
  const fetch = imageFetch([built.payload]);
  const { pipeline, typing, typingStopped } = harness({ fetch: fetch.impl, submitResult: 'failed' });

  await pipeline.route(built.message, signal);

  assert.deepEqual(typing, ['owner-1']);
  assert.deepEqual(typingStopped, ['owner-1']);
});

test('独立模式：超过 9 张只取前 9 张', async () => {
  const built = imageMessage(12);
  const fetch = imageFetch([built.payload]);
  const { pipeline, submitted } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 9);
  const content = submitted[0]?.content ?? [];
  assert.equal(content.filter((part) => part.type === 'image').length, 9);
});

test('独立模式：图下载失败但文字照常送达', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([Buffer.from('not an image')]);
  const { pipeline, submitted } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.deepEqual(submitted[0]?.content, [{ type: 'text', text: '看这张' }]);
});

test('独立模式：图片下载期间切到接入核心，就不再开新提交', async () => {
  const built = imageOnlyMessage();
  const fetch = imageFetch([built.payload]);
  // 下载一发起（calls 变成 1）就模拟「这张图下载期间被切走」：判据同源，route 醒来要重新看。
  const { pipeline, submitted, typing } = harness({
    fetch: fetch.impl,
    ownFeatures: () => fetch.calls() === 0,
  });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 1, '下载已经发出去了');
  assert.deepEqual(submitted, []);
  assert.deepEqual(typing, [], '切走后不该再开输入状态');
});

test('独立模式：插话成功时保留输入状态给回合事件收尾', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([built.payload]);
  const { pipeline, typingStopped } = harness({ fetch: fetch.impl, submitResult: 'steered' });

  await pipeline.route(built.message, signal);

  assert.deepEqual(typingStopped, []);
});
