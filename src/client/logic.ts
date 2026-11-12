/**
 * 面板的纯逻辑：RPC 调用、状态翻译、二维码渲染。
 *
 * 抽成纯函数是为了让单测直接覆盖：状态到文案的映射、契约版本比较、二维码
 * 生成失败时的降级，都不依赖 React。
 */

import { MAX_LONG_TASK_MINUTES, MIN_LONG_TASK_MINUTES, RPC_PATH, RPC_TIMEOUT_MS } from './constants.ts';
import { encodeQr, qrSvgDataUrl } from '../shared/qr.ts';

export interface CodedError extends Error {
  code?: string;
  details?: unknown;
}

/** 拆宿主的 RPC 响应信封：`{result: {ok, value | error}}`。 */
export function unwrapResult(raw: any): any {
  const result = raw && typeof raw === 'object' && raw.result && typeof raw.result === 'object'
    ? raw.result
    : raw;
  if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
    const error = new Error('宿主返回了无法识别的响应') as CodedError;
    error.code = 'invalid-response';
    throw error;
  }
  if (!result.ok) {
    const error = new Error(
      typeof result.error?.message === 'string' && result.error.message ? result.error.message : '操作失败',
    ) as CodedError;
    error.code = typeof result.error?.code === 'string' ? result.error.code : 'rpc-failed';
    error.details = result.error?.details ?? {};
    throw error;
  }
  return result.value;
}

/** 造面板用的 RPC 调用：宿主 `connection.rpc.call` 的薄封装。 */
export function createRpcCall(connection: any) {
  return async function rpcCall<T = any>(endpoint: string, payload: any = {}, signal?: any): Promise<T> {
    if (!connection?.rpc || typeof connection.rpc.call !== 'function') {
      const error = new Error('当前页面没有可用的 Host 连接') as CodedError;
      error.code = 'connection-unavailable';
      throw error;
    }
    const raw = await connection.rpc.call(
      '/api',
      RPC_PATH,
      { method: endpoint, payload },
      signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS),
    );
    return unwrapResult(raw) as T;
  };
}

export interface DescribedError {
  message: string;
  code: string;
}

export function describeError(error: any): DescribedError {
  const message = typeof error?.message === 'string' && error.message ? error.message : '操作失败';
  const code = typeof error?.code === 'string' ? error.code : '';
  return { message, code };
}

/** 面板比 host 新：契约版本对不上时提示重启，而不是让按钮报「未知端点」。 */
export function isHostOlder(status: any, required: number): boolean {
  if (!status || typeof status !== 'object') return false;
  const contract = typeof status.contract === 'number' ? status.contract : 0;
  return contract < required;
}

/** 健康状态 → 中文原文（再交给 `t()` 翻译）。 */
export function describeHealth(health: any): string {
  if (!health || typeof health !== 'object') return '未登录';
  if (health.state === 'ok') return '连接正常';
  if (health.state === 'degraded') return '连接异常';
  if (health.reason) return String(health.reason);
  return '连接中断';
}

/** 扫码阶段 → 中文原文。 */
export function describeLoginPhase(phase: string): string {
  switch (phase) {
    case 'waiting': return '等待扫码';
    case 'scanned': return '已扫描，请在手机上确认';
    case 'need-verify-code': return '需要在手机上输入验证码';
    case 'confirmed': return '登录成功';
    case 'binded': return '已连接过，无需重复登录';
    case 'failed': return '二维码已过期或流程结束';
    default: return '';
  }
}

export function formatTime(at: unknown): string {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '';
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 二维码内容 → `<img src>` 可用的 data URL。
 *
 * 编码失败（内容超出我们支持的最大版本）返回 null：面板据此退回「显示链接」，
 * 登录流程本身不受影响。
 */
export function qrImageUrl(content: string, scale = 5): string | null {
  if (typeof content !== 'string' || content.trim() === '') return null;
  try {
    return qrSvgDataUrl(encodeQr(content, { ecc: 'M' }), { scale, margin: 4 });
  } catch {
    return null;
  }
}

/**
 * 只有 https 链接才渲染成可点的 `<a href>`。
 *
 * `qrContent` 来自服务端响应，`javascript:` 形式会在面板同源执行脚本；
 * 不合格时面板退回纯文本 + 复制按钮，登录流程不受影响。
 */
export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** 扫码是否还在进行中（决定面板用 2 秒还是 15 秒轮询）。 */
export function isLoginActive(phase: string): boolean {
  return phase === 'waiting' || phase === 'scanned' || phase === 'need-verify-code';
}

/**
 * 长任务阈值的入参校验：1..1440 的整数分钟。
 *
 * 与 host 半的夹取区间一致——非整数会被宿主 round 改写，与其保存后输入框被
 * 回读值顶掉，不如在面板就拒绝并说明。
 */
export function validateMinutes(raw: string): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.trim();
  const value = Number(text);
  if (
    text === ''
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < MIN_LONG_TASK_MINUTES
    || value > MAX_LONG_TASK_MINUTES
  ) {
    return { ok: false, message: `阈值需为 ${MIN_LONG_TASK_MINUTES} 到 ${MAX_LONG_TASK_MINUTES} 的整数分钟` };
  }
  return { ok: true, value };
}

