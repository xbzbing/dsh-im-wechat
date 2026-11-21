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
  reminderSourceKey,
  standaloneSettingsLocked,
  validateMinutes,
  validateQuestionDelay,
  workspaceOptions,
} from './logic.ts';
import { modelSaveable } from './model-route.ts';
import { h } from './platform.ts';
import type { ModelCatalogView } from '../shared/models.ts';
import { Fact, Metric, MinutesRow, ModelRouteRow, PickerRow, SwitchRow } from './rows.ts';
import { Button, Dialog, IconCopy, IconLink, Input, StateDot } from './ui.ts';
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

/** 连接区：账号事实、登录/登出动作；扫码登录在弹层里（`LoginDialog`）。 */
export function ConnectionSection(props: {
  t: T;
  rpcCall: RpcCall;
  run: Run;
  status: any;
  state: string;
  loggedIn: boolean;
  health: any;
  busy: string;
  onLogin: () => void;
}) {
  const { t, rpcCall, run, status, state, loggedIn, health, busy, onLogin } = props;
  // 只在真的接上了才说：未接入是默认状态，不必占一行。
  const bridgeLabel = status?.bridge?.registered ? t('connection.bridgeOn') : '';

  return h('section', { className: 'wx-panel wx-connection-panel' },
    h('div', { className: 'wx-section-head' },
      h('div', null,
        h('p', { className: 'wx-eyebrow' }, t('connection.eyebrow')),
        h('h4', { className: 'wx-section-title' }, loggedIn ? t('connection.titleConnected') : t('connection.titleConnect'))),
      h('span', { className: 'wx-version' }, `${t('connection.version')} ${status?.version ?? ''}`)),
    h('div', { className: 'wx-connection-main' },
      h('div', { className: 'wx-connection-status' },
        h(StateDot, { state }),
        h('div', null,
          h('strong', null, loggedIn ? healthText(t, health) : t('connection.signedOut')),
          loggedIn
            ? (bridgeLabel !== '' ? h('span', null, bridgeLabel) : null)
            : h('span', null, t('connection.signedOutHint')))),
      h('div', { className: 'wx-facts' },
        h(Fact, {
          label: t('connection.account'),
          value: status?.accountTail ?? t('status.signedOut'),
          ...(typeof status?.account === 'string' && status.account !== '' ? { hint: status.account } : {}),
        }),
        h(Fact, { label: t('connection.signedInAt'), value: status?.loggedInAt ? formatTime(status.loggedInAt) : '—' }),
        h(Fact, {
          label: t('reminder.source'),
          value: t(reminderSourceKey(status?.superagent)),
        })),
      h('div', { className: 'wx-actions' },
        // 登录与重新扫码是同一个动作，只差 variant 与文案；二维码在弹层里出。
        h(Button, {
          variant: loggedIn ? 'outline' : 'primary',
          size: 'md',
          disabled: busy !== '',
          onClick: onLogin,
        }, busy === 'login' ? t('common.loading') : loggedIn ? t('login.restartScan') : t('login.start')),
        loggedIn
          ? h(Button, {
            variant: 'ghost',
            size: 'md',
            disabled: busy !== '',
            onClick: () => void run('logout', () => rpcCall(ENDPOINTS.logout)),
          }, t('login.signOut'))
          : null),
      // 提示独立成行：宽版时拉通整行，不跟按钮挤在右侧格子里。
      loggedIn
        ? h('span', { className: 'wx-action-hint' }, t('login.signOutHint'))
        : null));
}

/**
 * 扫码登录弹层：二维码是唯一有底色的元素，其余按文字排。
 *
 * 关闭即取消这次登录（没有会话在等，留着只会让二维码一直轮询）；登录已结束（失败、
 * 已绑定）时点关闭只是收起弹层，由调用方记住这次收起。
 */
