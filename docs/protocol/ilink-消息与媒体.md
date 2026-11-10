# iLink：消息与媒体

字段与端点事实。边界与选择（下载白名单、上限、发图顺序）在 [ADR-0004](../adr/0004-图片入站与下载安全.md) 与 [ADR-0010](../adr/0010-出站发图.md)。

## 消息壳

- 发消息走 `ilink/bot/sendmessage`，`message_type` 为 `BOT`（机器人发言）。
- 主动发送必须回传主人最近一条消息带来的 `context_token`，过期后返回 `ret=-2`。窗口语义见 [ADR-0013](../adr/0013-声明推送窗口.md)。
- 消息条目在 `item_list` 里，`type = 2` 是图片。

## 入站图片

- 只给**密文引用**，没有字节：`image_item.media` 带 `encrypt_query_param`、`aes_key`、可选的 `full_url`。
- 少数帧在 `image_item.aeskey` 里另给一份十六进制密钥，**优先级高于** `media.aes_key`。
- 解密算法是 AES-128-ECB + PKCS#7（协议给定，不是选择）。
- `aes_key` 有两种编码，都要认：`base64(16 字节裸密钥)`，或 `base64(32 个十六进制字符)`。
- 取图地址：优先 `full_url`（须过域名白名单），否则用 CDN 基址拼 `download?encrypted_query_param=…`。

## 出站图片

四步，顺序不能乱：

1. `POST ilink/bot/getuploadurl`，带 `filekey`（16 字节随机数的十六进制）、`aeskey`（16 字节随机密钥的十六进制）、`media_type: 1`、`to_user_id`、`rawsize`、`rawfilemd5`、`filesize`、`no_need_thumb: true`。其中密文大小 `filesize = rawsize + 16 - rawsize % 16`。
2. 上传地址优先用响应里的 `upload_full_url`，否则按 `{cdnBaseUrl}/upload?encrypted_query_param=…&filekey=…` 拼。
3. 用该密钥做 AES-128-ECB + PKCS#7 加密，以 `Content-Type: application/octet-stream` POST 密文；下载参数从响应头 `x-encrypted-param` 取回。
4. 发 `message_type: BOT`、`item_list[0].type = 2` 的消息，`image_item` **只放** `media` 与 `mid_size`。

`image_item` 的字段是硬的，多一个少一个都不显示：

| 字段 | 值 | 说明 |
| --- | --- | --- |
| `media.encrypt_query_param` | 第 3 步拿到的下载参数 | |
| `media.aes_key` | `base64(32 个十六进制字符)` | **只有这一种形态** |
| `media.encrypt_type` | 固定 `1` | 客户端按它去取缩略图与尺寸元数据，缺了渲染不出来 |
| `mid_size` | 密文大小 | |
| `image_item.aeskey` | **不能带** | 客户端拿十六进制密钥直接解密，现象是灰块而不是报错 |

失败表现值得记住：少 `encrypt_type`、或多带顶层 `aeskey` 时，`sendmessage` 一样返回成功、核心回执一样是 `sent`，微信端**什么都不显示**或只出一个灰块——不是报错，所以只能靠真机核对。

## 输入状态（正在输入）

- `ilink/bot/getconfig` 按用户取 `typing_ticket`，请求要带该用户最近一条消息的 `context_token`。
- `ilink/bot/sendtyping` 带 ticket 发 `status=1`（开始输入）/ `status=2`（取消）；思考期间每 **5 秒**重发一次保活。
- ticket 按用户缓存 24 小时；取失败按 2 秒起指数退避（上限 1 小时）；`typing_ticket` 为空就不发。

真机实测（2026-11-08，微信 Mac + iOS）：

- 两端都显示「对方正在输入」。
- `getconfig` 的 `ilink_user_id` **大小写敏感**：传小写形式返回 `ret=-4 GetTypingTicket rpc failed`，必须用登录态里的规范大小写（入站 `from_user_id` 就是规范形态）。
- `sendtyping` 的 `status=1` / `status=2` 都返回 `ret=0`，服务端接受取消；但客户端在取消后仍会把状态**再展示约 10 秒**才消失。这是客户端的展示时长，协议层没有更早清除的手段。

## 出处

- 入站解密与出站上传对照腾讯官方 `openclaw-weixin` 的 `cdn/upload.ts`、`src/api/api.ts` 与 Dart SDK `weixin_clawbot` 的 `CdnMediaUploader`。
- `image_item` 字段表来自 2026-11-09 的真机反证：第一版按「社区实现」多带了顶层 `aeskey`、漏了 `encrypt_type`，结果是发送成功但微信端不显示。
