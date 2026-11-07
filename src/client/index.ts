/**
 * 面板的插件注册入口。
 *
 * 打包形态：`scripts/build.mjs` 用 esbuild 把本目录打成单个 `lib/client.js`，
 * 外层是 `window.__ModuleLoader__.load({ id, factory })`，平台模块（`react`、
 * `react-dom`、`@deepseek-ai/*`）保持 external，由宿主的模块表提供。
 *
 * 注册两个槽位：
 * - `settings.section`：设置页里的完整面板；
 * - `plugins.bundle.config`：插件页里按包名分发的配置节（注册即表示要显示）。
 */

import { BUNDLE_CONFIG_SLOT, PACKAGE_NAME, PANEL_ID, SLOT_NAME } from './constants.ts';
import { en, NS, zh } from './locales.ts';
import type { Translate } from './locales.ts';
import { createRpcCall } from './logic.ts';
import { WeixinSettingsPanel } from './panel.ts';

export function apply(ctx: any): void {
  let t: Translate = (text: string) => text;

  if (typeof ctx.locale?.register === 'function') {
    ctx.effect(() => {
      let unregister: unknown;
      try {
        unregister = ctx.locale.register(NS, { zh, en });
      } catch (error) {
        // 命名空间已被占用：只可能来自同一插件的另一份实例（HMR 未释放或包名切换）。
        // 字典是同一份，复用既有注册即可；拿不到就直接抛出，不掩盖真问题。
        if (typeof ctx.locale.bind !== 'function') throw error;
        try {
          ctx.locale.bind(NS);
        } catch {
          throw error;
        }
        return () => {};
      }
      return () => {
        if (typeof unregister === 'function') unregister();
      };
    }, 'dsh-im-wechat: 面板文案');
    if (typeof ctx.locale.bind === 'function') t = ctx.locale.bind(NS) as Translate;
  }

  const rpcCall = createRpcCall(ctx.connection);
  // 组件不感知 ctx：依赖在注册时快照，与宿主设置页的注入方式一致。
  const dependencies = () => ({ t, rpcCall });
  const label = () => t('微信');

  if (typeof ctx.slots?.inject !== 'function' || typeof ctx.slots?.register !== 'function') return;

  ctx.effect(() => {
    const dispose = ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
      name: SLOT_NAME,
      id: PANEL_ID,
      order: 24,
      label,
      locale: NS,
      inject: dependencies,
    }, WeixinSettingsPanel));
    return () => dispose?.();
  }, 'dsh-im-wechat: 设置页');

  ctx.effect(() => {
    const dispose = ctx.slots.inject(BUNDLE_CONFIG_SLOT, () => ctx.slots.register({
      name: BUNDLE_CONFIG_SLOT,
      key: PACKAGE_NAME,
      locale: NS,
      inject: dependencies,
    }, WeixinSettingsPanel));
    return () => dispose?.();
  }, 'dsh-im-wechat: 插件页配置');
}

/** Cordis 客户端插件的名字：与包名一致（模块加载器的注册键也用它）。 */
export const name = PACKAGE_NAME;

/** 只依赖槽位、连接（RPC 载体）与文案。 */
export const inject = ['slots', 'connection', 'locale'] as const;
