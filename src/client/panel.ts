/**
 * 微信的设置面板。
 *
 * 一切状态都来自 host（面板不推断）：登录由 host 半驱动、面板只轮询快照；开关是显式
 * 动作，做完再拉一次状态。二维码在浏览器里现画（`shared/qr.ts`），画不出来就退回
 * 显示链接——登录流程不依赖画码是否成功（ADR-0002）。
 *
 * 控件优先用官方 UI 原语（`ui.ts`），布局用设计令牌（`styles.ts`），因此深浅色主题
 * 自动跟随。
 */

import { ENDPOINTS, LOGIN_POLL_INTERVAL_MS, REFRESH_INTERVAL_MS, REQUIRED_CONTRACT } from './constants.ts';
import {
  describeError,
  describeHealth,
  describeLoginPhase,
  formatTime,
  isHostOlder,
  isLoginActive,
  isHttpsUrl,
  qrImageUrl,
} from './logic.ts';
import { h, useCallback, useEffect, useMemo, useRef, useState } from './platform.ts';
import { ensureStyles } from './styles.ts';
import { Button, IconCopy, IconLink, IconRefresh, Input, StateDot, Switch, copyText } from './ui.ts';

/** 健康状态 → StateDot 的取值。 */
function healthDot(state: string): 'done' | 'warning' | 'error' | 'idle' {
  if (state === 'ok') return 'done';
  if (state === 'degraded') return 'warning';
  if (state === 'down') return 'error';
  return 'idle';
}

/** 带说明的开关行：标题 + 说明在左，开关在右。 */
function SwitchRow({ title, description, checked, disabled, onChange }: any) {
  return h('div', { className: 'wx-setting-row' },
    h('div', { className: 'wx-setting-copy' },
      h('span', { className: 'wx-setting-title' }, title),
      description ? h('span', { className: 'wx-setting-description' }, description) : null),
    h(Switch, {
      checked,
      disabled,
      label: title,
      onChange: (next: boolean) => onChange(next),
    }));
}


function Fact({ label, value }: { label: string; value: string }) {
  return h('div', { className: 'wx-fact' },
    h('span', null, label),
    h('strong', null, value));
}

function Metric({ value, label, wide }: { value: string; label: string; wide?: boolean }) {
  return h('div', { className: `wx-metric${wide ? ' wx-metric-wide' : ''}` },
    h('strong', null, value),
    h('span', null, label));
}

