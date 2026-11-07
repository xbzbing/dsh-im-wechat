/**
 * 面板用到的宿主原语（官方 UI）。
 *
 * 从模块表 `require('@deepseek-ai/dsh-client-ui-primitives')` 取；取不到时退回等价的
 * 朴素实现——插件是可选能力，白屏比少几个圆角严重得多。
 */

import { h, optionalRequire } from './platform.ts';

const UI = (optionalRequire('@deepseek-ai/dsh-client-ui-primitives') ?? {}) as Record<string, any>;

/** 官方按钮；缺失时退回原生 button（样式仍由我们的 class 兜住）。 */
export const Button: any = UI.Button ?? function ButtonFallback(props: any) {
  return h('button', props, props.children);
};

/** 官方开关；缺失时退回原生 checkbox。 */
export const Switch: any = UI.Switch ?? function SwitchFallback({ checked, onChange, label, disabled }: any) {
  return h('input', {
    type: 'checkbox',
    checked,
    disabled,
    'aria-label': label,
    onChange: (event: any) => onChange?.(event.target.checked),
  });
};

export const Input: any = UI.Input ?? function InputFallback(props: any) {
  return h('input', props);
};

/** 状态点：done / warning / ongoing / error / idle。 */
export const StateDot: any = UI.StateDot ?? function StateDotFallback() {
  return null;
};

export const Pill: any = UI.Pill ?? function PillFallback(props: any) {
  return h('span', { className: props.className }, props.children);
};

export const IconRefresh: any = UI.IconRefreshOutlineRegular ?? (() => null);
export const IconLink: any = UI.IconLinkOutlineRegular ?? (() => null);
export const IconCopy: any = UI.IconCopyOutlineRegular ?? (() => null);
export const IconLogout: any = UI.IconRightUpOutlineRegular ?? (() => null);

/** 复制到剪贴板：优先用官方 `writeClipboard`，退回复制 API。 */
export async function copyText(text: string): Promise<boolean> {
  const write = UI.writeClipboard as ((value: string) => Promise<unknown> | unknown) | undefined;
  if (typeof write === 'function') {
    await write(text);
    return true;
  }
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}
