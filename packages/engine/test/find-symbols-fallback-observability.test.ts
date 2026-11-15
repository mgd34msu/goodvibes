import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeSymbolsQuery } from '../platform/src/platform/tools/find/symbols.ts';
import {
  extractOutline,
  extractSymbols,
} from '../platform/src/platform/tools/read/text.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = join(tmpdir(), `gv-find-symbols-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

describe('symbol fallback observability', () => {
  test('find symbols reports regex fallback source when tree-sitter cannot provide symbols', async () => {
    const root = tempDir();
    writeFileSync(join(root, 'sample.txt'), 'function visible() {}\n', 'utf-8');

    const result = await executeSymbolsQuery(
      { id: 'symbols', mode: 'symbols', path: root },
      {},
      root,
    );

    expect(result.source).toBe('regex_fallback');
    expect(result.count).toBe(1);
  });

  test('read outline and symbols include fallback notes when parser support is unavailable', async () => {
    const content = 'function visible() {}\n';
    const lines = content.split('\n');

    const outline = await extractOutline('sample.txt', content, lines, false);
    const symbols = await extractSymbols('sample.txt', content, lines, false);

    expect(outline).toMatch(/Falling back to regex/);
    expect(symbols).toMatch(/Falling back to regex/);
  });
});