export function LoginDialog(props: {
  t: T;
  rpcCall: RpcCall;
  run: Run;
  login: any;
  qrData: string | null;
  qrLink: string | null;
  copied: boolean;
  code: string;
  busy: string;
  active: boolean;
  copyLink: () => Promise<void>;
  setCode: (value: string) => void;
  onClose: () => void;
}) {
  const { t, rpcCall, run, login, copied, code, busy, active, copyLink, setCode, onClose } = props;
  const { qrData, qrLink } = props;

  return h(Dialog, { open: true, label: t('login.title'), onClose },
    h('div', { className: 'wx-login' },
      h('div', { className: 'wx-login-head' },
        h('strong', null, t(describeLoginPhase(login.phase) || 'login.phase.waiting')),
        h('span', null, t('login.scanHint'))),
      login.phase === 'failed' && login.error
        ? h('p', { className: 'wx-error' }, String(login.error))
        : null,
      qrData
        ? h('img', { className: 'wx-login-qr', src: qrData, alt: t('login.qrAlt') })
        : h('div', { className: 'wx-login-qr wx-login-qr-empty' },
          h('span', null, login.qrContent ? t('login.qrFallback') : t('login.qrLoading'))),
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
      // 链接只以按钮出现：复制到手机、或在手机上打开，不铺原文。
      login.qrContent
        ? h('div', { className: 'wx-actions' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconCopy, null), onClick: () => void copyLink() },
            copied ? t('common.copied') : t('login.copyLink')),
          qrLink
            ? h(Button, {
              variant: 'ghost',
              size: 'sm',
              icon: h(IconLink, null),
              onClick: () => window.open(qrLink, '_blank', 'noreferrer'),
            }, t('login.openLink'))
            : null)
        : null,
      h('button', {
        type: 'button',
        className: 'wx-login-foot',
        disabled: busy !== '',
        onClick: () => void run(
          active ? 'cancel' : 'login',
          () => rpcCall(active ? ENDPOINTS.loginCancel : ENDPOINTS.loginStart),
        ),
      }, active ? t('common.cancel') : t('login.restart'))));
}

