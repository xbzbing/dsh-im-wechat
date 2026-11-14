/**
 * 微信的设置面板。
 *
 * 一切状态都来自 host（面板不推断）：登录由 host 半驱动、面板只轮询快照；开关是显式
 * 动作，做完再拉一次状态。二维码在浏览器里现画（`shared/qr.ts`），画不出来就退回
 * 显示链接——登录流程不依赖画码是否成功（ADR-0002）。
 *
 * 这里只保留状态、动作与组合；分段视图在 `sections.ts`。两条错误通道互不覆盖：
 * `actionError` 属于动作（只在动作入口清），`pollError` 属于状态轮询（成功只清自己），
 * 否则在途轮询会把刚失败动作的报错冲掉。
 */

import { ENDPOINTS, LOGIN_POLL_INTERVAL_MS, REFRESH_INTERVAL_MS, REQUIRED_CONTRACT } from './constants.ts';
import {
  errorText,
  isHostOlder,
  isLoginActive,
  isHttpsUrl,
  qrImageUrl,
  validateMinutes,
  validateQuestionDelay,
} from './logic.ts';
import type { Translate } from './locales.ts';
import { h, useCallback, useEffect, useMemo, useRef, useState } from './platform.ts';
import {
  ConnectionSection,
  DirectSection,
  ErrorSection,
  ReminderSection,
  RuntimeSection,
  healthDot,
} from './sections.ts';
import { ensureStyles } from './styles.ts';
import { Button, IconRefresh, StateDot, copyText } from './ui.ts';
import iconUrl from '../../assets/icon.svg';

