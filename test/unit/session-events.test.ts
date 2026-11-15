import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dispatchSessionEvent } from '../../src/host/session-events.ts';
import type { SessionEventDeps } from '../../src/host/session-events.ts';

function deps(overrides: Partial<SessionEventDeps> = {}): SessionEventDeps & { calls: string[] } {
  const calls: string[] = [];
  const base: SessionEventDeps = {
    ownFeaturesActive: () => true,
    longTasks: { handleEvent: (id) => calls.push(`long:${id}`) },
    binding: () => ({ sessionId: 'bound', workspaceId: '', boundAt: 0 }),
    ownerUserId: () => 'owner-1',
    typingStop: () => calls.push('typing'),
    forwardPresented: () => calls.push('present'),
    watchHandle: (id) => calls.push(`watch:${id}`),
    directHandle: (id) => calls.push(`direct:${id}`),
    ...overrides,
  };
  return { ...base, calls };
}

test('会话事件：命令观察者拿到所有会话，直连只拿绑定会话', () => {
  const d = deps();
  dispatchSessionEvent(d, 'other', { type: 'turn/end' });
  assert.deepEqual(d.calls, ['long:other', 'watch:other']);

  d.calls.length = 0;
  dispatchSessionEvent(d, 'bound', { type: 'turn/end' });
  assert.deepEqual(d.calls, ['long:bound', 'watch:bound', 'typing', 'direct:bound']);
});

test('会话事件：present 只转发绑定会话的图片', () => {
  const d = deps();
  dispatchSessionEvent(d, 'other', { type: 'deliverables/presented' });
  assert.deepEqual(d.calls, ['long:other', 'watch:other']);

  d.calls.length = 0;
  dispatchSessionEvent(d, 'bound', { type: 'deliverables/presented' });
  assert.deepEqual(d.calls, ['long:bound', 'watch:bound', 'present', 'direct:bound']);
});

test('会话事件：自有功能不生效时整段不进', () => {
  const d = deps({ ownFeaturesActive: () => false });
  dispatchSessionEvent(d, 'bound', { type: 'turn/end' });
  assert.deepEqual(d.calls, []);
});
