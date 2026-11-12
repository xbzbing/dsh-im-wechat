import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_IMAGE_PROMPT, buildPromptContent, textContent, withImageHint } from '../../src/host/prompt-parts.ts';

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
  const hinted = withImageHint([IMAGE_PART]);
  assert.deepEqual(hinted[0], { type: 'text', text: DEFAULT_IMAGE_PROMPT });
  assert.deepEqual(hinted[1], IMAGE_PART);
});

test('已经有文字、或根本没有图片时不补提示', () => {
  assert.deepEqual(withImageHint([{ type: 'text', text: '看图' }, IMAGE_PART]), [
    { type: 'text', text: '看图' },
    IMAGE_PART,
  ]);
  assert.deepEqual(withImageHint([]), []);
});

test('取出真实文字用于「去掉图片重发」', () => {
  assert.equal(textContent([{ type: 'text', text: '捕获到的报错' }, IMAGE_PART]), '捕获到的报错');
  assert.equal(textContent([IMAGE_PART]), '');
  assert.equal(textContent([]), '');
});
