/**
 * 面板文案。
 *
 * 中文原文即 key：中文是 identity 语言，`en` 提供「中文 → 英文」映射；漏翻译时
 * 回落中文而不是显示 key。`zh` 由 `en` 的键集合派生，保证两种语言键集一致。
 */

export const NS = 'dsh-im-wechat';

export const en = {
  '微信': 'WeChat',
  '把微信接入本机 Harness：扫码登录后，消息与交付会在微信和核心之间同步。':
    'Connect WeChat to this Harness: after scanning the QR code, messages and deliveries sync between WeChat and the core.',
  '插件版本': 'Plugin version',
  '未登录': 'Not signed in',
  '尚未登录微信': 'WeChat is not connected',
  '扫码登录后开始接收和发送消息。': 'Sign in with a QR code to start receiving and sending messages.',
  '已登录': 'Signed in',
  '已停用': 'Disabled',
  '连接正常': 'Healthy',
  '连接异常': 'Degraded',
  '连接中断': 'Disconnected',
  '已接入超级助理': 'Bridged to My Superagent',
  '未接入超级助理': 'Not bridged',
  '账号': 'Account',
  '登录时间': 'Signed in at',
  '扫码登录': 'Sign in with QR code',
  '重新扫码': 'Sign in again',
  '登出': 'Sign out',
  '取消': 'Cancel',
  '用手机微信扫描二维码': 'Scan the QR code with WeChat on your phone',
  '二维码加载中…': 'Preparing QR code…',
  '无法显示二维码时，可复制下面的链接在手机微信中打开：':
    'If the QR code is unavailable, copy the link below and open it in WeChat:',
  '复制链接': 'Copy link',
  '已复制': 'Copied',
  '打开链接': 'Open link',
  '等待扫码': 'Waiting for scan',
  '已扫描，请在手机上确认': 'Scanned — confirm on your phone',
  '需要在手机上输入验证码': 'Enter the code shown on your phone',
  '验证码': 'Verification code',
  '提交验证码': 'Submit code',
  '二维码已过期或流程结束': 'The QR code expired or the flow ended',
  '已连接过，无需重复登录': 'Already connected — no need to sign in again',
  '登录成功': 'Signed in',
  '重新开始': 'Start over',
  '接入微信（收消息）': 'Receive messages from WeChat',
  '停用后不再收取微信消息，核心的交付也不会发到这个渠道。':
    'When disabled, WeChat messages are no longer received and deliveries are not sent here.',
  '最近错误': 'Last error',
  '加载中…': 'Loading…',
  '操作失败': 'Operation failed',
  '状态不可用': 'Status unavailable',
  '请重启 dsh web：面板比 Host 新': 'Restart dsh web: the panel is newer than the host',
  '刷新': 'Refresh',
  '登出后需要重新扫码才能继续接收微信消息。': 'After signing out you must scan again to receive WeChat messages.',
  '二维码': 'QR code',
  '连接': 'Connection',
  '接入方式': 'Connection mode',
  '控制消息从哪里进出': 'Control where messages enter and leave',
  '消息与提醒': 'Messages and reminders',
  '关闭后由微信插件自己发送问题与长任务提醒。': 'When off, the WeChat plugin sends questions and long-task reminders itself.',
  '微信已连接': 'WeChat connected',
  '连接微信': 'Connect WeChat',
  '运行状态': 'Runtime',
  '运行概览': 'Runtime overview',
  '需要注意': 'Needs attention',
  '接入我的超级助理': 'Connect to My Superagent',
  '提醒阈值（分钟）': 'Reminder threshold (minutes)',
  '根会话的一个回合超过这个时长才发提醒；只在本插件发送提醒时生效。':
    'A root-session turn triggers a reminder only when it runs longer than this; applies when this plugin sends the reminders.',
  '分钟': 'min',
  '保存': 'Save',
  '当前阈值': 'Current threshold',
  '阈值需为 1 到 1440 的整数分钟': 'The threshold must be a whole number of minutes between 1 and 1440',
  '等待作答的问题': 'Questions awaiting an answer',
  '跟踪中的长任务': 'Long tasks being tracked',
  '提醒来源': 'Reminder source',
  '由本插件发送': 'Sent by this plugin',
  '由超级助理发送': 'Sent by My Superagent',
  '登录态里没有记录扫码的微信用户，提醒无法发出：请重新扫码登录。':
    'The signed-in state has no WeChat user recorded, so reminders cannot be sent. Please sign in again.',
  '独立模式': 'Standalone mode',
  '直连会话': 'Direct session',
  '由超级助理接管': 'Handled by My Superagent',
  '由本插件直接处理': 'Handled by this plugin',
  '收起': 'Collapse',
  '展开': 'Expand',
  '接入超级助理后，会话与模型由核心决定；关闭上方开关即可启用独立模式。':
    'With My Superagent connected, the core decides the session and model. Turn the switch above off to enable standalone mode.',
  '未接入超级助理时，本插件直接与会话交互：首次消息按所选工作区新建会话，回答发回微信。':
    'Without My Superagent, this plugin talks to the session directly: the first message creates a session in the chosen workspace, and answers come back to WeChat.',
  '回合内插话': 'Steer within a running turn',
  '关闭时新消息排队等待当前回合结束；打开后插入正在运行的回合。':
    'Off: new messages queue until the current turn ends. On: they are inserted into the running turn.',
  '工作区': 'Workspace',
  '首次消息在该工作区新建会话并持续复用；留空使用宿主的默认位置。':
    'The first message creates a session in this workspace and reuses it afterwards; leave empty for the host default location.',
  '不指定（宿主默认位置）': 'Not specified (host default)',
  '当前会话': 'Current session',
  '运行中': 'running',
  '重置绑定': 'Reset binding',
  '尚未绑定会话，下一条消息将按所选工作区新建。':
    'No session is bound yet; the next message creates one in the selected workspace.',
  '宿主未提供会话服务，独立模式不可用。': 'The host exposes no session service, so standalone mode is unavailable.',
} as const;

/** 中文模式：键即译文。 */
export const zh: { [K in keyof typeof en]: K } = Object.fromEntries(
  Object.keys(en).map((key) => [key, key]),
) as { [K in keyof typeof en]: K };

export type Translate = (text: string) => string;
