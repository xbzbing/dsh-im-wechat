/**
 * 面板样式（一次性注入）。
 *
 * 只用官方设计令牌（`--dsw-alias-*`、`--dsw-radius-*`），因此浅色/深色主题自动跟随，
 * 不写死任何颜色值。类名前缀 `wx-` 避免与宿主样式相撞。
 */

const STYLE_ID = 'dsh-im-wechat-styles';

export const STYLES = `
.wx-root { display: flex; flex-direction: column; gap: 20px; padding: 4px 0 8px; }
.wx-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wx-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wx-version { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.wx-spacer { flex: 1; }
.wx-section { display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-alias-bg-layer-2); }
.wx-section-title { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.wx-hint { margin: 0; font-size: 12px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }
.wx-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wx-row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.wx-item { display: flex; flex-direction: column; gap: 2px; }
.wx-item-label { font-size: 13px; color: var(--dsw-alias-label-primary); }
.wx-item-desc { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.wx-status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.wx-kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; font-size: 12px; }
.wx-kv dt { color: var(--dsw-alias-label-secondary); }
.wx-kv dd { margin: 0; color: var(--dsw-alias-label-primary); word-break: break-all; }
.wx-qr { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.wx-qr-img { width: 176px; height: 176px; padding: 8px; border-radius: var(--dsw-radius-md, 8px); background: #fff; image-rendering: pixelated; }
.wx-qr-side { display: flex; flex-direction: column; gap: 10px; min-width: 220px; flex: 1; }
.wx-link { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); word-break: break-all; font-family: var(--dsw-font-mono, ui-monospace, monospace); }
.wx-error { margin: 0; font-size: 12px; color: var(--dsw-alias-label-error, #d9534f); word-break: break-word; }
.wx-divider { height: 1px; background: var(--dsw-alias-border-subtle, rgba(127,127,127,0.16)); }
.wx-code-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
`;

/** 注入一次样式；重复调用是幂等的。 */
export function ensureStyles(doc: Document | null = typeof document === 'undefined' ? null : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}
