import assert from 'node:assert/strict';
import { test } from 'node:test';

import { InboundPipeline } from '../../src/host/inbound-pipeline.ts';
import type { InboundPipelineDeps } from '../../src/host/inbound-pipeline.ts';
import type { SubmitResult } from '../../src/host/direct.ts';
import type { InboundFiles } from '../../src/host/inbound.ts';
import type { PromptPart } from '../../src/host/prompt-parts.ts';
import type { CommandInput } from '../../src/host/standalone/commands.ts';
import type { WeixinMessage } from '../../src/host/ilink/types.ts';
import type { WeixinBridge } from '../../src/host/superagent/bridge.ts';
import type { BridgeBinder } from '../../src/host/superagent/link.ts';
import type { OwnerMessageDraft } from '../../src/host/superagent/protocol.ts';
import { CDN, PDF, PNG, fileMessage, imageFetch, imageMessage, imageOnlyMessage } from './helpers/inbound-fixtures.ts';

interface Submitted {
  sender: string;
  content: readonly PromptPart[];
  files?: InboundFiles;
}

/** 只为 `route` 用的最小依赖：轮询侧的状态用空壳占位，本组测试不碰。 */
function harness(options: {
  fetch?: typeof globalThis.fetch;
  isOwner?: (sender: string) => boolean;
  ownFeatures?: boolean | (() => boolean);
  superagent?: boolean;
  /** 接入核心：给一个已注册的绑定器，并把草稿收进 `received`。 */
  core?: boolean;
  /** 覆盖桥的能力声明与身份查询（默认只有 account）。 */
  bridge?: Partial<WeixinBridge>;
  replyQuestion?: (text: string) => boolean;
  directAvailable?: boolean;
  submitResult?: SubmitResult;
  commandHandled?: boolean;
} = {}) {
  const received: OwnerMessageDraft[] = [];
  const submitted: Submitted[] = [];
  const typing: string[] = [];
  const typingStopped: string[] = [];
  const commands: CommandInput[] = [];
  const replies: string[] = [];
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
    bridge: () => ({ account: 'bot', ...options.bridge }) as unknown as WeixinBridge,
    binder: () => (options.core === true
      ? {
        receive: async (draft: OwnerMessageDraft) => {
          received.push(draft);
          return { accepted: true };
        },
        registrationError: undefined,
      } as unknown as BridgeBinder
      : null),
    ownFeaturesActive: () => (typeof options.ownFeatures === 'function' ? options.ownFeatures() : options.ownFeatures ?? true),
    isOwner: options.isOwner ?? ((sender: string) => sender === 'owner-1'),
    replyQuestion: (text: string) => {
      replies.push(text);
      return options.replyQuestion === undefined ? false : options.replyQuestion(text);
    },
    superagentEnabled: () => options.superagent ?? false,
    directAvailable: () => options.directAvailable ?? true,
    runCommand: async (input) => {
      commands.push(input);
      return options.commandHandled ?? false;
    },
    typingStart: (sender) => typing.push(sender),
    typingStop: (sender) => typingStopped.push(sender),
    submitDirect: async (sender, content, files) => {
      submitted.push({ sender, content, ...(files !== undefined ? { files } : {}) });
      return options.submitResult ?? 'queued';
    },
    setHealth: () => {},
    noteError: () => {},
  });
  return { pipeline, submitted, received, typing, typingStopped, commands, replies };
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

/** 一条只有文字的入站消息。 */
function textMessage(text: string) {
  return {
    message: {
      message_id: '3001',
      from_user_id: 'owner-1',
      create_time_ms: 1_760_000_000_000,
      item_list: [{ type: 1 as const, text_item: { text } }],
    },
  };
}

test('独立模式：主人的命令交给命令层，不再进会话', async () => {
  const { pipeline, submitted, typing, commands } = harness({ commandHandled: true });
  await pipeline.route(textMessage('/help').message, signal);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.text, '/help');
  assert.equal(commands[0]?.hasImages, false);
  assert.deepEqual(submitted, []);
  assert.deepEqual(typing, [], '命令不经过模型，不开「正在输入」');
});

