/**
 * 面板用到的宿主原语（官方 UI）。
 *
 * 从模块表 `require('@deepseek-ai/dsh-client-ui-primitives')` 取；取不到时退回等价的
 * 朴素实现——插件是可选能力，白屏比少几个圆角严重得多。
 */

import { MENU_SURFACE_CLASS, menuSurfaceStyle, placeMenu } from './logic.ts';
import { h, optionalRequire, useCallback, useEffect, useRef, useState } from './platform.ts';

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

export const MenuSurface: any = UI.MenuSurface ?? function MenuSurfaceFallback(props: any) {
  return h('div', props, props.children);
};

/**
 * 官方悬停提示；缺失时退回原生 `title`。
 *
 * 官方浮层由宿主统一排版（深色气泡、层级与定位），调用方只决定 `side` 与延迟。
 */
export const Tooltip: any = UI.Tooltip ?? function TooltipFallback({ label, children }: any) {
  return h('span', { title: label }, children);
};

export const IconCheck: any = UI.IconCheckOutlineRegular ?? (() => null);
export const IconChevronDown: any = UI.IconChevronDownOutlineRegular ?? (() => null);
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

// ------------------------------------------------------------ 弹层

/**
 * 居中弹层：遮罩铺满视口，卡片接管焦点。
 *
 * 打开时把焦点移进卡片并把页面滚动锁住，关闭后焦点还给原来的触发器；Esc、点遮罩都
 * 交给 `onClose`，由调用方决定「关闭」是取消登录还是只收起。焦点陷阱只做首尾回环：
 * 卡片自己（tabIndex=-1）是起点，Tab 进入第一个可聚焦元素。
 */
export function Dialog(props: any) {
  const { open, label, onClose } = props;
  const cardRef = useRef<any>(null);
  const restoreRef = useRef<any>(null);
  // 关闭回调每次渲染都是新函数：放进 ref，effect 只在开关变化时跑，免得反复抢焦点。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    restoreRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: any) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const root = cardRef.current;
      if (!root) return;
      const nodes = Array.from(root.querySelectorAll(
        'button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])',
      )) as any[];
      const focusable = nodes.filter((node) => node.disabled !== true && node.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    const focusCard = () => cardRef.current?.focus?.();
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(focusCard) : (focusCard(), 0);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      const previous = restoreRef.current;
      restoreRef.current = null;
      if (previous && typeof previous.focus === 'function') previous.focus();
    };
  }, [open]);

  if (!open) return null;
  const mask = h('div', {
    className: 'wx-dialog-mask',
    onClick: (event: any) => {
      if (event.target === event.currentTarget) closeRef.current?.();
    },
  }, h('div', {
    ref: cardRef,
    className: 'wx-dialog',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': label,
    tabIndex: -1,
  }, props.children));
  return portal ? portal(mask, document.body) : mask;
}

// ------------------------------------------------------------ 下拉菜单

/**
 * dsh 风格的下拉：触发器 + 官方 `MenuSurface` 浮层。
 *
 * 浮层用 portal + `position: fixed`：设置页外层可滚动，绝对定位会被祖先的 overflow
 * 裁掉。菜单不自己收：选中后由调用方 `onChange`，组件随即关闭。
 */
const MENU_PLACEMENT = { minWidth: 240, maxHeight: 320, gap: 4, padding: 12 } as const;

const ReactDOM = optionalRequire('react-dom');
const portal = typeof ReactDOM?.createPortal === 'function' ? ReactDOM.createPortal : null;

/** 浮层里的选项列表：外层 MenuSurface 给材质，内层 div 收键盘与焦点。 */
export function OptionMenu({ label, items, value, disabled, onSelect, onKeyDown, menuRef, placement }: any) {
  const entries = (items ?? []).map((item: any) => h('button', {
    key: item.value,
    type: 'button',
    role: 'menuitemradio',
    'aria-checked': item.value === value,
    className: 'wx-menu-item',
    title: item.hint ? `${item.label} — ${item.hint}` : item.label,
    disabled: disabled === true,
    onClick: () => onSelect?.(item.value),
  },
  h('span', { className: 'wx-menu-item-copy' },
    h('span', { className: 'wx-menu-item-label' }, item.label),
    item.hint ? h('span', { className: 'wx-menu-item-hint' }, item.hint) : null),
  h('span', { className: 'wx-menu-check' }, item.value === value ? h(IconCheck, null) : null)));

  return h(MenuSurface, {
    'data-dsh-wx-menu': '',
    'data-dsh-wx-menu-root': '',
    className: MENU_SURFACE_CLASS,
    role: 'menu',
    'aria-label': label,
    // 首帧还拿不到触发器的 rect 时先藏着：MenuSurface 要真实尺寸才铺得开材质。
    style: menuSurfaceStyle(placement ?? null),
  }, h('div', { ref: menuRef, className: 'wx-menu-body', role: 'presentation', onKeyDown }, entries));
}

