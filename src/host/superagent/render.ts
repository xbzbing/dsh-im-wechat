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
 * 3. **还原核心的转义**：核心给外部文本（卡片标题、评论摘录）先做过 markdown 转义，
 *    微信没有渲染器接手，`\*`、`\#` 这类会原样露出来，所以拍平时一并还原字符。
 * 4. **分条**：超过 `maxText` 时按段落边界切分，宁可多条也不截断。
 *
 * 代码（围栏块与行内代码）在拍平前先摘出来、拍平后放回：里面的反斜杠与下划线是作者本意
 * （`s/\(x\)/y/`、`\d+\.\d+`），不能被上面的规则改写。反转义的字符集与核心
 * `dsh-my-superagent` 的 `src/host/shared/markdown.ts` 保持一致，两边要一起改。
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

/**
 * 行内 Markdown → 纯文本。规则只覆盖核心产出里会出现的语法。
 *
 * 代码先摘成占位符再放回，见文件头注释；除代码以外的文本才会被拍平与反转义。
 */
export function toPlainText(markdown: string): string {
  const guarded: string[] = [];
  const hold = (code: string) => `\u0000${guarded.push(code) - 1}\u0000`;
  const body = markdown
    .replace(/\r\n?/g, '\n')
    // 代码：保留内容、去掉围栏/反引号，先换成占位符。
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code: string) => hold(code.replace(/\n$/, '')))
    .replace(/`([^`\n]+)`/g, (_match, code: string) => hold(code))
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
    // 单下划线斜体：核心的状态行曾用 `_…_`，微信不渲染它，留着就是原始标记。
    // 只认「行首或空白后开始、以空白或行尾结束」的一对：`a_b_c`、`_config_.json`、`(_build_)`
    // 都不受影响；代价是 `他说：“_重点_”` 这种引号夹住的仍会漏出标记——宁可漏拍，不误伤标识符。
    .replace(/(^|[ \t])_([^_\n]+)_(?=[ \t]|$)/gm, '$1$2')
    // 引用与列表。
    .replace(/^>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ')
    // 分隔线。
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '')
    // 反转义：只作用于代码之外的文本。放在最后，免得 `\-` 被当成列表或分隔线。
    .replace(/\\([\\`*_{}\[\]()#+\-.!|<>@~])/g, '$1');
  return body.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => guarded[Number(index)] ?? '');
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
