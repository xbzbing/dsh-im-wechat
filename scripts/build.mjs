#!/usr/bin/env node
/**
 * 构建 `lib/`：把 TypeScript 源码编译成可安装产物。
 *
 * 两半的产物形态不同，处理方式也不同：
 *
 * - **host 半**（`index.ts` 与 `src/host`、`src/shared`）：`tsc` 按模块逐个编译到
 *   `lib/`，保持 `src/` 的目录形状，相对导入由 `rewriteRelativeImportExtensions`
 *   从 `./x.ts` 改写成 `./x.js`。不打包——一个模块一个文件，堆栈里能直接看出是
 *   谁抛的，改一行也不用重新打包整棵树。
 * - **client 半**（`src/client`）：浏览器只接受一个「无 import 的脚本」，它由
 *   `window.__ModuleLoader__.load({id, factory})` 包裹、平台模块从工厂的 `require`
 *   取。所以这一半用 esbuild 打成单文件 `lib/client.js`，平台 seed 表里的包保持
 *   external（`react`、`@deepseek-ai/*`）。
 *
 * 产物布局（与 `dsh-im` 约定一致）：
 *
 *   lib/index.js        ← index.ts
 *   lib/client.js       ← src/client/index.ts（打包）
 *   lib/src/**\/*.js     ← src/**\/*.ts
 *
 * 因此 `exports["."]` 指向 `lib/index.js`、`exports["./client"]` 指向 `lib/client.js`，
 * 而 `lib/index.js` 内部的 `./src/host/index.ts` 已改写成 `./src/host/index.js`，一致。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 包名：client 半的模块加载器 id 必须等于它。 */
const PACKAGE_NAME = 'dsh-im-wechat';

/**
 * 平台 seed 模块：由 web 页面在模块加载器里注入，必须保持 external，
 * 否则会把宿主自己的 React 再打一份进来，Symbol 与 context 全部对不上。
 */
const PLATFORM_MODULES = ['react', 'react-dom', 'react-dom/client', '@deepseek-ai/*'];

/** client 半的入口。 */
const CLIENT_ENTRY = join(root, 'src/client/index.ts');

/** 递归列出目录下的文件（绝对路径）；`verify-package.mjs` 也用它比对产物。 */
export async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/** 累加文件字节数，用于构建摘要。 */
async function totalBytes(files) {
  let sum = 0;
  for (const file of files) {
    sum += (await stat(file)).size;
  }
  return sum;
}

const toPosix = (target) => relative(root, target).split(sep).join('/');

/**
 * 源码目录只允许 TypeScript。夹带 `.js`/`.mjs`/编辑器临时文件时直接失败：
 * 它们不会被 tsc 编译，却会被安装进 `lib/`，在运行期表现成「改了没反应」。
 */
async function assertTypeScriptOnly(dir) {
  if (!existsSync(dir)) return;
  for (const file of await listFiles(dir)) {
    if (!file.endsWith('.ts')) {
      throw new Error(`src/ 下只允许 .ts 文件，发现 ${toPosix(file)}`);
    }
  }
}

/** 编译器入口：优先用仓库里的 `typescript`，缺失时给出明确提示。 */
function tscBinary() {
  const local = join(root, 'node_modules/typescript/bin/tsc');
  if (!existsSync(local)) {
    throw new Error('找不到 typescript，请先执行 npm install');
  }
  return local;
}

/** host 半：`tsc` 逐模块编译到 outDir。 */
function emitHost(outDir) {
  const result = spawnSync(
    process.execPath,
    [tscBinary(), '-p', join(root, 'tsconfig.build.json'), '--outDir', outDir, '--pretty', 'false'],
    { cwd: root, stdio: 'inherit', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`tsc 编译失败（退出码 ${result.status ?? '未知'}）`);
  }
}

/** client 半：esbuild 打成一个 ModuleLoader 工厂脚本。 */
async function bundleClient(outDir) {
  await esbuild.build({
    entryPoints: [CLIENT_ENTRY],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: PLATFORM_MODULES,
    minify: false,
    sourcemap: false,
    outfile: join(outDir, 'client.js'),
    logLevel: 'warning',
    // banner 在 ESM 入口里故意声明 `module`/`exports`，这两条告警是预期的；
    // 动态 `require(name)` 是平台原语的可选降级路径，同样预期。
    logOverride: { 'commonjs-variable-in-esm': 'silent', 'require-resolve-not-external': 'silent' },
    banner: {
      js:
        `window.__ModuleLoader__.load({ id: "${PACKAGE_NAME}", factory: (require) => {\n` +
        'var module = { exports: {} }; var exports = module.exports;',
    },
    footer: {
      js: 'return module.exports;\n} });',
    },
  });
}

/**
 * 构建一次。
 *
 * `outDir` 可指向任意目录：`verify-package.mjs` 用它把产物重建到临时目录，
 * 再和 `lib/` 逐字节比对，确认「源码改了但忘了 build」不会溜过去。
 */
export async function build({ outDir = join(root, 'lib') } = {}) {
  await assertTypeScriptOnly(join(root, 'src'));

  // 1. 清空并重建产物目录：不做增量，避免已删除的源文件残留在 lib/ 里。
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  // 2. host 半：tsc 逐模块编译；client 半：esbuild 打包。
  emitHost(outDir);
  await bundleClient(outDir);

  // 3. 自检：两个入口必须在，否则装上去就是插件不激活。
  for (const entry of ['index.js', 'client.js']) {
    const target = join(outDir, entry);
    if (!existsSync(target)) {
      throw new Error(`产物缺少入口：${toPosix(target)}`);
    }
    const text = await readFile(target, 'utf8');
    if (text.trim().length === 0) {
      throw new Error(`产物入口是空文件：${toPosix(target)}`);
    }
  }

  const files = await listFiles(outDir);
  // 按产物内的相对路径统计：outDir 也可能是 verify 用的临时目录，绝对路径不可比。
  const relativeFiles = files.map((file) => relative(outDir, file).split(sep).join('/'));
  return {
    outDir,
    files,
    // 只数 `src/` 下经 tsc 编译的模块。根入口 `lib/index.js` 同属 tsc 产出，但在
    // 摘要里单独点名；混进这个数会让「host 半 N 个模块」比事实多 1。
    hostModules: relativeFiles.filter((name) => name.startsWith('src/') && name.endsWith('.js')).length,
    bytes: await totalBytes(files),
  };
}

/** 命令行入口。 */
async function main() {
  const result = await build();
  const kib = (result.bytes / 1024).toFixed(1);
  process.stdout.write(
    `构建完成：${result.files.length} 个文件，${kib} KiB → ${toPosix(result.outDir)}/\n` +
      `  入口：lib/index.js（host）、lib/client.js（web 面板）\n` +
      `  host 半：src/ 下 ${result.hostModules} 个模块经 tsc 编译（另有入口 lib/index.js）\n` +
      '  client 半：src/client 经 esbuild 打包\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`构建失败：${error.message}\n`);
    process.exit(1);
  });
}
