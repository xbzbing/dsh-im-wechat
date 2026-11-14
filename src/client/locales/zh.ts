/**
 * `dsh-im-wechat` 命名空间字典：中文。
 *
 * 键由面板自己定义，中文只是这一语言的值。`WeChatKey` 由本字典派生，`en.ts`
 * 按同一组键声明——少一个、多一个都编译不过。
 */
export const zh = {
  // 面板与通用
  'panel.title': '微信',
  'panel.subtitle': '把微信接入本机 Harness：扫码登录后，消息与交付会在微信和核心之间同步。',
  'panel.refresh': '刷新',
  'banner.hostOlder': '请重启 dsh web：面板比 Host 新',
  'common.loading': '加载中…',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.copied': '已复制',
  'common.expand': '展开',
  'common.collapse': '收起',
  'common.minutes': '分钟',

  // 状态
  'status.signedIn': '已登录',
  'status.signedOut': '未登录',
  'status.disabled': '已停用',
  'status.unavailable': '状态不可用',

  // 连接健康状态
  'health.ok': '连接正常',
  'health.degraded': '连接异常',
  'health.down': '连接中断',
  'health.unknown': '未登录',

  // 错误
  'error.title': '最近错误',
  'error.heading': '需要注意',
  'error.operationFailed': '操作失败',

  // 连接区
  'connection.eyebrow': '连接',
  'connection.titleConnected': '微信已连接',
  'connection.titleConnect': '连接微信',
  'connection.version': '插件版本',
  'connection.account': '账号',
  'connection.signedInAt': '登录时间',
  'connection.signedOut': '尚未登录微信',
  'connection.signedOutHint': '扫码登录后开始接收和发送消息。',
  'connection.bridgeOn': '已接入超级助理',
  'connection.bridgeOff': '未接入超级助理',

  // 扫码登录
  'login.start': '扫码登录',
  'login.restartScan': '重新扫码',
  'login.signOut': '登出',
  'login.signOutHint': '登出后需要重新扫码才能继续接收微信消息。',
  'login.scanHint': '用手机微信扫描二维码',
  'login.qrAlt': '二维码',
  'login.qrLoading': '二维码加载中…',
  'login.linkHint': '无法显示二维码时，可复制下面的链接在手机微信中打开：',
  'login.copyLink': '复制链接',
  'login.openLink': '打开链接',
  'login.verifyCode': '验证码',
  'login.submitCode': '提交验证码',
  'login.restart': '重新开始',
  'login.phase.waiting': '等待扫码',
  'login.phase.scanned': '已扫描，请在手机上确认',
  'login.phase.needCode': '需要在手机上输入验证码',
  'login.phase.confirmed': '登录成功',
  'login.phase.bound': '已连接过，无需重复登录',
  'login.phase.expired': '二维码已过期或流程结束',
  'login.phase.failed': '登录未完成',

  // 消息与提醒
  'reminder.eyebrow': '接入方式',
  'reminder.title': '消息与提醒',
  'reminder.note': '控制消息从哪里进出',
  'reminder.enabledTitle': '接入微信（收消息）',
  'reminder.enabledDescription': '停用后不再收取微信消息，核心的交付也不会发到这个渠道。',
  'reminder.superagentTitle': '接入我的超级助理',
  'reminder.superagentDescription': '关闭后由微信插件自己发送问题与长任务提醒。',
  'reminder.thresholdTitle': '提醒阈值（分钟）',
  'reminder.thresholdDescription': '根会话的一个回合超过这个时长才发提醒；只在本插件发送提醒时生效。',
  'reminder.thresholdValue': '当前阈值：{value} {unit}',
  'reminder.questionTitle': '问题与审批提醒',
  'reminder.questionDescription': '关掉后提问与工具授权只在 Web 端处理，不再发到微信。',
  'reminder.questionDelayTitle': '提醒前等待（分钟）',
  'reminder.questionDelayDescription': '这段时间里在 Web 端答完就不打扰；到点还没答才发到微信。',
  'reminder.questionDelayValue': '当前等待：{value} {unit}',
  'reminder.invalid': '需为 {min} 到 {max} 的整数分钟',
  'reminder.source': '提醒来源',
  'reminder.sourcePlugin': '由本插件发送',
  'reminder.sourceCore': '由超级助理发送',

  // 独立模式
  'direct.eyebrow': '独立模式',
  'direct.title': '直连会话',
  'direct.handledByCore': '由超级助理接管',
  'direct.handledByPlugin': '由本插件直接处理',
  'direct.bridgeHint': '接入超级助理后，会话与模型由核心决定；关闭上方开关即可启用独立模式。',
  'direct.standaloneHint': '未接入超级助理时，本插件直接与会话交互：首次消息按所选工作区新建会话，文字与图片交给会话，回答发回微信。',
  'direct.steerTitle': '回合内插话',
  'direct.steerDescription': '默认打开：插入正在运行的回合；关闭时新消息排队等待当前回合结束。',
  'direct.workspace': '工作区',
  'direct.workspaceDescription': '首次消息在该工作区新建会话并持续复用；默认使用自动创建的「微信会话」。',
  'direct.defaultWorkspace': '默认（微信会话）',
  'direct.workspaceUnselected': '未选择',
  'direct.currentSession': '当前会话',
  'direct.running': '运行中',
  'direct.resetBinding': '重置绑定',
  'direct.noSession': '尚未绑定会话，下一条消息将按所选工作区新建。',
  'direct.unavailable': '宿主未提供会话服务，独立模式不可用。',

  // 运行概览
  'runtime.eyebrow': '运行状态',
  'runtime.title': '运行概览',
  'runtime.pendingQuestions': '等待作答的问题',
  'runtime.pendingApprovals': '等待授权的工具',
  'runtime.trackingTasks': '跟踪中的长任务',
  'runtime.ownerUnknown': '登录态里没有记录扫码的微信用户，提醒无法发出：请重新扫码登录。',
};

/** 命名空间定义的全部文案键（本字典是唯一来源）。 */
export type WeChatKey = keyof typeof zh;
