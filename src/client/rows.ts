/**
 * 面板复用的行控件：开关行、下拉行、分钟行，以及连接区与概览用的事实/指标块。
 *
 * 从 `sections.ts` 拆出（文件规模规则）：分段视图只管把卡片拼起来，行内排版与禁用
 * 判据留在这份，加新设置项时不用再动整张卡。
 */

import { catalogModel, effortOptions, modelOptions, modelRowId, modelRowName, providerOptions } from './model-route.ts';
import { h } from './platform.ts';
import { Button, Input, MenuPicker, Switch } from './ui.ts';
import type { Translate } from './locales.ts';
import type { ModelCatalogView } from '../shared/models.ts';

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

export function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return h('div', { className: 'wx-fact' },
    h('span', null, label),
    // 悬停看全文：账号这类值平时只显示尾号，不把整串铺在卡片上。
    h('strong', { ...(hint ? { title: hint } : {}) }, value));
}

/** 保存成功的即时反馈：只活几秒，由面板的状态驱动。 */
export function SavedHint({ t, saved }: { t: T; saved: boolean }) {
  if (!saved) return null;
  return h('span', { className: 'wx-saved', role: 'status' }, t('common.saved'));
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
  saved?: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  const { t, title, description, value, items, placeholder, disabled, saved, onChange, onSave } = props;
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
      }, t('common.save')),
      h(SavedHint, { t, saved: saved === true })));
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
  saved?: boolean;
  onChange: (value: string) => void;
  onSave: () => Promise<void>;
  error: string | null;
  draftHint: string | null;
}) {
  const { t, title, description, value, placeholder, disabled, canSave, saved, onChange, onSave, error, draftHint } = props;
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
        }, t('common.save')),
        h(SavedHint, { t, saved: saved === true }))),
    // 校验不过就地说明：宿主会把值夹回区间，与其保存后被回读顶掉，不如先讲清楚。
    error !== null ? h('p', { className: 'wx-error' }, error) : null,
    draftHint !== null ? h('p', { className: 'wx-draft-hint' }, draftHint) : null);
}

/**
 * 模型三级选择行：provider → model → 推理等级，选完一起保存。
 *
 * 三级各自是官方的下拉（`MenuPicker`），级联规则由 `model-route.ts` 的纯函数决定：
 * 换 provider 时同名模型留下、换模型时模型仍声明的推理等级留下。空白推理等级表示用
 * 模型自己的默认，所以第三级始终留一行「模型默认」。
 */
export function ModelRouteRow(props: {
  t: T;
  title: string;
  description: string;
  catalog: ModelCatalogView | null;
  provider: string;
  model: string;
  effort: string;
  disabled: boolean;
  canSave: boolean;
  saved?: boolean;
  onChangeProvider: (value: string) => void;
  onChangeModel: (value: string) => void;
  onChangeEffort: (value: string) => void;
  onSave: () => Promise<void>;
}) {
  const { t, title, description, catalog, provider, model, effort, disabled, canSave, saved } = props;
  const activeModel = catalogModel(catalog, provider, model);
  const efforts = Array.isArray(activeModel?.efforts) ? activeModel.efforts : [];
  // 半截选择（有来源没模型）与「模型没有推理等级」是两种提示，都只在这里算一次。
  const hint = provider !== '' && model === ''
    ? t('direct.modelIncomplete')
    : activeModel !== undefined && efforts.length === 0
      ? t('direct.effortNone')
      : null;
  const modelValue = model === '' ? '' : modelRowId(provider, model);
  // 没有推理等级可选的模型禁用第三级；但已保存的旧推理等级要留着能清回默认，不能一起锁死。
  const effortDisabled = disabled || model === '' || (efforts.length === 0 && effort === '');
  return h('div', { className: 'wx-field-block' },
    h('div', { className: 'wx-setting-copy' },
      h('span', { className: 'wx-setting-title' }, title),
      h('span', { className: 'wx-setting-description' }, description)),
    h('div', { className: 'wx-model-controls' },
      h(MenuPicker, {
        label: t('direct.modelProvider'),
        value: provider,
        items: providerOptions(catalog, provider, {
          followDefault: t('direct.modelFollowDefault'),
          missing: t('direct.modelMissing'),
          unverified: t('direct.modelUnverified'),
        }),
        placeholder: t('direct.modelFollowDefault'),
        disabled,
        onChange: (next: string) => props.onChangeProvider(next),
      }),
      h(MenuPicker, {
        label: t('direct.model'),
        value: modelValue,
        items: modelOptions(catalog, provider, modelValue, {
          placeholder: t('direct.modelPick'),
          missing: t('direct.modelMissing'),
          unverified: t('direct.modelUnverified'),
        }),
        placeholder: t('direct.modelPick'),
        disabled: disabled || provider === '',
        onChange: (next: string) => props.onChangeModel(next === '' ? '' : modelRowName(next)),
      }),
      h(MenuPicker, {
        label: t('direct.effort'),
        value: effort,
        items: effortOptions(catalog, provider, model, effort, {
          default: t('direct.effortDefault'),
          missing: t('direct.effortMissing'),
          unverified: t('direct.effortUnverified'),
        }),
        placeholder: t('direct.effortDefault'),
        disabled: effortDisabled,
        onChange: (next: string) => props.onChangeEffort(next),
      }),
      h(Button, {
        variant: 'outline',
        size: 'sm',
        disabled: disabled || !canSave,
        onClick: () => void props.onSave(),
      }, t('common.save')),
      h(SavedHint, { t, saved: saved === true })),
    hint !== null ? h('p', { className: 'wx-draft-hint' }, hint) : null);
}
