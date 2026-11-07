import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  LoginStateStore,
  accountTail,
  describeLoginState,
  parseLoginState,
} from '../../src/host/state/login-state.ts';
import { SyncCursorStore } from '../../src/host/state/sync-cursor.ts';
import { ContextTokenStore } from '../../src/host/state/context-tokens.ts';
import { resolveDataDir, safeSegment } from '../../src/host/state/paths.ts';

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-state-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LOGIN = {
  botToken: 'token-abc',
  account: 'b0f5860fdecb@im.bot',
  userId: 'wx-user-1',
  baseUrl: 'https://ilinkai.weixin.qq.com',
  loggedInAt: 1_760_000_000_000,
};

test('数据目录跟随 DSH_HOME，缺省落到 ~/.dsh', () => {
  assert.equal(resolveDataDir({ DSH_HOME: '/srv/dsh' }, '/home/u'), '/srv/dsh/dsh-im-wechat');
  assert.equal(resolveDataDir({}, '/home/u'), '/home/u/.dsh/dsh-im-wechat');
  assert.equal(resolveDataDir({ DSH_HOME: '  ' }, '/home/u'), '/home/u/.dsh/dsh-im-wechat');
});

test('账号 id 拼进文件名前被收窄', () => {
  assert.equal(safeSegment('b0f@im.bot'), 'b0f@im.bot');
  assert.equal(safeSegment('../../etc/passwd'), '.._.._etc_passwd');
  assert.equal(safeSegment(''), 'unknown');
});

test('登录态写入 0600、目录 0700，且能读回', async () => {
  await withDir(async (dir) => {
    const store = new LoginStateStore({ dir });
    await store.save(LOGIN);
    const mode = (await stat(store.path)).mode & 0o777;
    assert.equal(mode, 0o600);
    const dirMode = (await stat(dir)).mode & 0o777;
    assert.equal(dirMode, 0o700);
    const loaded = await store.load();
    assert.deepEqual(loaded, { version: 1, ...LOGIN });
  });
});

test('面板视图不含 token', async () => {
  await withDir(async (dir) => {
    const store = new LoginStateStore({ dir });
    const saved = await store.save(LOGIN);
    const view = describeLoginState(saved);
    assert.equal(view.loggedIn, true);
    assert.equal(view.accountTail, 'b0f5…@im.bot');
    assert.equal(JSON.stringify(view).includes('token-abc'), false);
    assert.equal(accountTail('ab'), 'ab');
  });
});

test('登录态字段非法时作废并隔离，不让插件起不来', async () => {
  await withDir(async (dir) => {
    const store = new LoginStateStore({ dir });
    await store.save(LOGIN);
    // 手工把 token 抹成空串：形状校验应判非法。
    const path = store.path;
    const broken = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    broken.botToken = '';
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, JSON.stringify(broken), 'utf8');
    assert.equal(await store.load(), null);
    assert.equal(await store.load(), null);
  });
});

test('登出清理掉登录文件', async () => {
  await withDir(async (dir) => {
    const store = new LoginStateStore({ dir });
    await store.save(LOGIN);
    await store.clear();
    assert.equal(await store.load(), null);
    await store.clear();
  });
});

test('parseLoginState 拒绝版本不符与缺字段', () => {
  assert.equal(parseLoginState(null), null);
  assert.equal(parseLoginState({ version: 2, ...LOGIN }), null);
  assert.equal(parseLoginState({ version: 1, ...LOGIN, baseUrl: '' }), null);
  assert.equal(parseLoginState({ version: 1, ...LOGIN, loggedInAt: 'x' }), null);
});

test('游标按账号分文件保存与读取', async () => {
  await withDir(async (dir) => {
    const store = new SyncCursorStore({ dir });
    assert.equal(await store.load('acc1'), '');
    await store.save('acc1', 'CURSOR-1');
    assert.equal(await store.load('acc1'), 'CURSOR-1');
    assert.equal(await store.load('acc2'), '');
    assert.ok(store.path('acc1').endsWith('cursor-acc1.json'));
  });
});

test('context_token 按账号与用户归一存取并落盘', async () => {
  await withDir(async (dir) => {
    const store = new ContextTokenStore({ dir });
    store.set('acc', 'User-A', 'tok-1');
    assert.equal(store.get('acc', 'user-a'), 'tok-1');
    assert.equal(store.get('other', 'user-a'), undefined);
    await store.flush();

    const reloaded = new ContextTokenStore({ dir });
    await reloaded.hydrate('acc');
    assert.equal(reloaded.get('acc', 'USER-A'), 'tok-1');
    const text = await readFile(reloaded.path('acc'), 'utf8');
    assert.equal(text.includes('tok-1'), true);
  });
});

test('清空账号 token 后不再返回旧值', async () => {
  await withDir(async (dir) => {
    const store = new ContextTokenStore({ dir });
    store.set('acc', 'user-a', 'tok-1');
    await store.flush();
    await store.clearAccount('acc');
    assert.equal(store.get('acc', 'user-a'), undefined);
  });
});
