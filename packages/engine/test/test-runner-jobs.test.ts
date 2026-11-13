import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A copy of the runner next to a product-like directory `app/` holding the given test files. */
function fixture(files: Record<string, string>): { root: string; run: (args: string[]) => { code: number | null; output: string } } {
  const root = mkdtempSync(join(tmpdir(), 'runner-jobs-')); roots.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'app'));
  for (const file of ['test.ts', 'test-discovery.ts', 'test-partitions.ts']) copyFileSync(resolve(import.meta.dir, '../scripts', file), join(root, 'scripts', file));
  cpSync(resolve(import.meta.dir, '../toolchain/src/test-runner'), join(root, 'toolchain/src/test-runner'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, 'app', name, '..'), { recursive: true });
    writeFileSync(join(root, 'app', name), `import { test, expect } from 'bun:test'; test(${JSON.stringify(name)}, () => { ${body} });`);
  }
  const run = (args: string[]) => {
    const child = Bun.spawnSync({ cmd: [process.execPath, join(root, 'scripts/test.ts'), '--cwd', 'app', ...args], cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root }, timeout: 30_000, stdout: 'pipe', stderr: 'pipe' });
    return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
  };
  return { root, run };
}

test('--jobs runs each file in its own process, honours ignore patterns and reports failed files', () => {
  const { run } = fixture({
    'src/a.test.ts': "globalThis.leak = (globalThis.leak ?? 0) + 1; expect(globalThis.leak).toBe(1);",
    'src/b.test.ts': "globalThis.leak = (globalThis.leak ?? 0) + 1; expect(globalThis.leak).toBe(1);",
    'src/e2e/skipped.test.ts': "throw new Error('must be ignored');",
    'src/bad.test.ts': "expect(1).toBe(2);",
  });
  const result = run(['--jobs=2', '--path-ignore-patterns', 'src/e2e/**', 'src/']);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('Test files: 3, failed: 1');
  expect(result.output).toContain('FAIL src/bad.test.ts');
  expect(result.output).not.toContain('must be ignored');
  const ok = run(['--jobs=auto', './src/a.test.ts', './src/b.test.ts']);
  expect(ok.code, ok.output).toBe(0);
  expect(ok.output).toContain('Test files: 2, failed: 0');
});

test('space-separated flag values are not mistaken for test files, and an unmatched filter fails', () => {
  const { run } = fixture({ 'a.test.ts': 'expect(1).toBe(1);' });
  const spaced = run(['--timeout', '20000', '--jobs', '2', 'a.test']);
  expect(spaced.code, spaced.output).toBe(0);
  expect(spaced.output).toContain('Test files: 1, failed: 0');
  expect(run(['--jobs=2', 'nothing-matches']).code).not.toBe(0);
});
