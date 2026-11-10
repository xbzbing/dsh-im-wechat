# 0014. 跟随 openclaw-weixin 3.0.0-beta 的绑定兼容

- 状态：已采纳（协议细节与不跟进清单见 [iLink：登录与绑定](../protocol/ilink-登录与绑定.md)、[上游：openclaw-weixin](../protocol/上游-openclaw-weixin.md)）
- 日期：2026-11-09

## 背景

上游 `Tencent/openclaw-weixin` 发布 `3.0.0-beta-0`（尚未替换 `latest` 的 2.4.10），绑定链路有三处变化会影响第三方客户端：绑定过程要输入手机显示的 PIN、新增「连接本人 / 他人 Bot」的实名授权、`base_info.channel_version` 的前三段必须是上游版本。状态名、版本头编码、`bot_spam_ticket` 的用法见 [iLink：登录与绑定](../protocol/ilink-登录与绑定.md)。

本插件的扫码登录只服务「主人把自己的微信接进来」：扫码人就是主人，登录态里的 `ilink_user_id` 直接作为主人 id。没有「替别人绑定」的产品能力，也不应该为了跟进协议新增这种能力。

## 决策

- **只做本人绑定**：`get_bot_qrcode` 永远只带 `local_token_list`，不请求他人绑定、不调用实名 CGI、不带 `bot_spam_ticket`。实名授权是「连接他人 Bot」才需要的步骤，与本插件的「主人给自己发」模型不相干；上游把 `promptBindOwner` 的入口默认值调成 `true` 时也不需要跟随。
- **PIN 按「状态名包含 `need_verifycode`」判断**，不枚举具体状态名：上游随时可能再出同族状态，落进未知状态会一直轮询到登录总超时。旧状态名不再单独判断。
- **PIN 提交后保留，直到 `scaned`**：官方在收到 `need_verifycode` 后把号码暂存，之后每次轮询都带上，只有 `scaned` 才确认接受；中途遇到长轮询超时返回 `wait` 就丢掉号码，会让服务端永远等不到数字。按官方语义实现。
- **版本号对齐协议代次**：`channel_version` 上报 `3.0.0/dsh-im-wechat-<包版本>`，`iLink-App-ClientVersion` 按 `3.0.0` 编码。协议代次变化时只改 `ILINK_PROTOCOL_VERSION` 一处。
- **增加 `verifyPin` 静态开关**：打开后取码请求带 `bot_spam_business_data`，用于在服务端强制 PIN 之前验证完整交互。默认关闭；关闭它不能阻止服务端自行要求 PIN。
- **不跟进**上游的连续消息合并、失败提示开关、待处理消息日志、媒体下载取消总时限；逐项理由见 [上游：openclaw-weixin](../protocol/上游-openclaw-weixin.md)，其中「连续消息合并」若将来有真实需求要单独设计，不走协议兼容的路子。

## 后果

- 面板上的登录流程要能显示并提交 PIN；现有「验证码」输入框直接复用，不改 RPC 契约和面板版本。
- 服务端开始强制 PIN 后，主人会在扫码后多一步输入手机数字；这是微信侧的流程要求，不是插件新增的门槛。
- `channel_version` 的前缀从此是协议兼容性的一部分：上游换到 4.x 时只改 `ILINK_PROTOCOL_VERSION`，包版本继续放在后缀里。
- 真机验证 PIN 时把 profile 配置的 `verifyPin` 设为 `true`，重新发起登录；不打开时以服务端是否返回 `need_verifycode` 为准。
