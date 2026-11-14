# dsh-im-wechat

把微信（WeChat，腾讯 iLink 协议）接入 DeepSeek Harness 的插件。**两种用法：独立安装**（不装核心插件，微信直接驱动 DSH 会话）**或接入我的超级助理**（作为 `dsh-my-superagent` 的 IM 桥）。

> **状态：功能可用。** 协议客户端、独立模式直连会话、桥适配、图片入站与 Web 面板均已实现并通过单测；真机验收清单在本地 `docs/local/20261107-验收清单.md`（不入库，仅开发机可见）。设计决策见 [docs/adr/](docs/adr/README.md)。

## 两种部署方式

装哪个都不影响扫码登录和面板；差别在「消息由谁处理、提醒由谁发」：

| 能力 | 独立安装（不装核心插件） | 接入我的超级助理 |
| --- | --- | --- |
| 扫码登录、设置面板 | 支持 | 支持 |
| 微信里发文字 → DSH 会话 | 支持（面板里选工作区，首次消息建会话并复用） | 支持（核心的前台会话） |
| 回合在跑时再发一条 | 支持，面板可选排队或插话 | 支持，核心的 `front.submitMode` 决定 |
| 问题提醒、长任务提醒 | 插件自己发 | 核心发 |
| 在微信里回复问题作答 | 支持 | 支持（经核心） |
| 命令解析、主人判定 | 不解析命令；主人由扫码登录的登录态认定 | 由核心做 |
| 图片作为附件入站 | 支持（只收主人发的图，[ADR-0017](docs/adr/0017-独立模式的图片入站.md)） | 核心声明 `owner-images` 且判明是主人才支持 |

## 定位

- 微信侧走腾讯 iLink：扫码登录、长轮询收消息、主动发送；实现只参考腾讯官方 `openclaw-weixin` 的接口与协议定义，自写零运行时依赖客户端（[ADR-0001](docs/adr/0001-基于openclaw-weixin的零依赖微信桥.md)）。
- 两半式插件：host 半（Node，协议、会话直连与桥）+ client 半（Web 设置面板）。
- 接入核心时只做桥：不解析命令、不判断身份，消息与作答回交核心（[ADR-0003](docs/adr/0003-一期只做桥不做独立直聊.md)）。
- 不装核心时走独立模式：主人发的文字与图片直接提交到绑定的 DSH 会话，回答发回微信，回合在跑时可选插话或排队（[ADR-0009](docs/adr/0009-独立模式的直连会话.md)）。两种模式互斥，接入核心后独立模式整段沉默。
- 图片只做入站：核心模式要核心声明 `owner-images`、并经 `owner-lookup` 判明发送者是主人才下载（声明缺席一律按纯文本，[ADR-0004](docs/adr/0004-图片入站与下载安全.md)）；独立模式由登录态判明主人后同样下载成附件（[ADR-0017](docs/adr/0017-独立模式的图片入站.md)）。

## 安装

```bash
# 1) 从 npm 装正式版（推荐）
dsh plugin --profile web add dsh-im-wechat@0.1.0

# 2) 或装 GitHub Release 上的 tgz：不用构建，产物由 CI 打好
dsh plugin --profile web add https://github.com/xbzbing/dsh-im-wechat/releases/download/v0.1.0/dsh-im-wechat-0.1.0.tgz

# 3) 或装本地仓库的当前源码：先构建，再装
cd /Users/ankh/workspace/private/dsh-plugins/dsh-im-wechat
npm install && npm run build          # lib/ 不入库，必须先构建
dsh plugin --profile web add file:/Users/ankh/workspace/private/dsh-plugins/dsh-im-wechat

# host 半改动后重装生效：先 remove，等十几秒再 add
dsh plugin --profile web remove dsh-im-wechat
```

- **官方产物有两条，都带 `lib/`**：npm 上的版本，和 GitHub Release 上同名同版本的 `<包名>-<版本>.tgz` 附件。两者都由 CI 在门禁之后打包（[ADR-0020](docs/adr/0020-发布走CI与npm可信发布.md)），装哪一种都不需要本地构建。
- **本地源码安装要先构建**：`lib/` 是构建产物、不入库，`prepack` 只在 `npm pack` / `npm publish` 时跑。`file:` 安装是把目录按 `files` 清单复制进 profile，**不会**帮你构建，也不读软链接——没有 `lib/` 时装出来的包没有入口，插件加载报 `Cannot find module .../lib/index.js`。
- `file:` 复制的是安装那一刻的产物：改完源码要 `npm run build` 再卸载重装，仓库里的 `lib/` 变了不会自动同步到已装的 profile。
- **独立安装**：只装本插件即可，不需要 `dsh-my-superagent`。面板会显示「未接入超级助理」，插件按独立模式工作。
- **接入我的超级助理**：先装好 `dsh-my-superagent`，再装本插件，然后在「微信」面板打开 **接入我的超级助理**。核心接管消息、命令、会话与提醒，独立模式那一组设置自动折叠、不生效。

