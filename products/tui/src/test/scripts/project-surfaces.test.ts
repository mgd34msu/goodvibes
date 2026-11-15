import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { syncVersionSurfaces } from '../../../scripts/project-surfaces.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(manifest: Record<string, unknown>, versionTs = "let _version = '0.0.1'\n"): string {
  const root = makeProjectTempDir('gv-project-surfaces'); roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'version.ts'), versionTs);
  return root;
}

test('a package.json without a version is refused instead of baking the string "undefined"', () => {
  const root = fixture({ name: 'x' });
  expect(() => syncVersionSurfaces(root)).toThrow('pinned semantic version');
  expect(readFileSync(join(root, 'src', 'version.ts'), 'utf8')).toBe("let _version = '0.0.1'\n");
});

test('a version.ts without the fallback literal fails loudly', () => {
  const root = fixture({ version: '1.2.3' }, 'export const VERSION = "x"\n');
  expect(() => syncVersionSurfaces(root)).toThrow('_version fallback');
});

test('a read-only version.ts is a failure, not a skipped step', () => {
  const root = fixture({ version: '1.2.3' });
  chmodSync(join(root, 'src', 'version.ts'), 0o444);
  if (process.getuid?.() === 0) return;
  expect(() => syncVersionSurfaces(root)).toThrow();
});

test('a pinned version is written into the fallback', () => {
  const root = fixture({ version: '1.2.3' });
  expect(syncVersionSurfaces(root)).toBe('1.2.3');
  expect(readFileSync(join(root, 'src', 'version.ts'), 'utf8')).toContain("let _version = '1.2.3'");
});
