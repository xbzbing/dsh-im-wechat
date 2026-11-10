import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BridgeBinder } from '../../src/host/superagent/link.ts';
import type { SuperagentScope } from '../../src/host/superagent/link.ts';
import type { WeixinBridge } from '../../src/host/superagent/bridge.ts';
import type { OwnerMessageDraft } from '../../src/host/superagent/protocol.ts';

const DRAFT: OwnerMessageDraft = { messageId: 'm1', sender: 'owner-1', text: 'hi', at: 1 };

/** 桥最小替身：绑定器只调 attachHandle/detachHandle。 */
function fakeBridge(): WeixinBridge {
  return {
    attachHandle() {},
    detachHandle() {},
  } as unknown as WeixinBridge;
}

/** 注册表：前 `failFirst` 次注册抛 account-already-bridged，之后成功。 */
function makeScope(failFirst: number): { scope: SuperagentScope; state: { attempts: number; received: number } } {
  const state = { attempts: 0, received: 0 };
  const handle = {
    id: 'weixin:bot@im.bot',
    protocol: 'my-superagent/v1',
    async receive() {
      state.received += 1;
      return { accepted: true } as const;
    },
    async answer() {
      return { accepted: true } as const;
    },
    update() {},
    commands: () => [],
    isOwner: () => true,
    dispose() {},
  };
  const scope: SuperagentScope = {
    mySuperagent: {
      protocol: { versions: ['my-superagent/v1'], features: [] },
      bridges: {
        register() {
          state.attempts += 1;
          if (state.attempts <= failFirst) throw new Error('account-already-bridged');
          return handle;
        },
      },
    },
    effect: (execute) => {
      execute();
      return undefined;
    },
  };
  return { scope, state };
}

test('注册失败不静默：registrationError 可见，下次入站补注册并当条交付', async () => {
  const { scope, state } = makeScope(1);
  const binder = new BridgeBinder();
  binder.attach(scope);
  binder.bind(fakeBridge());
  // attach 时桥还没绑定（扫码前核心就绪的常态），bind 才是第一次注册尝试。
  assert.equal(state.attempts, 1);
  assert.equal(binder.registered, false);
  assert.equal(binder.registrationError, 'account-already-bridged');

  // 首次入站补注册（第二次尝试成功），同一条消息继续走正常路径，不丢。
  const result = await binder.receive(DRAFT);
  assert.deepEqual(result, { accepted: true });
  assert.equal(binder.registered, true);
  assert.equal(binder.registrationError, undefined);
  assert.equal(state.received, 1);
  assert.equal(state.attempts, 2);
});

test('持续失败时 receive 返回 null 且带错误；detach 后按「核心不在」处理', async () => {
  const { scope, state } = makeScope(Number.POSITIVE_INFINITY);
  const binder = new BridgeBinder();
  binder.attach(scope);
  binder.bind(fakeBridge());
  assert.equal(state.attempts, 1);

  assert.equal(await binder.receive(DRAFT), null);
  assert.equal(state.attempts, 2, '入站触发了一次补注册');
  assert.equal(binder.registrationError, 'account-already-bridged');
  assert.equal(binder.registered, false);

  // 服务撤销后是「核心不在」的常态：旧错误必须清掉，否则每条入站都误报注册失败。
  binder.detach();
  assert.equal(binder.registrationError, undefined);
  assert.equal(await binder.receive(DRAFT), null);
  assert.equal(state.attempts, 2, '核心不在时不再尝试注册');
});
