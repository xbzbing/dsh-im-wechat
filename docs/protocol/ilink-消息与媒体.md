# iLink：消息与媒体

字段与端点事实。边界与选择（下载白名单、上限、发图顺序）在 [ADR-0004](../adr/0004-图片入站与下载安全.md) 与 [ADR-0010](../adr/0010-出站发图.md)。

## 消息壳

- 发消息走 `ilink/bot/sendmessage`，`message_type` 为 `BOT`（机器人发言）。
- 主动发送必须回传主人最近一条消息带来的 `context_token`，过期后返回 `ret=-2`。腾讯没有公开窗口时长，公开口径是 24 小时（第三方渠道一致：24 小时内、每 10 条需用户再开口），本机实测 14.4 小时与 18.0 小时龄仍可发送。声明见 [ADR-0013](../adr/0013-声明推送窗口.md)，数值由 [ADR-0015](../adr/0015-推送窗口改为24小时.md) 修订为 24 小时。
- 窗口内条数额度：公开口径（PushPlus、MagicPush、曲辕）一致为「每 10 条需用户再开口一次」，腾讯无公开规范、本机未做定量实测。桥声明 `outbound.maxMessagesPerWindow = 10` 并在回执里上报 `messagesSent`，由核心在额度将尽时请求续约（[ADR-0016](../adr/0016-声明条数额度并由核心请求续约.md)）。
- `ret=-2 prepare failed` 不专指 token 过期：单条正文过长（官方仓库实测 5000 字符可发、7337 字符被拒）同样返回这一句，别用它区分「窗口关了」与「消息太长」。
- 消息条目在 `item_list` 里，`type = 2` 是图片。

## 发送响应与引用回指

- `ilink/bot/sendmessage` 成功时返回平台侧消息 id：`{ message_id?: string }`（uint64 on the wire，按字符串无损解析）。核心把它写进投递回执 `bridgeMessageId`，用来把用户后来的引用认回这次交付。
- 入站引用在 `item_list[].ref_msg` 里，两种形态都要认，**优先级 `svr_id` 高于 `message_item.msg_id`**：
  - `ref_msg.svr_id`：新版客户端只带这个，不带被引用消息的正文或媒体；
  - `ref_msg.message_item.msg_id`：旧版形态；`title` 只是展示文案，不是 id。
  - `ref_msg` 里没有可用 id 时，桥不猜，草稿不带 `replyTo`。
- 三个 id（`message_id`、`msg_id`、`svr_id`）都可能是 64 位整数，解析时按无损字符串处理（`ilink/json.ts` 的 `INTEGER_KEYS`）；取整会认到错的那条交付。

## 请求壳与 `bot_agent`

- 每个请求都带 `base_info: { channel_version, bot_agent }`，长轮询、发消息、上传、`getconfig`、`sendtyping` 一视同仁。
- `bot_agent` 是 UA 形态的观测标识：**不参与鉴权，也不控制消息路由**（官方 README 原文）。同一实例下所有 agent 共享一个值，按来源区分做不到。
- 规范：一个或多个 `Name/Version` token 空格分隔，每个可跟 ` (comment)`；仅 ASCII，总长 ≤256 字节；不合规片段在客户端清洗时静默丢弃，清洗后为空回退产品默认（官方回退 `OpenClaw`）。
- 本插件的默认值 `dsh-im-wechat/<插件版本>`，可用插件配置 `botAgent` 覆盖；有效值在启动时落盘 `bot-agent.json`，`dsh-wechat-send` 读同一份，保证两处发出的 UA 一致（命令是独立进程，读不到宿主 profile 的插件配置）。

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
