/**
 * `dsh-im-wechat` 命名空间字典：英文。
 *
 * 键集与 `./zh.ts` 完全一致：`Record<WeChatKey, string>` 让漏译或多写的键直接
 * 编译失败，而不是运行期静默回落中文。
 */
import type { WeChatKey } from './zh.ts';

export const en: Record<WeChatKey, string> = {
  // 面板与通用
  'panel.title': 'WeChat',
  'panel.subtitle': 'Connect WeChat to this Harness: after scanning the QR code, messages and deliveries sync between WeChat and the core.',
  'panel.refresh': 'Refresh',
  'banner.hostOlder': 'Restart dsh web: the panel is newer than the host',
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.copied': 'Copied',
  'common.expand': 'Expand',
  'common.collapse': 'Collapse',
  'common.minutes': 'min',

  // 状态
  'status.signedIn': 'Signed in',
  'status.signedOut': 'Not signed in',
  'status.disabled': 'Disabled',
  'status.unavailable': 'Status unavailable',

  // 连接健康状态
  'health.ok': 'Healthy',
  'health.degraded': 'Degraded',
  'health.down': 'Disconnected',
  'health.unknown': 'Not signed in',

  // 错误
  'error.title': 'Last error',
  'error.heading': 'Needs attention',
  'error.operationFailed': 'Operation failed',

  // 连接区
  'connection.eyebrow': 'Connection',
  'connection.titleConnected': 'WeChat connected',
  'connection.titleConnect': 'Connect WeChat',
  'connection.version': 'Plugin version',
  'connection.account': 'Account',
  'connection.signedInAt': 'Signed in at',
  'connection.signedOut': 'WeChat is not connected',
  'connection.signedOutHint': 'Sign in with a QR code to start receiving and sending messages.',
  'connection.bridgeOn': 'Bridged to My Superagent',
  'connection.bridgeOff': 'Not bridged',

  // 扫码登录
  'login.start': 'Sign in with QR code',
  'login.restartScan': 'Sign in again',
  'login.signOut': 'Sign out',
  'login.signOutHint': 'After signing out you must scan again to receive WeChat messages.',
  'login.scanHint': 'Scan the QR code with WeChat on your phone',
  'login.qrAlt': 'QR code',
  'login.qrLoading': 'Preparing QR code…',
  'login.linkHint': 'If the QR code is unavailable, copy the link below and open it in WeChat:',
  'login.copyLink': 'Copy link',
  'login.openLink': 'Open link',
  'login.verifyCode': 'Verification code',
  'login.submitCode': 'Submit code',
  'login.restart': 'Start over',
  'login.phase.waiting': 'Waiting for scan',
  'login.phase.scanned': 'Scanned — confirm on your phone',
  'login.phase.needCode': 'Enter the code shown on your phone',
  'login.phase.confirmed': 'Signed in',
  'login.phase.bound': 'Already connected — no need to sign in again',
  'login.phase.expired': 'The QR code expired or the flow ended',

  // 消息与提醒
  'reminder.eyebrow': 'Connection mode',
  'reminder.title': 'Messages and reminders',
  'reminder.note': 'Control where messages enter and leave',
  'reminder.enabledTitle': 'Receive messages from WeChat',
  'reminder.enabledDescription': 'When disabled, WeChat messages are no longer received and deliveries are not sent here.',
  'reminder.superagentTitle': 'Connect to My Superagent',
  'reminder.superagentDescription': 'When off, the WeChat plugin sends questions and long-task reminders itself.',
  'reminder.thresholdTitle': 'Reminder threshold (minutes)',
  'reminder.thresholdDescription': 'A root-session turn triggers a reminder only when it runs longer than this; applies when this plugin sends the reminders.',
  'reminder.thresholdValue': 'Current threshold: {value} {unit}',
  'reminder.invalid': 'The threshold must be a whole number of minutes between {min} and {max}',
  'reminder.source': 'Reminder source',
  'reminder.sourcePlugin': 'Sent by this plugin',
  'reminder.sourceCore': 'Sent by My Superagent',

  // 独立模式
  'direct.eyebrow': 'Standalone mode',
  'direct.title': 'Direct session',
  'direct.handledByCore': 'Handled by My Superagent',
  'direct.handledByPlugin': 'Handled by this plugin',
  'direct.bridgeHint': 'With My Superagent connected, the core decides the session and model. Turn the switch above off to enable standalone mode.',
  'direct.standaloneHint': 'Without My Superagent, this plugin talks to the session directly: the first message creates a session in the chosen workspace, text and images go to the session, and answers come back to WeChat.',
  'direct.steerTitle': 'Steer within a running turn',
  'direct.steerDescription': 'On by default: new messages are inserted into the running turn. Off: they queue until the current turn ends.',
  'direct.workspace': 'Workspace',
  'direct.workspaceDescription': 'The first message creates a session in this workspace and reuses it afterwards; the auto-created “WeChat session” is the default.',
  'direct.defaultWorkspace': 'Default (WeChat session)',
  'direct.workspaceUnselected': 'Not selected',
  'direct.currentSession': 'Current session',
  'direct.running': 'running',
  'direct.resetBinding': 'Reset binding',
  'direct.noSession': 'No session is bound yet; the next message creates one in the selected workspace.',
  'direct.unavailable': 'The host exposes no session service, so standalone mode is unavailable.',

  // 运行概览
  'runtime.eyebrow': 'Runtime',
  'runtime.title': 'Runtime overview',
  'runtime.pendingQuestions': 'Questions awaiting an answer',
  'runtime.trackingTasks': 'Long tasks being tracked',
  'runtime.ownerUnknown': 'The signed-in state has no WeChat user recorded, so reminders cannot be sent. Please sign in again.',
};