新装即生效：loader 直接载入，不用重启 `dsh web`，刷新设置页就能看到「微信」。

装好后在设置页找到「微信」：点「扫码登录」，用手机微信扫面板上的二维码（扫不了就复制链接在手机微信里打开），确认后状态变成「已登录」。如果微信要求绑定 PIN，面板会提示输入手机微信显示的数字，提交后继续完成登录。登录态落在 `$DSH_HOME/.dsh-im-wechat/login.json`（`0600`），重启或重装后沿用，不随包发布。

## 插件特性

- **登录与收发**：手机微信扫码确认即可登录；长轮询收消息（文字与图片）、主动接口发消息（文字与图片），不需要公网地址和回调域名。
- **绑定 PIN**：微信要求绑定 PIN 时，面板提示输入手机显示的数字；`verifyPin: true` 可在服务端强制之前提前验证这条链路（[ADR-0014](docs/adr/0014-跟随openclaw-weixin-3.0.0-beta的绑定兼容.md)）。
- **Markdown 原样透传**：微信客户端原生渲染 Markdown，表格、代码块、标题、列表、链接都按原样显示；图片、`#####`/`######`、中文斜体与删除线的标记会被剔除（[ADR-0008](docs/adr/0008-微信原生Markdown与出站文本过滤.md)）。单条超过 1500 字节按段分条（约 500 个中文字；`maxText` 可配，按 UTF-8 字节计）。
- **独立模式直连会话**：面板里从宿主的工作区列表选一个工作区；首条消息在那里建会话并复用，回答发回微信；回合正在跑时默认插话，可在面板改回排队；可随时「重置绑定」换会话（[ADR-0009](docs/adr/0009-独立模式的直连会话.md)）。
- **问题提醒**：题目与选项写成文字发到微信，回复序号或文字就能作答；微信与 Web 竞答，谁先答用谁，另一边自动收起；30 分钟没人答自动交回 Web 端。
- **长任务提醒**：超过阈值（默认 30 分钟，面板可改）的回合结束时，推送标题、耗时与最后结论。**失败立刻提醒**：报错、被拦、非主人中止的回合不看阈值、立刻推送（主人自己停的不发）（[ADR-0011](docs/adr/0011-失败立刻提醒.md)）。
- **只打扰该打扰的人**：只提醒主人和根会话，子代理的提问与回合不打扰。
- **不重复提醒**：接入我的超级助理后插件自动让位，问题与长任务提醒交给核心（[ADR-0006](docs/adr/0006-问题提醒与长任务提醒归谁发.md)）。
- **正在输入**：消息交给会话后、首段回答送达前，微信那头显示「正在输入」；真机行为不符预期时可用 `typingIndicator: false` 关掉（[ADR-0007](docs/adr/0007-输入状态.md)）。
- **出站快捷命令**：`dsh-wechat-send` 把文本或图片直接发到主人微信，模型在任意会话里一条命令即可，不用读插件源码（[ADR-0012](docs/adr/0012-出站快捷命令.md)）。
- **present 的图片自动发到微信**：独立模式下，模型在会话里 `present` 的本地图片会直接发到主人的微信（只发图片，单张 ≤ 10 MiB、一次 ≤ 10 张）（[ADR-0019](docs/adr/0019-present的图片自动发到微信.md)）。
- **设置面板**：扫码登录、开关渠道、选工作区、改长任务阈值，并查看账号尾号、绑定会话、提醒来源与最近错误；中文默认，跟随宿主浅色/深色主题。

## 使用

### 接入我的超级助理