export function WeixinSettingsPanel(props: any) {
  const t = props.t as Translate;
  const rpcCall = props.rpcCall as <T = any>(endpoint: string, payload?: any) => Promise<T>;
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  /** 动作失败的报错：只在动作入口清，不被在途的状态轮询冲掉。 */
  const [actionError, setActionError] = useState('');
  /** 状态轮询自己的报错：refresh 成功只清这一路。 */
  const [pollError, setPollError] = useState('');
  const [busy, setBusy] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  /** 阈值输入框的草稿；`dirty` 时不被状态刷新覆盖，免得正在输入的值被轮询冲掉。 */
  const [minutes, setMinutes] = useState('');
  const [minutesDirty, setMinutesDirty] = useState(false);
  /** 提醒等待时间输入框的草稿；dirty 时不被轮询覆盖。 */
  const [questionDelay, setQuestionDelay] = useState('');
  const [questionDelayDirty, setQuestionDelayDirty] = useState(false);
  /** 独立模式的工作区草稿；`dirty` 时不被轮询快照覆盖。 */
  const [workspaceId, setWorkspaceId] = useState('');
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  /** 独立模式卡片的展开状态；接入超级助理时默认收起，用户点开后不再被轮询合上。 */
  const [directOpen, setDirectOpen] = useState<boolean | null>(null);
  /** 宿主给的工作区候选（官方目录）：面板只让选，不让手写路径。 */
  const [workspaces, setWorkspaces] = useState<{ id: string; title: string; path: string }[]>([]);
  const [workspacesReady, setWorkspacesReady] = useState(false);
  /** 状态请求的单调序号：Host 慢时旧响应可能后到，绝不能覆盖新快照。 */
  const requestSeq = useRef(0);
  /** 单飞：慢宿主下轮询不叠加在途请求；在途期间的请求排队补一次。 */
  const inflight = useRef(false);
  const refreshQueued = useRef(false);

  useEffect(() => {
    ensureStyles();
  }, []);

  const refresh = useCallback(async () => {
    if (inflight.current) {
      refreshQueued.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        refreshQueued.current = false;
        const seq = requestSeq.current + 1;
        requestSeq.current = seq;
        try {
          const next = await rpcCall(ENDPOINTS.status);
          // 只接受最新一次请求的结果：登录确认态被旧的 waiting 快照覆盖会来回跳。
          if (seq === requestSeq.current) {
            setStatus(next);
            setPollError('');
          }
        } catch (error) {
          if (seq === requestSeq.current) setPollError(errorText(t, error));
        } finally {
          if (seq === requestSeq.current) setLoading(false);
        }
      } while (refreshQueued.current);
    } finally {
      inflight.current = false;
    }
  }, [rpcCall, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const threshold = status?.longTaskThresholdMinutes;
  const questionDelayValue = status?.questionDelayMinutes;
  const questionReminders = status?.questionReminders !== false;
  /** Host 比面板旧（契约对不上）：新端点还没实现，阈值控件要禁用。 */
  const hostOlder = isHostOlder(status, REQUIRED_CONTRACT);
  useEffect(() => {
    if (minutesDirty || typeof threshold !== 'number') return;
    setMinutes(String(threshold));
  }, [threshold, minutesDirty]);
  useEffect(() => {
    if (questionDelayDirty || typeof questionDelayValue !== 'number') return;
    setQuestionDelay(String(questionDelayValue));
  }, [questionDelayValue, questionDelayDirty]);

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
    } catch (error) {
      setActionError(errorText(t, error));
    } finally {
      // 失败也回读宿主真值：报错与最新状态同时可见（refresh 不碰 actionError）。
      await refresh();
      setBusy('');
    }
  }, [refresh, t]);

  /** 面板动作模板：busy/错误/回读快照都一致，差异只在请求与成功后的草稿清理。 */
  const applyAction = useCallback(async (name: string, call: () => Promise<any>, after?: (next: any) => void) => {
    setBusy(name);
    setActionError('');
    try {
      const next = await call();
      requestSeq.current += 1;
      setStatus(next);
      after?.(next);
    } catch (error) {
      setActionError(errorText(t, error));
      await refresh();
    } finally {
      setBusy('');
    }
  }, [refresh, t]);

  const login = status?.login ?? { phase: 'idle', refreshed: 0 };
  const qrData = useMemo(
    () => qrImageUrl(typeof login.qrContent === 'string' ? login.qrContent : ''),
    [login.qrContent],
  );
  // 服务端给的二维码内容只在 https 时才渲染成可点链接（防 javascript: 注入）。
  const qrLink = isHttpsUrl(login.qrContent) ? String(login.qrContent) : null;

  const copyLink = useCallback(async () => {
    setActionError('');
    try {
      if (await copyText(String(login.qrContent ?? ''))) {
        setCopied(true);
        return;
      }
      setActionError(t('error.operationFailed'));
    } catch {
      setActionError(t('error.operationFailed'));
    }
  }, [login.qrContent, t]);

  // 复制提示的定时器随组件卸载清理，切走设置页后不再触发 setState。
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  /** 保存阈值：校验不过就地报错，不回 Host 白跑一趟。 */
  const saveMinutes = useCallback(async () => {
    const check = validateMinutes(minutes);
    if (!check.ok) {
      setActionError(t(check.key, check.params));
      return;
    }
    // 直接用 Host 返回的快照回显：等下一轮轮询再来，输入框会先跳回旧值。
    await applyAction('longtask', () => rpcCall(ENDPOINTS.setLongTask, { minutes: check.value }), () => setMinutesDirty(false));
  }, [minutes, rpcCall, applyAction]);

  /** 保存提醒等待时间：0 表示立即提醒。 */
  const saveQuestionDelay = useCallback(async () => {
    const check = validateQuestionDelay(questionDelay);
    if (!check.ok) {
      setActionError(t(check.key, check.params));
      return;
    }
    await applyAction('question', () => rpcCall(ENDPOINTS.setQuestion, { delayMinutes: check.value }), () => setQuestionDelayDirty(false));
  }, [questionDelay, rpcCall, applyAction]);

  /** 问题与审批提醒开关：立即生效。 */
  const toggleQuestionReminders = useCallback(async (enabled: boolean) => {
    await applyAction('question', () => rpcCall(ENDPOINTS.setQuestion, { enabled }));
  }, [rpcCall, applyAction]);

  /** 独立模式：保存工作区或提交方式，或重置绑定（ADR-0009）。 */
  const saveDirect = useCallback(async (patch: { workspaceId?: string; busyMode?: 'queue' | 'steer'; reset?: boolean }) => {
    await applyAction('direct', () => rpcCall(ENDPOINTS.setDirect, patch), () => {
      if (patch.workspaceId !== undefined) setWorkspaceDirty(false);
    });
  }, [rpcCall, applyAction]);

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
  const directWorkspaceId = String(direct?.workspaceId ?? '');
  useEffect(() => {
    if (workspaceDirty || direct === null) return;
    setWorkspaceId(directWorkspaceId);
  }, [directWorkspaceId, direct, workspaceDirty]);

  if (loading && !status) {
    return h('div', { className: 'wx-root wx-loading', 'data-plugin': 'dsh-im-wechat' },
      h('div', { className: 'wx-loading-bar', 'aria-busy': 'true' }),
      h('p', { className: 'wx-hint' }, t('common.loading')));
  }

  // 首次加载失败：不拿默认值冒充已知状态，整页只留报错与重试（刷新按钮在头部）。
  const statusUnavailable = status === null;
  const loggedIn = status?.loggedIn === true;
  const enabled = status?.enabled !== false;
  const superagent = status?.superagent !== false;
  // 接入超级助理时默认收起独立模式；用户手动展开后不再被状态刷新合上。
  const directExpanded = directOpen ?? !superagent;
  const health = status?.health ?? {};
  const active = isLoginActive(login.phase);
  const showLoginPanel = active || login.phase === 'failed' || login.phase === 'binded';
  const stateLabel = statusUnavailable
    ? t('status.unavailable')
    : !enabled ? t('status.disabled') : loggedIn ? t('status.signedIn') : t('status.signedOut');
  const state = statusUnavailable
    ? 'idle'
    : !enabled ? 'idle' : loggedIn ? healthDot(String(health.state ?? 'ok')) : 'warning';

  const header = h('header', { className: 'wx-hero' },
    h('div', { className: 'wx-brand' },
      h('img', { className: 'wx-mark', src: iconUrl, alt: '', 'aria-hidden': 'true' }),
      h('div', { className: 'wx-brand-copy' },
        h('h3', { className: 'wx-title' }, t('panel.title')),
        h('p', { className: 'wx-subtitle' }, t('panel.subtitle')))),
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
      }, t('panel.refresh'))));

  const banner = hostOlder
    ? h('div', { className: 'wx-banner wx-banner-warning', role: 'status' },
      h(StateDot, { state: 'warning' }),
      h('span', null, t('banner.hostOlder')))
    : null;
  const errorSection = h(ErrorSection, {
    t,
    actionError,
    pollError,
    lastError: statusUnavailable ? null : status?.lastError ?? null,
  });

  if (statusUnavailable) {
    return h('div', { className: 'wx-root', 'data-plugin': 'dsh-im-wechat' },
      header, banner, errorSection);
  }

  return h('div', { className: 'wx-root', 'data-plugin': 'dsh-im-wechat' },
    header,
    banner,
    h(ConnectionSection, {
      t, rpcCall, run, status, state, loggedIn, health, showLoginPanel, active,
      login, qrData, qrLink, copied, code, busy, copyLink, setCode,
    }),
    h(ReminderSection, {
      t, rpcCall, run, saveMinutes, onMinutesChange: (value: string) => {
        setMinutesDirty(true);
        setMinutes(value);
      },
      enabled, superagent, minutes, minutesDirty, threshold, hostOlder, busy,
      questionReminders, questionDelay, questionDelayDirty, questionDelayValue,
      onQuestionDelayChange: (value: string) => {
        setQuestionDelayDirty(true);
        setQuestionDelay(value);
      },
      saveQuestionDelay,
      toggleQuestionReminders,
    }),
    h(DirectSection, {
      t, saveDirect, onWorkspaceChange: (value: string) => {
        setWorkspaceDirty(true);
        setWorkspaceId(value);
      },
      onToggleExpand: () => setDirectOpen(!directExpanded),
      superagent, directExpanded, direct, workspaceId, workspaces, workspacesReady, hostOlder, busy,
    }),
    h(RuntimeSection, { t, status }),
    errorSection,
  );
}
