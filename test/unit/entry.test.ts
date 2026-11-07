import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, inject, name } from '../../index.ts';

test('插件名与 cordis.patch.yml 的 id 一致', () => {
  assert.equal(name, 'dsh-im-wechat');
});

test('骨架导出齐全且 apply 不抛', () => {
  assert.deepEqual(inject, []);
  assert.doesNotThrow(() => apply({}));
});
