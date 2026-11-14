import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * 装机契约（ADR-0024）：DSH 版本门禁与「零运行时依赖」的边界。
 *
 * 这些字段错了不会让任何行为测试变红：要么在别人的机器上装不上，要么让 npm 装进
 * 第二份宿主包（Symbol 查表失效，症状是插件加载不上），所以单独立一组断言。
 */
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

test('DSH 门禁看 engines.dsh：下界钉在基线，上界卡在 0.3', () => {
  const range = manifest.engines?.dsh ?? '';
  // 有 engines.dsh 时 DSH 只按它判兼容；缺了会退化成「按 DSH peer 反推」，
  // 那样多加一个 peer 就顺手改了装机门槛。
  assert.notEqual(range, '', '必须声明 engines.dsh');
  assert.match(range, /^>=0\.2\.2-rc\.1\b/, '下界是钉住的最老可用版本，放宽会让老 DSH 装上新面板');
  assert.match(range, / <0\.3\.0$/, '没有上界就等于承诺 0.x 永远兼容');
});

test('node 门槛是 24：22 的测试运行器会把直连用例误判为取消', () => {
  assert.equal(manifest.engines?.node, '>=24.0.0');
});

test('DSH 包只作可选 peer：npm 装机不去拉宿主包', () => {
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], '运行时依赖必须为空');
  assert.deepEqual(Object.keys(manifest.optionalDependencies ?? {}), [], '可选依赖也不能有');

  const peers = Object.keys(manifest.peerDependencies ?? {});
  assert.ok(peers.length > 0, '必须声明 peerDependencies');
  for (const name of peers) {
    assert.match(name, /^@deepseek-ai\//, `peer 只允许宿主平台包：${name}`);
    // 非可选 peer 会被 npm 自动装进项目：那是宿主包的第二个副本。
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} 必须标 optional`);
  }
});

test('peer 的版本下界与 engines.dsh 钉同一个基线', () => {
  // 两边各写各的，迟早会出现「门禁放行、peer 更严」的组合，装机时才炸。
  assert.match(manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? '', /0\.2\.2-rc\.1/);
});