/** 消息与提醒区：接入开关、提醒来源，以及独立模式才生效的提醒设置。 */
export function ReminderSection(props: {
  t: T;
  rpcCall: RpcCall;
  run: Run;
  saveMinutes: () => Promise<void>;
  onMinutesChange: (value: string) => void;
  enabled: boolean;
  superagent: boolean;
  /** 核心服务在不在：不在时「接入我的超级助理」不可打开，只能用独立模式。 */
  superagentAvailable: boolean;
  minutes: string;
  minutesDirty: boolean;
  minutesSaved: boolean;
  threshold: unknown;
  /** 失败提醒开关：默认开，关掉后失败的任务不再发提醒。 */
  failureReminders: boolean;
  toggleFailureReminders: (enabled: boolean) => Promise<void>;
  questionReminders: boolean;
  questionDelay: string;
  questionDelayDirty: boolean;
  questionDelaySaved: boolean;
  questionDelayValue: unknown;
  onQuestionDelayChange: (value: string) => void;
  saveQuestionDelay: () => Promise<void>;
  toggleQuestionReminders: (enabled: boolean) => Promise<void>;
  hostOlder: boolean;
  busy: string;
}) {
  const { t, rpcCall, run, saveMinutes, onMinutesChange } = props;
  const { enabled, superagent, superagentAvailable, minutes, minutesDirty, minutesSaved, threshold, hostOlder, busy } = props;
  const { failureReminders, toggleFailureReminders } = props;
  const { questionReminders, questionDelay, questionDelayDirty, questionDelaySaved, questionDelayValue } = props;
  const { onQuestionDelayChange, saveQuestionDelay, toggleQuestionReminders } = props;
  const check = validateMinutes(minutes);
  const canSaveMinutes = check.ok && check.value !== (typeof threshold === 'number' ? threshold : -1);
  const questionCheck = validateQuestionDelay(questionDelay);
  const canSaveQuestionDelay = questionCheck.ok
    && questionCheck.value !== (typeof questionDelayValue === 'number' ? questionDelayValue : -1);
  // 下面四项只在独立模式生效：接入核心后由核心按自己的设置发，锁住并说明原因。
  const ownLocked = standaloneSettingsLocked({ superagent, hostOlder, busy });

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
        description: superagentAvailable ? t('reminder.superagentDescription') : t('reminder.superagentUnavailable'),
        checked: superagent,
        disabled: busy !== '' || !superagentAvailable,
        onChange: (next: boolean) => void run('superagent', () => rpcCall(ENDPOINTS.setSuperagent, { enabled: next })),
      }),
      h('div', { className: `wx-settings-list${superagent ? ' wx-panel-muted' : ''}` },
        superagent ? h('p', { className: 'wx-draft-hint' }, t('reminder.ownHandledByCore')) : null,
        h(SwitchRow, {
          title: t('reminder.questionTitle'),
          description: t('reminder.questionDescription'),
          checked: questionReminders,
          disabled: ownLocked,
          onChange: (next: boolean) => void toggleQuestionReminders(next),
        }),
        h(MinutesRow, {
          t,
          title: t('reminder.questionDelayTitle'),
          description: t('reminder.questionDelayDescription'),
          value: questionDelay,
          placeholder: '5',
          disabled: ownLocked || !questionReminders,
          canSave: canSaveQuestionDelay,
          saved: questionDelaySaved,
          onChange: onQuestionDelayChange,
          onSave: saveQuestionDelay,
          error: !questionCheck.ok && questionDelay.trim() !== '' ? t(questionCheck.key, questionCheck.params) : null,
          draftHint: questionDelayDirty
            ? t('reminder.questionDelayValue', {
              value: typeof questionDelayValue === 'number' ? questionDelayValue : '—',
              unit: t('common.minutes'),
            })
            : null,
        }),
        h(MinutesRow, {
          t,
          title: t('reminder.thresholdTitle'),
          description: t('reminder.thresholdDescription'),
          value: minutes,
          placeholder: '30',
          disabled: ownLocked,
          canSave: canSaveMinutes,
          saved: minutesSaved,
          onChange: onMinutesChange,
          onSave: saveMinutes,
          error: !check.ok && minutes.trim() !== '' ? t(check.key, check.params) : null,
          draftHint: minutesDirty
            ? t('reminder.thresholdValue', {
              value: typeof threshold === 'number' ? threshold : '—',
              unit: t('common.minutes'),
            })
            : null,
        }),
        h(SwitchRow, {
          title: t('reminder.failureTitle'),
          description: t('reminder.failureDescription'),
          checked: failureReminders,
          disabled: ownLocked,
          onChange: (next: boolean) => void toggleFailureReminders(next),
        }))));
}

