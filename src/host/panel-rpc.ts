/**
 * Web 面板的管理 RPC：挂一条 exact 路由，校验信封后按端点分发给运行期。
 *
 * 信封格式与宿主其它插件一致（`type: 'client-request'` + `rpcId` + `payload`）。
 * 浏览器发来的 JSON 一律视为不可信输入：逐字段校验，认不出来就回 `bad-request`，
 * 不把原始错误抛给页面。
 */

import { errorDetail, injectOptional } from './host-context.ts';
import type { PanelRoute, PluginContext, PluginLogger } from './host-context.ts';
import type { RuntimeStatus, WeixinRuntime } from './runtime.ts';
import type { LoginSnapshot } from './ilink/login.ts';

/** 面板 RPC 的挂载路径：客户端经 connection.rpc.call('/api', 'dsh-im-wechat', …) 访问。 */
export const RPC_PATH = 'dsh-im-wechat';

export const ENDPOINTS = Object.freeze({
  STATUS: 'status',
  LOGIN_START: 'login.start',
  LOGIN_CODE: 'login.code',
  LOGIN_CANCEL: 'login.cancel',
  LOGOUT: 'logout',
  ENABLED_SET: 'enabled.set',
} as const);

export type Endpoint = (typeof ENDPOINTS)[keyof typeof ENDPOINTS];

interface RpcEnvelope {
  type?: unknown;
  rpcId?: unknown;
  method?: unknown;
  payload?: { method?: unknown; payload?: unknown };
}

interface CodedError extends Error {
  code: string;
}

function codedError(message: string, code: string): CodedError {
  const error = new Error(message) as CodedError;
  error.code = code;
  return error;
}

function reply(rpcId: string, result: unknown): Response {
  return Response.json({ type: 'server-response', rpcId, result });
}

function ok(rpcId: string, value: unknown): Response {
  return reply(rpcId, { ok: true, value });
}

function bad(rpcId: string, code: string, message: string): Response {
  return reply(rpcId, { ok: false, error: { code, message, details: {} } });
}

/** 面板 payload 的字段表：不是对象就按「什么都没填」处理。 */
function payloadOf(payload: unknown): Record<string, unknown> {
  return (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
}

async function handleEndpoint(
  runtime: WeixinRuntime,
  endpoint: string,
  payload: unknown,
): Promise<RuntimeStatus | LoginSnapshot> {
  switch (endpoint) {
    case ENDPOINTS.STATUS:
      return runtime.status();
    case ENDPOINTS.LOGIN_START:
      await runtime.startLogin();
      return runtime.status().login;
    case ENDPOINTS.LOGIN_CODE: {
      const code = payloadOf(payload).code;
      if (typeof code !== 'string' || code.trim() === '') {
        throw codedError('验证码不能为空', 'invalid-code');
      }
      return runtime.submitLoginCode(code);
    }
    case ENDPOINTS.LOGIN_CANCEL:
      await runtime.cancelLogin();
      return runtime.status().login;
    case ENDPOINTS.LOGOUT:
      return runtime.logout();
    case ENDPOINTS.ENABLED_SET: {
      const enabled = payloadOf(payload).enabled;
      if (typeof enabled !== 'boolean') throw codedError('enabled 必须是布尔值', 'invalid-config');
      return runtime.setEnabled(enabled);
    }
    default:
      throw codedError(`未知的面板端点：${endpoint}`, 'unknown-endpoint');
  }
}

export function registerPanelRpc(
  ctx: PluginContext,
  { runtime, logger }: { runtime: WeixinRuntime; logger: PluginLogger },
): void {
  const install = (scope: PluginContext): void => {
    const face = scope.connection?.fetch;
    if (!face || typeof face.register !== 'function') {
      logger.warn?.('面板 RPC 未注册：宿主未提供 connection.fetch.register');
      return;
    }
    const route: PanelRoute = {
      path: `/api/${RPC_PATH}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
        const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 });
        }
        let envelope: RpcEnvelope | null;
        try {
          envelope = (await request.json()) as RpcEnvelope | null;
        } catch {
          return new Response('body is not JSON', { status: 400 });
        }
        const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'invalid-request';
        const call = envelope?.payload;
        const invalid = envelope?.type !== 'client-request'
          || typeof envelope?.rpcId !== 'string'
          || envelope?.method !== RPC_PATH
          || call === undefined || call === null || typeof call !== 'object'
          || typeof call.method !== 'string';
        if (invalid) return bad(rpcId, 'bad-request', '管理请求格式不合法');
        try {
          return ok(rpcId, await handleEndpoint(runtime, call.method as string, call.payload));
        } catch (error) {
          logger.warn?.(`面板 RPC 失败 endpoint=${String(call.method)}`, errorDetail(error));
          const code = typeof (error as CodedError | null)?.code === 'string'
            ? (error as CodedError).code
            : 'internal';
          return bad(rpcId, code, error instanceof Error ? error.message : '面板操作失败');
        }
      },
    };
    try {
      // 有 effect 就走生命周期（Cordis 卸载时自动摘路由）；没有就直接挂上。
      if (typeof scope.effect === 'function') scope.effect(() => face.register(route), 'dsh-im-wechat: 面板 RPC');
      else face.register(route);
    } catch (error) {
      // 同路径已注册（插件另一份实例）不该让入站链路一起起不来。
      logger.error?.('面板 RPC 注册失败', errorDetail(error));
    }
  };

  injectOptional(ctx, 'connection', install);
}
