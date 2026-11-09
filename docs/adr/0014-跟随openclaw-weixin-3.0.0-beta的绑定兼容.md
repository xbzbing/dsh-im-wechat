# 0014. 跟随 openclaw-weixin 3.0.0-beta 的绑定兼容

- 状态：已采纳
- 日期：2026-11-09

## 背景

上游 `Tencent/openclaw-weixin` 发布 `3.0.0-beta-0`（尚未替换 `latest` 的 2.4.10），绑定链路有三处变化会影响第三方客户端：

1. 微信将要求绑定过程中输入手机显示的 PIN，状态名新增 `confirmed_but_need_verifycode`；
2. 新增「连接本人 / 他人 Bot」选择，他人 Bot 要先走实名授权并携带 `bot_spam_ticket`；
3. 协议明确 `base_info.channel_version` 的**前三段必须是 openclaw-weixin 的版本**，自有版本只能放在后缀里（如 `3.0.1/hermes-1.2.0`），这一代是 `3.x.x`。

本插件的扫码登录只服务「主人把自己的微信接进来」：扫码人就是主人，登录态里的 `ilink_user_id` 直接作为主人 id。没有「替别人绑定」的产品能力，也不应该为了跟进协议新增这种能力。

## 决策

- **只做本人绑定**：`get_bot_qrcode` 永远只带 `local_token_list`，不请求他人绑定、不调用实名 CGI、不带 `bot_spam_ticket`。实名授权是「连接他人 Bot」才需要的步骤，与本插件的「主人给自己发」模型不相干。上游把 `promptBindOwner` 的入口默认值调成 `true` 时也不需要跟随。
- **PIN 按「状态名包含 `need_verifycode`」判断**：`confirmed_but_need_verifycode` 说明绑定已确认但还差一次 PIN，落进未知状态会一直轮询到登录总超时。旧状态名不再单独判断，避免下次再出同族状态。
- **PIN 提交后保留，直到 `scaned`**：官方在收到 `need_verifycode` 后把号码暂存，之后每次轮询都带上，只有 `scaned` 才确认接受。中途遇到长轮询超时返回 `wait` 就丢掉号码，会让服务端永远等不到数字；这一条按官方语义实现。
- **版本号对齐协议代次**：`channel_version` 上报 `3.0.0/dsh-im-wechat-<包版本>`，`iLink-App-ClientVersion` 按 `3.0.0` 编码成 `196608`。此前写成自己的 `0.1.0` 会被 Bot 后台判成不支持或 `0.0.0`；写成不存在的 `3.3.2` 同样不可取。协议代次变化时只改 `ILINK_PROTOCOL_VERSION` 一处。
- **增加 `verifyPin` 静态开关**：打开后取码请求带 `bot_spam_business_data`（`base64({"verify_pin":1})`），用于在服务端强制 PIN 之前验证完整交互。默认关闭；关闭它不能阻止服务端自行要求 PIN。

本轮**不跟进**、并说明理由的项：

- **连续消息合并（#362）**：改变的是「多条消息如何组成一轮」的产品语义，牵动游标、去重、附件顺序与独立模式的插话/排队，不是协议兼容问题；等有明确的「先发图再补问题」需求时单独设计。
- **失败提示开关（#366）**：本插件有自己的失败提醒（ADR-0011），不引入第二套提示。
- **待处理消息日志与重启恢复**：本插件的游标只在整批投递完成后推进，重启会重拉同一批，核心按 `(bridge, messageId)` 去重；已有 at-least-once 语义，不需要再落一份原始消息日志。
- **媒体下载取消总时限**：上游面向语音/视频等大媒体且处理与轮询解耦；本插件只下载 ≤10 MiB 图片，下载仍会阻塞轮询，保留总时限是刻意的取舍。

## 后果

- 面板上的登录流程要能显示并提交 PIN；现有「验证码」输入框直接复用，不改 RPC 契约和面板版本。
- 服务端开始强制 PIN 后，主人会在扫码后多一步输入手机数字；这是微信侧的流程要求，不是插件新增的门槛。
- `channel_version` 的前缀从此是协议兼容性的一部分：上游换到 4.x 时只改 `ILINK_PROTOCOL_VERSION`，包版本继续放在后缀里。
- 真机验证 PIN 时把 profile 配置的 `verifyPin` 设为 `true`，重新发起登录；不打开时以服务端是否返回 `need_verifycode` 为准。

## 相关

- 上游说明：`Tencent/openclaw-weixin` 的 `docs/release-notes-bot-realname-auth_zh_CN.md`、`docs/protocol_zh_CN.md`（3.0.0-beta-0）
- ADR-0002（登录态与二维码呈现）、ADR-0004（图片下载边界）
- `src/host/ilink/login.ts`（PIN 状态机）、`src/host/ilink/api.ts`（取码与版本头）、`src/shared/version.ts`（协议代次）