test('独立模式：命令带图时只有 /send 下载图片，其他命令先说明图没有发出', async () => {
  const built = imageMessage(1);
  const fetch = imageFetch([built.payload]);
  const { pipeline, commands } = harness({ fetch: fetch.impl, commandHandled: true });

  const help = built.message;
  help.item_list![0] = { type: 1, text_item: { text: '/help' } };
  await pipeline.route(help, signal);
  assert.equal(fetch.calls(), 0);
  assert.equal(commands[0]?.hasImages, true);
  assert.deepEqual(commands[0]?.images, []);

  const send = built.message;
  send.message_id = '2002';
  send.item_list![0] = { type: 1, text_item: { text: '/send 1 看图' } };
  await pipeline.route(send, signal);
  assert.equal(fetch.calls(), 1);
  assert.equal(commands[1]?.images.length, 1);
});

test('独立模式：非主人的命令不交给命令层', async () => {
  const { pipeline, submitted, commands } = harness({ commandHandled: true, isOwner: () => false });
  await pipeline.route(textMessage('/help').message, signal);
  assert.deepEqual(commands, []);
  assert.deepEqual(submitted, []);
});

test('独立模式：待答问题不会把命令吞成答案', async () => {
  const { pipeline, commands, replies } = harness({ commandHandled: true, replyQuestion: () => true });
  await pipeline.route(textMessage('/help').message, signal);
  assert.equal(commands.length, 1);
  assert.deepEqual(replies, [], '命令先于「回答问题」处理');
});

test('独立模式：普通文字仍先给回答问题，再交给会话', async () => {
  const { pipeline, commands, replies, submitted } = harness({ commandHandled: true, replyQuestion: () => true });
  await pipeline.route(textMessage('我的答案是 2').message, signal);
  assert.deepEqual(commands, []);
  assert.deepEqual(replies, ['我的答案是 2']);
  assert.deepEqual(submitted, []);
});

test('独立模式：主人只发文件时下载并交给会话，补提示留给提交层', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'] });
  const fetch = imageFetch(built.payloads);
  const { pipeline, submitted, typing } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 1);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.sender, 'owner-1');
  assert.deepEqual(submitted[0]?.content, [], '文件不拼进 content，回执由提交层换');
  assert.equal(submitted[0]?.files?.files.length, 1);
  assert.equal(submitted[0]?.files?.files[0]?.name, '报告.pdf');
  assert.deepEqual(typing, ['owner-1']);
});

test('独立模式：文字与文件一起时，content 是文字、文件单独传', async () => {
  const built = fileMessage(1, { text: '总结这个', names: ['报告.pdf'] });
  const fetch = imageFetch(built.payloads);
  const { pipeline, submitted } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);

  assert.deepEqual(submitted[0]?.content, [{ type: 'text', text: '总结这个' }]);
  assert.equal(submitted[0]?.files?.files.length, 1);
});

test('独立模式：文件没收下又没有别的可交付内容时，只把原因交给提交层', async () => {
  const built = fileMessage(1, { names: ['大文件.pdf'] });
  const message = { ...built.message, item_list: [{ type: 4, file_item: { ...built.message.item_list?.[0]?.file_item, len: '999999999' } }] };
  const fetch = imageFetch(built.payloads);
  const { pipeline, submitted, typing } = harness({ fetch: fetch.impl });

  await pipeline.route(message, signal);

  assert.equal(fetch.calls(), 0);
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0]?.content, []);
  assert.equal(submitted[0]?.files?.files.length, 0);
  assert.equal(submitted[0]?.files?.dropped.length, 1);
  assert.deepEqual(typing, [], '没有可提交的内容，不开输入状态');
});

test('独立模式：非主人发文件不下载也不提交', async () => {
  const built = fileMessage(1);
  const fetch = imageFetch(built.payloads);
  const { pipeline, submitted } = harness({ fetch: fetch.impl, isOwner: () => false });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 0);
  assert.deepEqual(submitted, []);
});

test('独立模式：宿主没有会话服务时不下载文件', async () => {
  const built = fileMessage(1);
  const fetch = imageFetch(built.payloads);
  const { pipeline, submitted } = harness({ fetch: fetch.impl, directAvailable: false });

  await pipeline.route(built.message, signal);

  assert.equal(fetch.calls(), 0);
  assert.deepEqual(submitted, []);
});

