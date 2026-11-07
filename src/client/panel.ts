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
import { Button, IconCopy, IconLink, IconRefresh, Input, Pill, StateDot, Switch, copyText } from './ui.ts';

/** 健康状态 → StateDot 的取值。 */
function healthDot(state: string): 'done' | 'warning' | 'error' | 'idle' {
  if (state === 'ok') return 'done';
  if (state === 'degraded') return 'warning';
  if (state === 'down') return 'error';
  return 'idle';
}

function Row({ label, value }: any) {
  if (!value) return null;
  return h('div', { className: 'wx-item' },
    h('span', { className: 'wx-item-label' }, label),
    h('span', { className: 'wx-item-desc' }, value));
}

/** 带说明的开关行：标题 + 说明在左，开关在右。 */
function SwitchRow({ title, description, checked, disabled, onChange }: any) {
  return h('div', { className: 'wx-row-between' },
    h('div', { className: 'wx-item' },
      h('span', { className: 'wx-item-label' }, title),
      description ? h('span', { className: 'wx-item-desc' }, description) : null),
    h(Switch, {
      checked,
      disabled,
      label: title,
      onChange: (next: boolean) => onChange(next),
    }));
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

  if (loading && !status) {
    return h('div', { className: 'wx-root', 'data-plugin': 'dsh-im-wechat' },
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

  return h('div', { className: 'wx-root', 'data-plugin': 'dsh-im-wechat' },

    // ---------------------------------------------------------------- 顶栏
    h('div', { className: 'wx-head' },
      h('h3', { className: 'wx-title' }, t('微信')),
      h('span', { className: 'wx-version' }, `${t('插件版本')} ${status?.version ?? ''}`),
      h('span', { className: 'wx-status' },
        h(StateDot, { state: !enabled ? 'idle' : loggedIn ? healthDot(String(health.state ?? 'ok')) : 'warning' }),
        !enabled ? t('已停用') : loggedIn ? t('已登录') : t('未登录')),
      h('div', { className: 'wx-spacer' }),
      hostOlder ? h(Pill, null, t('请重启 dsh web：面板比 Host 新')) : null,
      h(Button, {
        variant: 'ghost',
        size: 'sm',
        icon: h(IconRefresh, null),
        disabled: busy !== '',
        onClick: () => void refresh(),
      }, t('刷新'))),

    h('p', { className: 'wx-hint' },
      t('把微信接入本机 Harness：扫码登录后，核心的交付会送到你的微信，你在微信里说的话也会回到核心。')),

    // ---------------------------------------------------------------- 连接
    h('section', { className: 'wx-section' },
      h('h4', { className: 'wx-section-title' }, t('连接')),
      h('dl', { className: 'wx-kv' },
        status?.accountTail ? h('dt', null, t('账号')) : null,
        status?.accountTail ? h('dd', null, status.accountTail) : null,
        status?.loggedInAt ? h('dt', null, t('登录时间')) : null,
        status?.loggedInAt ? h('dd', null, formatTime(status.loggedInAt)) : null,
        h('dt', null, t('状态')),
        h('dd', null, loggedIn ? describeHealth(health) : t('未登录')),
        h('dt', null, t('已接入超级助理')),
        h('dd', null, status?.bridge?.registered ? t('已接入超级助理') : t('未接入超级助理'))),

      // 扫码进行中
      showLoginPanel
        ? h('div', { className: 'wx-qr' },
          qrData
            ? h('img', { className: 'wx-qr-img', src: qrData, alt: t('二维码') })
            : null,
          h('div', { className: 'wx-qr-side' },
            h('span', { className: 'wx-item-label' }, describeLoginPhase(login.phase) || t('等待扫码')),
            qrData ? null : h('p', { className: 'wx-hint' }, t('无法显示二维码时，可复制下面的链接在手机微信中打开：')),
            login.phase === 'failed' && login.error
              ? h('p', { className: 'wx-error' }, String(login.error))
              : null,
            login.qrContent ? h('code', { className: 'wx-link' }, String(login.qrContent)) : null,
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
            h('div', { className: 'wx-row' },
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
                }, t('重新开始')))))
        : null,

      // 未登录 / 已登录的操作
      !showLoginPanel
        ? h('div', { className: 'wx-row' },
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
            : null,
          loggedIn ? h('span', { className: 'wx-hint' }, t('登出后需要重新扫码才能继续接收微信消息。')) : null)
        : null),

    h('div', { className: 'wx-divider' }),

    // ---------------------------------------------------------------- 开关
    h('section', { className: 'wx-section' },
      h('h4', { className: 'wx-section-title' }, t('接入方式')),
      h(SwitchRow, {
        title: t('接入微信（收消息）'),
        description: t('停用后不再收取微信消息，核心的交付也不会发到这个渠道。'),
        checked: enabled,
        disabled: busy !== '',
        onChange: (next: boolean) => void run('enabled', () => rpcCall(ENDPOINTS.setEnabled, { enabled: next })),
      }),
      h(SwitchRow, {
        title: t('接入我的超级助理'),
        description: t('关掉后本插件不向超级助理注册，改由插件自己把问题与长任务提醒发到微信。'),
        checked: superagent,
        disabled: busy !== '',
        onChange: (next: boolean) => void run('superagent', () => rpcCall(ENDPOINTS.setSuperagent, { enabled: next })),
      })),

    // ---------------------------------------------------------------- 长任务提醒
    h('section', { className: 'wx-section' },
      h('h4', { className: 'wx-section-title' }, t('长任务提醒')),
      h('div', { className: 'wx-row-between' },
        h('div', { className: 'wx-item' },
          h('span', { className: 'wx-item-label' }, t('提醒阈值（分钟）')),
          h('span', { className: 'wx-item-desc' },
            t('根会话的一个回合超过这个时长才发提醒；只在本插件发送提醒时生效。'))),
        h('div', { className: 'wx-row' },
          h(Input, {
            className: 'wx-minutes',
            value: minutes,
            placeholder: '30',
            'aria-label': t('提醒阈值（分钟）'),
            // 保存中禁用：回包会按 Host 的值回显，这期间敲的字会被冲掉。
            disabled: busy !== '' || hostOlder,
            onChange: (event: any) => {
              setMinutesDirty(true);
              setMinutes(String(event.target.value));
            },
          }),
          h('span', { className: 'wx-item-desc' }, t('分钟')),
          h(Button, {
            variant: 'ghost',
            size: 'sm',
            disabled: busy !== '' || !canSaveMinutes || hostOlder,
            onClick: () => void saveMinutes(),
          }, t('保存')))),
      minutesDirty
        ? h('p', { className: 'wx-hint' },
          `${t('当前阈值')}：${typeof threshold === 'number' ? threshold : '—'} ${t('分钟')}`)
        : null),

    // ---------------------------------------------------------------- 运行状态
    h('section', { className: 'wx-section' },
      h('h4', { className: 'wx-section-title' }, t('运行状态')),
      h(Row, { label: t('等待作答的问题'), value: String(status?.pendingQuestions ?? 0) }),
      h(Row, { label: t('跟踪中的长任务'), value: String(status?.trackingTasks ?? 0) }),
      h(Row, {
        label: t('提醒来源'),
        value: status?.ownFeatures ? t('由本插件发送') : t('由超级助理发送'),
      }),
      status?.ownFeatures && status?.ownerKnown === false
        ? h('p', { className: 'wx-error' }, t('登录态里没有记录扫码的微信用户，提醒无法发出：请重新扫码登录。'))
        : null),

    // ---------------------------------------------------------------- 错误
    h('section', { className: 'wx-section' },
      h('h4', { className: 'wx-section-title' }, t('最近错误')),
      status?.lastError?.message
        ? h('p', { className: 'wx-error' }, `${formatTime(status.lastError.at)} ${String(status.lastError.message)}`)
        : h('p', { className: 'wx-hint' }, t('暂无')),
      actionError ? h('p', { className: 'wx-error' }, actionError) : null),
  );
}
