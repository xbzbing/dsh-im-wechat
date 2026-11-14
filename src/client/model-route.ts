/**
 * 模型三级下拉的纯逻辑：provider → model → 推理等级（ADR-0026）。
 *
 * 从 `logic.ts` 拆出（文件规模规则）：这里只放目录取行、三级选项与级联规则，面板与
 * 行控件都从这里取，避免「换 provider 时清不清模型」这类规则在渲染里各写一份。
 */

import type { ModelOption } from './logic.ts';
import type { ModelCatalogItem, ModelCatalogView, ModelRef } from '../shared/models.ts';

/** 模型目录里的一个 provider（按目录顺序去重，名字缺失时退回 id）。 */
export interface ModelProviderChoice {
  id: string;
  name: string;
}

/** 目录读全了没有：只有读全了才能把「目录里没有」说成已下架。 */
function catalogComplete(catalog: ModelCatalogView | null): boolean {
  return catalog?.available === true
    && Array.isArray(catalog.unavailableProviders)
    && catalog.unavailableProviders.length === 0;
}

/**
 * 这个 provider 的目录读全了没有。
 *
 * 宿主的校验是按 provider 放行的（只有该 provider 自己读失败才跳过），所以模型与档位
 * 的「已下架」也按 provider 判断：别的 provider 读失败不能把这一家说成「未校验」，
 * 否则面板放行、保存时却被宿主拒掉。
 */
function providerComplete(catalog: ModelCatalogView | null, provider: string): boolean {
  return catalog?.available === true
    && Array.isArray(catalog.unavailableProviders)
    && !catalog.unavailableProviders.includes(provider);
}

/** 目录里的 provider；外部输入逐行筛，脏行丢掉。 */
export function catalogProviders(catalog: ModelCatalogView | null): ModelProviderChoice[] {
  const providers: ModelProviderChoice[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    if (typeof item?.provider !== 'string' || item.provider === '' || seen.has(item.provider)) continue;
    seen.add(item.provider);
    const name = typeof item.providerName === 'string' && item.providerName.trim() !== ''
      ? item.providerName.trim()
      : item.provider;
    providers.push({ id: item.provider, name });
  }
  return providers;
}

/** 目录里这个 provider 下的模型；provider 为空时没有候选。 */
export function catalogModels(catalog: ModelCatalogView | null, provider: string): ModelCatalogItem[] {
  if (provider === '') return [];
  const models: ModelCatalogItem[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(catalog?.items) ? catalog.items : []) {
    if (item?.provider !== provider || typeof item.model !== 'string' || item.model === '') continue;
    if (seen.has(item.model)) continue;
    seen.add(item.model);
    models.push(item);
  }
  return models;
}

/** 目录里的一个模型；找不到时 undefined（可能已下架，也可能是目录没读全）。 */
export function catalogModel(
  catalog: ModelCatalogView | null,
  provider: string,
  model: string,
): ModelCatalogItem | undefined {
  if (provider === '' || model === '') return undefined;
  return catalogModels(catalog, provider).find((item) => item.model === model);
}

/**
 * 模型下拉的行键：`provider` 与 `model` 用 NUL 拼起来。
 *
 * 只在浏览器里当选中标记用（不发给宿主，保存时回传 `{provider, model, reasoningEffort}`）。
 * 用 NUL 而不是 `/` 是因为 model id 里可能带斜杠，字符串拼接会撞行键（与宿主侧的拼法
 * 一致）。
 */
