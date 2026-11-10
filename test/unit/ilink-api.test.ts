import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ILinkApi,
  ILinkError,
  ILINK_APP_CLIENT_VERSION,
  encodeClientVersion,
  isAllowedApiUrl,
} from '../../src/host/ilink/api.ts';
import { parseJsonKeepIntegers } from '../../src/host/ilink/json.ts';
import { CHANNEL_VERSION, ILINK_PROTOCOL_VERSION, PACKAGE_NAME, PLUGIN_VERSION } from '../../src/shared/version.ts';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null | undefined;
}

/** 记录请求并回放固定响应。 */
function recordingFetch(response: Response | (() => Promise<Response>)): {
  calls: Captured[];
  impl: typeof globalThis.fetch;
} {
  const calls: Captured[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body,
      signal: init?.signal,
    });
    return typeof response === 'function' ? response() : response.clone();
  }) as typeof globalThis.fetch;
  return { calls, impl };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeApi(overrides: Partial<ConstructorParameters<typeof ILinkApi>[0]> = {}): ILinkApi {
  const { impl } = recordingFetch(jsonResponse({ ret: 0 }));
  return new ILinkApi({
    baseUrl: 'https://ilinkai.weixin.qq.com',
    channelVersion: CHANNEL_VERSION,
    botAgent: 'dsh-im-wechat/0.1.0',
    token: 'token-abc',
    fetch: overrides.fetch ?? impl,
    randomUint32: () => 1_234_567,
    ...overrides,
  });
}

test('包版本常量与 package.json 一致', () => {
  assert.equal(PLUGIN_VERSION, manifest.version);
  assert.equal(ILINK_PROTOCOL_VERSION, '3.0.0');
  // 协议要求前三段是上游版本，自有版本只能跟在斜杠后面。
  assert.equal(CHANNEL_VERSION, `3.0.0/${PACKAGE_NAME}-${manifest.version}`);
});

test('客户端版本按 0x00MMNNPP 编码', () => {
  assert.equal(encodeClientVersion('3.0.0'), 196_608);
  assert.equal(ILINK_APP_CLIENT_VERSION, 196_608);
  assert.equal(encodeClientVersion('0.1.0'), 256);
  assert.equal(encodeClientVersion('1'), 65_536);
});

test('message_id 保住 64 位精度，-0 归一成 0', () => {
  const text = '{"message_id":-9223372036854775808,"msg_id":9007199254740993,"seq":7,"n":-0}';
  const parsed = parseJsonKeepIntegers(text) as Record<string, unknown>;
  assert.equal(parsed.message_id, '-9223372036854775808');
  assert.equal(parsed.msg_id, '9007199254740993');
  assert.equal(parsed.seq, 7);
  assert.equal(Object.is(parsed.n, -0), true);
});

test('POST 带齐协议头与 base_info', async () => {
  const { calls, impl } = recordingFetch(jsonResponse({ ret: 0, msgs: [] }));
  const api = makeApi({ fetch: impl });
  await api.getUpdates({ cursor: 'CURSOR', timeoutMs: 1000 });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://ilinkai.weixin.qq.com/ilink/bot/getupdates');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['iLink-App-Id'], 'bot');
  assert.equal(call.headers['iLink-App-ClientVersion'], '196608');
  assert.equal(call.headers.AuthorizationType, 'ilink_bot_token');
  assert.equal(call.headers.Authorization, 'Bearer token-abc');
  assert.equal(call.headers['X-WECHAT-UIN'], Buffer.from('1234567').toString('base64'));
  assert.deepEqual(call.body, {
    get_updates_buf: 'CURSOR',
    base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'dsh-im-wechat/0.1.0' },
  });
});

test('扫码接口不带 Authorization，鉴权接口才带', async () => {
  const { calls, impl } = recordingFetch(jsonResponse({ qrcode: 'q1', qrcode_img_content: 'https://x' }));
  const api = makeApi({ fetch: impl, token: undefined });
  await api.getBotQrCode();
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].headers['X-WECHAT-UIN'] !== undefined, true);
  assert.ok(calls[0].url.endsWith('/ilink/bot/get_bot_qrcode?bot_type=3'));
});

test('verifyPin 打开时取码带 bot_spam_business_data，关闭时不带', async () => {
  const { calls, impl } = recordingFetch(jsonResponse({ qrcode: 'q1', qrcode_img_content: 'https://x' }));
  const api = makeApi({ fetch: impl, token: undefined });
  await api.getBotQrCode({ localTokenList: [] });
  assert.deepEqual(calls[0].body, { local_token_list: [] });
  await api.getBotQrCode({ localTokenList: ['tok'], verifyPin: true });
  assert.deepEqual(calls[1].body, {
    local_token_list: ['tok'],
    bot_spam_business_data: 'eyJ2ZXJpZnlfcGluIjoxfQ==',
  });
});

test('长轮询超时按正常控制流返回空响应', async () => {
  const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof globalThis.fetch;
  const api = makeApi({ fetch: hanging });
  const response = await api.getUpdates({ cursor: 'C2', timeoutMs: 5 });
  assert.deepEqual(response, { ret: 0, msgs: [], get_updates_buf: 'C2' });
});

test('外部取消原样抛出，交给轮询循环退出', async () => {
  const controller = new AbortController();
  const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof globalThis.fetch;
  const api = makeApi({ fetch: hanging });
  const pending = api.getUpdates({ cursor: '', timeoutMs: 30_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === 'AbortError');
});

test('HTTP 失败归成 http 类错误并带状态码', async () => {
  const { impl } = recordingFetch(new Response('boom', { status: 503 }));
  const api = makeApi({ fetch: impl });
  await assert.rejects(api.getUpdates({ cursor: '' }), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 503);
    return true;
  });
});

