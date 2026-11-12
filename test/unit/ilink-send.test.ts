import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ILinkError } from '../../src/host/ilink/api.ts';
import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { HARD_TEXT_LIMIT, SendError, classifySendFailure, sendImage, sendText } from '../../src/host/ilink/send.ts';
import type { OutboundMessage } from '../../src/host/ilink/types.ts';

interface Sent {
  message: OutboundMessage;
  timeoutMs?: number;
}

async function recordingApi(result: Error | null = null, response: Record<string, unknown> = {}): Promise<{ api: ILinkApi; sent: Sent[] }> {
  const sent: Sent[] = [];
  const api = {
    async sendMessage(message: OutboundMessage, options: { timeoutMs?: number } = {}) {
      sent.push({ message, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
      if (result) throw result;
      return response;
    },
  } as unknown as ILinkApi;
  return { api, sent };
}

test('缺少 context_token 时不发请求，按 window-closed 报错', async () => {
  const { api, sent } = await recordingApi();
  await assert.rejects(
    sendText(api, { to: 'owner-1', text: 'hi', contextToken: undefined }),
    (error: unknown) => error instanceof SendError && error.code === 'window-closed',
  );
  await assert.rejects(
    sendText(api, { to: 'owner-1', text: 'hi', contextToken: '   ' }),
    (error: unknown) => error instanceof SendError && error.code === 'window-closed',
  );
  assert.equal(sent.length, 0);
});

test('发送文本带齐协议字段', async () => {
  const { api, sent } = await recordingApi();
  const result = await sendText(api, { to: 'owner-1', text: '你好', contextToken: 'ctx-1', runId: 'run-1' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.to_user_id, 'owner-1');
  assert.equal(sent[0].message.message_type, 2);
  assert.equal(sent[0].message.message_state, 2);
  assert.equal(sent[0].message.context_token, 'ctx-1');
  assert.equal(sent[0].message.run_id, 'run-1');
  assert.deepEqual(sent[0].message.item_list, [{ type: 1, text_item: { text: '你好' } }]);
  assert.equal(sent[0].message.client_id, result.clientId);
  assert.match(result.clientId, /^dsh-im-wechat:/);
});

test('平台返回的 message_id 带回来，供引用回指定位到那一条', async () => {
  const { api } = await recordingApi(null, { message_id: '7526728717449013512' });
  const result = await sendText(api, { to: 'owner-1', text: 'hi', contextToken: 'ctx-1' });
  assert.equal(result.messageId, '7526728717449013512');
});

test('响应里没有 message_id 时不编造', async () => {
  const { api } = await recordingApi(null, { ret: 0 });
  const result = await sendText(api, { to: 'owner-1', text: 'hi', contextToken: 'ctx-1' });
  assert.equal(result.messageId, undefined);
});

test('图片发送同样带回平台 message_id', async () => {
  const { api, sent } = await recordingApi(null, { message_id: '7526728717449013512' });
  const result = await sendImage(api, {
    to: 'owner-1',
    contextToken: 'ctx-1',
    upload: { encryptQueryParam: 'p', aesKeyHex: '0'.repeat(32), ciphertextSize: 16 },
  });
  assert.equal(result.messageId, '7526728717449013512');
  assert.equal(sent.length, 1);
});

test('空文本不发空 item_list', async () => {
  const { api, sent } = await recordingApi();
  await sendText(api, { to: 'owner-1', text: '', contextToken: 'ctx-1' });
  assert.equal(sent[0].message.item_list, undefined);
});

test('超过硬上限的文本按 too-long 拒绝', async () => {
  const { api, sent } = await recordingApi();
  await assert.rejects(
    sendText(api, { to: 'owner-1', text: 'x'.repeat(HARD_TEXT_LIMIT + 1), contextToken: 'ctx-1' }),
    (error: unknown) => error instanceof SendError && error.code === 'too-long',
  );
  assert.equal(sent.length, 0);
});

test('长度上限按码点计，emoji 不被数成两个', async () => {
  const { api, sent } = await recordingApi();
  // UTF-16 长度是 2*HARD_TEXT_LIMIT，码点数正好等于上限 → 应放行。
  const text = '😀'.repeat(HARD_TEXT_LIMIT);
  assert.equal(text.length, HARD_TEXT_LIMIT * 2);
  await sendText(api, { to: 'owner-1', text, contextToken: 'ctx-1' });
  assert.equal(sent.length, 1);
  await assert.rejects(
    sendText(api, { to: 'owner-1', text: '😀'.repeat(HARD_TEXT_LIMIT + 1), contextToken: 'ctx-1' }),
    (error: unknown) => error instanceof SendError && error.code === 'too-long',
  );
});

test('失败分类：确定没送达的 failed、可能已送达的 uncertain', () => {
  assert.deepEqual(classifySendFailure(new SendError('window-closed', 'x')), {
    code: 'window-closed',
    certainty: 'failed',
    message: 'x',
  });
  assert.equal(classifySendFailure(new ILinkError('timeout', 't')).certainty, 'uncertain');
  assert.equal(classifySendFailure(new ILinkError('network', 'n', { reason: 'dns' })).certainty, 'failed');
  assert.equal(classifySendFailure(new ILinkError('network', 'n', { reason: 'tcp' })).certainty, 'uncertain');
  assert.deepEqual(
    { code: classifySendFailure(new ILinkError('http', 'h', { status: 401 })).code },
    { code: 'auth-expired' },
  );
  assert.equal(classifySendFailure(new ILinkError('http', 'h', { status: 429 })).code, 'rate-limited');
  assert.equal(classifySendFailure(new ILinkError('http', 'h', { status: 500 })).code, 'other');
  assert.equal(classifySendFailure(new ILinkError('api', 'a', { ret: -14 })).code, 'auth-expired');
  assert.equal(classifySendFailure(new ILinkError('api', 'a', { errcode: -14 })).code, 'auth-expired');
  assert.equal(classifySendFailure(new ILinkError('api', 'a', { ret: -2 })).code, 'window-closed');
  assert.equal(classifySendFailure(new ILinkError('api', 'a', { ret: 7 })).code, 'other');
  assert.deepEqual(classifySendFailure(new Error('boom')), { code: 'other', certainty: 'failed', message: 'boom' });
});
