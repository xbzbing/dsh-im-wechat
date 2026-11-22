/**
 * 面板样式（一次性注入）。
 *
 * 颜色、圆角和层级全部来自 DSH 设计令牌；品牌感只通过项目主图标（构建期以
 * data URL 内联进 client 产物）表达，不把一整页染成品牌色。布局使用边框、
 * 间距和排版建立层次，避免重复的灰色大卡片。
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
/* 项目主图标：构建期以 data URL 内联进 client 产物，与 package.json 的 icon 同源。 */
.wx-mark { display: block; flex: none; width: 42px; height: 42px; border-radius: 10px; }
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

/* 弹层：遮罩压暗页面，卡片居中；Esc、点遮罩关闭与焦点回收由 ui.ts 的 Dialog 处理。 */
.wx-dialog-mask { position: fixed; inset: 0; z-index: 1100; display: grid; place-items: center; padding: 24px; background: rgba(15, 18, 24, .38); }
.wx-dialog { display: flex; flex-direction: column; align-items: center; gap: 14px; width: min(100%, 320px); max-height: calc(100vh - 48px); overflow: auto; padding: 22px 20px 16px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xl, 20px); background: var(--dsw-alias-bg-layer-1); box-shadow: var(--dsw-elevation-prominent, 0 18px 48px rgba(0, 0, 0, .28)); color: var(--dsw-alias-label-primary); text-align: center; outline: none; }
.wx-dialog:focus-visible { outline: none; }
.wx-dialog .wx-login { align-items: center; text-align: center; }
.wx-dialog .wx-login-head { align-items: center; }
.wx-dialog .wx-actions { justify-content: center; }

/* 连接区：状态在左、操作在右；事实行与提示各占整行，窄列也不会把时间挤成省略号。 */
.wx-connection-main {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 20px;
  row-gap: 18px;
}
.wx-connection-main > .wx-connection-status { grid-column: 1; grid-row: 1; }
.wx-connection-main > .wx-actions { grid-column: 2; grid-row: 1; justify-content: flex-end; }
.wx-connection-main > .wx-facts { grid-column: 1 / -1; grid-row: 2; }
.wx-connection-main > .wx-action-hint { grid-column: 1 / -1; grid-row: 3; }
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

