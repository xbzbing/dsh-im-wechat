/**
 * 面板复用的行控件：开关行、下拉行、分钟行，以及连接区与概览用的事实/指标块。
 *
 * 从 `sections.ts` 拆出（文件规模规则）：分段视图只管把卡片拼起来，行内排版与禁用
 * 判据留在这份，加新设置项时不用再动整张卡。
 */

import { h } from './platform.ts';
import { Button, Input, MenuPicker, Switch } from './ui.ts';
import type { Translate } from './locales.ts';

type T = Translate;

/** 带说明的开关行：标题 + 说明在左，开关在右。 */
export function SwitchRow({ title, description, checked, disabled, onChange }: any) {
  return h('div', { className: 'wx-setting-row' },
    h('div', { className: 'wx-setting-copy' },
      h('span', { className: 'wx-setting-title' }, title),
      description ? h('span', { className: 'wx-setting-description' }, description) : null),
    h(Switch, {
      checked,
      disabled,
      label: title,
      onChange: (next: boolean) => onChange(next),
    }));
}

export function Fact({ label, value }: { label: string; value: string }) {
  return h('div', { className: 'wx-fact' },
    h('span', null, label),
    h('strong', null, value));
}

export function Metric({ value, label, wide }: { value: string; label: string; wide?: boolean }) {
  return h('div', { className: `wx-metric${wide ? ' wx-metric-wide' : ''}` },
    h('strong', null, value),
    h('span', null, label));
}

/**
 * 下拉行：标题与说明在上，下拉与保存按钮在下。
 *
 * 工作区与模型共用同一套排版与禁用判据——两份拷贝容易漂移（只给其中一份改锁定条件，
 * 另一份就变成能改但不生效）。
 */
export function PickerRow(props: {
  t: T;
  title: string;
  description: string;
  value: string;
  items: any[];
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  const { t, title, description, value, items, placeholder, disabled, onChange, onSave } = props;
  return h('div', { className: 'wx-field-block' },
    h('div', { className: 'wx-setting-copy' },
      h('span', { className: 'wx-setting-title' }, title),
      h('span', { className: 'wx-setting-description' }, description)),
    h('div', { className: 'wx-threshold-control' },
      h(MenuPicker, {
        label: title,
        value,
        items,
        placeholder,
        disabled,
        onChange: (next: string) => onChange(next),
      }),
      h(Button, {
        variant: 'outline',
        size: 'sm',
        disabled,
        onClick: () => void onSave(),
      }, t('common.save'))));
}

/** 分钟输入行：标题 + 说明 + 数字输入 + 单位 + 保存 + 校验/草稿提示。 */
export function MinutesRow(props: {
  t: T;
  title: string;
  description: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  canSave: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  error: string | null;
  draftHint: string | null;
}) {
  const { t, title, description, value, placeholder, disabled, canSave, onChange, onSave, error, draftHint } = props;
  return h('div', { className: 'wx-setting-group' },
    h('div', { className: 'wx-setting-row wx-threshold-row' },
      h('div', { className: 'wx-setting-copy' },
        h('span', { className: 'wx-setting-title' }, title),
        h('span', { className: 'wx-setting-description' }, description)),
      h('div', { className: 'wx-threshold-control' },
        h(Input, {
          className: 'wx-minutes',
          value,
          placeholder,
          'aria-label': title,
          disabled,
          onChange: (event: any) => onChange(String(event.target.value)),
        }),
        h('span', { className: 'wx-unit' }, t('common.minutes')),
        h(Button, {
          variant: 'outline',
          size: 'sm',
          disabled: disabled || !canSave,
          onClick: () => void onSave(),
        }, t('common.save')))),
    // 校验不过就地说明：宿主会把值夹回区间，与其保存后被回读顶掉，不如先讲清楚。
    error !== null ? h('p', { className: 'wx-error' }, error) : null,
    draftHint !== null ? h('p', { className: 'wx-draft-hint' }, draftHint) : null);
}
