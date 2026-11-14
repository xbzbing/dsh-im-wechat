/**
 * 面板的分段视图：连接、消息与提醒、独立模式、运行状态、错误横幅。
 *
 * 从 `panel.ts` 拆出（单文件约 500 行的约定）：这里只负责渲染，状态与动作回调
 * 由 `panel.ts` 组合时显式传入。文案一律用本命名空间的键，动态文案（健康原因、
 * 错误消息、校验结果）先落到键或原文，再由 `t()` 或原样输出。
 */

import { ENDPOINTS } from './constants.ts';
import {
  describeLoginPhase,
  formatTime,
  healthText,
  validateMinutes,
  validateQuestionDelay,
  workspaceOptions,
} from './logic.ts';
import { h } from './platform.ts';
import { Button, IconCopy, IconLink, Input, MenuPicker, StateDot, Switch } from './ui.ts';
import type { Translate } from './locales.ts';

type T = Translate;
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
  const bridgeLabel = status?.bridge?.registered ? t('connection.bridgeOn') : t('connection.bridgeOff');

  return h('section', { className: 'wx-panel wx-connection-panel' },
    h('div', { className: 'wx-section-head' },
      h('div', null,
        h('p', { className: 'wx-eyebrow' }, t('connection.eyebrow')),
        h('h4', { className: 'wx-section-title' }, loggedIn ? t('connection.titleConnected') : t('connection.titleConnect'))),
      h('span', { className: 'wx-version' }, `${t('connection.version')} ${status?.version ?? ''}`)),
    // 没有二维码时不留右列：整张卡拉通，避免右半边空着、左半边挤到截断。
    h('div', { className: `wx-connection-grid${showLoginPanel ? ' wx-connection-split' : ''}` },
      h('div', { className: 'wx-connection-main' },
        h('div', { className: 'wx-connection-status' },
          h(StateDot, { state }),
          h('div', null,
            h('strong', null, loggedIn ? healthText(t, health) : t('connection.signedOut')),
            h('span', null, loggedIn ? bridgeLabel : t('connection.signedOutHint')))),
        h('div', { className: 'wx-facts' },
          h(Fact, { label: t('connection.account'), value: status?.accountTail ?? t('status.signedOut') }),
          h(Fact, { label: t('connection.signedInAt'), value: status?.loggedInAt ? formatTime(status.loggedInAt) : '—' }),
          h(Fact, {
            label: t('reminder.source'),
            value: status?.ownFeatures ? t('reminder.sourcePlugin') : t('reminder.sourceCore'),
          })),
        !showLoginPanel
          ? h('div', { className: 'wx-actions' },
            // 登录与重新扫码是同一个动作，只差 variant 与文案。
            h(Button, {
              variant: loggedIn ? 'outline' : 'primary',
              size: 'md',
              disabled: busy !== '',
              onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
            }, busy === 'login' ? t('common.loading') : loggedIn ? t('login.restartScan') : t('login.start')),
            loggedIn
              ? h(Button, {
                variant: 'ghost',
                size: 'md',
                disabled: busy !== '',
                onClick: () => void run('logout', () => rpcCall(ENDPOINTS.logout)),
              }, t('login.signOut'))
              : null)
          : null,
        // 提示独立成行：宽版时拉通整行，不跟按钮挤在右侧格子里。
        !showLoginPanel && loggedIn
          ? h('span', { className: 'wx-action-hint' }, t('login.signOutHint'))
          : null),

      showLoginPanel
        ? h('div', { className: 'wx-qr-card' },
          h('div', { className: 'wx-qr-heading' },
            h('span', { className: 'wx-qr-step' }, '01'),
            h('div', null,
              h('strong', null, t(describeLoginPhase(login.phase) || 'login.phase.waiting')),
              h('span', null, t('login.scanHint')))),
          h('div', { className: 'wx-qr-content' },
            qrData
              ? h('img', { className: 'wx-qr-img', src: qrData, alt: t('login.qrAlt') })
              : h('div', { className: 'wx-qr-placeholder' }, t('login.qrLoading')),
            h('div', { className: 'wx-qr-side' },
              login.phase === 'failed' && login.error
                ? h('p', { className: 'wx-error' }, String(login.error))
                : null,
              login.qrContent
                ? h('code', { className: 'wx-link' }, String(login.qrContent))
                : h('p', { className: 'wx-hint' }, t('login.linkHint')),
              login.phase === 'need-verify-code'
                ? h('div', { className: 'wx-code-row' },
                  h(Input, {
                    value: code,
                    placeholder: t('login.verifyCode'),
                    'aria-label': t('login.verifyCode'),
                    onChange: (event: any) => setCode(event.target.value),
                  }),
                  h(Button, {
                    variant: 'primary',
                    size: 'sm',
                    disabled: busy !== '' || code.trim() === '',
                    onClick: () => void run('code', () => rpcCall(ENDPOINTS.loginCode, { code: code.trim() })),
                  }, t('login.submitCode')))
                : null,
              h('div', { className: 'wx-actions' },
                login.qrContent
                  ? h(Button, { variant: 'ghost', size: 'sm', icon: h(IconCopy, null), onClick: () => void copyLink() },
                    copied ? t('common.copied') : t('login.copyLink'))
                  : null,
                qrLink
                  ? h(Button, {
                    variant: 'ghost',
                    size: 'sm',
                    icon: h(IconLink, null),
                    onClick: () => window.open(qrLink, '_blank', 'noreferrer'),
                  }, t('login.openLink'))
                  : null,
                active
                  ? h(Button, {
                    variant: 'ghost',
                    size: 'sm',
                    disabled: busy !== '',
                    onClick: () => void run('cancel', () => rpcCall(ENDPOINTS.loginCancel)),
                  }, t('common.cancel'))
                  : h(Button, {
                    variant: 'ghost',
                    size: 'sm',
                    disabled: busy !== '',
                    onClick: () => void run('login', () => rpcCall(ENDPOINTS.loginStart)),
                  }, t('login.restart'))))))
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
  questionReminders: boolean;
  questionDelay: string;
  questionDelayDirty: boolean;
  questionDelayValue: unknown;
  onQuestionDelayChange: (value: string) => void;
  saveQuestionDelay: () => Promise<void>;
  toggleQuestionReminders: (enabled: boolean) => Promise<void>;
  hostOlder: boolean;
  busy: string;
}) {
  const { t, rpcCall, run, saveMinutes, onMinutesChange } = props;
  const { enabled, superagent, minutes, minutesDirty, threshold, hostOlder, busy } = props;
  const { questionReminders, questionDelay, questionDelayDirty, questionDelayValue } = props;
  const { onQuestionDelayChange, saveQuestionDelay, toggleQuestionReminders } = props;
  const check = validateMinutes(minutes);
  const canSaveMinutes = check.ok && check.value !== (typeof threshold === 'number' ? threshold : -1);
  const questionCheck = validateQuestionDelay(questionDelay);
  const canSaveQuestionDelay = questionCheck.ok
    && questionCheck.value !== (typeof questionDelayValue === 'number' ? questionDelayValue : -1);

  return h('section', { className: 'wx-panel' },
    h('div', { className: 'wx-section-head' },
      h('div', null,
        h('p', { className: 'wx-eyebrow' }, t('reminder.eyebrow')),
        h('h4', { className: 'wx-section-title' }, t('reminder.title'))),
      h('span', { className: 'wx-section-note' }, t('reminder.note'))),
    h('div', { className: 'wx-settings-list' },
      h(SwitchRow, {
        title: t('reminder.enabledTitle'),
        description: t('reminder.enabledDescription'),
        checked: enabled,
        disabled: busy !== '',
        onChange: (next: boolean) => void run('enabled', () => rpcCall(ENDPOINTS.setEnabled, { enabled: next })),
      }),
      h(SwitchRow, {
        title: t('reminder.superagentTitle'),
        description: t('reminder.superagentDescription'),
        checked: superagent,
        disabled: busy !== '',
        onChange: (next: boolean) => void run('superagent', () => rpcCall(ENDPOINTS.setSuperagent, { enabled: next })),
      }),
      h(SwitchRow, {
        title: t('reminder.questionTitle'),
        description: t('reminder.questionDescription'),
        checked: questionReminders,
        disabled: busy !== '' || hostOlder,
        onChange: (next: boolean) => void toggleQuestionReminders(next),
      }),
      h('div', { className: 'wx-setting-row wx-threshold-row' },
        h('div', { className: 'wx-setting-copy' },
          h('span', { className: 'wx-setting-title' }, t('reminder.questionDelayTitle')),
          h('span', { className: 'wx-setting-description' }, t('reminder.questionDelayDescription'))),
        h('div', { className: 'wx-threshold-control' },
          h(Input, {
            className: 'wx-minutes',
            value: questionDelay,
            placeholder: '5',
            'aria-label': t('reminder.questionDelayTitle'),
            disabled: busy !== '' || hostOlder || !questionReminders,
            onChange: (event: any) => onQuestionDelayChange(String(event.target.value)),
          }),
          h('span', { className: 'wx-unit' }, t('common.minutes')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy !== '' || hostOlder || !questionReminders || !canSaveQuestionDelay,
            onClick: () => void saveQuestionDelay(),
          }, t('common.save')))),
      // 提醒关掉时等待时间不会立刻生效：置灰而不是藏起来，切回来还能看到当前值。
      !questionCheck.ok && questionDelay.trim() !== ''
        ? h('p', { className: 'wx-error' }, t(questionCheck.key, questionCheck.params))
        : null,
      questionDelayDirty
        ? h('p', { className: 'wx-draft-hint' },
          t('reminder.questionDelayValue', {
            value: typeof questionDelayValue === 'number' ? questionDelayValue : '—',
            unit: t('common.minutes'),
          }))
        : null,
      h('div', { className: 'wx-setting-row wx-threshold-row' },
        h('div', { className: 'wx-setting-copy' },
          h('span', { className: 'wx-setting-title' }, t('reminder.thresholdTitle')),
          h('span', { className: 'wx-setting-description' },
            t('reminder.thresholdDescription'))),
        h('div', { className: 'wx-threshold-control' },
          h(Input, {
            className: 'wx-minutes',
            value: minutes,
            placeholder: '30',
            'aria-label': t('reminder.thresholdTitle'),
            disabled: busy !== '' || hostOlder,
            onChange: (event: any) => onMinutesChange(String(event.target.value)),
          }),
          h('span', { className: 'wx-unit' }, t('common.minutes')),
          h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy !== '' || !canSaveMinutes || hostOlder,
            onClick: () => void saveMinutes(),
          }, t('common.save')))),
      // 校验不过就地说明：宿主会把值夹回 1..1440，与其保存后被回读顶掉，不如先讲清楚。
      !check.ok && minutes.trim() !== ''
        ? h('p', { className: 'wx-error' }, t(check.key, check.params))
        : null,
      minutesDirty
        ? h('p', { className: 'wx-draft-hint' },
          t('reminder.thresholdValue', {
            value: typeof threshold === 'number' ? threshold : '—',
            unit: t('common.minutes'),
          }))
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
        h('p', { className: 'wx-eyebrow' }, t('direct.eyebrow')),
        h('h4', { className: 'wx-section-title' }, t('direct.title'))),
      h('div', { className: 'wx-section-side' },
        h('span', { className: 'wx-section-note' },
          superagent ? t('direct.handledByCore') : t('direct.handledByPlugin')),
        h('button', {
          type: 'button',
          className: 'wx-collapse',
          'aria-expanded': directExpanded,
          'aria-controls': 'wx-direct-body',
          onClick: onToggleExpand,
        },
        h('span', { className: `wx-chevron${directExpanded ? ' wx-chevron-open' : ''}`, 'aria-hidden': 'true' }),
        directExpanded ? t('common.collapse') : t('common.expand')))),
    directExpanded
      ? h('div', { id: 'wx-direct-body' },
        h('p', { className: 'wx-draft-hint' },
          superagent
            ? t('direct.bridgeHint')
            : t('direct.standaloneHint')),
        h('div', { className: 'wx-settings-list' },
          h(SwitchRow, {
            title: t('direct.steerTitle'),
            description: t('direct.steerDescription'),
            checked: directBusy,
            disabled: directLocked,
            onChange: (next: boolean) => void saveDirect({ busyMode: next ? 'steer' : 'queue' }),
          }),
          h('div', { className: 'wx-field-block' },
            h('div', { className: 'wx-setting-copy' },
              h('span', { className: 'wx-setting-title' }, t('direct.workspace')),
              h('span', { className: 'wx-setting-description' },
                t('direct.workspaceDescription'))),
            h('div', { className: 'wx-threshold-control' },
              h(MenuPicker, {
                label: t('direct.workspace'),
                value: workspaceId,
                items: workspaceOptions(workspaces, workspaceId, t('direct.defaultWorkspace')),
                placeholder: t('direct.workspaceUnselected'),
                disabled: directLocked || !workspacesReady,
                onChange: (next: string) => onWorkspaceChange(next),
              }),
              h(Button, {
                variant: 'outline',
                size: 'sm',
                disabled: directLocked,
                onClick: () => void saveDirect({ workspaceId }),
              }, t('common.save')))),
          direct?.bound
            ? h('div', { className: 'wx-setting-row' },
              h('div', { className: 'wx-setting-copy' },
                h('span', { className: 'wx-setting-title' }, t('direct.currentSession')),
                h('span', { className: 'wx-setting-description' },
                  `${String(direct.sessionId ?? '').slice(0, 18)}…${direct.running ? ` · ${t('direct.running')}` : ''}${
                    boundWorkspace ? ` · ${boundWorkspace.title}` : ''}`)),
              h(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: directLocked,
                onClick: () => void saveDirect({ reset: true }),
              }, t('direct.resetBinding')))
            : h('p', { className: 'wx-draft-hint' },
              t('direct.noSession'))),
        direct?.available === false
          ? h('p', { className: 'wx-draft-hint' }, t('direct.unavailable'))
          : null)
      : null);
}