export function MenuPicker({ label, value, items, disabled, placeholder, onChange }: any) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<any>(null);
  const triggerRef = useRef<any>(null);
  const menuRef = useRef<any>(null);
  const options = Array.isArray(items) ? items : [];
  const current = options.find((item: any) => item.value === value);

  const place = useCallback(() => {
    const node = triggerRef.current;
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    const rect = node.getBoundingClientRect();
    // 没有 window（测试/SSR）时按「下方放得下」的乐观假设排版，不抛错。
    const viewport = typeof window === 'undefined'
      ? { width: rect.left + rect.width + MENU_PLACEMENT.padding, height: rect.bottom + MENU_PLACEMENT.maxHeight + MENU_PLACEMENT.padding }
      : { width: window.innerWidth, height: window.innerHeight };
    return placeMenu(rect, viewport, MENU_PLACEMENT);
  }, []);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    setPosition(place());
    setOpen(true);
  }, [open, place]);

  /** 触发器上按上下键直接展开（Enter/Space 走原生按钮的 click）。 */
  const onTriggerKeyDown = useCallback((event: any) => {
    if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    event.preventDefault();
    setPosition(place());
    setOpen(true);
  }, [open, place]);

  /** 菜单内键盘导航：上下/Home/End 换焦点，Tab 收起，Escape 收起并把焦点还给触发器。 */
  const onMenuKeyDown = useCallback((event: any) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll('[role="menuitemradio"]:not([disabled])') ?? [],
    ) as any[];
    if (buttons.length === 0) return;
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      triggerRef.current?.focus?.();
      return;
    }
    const index = buttons.indexOf(event.target);
    let next = -1;
    if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length;
    else if (event.key === 'ArrowUp') next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next < 0) return;
    event.preventDefault();
    buttons[next]?.focus?.();
  }, []);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    // 焦点进菜单：选中项优先，没有选中就第一项；否则 Tab 会从触发器直接跳到「保存」。
    const focusItem = () => {
      const root = menuRef.current;
      if (!root) return;
      (root.querySelector('[role="menuitemradio"][aria-checked="true"]')
        ?? root.querySelector('[role="menuitemradio"]'))?.focus?.();
    };
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(focusItem)
      : (focusItem(), 0);
    const dismiss = (event: any) => {
      const node = triggerRef.current;
      if (node && typeof node.contains === 'function' && node.contains(event.target)) return;
      const insideMenu = typeof Element !== 'undefined'
        && event.target instanceof Element
        && event.target.closest('[data-dsh-wx-menu]') !== null;
      if (insideMenu) return;
      setOpen(false);
    };
    // rAF 合帧：滚动时每个事件都重算 rect 会重渲染整张菜单。
    let pending = 0;
    const reposition = () => {
      if (pending !== 0) return;
      pending = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => {
          pending = 0;
          setPosition(place());
        })
        : 0;
      if (pending === 0) setPosition(place());
    };
    const cancelPending = () => {
      if (pending !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending);
      pending = 0;
    };
    const onKeyDown = (event: any) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus?.();
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    // capture：滚动可能发生在某个祖先容器上，不冒泡到 window。
    window.addEventListener('scroll', reposition, true);
    return () => {
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      cancelPending();
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, place]);

  const trigger = h('button', {
    ref: triggerRef,
    type: 'button',
    className: 'wx-picker-trigger',
    disabled: disabled === true,
    'aria-haspopup': 'menu',
    'aria-expanded': open === true,
    'aria-label': label,
    title: current?.hint ?? current?.label ?? '',
    onClick: toggle,
    onKeyDown: onTriggerKeyDown,
  },
  h('span', {
    className: current ? 'wx-picker-value' : 'wx-picker-value wx-picker-value-empty',
  }, current?.label ?? placeholder ?? ''),
  h(IconChevronDown, { className: 'wx-picker-chevron' }));

  if (!open) return h('div', { className: 'wx-picker' }, trigger);

  const menu = h(OptionMenu, {
    label,
    items: options,
    value,
    disabled,
    menuRef,
    onKeyDown: onMenuKeyDown,
    placement: position,
    onSelect: (next: string) => {
      setOpen(false);
      // 选完把焦点还给触发器，键盘用户不会落回 body。
      triggerRef.current?.focus?.();
      if (next !== value) onChange(next);
    },
  });

  return h('div', { className: 'wx-picker' },
    trigger,
    portal ? portal(menu, document.body) : menu);
}
