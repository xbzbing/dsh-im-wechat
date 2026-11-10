# 上游：openclaw-weixin

本项目只参考上游的接口与协议定义自写客户端（[ADR-0001](../adr/0001-基于openclaw-weixin的零依赖微信桥.md)），不把上游包当依赖。跟随与不跟随的取舍记录在这里，避免同一件事被反复提。

## 版本节奏

- `latest` 为 `2.4.10`；`3.0.0-beta-0` 已发布但未替换 `latest`。
- 3.0.0-beta-0 对本项目有影响的三处变化（细节见 [iLink：登录与绑定](ilink-登录与绑定.md)）：
  1. 绑定过程要求输入手机显示的 PIN，状态名新增 `confirmed_but_need_verifycode`；
  2. 新增「连接本人 / 他人 Bot」选择，他人 Bot 要先走实名授权并携带 `bot_spam_ticket`；
  3. `base_info.channel_version` 明确前三段必须是 openclaw-weixin 的版本，自有版本只能放后缀。

## 刻意不跟随的项

| 上游变更 | 不跟随的理由 |
| --- | --- |
| 连续消息合并（#362） | 改的是「多条消息如何组成一轮」的产品语义，牵动游标、去重、附件顺序与独立模式的插话/排队，不是协议兼容问题。等出现「先发图再补问题」的真实需求时单独设计 |
| 失败提示开关（#366） | 本插件有自己的失败提醒（[ADR-0011](../adr/0011-失败立刻提醒.md)），不引入第二套提示 |
| 待处理消息日志与重启恢复 | 游标只在整批投递完成后推进，重启会重拉同一批，核心按 `(bridge, messageId)` 去重；已经是 at-least-once，不需要再落一份原始消息日志 |
| 媒体下载取消总时限 | 上游面向语音、视频等大媒体且把处理与轮询解耦；本插件只下载 ≤10 MiB 图片、下载仍阻塞轮询，保留总时限是刻意的取舍 |

其中「连续消息合并」是唯一可能回头做的项；其余三项若上游后续成为强制行为（而不是可选能力），要重新评估。

## 出处

- 上游：`Tencent/openclaw-weixin` 的 `docs/release-notes-bot-realname-auth_zh_CN.md`、`docs/protocol_zh_CN.md`（3.0.0-beta-0）、`src/messaging/markdown-filter.ts`、`cdn/upload.ts`。
- 本项目跟进这些变化的那一轮提交见 `feat(登录): 适配 openclaw-weixin 3.0.0-beta 的 PIN 与版本规则`。