- 主人在微信里发消息 → 插件交给核心，命令解析、主人判定都由核心做；核心受理后到首段交付送达前显示「正在输入」。
- 核心的交付 → 插件按 Markdown 透传发到微信，超过 1500 字节分条。
- 主人太久没开口时 `context_token` 会过期（窗口声明为 24 小时，实测 18 小时龄仍可发送），交付先挂起、等主人下次发消息再送达；桥已向核心声明这个窗口，核心会跳过硬发（[ADR-0013](docs/adr/0013-声明推送窗口.md)，数值由 [ADR-0015](docs/adr/0015-推送窗口改为24小时.md) 修订为 24 小时）。
- 没有交互卡：核心的问题与选项由插件写成文字，主人回复序号或文字即可作答。
- 主人在微信里发的图片会作为附件交给核心（需要核心声明 `owner-images` 且判明是主人，否则按纯文本）。
- 面板上的两个开关：**接入微信（收消息）** 控制插件是否工作；**接入我的超级助理** 决定消息与提醒归谁——打开时由核心处理，关闭后插件自己发问题提醒（与 Web 竞答）和长任务提醒。

### 独立模式

- 面板「独立模式」里选工作区：默认是 `$DSH_HOME/dsh-im-wechat` 下自动创建的「微信会话」，也可以换成宿主里已有的工作区。首条微信消息在所选工作区的目录里新建一个会话，之后一直用它。
- 这个工作区目录与会话的 cwd 是同一个位置，里面**没有**任何凭据：登录态与面板设置放在另一个目录 `$DSH_HOME/.dsh-im-wechat`（[ADR-0021](docs/adr/0021-状态目录与默认工作区分离.md)）。
- 之后主人发的文字与图片直接提交给该会话，回答发回微信；「当前会话」里能看到绑定的会话与运行状态。模型 `present` 的本地图片会自动发到微信，不用它知道 CLI。
- 图片（png / jpeg / webp / gif，单张 ≤ 10 MiB，一次最多 9 张）作为附件交给会话；只有图没有字时补一句「请看这张图」，下载失败的图当这条没有图（[ADR-0017](docs/adr/0017-独立模式的图片入站.md)）。
- 绑定会话的模型需要支持图片输入；不支持时图片会被拒收、文字照常送达，并回一句「图片没有发出去」。
- 「回合内插话」默认打开：回合正在跑也会把新消息插进去（尽力而为，宿主窗口已关时退化成排队）；关掉才排队等这一轮结束。
- 换工作区或想开新会话：点「重置绑定」，下一条消息按新设置重建。
- 独立模式不解析命令、不判身份（只认扫码登录的主人）；需要命令解析与核心的主人判定请接入 `dsh-my-superagent`。

## 出站入口（命令 / 命令行）

同一套发送实现有两个入口，按「谁发起」选（[ADR-0012](docs/adr/0012-出站快捷命令.md)）：

| 入口 | 谁用 | 说明 |
| --- | --- | --- |
| 斜杠命令 `/wechat` | 主人 | 在输入框自己发，可直接拖图片；**模型调不到**（命令不经过模型） |
| `dsh-wechat-send` | 模型 / 脚本 | 模型用 bash 调用；普通会话里发图就走这条 |

命令用法：

```text
/wechat status                     查看登录态与能不能发
/wechat 构建已完成                  发一条文本
/wechat image ./a.png ./b.png       发本地图片
/wechat 四张头像 + 拖入图片          发输入框里的图片，附一句说明
```

命令行用法：

```bash
dsh-wechat-send status                       # 登录态、收件人与 context_token 是否可用
dsh-wechat-send text '构建已完成'
dsh-wechat-send image ./a.png ./b.png --text '四张头像'
```

- 收件人固定是扫码登录的主人，**没有** `--to`。
- 图片先发、正文后发；支持 png / jpeg / webp / gif，单张 ≤ 10 MiB，一次 ≤ 10 张。
- 退出码：`0` 成功、`1` 发送或前置条件失败、`2` 参数写错。
- profile 的 `node_modules/.bin` 不在 `PATH` 上，接一下就能直接敲：

```bash
ln -sf ~/.dsh/profiles/web/node_modules/dsh-im-wechat/bin/dsh-wechat-send.mjs ~/.local/bin/dsh-wechat-send
```


唯一会卡住的情况：`status` 报缺少 `context_token`——iLink 协议要求主人最近给机器人发过消息。此时不要重试，先在微信里发一条，再执行。

## 配置

profile 的 `cordis.patch.yml` 里按 loader id 叠加配置：

```yaml
- id: dsh-im-wechat
  config:
    enabled: true                     # 静态默认「接入微信（收消息）」，面板值优先
    superagent: true                  # 静态默认「接入我的超级助理」，面板值优先
    longTaskThresholdMinutes: 45      # 长任务提醒阈值（分钟），默认 30，范围 1–1440
    maxText: 1500                     # 单条消息上限，按 UTF-8 字节计，默认 1500
    typingIndicator: true             # 「正在输入」状态，默认开（ADR-0007）
    verifyPin: false                  # 取码时强制服务端出 PIN，仅用于提前验证（ADR-0014）
```

