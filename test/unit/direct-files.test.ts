import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HostFileUploader } from '../../src/host/direct.ts';
import type { FakeController } from './helpers/direct-fixtures.ts';
import { fakeController, setup, text } from './helpers/direct-fixtures.ts';

interface UploadCall {
  sessionId: string;
  name?: string;
  bytes: number;
}

/** 宿主 `fileUploads.uploadStream` 的最小替身：记录会话、名字与字节数。 */
function fakeUploader(options: { failName?: string } = {}): { uploader: HostFileUploader; calls: UploadCall[] } {
  const calls: UploadCall[] = [];
  const uploader: HostFileUploader = {
    async uploadStream(request) {
      let bytes = 0;
      for await (const chunk of request.data) bytes += chunk.byteLength;
      if (options.failName !== undefined && request.name === options.failName) throw new Error('磁盘满了');
      calls.push({ sessionId: request.sessionId, ...(request.name !== undefined ? { name: request.name } : {}), bytes });
      return { receiptId: `r-${calls.length}` };
    },
  };
  return { uploader, calls };
}

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n');

test('独立模式：文件先交给宿主暂存，回执作为 part 提交在文字之后', async (t) => {
  const { chat, controller } = await setup(t);
  const { uploader, calls } = fakeUploader();
  chat.attachUploader(uploader);

  assert.equal(
    await chat.submit('owner-1', text('总结一下这个 pdf'), { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }),
    'queued',
  );

  assert.deepEqual(calls, [{ sessionId: 's-1', name: '报告.pdf', bytes: PDF_BYTES.byteLength }]);
  assert.equal(calls[0]?.sessionId, (controller as FakeController).prompts[0]?.sessionId, '回执只对同一个会话有效');
  assert.deepEqual((controller as FakeController).prompts[0]?.content, [
    { type: 'text', text: '总结一下这个 pdf' },
    { type: 'file', receiptId: 'r-1' },
  ]);
});

test('独立模式：只有文件时补「请看这个文件」', async (t) => {
  const { chat, controller } = await setup(t);
  chat.attachUploader(fakeUploader().uploader);

  assert.equal(await chat.submit('owner-1', [], { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }), 'queued');

  const content = (controller as FakeController).prompts[0]?.content ?? [];
  assert.deepEqual(content[0], { type: 'text', text: '请看这个文件' });
  assert.deepEqual(content[1], { type: 'file', receiptId: 'r-1' });
});

test('独立模式：宿主没有文件上传服务时只发文字，并回一句原因', async (t) => {
  const { chat, controller, sent } = await setup(t);

  assert.equal(
    await chat.submit('owner-1', text('看下这个'), { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }),
    'queued',
  );

  assert.deepEqual((controller as FakeController).prompts[0]?.content, [{ type: 'text', text: '看下这个' }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /文件没有收进会话/);
  assert.match(sent[0]!, /报告\.pdf/);
  assert.match(sent[0]!, /文件上传服务/);
});

test('独立模式：上传失败只丢那一个文件，其余照常', async (t) => {
  const { chat, controller, sent } = await setup(t);
  chat.attachUploader(fakeUploader({ failName: '坏的.pdf' }).uploader);

  assert.equal(
    await chat.submit('owner-1', text('两个文件'), {
      files: [{ name: '好的.pdf', bytes: PDF_BYTES }, { name: '坏的.pdf', bytes: PDF_BYTES }],
      dropped: [],
    }),
    'queued',
  );

  const content = (controller as FakeController).prompts[0]?.content ?? [];
  assert.equal(content.filter((part) => part.type === 'file').length, 1);
  assert.equal(content[1]?.type === 'file' ? content[1].receiptId : '', 'r-1');
  assert.match(sent.join('\n'), /坏的\.pdf/);
});

test('独立模式：只有文件且一个都没收下时不建会话、只回原因', async (t) => {
  const { chat, controller, sent } = await setup(t);

  assert.equal(await chat.submit('owner-1', [], { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }), 'ignored');

  assert.deepEqual((controller as FakeController).created, []);
  assert.deepEqual((controller as FakeController).prompts, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /报告\.pdf/);
});

test('独立模式：下载阶段没收下的文件也回一句原因，文字照常送达', async (t) => {
  const { chat, controller, sent } = await setup(t);

  assert.equal(
    await chat.submit('owner-1', text('看下'), {
      files: [],
      dropped: [{ name: '大文件.pdf', reason: '超过 32 MB 上限' }],
    }),
    'queued',
  );

  assert.deepEqual((controller as FakeController).prompts[0]?.content, [{ type: 'text', text: '看下' }]);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /大文件\.pdf/);
  assert.match(sent[0]!, /超过 32 MB 上限/);
});

test('独立模式：文件被拒收时去掉文件用同一个 requestId 重发文字', async (t) => {
  const controller = fakeController();
  const seen: { requestId: string; hasFile: boolean }[] = [];
  controller.prompt = async (request) => {
    const hasFile = request.content.some((part) => part.type === 'file');
    seen.push({ requestId: request.requestId, hasFile });
    if (hasFile) throw new Error('File was not uploaded for this session.');
    return { accepted: true };
  };
  const { chat, sent } = await setup(t, { controller });
  chat.attachUploader(fakeUploader().uploader);

  assert.equal(
    await chat.submit('owner-1', text('看下这个'), { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }),
    'queued',
  );

  assert.deepEqual(seen.map((item) => item.hasFile), [true, false]);
  assert.equal(seen[0]?.requestId, seen[1]?.requestId, '同一个 requestId 让宿主去重');
  assert.match(sent.join('\n'), /文件没有发出去/);
});


test('独立模式：暂存吃满提交预算时只说「提交超时」，不带英文原文', async (t) => {
  const { chat, sent } = await setup(t, { submitTimeoutMs: 20 });
  chat.attachUploader({
    uploadStream(request) {
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')), { once: true });
      });
    },
  });

  assert.equal(await chat.submit('owner-1', [], { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }), 'failed');

  assert.match(sent.join('\n'), /附件暂存超时/);
  assert.match(sent.join('\n'), /报告\.pdf（提交超时）/);
  assert.doesNotMatch(sent.join('\n'), /aborted|AbortError/);
});

test('独立模式：会话已建但文件全没上传成功、又没有文字时不提交', async (t) => {
  const { chat, controller, sent } = await setup(t);
  chat.attachUploader(fakeUploader({ failName: '坏的.pdf' }).uploader);

  assert.equal(await chat.submit('owner-1', [], { files: [{ name: '坏的.pdf', bytes: PDF_BYTES }], dropped: [] }), 'ignored');

  assert.deepEqual((controller as FakeController).prompts, []);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /坏的\.pdf（上传失败）/);
});

test('独立模式：只有文件被拒收时不重发，明确说文件没发出去', async (t) => {
  const controller = fakeController();
  const seen: boolean[] = [];
  controller.prompt = async (request) => {
    seen.push(request.content.some((part) => part.type === 'file'));
    throw new Error('File was not uploaded for this session.');
  };
  const { chat, sent } = await setup(t, { controller });
  chat.attachUploader(fakeUploader().uploader);

  assert.equal(await chat.submit('owner-1', [], { files: [{ name: '报告.pdf', bytes: PDF_BYTES }], dropped: [] }), 'failed');

  assert.deepEqual(seen, [true], '没有文字可重发');
  assert.match(sent.join('\n'), /文件没有发出去/);
  assert.doesNotMatch(sent.join('\n'), /已按文字发送/, '没有文字，不能说已按文字发送');
});
