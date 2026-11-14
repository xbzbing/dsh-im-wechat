# AGENTS.md

本文件是 `dsh-im-wechat` 仓库的 agent 工作指南。动手前先读完本文件，再读 [docs/adr/README.md](docs/adr/README.md)。功能细节以代码与测试为准；**理由与背景以 ADR（`docs/adr/`）为准，外部协议事实以 `docs/protocol/` 为准**，本文件只记操作规则与踩过的坑，不复制 ADR 与设计文档。

## 项目定位

微信 IM 桥插件：把微信接入 DeepSeek Harness，作为 `dsh-my-superagent` 的 IM 桥（协议 `my-superagent/v1`，经 `bridges.register` 注册），把交付渲染成微信消息送达主人，把主人的消息与作答回交核心；**独立安装**（不装核心）时直接驱动 DSH 会话（ADR-0009），与接入核心互斥（两种用法见 README）。微信侧走腾讯 iLink 协议，**只以腾讯官方 `openclaw-weixin` 的接口与协议定义为参考、自写零依赖客户端**（ADR-0001）。插件为两半式结构：host 半跑在 DSH Host 进程内，client 半是 Web 设置面板；框架与构建门禁与 `dsh-im-infoflow` 同构。

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `index.ts` | 包入口，只 re-export host 入口 |
| `src/host/index.ts` | Cordis 入口：只装配与接线 |
| `src/host/ilink/` | iLink 协议客户端：`types`/`api`（端点、请求头、错误分类）、`json`（64 位消息 id 保真）、`identity`（入站身份）、`login`、`poll`、`send`、`upload`（CDN 上传）、`media`、`session-guard`；只用 Node 内置模块 |
| `src/host/superagent/` | `my-superagent/v1` 桥适配：`protocol`（结构描述，不 import 核心包）、`render`（Markdown 降级、交互转文字、分条）、`bridge`（`BridgeProvider`）、`quota`（bridge 级发送窗口）、`send-health`（发送失败到健康状态）、`link`（延后注册的 `BridgeBinder`） |
| `src/host/questions.ts`、`approvals.ts`、`reminder-center.ts`、`reply-pending.ts`、`answer-text.ts`、`long-tasks.ts`、`host-agents.ts` | 自有功能（ADR-0006）：问题提醒与竞答、审批提醒与微信作答（ADR-0023）、两者的开关/等待窗口与入站归属、共用的待答机械件、作答匹配、长任务提醒、按会话来源判根会话 |
| `src/host/state/` | 本机状态：登录态、长轮询游标、`context_token`、独立模式绑定、已消费的提醒回复；`files.ts` 私密文件读写、`paths.ts` 目录解析；目录 `0700`、文件 `0600`、原子写 |
| `src/host/` | `index.ts` 入口、`runtime.ts` 装配与生命周期、`runtime-status.ts` 面板状态、`panel-actions.ts` 面板设置的校验/落盘/生效、`inbound.ts` 入站转换、`inbound-pipeline.ts` 轮询/投递流水线、`owner-channel.ts` 主人收发通道、`typing.ts` 输入状态（ADR-0007）、`direct.ts` 独立模式直连（ADR-0009）、`direct-model.ts` 独立模式的模型选择与钉模型（ADR-0025）、`present-images.ts` present 图片转发（ADR-0019）、`session-events.ts` 会话事件、`workspace-default.ts` 默认工作区、`bot-agent.ts` 机器人元数据、`prompt-parts.ts` 提交给会话的文字/图片 part（ADR-0017）、`panel-rpc.ts` 面板 RPC、`send-gate.ts` 提醒节流、`cli.ts` 出站命令逻辑（ADR-0012）、`config.ts` 配置、`host-context.ts` 宿主上下文最小类型 |
| `bin/dsh-wechat-send.mjs` | 出站命令入口，只把参数交给 `lib/src/host/cli.js`（ADR-0012） |
| `src/host/command.ts` | 斜杠命令 `/wechat`：人用入口，复用 `cli.ts` 的解析与发送端口（ADR-0012） |
| `src/client/` | Web 面板，esbuild 打成 `lib/client.js`，平台模块保持 external |
| `src/shared/` | 跨上下文的纯函数与纯类型：版本常量、二维码编码器、`media.ts` 图片类型、`question-text.ts` 提示语渲染（两条提问路径共用）、`limits.ts` 文件行数上限 |
| `test/unit/` | 单元测试（每测独立临时目录） |
| `scripts/` | `build.mjs`（host tsc + client esbuild）、`verify-package.mjs`（打包自洽校验）、`assert-pack.mjs`（产物清单断言）、`dev-bridge.mjs`（不开面板的真机自测） |
| `docs/adr/` | 架构决策记录：选了哪条路、否决了什么、代价是什么 |
| `docs/protocol/` | 外部协议事实：iLink 字段、微信客户端渲染、上游版本差异、真机实测 |
| `docs/local/`、`docs/review/` | 只留本地，已 gitignore |

