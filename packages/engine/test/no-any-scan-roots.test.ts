import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'no-any-types.ts');

function run(directory: string, source: string): { status: number | null; output: string } {
  const root = mkdtempSync(join(tmpdir(), 'gv-any-'));
  try {
    mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, directory, 'sample.ts'), source, 'utf8');
    const result = Bun.spawnSync(['bun', SCRIPT], { env: { ...process.env, ANY_CHECK_ROOT: root }, stdout: 'pipe', stderr: 'pipe' });
    return { status: result.exitCode, output: `${result.stdout.toString()}${result.stderr.toString()}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('an `any` in a directory the gate never listed by name is still found', () => {
  const result = run('brand-new-package', 'export const value: any = 1;\n');
  expect(result.status).toBe(1);
  expect(result.output).toContain('brand-new-package/sample.ts');
});

test('a clean directory passes', () => {
  expect(run('brand-new-package', 'export const value: unknown = 1;\n').status).toBe(0);
});

test('build output directories are not scanned', () => {
  expect(run('dist', 'export const value: any = 1;\n').status).toBe(0);
});