export function modelRowId(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

/** 行键 → 模型 id：模型下拉的选中值与级联都靠它把行键还原成模型。 */
export function modelRowName(value: string): string {
  return value.split('\u0000')[1] ?? value;
}

/** 一次选择给人看的写法：`provider/model`，带推理等级时再补一段。 */
export function modelRefLabel(catalog: ModelCatalogView | null, ref: ModelRef | null): string {
  if (ref === null) return '';
  const route = `${ref.provider}/${ref.model}`;
  if (ref.reasoningEffort === undefined) return route;
  const item = catalogModel(catalog, ref.provider, ref.model);
  const effort = Array.isArray(item?.efforts)
    ? item.efforts.find((entry) => entry.id === ref.reasoningEffort)
    : undefined;
  return `${route} · ${effort?.label ?? ref.reasoningEffort}`;
}

/**
 * provider 下拉：第一项「跟随 DSH 默认」，说明里带上宿主当前的默认模型（含推理等级）；
 * 其余按目录顺序列。已保存的 provider 不在目录里时补一行原文，免得显示成「未选择」。
 */
export function providerOptions(
  catalog: ModelCatalogView | null,
  value: string,
  labels: { followDefault: string; missing: string; unverified: string },
): ModelOption[] {
  const fallback = modelRefLabel(catalog, catalog?.default ?? null);
  const options: ModelOption[] = [{
    value: '',
    label: labels.followDefault,
    ...(fallback === '' ? {} : { hint: fallback }),
  }];
  const providers = catalogProviders(catalog);
  for (const provider of providers) options.push({ value: provider.id, label: provider.name });
  if (value !== '' && !providers.some((provider) => provider.id === value)) {
    options.push({
      value,
      label: value,
      hint: catalogComplete(catalog) ? labels.missing : labels.unverified,
    });
  }
  return options;
}

/**
 * 模型下拉：当前 provider 下的模型，第一项是「选择模型」（空值）。
 *
 * 已保存的模型不在这个 provider 下时补一行原文；那一行只是显示，保存时仍由宿主按目录
 * 拒掉，面板不会静默把它清成「跟随默认」。
 */
export function modelOptions(
  catalog: ModelCatalogView | null,
  provider: string,
  value: string,
  labels: { placeholder: string; missing: string; unverified: string },
): ModelOption[] {
  const options: ModelOption[] = [{ value: '', label: labels.placeholder }];
  const seen = new Set<string>(['']);
  for (const item of catalogModels(catalog, provider)) {
    const id = modelRowId(item.provider, item.model);
    if (seen.has(id)) continue;
    seen.add(id);
    const label = typeof item.label === 'string' && item.label.trim() !== '' ? item.label.trim() : item.model;
    options.push({ value: id, label, ...(label === item.model ? {} : { hint: item.model }) });
  }
  if (value !== '' && !seen.has(value)) {
    options.push({
      value,
      label: modelRowName(value),
      hint: providerComplete(catalog, provider) ? labels.missing : labels.unverified,
    });
  }
  return options;
}

/**
 * 推理等级下拉：第一项是「模型默认」（空值），其余按模型声明的顺序列。
 *
 * 模型没有声明推理等级时只剩「模型默认」一项；已保存的推理等级不在表里时补一行原文并标
 * 「已下架 / 未校验」，让主人还能把它清回默认。
 */
export function effortOptions(
  catalog: ModelCatalogView | null,
  provider: string,
  model: string,
  value: string,
  labels: { default: string; missing: string; unverified: string },
): ModelOption[] {
  const item = catalogModel(catalog, provider, model);
  const efforts = Array.isArray(item?.efforts) ? item.efforts : [];
  const defaultLabel = item?.defaultEffort === undefined
    ? ''
    : efforts.find((effort) => effort?.id === item.defaultEffort)?.label ?? item.defaultEffort;
  const options: ModelOption[] = [{
    value: '',
    label: labels.default,
    ...(defaultLabel === '' ? {} : { hint: defaultLabel }),
  }];
  const seen = new Set<string>(['']);
  for (const effort of efforts) {
    if (typeof effort?.id !== 'string' || effort.id === '' || seen.has(effort.id)) continue;
    seen.add(effort.id);
    options.push({ value: effort.id, label: typeof effort.label === 'string' && effort.label !== '' ? effort.label : effort.id });
  }
  if (value !== '' && !efforts.some((effort) => effort?.id === value)) {
    options.push({
      value,
      label: value,
      hint: providerComplete(catalog, provider) ? labels.missing : labels.unverified,
    });
  }
  return options;
}

/** 换 provider 时保留模型：只有新 provider 也声明同一个 id 才留。 */
export function modelForProvider(catalog: ModelCatalogView | null, provider: string, model: string): string {
  if (provider === '' || model === '') return '';
  return catalogModels(catalog, provider).some((item) => item.model === model) ? model : '';
}

/** 换模型时保留推理等级：只有新模型仍声明这一档才留。 */
export function effortForModel(
  catalog: ModelCatalogView | null,
  provider: string,
  model: string,
  effort: string,
): string {
  if (model === '' || effort === '') return '';
  const item = catalogModel(catalog, provider, model);
  return Array.isArray(item?.efforts) && item.efforts.some((entry) => entry?.id === effort) ? effort : '';
}

/**
 * 草稿能不能保存：选「跟随 DSH 默认」（provider 为空）可以，选了 provider 就必须
 * 有模型——只有一半的选择不该落盘，也不该在保存时被悄悄当成「清空」。
 */
export function modelSaveable(provider: string, model: string): boolean {
  return provider === '' || model !== '';
}

/** 三级草稿 → 保存用的选择：没有 provider 或 model 就是「跟随 DSH 默认」。 */
export function modelSelectionOf(provider: string, model: string, effort: string): ModelRef | null {
  if (provider === '' || model === '') return null;
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) };
}