test('业务 ret 非 0 归成 api 类错误并保留 ret', async () => {
  const { impl } = recordingFetch(jsonResponse({ ret: -2, errmsg: '' }));
  const api = makeApi({ fetch: impl });
  await assert.rejects(api.sendMessage({
    from_user_id: '',
    to_user_id: 'u1',
    client_id: 'c1',
    message_type: 2,
    message_state: 2,
  }), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.equal(error.kind, 'api');
    assert.equal(error.ret, -2);
    return true;
  });
});

test('扫码轮询只把客户端超时折成 wait，网络错误上抛', async () => {
  // 超时：服务端还没扫完，正常等待。
  const hanging = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    })) as typeof globalThis.fetch;
  const api = makeApi({ fetch: hanging });
  assert.deepEqual(await api.getQrStatus({ qrcode: 'q1', timeoutMs: 5 }), { status: 'wait' });

  // 网络错误必须上抛：折成 wait 会让 DNS 断了也显示「等待扫码」。
  const failing = (async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } });
  }) as typeof globalThis.fetch;
  const api2 = makeApi({ fetch: failing });
  await assert.rejects(api2.getQrStatus({ qrcode: 'q1', timeoutMs: 10 }), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.equal(error.kind, 'network');
    return true;
  });
});

test('扫码轮询解析状态字段', async () => {
  const { calls, impl } = recordingFetch(jsonResponse({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b' }));
  const api = makeApi({ fetch: impl });
  const status = await api.getQrStatus({ qrcode: 'q1', verifyCode: '42' });
  assert.equal(status.status, 'confirmed');
  assert.equal(status.bot_token, 't');
  assert.equal(calls[0].method, 'GET');
  assert.equal(
    calls[0].url,
    'https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=q1&verify_code=42',
  );
});

test('扫码轮询的 HTTP 错误消息不带查询串（PIN 不进日志与面板）', async () => {
  const bad = (async () => new Response('bad gateway', { status: 502 })) as typeof globalThis.fetch;
  const api = makeApi({ fetch: bad });
  await assert.rejects(api.getQrStatus({ qrcode: 'q1', verifyCode: 'secret-pin' }), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.equal(error.kind, 'http');
    assert.match(error.message, /ilink\/bot\/get_qrcode_status/);
    assert.equal(error.message.includes('verify_code'), false);
    assert.equal(error.message.includes('secret-pin'), false);
    return true;
  });
});

test('响应必须是对象：网关返回非 JSON 对象按 api 错误拒绝', async () => {
  const scalar = (async () => new Response('<html>gateway</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  })) as typeof globalThis.fetch;
  const api = makeApi({ fetch: scalar });
  await assert.rejects(api.sendMessage({
    from_user_id: '',
    to_user_id: 'u1',
    client_id: 'c1',
    message_type: 2,
    message_state: 2,
  }), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.equal(error.kind, 'api');
    return true;
  });
  await assert.rejects(api.getUpdates({ cursor: '' }), (error: unknown) => error instanceof ILinkError);
  await assert.rejects(api.getQrStatus({ qrcode: 'q1' }), (error: unknown) => error instanceof ILinkError);
});

test('getupdates 的 msgs 必须是数组', async () => {
  const bad = (async () => new Response(JSON.stringify({ ret: 0, msgs: 'oops' }))) as typeof globalThis.fetch;
  const api = makeApi({ fetch: bad });
  await assert.rejects(api.getUpdates({ cursor: '' }), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.match(error.message, /msgs/);
    return true;
  });
});

test('API 基址白名单只认腾讯域名', () => {
  assert.equal(isAllowedApiUrl('https://ilinkai.weixin.qq.com'), true);
  assert.equal(isAllowedApiUrl('https://idc2.ilink.weixin.qq.com/x'), true);
  assert.equal(isAllowedApiUrl('http://ilinkai.weixin.qq.com'), false);
  assert.equal(isAllowedApiUrl('https://evil.example.com'), false);
  assert.equal(isAllowedApiUrl('https://qq.com.evil.com'), false);
  assert.equal(isAllowedApiUrl('not a url'), false);
});

test('网络失败归成 network 类错误并带分类', async () => {
  const failing = (async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { cause: { code: 'ENOTFOUND' } });
  }) as typeof globalThis.fetch;
  const api = makeApi({ fetch: failing });
  await assert.rejects(api.notifyStart(), (error: unknown) => {
    assert.ok(error instanceof ILinkError);
    assert.equal(error.kind, 'network');
    assert.equal(error.reason, 'dns');
    return true;
  });
});

test('sendTyping 打到 sendtyping 端点并带 ticket 与状态', async () => {
  const { calls, impl } = recordingFetch(jsonResponse({}));
  const api = makeApi({ fetch: impl });
  await api.sendTyping({ userId: 'user-1', typingTicket: 'tt-9', status: 1 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /ilink\/bot\/sendtyping$/);
  assert.equal(calls[0].method, 'POST');
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.ilink_user_id, 'user-1');
  assert.equal(body.typing_ticket, 'tt-9');
  assert.equal(body.status, 1);
  assert.ok(body.base_info, '所有 POST 都带 base_info');
});

test('sendTyping 的 HTTP 失败照常抛出，让上层记日志', async () => {
  const failing = (async () => new Response('oops', { status: 500 })) as typeof globalThis.fetch;
  const api = makeApi({ fetch: failing });
  await assert.rejects(
    api.sendTyping({ userId: 'user-1', typingTicket: 'tt-9', status: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof ILinkError);
      assert.equal(error.kind, 'http');
      return true;
    },
  );
});
