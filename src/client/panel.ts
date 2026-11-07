/**
 * 微信桥的设置面板：状态、扫码登录、开关与最近错误。
 *
 * 一切状态都来自 host（面板不推断）：登录由 host 半驱动、面板只轮询快照；
 * 开关与登出是显式动作，做完再拉一次状态。二维码在浏览器里现画（`shared/qr.ts`），
 * 画不出来就退回显示链接——登录流程不依赖画码是否成功（ADR-0002）。
 */

import { ENDPOINTS, LOGIN_POLL_INTERVAL_MS, REFRESH_INTERVAL_MS, REQUIRED_CONTRACT } from './constants.ts';
import {
  describeError,
  describeHealth,
  describeLoginPhase,
  formatTime,
  isHostOlder,
  isLoginActive,
  qrImageUrl,
} from './logic.ts';
import { h, useCallback, useEffect, useMemo, useState } from './platform.ts';

const S: Record<string, any> = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' },
  header: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  title: { fontSize: 15, fontWeight: 600, margin: 0 },
  version: { fontSize: 12, opacity: 0.55 },
  muted: { fontSize: 12, opacity: 0.7, lineHeight: 1.6, margin: 0 },
  card: {
    border: '1px solid rgba(127,127,127,0.22)',
    borderRadius: 10,
    padding: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  cardTitle: { fontSize: 13, fontWeight: 600, margin: 0 },
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  label: { fontSize: 12, opacity: 0.65, minWidth: 64 },
  value: { fontSize: 13, wordBreak: 'break-all' as const },
  badge: { fontSize: 11, padding: '2px 8px', borderRadius: 999, border: '1px solid currentColor' },
  button: {
    fontSize: 12,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  primary: {
    fontSize: 12,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'rgba(127,127,127,0.12)',
    color: 'inherit',
    cursor: 'pointer',
  },
  input: {
    fontSize: 12,
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid rgba(127,127,127,0.35)',
    background: 'transparent',
    color: 'inherit',
    width: 160,
  },
  qr: { display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' },
  qrImage: {
    width: 168,
    height: 168,
    borderRadius: 8,
    background: '#fff',
    padding: 6,
    imageRendering: 'pixelated' as const,
  },
  qrSide: { display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 220 },
  link: { fontSize: 11, opacity: 0.7, wordBreak: 'break-all' as const, fontFamily: 'ui-monospace, monospace' },
  error: { fontSize: 12, color: '#d9534f', margin: 0 },
  notice: { fontSize: 12, opacity: 0.75, margin: 0 },
};

function Badge({ label, tone }: any) {
  const color = tone === 'ok' ? '#2e9d5b' : tone === 'warn' ? '#c9821a' : 'rgba(127,127,127,0.8)';
  return h('span', { style: { ...S.badge, color } }, label);
}

function Field({ label, value }: any) {
  if (!value) return null;
  return h('div', { style: S.row },
    h('span', { style: S.label }, label),
    h('span', { style: S.value }, value));
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

  const refresh = useCallback(async () => {
    try {
      setStatus(await rpcCall(ENDPOINTS.status));
      setActionError('');
    } catch (error) {
      setActionError(describeError(error).message);
    } finally {
      setLoading(false);
    }
  }, [rpcCall]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      const next = await action();
      if (next && typeof next === 'object' && 'loggedIn' in next) setStatus(next);
      await refresh();
    } catch (error) {
      setActionError(describeError(error).message);
    } finally {
      setBusy('');
    }
  }, [refresh]);

  const login = status?.login ?? { phase: 'idle', refreshed: 0 };
  const qrData = useMemo(() => qrImageUrl(typeof login.qrContent === 'string' ? login.qrContent : ''), [login.qrContent]);

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(String(login.qrContent ?? ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setActionError(t('操作失败'));
    }
  }, [login.qrContent, t]);

  if (loading && !status) {
    return h('div', { style: S.root, 'data-plugin': 'dsh-im-wechat' },
      h('p', { style: S.muted }, t('加载中…')));
  }

  const loggedIn = status?.loggedIn === true;
  const enabled = status?.enabled !== false;
  const health = status?.health;
  const active = isLoginActive(login.phase);
  const showLogin = active || login.phase === 'failed' || login.phase === 'binded';

  return h('div', { style: S.root, 'data-plugin': 'dsh-im-wechat' },
    h('div', { style: S.header },
      h('h4', { style: S.title }, t('微信桥')),
      h('span', { style: S.version }, `${t('插件版本')} ${status?.version ?? ''}`),
      h(Badge, {
        label: !enabled ? t('已停用') : loggedIn ? t('已登录') : t('未登录'),
        tone: enabled && loggedIn ? 'ok' : 'warn',
      }),
      isHostOlder(status, REQUIRED_CONTRACT)
        ? h(Badge, { label: t('请重启 dsh web：面板比 Host 新'), tone: 'warn' })
        : null),

    h('p', { style: S.muted },
      t('把微信接入本机 Harness：扫码登录后，核心的交付会送到你的微信，你在微信里说的话也会回到核心。')),

    h('div', { style: S.card },
      h('h5', { style: S.cardTitle }, t('状态')),
      h(Field, { label: t('账号'), value: status?.accountTail }),
      h(Field, { label: t('登录时间'), value: formatTime(status?.loggedInAt) }),
      h(Field, { label: t('状态'), value: describeHealth(health) }),
      h(Field, {
        label: t('已接入超级助理'),
        value: status?.bridge?.registered
          ? t('已接入超级助理')
          : t('未接入超级助理（未安装核心插件）'),
      }),
      h('div', { style: S.row },
        h('button', {
          type: 'button',
          style: S.button,
          disabled: busy !== '',
          onClick: () => void refresh(),
        }, t('刷新')))),

    h('div', { style: S.card },
      h('h5', { style: S.cardTitle }, t('扫码登录')),
      !showLogin && !loggedIn
        ? h('div', { style: S.row },
          h('button', {
            type: 'button',
            style: S.primary,
            disabled: busy !== '',
            onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
          }, busy === 'login' ? t('加载中…') : t('扫码登录')))
        : null,

      showLogin
        ? h('div', { style: S.qr },
          qrData
            ? h('img', { style: S.qrImage, src: qrData, alt: t('二维码') })
            : h('p', { style: S.notice }, t('无法显示二维码时，可复制下面的链接在手机微信中打开：')),
          h('div', { style: S.qrSide },
            h('p', { style: S.muted }, describeLoginPhase(login.phase) || t('等待扫码')),
            login.phase === 'failed' && login.error
              ? h('p', { style: S.error }, String(login.error))
              : null,
            login.qrContent
              ? h('div', { style: S.row },
                h('button', { type: 'button', style: S.button, onClick: () => void copyLink() },
                  copied ? t('已复制') : t('复制链接')),
                h('a', {
                  style: { ...S.button, textDecoration: 'none' },
                  href: String(login.qrContent),
                  target: '_blank',
                  rel: 'noreferrer',
                }, t('打开链接')))
              : null,
            login.qrContent ? h('code', { style: S.link }, String(login.qrContent)) : null,
            login.phase === 'need-verify-code'
              ? h('div', { style: S.row },
                h('input', {
                  style: S.input,
                  value: code,
                  placeholder: t('验证码'),
                  onChange: (event: any) => setCode(event.target.value),
                }),
                h('button', {
                  type: 'button',
                  style: S.primary,
                  disabled: busy !== '' || code.trim() === '',
                  onClick: () => void run('code', () => rpcCall(ENDPOINTS.loginCode, { code: code.trim() })),
                }, t('提交验证码')))
              : null,
            h('div', { style: S.row },
              active
                ? h('button', {
                  type: 'button',
                  style: S.button,
                  disabled: busy !== '',
                  onClick: () => void run('cancel', () => rpcCall(ENDPOINTS.loginCancel)),
                }, t('取消'))
                : h('button', {
                  type: 'button',
                  style: S.button,
                  disabled: busy !== '',
                  onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
                }, t('重新开始')))))
        : null,

      loggedIn
        ? h('div', { style: S.row },
          h('button', {
            type: 'button',
            style: S.primary,
            disabled: busy !== '',
            onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
          }, t('重新扫码')),
          h('button', {
            type: 'button',
            style: S.button,
            disabled: busy !== '',
            onClick: () => void run('logout', () => rpcCall(ENDPOINTS.logout)),
          }, t('登出')),
          h('span', { style: S.muted }, t('登出后需要重新扫码才能继续接收微信消息。')))
        : null),

    h('div', { style: S.card },
      h('h5', { style: S.cardTitle }, t('接入微信（收消息）')),
      h('div', { style: S.row },
        h('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: busy !== '',
          onChange: (event: any) => void run('enabled', () =>
            rpcCall(ENDPOINTS.setEnabled, { enabled: event.target.checked })),
        }),
        h('span', { style: S.muted }, t('停用后不再收取微信消息，核心的交付也不会发到这个渠道。')))),

    h('div', { style: S.card },
      h('h5', { style: S.cardTitle }, t('最近错误')),
      status?.lastError?.message
        ? h('p', { style: S.error }, `${formatTime(status.lastError.at)} ${String(status.lastError.message)}`)
        : h('p', { style: S.muted }, t('暂无')),
      actionError ? h('p', { style: S.error }, actionError) : null),
  );
}