/* 扫码登录（弹层内）：不套卡片，二维码是唯一有底色的元素。 */
.wx-login { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.wx-login-head { display: flex; flex-direction: column; gap: 2px; }
.wx-login-head strong { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; line-height: 18px; }
.wx-login-head span { color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; }
.wx-login-qr { display: block; width: 168px; height: 168px; flex: none; padding: 8px; border-radius: var(--dsw-radius-md, 12px); background: #fff; image-rendering: pixelated; }
.wx-login-qr-empty { display: grid; place-items: center; padding: 14px; border: .5px dashed var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-tertiary); text-align: center; font-size: 11px; line-height: 16px; }
.wx-login-foot { padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 11px; line-height: 16px; cursor: pointer; transition: color .15s; }
.wx-login-foot:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.wx-login-foot:disabled { opacity: .5; cursor: not-allowed; }
.wx-login-foot:focus-visible { outline: 2px solid var(--dsw-alias-border-l2); outline-offset: 2px; }
.wx-code-row { display: flex; align-items: center; gap: 8px; width: 100%; max-width: 240px; }
.wx-code-row input { min-width: 0; flex: 1; }

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
/* 工作区下拉：触发器沿用原来 select 的尺寸，浮层见文件末尾的 .wx-menu。 */
.wx-picker { display: flex; flex: 1 1 auto; min-width: 0; }
.wx-picker-trigger { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 30px; padding: 0 6px 0 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.wx-picker-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.wx-picker-trigger:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary); box-shadow: 0 0 0 3px rgba(32, 106, 238, .13); }
.wx-picker-trigger:disabled { opacity: .5; cursor: not-allowed; }
.wx-picker-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wx-picker-value-empty { color: var(--dsw-alias-label-tertiary); }
.wx-picker-chevron { flex: none; color: var(--dsw-alias-label-caption); }
/* 标题 + 控件上下排的字段块：标题与说明在上，控件独占下一行。 */
.wx-field-block { display: flex; flex-direction: column; gap: 10px; padding: 14px 0; border-top: .5px solid var(--dsw-alias-border-l2); }
.wx-field-block .wx-threshold-control { width: 100%; }
.wx-field-block .wx-picker { flex: 1 1 auto; min-width: 0; max-width: 420px; }
/* 控件行里除下拉以外的控件不参与收缩，否则窄面板会把「保存」挤成两行（宿主 Button 可能包一层）。 */
.wx-field-block .wx-threshold-control > *:not(.wx-picker) { flex: none; white-space: nowrap; }
/* 模型三级下拉：provider / model / 推理等级同一行，窄面板自动换行；保存不参与收缩。 */
.wx-model-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
.wx-model-controls .wx-picker { flex: 1 1 132px; min-width: 108px; max-width: 260px; }
.wx-model-controls > *:not(.wx-picker) { flex: none; white-space: nowrap; }
/* 可折叠卡片的头部：右侧是状态说明 + 展开/收起。 */
.wx-head-collapsible { align-items: center; flex-wrap: wrap; row-gap: 8px; }
/* 标题块至少占 220px：窄面板里状态与「展开」按钮换到下一行，标题不被挤成一字一行。 */
.wx-head-collapsible > div:first-child { min-width: 0; flex: 1 1 220px; }
.wx-section-side { margin-left: auto; display: flex; align-items: center; gap: 10px; flex: none; }
.wx-collapse { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
.wx-collapse:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-tertiary); }
.wx-collapse:focus-visible { outline: 2px solid var(--dsw-alias-border-l2); outline-offset: 2px; }
/* 折叠箭头：收起时指右、展开时指下，纯 CSS 三角，不依赖图标包。 */
.wx-chevron { width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor; transform: rotate(-90deg); transition: transform .15s; }
.wx-chevron-open { transform: rotate(0deg); }
.wx-menu-body { display: flex; flex-direction: column; gap: 2px; }
.wx-menu { position: fixed; z-index: 1200; display: flex; flex-direction: column; gap: 2px; padding: 4px; overflow-y: auto; overscroll-behavior: contain; outline: none; border: .5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, .16)); color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family, inherit); }
.wx-menu, .wx-menu * { box-sizing: border-box; }
.wx-menu-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; border: none; border-radius: 6px; background: none; color: inherit; font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.wx-menu-item:hover:not(:disabled), .wx-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.wx-menu-item:disabled { color: var(--dsw-alias-label-dimmed); cursor: default; }
.wx-menu-item-copy { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.wx-menu-item-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wx-menu-item-hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; }
.wx-menu-check { flex: 0 0 14px; display: grid; place-items: center; color: var(--dsw-alias-label-primary); }
.wx-menu-check svg { width: 14px; height: 14px; }
.wx-panel-muted { opacity: .72; }
.wx-unit { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.wx-draft-hint { margin: 0 0 -2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
/* 保存成功的即时反馈：两秒后由面板清掉。 */
.wx-saved { display: inline-block; min-width: 3.2em; color: var(--dsw-alias-state-success-label, var(--dsw-alias-label-secondary)); font-size: 11px; line-height: 16px; white-space: nowrap; animation: wx-saved-in .18s ease-out; }
@keyframes wx-saved-in { from { opacity: 0; transform: translateY(1px); } to { opacity: 1; transform: none; } }
/* 当前会话：名字完整显示，id 用小字单独一行，长 id 可换行、可复制。 */
.wx-session-name { color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
.wx-session-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.wx-session-id { color: var(--dsw-alias-label-tertiary); font: 11px/16px var(--dsw-font-mono, ui-monospace, monospace); overflow-wrap: anywhere; }

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
  /* 窄屏状态与按钮各占一行，按钮靠左排。 */
  .wx-connection-main {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 16px;
  }
  .wx-connection-main > .wx-actions { justify-content: flex-start; }
}
@media (max-width: 420px) {
  .wx-panel, .wx-hero { padding: 16px; border-radius: var(--dsw-radius-lg, 16px); }
  .wx-login-qr { width: 148px; height: 148px; }
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
