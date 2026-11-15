import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseBunCompileArgs } from '@goodvibes-jev/engine/toolchain';

test('shared compilation preserves every Agent/TUI target, including Windows beta', () => {
  for (const target of ['bun-linux-x64', 'bun-linux-arm64', 'bun-darwin-x64', 'bun-darwin-arm64', 'bun-windows-x64'] as const) {
    expect(parseBunCompileArgs(['entry.ts', '--compile', `--target=${target}`, '--outfile', 'dist/artifact']).target).toBe(target);
  }
});

// Node loads the published `toolchain` entry from built output, which this test
// cannot rely on existing; what it can pin from source is the cause of a Node
// load failure: a `bun:` module specifier anywhere in the entry's import graph.
test('nothing reachable from the public toolchain entry imports a bun: module', () => {
  const root = join(import.meta.dir, '..', '..', 'toolchain', 'src');
  const seen = new Set<string>();
  const offenders: string[] = [];
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      if (specifier.startsWith('bun:')) offenders.push(`${file}: ${specifier}`);
      else if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
        if (existsSync(target)) visit(target);
      }
    }
  };
  visit(join(root, 'index.ts'));
  expect(seen.size).toBeGreaterThan(5);
  expect(offenders).toEqual([]);
});
