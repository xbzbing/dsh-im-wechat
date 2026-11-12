import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

const release = read('.github/workflows/release.yml');
const ci = read('.github/workflows/ci.yml');
const manifest = JSON.parse(read('package.json'));

/** 去掉整行 YAML 注释：安全断言只看真正生效的配置，不看注释里提到的词。 */
function withoutComments(workflow: string): string {
  return workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

const releaseCode = withoutComments(release);

/**
 * 发布流水线的守门测试（ADR-0020）。
 *
 * 这些约束单看 YAML 很难发现被破坏：把 `id-token: write` 挪到装依赖的那个 job
 * 上，或者「临时」加回 NPM_TOKEN，流水线照样能发布成功，只是安全边界没了。
 */
test('发布只在 master 上跑，手动触发别的分支不发布', () => {
  assert.match(release, /branches:\s*\[master\]/);
  assert.match(release, /if:\s*github\.ref == 'refs\/heads\/master'/);
  // 非 master 的分支要给出可见说明，否则两个 job 跳过会静默变绿。
  assert.match(release, /release runs on master only/);
});

test('发布 job 不装依赖，门禁 job 不拿发布身份', () => {
  const [gatePart, releasePart] = release.split(/\n  release:\n/);
  assert.ok(gatePart && releasePart, 'release.yml 应当分成 gate 与 release 两个 job');

  // 门禁会执行依赖代码：不能拿到推 tag 或签 OIDC 身份的能力。
  assert.doesNotMatch(gatePart, /id-token:\s*write/);
  assert.doesNotMatch(gatePart, /contents:\s*write/);
  assert.match(gatePart, /persist-credentials:\s*false/);

  // 发布 job 不 checkout 源码、不装依赖，只从 artifact 取 tgz。
  assert.doesNotMatch(releasePart, /actions\/checkout/);
  assert.doesNotMatch(releasePart, /npm ci/);
  assert.match(releasePart, /contents:\s*write/);
  assert.match(releasePart, /id-token:\s*write/);
});

test('npm 走可信发布：不留任何长期令牌', () => {
  // 只允许 OIDC 换令牌；出现 secrets.NPM_TOKEN 就说明退回了长期令牌方案。
  assert.doesNotMatch(releaseCode, /NPM_TOKEN/);
  assert.doesNotMatch(releaseCode, /NODE_AUTH_TOKEN/);
  // setup-node 写 registry-url 会顺手写一行读 NODE_AUTH_TOKEN 的 .npmrc，
  // 可信发布下那行没有来源，会变成认证失败。
  assert.doesNotMatch(releaseCode, /registry-url/);
  assert.match(release, /npm publish "dsh-im-wechat-\$V\.tgz" --provenance --access public/);
});

test('发布前先过门禁并自检产物，正文不入库就不发', () => {
  assert.match(release, /npm run check/);
  assert.match(release, /node scripts\/assert-pack\.mjs pkg\/package/);
  assert.match(release, /docs\/releases\/v\$V\.md/);
  // 缺正文必须在不可逆的 npm publish 之前失败。
  const notesIndex = release.indexOf('Release notes');
  const publishIndex = release.indexOf('Publish to npm');
  assert.ok(notesIndex > 0 && notesIndex < publishIndex, '正文校验要排在 npm publish 之前');
});

test('Release 一定带 tgz 附件：页面已存在时补传', () => {
  // 「从 Release 装」是 README 的官方安装路径之一，附件缺了等于半成品。
  assert.match(release, /gh release create "v\$V" "dsh-im-wechat-\$V\.tgz"/);
  assert.match(release, /gh release upload "v\$V" "dsh-im-wechat-\$V\.tgz" --clobber/);
  // 预发布也要附件：npm 发不了的时候它就是唯一的安装来源。
  assert.match(release, /CHANNEL=\(--prerelease\)/);
});

test('每一步先看状态，重跑能接着走', () => {
  for (const marker of ['tag=done', 'gh=done', 'npm=done', 'npm=skipped']) {
    assert.match(release, new RegExp(marker), `缺少幂等标记 ${marker}`);
  }
  // 预发布不发 npm。
  assert.match(release, /prerelease != 'true' && steps\.state\.outputs\.npm != 'done'/);
});

test('CI 门禁固定 node 24：node 22 的测试运行器会把直连用例误判为取消', () => {
  assert.match(ci, /node-version:\s*'24\.x'/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /npm run check/);
  assert.match(ci, /permissions:\s*\n\s*contents:\s*read/);
});

test('包清单能支撑可信发布：不 private、有 repository', () => {
  assert.notEqual(manifest.private, true);
  assert.equal(manifest.repository?.url, 'git+https://github.com/xbzbing/dsh-im-wechat.git');
  assert.equal(manifest.publishConfig?.access, 'public');
});
