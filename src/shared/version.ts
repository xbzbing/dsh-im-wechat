/**
 * 包的标识与版本。
 *
 * `package.json` 是权威来源，但产物布局是 `lib/src/**`，相对路径读 `package.json`
 * 会指错目录（安装后被换掉的那份才是真的），所以版本在这里落一个常量，由单测
 * 钉住它与 `package.json` 一致——漏改会红，不会静默漂移。
 */

export const PACKAGE_NAME = 'dsh-im-wechat';

export const PLUGIN_VERSION = '0.1.0';
