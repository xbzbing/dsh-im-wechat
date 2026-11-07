/**
 * 宿主题问的读取与文字作答匹配。
 *
 * DSH 的 `user-questions/request` 是一条 Cordis waterfall：监听器返回的就是答案，
 * 调 `next()` 交给下一个监听器（Web 端也在链上）。桥把题目发到微信，主人在微信里
 * 回一句话，这里把这句话变成结构化答案交回宿主。
 *
 * 匹配规则与核心（`dsh-my-superagent` 的 `answerFromText`）以及
 * `shared/question-text.ts` 的提示语逐条对齐：单题认序号 / 选项文字 / 自由输入；
 * 多题按「；」「。」或换行分段，段数对上就一段一题；计划审阅认批准词与继续规划。
 */

import type { Interaction } from './superagent/protocol.ts';

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestionIntent {
  kind?: string;
  approve?: string;
  reject?: string;
}

export interface AskQuestion {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskQuestionOption[];
  multiSelect?: boolean;
  intent?: AskQuestionIntent;
}

export interface AnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

/** 宿主 `AskUserQuestionAnswer` 的结构形状。 */
export interface Answer {
  answers: AnswerItem[];
}

const DEFAULT_APPROVE = /^(1|批准|通过|同意|可以|approve|yes|y|ok)$/i;
const DEFAULT_KEEP = /^(2|继续规划|keep planning)$/i;
const SEGMENT_SPLIT = /[；;。\n]+/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 把宿主给的题目收窄成确定形状；认不出的题直接丢掉。 */
export function normalizeQuestions(value: unknown): AskQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AskQuestion[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = textOf(record.id);
    const question = textOf(record.question);
    if (id === '' || question === '') continue;
    const options: AskQuestionOption[] = [];
    if (Array.isArray(record.options)) {
      for (const raw of record.options) {
        const option = asRecord(raw);
        const label = textOf(option?.label);
        if (!option || label === '') continue;
        const description = textOf(option.description);
        options.push(description === '' ? { label } : { label, description });
      }
    }
    const intent = asRecord(record.intent);
    const kind = textOf(intent?.kind);
    questions.push({
      id,
      question,
      ...(textOf(record.detail) !== '' ? { detail: textOf(record.detail) } : {}),
      ...(textOf(record.header) !== '' ? { header: textOf(record.header) } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
      ...(kind !== ''
        ? {
          intent: {
            kind,
            ...(textOf(intent?.approve) !== '' ? { approve: textOf(intent?.approve) } : {}),
            ...(textOf(intent?.reject) !== '' ? { reject: textOf(intent?.reject) } : {}),
          },
        }
        : {}),
    });
  }
  return questions;
}

function planReviewQuestion(questions: readonly AskQuestion[]): AskQuestion | null {
  if (questions.length !== 1) return null;
  const question = questions[0];
  return question.intent?.kind === 'plan-review' ? question : null;
}

/** 计划审阅：批准项由题目自己指定，其余选项都算「不批准」。 */
function answerPlanReview(question: AskQuestion, reply: string): Answer {
  const options = question.options ?? [];
  const approve = question.intent?.approve ?? options[0]?.label ?? '批准';
  const keep = options.find((option) => option.label !== approve)?.label ?? '继续规划';
  if (reply.toLowerCase() === approve.toLowerCase() || DEFAULT_APPROVE.test(reply)) {
    return { answers: [{ id: question.id, selected: [approve] }] };
  }
  if (reply.toLowerCase() === keep.toLowerCase() || DEFAULT_KEEP.test(reply)) {
    return { answers: [{ id: question.id, selected: [keep] }] };
  }
  return { answers: [{ id: question.id, selected: [keep], custom: reply }] };
}

/** 单题：精确选项 → 序号/文字组合 → 自由输入。 */
function answerOne(question: AskQuestion, reply: string): AnswerItem {
  const options = question.options ?? [];
  const exact = options.find((option) => option.label.toLowerCase() === reply.toLowerCase());
  if (exact) return { id: question.id, selected: [exact.label] };

  const tokens = reply.split(/[\s,，、]+/).filter(Boolean);
  const labels = tokens.map((token) => {
    if (/^\d+$/.test(token)) return options[Number(token) - 1]?.label;
    return options.find((option) => option.label.toLowerCase() === token.toLowerCase())?.label;
  });
  const resolved = labels.length > 0 && labels.every((label) => label !== undefined);
  if (options.length > 0 && resolved && (question.multiSelect || labels.length === 1)) {
    return { id: question.id, selected: [...new Set(labels as string[])] };
  }
  return { id: question.id, selected: [], custom: reply };
}

/**
 * 主人的一句话 → 结构化答案。
 *
 * 返回 `null` 表示这句话不是作答（例如只是聊天），交给普通消息路径。
 */
export function answerFromText(questions: readonly AskQuestion[], input: string): Answer | null {
  const reply = input.trim();
  if (reply === '' || questions.length === 0) return null;

  const plan = planReviewQuestion(questions);
  if (plan) return answerPlanReview(plan, reply);

  if (questions.length > 1) {
    const segments = reply.split(SEGMENT_SPLIT).map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === questions.length) {
      return { answers: questions.map((question, index) => answerOne(question, segments[index])) };
    }
    return { answers: questions.map((question) => ({ id: question.id, selected: [], custom: reply })) };
  }

  return { answers: [answerOne(questions[0], reply)] };
}

/** 一组题目 → 渲染用的交互形状（与核心交付里的 `interaction` 同构）。 */
export function questionsToInteraction(questions: readonly AskQuestion[]): Interaction {
  return {
    questions: questions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.detail ? { detail: question.detail } : {}),
      ...(question.header ? { header: question.header } : {}),
      ...(question.options ? { options: question.options } : {}),
      ...(question.multiSelect ? { multiSelect: true } : {}),
      ...(question.intent?.kind === 'plan-review' || question.intent?.kind === 'approval'
        ? { intent: question.intent.kind }
        : {}),
    })),
  };
}
