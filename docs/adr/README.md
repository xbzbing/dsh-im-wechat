# 设计决策索引：dsh-im-wechat

把微信（WeChat，腾讯 iLink 协议）接入 DeepSeek Harness、作为超级助理 IM 桥的插件。本目录存放架构决策记录（ADR），每篇独立可读；本文件只做导航、汇总与「还没定的事」。

## 一句话方案

**两半式 dsh 插件**：host 半跑在 DSH Host 进程内，包含自写的 iLink 协议客户端与 `my-superagent/v1` 桥适配；client 半是 Web 设置面板。微信侧用长轮询收消息、主动接口发消息，不需要公网回调地址；协议实现只参考腾讯官方 `openclaw-weixin` 的接口定义，零运行时依赖。

```mermaid
flowchart TD
    Owner["主人的微信"]
    ILink["腾讯 iLink 服务"]
    Poll["ilink 长轮询收消息"]
    Bridge["superagent 桥适配"]
    Core["dsh-my-superagent 核心"]
    Send["ilink 主动发送"]
    Panel["Web 设置面板 client 半"]

    Owner <-->|"消息"| ILink
    ILink -->|"长轮询"| Poll
    Poll --> Bridge
    Bridge -->|"receive / answer"| Core
    Core -->|"deliver"| Bridge
    Bridge --> Send
    Send --> Owner
    Panel -.->|"面板 RPC"| Bridge
```

## 决策清单

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-基于openclaw-weixin的零依赖微信桥.md) | 基于 openclaw-weixin 的零依赖微信桥 | 已采纳 |
| [0002](0002-登录态与二维码呈现.md) | 登录态与二维码呈现 | 已采纳 |
| [0003](0003-一期只做桥不做独立直聊.md) | 一期只做桥，不做独立直聊 | 已采纳 |
| [0004](0004-图片入站与下载安全.md) | 图片入站与下载安全 | 已采纳 |
| [0005](0005-交互以文字呈现.md) | 交互以文字呈现，不声明交互卡能力 | 已采纳 |
| [0006](0006-问题提醒与长任务提醒归谁发.md) | 问题提醒与长任务提醒归谁发 | 已采纳 |
| [0007](0007-输入状态.md) | 输入状态（正在输入） | 已采纳 |
| [0008](0008-微信原生Markdown与出站文本过滤.md) | 微信原生 Markdown 与出站文本过滤 | 已采纳 |
| [0009](0009-独立模式的直连会话.md) | 独立模式的直连会话 | 已采纳 |

## 还没定的事

- 出站发图（本期只做入站，见 ADR-0004 后果一节）。
- 真机实测后要修订的数字：连发限流条数、长轮询超时、`longpolling_timeout_ms` 的实际取值。
