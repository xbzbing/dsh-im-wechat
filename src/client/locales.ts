/**
 * 面板文案的对外表面。
 *
 * 两份字典分放在 `./locales/`：`zh.ts` 是键的唯一来源（`WeChatKey` 由它派生），
 * `en.ts` 按同一组键声明。这里只做聚合，并提供宿主文案服务缺席时的兜底翻译——
 * 面板要能单独降级，不能让用户看到 `panel.title` 这种键名。
 */

import { zh } from './locales/zh.ts';
import type { WeChatKey } from './locales/zh.ts';

export const NS = 'dsh-im-wechat';

export { en } from './locales/en.ts';
export { zh };
export type { WeChatKey };

/** 插值参数：`{name}` 占位符，规则与宿主的文案服务一致。 */
export type TranslateParams = Record<string, string | number>;

/** 翻译函数：键 + 可选插值参数。 */
export type Translate = (key: WeChatKey, params?: TranslateParams) => string;

/** 没有 `ctx.locale` 时的翻译：查中文，插值规则与宿主一致。 */
export function fallbackTranslate(key: WeChatKey, params?: TranslateParams): string {
  const template = zh[key];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}
