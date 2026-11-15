import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { staleDistNote } from '../scripts/dist-freshness.ts';
import { checkFilters, runBunTest } from '../scripts/test.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const FILES = ['test/a.test.ts', 'test/b.test.ts', 'src/test/c.test.ts'];

describe('explicit test filters', () => {
  test('a renamed file in an explicit list is an error that names it, though other entries still match', () => {
    expect(() => checkFilters('/x', FILES, ['./test/a.test.ts', './test/renamed.test.ts'])).toThrow('./test/renamed.test.ts');
    expect(() => checkFilters('/x', FILES, ['test/a.test.ts', 'test/gone.test.ts'])).toThrow('test/gone.test.ts');
  });

  test('a ./ directory filter selects the tests under it and is not reported missing', () => {
    expect(checkFilters('/x', FILES, ['./test', './src/test/'])).toEqual([]);
    expect(() => checkFilters('/x', FILES, ['./tes'])).toThrow('./tes');
  });

  test('a substring that matches nothing is reported, not fatal', () => {
    expect(checkFilters('/x', FILES, ['./test/a.test.ts', 'nothing-here/'])).toEqual(['nothing-here/']);
  });

  test('the runner refuses a missing file before running anything', async () => {
    await expect(runBunTest({ args: ['./test/does-not-exist.test.ts', './test/test-isolation.test.ts'] })).rejects.toThrow('does-not-exist');
  });
});

describe('stale compiled output note', () => {
  function tree(): { src: string; dist: string } {
    const root = mkdtempSync(join(tmpdir(), 'dist-fresh-')); roots.push(root);
    const src = join(root, 'src'); const dist = join(root, 'dist');
    mkdirSync(src); mkdirSync(dist);
    writeFileSync(join(src, 'a.ts'), ''); writeFileSync(join(dist, 'a.js'), '');
    return { src, dist };
  }
  const at = (path: string, seconds: number): void => utimesSync(path, seconds, seconds);

  test('names the build command when the source is newer than the output', () => {
    const { src, dist } = tree();
    at(join(dist, 'a.js'), 1_000); at(join(src, 'a.ts'), 2_000);
    expect(staleDistNote(src, dist, 'bun run build')).toContain('bun run build');
  });

  test('says nothing when the output is newer, and names the build when it is missing', () => {
    const { src, dist } = tree();
    at(join(src, 'a.ts'), 1_000); at(join(dist, 'a.js'), 2_000);
    expect(staleDistNote(src, dist, 'bun run build')).toBeUndefined();
    expect(staleDistNote(src, join(dist, 'missing'), 'bun run build')).toContain('not built');
  });
});
