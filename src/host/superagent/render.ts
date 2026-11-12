/**
 * 交付 → 微信文本。
 *
 * 微信客户端**原生渲染 Markdown**（实测：标题、加粗、斜体、列表、表格、引用、分隔线、
 * 链接、行内代码、带高亮的代码块都能渲染）。官方参考实现 `openclaw-weixin` 的
 * `src/messaging/markdown-filter.ts` 正是按这个前提写的：它不做「删格式」，只剔掉
 * 客户端渲染不了的少数构造——图片、H5/H6 标题标记、包住中文的斜体标记、删除线标记，
 * 其余原样透传。
 *
 * 所以桥这里不再拍平 Markdown，而是做三件事（ADR-0008）：
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

/**
 * 微信单条文本的实际可显示上限（UTF-8 字节）。
 *
 * 实测：572 字的中文完整显示，984 字的只显示前几条（客户端折叠，不是发送失败）。
 * 中文一字 3 字节，取 500 中文字 ≈ 1500 字节，984 字正好拆两条、每条都能完整显示。
 */
export const MAX_TEXT_BYTES = 1_500;

/** 中文（含日韩汉字与假名）：这些字符包在斜体里微信渲染难看，官方实现同样去标记。 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 组装一条交付的完整文本；`detail` 不支持折叠，按协议直接省略。 */
export function composeDeliveryText(delivery: Delivery): string {
  const sections: string[] = [];
  const title = typeof delivery.title === 'string' ? delivery.title.trim() : '';
  const body = typeof delivery.body === 'string' ? delivery.body.trim() : '';
  // 回应主人刚发的那条消息（inReplyTo）只发正文：一问一答的正文自己就说明是什么，
  // 加个「回复」抬头只是噪音（核心也按「回复不带标题」写标题，见核心 ADR-0030；组装规则见 ADR-0008）。
  // 正文为空时仍发标题：宁可多发一行，也不能因为丢标题而发出一条空消息。
  if (title !== '' && (delivery.inReplyTo === undefined || body === '')) sections.push(toWeChatMarkdown(title));
  if (body !== '') sections.push(toWeChatMarkdown(body));
  if (delivery.interaction) {
    const interaction = renderInteraction(delivery.interaction);
    // 交互段与标题/正文走同一套降级：detail/选项文案里的原始标记同样不能露出。
    if (interaction !== '') sections.push(toWeChatMarkdown(interaction));
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

  // 输入里的 NUL 先清掉：占位符是 NUL+序号+NUL，输入自带同形串会被 restore
  // 当成占位符，越界变空串（吞内容）或命中则错位复制。
  const source = markdown.split(String.fromCharCode(0)).join('');
  const body = source
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
    // alt 允许一层方括号、URL 允许一层圆括号：不匹配会把原始标记整个留在正文里。
    .replace(/[ \t]*!\[(?:[^\[\]]|\[[^\]]*\])*\]\((?:[^()]|\([^()]*\))*\)/g, '')
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

export function utf8Bytes(point: string): number {
  const code = point.codePointAt(0) ?? 0;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * 按 `measure` 计的宽度切分，优先在换行处断开。
 *
 * 生产调用按 UTF-8 字节计：微信按字节截断，中文一字 3 字节，按码点算会让 984 字
 * 超限、客户端只显示前几条。切点落在码点边界上，emoji 不会被劈开。
 * 测试可按码点传入 `() => 1`。
 */
export function splitText(
  text: string,
  limit: number = MAX_TEXT_BYTES,
  measure: (point: string) => number = utf8Bytes,
): string[] {
  if (limit <= 0) throw new RangeError('limit 必须为正数');
  const points = Array.from(text);
  if (points.length === 0) return [];
  const prefix: number[] = [0];
  for (const point of points) prefix.push(prefix[prefix.length - 1]! + measure(point));
  if (prefix[prefix.length - 1]! <= limit) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    while (end < points.length && prefix[end + 1]! - prefix[start]! <= limit) end += 1;
    // 单个码点就超限时仍发出去，避免死循环。
    if (end === start) end = start + 1;
    // 在已经装下的区间里找最后一个换行（至少用掉一半容量），避免把一句话劈开。
    let cut = end;
    for (let probe = end; probe > start; probe -= 1) {
      if (points[probe - 1] === '\n' && prefix[probe]! - prefix[start]! >= Math.floor(limit / 2)) {
        cut = probe;
        break;
      }
    }
    chunks.push(points.slice(start, cut).join('').trimEnd());
    start = cut;
    while (start < points.length && points[start] === '\n') start += 1;
  }
  return chunks.filter((chunk) => chunk !== '');
}
