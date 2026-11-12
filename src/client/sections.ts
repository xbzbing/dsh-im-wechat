/**
 * 面板的分段视图：连接、消息与提醒、独立模式、运行状态、错误横幅。
 *
 * 从 `panel.ts` 拆出（单文件约 500 行的约定）：这里只负责渲染，状态与动作回调
 * 由 `panel.ts` 组合时显式传入。文案一律先取中文原文再过 `t()`，宿主给的动态
 * 文本（健康原因、错误消息）也包一层——查不到键会回落原文，不会显示键名。
 */

import { ENDPOINTS } from './constants.ts';
import { describeHealth, describeLoginPhase, formatTime, validateMinutes, workspaceOptions } from './logic.ts';
import { h } from './platform.ts';
import { Button, IconCopy, IconLink, Input, MenuPicker, StateDot, Switch } from './ui.ts';

type T = (text: string) => string;
type RpcCall = (endpoint: string, payload?: any) => Promise<any>;
type Run = (name: string, action: () => Promise<any>) => Promise<void>;

/** 健康状态 → StateDot 的取值。 */
export function healthDot(state: string): 'done' | 'warning' | 'error' | 'idle' {
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

/** 连接区：账号事实、登录/登出动作与扫码卡片。 */
export function ConnectionSection(props: {
  t: T;
  rpcCall: RpcCall;
  run: Run;
  status: any;
  state: string;
  loggedIn: boolean;
  health: any;
  showLoginPanel: boolean;
  active: boolean;
  login: any;
  qrData: string | null;
  qrLink: string | null;
  copied: boolean;
  code: string;
  busy: string;
  copyLink: () => Promise<void>;
  setCode: (value: string) => void;
}) {
  const { t, rpcCall, run, status, state, loggedIn, health, showLoginPanel, active, login } = props;
  const { qrData, qrLink, copied, code, busy, copyLink, setCode } = props;
  const bridgeLabel = status?.bridge?.registered ? t('已接入超级助理') : t('未接入超级助理');

  return h('section', { className: 'wx-panel wx-connection-panel' },
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
            h('strong', null, loggedIn ? t(describeHealth(health)) : t('尚未登录微信')),
            h('span', null, loggedIn ? bridgeLabel : t('扫码登录后开始接收和发送消息。')))),
        h('div', { className: 'wx-facts' },
          h(Fact, { label: t('账号'), value: status?.accountTail ?? t('未登录') }),
          h(Fact, { label: t('登录时间'), value: status?.loggedInAt ? formatTime(status.loggedInAt) : '—' }),
          h(Fact, { label: t('提醒来源'), value: status?.ownFeatures ? t('由本插件发送') : t('由超级助理发送') })),
        !showLoginPanel
          ? h('div', { className: 'wx-actions' },
            // 登录与重新扫码是同一个动作，只差 variant 与文案。
            h(Button, {
              variant: loggedIn ? 'outline' : 'primary',
              size: 'md',
              disabled: busy !== '',
              onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
            }, busy === 'login' ? t('加载中…') : loggedIn ? t('重新扫码') : t('扫码登录')),
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
              h('strong', null, t(describeLoginPhase(login.phase)) || t('等待扫码')),
              h('span', null, t('用手机微信扫描二维码')))),
          h('div', { className: 'wx-qr-content' },
            qrData
              ? h('img', { className: 'wx-qr-img', src: qrData, alt: t('二维码') })
              : h('div', { className: 'wx-qr-placeholder' }, t('二维码加载中…')),
            h('div', { className: 'wx-qr-side' },
              login.phase === 'failed' && login.error
                ? h('p', { className: 'wx-error' }, t(String(login.error)))
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
        : null));
}

/** 消息与提醒区：两个接入开关与长任务阈值。 */
export function ReminderSection(props: {
  t: T;
  rpcCall: RpcCall;
  run: Run;
  saveMinutes: () => Promise<void>;
  onMinutesChange: (value: string) => void;
  enabled: boolean;
  superagent: boolean;
  minutes: string;
  minutesDirty: boolean;
  threshold: unknown;
  hostOlder: boolean;
  busy: string;
}) {
  const { t, rpcCall, run, saveMinutes, onMinutesChange } = props;
  const { enabled, superagent, minutes, minutesDirty, threshold, hostOlder, busy } = props;
  const check = validateMinutes(minutes);
  const canSaveMinutes = check.ok && check.value !== (typeof threshold === 'number' ? threshold : -1);

  return h('section', { className: 'wx-panel' },
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
            onChange: (event: any) => onMinutesChange(String(event.target.value)),
          }),
          h('span', { className: 'wx-unit' }, t('分钟')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy !== '' || !canSaveMinutes || hostOlder,
            onClick: () => void saveMinutes(),
          }, t('保存')))),
      // 校验不过就地说明：宿主会把值夹回 1..1440，与其保存后被回读顶掉，不如先讲清楚。
      !check.ok && minutes.trim() !== ''
        ? h('p', { className: 'wx-error' }, t(check.message))
        : null,
      minutesDirty
        ? h('p', { className: 'wx-draft-hint' },
          `${t('当前阈值')}：${typeof threshold === 'number' ? threshold : '—'} ${t('分钟')}`)
        : null));
}