export function WeixinSettingsPanel(props: any) {
  const t = props.t as (text: string) => string;
  const rpcCall = props.rpcCall as <T = any>(endpoint: string, payload?: any) => Promise<T>;
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  /** 阈值输入框的草稿；`dirty` 时不被状态刷新覆盖，免得正在输入的值被轮询冲掉。 */
  const [minutes, setMinutes] = useState('');
  const [minutesDirty, setMinutesDirty] = useState(false);
  /** 独立模式的工作区草稿；`dirty` 时不被轮询快照覆盖。 */
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  /** 宿主给的工作区候选（官方目录）：面板只让选，不让手写路径。 */
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string; path: string }[]>([]);
  const [workspacesReady, setWorkspacesReady] = useState(false);
  /** 状态请求的单调序号：Host 慢时旧响应可能后到，绝不能覆盖新快照。 */
  const requestSeq = useRef(0);

  useEffect(() => {
    ensureStyles();
  }, []);

  const refresh = useCallback(async () => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    try {
      const next = await rpcCall(ENDPOINTS.status);
      // 只接受最新一次请求的结果：登录确认态被旧的 waiting 快照覆盖会来回跳。
      if (seq !== requestSeq.current) return;
      setStatus(next);
      setActionError('');
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setActionError(describeError(error).message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [rpcCall]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const threshold = status?.longTaskThresholdMinutes;
  /** Host 比面板旧（契约对不上）：新端点还没实现，阈值控件要禁用。 */
  const hostOlder = isHostOlder(status, REQUIRED_CONTRACT);
  useEffect(() => {
    if (minutesDirty || typeof threshold !== 'number') return;
    setMinutes(String(threshold));
  }, [threshold, minutesDirty]);

  const phase = typeof status?.login?.phase === 'string' ? status.login.phase : 'idle';
  useEffect(() => {
    const interval = isLoginActive(phase) ? LOGIN_POLL_INTERVAL_MS : REFRESH_INTERVAL_MS;
    const timer = setInterval(() => {
      void refresh();
    }, interval);
    return () => clearInterval(timer);
  }, [phase, refresh]);

  const run = useCallback(async (name: string, action: () => Promise<any>) => {
    setBusy(name);
    setActionError('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setActionError(describeError(error).message);
    } finally {
      setBusy('');
    }
  }, [refresh]);

  const login = status?.login ?? { phase: 'idle', refreshed: 0 };
  const qrData = useMemo(
    () => qrImageUrl(typeof login.qrContent === 'string' ? login.qrContent : ''),
    [login.qrContent],
  );
  // 服务端给的二维码内容只在 https 时才渲染成可点链接（防 javascript: 注入）。
  const qrLink = isHttpsUrl(login.qrContent) ? String(login.qrContent) : null;

  const copyLink = useCallback(async () => {
    try {
      if (await copyText(String(login.qrContent ?? ''))) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1_500);
        return;
      }
      setActionError(t('操作失败'));
    } catch {
      setActionError(t('操作失败'));
    }
  }, [login.qrContent, t]);

  /** 保存阈值：非数字就地报错，不回 Host 白跑一趟。 */
  const saveMinutes = useCallback(async () => {
    const value = Number(minutes.trim());
    if (!Number.isFinite(value) || value <= 0) {
      setActionError(t('阈值必须是大于 0 的分钟数'));
      return;
    }
    setBusy('longtask');
    setActionError('');
    try {
      const next = await rpcCall(ENDPOINTS.setLongTask, { minutes: value });
      // 直接用 Host 返回的快照回显：等下一轮轮询再来，输入框会先跳回旧值。
      // 顺带作废在途的状态请求，否则它可能把刚保存的值覆盖回去。
      requestSeq.current += 1;
      setStatus(next);
      setMinutesDirty(false);
    } catch (error) {
      setActionError(describeError(error).message);
    } finally {
      setBusy('');
    }
  }, [minutes, rpcCall, t]);

  /** 独立模式：保存工作区或提交方式，或重置绑定（ADR-0009）。 */
  const saveDirect = useCallback(async (patch: { workspaceId?: string; busyMode?: 'queue' | 'steer'; reset?: boolean }) => {
    setBusy('direct');
    setActionError('');
    try {
      const next = await rpcCall(ENDPOINTS.setDirect, patch);
      requestSeq.current += 1;
      setStatus(next);
      if (patch.workspaceId !== undefined) setWorkspaceDirty(false);
    } catch (error) {
      setActionError(describeError(error).message);
    } finally {
      setBusy('');
    }
  }, [rpcCall]);

  useEffect(() => {
    let cancelled = false;
    rpcCall(ENDPOINTS.workspaces)
      .then((value: any) => {
        if (cancelled) return;
        setWorkspaces(Array.isArray(value?.items) ? value.items : []);
        setWorkspacesReady(true);
      })
      .catch(() => {
        if (!cancelled) setWorkspacesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rpcCall]);

  const direct = status?.direct ?? null;
  const directBusy = direct?.busyMode === 'steer';
  const directWorkspaceId = String(direct?.workspaceId ?? '');
  useEffect(() => {
    if (workspaceDirty || direct === null) return;
    setWorkspaceId(directWorkspaceId);
  }, [directWorkspaceId, direct, workspaceDirty]);

  if (loading && !status) {
    return h('div', { className: 'wx-root wx-loading', 'data-plugin': 'dsh-im-wechat' },
      h('div', { className: 'wx-loading-bar', 'aria-busy': 'true' }),
      h('p', { className: 'wx-hint' }, t('加载中…')));
  }

  const loggedIn = status?.loggedIn === true;
  const enabled = status?.enabled !== false;
  const superagent = status?.superagent !== false;
  const health = status?.health ?? {};
  const minutesValue = Number(minutes.trim());
  const canSaveMinutes = minutes.trim() !== ''
    && Number.isFinite(minutesValue)
    && minutesValue > 0
    && minutesValue !== (typeof threshold === 'number' ? threshold : -1);
  const active = isLoginActive(login.phase);
  const showLoginPanel = active || login.phase === 'failed' || login.phase === 'binded';
  const stateLabel = !enabled ? t('已停用') : loggedIn ? t('已登录') : t('未登录');
  const state = !enabled ? 'idle' : loggedIn ? healthDot(String(health.state ?? 'ok')) : 'warning';
  const bridgeLabel = status?.bridge?.registered ? t('已接入超级助理') : t('未接入超级助理');

  return h('div', { className: 'wx-root', 'data-plugin': 'dsh-im-wechat' },

    h('header', { className: 'wx-hero' },
      h('div', { className: 'wx-brand' },
        h('div', { className: 'wx-mark', 'aria-hidden': 'true' },
          h('span', { className: 'wx-mark-bubble wx-mark-bubble-main' }),
          h('span', { className: 'wx-mark-bubble wx-mark-bubble-small' })),
        h('div', { className: 'wx-brand-copy' },
          h('h3', { className: 'wx-title' }, t('微信')),
          h('p', { className: 'wx-subtitle' }, t('把微信接入本机 Harness：扫码登录后，消息与交付会在微信和核心之间同步。')))),
      h('div', { className: 'wx-hero-actions' },
        h('div', { className: 'wx-state-chip', 'data-state': state },
          h(StateDot, { state }),
          h('span', null, stateLabel)),
        h(Button, {
          variant: 'ghost',
          size: 'sm',
          icon: h(IconRefresh, null),
          disabled: busy !== '',
          onClick: () => void refresh(),
        }, t('刷新')))),

    hostOlder
      ? h('div', { className: 'wx-banner wx-banner-warning', role: 'status' },
        h(StateDot, { state: 'warning' }),
        h('span', null, t('请重启 dsh web：面板比 Host 新')))
      : null,

    h('section', { className: 'wx-panel wx-connection-panel' },
      h('div', { className: 'wx-section-head' },
        h('div', null,
          h('p', { className: 'wx-eyebrow' }, t('连接')),
          h('h4', { className: 'wx-section-title' }, loggedIn ? t('微信已连接') : t('连接微信'))),
        h('span', { className: 'wx-version' }, `${t('插件版本')} ${status?.version ?? ''}`)),
      // 没有二维码时不留右列：整张卡拉通，避免右半边空着、左半边挤到截断。
      h('div', { className: `wx-connection-grid${showLoginPanel ? ' wx-connection-split' : ''}` },
        h('div', { className: 'wx-connection-main' },
          h('div', { className: 'wx-connection-status' },
            h(StateDot, { state }),
            h('div', null,
              h('strong', null, loggedIn ? describeHealth(health) : t('尚未登录微信')),
              h('span', null, loggedIn ? bridgeLabel : t('扫码登录后开始接收和发送消息。')))),
          h('div', { className: 'wx-facts' },
            h(Fact, { label: t('账号'), value: status?.accountTail ?? t('未登录') }),
            h(Fact, { label: t('登录时间'), value: status?.loggedInAt ? formatTime(status.loggedInAt) : '—' }),
            h(Fact, { label: t('提醒来源'), value: status?.ownFeatures ? t('由本插件发送') : t('由超级助理发送') })),
          !showLoginPanel
            ? h('div', { className: 'wx-actions' },
              !loggedIn
                ? h(Button, {
                  variant: 'primary',
                  size: 'md',
                  disabled: busy !== '',
                  onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
                }, busy === 'login' ? t('加载中…') : t('扫码登录'))
                : h(Button, {
                  variant: 'outline',
                  size: 'md',
                  disabled: busy !== '',
                  onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
                }, t('重新扫码')),
              loggedIn
                ? h(Button, {
                  variant: 'ghost',
                  size: 'md',
                  disabled: busy !== '',
                  onClick: () => void run('logout', () => rpcCall(ENDPOINTS.logout)),
                }, t('登出'))
                : null)
            : null,
          // 提示独立成行：宽版时拉通整行，不跟按钮挤在右侧格子里。
          !showLoginPanel && loggedIn
            ? h('span', { className: 'wx-action-hint' }, t('登出后需要重新扫码才能继续接收微信消息。'))
            : null),

        showLoginPanel
          ? h('div', { className: 'wx-qr-card' },
            h('div', { className: 'wx-qr-heading' },
              h('span', { className: 'wx-qr-step' }, '01'),
              h('div', null,
                h('strong', null, describeLoginPhase(login.phase) || t('等待扫码')),
                h('span', null, t('用手机微信扫描二维码')))),
            h('div', { className: 'wx-qr-content' },
              qrData
                ? h('img', { className: 'wx-qr-img', src: qrData, alt: t('二维码') })
                : h('div', { className: 'wx-qr-placeholder' }, t('二维码加载中…')),
              h('div', { className: 'wx-qr-side' },
                login.phase === 'failed' && login.error
                  ? h('p', { className: 'wx-error' }, String(login.error))
                  : null,
                login.qrContent
                  ? h('code', { className: 'wx-link' }, String(login.qrContent))
                  : h('p', { className: 'wx-hint' }, t('无法显示二维码时，可复制下面的链接在手机微信中打开：')),
                login.phase === 'need-verify-code'
                  ? h('div', { className: 'wx-code-row' },
                    h(Input, {
                      value: code,
                      placeholder: t('验证码'),
                      'aria-label': t('验证码'),
                      onChange: (event: any) => setCode(event.target.value),
                    }),
                    h(Button, {
                      variant: 'primary',
                      size: 'sm',
                      disabled: busy !== '' || code.trim() === '',
                      onClick: () => void run('code', () => rpcCall(ENDPOINTS.loginCode, { code: code.trim() })),
                    }, t('提交验证码')))
                  : null,
                h('div', { className: 'wx-actions' },
                  login.qrContent
                    ? h(Button, { variant: 'ghost', size: 'sm', icon: h(IconCopy, null), onClick: () => void copyLink() },
                      copied ? t('已复制') : t('复制链接'))
                    : null,
                  qrLink
                    ? h(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      icon: h(IconLink, null),
                      onClick: () => window.open(qrLink, '_blank', 'noreferrer'),
                    }, t('打开链接'))
                    : null,
                  active
                    ? h(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      disabled: busy !== '',
                      onClick: () => void run('cancel', () => rpcCall(ENDPOINTS.loginCancel)),
                    }, t('取消'))
                    : h(Button, {
                      variant: 'ghost',
                      size: 'sm',
                      disabled: busy !== '',
                      onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
                    }, t('重新开始'))))))
          : null)),

    h('section', { className: 'wx-panel' },
      h('div', { className: 'wx-section-head' },
        h('div', null,
          h('p', { className: 'wx-eyebrow' }, t('接入方式')),
          h('h4', { className: 'wx-section-title' }, t('消息与提醒'))),
        h('span', { className: 'wx-section-note' }, t('控制消息从哪里进出'))),
      h('div', { className: 'wx-settings-list' },
        h(SwitchRow, {
          title: t('接入微信（收消息）'),
          description: t('停用后不再收取微信消息，核心的交付也不会发到这个渠道。'),
          checked: enabled,
          disabled: busy !== '',
          onChange: (next: boolean) => void run('enabled', () => rpcCall(ENDPOINTS.setEnabled, { enabled: next })),
        }),
        h(SwitchRow, {
          title: t('接入我的超级助理'),
          description: t('关闭后由微信插件自己发送问题与长任务提醒。'),
          checked: superagent,
          disabled: busy !== '',
          onChange: (next: boolean) => void run('superagent', () => rpcCall(ENDPOINTS.setSuperagent, { enabled: next })),
        }),
        h('div', { className: 'wx-setting-row wx-threshold-row' },
          h('div', { className: 'wx-setting-copy' },
            h('span', { className: 'wx-setting-title' }, t('提醒阈值（分钟）')),
            h('span', { className: 'wx-setting-description' },
              t('根会话的一个回合超过这个时长才发提醒；只在本插件发送提醒时生效。'))),
          h('div', { className: 'wx-threshold-control' },
            h(Input, {
              className: 'wx-minutes',
              value: minutes,
              placeholder: '30',
              'aria-label': t('提醒阈值（分钟）'),
              disabled: busy !== '' || hostOlder,
              onChange: (event: any) => {
                setMinutesDirty(true);
                setMinutes(String(event.target.value));
              },
            }),
            h('span', { className: 'wx-unit' }, t('分钟')),
            h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: busy !== '' || !canSaveMinutes || hostOlder,
              onClick: () => void saveMinutes(),
            }, t('保存')))),
        minutesDirty
          ? h('p', { className: 'wx-draft-hint' },
            `${t('当前阈值')}：${typeof threshold === 'number' ? threshold : '—'} ${t('分钟')}`)
          : null)),

    h('section', { className: `wx-panel${superagent ? ' wx-panel-muted' : ''}` },
      h('div', { className: 'wx-section-head' },
        h('div', null,
          h('p', { className: 'wx-eyebrow' }, t('独立模式')),
          h('h4', { className: 'wx-section-title' }, t('不接核心时的直连会话'))),
        h('span', { className: 'wx-section-note' },
          superagent ? t('已接入超级助理，这组设置暂停') : t('接入超级助理后自动沉默'))),
      superagent
        ? h('p', { className: 'wx-draft-hint' }, t('接入超级助理时由核心决定会话与模型；关掉上面的开关即可使用独立模式。'))
        : null,
      h('div', { className: 'wx-settings-list' },
        h(SwitchRow, {
          title: t('回合中再发消息时插话'),
          description: t('关闭：排队等这一轮结束（默认）；打开：把消息插进正在跑的这一轮，本轮回答仍照常送回。'),
          checked: directBusy,
          disabled: superagent || busy !== '' || hostOlder || direct?.available === false,
          onChange: (next: boolean) => void saveDirect({ busyMode: next ? 'steer' : 'queue' }),
        }),
        h('div', { className: 'wx-setting-row wx-threshold-row wx-row-stack' },
          h('div', { className: 'wx-setting-copy' },
            h('span', { className: 'wx-setting-title' }, t('工作区')),
            h('span', { className: 'wx-setting-description' },
              t('独立模式下第一次发消息时在这里新建会话，之后一直用它；不指定则用宿主的默认位置。'))),
          h('div', { className: 'wx-threshold-control' },
            h('select', {
              className: 'wx-select',
              value: workspaceId,
              'aria-label': t('工作区'),
              disabled: superagent || busy !== '' || hostOlder || direct?.available === false || !workspacesReady,
              onChange: (event: any) => {
                setWorkspaceDirty(true);
                setWorkspaceId(String(event.target.value));
              },
            }, [
              h('option', { value: '' }, t('不指定（宿主默认位置）')),
              ...workspaces.map((workspace) => h('option', { value: workspace.id }, `${workspace.title} — ${workspace.path}`)),
            ]),
            h(Button, {
              variant: 'outline',
              size: 'sm',
              disabled: superagent || busy !== '' || hostOlder || direct?.available === false,
              onClick: () => void saveDirect({ workspaceId }),
            }, t('保存')))),
        direct?.bound
          ? h('div', { className: 'wx-setting-row' },
            h('div', { className: 'wx-setting-copy' },
              h('span', { className: 'wx-setting-title' }, t('当前绑定的会话')),
              h('span', { className: 'wx-setting-description' },
                `${String(direct.sessionId ?? '').slice(0, 18)}…${direct.running ? ` · ${t('正在跑')}` : ''}${
                  direct.workspaceId && workspaces.some((workspace) => workspace.id === direct.workspaceId)
                    ? ` · ${workspaces.find((workspace) => workspace.id === direct.workspaceId)!.title}`
                    : ''}`)),
            h(Button, {
              variant: 'ghost',
              size: 'sm',
              disabled: superagent || busy !== '' || hostOlder,
              onClick: () => void saveDirect({ reset: true }),
            }, t('重置绑定')))
          : h('p', { className: 'wx-draft-hint' },
            t('还没有绑定会话：下一条微信消息会按这里的工作区新建一个。'))),
      direct?.available === false
        ? h('p', { className: 'wx-draft-hint' }, t('宿主没有提供会话服务，独立模式不可用。'))
        : null),

    h('section', { className: 'wx-panel wx-runtime-panel' },
      h('div', { className: 'wx-section-head' },
        h('div', null,
          h('p', { className: 'wx-eyebrow' }, t('运行状态')),
          h('h4', { className: 'wx-section-title' }, t('运行概览')))),
      h('div', { className: 'wx-metrics' },
        h(Metric, { value: String(status?.pendingQuestions ?? 0), label: t('等待作答的问题') }),
        h(Metric, { value: String(status?.trackingTasks ?? 0), label: t('跟踪中的长任务') }),
        h(Metric, { value: status?.ownFeatures ? t('由本插件发送') : t('由超级助理发送'), label: t('提醒来源'), wide: true })),
      status?.ownFeatures && status?.ownerKnown === false
        ? h('div', { className: 'wx-banner wx-banner-warning', role: 'status' },
          h(StateDot, { state: 'warning' }),
          h('span', null, t('登录态里没有记录扫码的微信用户，提醒无法发出：请重新扫码登录。')))
        : null),

    actionError || status?.lastError?.message
      ? h('section', { className: 'wx-panel wx-error-panel' },
        h('div', { className: 'wx-section-head' },
          h('div', null,
            h('p', { className: 'wx-eyebrow' }, t('最近错误')),
            h('h4', { className: 'wx-section-title' }, t('需要注意')))),
        status?.lastError?.message
          ? h('p', { className: 'wx-error' }, `${formatTime(status.lastError.at)} ${String(status.lastError.message)}`)
          : null,
        actionError ? h('p', { className: 'wx-error' }, actionError) : null)
      : null,
  );
}