其余键（`dataDir`、`baseUrl`、`cdnBaseUrl`、`botAgent`、`directWorkspaceId`、`directBusyMode`）见 `src/host/config.ts`。

面板上改的设置（接入微信、接入我的超级助理、长任务阈值、独立模式的工作区与提交方式）落在
`$DSH_HOME/.dsh-im-wechat/config.json`（`0600`）；独立模式的会话绑定在 `direct.json`（同目录）。两者都**优先于** profile 配置，卸载重装后沿用。

## 构建与验证

```bash
npm install
npm run check   # typecheck + test + verify

# 不开面板的真机自测（终端里画二维码、打印入站消息、对 ping 回 pong）
node scripts/dev-bridge.mjs login
node scripts/dev-bridge.mjs run

# 提前验证绑定 PIN：先 export DSH_WECHAT_VERIFY_PIN（值为 1），再执行上面的 login
```

## 发布

发布由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 在 master 上执行（[ADR-0020](docs/adr/0020-发布走CI与npm可信发布.md)）：门禁 → 打 tag → `npm publish`（可信发布，OIDC，不存 `NPM_TOKEN`）→ GitHub Release（附同一个 tgz）。**不要手工打 tag，也不要在本地 `npm publish`**。

```bash
# 1. 版本号：package.json 与 package-lock.json 两处一起改
#    带 - 的是预发布（0.2.0-rc.1）：只打 tag + 建 GitHub 预发布，不发 npm
npm version <v> --no-git-tag-version

# 2. 正文：稳定版与预发布都要写，和版本号一起提交
$EDITOR docs/releases/v<v>.md
git add package.json package-lock.json docs/releases/v<v>.md
git commit -m "chore: release v<v>"
```

正文骨架见 [`.github/RELEASE_TEMPLATE.md`](.github/RELEASE_TEMPLATE.md)。中途失败直接重跑 `gh workflow run release.yml`，已完成的步骤会跳过。

## 目录

- `src/host/ilink/` — iLink 协议客户端（类型、HTTP、登录、长轮询、发送、媒体）
- `src/host/direct.ts`、`src/host/state/direct-binding.ts` — 独立模式的直连会话与绑定
- `src/host/state/` — 登录态、长轮询游标、`context_token` 与会话绑定的本机持久化
- `src/host/superagent/` — `my-superagent/v1` 桥适配与 Markdown 呈现
- `src/host/runtime.ts`、`src/host/runtime-status.ts`、`src/host/inbound-pipeline.ts`、`src/host/panel-rpc.ts` — 运行期装配、状态视图、入站流水线与面板 RPC
- `src/host/questions.ts`、`long-tasks.ts`、`typing.ts`、`answer-text.ts`、`host-agents.ts` — 自有问题提醒、长任务提醒、输入状态与根会话识别
- `src/host/cli.ts`、`bin/dsh-wechat-send.mjs` — 出站快捷命令（ADR-0012）
- `src/client/` — Web 设置面板
- `src/shared/` — 跨上下文的纯函数（版本、二维码编码器、提问提示语、文件行数上限）
- `src/host/command.ts` — 斜杠命令 `/wechat`（人用；与 CLI 共用发送实现）
- `docs/adr/` — 架构决策记录

## 已知限制

- **`supersedes` 不会撤回或改写已发出的微信消息**：微信没有编辑消息的能力，桥也没有声明 `edit`；核心把旧交付标成被取代时，主人手里的旧消息仍在。
- **高频交付与核心的 30 秒预算不总是对齐**：平台限制约 10 条/分钟，超过 10 段（约 15,000 字节）的交付必然要等 60 秒；核心的 deliver 超时是 30 秒，超时后可能把这条记为 `uncertain`，桥随后发出的真实回执会被丢弃。桥这边已给单请求加超时、给整条交付加 10 分钟总截止；核心侧的预算调整另开。
- **重启后可能重复发送**：断点进度与幂等回执只在内存里。桥进程重启后，核心重试同一个 `delivery.id` 会从头再发一遍；这是有意的取舍——宁可重复，也不假装发过。
- **`expiresAt` 只由核心在发送前检查**：桥收到就发，不在发送过程中重新判过期；核心的重试窗口很短，这个竞态暂不处理。

## 许可

MIT
