/**
 * 核心模式的文件上报（ADR-0030）：核心声明 `owner-files` 才发，发之前桥自己按
 * 核心 Schema 的上限剔一遍——一条草稿被拒是整条消息（连文字）一起丢。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OWNER_FILE_BYTES_MAX, OWNER_FILE_DATA_MAX, OWNER_FILES_BYTES_MAX, OWNER_FILES_MAX } from '../../src/host/superagent/protocol.ts';
import { toOwnerMessageDraft } from '../../src/host/inbound.ts';
import type { InboundOptions } from '../../src/host/inbound.ts';
import { CDN, PDF, fileFetch, fileMessage, withDeclaredLen, withQuote } from './helpers/inbound-fixtures.ts';

const MiB = 1024 * 1024;

/** 核心模式：能判主人的那条路都走这一组选项。 */
function coreOptions(fetch: typeof globalThis.fetch, overrides: Partial<InboundOptions> = {}): InboundOptions {
  return {
    account: 'bot',
    cdnBaseUrl: CDN,
    filesEnabled: true,
    senderIsOwner: () => true,
    fetch,
    ...overrides,
  };
}

test('核心声明 owner-files 时把主人文件按标准 base64 上报，id 与引用不受影响', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'], text: '看下这个 pdf' });
  const fetch = fileFetch(built.payloads);
  const draft = await toOwnerMessageDraft(withQuote(built.message, '2999'), coreOptions(fetch.impl));

  assert.equal(draft?.messageId, 'weixin:v1:bot:owner-1:mid:3001');
  assert.equal(draft?.platformMessageId, '3001');
  assert.equal(draft?.replyTo, '2999');
  assert.equal(draft?.text, '看下这个 pdf');
  assert.equal(draft?.images, undefined);
  assert.equal(draft?.files?.length, 1);

  const file = draft?.files?.[0];
  assert.equal(file?.name, '报告.pdf');
  assert.equal(file?.mediaType, undefined, 'mediaType 只供展示，桥不填');
  assert.equal((file?.data ?? '').length % 4, 0, '标准 base64 带填充');
  assert.deepEqual(Buffer.from(file?.data ?? '', 'base64'), PDF);
});

test('只有文件没有文字：返回草稿而不是 null', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'] });
  const fetch = fileFetch(built.payloads);
  const draft = await toOwnerMessageDraft(built.message, coreOptions(fetch.impl));

  assert.notEqual(draft, null);
  assert.equal(draft?.text, '');
  assert.equal(draft?.files?.length, 1);
  assert.deepEqual(Buffer.from(draft?.files?.[0]?.data ?? '', 'base64'), PDF);
});

test('核心没声明 owner-files：不下载、草稿不带 files，只有文件的消息不产出草稿', async () => {
  const built = fileMessage(1, { names: ['报告.pdf'] });
  const fetch = fileFetch(built.payloads);
  // 这一组选项里没有 `filesEnabled`：桥自己的版本不能顶替核心的声明。
  const options: InboundOptions = { account: 'bot', cdnBaseUrl: CDN, fetch: fetch.impl, senderIsOwner: () => true };

  assert.equal(await toOwnerMessageDraft(built.message, options), null);
  assert.equal(fetch.calls(), 0);

  const withText = await toOwnerMessageDraft(fileMessage(1, { text: '看下这个 pdf' }).message, options);
  assert.equal(withText?.text, '看下这个 pdf');
  assert.equal(withText?.files, undefined);
});

test('声明了文件但没有身份判定时按纯文本处理，不下载', async () => {
  // 与图片同一道闸（ADR-0004）：没有 owner-lookup 就判不了主人，不能替任意发送者下文件。
  const built = fileMessage(1, { text: '看下这个 pdf' });
  const fetch = fileFetch(built.payloads);
  const options: InboundOptions = { account: 'bot', cdnBaseUrl: CDN, filesEnabled: true, fetch: fetch.impl };

  const draft = await toOwnerMessageDraft(built.message, options);
  assert.equal(fetch.calls(), 0);
  assert.equal(draft?.text, '看下这个 pdf');
  assert.equal(draft?.files, undefined);
});

