import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENDPOINTS, RPC_PATH, registerPanelRpc } from '../../src/host/panel-rpc.ts';
import type { PanelRoute, PluginContext } from '../../src/host/host-context.ts';

interface Harness {
  route: PanelRoute;
  calls: string[];
  warnings: unknown[][];
}

function harness(): Harness {
  const calls: string[] = [];
  const warnings: unknown[][] = [];
  const runtime = {
    status: () => ({ contract: 1, loggedIn: false, login: { phase: 'idle', refreshed: 0 } }),
    startLogin: async () => {
      calls.push('startLogin');
      return { phase: 'waiting', refreshed: 0 };
    },
    submitLoginCode: (code: string) => {
      calls.push(`code:${code}`);
      return { phase: 'waiting', refreshed: 0 };
    },
    cancelLogin: async () => ({ phase: 'cancelled', refreshed: 0 }),
    logout: async () => ({ contract: 1, loggedIn: false }),
    setEnabled: async (enabled: boolean) => {
      calls.push(`enabled:${enabled}`);
      return { contract: 1, enabled };
    },
    setSuperagent: async (enabled: boolean) => {
      calls.push(`superagent:${enabled}`);
      return { contract: 1, superagent: enabled };
    },
  };
  let route: PanelRoute | null = null;
  const ctx: PluginContext = {
    logger: { warn: (...args: unknown[]) => warnings.push(args) },
    effect: (execute: () => unknown) => {
      execute();
      return undefined;
    },
    connection: {
      fetch: {
        register: (value: PanelRoute) => {
          route = value;
          return () => undefined;
        },
      },
    },
  };
  registerPanelRpc(ctx, { runtime: runtime as never, logger: { warn: (...args: unknown[]) => warnings.push(args) } });
  assert.ok(route);
  return { route, calls, warnings };
}

function envelope(method: unknown, payload: unknown = {}): string {
  return JSON.stringify({ type: 'client-request', rpcId: 'r1', method: RPC_PATH, payload: { method, payload } });
}

function request(body: string, options: { method?: string; contentType?: string } = {}): Request {
  return new Request(`http://127.0.0.1/api/${RPC_PATH}`, {
    method: options.method ?? 'POST',
    headers: { 'content-type': options.contentType ?? 'application/json' },
    body: options.method === 'GET' ? undefined : body,
  });
}

async function call(h: Harness, body: string, options?: { method?: string; contentType?: string }): Promise<any> {
  const response = await h.route.fetch(request(body, options));
  return response.json();
}

test('缺 connection 时只告警，不抛', () => {
  const warnings: unknown[][] = [];
  assert.doesNotThrow(() => {
    registerPanelRpc({ logger: { warn: (...args: unknown[]) => warnings.push(args) } }, {
      runtime: {} as never,
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
    });
  });
  assert.equal(warnings.length > 0, true);
});

test('status 端点返回运行期快照', async () => {
  const h = harness();
  const result = await call(h, envelope(ENDPOINTS.STATUS));
  assert.deepEqual(result, { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { contract: 1, loggedIn: false, login: { phase: 'idle', refreshed: 0 } } } });
});

test('内容类型与请求方法都按信封要求拒绝', async () => {
  const h = harness();
  const wrongType = await h.route.fetch(request(envelope(ENDPOINTS.STATUS), { contentType: 'text/plain' }));
  assert.equal(wrongType.status, 415);
  const wrongMethod = await h.route.fetch(request('', { method: 'GET' }));
  assert.equal(wrongMethod.status, 405);
});

test('信封不合法回 bad-request，不把内部错误抛给页面', async () => {
  const h = harness();
  const result = await call(h, JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'other', payload: {} }));
  assert.equal(result.result.ok, false);
  assert.equal(result.result.error.code, 'bad-request');
});

test('未知端点回 unknown-endpoint', async () => {
  const h = harness();
  const result = await call(h, envelope('nope'));
  assert.equal(result.result.error.code, 'unknown-endpoint');
});

test('登录动作转发给运行期', async () => {
  const h = harness();
  await call(h, envelope(ENDPOINTS.LOGIN_START));
  await call(h, envelope(ENDPOINTS.LOGIN_CODE, { code: ' 123456 ' }));
  await call(h, envelope(ENDPOINTS.ENABLED_SET, { enabled: false }));
  await call(h, envelope(ENDPOINTS.SUPERAGENT_SET, { enabled: false }));
  assert.deepEqual(h.calls, ['startLogin', 'code: 123456 ', 'enabled:false', 'superagent:false']);
});

test('入参校验：验证码不能为空、enabled 必须是布尔', async () => {
  const h = harness();
  const emptyCode = await call(h, envelope(ENDPOINTS.LOGIN_CODE, { code: '   ' }));
  assert.equal(emptyCode.result.error.code, 'invalid-code');
  const badEnabled = await call(h, envelope(ENDPOINTS.ENABLED_SET, { enabled: 'yes' }));
  assert.equal(badEnabled.result.error.code, 'invalid-config');
});

test('路由挂在 /api/<包名> 上，且只接受 POST', () => {
  const h = harness();
  assert.equal(h.route.path, `/api/${RPC_PATH}`);
  assert.deepEqual(h.route.methods, ['POST']);
});
