/**
 * 超级助理桥适配（骨架占位）。
 *
 * 按 `my-superagent/v1` 协议向核心注册 `bridges`：`deliver` 把交付渲染成
 * 微信消息，`receive` 把主人消息原样交回核心。桥不解析命令、不判断身份，
 * 命令解析与主人判定都在核心（协议约定，ADR-0001）。类型只做结构描述，
 * 不 import dsh-my-superagent 的包。
 */
export {};
