# iLink：登录与绑定

扫码换凭据，凭据落本机状态文件——存哪里、谁能读、谁驱动登录是 [ADR-0002](../adr/0002-登录态与二维码呈现.md) 的决策，这里只记协议事实。

## 扫码

- `ilink/bot/get_bot_qrcode` 返回 `qrcode`（轮询用的标识）与 `qrcode_img_content`（二维码里要编码的**文本**，同时也是一个可打开的链接）。
- `ilink/bot/get_qrcode_status` 轮询到 `confirmed` 得到 `bot_token`、`ilink_bot_id`、`ilink_user_id` 与 `baseurl`。
- 二维码 **5 分钟** TTL；过期自动刷新，最多 3 次（官方实现的默认值）。
- 状态名与处理：

| 状态 | 含义 | 处理 |
| --- | --- | --- |
| `wait` | 还没扫 | 继续轮询；此时**丢掉**已暂存的 PIN |
| `scaned` | 已扫码 | 确认 PIN 被接受 |
| `need_verifycode` / `confirmed_but_need_verifycode` | 要输入手机上的 PIN | 等主人输入并提交，见下 |
| `scaned_but_redirect` | 扫码后要换轮询域名 | 只对本次登录轮询生效 |
| `binded_redirect` | 该微信号已绑定过 | 视为「已绑定」而非失败 |
| `confirmed` | 完成 | 落盘并开始长轮询 |

- 判断 PIN 需求时按「状态名**包含** `need_verifycode`」，不枚举具体状态名：上游 3.0.0-beta 新增 `confirmed_but_need_verifycode`，按固定名判断会把新状态当未知状态一直轮询到登录超时。
- PIN **提交后保留到 `scaned`**：官方在收到 `need_verifycode` 后把号码暂存，之后每次轮询都带上，只有 `scaned` 才确认接受。中途遇到长轮询超时返回 `wait` 就丢号，会让服务端永远等不到数字。

## 域名

- 带凭据（token / PIN）的请求只允许打到腾讯域名（`weixin.qq.com`、`qq.com` 及其子域），重定向与响应里给的地址同样要过这层白名单。
- 运行域名以 `confirmed` 返回的 `baseurl` 为准并落盘；未返回时退回 `https://ilinkai.weixin.qq.com`。

## 渠道版本头

- `base_info.channel_version` 的**前三段必须是 openclaw-weixin 的版本**，自有版本只能放在后缀里（例：`3.0.0/dsh-im-wechat-0.1.0`）。
- `iLink-App-ClientVersion` 按 `3.0.0` 编码成 `196608`（`major<<16 | minor<<8 | patch`）。
- 写成自己的 `0.1.0` 会被 Bot 后台判成不支持或 `0.0.0`；写成不存在的 `3.3.2` 同样不可取。协议代次变化时只改一处常量。
- 出处：上游 `docs/protocol_zh_CN.md`（3.0.0-beta-0）。

## 他人绑定（本项目不用）

上游 3.0.0-beta 增加「连接本人 / 他人 Bot」选择：他人 Bot 要先走实名授权并携带 `bot_spam_ticket`，入口由 `promptBindOwner` 控制。本插件的扫码只服务「主人把自己的微信接进来」，`get_bot_qrcode` 永远只带 `local_token_list`，不请求他人绑定、不调用实名 CGI。

`bot_spam_ticket` 的另一个用途是**主动验证 PIN 流程**：`bot_spam_business_data` 带 `base64({"verify_pin":1})` 可让服务端在正式强制前先要求 PIN。这只是调试开关（见 ADR-0014 的 `verifyPin`），不作为产品能力。

## 实测记录

- 2026-11-09，上游 `Tencent/openclaw-weixin` 发布 `3.0.0-beta-0`（`latest` 仍是 2.4.10），上述状态名与版本前缀规则来自该版本的 `docs/release-notes-bot-realname-auth_zh_CN.md`。