/** 独立模式区：插话、工作区、模型与推理等级、绑定（ADR-0009、ADR-0025、ADR-0026）。 */
export function DirectSection(props: {
  t: T;
  saveDirect: (patch: { workspaceId?: string; busyMode?: 'queue' | 'steer'; reset?: boolean; replyStatus?: boolean }) => Promise<void>;
  onWorkspaceChange: (value: string) => void;
  onToggleExpand: () => void;
  superagent: boolean;
  directExpanded: boolean;
  direct: any;
  workspaceId: string;
  workspaceSaved: boolean;
  workspaces: { id: string; title: string; path: string }[];
  workspacesReady: boolean;
  /** 宿主的模型目录（`null` 表示还没读到）。 */
  models: ModelCatalogView | null;
  /** 模型三级草稿：provider 空 = 跟随 DSH 默认；model 空 = 还没选；effort 空 = 模型默认。 */
  modelProvider: string;
  modelId: string;
  modelEffort: string;
  /** 本次会话里刚清空过模型：提示「已绑定会话仍用旧模型」，不常显。 */
  modelCleared: boolean;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  saveModel: () => Promise<void>;
  modelSaved: boolean;
  hostOlder: boolean;
  busy: string;
}) {
  const { t, saveDirect, onWorkspaceChange, onToggleExpand } = props;
  const { superagent, directExpanded, direct, workspaceId, workspaceSaved, workspaces, workspacesReady, hostOlder, busy } = props;
  const { models, modelProvider, modelId, modelEffort, modelCleared, saveModel, modelSaved } = props;
  const { onProviderChange, onModelChange, onEffortChange } = props;
  const directBusy = direct?.busyMode === 'steer';
  // 同形的禁用条件只算一次：四份拷贝已经漂移过（重置绑定曾少了 available 判断）。
  const directLocked = standaloneSettingsLocked({ superagent, hostOlder, busy }) || direct?.available === false;
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
          h(SwitchRow, {
            title: t('direct.replyStatusTitle'),
            description: t('direct.replyStatusDescription'),
            checked: direct?.replyStatus === true,
            disabled: directLocked,
            onChange: (next: boolean) => void saveDirect({ replyStatus: next }),
          }),
          h(PickerRow, {
            t,
            title: t('direct.workspace'),
            description: t('direct.workspaceDescription'),
            value: workspaceId,
            items: workspaceOptions(workspaces, workspaceId, t('direct.defaultWorkspace')),
            placeholder: t('direct.workspaceUnselected'),
            disabled: directLocked || !workspacesReady,
            saved: workspaceSaved,
            onChange: onWorkspaceChange,
            onSave: () => saveDirect({ workspaceId }),
          }),
          h(ModelRouteRow, {
            t,
            title: t('direct.model'),
            description: t('direct.modelDescription'),
            catalog: models,
            provider: modelProvider,
            model: modelId,
            effort: modelEffort,
            // 目录整体读不到时不让人乱选：能列出目录才谈「选目录里的模型」。
            disabled: directLocked || models === null || models.available === false,
            canSave: modelSaveable(modelProvider, modelId),
            saved: modelSaved,
            onChangeProvider: onProviderChange,
            onChangeModel: onModelChange,
            onChangeEffort: onEffortChange,
            onSave: saveModel,
          }),
          direct?.bound
            ? h('div', { className: 'wx-setting-row' },
              h('div', { className: 'wx-setting-copy' },
                h('span', { className: 'wx-setting-title' }, t('direct.currentSession')),
                // 会话名完整显示（标题行不截断），id 用小字放在下一行，方便复制排障。
                h('span', { className: 'wx-session-name' },
                  typeof direct.sessionTitle === 'string' && direct.sessionTitle !== ''
                    ? direct.sessionTitle
                    : t('direct.unnamedSession')),
                h('span', { className: 'wx-session-meta' },
                  h('code', { className: 'wx-session-id' }, String(direct.sessionId ?? '')),
                  direct.running ? h('span', null, t('direct.running')) : null,
                  boundWorkspace ? h('span', null, boundWorkspace.title) : null)),
              h(Button, {
                variant: 'ghost',
                size: 'sm',
                disabled: directLocked,
                onClick: () => void saveDirect({ reset: true }),
              }, t('direct.resetBinding')))
            : h('p', { className: 'wx-draft-hint' },
              t('direct.noSession'))),
        models !== null && models.available === false
          ? h('p', { className: 'wx-draft-hint' },
            t('direct.modelUnavailable', { reason: String(models.reason ?? '') }))
          : null,
        !hostOlder && modelCleared && direct?.bound === true
          ? h('p', { className: 'wx-draft-hint' }, t('direct.modelResetHint'))
          : null,
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
      h(Metric, { value: String(status?.pendingApprovals ?? 0), label: t('runtime.pendingApprovals') }),
      h(Metric, { value: String(status?.trackingTasks ?? 0), label: t('runtime.trackingTasks') }),
      h(Metric, {
        value: t(reminderSourceKey(status?.superagent)),
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
