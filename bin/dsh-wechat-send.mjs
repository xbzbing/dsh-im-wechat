#!/usr/bin/env node
/**
 * `dsh-wechat-send` 的入口（ADR-0012）。
 *
 * 真正的逻辑在 `src/host/cli.ts`，由构建产到 `lib/src/host/cli.js`。这里只负责
 * 在产物缺失时给一句能看懂的话，而不是抛 ERR_MODULE_NOT_FOUND 栈。
 */

import process from 'node:process';

try {
  const { runCli } = await import('../lib/src/host/cli.js');
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  if (error && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND') {
    process.stderr.write('dsh-wechat-send：找不到 lib/，先在这个包里执行 npm run build\n');
    process.exitCode = 1;
  } else {
    throw error;
  }
}
