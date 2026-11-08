/**
 * 面板样式（一次性注入）。
 *
 * 颜色、圆角和层级全部来自 DSH 设计令牌；微信的品牌感只通过轻量的气泡标记
 * 表达，不把一整页染成品牌色。布局使用边框、间距和排版建立层次，避免重复的
 * 灰色大卡片。
 */

const STYLE_ID = 'dsh-im-wechat-styles';

export const STYLES = `
.wx-root {
  box-sizing: border-box;
  width: min(100%, 760px);
  margin: 0 auto;
  padding: 4px 0 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  color: var(--dsw-alias-label-primary);
  font-family: var(--dsw-font-family, inherit);
}
.wx-root *, .wx-root *:before, .wx-root *:after { box-sizing: border-box; }
.wx-loading { min-height: 180px; align-items: center; justify-content: center; }
.wx-loading-bar {
  width: 28px;
  height: 28px;
  border: 2px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-state-business-primary);
  border-radius: 50%;
  animation: wx-spin .8s linear infinite;
}
@keyframes wx-spin { to { transform: rotate(360deg); } }

.wx-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-xl, 20px);
  background: var(--dsw-alias-bg-layer-2);
}
.wx-brand { min-width: 0; display: flex; align-items: center; gap: 12px; }
.wx-mark {
  position: relative;
  flex: none;
  width: 42px;
  height: 42px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: 13px;
  background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-1));
}
.wx-mark-bubble {
  position: absolute;
  display: block;
  border: 1.5px solid var(--dsw-alias-state-business-primary);
  border-radius: 7px 7px 7px 2px;
}
.wx-mark-bubble-main { width: 20px; height: 14px; top: 10px; left: 8px; }
.wx-mark-bubble-small { width: 14px; height: 10px; right: 6px; bottom: 9px; border-radius: 2px 6px 6px 6px; background: var(--dsw-alias-bg-layer-2); }
.wx-brand-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.wx-title { margin: 0; font-size: 18px; line-height: 24px; font-weight: 600; letter-spacing: -.01em; }
.wx-subtitle { max-width: 520px; margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wx-hero-actions { flex: none; display: flex; align-items: center; gap: 8px; }
.wx-state-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 9px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; }
.wx-state-chip[data-state="done"] { color: var(--dsw-alias-state-success-label, var(--dsw-alias-label-primary)); background: var(--dsw-alias-state-success-tertiary, var(--dsw-alias-bg-layer-1)); }
.wx-state-chip[data-state="warning"] { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-primary)); background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-1)); }
.wx-state-chip[data-state="error"] { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-tertiary, var(--dsw-alias-bg-layer-1)); }
.wx-version, .wx-section-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }

.wx-panel { padding: 20px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-alias-bg-layer-2); }
.wx-section-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.wx-eyebrow { margin: 0 0 3px; color: var(--dsw-alias-label-tertiary); font-size: 10px; font-weight: 600; letter-spacing: .08em; line-height: 14px; text-transform: uppercase; }
.wx-section-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 15px; font-weight: 600; line-height: 22px; }
.wx-banner { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 12px); font-size: 12px; line-height: 18px; }
.wx-banner-warning { color: var(--dsw-alias-state-warn-label, var(--dsw-alias-label-primary)); background: var(--dsw-alias-state-warn-tertiary, var(--dsw-alias-bg-layer-2)); }

/* 默认单列拉通：只有扫码时才分出右列放二维码，不留空白列。 */
.wx-connection-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px; align-items: stretch; }
.wx-connection-split { grid-template-columns: minmax(240px, .88fr) minmax(300px, 1.12fr); }
.wx-connection-main { min-width: 0; display: flex; flex-direction: column; justify-content: space-between; gap: 20px; }
/* 宽版（无二维码）：状态在左、操作在右，事实与提示各占整行，避免左列过窄截断时间。 */
.wx-connection-grid:not(.wx-connection-split) .wx-connection-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 20px;
  row-gap: 18px;
}
.wx-connection-grid:not(.wx-connection-split) .wx-connection-status { grid-column: 1; grid-row: 1; }
.wx-connection-grid:not(.wx-connection-split) .wx-actions { grid-column: 2; grid-row: 1; justify-content: flex-end; }
.wx-connection-grid:not(.wx-connection-split) .wx-facts { grid-column: 1 / -1; grid-row: 2; }
.wx-connection-grid:not(.wx-connection-split) .wx-action-hint { grid-column: 1 / -1; grid-row: 3; }
.wx-connection-status { display: flex; align-items: flex-start; gap: 9px; }
.wx-connection-status > div { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.wx-connection-status strong { font-size: 14px; font-weight: 600; line-height: 20px; }
.wx-connection-status span { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
/* 自适应列数：宽版三列，左列窄时两列或堆叠，都不把登录时间挤到省略号。 */
.wx-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px 16px; padding-top: 16px; border-top: .5px solid var(--dsw-alias-border-l2); }
.wx-fact { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.wx-fact span { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.wx-fact strong { overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 12px; font-weight: 500; line-height: 18px; text-overflow: ellipsis; white-space: nowrap; }
.wx-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.wx-action-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }

.wx-qr-card { min-width: 0; padding: 14px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 16px); background: var(--dsw-alias-bg-layer-1); }
.wx-qr-heading { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
.wx-qr-step { display: grid; width: 26px; height: 26px; flex: none; place-items: center; border-radius: 8px; color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-2)); font-size: 10px; font-weight: 600; }
.wx-qr-heading div { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.wx-qr-heading strong { font-size: 13px; font-weight: 600; line-height: 18px; }
.wx-qr-heading span { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.wx-qr-content { display: flex; align-items: flex-start; gap: 14px; }
.wx-qr-img { width: 132px; height: 132px; flex: none; padding: 7px; border-radius: var(--dsw-radius-sm, 8px); background: #fff; image-rendering: pixelated; }
.wx-qr-placeholder { display: grid; width: 132px; height: 132px; flex: none; place-items: center; padding: 12px; border: .5px dashed var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 8px); color: var(--dsw-alias-label-tertiary); text-align: center; font-size: 11px; }
.wx-qr-side { min-width: 0; display: flex; flex: 1; flex-direction: column; align-items: flex-start; gap: 9px; }
.wx-link { width: 100%; max-height: 52px; overflow: hidden; color: var(--dsw-alias-label-tertiary); font: 10px/16px var(--dsw-font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }
.wx-code-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; width: 100%; }
.wx-code-row input { min-width: 120px; flex: 1; }

.wx-settings-list { display: flex; flex-direction: column; }
.wx-setting-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 20px; min-height: 68px; padding: 14px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.wx-setting-row:first-child { border-top: 0; padding-top: 0; }
.wx-setting-row:last-child { padding-bottom: 0; }
.wx-setting-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.wx-setting-title { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 19px; }
.wx-setting-description { max-width: 520px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.wx-setting-row .wx-item, .wx-setting-row .wx-item-label, .wx-setting-row .wx-item-desc { display: contents; }
.wx-setting-row > input[type="checkbox"] { flex: none; }
.wx-threshold-control { display: flex; align-items: center; gap: 6px; }
.wx-minutes { width: 68px; }
.wx-select { min-width: 0; width: 100%; height: 30px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; }
/* 带下拉/长输入的行：控件另起一行占满，窄面板里不会把标签挤成一列单字。 */
.wx-setting-row.wx-row-stack { grid-template-columns: minmax(0, 1fr); align-items: stretch; gap: 10px; }
.wx-row-stack .wx-threshold-control { width: 100%; }
.wx-row-stack .wx-select { flex: 1 1 auto; min-width: 0; max-width: 420px; }
/* 控件行里的按钮不参与收缩，否则窄面板会把「保存」挤成两行。 */
.wx-row-stack .wx-threshold-control > button { flex: none; white-space: nowrap; }
.wx-select:disabled { opacity: .5; }
.wx-panel-muted { opacity: .72; }
.wx-unit { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wx-draft-hint { margin: 0 0 -2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }

.wx-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.wx-metric { min-width: 0; min-height: 78px; display: flex; flex-direction: column; justify-content: space-between; gap: 8px; padding: 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 12px); background: var(--dsw-alias-bg-layer-1); }
.wx-metric strong { overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 20px; font-weight: 600; line-height: 24px; text-overflow: ellipsis; white-space: nowrap; }
.wx-metric span { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.wx-metric-wide { grid-column: 1 / -1; min-height: 52px; flex-direction: row; align-items: center; }
.wx-metric-wide strong { font-size: 13px; line-height: 18px; }
.wx-runtime-panel .wx-banner { margin-top: 12px; }
.wx-error-panel { border-color: var(--dsw-alias-state-error-primary); }
.wx-error { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.wx-hint { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }

@media (max-width: 640px) {
  .wx-hero { align-items: flex-start; flex-direction: column; }
  .wx-hero-actions { width: 100%; justify-content: space-between; }
  .wx-connection-split { grid-template-columns: 1fr; }
  /* 窄屏状态与按钮各占一行，按钮靠左排。 */
  .wx-connection-grid:not(.wx-connection-split) .wx-connection-main {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }
  .wx-connection-grid:not(.wx-connection-split) .wx-actions { justify-content: flex-start; }
}
@media (max-width: 420px) {
  .wx-panel, .wx-hero { padding: 16px; border-radius: var(--dsw-radius-lg, 16px); }
  .wx-connection-grid { gap: 14px; }
  .wx-qr-content { flex-direction: column; }
  .wx-qr-img, .wx-qr-placeholder { width: 156px; height: 156px; }
  .wx-setting-row { grid-template-columns: minmax(0, 1fr) auto; gap: 12px; }
  .wx-setting-description { font-size: 11px; }
}
`;

/** 注入一次样式；重复调用是幂等的。 */
export function ensureStyles(doc: Document | null = typeof document === 'undefined' ? null : document): void {
  if (!doc || doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = STYLES;
  doc.head.appendChild(style);
}