test('非主人：不下载文件，文字照常交给核心判定', async () => {
  const built = fileMessage(1, { text: '看下这个 pdf' });
  const fetch = fileFetch(built.payloads);
  const draft = await toOwnerMessageDraft(built.message, coreOptions(fetch.impl, { senderIsOwner: () => false }));

  assert.equal(fetch.calls(), 0);
  assert.equal(draft?.text, '看下这个 pdf');
  assert.equal(draft?.files, undefined);
});

test('单个文件超过 8 MiB：只丢那个文件，其余文件与文字照常', async () => {
  const payloads = [Buffer.alloc(8 * MiB + 1, 0x41), PDF];
  const built = fileMessage(2, { names: ['超大.pdf', '小.pdf'], text: '两份都看下', payloads });
  const fetch = fileFetch(built.payloads);
  const draft = await toOwnerMessageDraft(built.message, coreOptions(fetch.impl));

  assert.equal(draft?.text, '两份都看下');
  assert.deepEqual(draft?.files?.map((file) => file.name), ['小.pdf']);
  for (const file of draft?.files ?? []) {
    assert.ok(Buffer.from(file.data, 'base64').length <= 8 * MiB, '不能让超限的 data 上到草稿');
  }
});

test('`len` 谎报时按解码后的字节再判一次：超过 8 MiB 的仍丢掉', async () => {
  const payloads = [Buffer.alloc(8 * MiB + 1, 0x41), PDF];
  const built = fileMessage(2, { names: ['谎报.pdf', '小.pdf'], payloads });
  const message = withDeclaredLen(built.message, 0, String(PDF.length));
  const draft = await toOwnerMessageDraft(message, coreOptions(fileFetch(built.payloads).impl));

  assert.deepEqual(draft?.files?.map((file) => file.name), ['小.pdf']);
});

test('合计超过 16 MiB：从尾部丢到放得下', async () => {
  const chunk = Buffer.alloc(6 * MiB, 0x42);
  const built = fileMessage(3, { names: ['一.pdf', '二.pdf', '三.pdf'], payloads: [chunk, chunk, chunk] });
  const fetch = fileFetch(built.payloads);
  const draft = await toOwnerMessageDraft(built.message, coreOptions(fetch.impl));

  assert.deepEqual(draft?.files?.map((file) => file.name), ['一.pdf', '二.pdf'], '尾部那个放不下');
  const total = (draft?.files ?? []).reduce((sum, file) => sum + Buffer.from(file.data, 'base64').length, 0);
  assert.ok(total <= 16 * MiB, `合计 ${total} 字节超过核心上限`);
});

test('空文件不上报：核心 Schema 要求 data 至少 4 个字符，带上会整条被拒', async () => {
  const built = fileMessage(1, { names: ['空.pdf'], payloads: [Buffer.alloc(0)] });
  const draft = await toOwnerMessageDraft(built.message, coreOptions(fileFetch(built.payloads).impl));

  assert.equal(draft, null, '没有可上报的内容');
});

test('本地常量与核心 Schema 对齐：3 个、8 MiB、16 MiB 与 base64 字符上限', async () => {
  // 字符上限必须由字节上限算出来：4 × ceil(8 MiB / 3)，两边任何一处单独改动都会让整条草稿被拒。
  assert.equal(OWNER_FILES_MAX, 3);
  assert.equal(OWNER_FILE_BYTES_MAX, 8 * 1024 * 1024);
  assert.equal(OWNER_FILES_BYTES_MAX, 16 * 1024 * 1024);
  assert.equal(OWNER_FILE_DATA_MAX, 4 * Math.ceil(OWNER_FILE_BYTES_MAX / 3));
});
