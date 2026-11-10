import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAX_SOURCE_LINES } from '../../src/shared/limits.ts';

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url));

/** 递归收集 `src/` 下的 .ts 源文件（构建产物在 lib/，不在此规则内）。 */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

/** 与 `wc -l` 同口径：按换行计数，文件末尾换行不额外算一行。 */
function countLines(text: string): number {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length;
}

test('src 下每个源文件不超过约定的行数上限（AGENTS.md 文件规模规则）', async () => {
  const over: string[] = [];
  for (const file of await sourceFiles(SRC_DIR)) {
    const lines = countLines(await readFile(file, 'utf8'));
    if (lines > MAX_SOURCE_LINES) over.push(`${file.slice(SRC_DIR.length + 1)}: ${lines} 行`);
  }
  assert.deepEqual(over, [], `以下文件超过 ${MAX_SOURCE_LINES} 行，先拆分再加功能：\n${over.join('\n')}`);
});
