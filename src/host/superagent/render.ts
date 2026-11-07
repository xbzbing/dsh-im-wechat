/**
 * 交付 → 微信文本。
 *
 * 微信没有富文本，也没有可编辑的消息卡片，所以桥要完成的降级有三步（ADR-0003）：
 *
 * 1. **去 Markdown**：`**`、反引号、标题符号、链接语法都拍平成纯文本，链接保留
 *    `文字(地址)` 的可读形态。
 * 2. **没有交互卡也要能作答**：核心把结构化问题放在 `delivery.interaction` 里，
 *    不等同于正文；桥必须把题目与选项写成文字，并给出与核心 `answerFromText`
 *    一致的作答提示（序号 / 选项文字 / 自由输入），否则主人在微信里无从作答。
 * 3. **分条**：超过 `maxText` 时按段落边界切分，宁可多条也不截断。
 */

import { renderInteraction } from '../../shared/question-text.ts';

export { renderInteraction } from '../../shared/question-text.ts';
import type { Delivery } from './protocol.ts';

/** 桥上声明的单条字符上限。 */
export const MAX_TEXT_CHARS = 1_800;

/** 组装一条交付的完整文本；`detail` 不支持折叠，按协议直接省略。 */
export function composeDeliveryText(delivery: Delivery): string {
  const sections: string[] = [];
  const title = typeof delivery.title === 'string' ? delivery.title.trim() : '';
  const body = typeof delivery.body === 'string' ? delivery.body.trim() : '';
  if (title !== '') sections.push(toPlainText(title));
  if (body !== '') sections.push(toPlainText(body));
  if (delivery.interaction) {
    const interaction = renderInteraction(delivery.interaction);
    if (interaction !== '') sections.push(interaction);
  }
  return sections.join('\n\n');
}

/** 行内 Markdown → 纯文本。规则只覆盖核心产出里会出现的语法。 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, '\n')
    // 围栏代码块：保留内容、去掉围栏。
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => code.replace(/\n$/, ''))
    // 标题：去掉前缀井号，括号里是给核心的锚点，正文不需要。
    .replace(/^#{1,6}\s+(.*)$/gm, '$1')
    // 图片与链接：`[文字](地址)` → `文字(地址)`。
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => (alt ? `${alt}(${url})` : url))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
      label.trim() === url.trim() ? url : `${label}(${url})`)
    // 加粗 / 斜体 / 删除线 / 行内代码。
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,，。；！？]|$)/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    // 引用与列表。
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    // 分隔线。
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
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