/** 下拉菜单的一行：值、主标题与可选的说明（工作区路径）。 */
export interface WorkspaceOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * 把宿主的工作区快照转成下拉选项。
 *
 * 去重、丢掉没有 id 的项；标题缺失时退回 id（宿主的默认工作区一定有标题，这里只是
 * 兜底）。`value` 为空（默认工作区还没建好）时在最前面补一条兜底项，免得下拉空白。
 */
export function workspaceOptions(
  workspaces: readonly { id?: unknown; title?: unknown; path?: unknown }[],
  value: string,
  fallbackLabel: string,
): WorkspaceOption[] {
  const items: WorkspaceOption[] = [];
  const seen = new Set<string>();
  for (const entry of workspaces) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    const title = typeof entry.title === 'string' && entry.title.trim() !== '' ? entry.title.trim() : id;
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    items.push({ value: id, label: title, ...(path !== '' ? { hint: path } : {}) });
  }
  if (value === '') items.unshift({ value: '', label: fallbackLabel });
  return items;
}

/** 下拉浮层的落点：视口内固定定位的 top/left/width/maxHeight。 */
export interface MenuPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/** 触发器与视口的矩形（只取定位用到的边）。 */
export interface MenuAnchorRect {
  top: number;
  left: number;
  bottom: number;
  width: number;
}

export interface MenuPlacementOptions {
  minWidth: number;
  maxHeight: number;
  gap: number;
  padding: number;
}

/**
 * 算下拉浮层的位置：默认贴在触发器下方，下方空间不够就向上翻，左右夹回视口内。
 *
 * 纯数学，放在这里是为了能直接单测（组件里只负责取 rect 与 setState）。
 */
export function placeMenu(rect: MenuAnchorRect, viewport: { width: number; height: number }, options: MenuPlacementOptions): MenuPlacement {
  const width = Math.max(rect.width, options.minWidth);
  const left = Math.max(options.padding, Math.min(rect.left, viewport.width - width - options.padding));
  const below = viewport.height - rect.bottom - options.gap - options.padding;
  const above = rect.top - options.gap - options.padding;
  // 下方连一半都放不下、上方更宽裕时向上翻（和原生 select 的行为一致）。
  const openUp = below < options.maxHeight / 2 && above > below;
  const space = openUp ? above : below;
  // 上下都不够时先保证不超出视口：视口内可用高度是硬上限。
  const available = Math.max(24, viewport.height - options.padding * 2);
  const maxHeight = Math.round(Math.min(options.maxHeight, available, Math.max(120, space)));
  const top = openUp ? rect.top - maxHeight - options.gap : rect.bottom + options.gap;
  return {
    top: Math.round(Math.max(options.padding, Math.min(top, viewport.height - maxHeight - options.padding))),
    left: Math.round(left),
    width: Math.round(width),
    maxHeight,
  };
}

/** 浮层表面的类名：样式表里的 `.wx-menu` 负责材质、圆角、滚动与层级。 */
export const MENU_SURFACE_CLASS = 'wx-menu';

/** 浮层层级：压过设置页的滚动容器与宿主弹窗遮罩，低于命令面板。 */
export const MENU_Z_INDEX = 1200;

/**
 * 把落点拼成浮层的固定定位样式。
 *
 * `position` 写进内联样式而不是只靠类名：漏挂类名时浮层会退回静态流，看起来
 * 就是「点了没反应」。拿不到落点（首帧、测试环境）时先藏起来。
 */
export function menuSurfaceStyle(placement: MenuPlacement | null): Record<string, number | string> {
  if (!placement) return { position: 'fixed', top: 0, left: 0, visibility: 'hidden' };
  return {
    position: 'fixed',
    zIndex: MENU_Z_INDEX,
    top: placement.top,
    left: placement.left,
    width: placement.width,
    maxHeight: placement.maxHeight,
  };
}