依赖方向：协议类型 ← 领域与桥适配 ← 装配入口。`ilink/` 不感知超级助理，`superagent/` 不感知传输细节，两者在装配层接线。

## 工程约定

- TypeScript strict，`erasableSyntaxOnly`：不用 enum、namespace、参数属性；相对 import 写 `.ts` 后缀。
- **零运行时依赖**：只用 Node 内置模块（`fetch`、`node:crypto` 等）；平台模块（`react`、`@deepseek-ai/*`）在 client 半 external。协议实现参考官方 `openclaw-weixin` 的接口定义自写，不把它或任何第三方插件代码作为依赖引入。`dependencies` / `optionalDependencies` 恒为空；`peerDependencies` 只允许 `@deepseek-ai/*` 平台包且必须标 `optional`（只作兼容声明，npm 不装副本，ADR-0024）。
- **不引用、不复制、不提及任何第三方 DSH 微信插件仓库**；协议事实以官方实现与实测为准，出处写进 `docs/protocol/`。
- 宿主与核心服务一律用最小结构类型描述，不 import 宿主包与 `dsh-my-superagent` 的包。
- 外部输入（协议帧、面板 RPC 参数、配置文件）在边界按 Schema 校验，领域内部不再做防御式判空。
- 任何密钥、令牌、登录态不进日志、审计与面板快照；需要展示时只给「已设置」与状态。
- 子进程一律 argv 数组、不经 shell。
- 文件不超过约 500 行；超出先拆分再加功能。
- **自有功能与核心互斥**：`ownFeatures = 启用 && 未接入核心 && 已登录 && 未停机`（与 `runtime.ts` 的 `#ownFeaturesActive` 四项一致）。接入核心时不发自己的提醒，否则同一条提醒会来两遍（ADR-0006）；新增任何「主动提醒主人」的能力都要先过这个判据。面板同理：只属于独立模式的设置（提醒开关与两个分钟值、直连会话、会话模型）接入核心后在面板锁住，判据是 `logic.ts` 的 `standaloneSettingsLocked`，别在渲染里各写一份。
- **失败提醒不受开关影响**：长任务提醒的开关只关「完成」提醒；宿主 `error`、`blocked`、非用户原因的 `aborted` 一律立刻提醒，主人自己停的（`reason.reason.kind === 'user'`）不提醒。关掉开关后仍会收到失败提醒是刻意的，不要当 bug 改；判据在 `src/host/long-tasks.ts` 与 `test/unit/long-tasks.test.ts`。注意该不变量在**提醒器层**成立（直连测试覆盖）；集成层里开关与事件门同源，插件停用或接入核心时整段不进提醒——两种表述指向同一现状，别把提醒器层的不变量当集成层 bug 查。
- 面板 RPC 契约版本（`HOST_CONTRACT` / `REQUIRED_CONTRACT`）两半必须一致：加端点或改返回结构时一起递增，否则「新面板 + 旧 host」会打到不存在的端点。
- 凭据与 `context_token` 不进日志、不进面板快照；面板只显示账号尾号（`accountTail`）。
- 注释只写实现逻辑与不明显的约束，不写演进过程。

## 开发流程

1. 关键决策先写 ADR（`docs/adr/NNNN-标题.md`，状态/背景/决策/后果四段）；新概念补进 ADR 索引。**准入判据：命中一条才写**——难逆转（选型、落盘位置、对外契约）、跨仓或跨进程契约、安全边界、有会被重新提一遍的否决方案。都不命中的单模块行为调整写进代码注释、测试与提交信息，不占 ADR 编号。
2. 外部事实不写进 ADR：协议字段、客户端渲染、上游版本差异、真机实测放 `docs/protocol/`，变了就直接改那份；ADR 只留「选了哪条路、为什么、否决了什么、代价是什么」。
3. 改决策要新开一篇取代旧的，两篇互相标注，索引改成「被 NNNN 修订」，旧篇正文不改；只是事实变了就改 `docs/protocol/`，不要动 ADR。
4. 先写失败的测试，再写实现，再重构。测试断言行为，不断言实现细节；修 bug 先写能复现的测试。
5. 每完成几项功能，用 subagent 加载 `code-review-and-quality` 做隔离上下文的五轴评审（只读，不改文件）；评审结论全部处理，判断不修的写进 `docs/review/` 并说明理由（该目录 gitignore，不入库）。
6. 按功能或模块分别提交。commit 用 Conventional Commits 前缀加中文：一行标题，正文只在有额外事实时写 2 到 4 行，只写最终实现。scope 用英文模块名或省略（`fix(login): …`、`fix: …`），不写中文 scope。只本地提交，不推送。

