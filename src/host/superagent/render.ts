/**
 * 交付 → 微信文本。
 *
 * 微信客户端**原生渲染 Markdown**（实测：标题、加粗、斜体、列表、表格、引用、分隔线、
 * 链接、行内代码、带高亮的代码块都能渲染）。官方参考实现 `openclaw-weixin` 的
 * `src/messaging/markdown-filter.ts` 正是按这个前提写的：它不做「删格式」，只剔掉
 * 客户端渲染不了的少数构造——图片、H5/H6 标题标记、包住中文的斜体标记、删除线标记，
 * 其余原样透传。
 *
 * 所以桥这里不再拍平 Markdown，而是做三件事（ADR-0009）：
 *
 * 1. **剔掉客户端渲染不了的东西**：图片整段丢弃，`#####`/`######` 去标记留文字，
 *    包住中文的斜体去标记（中文斜体在微信里很难看），删除线去标记留文字。
 * 2. **代码先摘出来**：围栏块与行内代码里的星号、竖线、井号都不是标记，不能被上面的
 *    规则改写。
 * 3. **分条**：超过 `maxText` 时按换行边界切分，宁可多条也不截断。
 *
 * 与官方实现的差异只有一处：官方是流式过滤器，遇到任何 `~` 都直接吞掉（`~/x` 会变成
 * `/x`）；我们发的是整条消息，只剥 `~~…~~` 这一对标记，单独的波浪线原样保留。
 */

import { renderInteraction } from '../../shared/question-text.ts';

export { renderInteraction } from '../../shared/question-text.ts';
import type { Delivery } from './protocol.ts';

/** 桥上声明的单条字符上限。 */
export const MAX_TEXT_CHARS = 1_800;

/** 中文（含日韩汉字与假名）：这些字符包在斜体里微信渲染难看，官方实现同样去标记。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 组装一条交付的完整文本；`detail` 不支持折叠，按协议直接省略。 */
export function composeDeliveryText(delivery: Delivery): string {
  const sections: string[] = [];
  const title = typeof delivery.title === 'string' ? delivery.title.trim() : '';
  const body = typeof delivery.body === 'string' ? delivery.body.trim() : '';
  if (title !== '') sections.push(toWeChatMarkdown(title));
  if (body !== '') sections.push(toWeChatMarkdown(body));
  if (delivery.interaction) {
    const interaction = renderInteraction(delivery.interaction);
    if (interaction !== '') sections.push(interaction);
  }
  return sections
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Markdown → 微信可渲染的 Markdown。
 *
 * 保留的构造（客户端都能渲染）：`**加粗**`、`*斜体*`（非中文）、`__加粗__`、
 * `# 标题`（H1–H4）、`- ` / `1. ` 列表、`|` 表格、`>` 引用、`---` 分隔线、
 * `[文字](地址)`、行内代码与围栏代码块。
 */
export function toWeChatMarkdown(markdown: string): string {
  const guarded: string[] = [];
  const hold = (text: string) => `\u0000${guarded.push(text) - 1}\u0000`;

  const body = markdown
    .replace(/\r\n?/g, '\n')
    // 代码：围栏块与行内代码先摘成占位符，里面的标记不参与下面的规则。
    .replace(/```[^\n]*\n[\s\S]*?```/g, (match) => hold(match))
    .replace(/(`+)[^`\n]+?\1/g, (match) => hold(match))
    // 三角标（加粗 + 斜体）：包中文去标记，否则整体留占位符。
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, (match, text: string) => (CJK.test(text) ? text : hold(match)))
    .replace(/___([^_\n]+)___/g, (match, text: string) => (CJK.test(text) ? text : hold(match)))
    // 双标记加粗：客户端渲染，原样保留（先占位，免得被斜体规则拆开）。
    .replace(/\*\*[^*\n]+\*\*/g, (match) => hold(match))
    .replace(/__[^_\n]+__/g, (match) => hold(match))
    // 图片：客户端不渲染，官方实现同样整段丢弃。
    .replace(/[ \t]*!\[[^\]]*\]\([^)]*\)/g, '')
    // H5/H6：客户端不渲染这两级标记，去掉井号留文字。
    .replace(/^#{5,6}[ \t]+(.*)$/gm, '$1')
    // 删除线：客户端不渲染，去掉波浪线留文字。
    .replace(/~~([^~\n]+)~~/g, '$1')
    // 斜体：包中文去标记，其余保留。
    .replace(/\*([^*\n]+)\*/g, (match, text: string) => (CJK.test(text) ? text : hold(match)))
    .replace(
      /(^|[ \t(])_([^_\n]+)_(?=[ \t).,，。；！？]|$)/gm,
      (match, lead: string, text: string) => (CJK.test(text) ? `${lead}${text}` : hold(match)),
    );

  return restore(body, guarded)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function restore(text: string, guarded: readonly string[]): string {
  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => guarded[Number(index)] ?? '');
}

/**
 * 按字符（码点）切分，优先在换行处断开。
 *
 * 用码点而不是 UTF-16 长度：emoji 被劈成两半会变成乱码。
 */
export function splitText(text: string, maxChars: number = MAX_TEXT_CHARS): string[] {
  if (maxChars <= 0) throw new RangeError('maxChars 必须为正数');
  const points = Array.from(text);
  if (points.length <= maxChars) return text === '' ? [] : [text];

  const chunks: string[] = [];
  let rest = points;
  while (rest.length > maxChars) {
    let cut = maxChars;
    // 在容量的一半到上限之间找最近的换行，避免把一句话劈开。
    for (let index = maxChars; index > Math.floor(maxChars / 2); index -= 1) {
      if (rest[index - 1] === '\n') {
        cut = index;
        break;
      }
    }
    chunks.push(rest.slice(0, cut).join('').trimEnd());
    rest = rest.slice(cut);
    while (rest.length > 0 && rest[0] === '\n') rest = rest.slice(1);
  }
  if (rest.length > 0) chunks.push(rest.join(''));
  return chunks.filter((chunk) => chunk !== '');
}
