import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeDeliveryText, renderInteraction, splitText, toPlainText } from '../../src/host/superagent/render.ts';
import type { Delivery } from '../../src/host/superagent/protocol.ts';

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    protocol: 'my-superagent/v1',
    id: 'd-1',
    recipient: 'owner-1',
    intent: 'result',
    title: '完成',
    body: '正文',
    ...overrides,
  };
}

test('标题与正文拍平成纯文本', () => {
  assert.equal(
    composeDeliveryText(delivery({ title: '**构建完成**', body: '- 第一步\n- 第二步' })),
    '构建完成\n\n• 第一步\n• 第二步',
  );
});

test('Markdown 降级：标题、链接、代码、引用、分隔线', () => {
  const text = toPlainText(
    ['# 标题', '看 [文档](https://example.com/a)', '> 引用', '`code` 与 **粗体**', '---', '```', 'fenced', '```'].join('\n'),
  );
  assert.match(text, /^标题$/m);
  assert.match(text, /文档\(https:\/\/example\.com\/a\)/);
  assert.match(text, /^引用$/m);
  assert.match(text, /code 与 粗体/);
  assert.equal(text.includes('---'), false);
  assert.match(text, /^fenced$/m);
});

test('detail 不折叠就省略', () => {
  assert.equal(composeDeliveryText(delivery({ detail: '思考过程' })).includes('思考过程'), false);
});

test('没有交互卡：单题把选项写成带序号的文字', () => {
  const text = composeDeliveryText(
    delivery({
      title: '',
      body: '选一个',
      interaction: {
        questions: [{ id: 'q1', question: '去哪吃饭', options: [{ label: '面' }, { label: '饭', description: '堂食' }] }],
      },
    }),
  );
  assert.match(text, /去哪吃饭/);
  assert.match(text, /1\. 面/);
  assert.match(text, /2\. 饭 — 堂食/);
  assert.match(text, /回复序号选择/);
});

test('多题提示按题目顺序分行作答', () => {
  const text = renderInteraction({
    questions: [
      { id: 'a', question: '第一个', options: [{ label: '甲' }] },
      { id: 'b', question: '第二个', multiSelect: true, options: [{ label: '乙' }] },
    ],
  });
  assert.match(text, /^1\. 第一个$/m);
  assert.match(text, /^2\. 第二个（可多选）$/m);
  assert.match(text, /按题目顺序分行/);
});

test('计划审阅按批准 / 修改意见两种作答呈现', () => {
  const text = renderInteraction({
    questions: [
      {
        id: 'plan',
        question: '计划是否批准',
        detail: '1. 建仓库',
        intent: 'plan-review',
        options: [{ label: '批准' }, { label: '继续规划' }],
      },
    ],
  });
  assert.match(text, /计划等待审阅/);
  assert.match(text, /1\. 建仓库/);
  assert.match(text, /回复「批准」开始执行/);
});

test('分条：优先在换行处断开，不劈开 emoji', () => {
  const line = '这是一行文字\n';
  const text = line.repeat(40).trimEnd();
  const parts = splitText(text, 12);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(Array.from(part).length <= 12);
  }
  const emoji = '😀'.repeat(30);
  const emojiParts = splitText(emoji, 10);
  assert.equal(emojiParts.join(''), emoji);
  for (const part of emojiParts) assert.equal(Array.from(part).length, 10);
});

test('短文本不分条，空文本给出空数组', () => {
  assert.deepEqual(splitText('短', 1800), ['短']);
  assert.deepEqual(splitText('', 1800), []);
});
