import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ILinkApi } from '../../src/host/ilink/api.ts';
import { OwnerChannel } from '../../src/host/owner-channel.ts';

interface SentMessage {
  to: string;
  text: string;
  contextToken: string;
}

function fakeApi(options: { fail?: boolean } = {}) {
  const sent: SentMessage[] = [];
  const api = {
    async sendMessage(message: {
      to_user_id?: string;
      context_token?: string;
      item_list?: { text_item?: { text?: string } }[];
    }) {
      if (options.fail) throw new Error('网络断了');
      sent.push({
        to: message.to_user_id ?? '',
        text: message.item_list?.[0]?.text_item?.text ?? '',
        contextToken: message.context_token ?? '',
      });
    },
  } as unknown as ILinkApi;
  return { api, sent };
}

function makeChannel(options: {
  active?: boolean;
  api?: ILinkApi | null;
  ownerId?: string;
  token?: string;
  gate?: { tryTake(): boolean };
} = {}) {
  const errors: string[] = [];
  const channel = new OwnerChannel({
    active: () => options.active !== false,
    api: () => options.api ?? null,
    account: () => 'bot@im.bot',
    ownerId: () => options.ownerId,
    token: () => options.token ?? 'ctx-1',
    noteError: (message) => errors.push(message),
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
  });
  return { channel, errors };
}

test('收件人只在自有功能生效且主人已知时才给出', () => {
  assert.equal(makeChannel({ ownerId: 'owner-1' }).channel.recipient(), 'owner-1');
  assert.equal(makeChannel({ ownerId: 'owner-1', active: false }).channel.recipient(), null);
  // 登录态里没记录扫码用户：不能猜，也不能退回到最近发消息的人。
  assert.equal(makeChannel().channel.recipient(), null);
});

test('主人判定按不区分大小写比对，主人未知时一律不认', () => {
  const { channel } = makeChannel({ ownerId: 'Owner-1' });
  assert.equal(channel.isOwner('owner-1'), true);
  assert.equal(channel.isOwner('owner-2'), false);
  assert.equal(makeChannel().channel.isOwner('owner-1'), false);
});

test('发到主人：带上收件人、文本与 context_token', async () => {
  const { api, sent } = fakeApi();
  const { channel, errors } = makeChannel({ api, ownerId: 'owner-1' });
  assert.equal(await channel.send('长任务提醒'), true);
  assert.deepEqual(sent, [{ to: 'owner-1', text: '长任务提醒', contextToken: 'ctx-1' }]);
  assert.deepEqual(errors, []);
});

test('提醒超预算时不发，交给调用方交回 Web', async () => {
  const { api, sent } = fakeApi();
  const { channel } = makeChannel({ api, ownerId: 'owner-1', gate: { tryTake: () => false } });
  assert.equal(await channel.send('提醒'), false);
  assert.deepEqual(sent, []);
});

test('没有令牌或没有客户端时不发，也不会编造成功', async () => {
  const { api, sent } = fakeApi();
  // 主人很久没说话：context_token 没了，协议侧会静默丢弃，本地直接不发。
  const noToken = makeChannel({ api, ownerId: 'owner-1', token: '' });
  assert.equal(await noToken.channel.send('hi'), false);
  assert.equal(sent.length, 0);
  assert.match(noToken.errors[0] ?? '', /提醒发送失败：.*context_token/);

  const noApi = makeChannel({ ownerId: 'owner-1' });
  assert.equal(await noApi.channel.send('hi'), false);
  assert.deepEqual(noApi.errors, []);
});

test('发送抛错只记一条可读错误，不把异常抛给提醒链路', async () => {
  const { api } = fakeApi({ fail: true });
  const { channel, errors } = makeChannel({ api, ownerId: 'owner-1' });
  assert.equal(await channel.send('hi'), false);
  assert.deepEqual(errors, ['提醒发送失败：网络断了']);
});