/** 独立模式区：插话、工作区与绑定（ADR-0009）。 */
export function DirectSection(props: {
  t: T;
  saveDirect: (patch: { workspaceId?: string; busyMode?: 'queue' | 'steer'; reset?: boolean }) => Promise<void>;
  onWorkspaceChange: (value: string) => void;
  onToggleExpand: () => void;
  superagent: boolean;
  directExpanded: boolean;
  direct: any;
  workspaceId: string;
  workspaces: { id: string; title: string; path: string }[];
  workspacesReady: boolean;
  hostOlder: boolean;
  busy: string;
}) {
  const { t, saveDirect, onWorkspaceChange, onToggleExpand } = props;
  const { superagent, directExpanded, direct, workspaceId, workspaces, workspacesReady, hostOlder, busy } = props;
  const directBusy = direct?.busyMode === 'steer';
  // 同形的禁用条件只算一次：四份拷贝已经漂移过（重置绑定曾少了 available 判断）。
  const directLocked = superagent || busy !== '' || hostOlder || direct?.available === false;
  const boundWorkspace = direct?.bound && direct.workspaceId
    ? workspaces.find((workspace) => workspace.id === direct.workspaceId)
    : undefined;

  return h('section', { className: `wx-panel${superagent ? ' wx-panel-muted' : ''}` },
    h('div', { className: 'wx-section-head wx-head-collapsible' },
      h('div', null,
        h('p', { className: 'wx-eyebrow' }, t('独立模式')),
        h('h4', { className: 'wx-section-title' }, t('直连会话'))),
      h('div', { className: 'wx-section-side' },
        h('span', { className: 'wx-section-note' },
          superagent ? t('由超级助理接管') : t('由本插件直接处理')),
        h('button', {
          type: 'button',
          className: 'wx-collapse',
          'aria-expanded': directExpanded,
          'aria-controls': 'wx-direct-body',
          onClick: onToggleExpand,
        },
        h('span', { className: `wx-chevron${directExpanded ? ' wx-chevron-open' : ''}`, 'aria-hidden': 'true' }),
        directExpanded ? t('收起') : t('展开')))),
    directExpanded
      ? h('div', { id: 'wx-direct-body' },
        h('p', { className: 'wx-draft-hint' },
          superagent
            ? t('接入超级助理后，会话与模型由核心决定；关闭上方开关即可启用独立模式。')
            : t('未接入超级助理时，本插件直接与会话交互：首次消息按所选工作区新建会话，文字与图片交给会话，回答发回微信。')),
        h('div', { className: 'wx-settings-list' },
          h(SwitchRow, {
            title: t('回合内插话'),
            description: t('关闭时新消息排队等待当前回合结束；打开后插入正在运行的回合。'),
            checked: directBusy,
            disabled: directLocked,
            onChange: (next: boolean) => void saveDirect({ busyMode: next ? 'steer' : 'queue' }),
          }),
          h('div', { className: 'wx-field-block' },
            h('div', { className: 'wx-setting-copy' },
              h('span', { className: 'wx-setting-title' }, t('工作区')),
              h('span', { className: 'wx-setting-description' },
                t('首次消息在该工作区新建会话并持续复用；默认使用自动创建的「微信会话」。'))),
            h('div', { className: 'wx-threshold-control' },
              h(MenuPicker, {
                label: t('工作区'),
                value: workspaceId,
                items: workspaceOptions(workspaces, workspaceId, t('默认（微信会话）')),
                placeholder: t('未选择'),
                disabled: directLocked || !workspacesReady,
                onChange: (next: string) => onWorkspaceChange(next),
              }),
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: directLocked,
                onClick: () => void saveDirect({ workspaceId }),
              }, t('保存')))),
          direct?.bound
            ? h('div', { className: 'wx-setting-row' },
              h('div', { className: 'wx-setting-copy' },
                h('span', { className: 'wx-setting-title' }, t('当前会话')),
                h('span', { className: 'wx-setting-description' },
                  `${String(direct.sessionId ?? '').slice(0, 18)}…${direct.running ? ` · ${t('运行中')}` : ''}${
                    boundWorkspace ? ` · ${boundWorkspace.title}` : ''}`)),
              h(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: directLocked,
                onClick: () => void saveDirect({ reset: true }),
              }, t('重置绑定')))
            : h('p', { className: 'wx-draft-hint' },
              t('尚未绑定会话，下一条消息将按所选工作区新建。'))),
        direct?.available === false
          ? h('p', { className: 'wx-draft-hint' }, t('宿主未提供会话服务，独立模式不可用。'))
          : null)
      : null);
}

/** 运行概览区。 */
export function RuntimeSection(props: { t: T; status: any }) {
  const { t, status } = props;
  return h('section', { className: 'wx-panel wx-runtime-panel' },
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
      : null);
}

/**
 * 错误横幅：动作报错、状态轮询报错、宿主最近错误三路合并展示。
 *
 * 三路分开展示是因为来源与处置不同：动作报错等下次动作清、轮询报错等下次
 * 轮询成功清、宿主错误由宿主自己滚动覆盖。
 */
export function ErrorSection(props: { t: T; actionError: string; pollError: string; lastError: any }) {
  const { t, actionError, pollError, lastError } = props;
  if (!actionError && !pollError && !lastError?.message) return null;
  return h('section', { className: 'wx-panel wx-error-panel' },
    h('div', { className: 'wx-section-head' },
      h('div', null,
        h('p', { className: 'wx-eyebrow' }, t('最近错误')),
        h('h4', { className: 'wx-section-title' }, t('需要注意')))),
    lastError?.message
      ? h('p', { className: 'wx-error' }, `${formatTime(lastError.at)} ${t(String(lastError.message))}`)
      : null,
    actionError ? h('p', { className: 'wx-error' }, actionError) : null,
    pollError ? h('p', { className: 'wx-error' }, pollError) : null);
}
