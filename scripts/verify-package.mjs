#!/usr/bin/env node
/**
 * 打包自洽性校验（`npm run check` 的一部分）。
 *
 * `lib/` 是 `npm run build` 的产物（见 本仓库 ADR），装的是它、跑的是它，
 * 因此「源码改了但忘了 build」是最常见的翻车方式，而症状在运行期是「面板白屏」
 * 或「插件不激活」，很难从日志反推。这里替代了打包器的自检职责：
 *
 * 1. `lib/` 能否由当前源码确定性重建出来（重建成临时目录后逐字节比对）；
 * 2. 产物在不在、清单指不指得到；
 * 3. 有没有偷偷依赖宿主内部包；
 * 4. 图标与语言资源是否合规、patch 是否只激活自己。
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, listFiles } from './build.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

async function exists(relativePath) {
  try {
    await stat(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

const toPosix = (absolute) => relative(root, absolute).split(sep).join('/');

const manifest = await readJson('package.json');
const packageName = manifest.name;

// 0. 产物目录先兜一道：`lib/` 不入版本库，新克隆上直接跑 verify 是最常见的用法，
//    这里要给出「先跑 npm run build」，而不是让它后面崩成裸 ENOENT 栈。
if (!(await exists('lib'))) {
  process.stderr.write('打包校验失败：缺少 lib/，先跑 npm run build\n');
  process.exit(1);
}

// 1. 必需文件：源码（开发/测试）+ 产物（安装/发布）+ 资源
const required = [
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'assets/icon.svg',
  'README.md',
  'LICENSE',
  'docs/adr/README.md',
  'scripts/build.mjs',
  'tsconfig.json',
  'lib/index.js',
  'lib/client.js',
];
for (const file of required) {
  if (!(await exists(file))) {
    const hint = file.startsWith('lib/') ? '（先跑 npm run build）' : '';
    fail(`缺少必需文件：${file}${hint}`);
  }
}

// 2. 清单字段：入口必须指向构建产物
const expectedExports = ['.', './client', './package.json', './locale/*.json', './icon'];
for (const key of expectedExports) {
  if (!manifest.exports?.[key]) fail(`package.json 缺少 exports['${key}']`);
}
if (manifest.exports?.['.'] !== './lib/index.js') {
  fail("exports['.'] 必须指向构建产物 ./lib/index.js");
}
if (manifest.exports?.['./client'] !== './lib/client.js') {
  fail("exports['./client'] 必须指向构建产物 ./lib/client.js");
}
if (manifest.main !== './lib/index.js') {
  fail('main 必须指向构建产物 ./lib/index.js');
}
if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('package.json 的 dsh.bundle.patch 必须指向 ./cordis.patch.yml');
}
if (manifest.dsh?.client?.platform !== 'web') {
  fail("package.json 的 dsh.client.platform 必须是 'web'");
}
if (!Array.isArray(manifest.dsh?.client?.inject) || manifest.dsh.client.inject.length === 0) {
  fail('package.json 的 dsh.client.inject 必须声明面板依赖的包级顺序');
}
if (manifest.type !== 'module') fail("package.json 的 type 必须是 'module'");

// 3. 零运行时依赖（ADR-0001）：运行时依赖字段必须为空，devDependencies 只放
//    构建与类型工具——「顺手引个库」必须在这里翻车，不能只靠人肉评审。
//    宿主内部包（第二份副本会让 Host 的 Symbol 查表失效）不能在运行时字段里出现；
//    例外只有 peer 的「声明」（ADR-0024）：标了 optional，npm 不会装，只是为了
//    让装机方看到兼容范围，与实际 import 无关。
const RUNTIME_FIELDS = ['dependencies', 'optionalDependencies'];
const DEV_ALLOWLIST = new Set(['typescript', 'esbuild', '@types/node', '@types/react']);
for (const field of RUNTIME_FIELDS) {
  const deps = Object.keys(manifest[field] ?? {});
  if (deps.length > 0) {
    fail(`${field} 必须为空（零运行时依赖）：${deps.join(', ')}；协议实现自写，不引第三方库`);
  }
}
const peers = Object.keys(manifest.peerDependencies ?? {});
for (const name of peers) {
  if (!name.startsWith('@deepseek-ai/')) {
    fail(`peerDependencies 只允许声明宿主平台包：${name}`);
  } else if (manifest.peerDependenciesMeta?.[name]?.optional !== true) {
    fail(`peerDependencies['${name}'] 必须标 optional：否则 npm 会装一份宿主包副本`);
  }
}
for (const dep of Object.keys(manifest.devDependencies ?? {})) {
  if (dep.startsWith('@deepseek-ai/')) {
    fail(`devDependencies 里不能出现宿主内部包：${dep}`);
  } else if (!DEV_ALLOWLIST.has(dep)) {
    fail(`devDependencies 出现白名单外的包：${dep}（新增开发依赖需先评审并更新本白名单）`);
  }
}

// 4. 源码不得 import 宿主内部包。
//
// 唯一的例外是 web 前端的 seed 表：它由 `window.__ModuleLoader__` 在页面启动时注入，
// 从工厂的 `require` 取用是官方姿势（宿主自己的 model-selection 也这么取原语），
// 取不到时必须降级而不是崩。例外写在这里，而不是靠正则漏检——「换个封装就能绕过」
// 的检查等于没有检查。
const SEED_MODULES = new Set(['@deepseek-ai/dsh-client-ui-primitives']);
const sourceFiles = [];
if (await exists('src')) {
  for (const file of await listFiles(join(root, 'src'))) {
    if (/\.(ts|mjs|js)$/.test(file)) sourceFiles.push(file);
  }
}
for (const name of ['index.ts', 'index.js', 'client.ts', 'client.js']) {
  if (await exists(name)) sourceFiles.push(join(root, name));
}
for (const file of sourceFiles) {
  const text = await readFile(file, 'utf8');
  for (const [, spec] of text.matchAll(/['"](@deepseek-ai\/[^'"]+)['"]/g)) {
    if (!SEED_MODULES.has(spec)) {
      fail(`${toPosix(file)} 引用了非白名单宿主包：${spec}`);
    }
  }
}

// 5. lib/ 必须能由当前源码确定性重建 —— 防止「改了源码忘了 build」
// （第 0 步已保证 lib/ 存在。）
const scratch = await mkdtemp(join(tmpdir(), 'dsh-im-wechat-verify-'));
try {
  const rebuilt = await build({ outDir: scratch });
  const shipped = await listFiles(join(root, 'lib'));

  const rebuiltMap = new Map(rebuilt.files.map((file) => [relative(scratch, file), file]));
  const shippedSet = new Set(shipped.map((file) => toPosix(file)));

  for (const [relativePath, absolute] of rebuiltMap) {
    const key = `lib/${relativePath.split(sep).join('/')}`;
    if (!shippedSet.has(key)) {
      fail(`产物缺少文件：${key}（先跑 npm run build）`);
      continue;
    }
    const [expected, actual] = await Promise.all([
      readFile(absolute),
      readFile(join(root, key)),
    ]);
    if (!expected.equals(actual)) {
      fail(`产物与源码不一致：${key}（先跑 npm run build）`);
    }
  }

  for (const key of shippedSet) {
    if (!rebuiltMap.has(key.slice('lib/'.length))) {
      fail(`产物里有源码中不存在的文件：${key}`);
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// 6. 客户端产物必须注册与包名一致的加载器 id
const clientText = await readFile(join(root, 'lib/client.js'), 'utf8');
if (!clientText.includes('__ModuleLoader__.load')) fail('lib/client.js 没有注册 __ModuleLoader__ 工厂');
if (!clientText.includes(`id: '${packageName}'`) && !clientText.includes(`id: "${packageName}"`)) {
  fail(`lib/client.js 的加载器 id 必须等于包名 ${packageName}`);
}
if (!clientText.includes("require('react')") && !clientText.includes('require("react")')) {
  fail("lib/client.js 应当从 React 模块表取 React（require('react')）");
}

// 7. 语言资源
for (const locale of ['locale/zh.json', 'locale/en.json']) {
  const document = await readJson(locale);
  if (!document.meta?.title) fail(`${locale} 缺少 meta.title`);
  if (!document.meta?.description) fail(`${locale} 缺少 meta.description`);
}

// 8. 图标：必须真实存在于包内且体积合规
const iconStat = await stat(join(root, 'assets/icon.svg'));
if (iconStat.size > 256 * 1024) fail(`图标超过 256 KiB（${iconStat.size} 字节）`);
const iconText = await readFile(join(root, 'assets/icon.svg'), 'utf8');
if (!iconText.trimStart().startsWith('<svg')) fail('图标不是有效的 SVG');

// 9. patch 只激活自己
const patchText = await readFile(join(root, 'cordis.patch.yml'), 'utf8');
const insertNames = [...patchText.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
if (insertNames.length !== 1) fail(`cordis.patch.yml 应只插入 1 行，实际 ${insertNames.length} 行`);
for (const inserted of insertNames) {
  if (inserted !== packageName) fail(`cordis.patch.yml 插入的包名不是自己：${inserted}`);
}

// 10. files 白名单：装的是产物，不是源码
const files = manifest.files ?? [];
const mustShip = ['lib', 'cordis.patch.yml', 'locale/*.json', 'assets/icon.svg'];
for (const entry of mustShip) {
  if (!files.includes(entry) && !files.some((candidate) => candidate.startsWith(entry))) {
    fail(`files 白名单缺少：${entry}`);
  }
}
for (const stale of ['src', 'index.ts', 'index.js', 'client.ts', 'client.js', 'test']) {
  if (files.includes(stale)) {
    fail(`files 白名单不应包含源码 ${stale}：入口已指向 lib/，装源码只会造成两份副本`);
  }
}

// 11. 构建依赖必须是本地可用的开发依赖（装包的人不需要，开发的人必须有）
for (const tool of ['typescript', 'esbuild']) {
  if (!manifest.devDependencies?.[tool]) fail(`devDependencies 缺少构建工具：${tool}`);
}

// 11.5 出站命令（ADR-0012）：bin 要对得上文件、带 shebang，且依赖的产物在包里。
const binEntries = Object.entries(manifest.bin ?? {});
if (!binEntries.some(([name]) => name === 'dsh-wechat-send')) {
  fail("package.json 的 bin 缺少 dsh-wechat-send（ADR-0012 的出站命令）");
}
for (const [name, target] of binEntries) {
  const relativePath = target.replace(/^\.\//, '');
  if (!(await exists(relativePath))) {
    fail(`bin '${name}' 指向的文件不存在：${target}`);
    continue;
  }
  const text = await readFile(join(root, relativePath), 'utf8');
  if (!text.startsWith('#!')) fail(`bin '${name}' 缺少 shebang：${target}`);
  if (!text.includes('lib/src/host/cli.js')) {
    fail(`bin '${name}' 应当调用构建产物 lib/src/host/cli.js`);
  }
  if (!files.includes('bin') && !files.some((entry) => relativePath.startsWith(entry))) {
    fail(`files 白名单没有覆盖 bin 文件：${relativePath}`);
  }
}
if (!(await exists('lib/src/host/cli.js'))) {
  fail('缺少产物 lib/src/host/cli.js（先跑 npm run build）');
}

// 12. 真实打包清单：`files` 写错（glob 拼错、目录改名）只有 dry-run 能发现。
//     `--ignore-scripts` 避免 prepack 又把 lib/ 重建一遍。
//     环境里没有 npm CLI 才降级为跳过；跑了但失败/输出坏掉必须 fail，
//     否则「files 写错」这种 step 12 想抓的场景会被当成环境问题放过。
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  process.stdout.write('提示：环境里没有 npm CLI，跳过真实打包清单校验\n');
} else {
  const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const firstLine = String(result.stderr ?? '').split('\n').find((line) => line.trim() !== '') ?? '';
    fail(`npm pack --dry-run 失败：${firstLine || result.error?.message || '未知原因'}`);
  } else {
    let packed = null;
    try {
      packed = JSON.parse(result.stdout).pop() ?? null;
    } catch (error) {
      fail(`npm pack --dry-run 输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (packed) {
      const shipped = new Set(packed.files.map((file) => file.path));
      for (const must of [
        'lib/index.js',
        'lib/client.js',
        'bin/dsh-wechat-send.mjs',
        'cordis.patch.yml',
        'locale/zh.json',
        'locale/en.json',
        'assets/icon.svg',
      ]) {
        if (!shipped.has(must)) fail(`真实打包清单缺少：${must}`);
      }
      for (const path of shipped) {
        if (/^(src|test|scripts|docs\/local)\//.test(path) || /^tsconfig.*\.json$/.test(path)) {
          fail(`真实打包清单里混进了不该发布的文件：${path}`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(
    `打包校验失败（${failures.length} 项）：\n${failures.map((line) => `  - ${line}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('打包校验通过（产物可由源码确定性重建）\n');