## 构建与验证

```bash
npm install        # 首次
npm run build      # lib/：host 逐模块 tsc、client 由 esbuild 打包
npm run typecheck
npm test           # 构建 + node --test 跑 test/unit/*.test.ts
npm run verify     # 打包自洽：产物可由源码确定性重建、清单与资源合规
npm run check      # 提交前门禁：typecheck + test + verify
```

- 需要在主人的 web profile 验收时：先 `dsh plugin --profile web remove dsh-im-wechat`，再 `dsh plugin --profile web add file:<仓库路径>`；host 半改动靠卸载重装生效，只改 client 半刷新页面即可。新装插件由 loader 直接载入，**不需要重启 `dsh web`**；重装时卸载与安装之间留十几秒，间隔太短可能不会重新加载新代码。
- 真机自测不必开面板：`node scripts/dev-bridge.mjs login` 在终端画二维码并落盘登录态，`node scripts/dev-bridge.mjs run` 起长轮询（对 `ping` 回 `pong`），走的是 `src/` 里同一套实现。要提前验证绑定 PIN，先把环境变量 `DSH_WECHAT_VERIFY_PIN` 设为 1，再跑 `node scripts/dev-bridge.mjs login`（ADR-0014）。
- 插件 info 日志只进 Cordis 内存缓冲，终端看不到；排障写测试复现或后续在面板看最近错误。
- 本项目的 OpenViking 记忆写入项目 peer `viking://user/xubingzhen/peers/github.com-xbzbing-dsh-im-wechat/`（由仓库 origin 自动派生），不写用户级记忆。

## 发布

- 发布只由 `.github/workflows/release.yml` 在 master 上做（ADR-0020）：**不要手工打 tag，也不要在本地 `npm publish`**。改版本号 + 写 `docs/releases/v<版本>.md`，一起提交推上 master 即可。
- npm 走可信发布（OIDC），仓库里不放 `NPM_TOKEN`。门禁 job 会执行依赖代码，所以它只有 `contents: read`；`id-token: write` 与 `contents: write` 只在发布 job 上——`test/unit/release.test.ts` 会拦下把这两样挪回门禁 job 的改动。
- 版本号带 `-` 是预发布：只打 tag + 建 GitHub 预发布，不发 npm。
- 门禁固定 node 24。node 22 的 `node --test` 会把依赖 `AbortSignal.timeout`（定时器 unref）的直连用例判成 `cancelledByParent`，在 22 上跑本地全量会看到 9 条假失败，不是产品问题；`engines.node` 因此也只写 24（ADR-0024）。

## 安全红线

- 登录态与 token 只落本机状态文件，权限收紧；不进日志、不进面板快照、不随包发布。
- 桥不解析命令、不判断身份：命令由核心解析，是不是主人由核心按配对绑定判断；桥只上报渠道内的发送者标识。
- 非主人的微信消息不解析命令；对外发言、授权类动作永远由核心决策，桥只负责呈现与转发。例外只有独立模式（没有核心）：工具授权可以由主人在微信里回「批准/拒绝」，边界见 ADR-0023——只主人、只根会话、只认明确关键词、缺省失败关闭。
- 协议实现只用官方 `openclaw-weixin` 定义的接口，不做逆向扩展、不携带凭据到第三方端点。
- 出站入口（`/wechat` 命令、`dsh-wechat-send` 命令行、独立模式下 `present` 图片的自动转发）的收件人**恒为扫码登录的主人**，不提供指定收件人的参数：只解决「主人给自己发」，不新增「给第三方发言」的能力（ADR-0012、ADR-0019）。
- 斜杠命令是给人用的（`dsh-commands` 契约：handler 不经过模型），**模型调不到**；要模型主动发只能走 CLI 或注册工具，别再试图用命令解决模型侧需求。
