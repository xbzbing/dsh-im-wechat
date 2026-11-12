/**
 * 题目与选项的文字呈现。
 *
 * 微信没有交互卡，DSH 的两条提问路径（核心交付里的 `interaction`、宿主的
 * `user-questions/request`）都得拍成文字；两条路径共用这一份渲染，主人在微信里
 * 看到的格式才不会一会儿一个样（ADR-0005）。
 *
 * 提示语与核心的文字作答匹配规则逐条对齐，改一边必须改另一边。
 */

import type { Interaction, InteractionQuestion } from '../host/superagent/protocol.ts';

export type { Interaction, InteractionQuestion };

const CIRCLED_NUMBERS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

// 多题时题目用圆圈序号、选项用纯数字：两层都是「1.」时主人分不清在给哪一层回复。
// 超过 20 题退回纯数字；宿主一次提问远到不了这个数。
function questionMarker(index: number): string {
  return CIRCLED_NUMBERS[index] ?? `${index + 1}.`;
}

export function renderInteraction(interaction: Interaction): string {
  const { questions } = interaction;
  if (questions.length === 0) return '';

  const planReview = questions.length === 1 && questions[0]?.intent === 'plan-review';
  if (planReview) {
    const question = questions[0] as InteractionQuestion;
    const options = question.options ?? [];
    const approve = options[0]?.label ?? '批准';
    const keep = options.find((option) => option.label !== approve)?.label ?? '继续规划';
    return [
      '计划等待审阅',
      ...(question.detail ? ['', question.detail] : []),
      '',
      `回复「${approve}」开始执行；回复「${keep}」或其他文字即作为修改意见，继续规划。`,
    ].join('\n');
  }

  const lines: string[] = ['需要你回答的问题', ''];
  questions.forEach((question, index) => {
    // 分隔线让主人在微信里一眼看出上一题的选项到哪结束；只在题与题之间加。
    if (index > 0) lines.push('---', '');
    const title = question.header ? `${question.header}：${question.question}` : question.question;
    const marker = questions.length > 1 ? `${questionMarker(index)} ` : '';
    lines.push(`${marker}${title}${question.multiSelect ? '（可多选）' : ''}`);
    if (question.detail) lines.push('', question.detail);
    if (question.options?.length) {
      lines.push('');
      question.options.forEach((option, at) => {
        lines.push(`${at + 1}. ${option.description ? `${option.label} — ${option.description}` : option.label}`);
      });
    }
    lines.push('');
  });
  if (interaction.rationale) lines.push(`建议理由：${interaction.rationale}`, '');
  lines.push(
    questions.length > 1
      ? '按题目顺序分行（或用「；」「。」分隔）回复，每段对应一题，可写序号或选项文字。'
      : '回复序号选择（多选用逗号分隔），或直接回复文字作答。',
  );
  return lines.join('\n');
}

