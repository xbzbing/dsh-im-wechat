# dsh-im-wechat

把微信（WeChat，腾讯 iLink 协议）接入 DeepSeek Harness 的 IM 桥插件。

> **状态：功能可用（M0–M4）。** 协议客户端、桥适配、图片入站与 Web 面板均已实现并通过单测；真机验收清单见 [AGENTS.md](AGENTS.md)。设计决策见 [docs/adr/](docs/adr/README.md)。

## 定位

- 作为 `dsh-my-superagent` 的 IM 桥（协议 `my-superagent/v1`）：核心决定发什么，本插件决定怎么呈现；主人的消息与作答回交核心。
- 微信侧走腾讯 iLink：扫码登录、长轮询收消息、主动发送；实现只参考腾讯官方 `openclaw-weixin` 的接口与协议定义，自写零运行时依赖客户端（[ADR-0001](docs/adr/0001-基于openclaw-weixin的零依赖微信桥.md)）。
- 两半式插件：host 半（Node，协议与桥）+ client 半（Web 设置面板）。
- 只做桥，不做独立直聊（[ADR-0003](docs/adr/0003-一期只做桥不做独立直聊.md)）；图片只做入站（[ADR-0004](docs/adr/0004-图片入站与下载安全.md)）。

## 安装

```bash
dsh plugin --profile web add file:/Users/ankh/workspace/private/dsh-plugins/dsh-im-wechat
# host 半改动后重装生效：先 remove，等十几秒再 add
```

装好后在设置页找到「微信」：点「扫码登录」，用手机微信扫面板上的二维码（扫不了就复制链接在手机微信里打开），确认后状态变成「已登录」。登录态落在 `$DSH_HOME/dsh-im-wechat/login.json`（`0600`），不随包发布。

## 使用

- 主人在微信里发消息 → 插件把它交给核心，命令解析、主人判定都由核心做。
- 核心的交付 → 插件拍平成纯文本并发到微信；超过 1800 字按段分条。
- 没有交互卡：核心的问题与选项由插件写成文字，主人回复序号或文字即可作答。
- 面板上的两个开关：**接入微信（收消息）** 控制插件是否工作；**接入我的超级助理** 决定提醒由谁发——接入时由核心发，关掉后插件自己发问题提醒（与 Web 竞答）和长任务提醒（超过阈值，默认 30 分钟）到微信（[ADR-0006](docs/adr/0006-问题提醒与长任务提醒归谁发.md)）。
- 主人在微信里发的图片会作为附件交给核心（需要核心声明 `owner-images`）。

## 配置

profile 的 `cordis.patch.yml` 里按 loader id 叠加配置（改完重启 `dsh web`）：

```yaml
- id: dsh-im-wechat
  config:
    longTaskThresholdMinutes: 45   # 长任务提醒阈值（分钟），默认 30，范围 1–1440
    maxText: 1800                  # 单条消息字符上限，默认 1800
```

面板上的「接入微信（收消息）」「接入我的超级助理」与长任务阈值会落到
`$DSH_HOME/dsh-im-wechat/config.json`（`0600`），**优先于** profile 配置，卸载重装后沿用。

## 构建与验证

```bash
npm install
npm run check   # typecheck + test + verify

# 不开面板的真机自测（终端里画二维码、打印入站消息、对 ping 回 pong）
node scripts/dev-bridge.mjs login
node scripts/dev-bridge.mjs run
```

## 目录

- `src/host/ilink/` — iLink 协议客户端（类型、HTTP、登录、长轮询、发送、媒体）
- `src/host/state/` — 登录态、长轮询游标与 `context_token` 的本机持久化
- `src/host/superagent/` — `my-superagent/v1` 桥适配与呈现降级
- `src/host/runtime.ts`、`src/host/panel-rpc.ts` — 运行期装配与面板 RPC
- `src/client/` — Web 设置面板
- `src/shared/` — 跨上下文的纯函数（版本、二维码编码器）
- `docs/adr/` — 架构决策记录

## 许可

MIT
