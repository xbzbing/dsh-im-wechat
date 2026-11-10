import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  composeDeliveryText,
  renderInteraction,
  splitText,
  toWeChatMarkdown,
} from '../../src/host/superagent/render.ts';
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

test('标题与正文保留 Markdown（客户端原生渲染）', () => {
  assert.equal(
    composeDeliveryText(delivery({ title: '**构建完成**', body: '- 第一步\n- 第二步' })),
    '**构建完成**\n\n- 第一步\n- 第二步',
  );
});

test('回应主人消息的交付只发正文：一问一答不带标题', () => {
  assert.equal(
    composeDeliveryText(delivery({ title: '回复', body: '明天晴，12°C', inReplyTo: 'mid-1' })),
    '明天晴，12°C',
  );
});

test('主动推送才带标题：主人要知道这条是什么', () => {
  assert.equal(
    composeDeliveryText(delivery({ title: '长任务完成「周报」', body: '已完成' })),
    '长任务完成「周报」\n\n已完成',
  );
});

test('回应主人消息但正文为空时仍发标题：宁可多余，也不能发一条空消息', () => {
  assert.equal(composeDeliveryText(delivery({ title: '回复', body: '', inReplyTo: 'mid-1' })), '回复');
});

test('表格、链接、H1-H4、引用、分隔线、代码原样透传', () => {
  const source = [
    '# 一级标题',
    '',
    '| 城市 | 温度 |',
    '| --- | --- |',
    '| 北京 | 12°C |',
    '',
    '> 引用',
    '',
    '---',
    '',
    '看 [文档](https://example.com/a) 与 `code`',
    '',
    '```bash',
    'ls -l',
    '```',
  ].join('\n');
  assert.equal(toWeChatMarkdown(source), source);
});

test('H5/H6 客户端不渲染标记：去井号留文字，H1-H4 不动', () => {
  assert.equal(toWeChatMarkdown('##### 五级标题'), '五级标题');
  assert.equal(toWeChatMarkdown('###### 六级标题'), '六级标题');
  assert.equal(toWeChatMarkdown('#### 四级标题'), '#### 四级标题');
});

test('图片整段丢弃（客户端不渲染）', () => {
  assert.equal(toWeChatMarkdown('看图 ![截图](https://example.com/a.png) 结束'), '看图 结束');
  assert.equal(toWeChatMarkdown('![只有图](https://example.com/a.png)'), '');
});

test('图片降级覆盖 alt 带方括号与 URL 带一层括号', () => {
  // 这两类不匹配时会把原始标记整个留在正文里，比不处理还难看。
  assert.equal(toWeChatMarkdown('看图 ![a[b]](https://x/y) 完'), '看图 完');
  assert.equal(toWeChatMarkdown('![x](https://e/a(b)) 结尾'), '结尾');
});

test('输入里自带的 NUL 占位符不会被错位替换', () => {
  // 占位符形如 NUL+序号+NUL：输入里的同形串必须先清掉，否则会吞内容或把代码段复制一份。
  const NUL = String.fromCharCode(0);
  assert.equal(toWeChatMarkdown(`\`x\` 与 ${NUL}0${NUL}`), '`x` 与 0');
  assert.equal(toWeChatMarkdown(`前${NUL}0${NUL}后`), '前0后');
});

test('删除线去标记留文字（客户端不渲染）', () => {
  assert.equal(toWeChatMarkdown('~~旧结论~~ 新结论'), '旧结论 新结论');
});

test('中文斜体去标记，英文斜体保留', () => {
  assert.equal(toWeChatMarkdown('*重点*'), '重点');
  assert.equal(toWeChatMarkdown('_模型 MiMo-V2.6-Flash_'), '模型 MiMo-V2.6-Flash');
  assert.equal(toWeChatMarkdown('***又粗又斜***'), '又粗又斜');
  // 英文斜体客户端能渲染，保留标记。
  assert.equal(toWeChatMarkdown('*italic*'), '*italic*');
  assert.equal(toWeChatMarkdown('_italic_'), '_italic_');
});

test('加粗始终保留，不会被斜体规则拆开', () => {
  assert.equal(toWeChatMarkdown('**加粗中文**'), '**加粗中文**');
  assert.equal(toWeChatMarkdown('__加粗中文__'), '__加粗中文__');
  assert.equal(toWeChatMarkdown('**粗** 与 *斜*'), '**粗** 与 斜');
});

test('核心对「别人写的文字」做的转义保持不变（交给客户端的 Markdown 解析）', () => {
  assert.equal(toWeChatMarkdown('\\*\\*不是加粗\\*\\*'), '\\*\\*不是加粗\\*\\*');
  assert.equal(toWeChatMarkdown('issue \\#118 由 \\@Echosong 创建'), 'issue \\#118 由 \\@Echosong 创建');
});

test('代码里的反斜杠、下划线、井号保持原样', () => {
  const fenced = ['```bash', 'sed -E "s/\\(foo\\)/bar/" file', '```'].join('\n');
  assert.equal(toWeChatMarkdown(fenced), fenced);
  assert.equal(toWeChatMarkdown('正则 `\\d+\\.\\d+` 匹配小数'), '正则 `\\d+\\.\\d+` 匹配小数');
  assert.equal(toWeChatMarkdown('`_config_` 与 `a_b` 都别动'), '`_config_` 与 `a_b` 都别动');
  assert.equal(toWeChatMarkdown('```\n# 不是标题\n* 不是列表\n```'), '```\n# 不是标题\n* 不是列表\n```');
});

test('单下划线规则不误伤文件名、括号里的标识符与路径', () => {
  assert.equal(toWeChatMarkdown('_config_.json'), '_config_.json');
  assert.equal(toWeChatMarkdown('(_build_)'), '(_build_)');
  assert.equal(toWeChatMarkdown('src/host/super_client/agent_bridge.ts'), 'src/host/super_client/agent_bridge.ts');
  assert.equal(toWeChatMarkdown('session-a_b_c'), 'session-a_b_c');
});

test('多余空行收敛成一条，行尾空白清掉', () => {
  assert.equal(toWeChatMarkdown('甲\n\n\n\n乙   \n'), '甲\n\n乙');
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

test('交互段也走降级：客户端渲染不了的标记不露出', () => {
  const text = composeDeliveryText(
    delivery({
      title: '',
      body: '',
      interaction: {
        questions: [{
          id: 'plan',
          question: '计划是否批准',
          detail: '带 ~~删除线~~ 与 ![图](https://x/y.png)',
          intent: 'plan-review',
          options: [{ label: '批准' }],
        }],
      },
    }),
  );
  assert.equal(text.includes('~~'), false, '删除线标记不能原样露出');
  assert.equal(text.includes('!['), false, '图片标记不能原样露出');
  assert.match(text, /带 删除线 与/);
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
