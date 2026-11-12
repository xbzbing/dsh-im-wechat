#!/usr/bin/env node
/**
 * 发布产物自检：校验 `npm pack` 出来的 tarball 解包后的内容。
 *
 * `verify-package.mjs` 校验的是工作区（`lib/` 能否由源码确定性重建、`files` 白名单、
 * bin 的 shebang 与真实打包清单）。这里校验的是真正要发布的那一份：门禁 job 与发布
 * job 之间只传 tgz，装进去的东西已经与仓库状态脱钩，所以在不可逆的 `npm publish`
 * 之前再确认一次「要发布的东西是它该有的样子」。
 *
 * 用法：node scripts/assert-pack.mjs <解包后的 package 目录>
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const target = process.argv[2];
if (!target) {
  process.stderr.write('用法：node scripts/assert-pack.mjs <解包后的 package 目录>\n');
  process.exit(2);
}

const failures = [];

async function exists(relativePath) {
  try {
    await stat(join(target, relativePath));
    return true;
  } catch {
    return false;
  }
}

// 装了才会跑的东西：产物、清单、出站命令、面板资源、许可。
const required = [
  'package.json',
  'lib/index.js',
  'lib/client.js',
  'lib/src/host/cli.js',
  'bin/dsh-wechat-send.mjs',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'assets/icon.svg',
  'README.md',
  'LICENSE',
];
for (const file of required) {
  if (!(await exists(file))) failures.push(`缺少 ${file}`);
}

// 源码与构建输入不进包：入口已指向 lib/，多带一份只会变成两份副本。
for (const stale of ['src', 'test', 'scripts', 'node_modules', 'tsconfig.json']) {
  if (await exists(stale)) failures.push(`混进了不该发布的 ${stale}`);
}

let manifest = null;
try {
  manifest = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'));
} catch (error) {
  failures.push(`包里的 package.json 读不出来：${error instanceof Error ? error.message : String(error)}`);
}

if (manifest) {
  const repository = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  if (manifest.version !== repository.version) {
    failures.push(`包里版本 ${manifest.version} 与仓库 ${repository.version} 不一致`);
  }
  if (manifest.name !== repository.name) {
    failures.push(`包里包名 ${manifest.name} 与仓库 ${repository.name} 不一致`);
  }
  // private 的包 npm 会直接拒发，提前说清楚比读 npm 的报错快。
  if (manifest.private === true) failures.push('package.json 仍是 private，npm 会拒绝发布');
  if (typeof manifest.repository?.url !== 'string' || manifest.repository.url === '') {
    failures.push('package.json 缺少 repository：来源证明（provenance）要求它与仓库对应');
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `发布产物自检失败（${failures.length} 项）：\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(`发布产物自检通过：${required.length} 个必需文件俱在，无源码目录\n`);
