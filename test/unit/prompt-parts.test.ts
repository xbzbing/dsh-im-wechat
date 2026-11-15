import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ATTACHMENT_PROMPT,
  DEFAULT_FILE_PROMPT,
  DEFAULT_IMAGE_PROMPT,
  buildPromptContent,
  textContent,
  withAttachmentHint,
  withQuote,
} from '../../src/host/prompt-parts.ts';

const IMAGE = { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'weixin-a.png' } as const;
const IMAGE_PART = { type: 'image', ...IMAGE } as const;

test('文字在前、图片按顺序在后', () => {
  assert.deepEqual(buildPromptContent('看图', [IMAGE]), [
    { type: 'text', text: '看图' },
    { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'weixin-a.png' },
  ]);
});

test('组装只还原主人发的内容，不替它补提示', () => {
  assert.deepEqual(buildPromptContent('   ', [IMAGE]), [IMAGE_PART]);
  assert.deepEqual(buildPromptContent('  ', []), []);
});

test('提交前给只有图片的内容补一句提示', () => {
  const hinted = withAttachmentHint([IMAGE_PART]);
  assert.deepEqual(hinted[0], { type: 'text', text: DEFAULT_IMAGE_PROMPT });
  assert.deepEqual(hinted[1], IMAGE_PART);
});

test('已经有文字、或根本没有图片时不补提示', () => {
  assert.deepEqual(withAttachmentHint([{ type: 'text', text: '看图' }, IMAGE_PART]), [
    { type: 'text', text: '看图' },
    IMAGE_PART,
  ]);
  assert.deepEqual(withAttachmentHint([]), []);
});

test('取出真实文字用于「去掉图片重发」', () => {
  assert.equal(textContent([{ type: 'text', text: '捕获到的报错' }, IMAGE_PART]), '捕获到的报错');
  assert.equal(textContent([IMAGE_PART]), '');
  assert.equal(textContent([]), '');
});

const FILE_PART = { type: 'file', receiptId: 'r-1' } as const;

test('只有文件时补「请看这个文件」', () => {
  const hinted = withAttachmentHint([FILE_PART]);
  assert.deepEqual(hinted[0], { type: 'text', text: DEFAULT_FILE_PROMPT });
  assert.deepEqual(hinted[1], FILE_PART);
});

test('图片与文件都有时补「请看这些附件」', () => {
  const hinted = withAttachmentHint([IMAGE_PART, FILE_PART]);
  assert.deepEqual(hinted[0], { type: 'text', text: DEFAULT_ATTACHMENT_PROMPT });
  assert.deepEqual(hinted.slice(1), [IMAGE_PART, FILE_PART]);
});

test('有文字时文件与图片都不补提示；取出真实文字时忽略文件 part', () => {
  const parts = [{ type: 'text', text: '总结一下' } as const, FILE_PART];
  assert.deepEqual(withAttachmentHint(parts), parts);
  assert.equal(textContent(parts), '总结一下');
  assert.equal(textContent([FILE_PART]), '');
});

const QUOTE_PART = { type: 'text', text: '[引用：文件 报告.pdf]', quote: true } as const;

test('引用标头放在最前面，并打上 quote 标记', () => {
  assert.deepEqual(withQuote([{ type: 'text', text: '这个文件讲什么' }], '[引用：文件 报告.pdf]'), [
    QUOTE_PART,
    { type: 'text', text: '这个文件讲什么' },
  ]);
  assert.deepEqual(withQuote([IMAGE_PART], undefined), [IMAGE_PART]);
});

test('只有引用没有主人文字时，提示跟在标头后面', () => {
  assert.deepEqual(withAttachmentHint([QUOTE_PART, FILE_PART]), [QUOTE_PART, { type: 'text', text: DEFAULT_FILE_PROMPT }, FILE_PART]);
  assert.deepEqual(withAttachmentHint([QUOTE_PART, IMAGE_PART]), [QUOTE_PART, { type: 'text', text: DEFAULT_IMAGE_PROMPT }, IMAGE_PART]);
});

test('引用标头不算主人写的字：取出真实文字与补提示都按主人的文字判断', () => {
  assert.equal(textContent([QUOTE_PART, FILE_PART]), '');
  assert.equal(textContent([QUOTE_PART, { type: 'text', text: '这个文件讲什么' }]), '这个文件讲什么');
  assert.deepEqual(withAttachmentHint([QUOTE_PART, FILE_PART])[0], QUOTE_PART);
});