test('核心模式：声明 owner-files 时把文件随草稿交给核心', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'], text: '看下这个 pdf' });
  const fetch = imageFetch(built.payloads);
  const { pipeline, received, typing } = harness({
    fetch: fetch.impl,
    superagent: true,
    core: true,
    bridge: { filesEnabled: true, ownerLookup: (sender: string) => sender === 'owner-1' },
  });

  await pipeline.route(built.message, signal);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, '看下这个 pdf');
  assert.equal(received[0]?.files?.[0]?.name, '报告.pdf');
  assert.deepEqual(Buffer.from(received[0]?.files?.[0]?.data ?? '', 'base64'), PDF);
  assert.deepEqual(typing, ['owner-1'], '核心受理后开输入状态');
});

test('核心模式：没声明 owner-files 时文件不上报，文字照常交给核心', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'], text: '看下这个 pdf' });
  const fetch = imageFetch(built.payloads);
  const { pipeline, received } = harness({
    fetch: fetch.impl,
    superagent: true,
    core: true,
    bridge: { ownerLookup: (sender: string) => sender === 'owner-1' },
  });

  await pipeline.route(built.message, signal);

  assert.equal(received.length, 1);
  assert.equal(received[0]?.text, '看下这个 pdf');
  assert.equal(received[0]?.files, undefined);
  assert.equal(fetch.calls(), 0);
});

/** 一条「引用某条消息 + 一句文字」的入站消息。 */
function quotingMessage(
  ref: { svr_id?: string; title?: string },
  text: string,
): WeixinMessage {
  return {
    message_id: '4001',
    from_user_id: 'owner-1',
    create_time_ms: 1_760_000_000_001,
    item_list: [{ type: 1, text_item: { text }, ref_msg: ref }],
  };
}

function quotedText(content: readonly PromptPart[] | undefined): string {
  const first = content?.[0];
  return first?.type === 'text' ? first.text : '';
}

test('独立模式：引用上一条消息里的文件时，标头点名那个文件', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'] });
  const fetch = imageFetch(built.payloads);
  const { pipeline, submitted } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);
  await pipeline.route(quotingMessage({ svr_id: '3001' }, '这个文件的作者是谁？'), signal);

  assert.deepEqual(submitted[1]?.content, [
    { type: 'text', text: '[引用：文件 报告.pdf]', quote: true },
    { type: 'text', text: '这个文件的作者是谁？' },
  ]);
});

test('独立模式：引用先是文字的消息时带摘要', async () => {
  const { pipeline, submitted } = harness();

  await pipeline.route(textMessage('原文是这句话').message, signal);
  await pipeline.route(quotingMessage({ svr_id: '3001' }, '这句什么意思？'), signal);

  assert.equal(quotedText(submitted[1]?.content), '[引用：「原文是这句话」]');
  assert.deepEqual(submitted[1]?.content?.[1], { type: 'text', text: '这句什么意思？' });
});

test('独立模式：引用认不出来时只有标题，就带上标题', async () => {
  const { pipeline, submitted } = harness();

  await pipeline.route(quotingMessage({ svr_id: '9999', title: '被引用的消息' }, '这句什么意思？'), signal);

  assert.equal(quotedText(submitted[0]?.content), '[引用：「被引用的消息」]');
});

test('独立模式：只引用、没有别的可交付内容时不提交', async () => {
  const { pipeline, submitted } = harness();

  await pipeline.route(quotingMessage({ svr_id: '3001' }, ''), signal);

  assert.deepEqual(submitted, [], '标头不单独成一条消息');
});

test('独立模式：引用 + 只有图片时，标头与图片一起提交', async () => {
  const built = imageOnlyMessage();
  const fetch = imageFetch([built.payload, built.payload]);
  const { pipeline, submitted } = harness({ fetch: fetch.impl });

  await pipeline.route(built.message, signal);
  const [imageItem] = built.message.item_list ?? [];
  await pipeline.route({
    ...built.message,
    message_id: '4002',
    item_list: [{ ...imageItem, ref_msg: { svr_id: '2004' } }],
  }, signal);

  const content = submitted[1]?.content ?? [];
  assert.equal(quotedText(content), '[引用：图片]');
  assert.deepEqual(content.slice(1), [{
    type: 'image',
    mediaType: 'image/png',
    data: PNG.toString('base64'),
    name: 'weixin-only.png',
  }]);
});
