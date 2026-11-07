# dsh-im-wechat

把微信（WeChat，腾讯 iLink 协议）接入 DeepSeek Harness 的 IM 桥插件。

> **状态：仓库骨架。** 结构与构建门禁已就位，协议客户端与桥适配随里程碑实现；设计决策见 [docs/adr/](docs/adr/README.md)，工作约定见 [AGENTS.md](AGENTS.md)。

## 定位

- 作为 `dsh-my-superagent` 的 IM 桥（协议 `my-superagent/v1`）：核心决定发什么，本插件决定怎么呈现；主人的消息与作答回交核心。
- 微信侧走腾讯 iLink：扫码登录、长轮询收消息、主动发送；实现只参考腾讯官方 `openclaw-weixin` 的接口与协议定义，自写零运行时依赖客户端（ADR-0001）。
- 两半式插件：host 半（Node，协议与桥）+ client 半（Web 设置面板）。

## 安装（开发中）

```bash
dsh plugin --profile web add file:/Users/ankh/workspace/private/dsh-plugins/dsh-im-wechat
# host 半改动后重装生效：先 remove 再 add，不需要重启 dsh
```

## 构建与验证

```bash
npm install
npm run check   # typecheck + test + verify
```

## 目录

- `src/host/ilink/` — iLink 协议客户端（登录、长轮询、发送、媒体）
- `src/host/superagent/` — `my-superagent/v1` 桥适配
- `src/client/` — Web 设置面板
- `docs/adr/` — 架构决策记录

## 许可

MIT
