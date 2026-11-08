# AGENTS.md

本文件是 `dsh-im-wechat` 仓库的 agent 工作指南。动手前先读完本文件，再读 [docs/adr/README.md](docs/adr/README.md)。功能细节以代码与测试为准；**理由与背景以 ADR（`docs/adr/`）为准**，本文件只记操作规则与踩过的坑，不复制 ADR 与设计文档。

## 项目定位

微信 IM 桥插件：把微信接入 DeepSeek Harness，作为 `dsh-my-superagent` 的 IM 桥（协议 `my-superagent/v1`，经 `bridges.register` 注册），把交付渲染成微信消息送达主人，把主人的消息与作答回交核心。微信侧走腾讯 iLink 协议，**只以腾讯官方 `openclaw-weixin` 的接口与协议定义为参考、自写零依赖客户端**（ADR-0001）。插件为两半式结构：host 半跑在 DSH Host 进程内，client 半是 Web 设置面板；框架与构建门禁与 `dsh-im-infoflow` 同构。

## 代码结构

| 路径 | 内容 |
| --- | --- |
| `index.ts` | 包入口，只 re-export host 入口 |
| `src/host/index.ts` | Cordis 入口：只装配与接线 |
| `src/host/ilink/` | iLink 协议客户端：`types`/`api`（端点、请求头、错误分类）、`json`（64 位消息 id 保真）、`identity`（入站身份）、`login`、`poll`、`send`、`media`、`session-guard`；只用 Node 内置模块 |
| `src/host/superagent/` | `my-superagent/v1` 桥适配：`protocol`（结构描述，不 import 核心包）、`render`（Markdown 降级、交互转文字、分条）、`bridge`（`BridgeProvider`）、`link`（延后注册的 `BridgeBinder`） |
| `src/host/questions.ts`、`answer-text.ts`、`long-tasks.ts`、`host-agents.ts` | 自有功能（ADR-0006）：问题提醒与竞答、作答匹配、长任务提醒、根会话识别 |
| `src/host/state/` | 本机状态：登录态、长轮询游标、`context_token`；目录 `0700`、文件 `0600`、原子写 |
| `src/host/` | `index.ts` 入口、`runtime.ts` 装配与生命周期、`inbound.ts` 入站转换、`owner-channel.ts` 主人收发通道（收件人解析、主人判定、发送失败记账）、`panel-rpc.ts` 面板 RPC、`cli.ts` 出站命令逻辑（ADR-0012）、`config.ts` 配置、`host-context.ts` 宿主上下文最小类型 |
| `bin/dsh-wechat-send.mjs` | 出站命令入口，只把参数交给 `lib/src/host/cli.js`（ADR-0012） |
| `src/host/command.ts` | 斜杠命令 `/wechat`：人用入口，复用 `cli.ts` 的解析与发送端口（ADR-0012） |
| `src/client/` | Web 面板，esbuild 打成 `lib/client.js`，平台模块保持 external |
| `src/shared/` | 跨上下文的纯函数：版本常量、二维码编码器 |
| `test/unit/`、`test/fixtures/` | 单元测试与夹具 |
| `scripts/` | `build.mjs`（host tsc + client esbuild）、`verify-package.mjs`（打包自洽校验）、`dev-bridge.mjs`（不开面板的真机自测） |
| `docs/adr/` | 架构决策记录；`docs/local/` 只留本地，已 gitignore |

依赖方向：协议类型 ← 领域与桥适配 ← 装配入口。`ilink/` 不感知超级助理，`superagent/` 不感知传输细节，两者在装配层接线。

## 工程约定

- TypeScript strict，`erasableSyntaxOnly`：不用 enum、namespace、参数属性；相对 import 写 `.ts` 后缀。
- **零运行时依赖**：只用 Node 内置模块（`fetch`、`node:crypto` 等）；平台模块（`react`、`@deepseek-ai/*`）在 client 半 external。协议实现参考官方 `openclaw-weixin` 的接口定义自写，不把它或任何第三方插件代码作为依赖引入。
- **不引用、不复制、不提及任何第三方 DSH 微信插件仓库**；协议事实以官方实现与实测为准，出处写进 ADR。
- 宿主与核心服务一律用最小结构类型描述，不 import 宿主包与 `dsh-my-superagent` 的包。
- 外部输入（协议帧、面板 RPC 参数、配置文件）在边界按 Schema 校验，领域内部不再做防御式判空。
- 任何密钥、令牌、登录态不进日志、审计与面板快照；需要展示时只给「已设置」与状态。
- 子进程一律 argv 数组、不经 shell。
- 文件不超过约 500 行；超出先拆分再加功能。
- **自有功能与核心互斥**：`ownFeatures = 启用 && 未接入核心 && 已登录`。接入核心时不发自己的提醒，否则同一条提醒会来两遍（ADR-0006）；新增任何「主动提醒主人」的能力都要先过这个判据。
- 面板 RPC 契约版本（`HOST_CONTRACT` / `REQUIRED_CONTRACT`）两半必须一致：加端点或改返回结构时一起递增，否则「新面板 + 旧 host」会打到不存在的端点。
- 凭据与 `context_token` 不进日志、不进面板快照；面板只显示账号尾号（`accountTail`）。
- 注释只写实现逻辑与不明显的约束，不写演进过程。

## 开发流程

1. 关键决策先写 ADR（`docs/adr/NNNN-标题.md`，状态/背景/决策/后果四段）；新概念补进 ADR 索引。
2. 先写失败的测试，再写实现，再重构。测试断言行为，不断言实现细节；修 bug 先写能复现的测试。
3. 每完成几项功能，用 subagent 加载 `code-review-and-quality` 做隔离上下文的五轴评审（只读，不改文件）；评审结论全部处理，判断不修的写进 `docs/review/` 并说明理由（该目录 gitignore，不入库）。
4. 按功能或模块分别提交。commit 用 Conventional Commits 前缀加中文：一行标题，正文只在有额外事实时写 2 到 4 行，只写最终实现。只本地提交，不推送。

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
- 真机自测不必开面板：`node scripts/dev-bridge.mjs login` 在终端画二维码并落盘登录态，`node scripts/dev-bridge.mjs run` 起长轮询（对 `ping` 回 `pong`），走的是 `src/` 里同一套实现。
- 插件 info 日志只进 Cordis 内存缓冲，终端看不到；排障写测试复现或后续在面板看最近错误。
- 本项目的 OpenViking 记忆写入项目 peer `viking://user/xubingzhen/peers/github.com-xbzbing-dsh-im-wechat/`（由仓库 origin 自动派生），不写用户级记忆。

## 安全红线

- 登录态与 token 只落本机状态文件，权限收紧；不进日志、不进面板快照、不随包发布。
- 桥不解析命令、不判断身份：命令由核心解析，是不是主人由核心按配对绑定判断；桥只上报渠道内的发送者标识。
- 非主人的微信消息不解析命令；对外发言、授权类动作永远由核心决策，桥只负责呈现与转发。
- 协议实现只用官方 `openclaw-weixin` 定义的接口，不做逆向扩展、不携带凭据到第三方端点。
- 出站入口（`/wechat` 命令与 `dsh-wechat-send` 命令行）的收件人**恒为扫码登录的主人**，不提供指定收件人的参数：只解决「主人给自己发」，不新增「给第三方发言」的能力（ADR-0012）。
- 斜杠命令是给人用的（`dsh-commands` 契约：handler 不经过模型），**模型调不到**；要模型主动发只能走 CLI 或注册工具，别再试图用命令解决模型侧需求。
