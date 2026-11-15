/**
 * 独立模式测试的公共夹具：假会话控制器、发送记录与临时状态目录。
 *
 * `direct.test.ts` 与 `direct-files.test.ts` 共用（两份用例测的是同一个 DirectChat）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DirectChat } from '../../../src/host/direct.ts';
import type { DirectController } from '../../../src/host/direct.ts';
import type { PromptPart } from '../../../src/host/prompt-parts.ts';
import { DirectBindingStore } from '../../../src/host/state/direct-binding.ts';

/** 只有一段文字的内容（组装与提示由 prompt-parts 负责）。 */
export function text(value: string): PromptPart[] {
  return [{ type: 'text', text: value }];
}

/** 回复是异步发送的：等它跑完再断言。 */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-direct-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface FakeController extends DirectController {
  created: { workspaceId?: string }[];
  prompts: { requestId: string; sessionId: string; mode: string; text: string; content: readonly PromptPart[] }[];
  renames: string[];
  setRunning(value: boolean): void;
}

export function fakeController(): FakeController {
  const created: { workspaceId?: string }[] = [];
  const prompts: { requestId: string; sessionId: string; mode: string; text: string; content: readonly PromptPart[] }[] = [];
  const renames: string[] = [];
  let running = false;
  return {
    created,
    prompts,
    renames,
    setRunning(value: boolean) {
      running = value;
    },
    async create(request: { workspaceId?: string }) {
      created.push(request);
      return { sessionId: `s-${created.length}` };
    },
    async prompt(request, _signal) {
      const text = request.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
      prompts.push({ requestId: request.requestId, sessionId: request.sessionId, mode: request.mode, text, content: request.content });
      return { accepted: true };
    },
    async rename(request: { sessionId: string; title: string }) {
      renames.push(`${request.sessionId}:${request.title}`);
    },
    async list() {
      return { items: [{ sessionId: 's-1', running }] };
    },
  };
}

export async function setup(
  t: { after: (fn: () => void) => void },
  options: {
    workspaceId?: string;
    busyMode?: 'queue' | 'steer';
    controller?: FakeController | null;
    submitTimeoutMs?: number;
    applyModel?: (sessionId: string) => void;
    now?: () => number;
  } = {},
) {
  const dir = tempDir(t);
  const store = new DirectBindingStore({ dir });
  await store.hydrate();
  const sent: string[] = [];
  const controller = options.controller === undefined ? fakeController() : options.controller;
  const chat = new DirectChat({
    controller: () => controller,
    store,
    workspaceId: () => options.workspaceId ?? '',
    busyMode: () => options.busyMode ?? 'queue',
    send: async (text: string) => {
      sent.push(text);
      return true;
    },
    isOwner: (sender) => sender === 'owner-1',
    ownerLabel: () => 'abc123',
    now: options.now ?? (() => 1_700_000_000_000),
    ...(options.submitTimeoutMs !== undefined ? { submitTimeoutMs: options.submitTimeoutMs } : {}),
    ...(options.applyModel !== undefined ? { applyModel: options.applyModel } : {}),
  });
  return { chat, store, sent, controller };
}
