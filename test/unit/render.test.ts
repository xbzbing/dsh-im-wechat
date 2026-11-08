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

test('单下划线斜体也拍平：核心的状态行不再漏出原始标记', () => {
  assert.equal(
    toPlainText('_模型 MiMo\\-V2\\.6\\-Flash · 思考 high · 上下文 175K / 1.0M（17%）_'),
    '模型 MiMo-V2.6-Flash · 思考 high · 上下文 175K / 1.0M（17%）',
  );
  // 结尾前多一个空格（历史上真实出现过）同样要拍平。
  assert.equal(toPlainText('_模型 m _'), '模型 m ');
});

test('核心对「别人写的文字」做的 markdown 转义在这里还原', () => {
  assert.equal(toPlainText('\\*\\*不是加粗\\*\\*'), '**不是加粗**');
  assert.equal(toPlainText('issue \\#118 由 \\@Echosong 创建'), 'issue #118 由 @Echosong 创建');
  // 行首的转义短横不是列表项。
  assert.equal(toPlainText('\\- 不是列表'), '- 不是列表');
});

test('反转义的字符集与核心 escapeMarkdown 一致：斜杠不在其中，就不还原', () => {
  // 跨仓耦合：核心 src/host/shared/markdown.ts 转义 `[\\`*_{}[]()#+-.!|<>@~]`，不含 `/`。
  assert.equal(toPlainText('issue/118'), 'issue/118');
  assert.equal(toPlainText('a\\/b'), 'a\\/b');
});

test('代码里的反斜杠与下划线保持原样', () => {
  const fenced = ['```bash', 'sed -E "s/\\(foo\\)/bar/" file', '```'].join('\n');
  assert.equal(toPlainText(fenced), 'sed -E "s/\\(foo\\)/bar/" file');
  assert.equal(toPlainText('正则 `\\d+\\.\\d+` 匹配小数'), '正则 \\d+\\.\\d+ 匹配小数');
  assert.equal(toPlainText('`_config_` 与 `a_b` 都别动'), '_config_ 与 a_b 都别动');
});

test('单下划线规则不误伤文件名与括号里的标识符', () => {
  assert.equal(toPlainText('_config_.json'), '_config_.json');
  assert.equal(toPlainText('(_build_)'), '(_build_)');
});

test('标识符里的下划线不受单下划线斜体规则影响', () => {
  assert.equal(toPlainText('src/host/super_client/agent_bridge.ts'), 'src/host/super_client/agent_bridge.ts');
  assert.equal(toPlainText('session-a_b_c'), 'session-a_b_c');
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