/** 运行概览区。 */
export function RuntimeSection(props: { t: T; status: any }) {
  const { t, status } = props;
  return h('section', { className: 'wx-panel wx-runtime-panel' },
    h('div', { className: 'wx-section-head' },
      h('div', null,
        h('p', { className: 'wx-eyebrow' }, t('runtime.eyebrow')),
        h('h4', { className: 'wx-section-title' }, t('runtime.title')))),
    h('div', { className: 'wx-metrics' },
      h(Metric, { value: String(status?.pendingQuestions ?? 0), label: t('runtime.pendingQuestions') }),
      h(Metric, { value: String(status?.trackingTasks ?? 0), label: t('runtime.trackingTasks') }),
      h(Metric, {
        value: status?.ownFeatures ? t('reminder.sourcePlugin') : t('reminder.sourceCore'),
        label: t('reminder.source'),
        wide: true,
      })),
    status?.ownFeatures && status?.ownerKnown === false
      ? h('div', { className: 'wx-banner wx-banner-warning', role: 'status' },
        h(StateDot, { state: 'warning' }),
        h('span', null, t('runtime.ownerUnknown')))
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
        h('p', { className: 'wx-eyebrow' }, t('error.title')),
        h('h4', { className: 'wx-section-title' }, t('error.heading')))),
    lastError?.message
      ? h('p', { className: 'wx-error' }, `${formatTime(lastError.at)} ${String(lastError.message)}`)
      : null,
    actionError ? h('p', { className: 'wx-error' }, actionError) : null,
    pollError ? h('p', { className: 'wx-error' }, pollError) : null);
}
