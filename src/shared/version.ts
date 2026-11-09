/**
 * 包的标识与版本。
 *
 * `package.json` 是权威来源，但产物布局是 `lib/src/**`，相对路径读 `package.json`
 * 会指错目录（安装后被换掉的那份才是真的），所以版本在这里落一个常量，由单测
 * 钉住它与 `package.json` 一致——漏改会红，不会静默漂移。
 */

export const PACKAGE_NAME = 'dsh-im-wechat';

export const PLUGIN_VERSION = '0.1.0';

/**
 * 跟随 openclaw-weixin 的协议代次。
 *
 * 协议规定 `base_info.channel_version` 的前三段必须是上游插件版本，自有版本
 * 只能放在后缀里（例如 `3.0.1/hermes-1.2.0`）。3.0.0-beta-0 这一代是 3.x，
 * 写成 `0.1.0` 会让 Bot 后台把客户端记成不支持或 0.0.0。
 */
export const ILINK_PROTOCOL_VERSION = '3.0.0';

/** 给服务端上报的客户端版本：上游代次 + 本插件版本。 */
export const CHANNEL_VERSION = `${ILINK_PROTOCOL_VERSION}/${PACKAGE_NAME}-${PLUGIN_VERSION}`;
