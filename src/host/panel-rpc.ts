/**
 * Web 面板的管理 RPC：挂一条 exact 路由，校验信封后按端点分发给运行期。
 *
 * 信封格式与宿主其它插件一致（`type: 'client-request'` + `rpcId` + `payload`）。
 * 浏览器发来的 JSON 一律视为不可信输入：逐字段校验，认不出来就回 `bad-request`，
 * 不把原始错误抛给页面。
 */

import { errorDetail, injectOptional } from './host-context.ts';
import type { PanelRoute, PluginContext, PluginLogger } from './host-context.ts';
import type { WeixinRuntime } from './runtime.ts';

/** 面板 RPC 的挂载路径：客户端经 connection.rpc.call('/api', 'dsh-im-wechat', …) 访问。 */
export const RPC_PATH = 'dsh-im-wechat';

export const ENDPOINTS = Object.freeze({
  STATUS: 'status',
  LOGIN_START: 'login.start',
  LOGIN_CODE: 'login.code',
  LOGIN_CANCEL: 'login.cancel',
  LOGOUT: 'logout',
  ENABLED_SET: 'enabled.set',
  SUPERAGENT_SET: 'superagent.set',
  LONG_TASK_SET: 'longtask.set',
  QUESTION_SET: 'question.set',
  DIRECT_SET: 'direct.set',
  WORKSPACES_LIST: 'workspaces.list',
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

/**
 * 进程级单例：同路径只注册一条**委托路由**，请求转给「当前活着的实例」。
 *
 * 热重载重叠期新实例先注册、旧实例后 dispose 时，旧实例若无条件调 off() 摘掉
 * 的是新实例正依赖的路由（面板 404、只能重启恢复）。委托 + handler 替换之后：
 * 旧实例释放时发现 handler 已被接手就不动路由，最后离场的实例才摘。
 */
interface PanelRouteSingleton {
  handler: ((request: Request) => Response | Promise<Response>) | null;
  /** 最近一次成功注册返回的 off：只有最后离场的实例才调它。 */
  off: (() => void) | null;
}

const PANEL_ROUTE_SINGLETON = Symbol.for('dsh-im-wechat:panel-route');

function panelRouteSingleton(): PanelRouteSingleton {
  const globals = globalThis as unknown as Record<symbol, PanelRouteSingleton | undefined>;
  const existing = globals[PANEL_ROUTE_SINGLETON];
  if (existing) return existing;
  const created: PanelRouteSingleton = { handler: null, off: null };
  globals[PANEL_ROUTE_SINGLETON] = created;
  return created;
}

async function handleEndpoint(
  runtime: WeixinRuntime,
  endpoint: string,
  payload: unknown,
): Promise<unknown> {
  switch (endpoint) {
    case ENDPOINTS.STATUS:
      return runtime.status();
    case ENDPOINTS.WORKSPACES_LIST:
      return await runtime.workspacesView();
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
    case ENDPOINTS.SUPERAGENT_SET: {
      const enabled = payloadOf(payload).enabled;
      if (typeof enabled !== 'boolean') throw codedError('enabled 必须是布尔值', 'invalid-config');
      return runtime.setSuperagent(enabled);
    }
    case ENDPOINTS.DIRECT_SET: {
      const record = payloadOf(payload);
      const patch: { workspaceId?: string; busyMode?: 'queue' | 'steer'; reset?: boolean } = {};
      if (record.workspaceId !== undefined) {
        if (typeof record.workspaceId !== 'string') throw codedError('workspaceId 必须是字符串', 'invalid-config');
        patch.workspaceId = record.workspaceId;
      }
      if (record.busyMode !== undefined) {
        if (record.busyMode !== 'queue' && record.busyMode !== 'steer') {
          throw codedError('busyMode 只能是 queue 或 steer', 'invalid-config');
        }
        patch.busyMode = record.busyMode;
      }
      if (record.reset !== undefined) {
        if (typeof record.reset !== 'boolean') throw codedError('reset 必须是布尔值', 'invalid-config');
        patch.reset = record.reset;
      }
      return runtime.setDirect(patch);
    }
    case ENDPOINTS.QUESTION_SET: {
      const record = payloadOf(payload);
      const patch: { enabled?: boolean; delayMinutes?: number } = {};
      if (record.enabled !== undefined) {
        if (typeof record.enabled !== 'boolean') throw codedError('enabled 必须是布尔值', 'invalid-config');
        patch.enabled = record.enabled;
      }
      if (record.delayMinutes !== undefined) {
        if (typeof record.delayMinutes !== 'number' || !Number.isFinite(record.delayMinutes)) {
          throw codedError('delayMinutes 必须是数字', 'invalid-config');
        }
        patch.delayMinutes = record.delayMinutes;
      }
      if (patch.enabled === undefined && patch.delayMinutes === undefined) {
        throw codedError('没有要保存的设置', 'invalid-config');
      }
      return runtime.setQuestionSettings(patch);
    }
    case ENDPOINTS.LONG_TASK_SET: {
      const minutes = payloadOf(payload).minutes;
      if (typeof minutes !== 'number' || !Number.isFinite(minutes)) {
        throw codedError('minutes 必须是数字', 'invalid-config');
      }
      return runtime.setLongTaskThreshold(minutes);
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
    const state = panelRouteSingleton();

    const handleRequest = async (request: Request): Promise<Response> => {
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
        const coded = typeof (error as CodedError | null)?.code === 'string';
        // 只有自造的 coded 错误文案是给用户看的；未分类的内部错误不把
        // 可能带本机路径的 message 漏到页面（与文件头声明一致）。
        const code = coded ? (error as CodedError).code : 'internal';
        return bad(rpcId, code, coded && error instanceof Error ? error.message : '面板操作失败');
      }
    };

    const route: PanelRoute = {
      path: `/api/${RPC_PATH}`,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request: Request): Promise<Response> {
        const handler = state.handler;
        if (!handler) return new Response('插件未运行', { status: 503 });
        return handler(request);
      },
    };

    const release = (): void => {
      // handler 已被后到的实例接手：路由与 off 都不归我管，摘了就404。
      if (state.handler !== handleRequest) return;
      state.handler = null;
      const off = state.off;
      state.off = null;
      if (typeof off === 'function') off();
    };

    const takeOver = (): void => {
      state.handler = handleRequest;
      try {
        const off: unknown = face.register(route);
        state.off = typeof off === 'function' ? (off as () => void) : null;
      } catch (error) {
        if (state.off) {
          // 进程内已有本插件的同路径委托路由（热重载重叠期）：它委托给
          // state.handler，这里只接管 handler，不再注册。
          logger.warn?.('面板 RPC 同路径已注册，已接管现有路由', errorDetail(error));
        } else {
          logger.error?.('面板 RPC 注册失败', errorDetail(error));
        }
      }
    };

    try {
      // 有 effect 就走生命周期：回调必须交回清理函数，否则卸载/重装时摘不掉旧路由。
      if (typeof scope.effect === 'function') {
        scope.effect(() => {
          takeOver();
          return release;
        }, 'dsh-im-wechat: 面板 RPC');
      } else {
        takeOver();
      }
    } catch (error) {
      logger.error?.('面板 RPC 注册失败', errorDetail(error));
    }
  };

  injectOptional(ctx, 'connection', install);
}
