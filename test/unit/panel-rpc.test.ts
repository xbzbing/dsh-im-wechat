import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ENDPOINTS, RPC_PATH, registerPanelRpc } from '../../src/host/panel-rpc.ts';
import { HOST_CONTRACT } from '../../src/host/runtime.ts';
import type { PanelRoute, PluginContext } from '../../src/host/host-context.ts';
import { REQUIRED_CONTRACT } from '../../src/client/constants.ts';

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
    cancelLogin: async () => {
      calls.push('cancelLogin');
      return { phase: 'cancelled', refreshed: 0 };
    },
    logout: async () => {
      calls.push('logout');
      return { contract: 1, loggedIn: false };
    },
    setEnabled: async (enabled: boolean) => {
      calls.push(`enabled:${enabled}`);
      return { contract: 1, enabled };
    },
    setSuperagent: async (enabled: boolean) => {
      calls.push(`superagent:${enabled}`);
      return { contract: 1, superagent: enabled };
    },
    setLongTaskThreshold: async (minutes: number) => {
      calls.push(`longtask:${minutes}`);
      return { contract: 2, longTaskThresholdMinutes: minutes };
    },
    setDirect: async (patch: { workspaceId?: string; busyMode?: string; reset?: boolean }) => {
      calls.push(`direct:${JSON.stringify(patch)}`);
      return { contract: 3, direct: { bound: false, workspaceId: patch.workspaceId ?? '', busyMode: patch.busyMode ?? 'queue', running: false, available: true } };
    },
    workspaces: () => ({ items: [{ id: 'w1', title: '工作区一', path: '/tmp/w1' }], available: true }),
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
  await call(h, envelope(ENDPOINTS.LONG_TASK_SET, { minutes: 45 }));
  assert.deepEqual(h.calls, ['startLogin', 'code: 123456 ', 'enabled:false', 'superagent:false', 'longtask:45']);
});

test('登出与取消登录两个端点也转发给运行期', async () => {
  // 这两个 case 标签写错不会有别的测试红：登出是清登录态的用户可见动作。
  const h = harness();
  await call(h, envelope(ENDPOINTS.LOGOUT));
  await call(h, envelope(ENDPOINTS.LOGIN_CANCEL));
  assert.deepEqual(h.calls, ['logout', 'cancelLogin']);
});

test('独立模式设置转发给运行期，非法值在边界挡住', async () => {
  const h = harness();
  await call(h, envelope(ENDPOINTS.DIRECT_SET, { workspaceId: 'w1', busyMode: 'steer' }));
  await call(h, envelope(ENDPOINTS.DIRECT_SET, { reset: true }));
  assert.deepEqual(h.calls, [
    'direct:{"workspaceId":"w1","busyMode":"steer"}',
    'direct:{"reset":true}',
  ]);
  const list = await call(h, envelope(ENDPOINTS.WORKSPACES_LIST));
  assert.deepEqual((list.result as { value: unknown }).value, { items: [{ id: 'w1', title: '工作区一', path: '/tmp/w1' }], available: true });
  const badMode = await call(h, envelope(ENDPOINTS.DIRECT_SET, { busyMode: 'interrupt' }));
  assert.equal(badMode.result.error.code, 'invalid-config');
  const badWorkspace = await call(h, envelope(ENDPOINTS.DIRECT_SET, { workspaceId: 3 }));
  assert.equal(badWorkspace.result.error.code, 'invalid-config');
  const badReset = await call(h, envelope(ENDPOINTS.DIRECT_SET, { reset: 'yes' }));
  assert.equal(badReset.result.error.code, 'invalid-config');
});

test('入参校验：验证码不能为空、enabled 必须是布尔', async () => {
  const h = harness();
  const emptyCode = await call(h, envelope(ENDPOINTS.LOGIN_CODE, { code: '   ' }));
  assert.equal(emptyCode.result.error.code, 'invalid-code');
  const badEnabled = await call(h, envelope(ENDPOINTS.ENABLED_SET, { enabled: 'yes' }));
  assert.equal(badEnabled.result.error.code, 'invalid-config');
  const badMinutes = await call(h, envelope(ENDPOINTS.LONG_TASK_SET, { minutes: '45' }));
  assert.equal(badMinutes.result.error.code, 'invalid-config');
  assert.deepEqual(h.calls, []);
});

test('两半契约版本一致：加端点或改返回结构时两边要一起递增', () => {
  // 对不上时：新面板 + 旧 Host 会打到不存在的端点，旧面板 + 新 Host 只是少几个字段。
  assert.equal(HOST_CONTRACT, REQUIRED_CONTRACT);
});

test('路由挂在 /api/<包名> 上，且只接受 POST', () => {
  const h = harness();
  assert.equal(h.route.path, `/api/${RPC_PATH}`);
  assert.deepEqual(h.route.methods, ['POST']);
});

test('热重载重叠：同路径只注册一次，旧实例清理不摘新实例的路由', async () => {
  // 模拟宿主：同路径重复 register 抛错（与真实 connection.fetch 行为一致的那半边）。
  const warnings: unknown[][] = [];
  let registrations = 0;
  let activeRoute: PanelRoute | null = null;
  const face = {
    register(route: PanelRoute) {
      // 只计成功：第二次是尝试注册并被良性捕获（真实宿主对重复 path 抛错）。
      if (registrations >= 1) throw new Error('path already registered');
      registrations += 1;
      activeRoute = route;
      return () => {
        activeRoute = null;
      };
    },
  };
  const makeCtx = (marker: string) => {
    const cleanups: (() => void)[] = [];
    const logger = { warn: (...args: unknown[]) => warnings.push(args) };
    const ctx: PluginContext = {
      logger,
      effect: (execute: () => unknown) => {
        const dispose = execute();
        if (typeof dispose === 'function') cleanups.push(dispose as () => void);
        return undefined;
      },
      connection: { fetch: face },
    };
    const runtime = { status: () => ({ marker }) } as never;
    registerPanelRpc(ctx, { runtime, logger });
    return { cleanups, marker };
  };

  const first = makeCtx('first');
  const second = makeCtx('second');
  assert.equal(registrations, 1, '同路径只该注册一次');
  assert.ok(warnings.some((args) => String(args[0]).includes('接管现有路由')));

  const route = activeRoute as PanelRoute | null;
  assert.ok(route);
  const fetchStatus = async (): Promise<unknown> => {
    const response = await route.fetch(request(envelope(ENDPOINTS.STATUS)));
    const body = (await response.json()) as { result: { value: { marker?: string } } };
    return body.result.value.marker;
  };
  // 后装的实例接管 handler：请求由它服务。
  assert.equal(await fetchStatus(), 'second');

  // 重叠期旧实例先 dispose：路由必须还在，仍由新实例服务（这就是原 bug 的反面）。
  for (const cleanup of first.cleanups) cleanup();
  assert.notEqual(activeRoute, null, '旧实例清理不该摘掉路由');
  assert.equal(await fetchStatus(), 'second');

  // 新实例才是最后离场的：它清理后路由摘掉，兜底回 503。
  for (const cleanup of second.cleanups) cleanup();
  assert.equal(activeRoute, null);
  const fallback = await route.fetch(request(envelope(ENDPOINTS.STATUS)));
  assert.equal(fallback.status, 503);
});
