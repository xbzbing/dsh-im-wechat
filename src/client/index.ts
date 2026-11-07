/**
 * Web 面板入口（骨架占位）。
 *
 * 骨架阶段只保证构建与模块加载器注册成立（`id` 等于包名，从平台模块表取
 * React）；设置页内容随里程碑接入 `dsh-client-ui-settings` 与 `ui-slots`。
 */
import { createElement } from 'react';

/** 返回面板根元素的占位实现；真正的设置节在后续里程碑注册。 */
export function renderPanel(): unknown {
  return createElement('div', { 'data-plugin': 'dsh-im-wechat' });
}
