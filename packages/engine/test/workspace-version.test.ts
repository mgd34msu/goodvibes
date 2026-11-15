import { expect, spyOn, test } from 'bun:test';
import { isPinnedWorkspaceVersion } from '../toolchain/src/lib/workspace-version.ts';
import { syncVersionSurfaces as syncAgentVersionSurfaces } from '../../../products/agent/scripts/project-surfaces.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('build versions accept pinned development versions while rejecting ranges, invalid identifiers and leading zeros', () => {
  for (const version of ['3.0.0', '3.0.0-dev.0', '3.0.0-rc.1+build.7']) expect(isPinnedWorkspaceVersion(version)).toBe(true);
  for (const version of ['latest', '^3.0.0', 'v3.0.0', '03.0.0', '3.0.0-dev.01', '3.0.0-', '3.0', ' 3.0.0']) expect(isPinnedWorkspaceVersion(version)).toBe(false);
});
const PRODUCTS = [
  ['Agent', syncAgentVersionSurfaces],
] as const;

function withProductRoot(packageVersion: string, setup: (root: string) => void, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'workspace-version-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: packageVersion }));
    setup(root);
    run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const [name, syncVersionSurfaces] of PRODUCTS) {
  test(`${name} prebuild stamps the unified development version without changing stable release policy`, () => {
    withProductRoot('3.0.0-dev.0', (root) => writeFileSync(join(root, 'src/version.ts'), "let _version = '2.0.0';\n"), (root) => {
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(syncVersionSurfaces(root)).toBe('3.0.0-dev.0');
      } finally { log.mockRestore(); }
      expect(readFileSync(join(root, 'src/version.ts'), 'utf8')).toContain("let _version = '3.0.0-dev.0'");
    });
  });
  test(`${name} prebuild refuses a version.ts without the _version literal instead of shipping a stale fallback`, () => {
    withProductRoot('3.0.0', (root) => writeFileSync(join(root, 'src/version.ts'), "export const version = '2.0.0';\n"), (root) => {
      expect(() => syncVersionSurfaces(root)).toThrow('_version fallback literal');
      expect(readFileSync(join(root, 'src/version.ts'), 'utf8')).toBe("export const version = '2.0.0';\n");
    });
  });
  test(`${name} prebuild refuses a package.json version that is not pinned`, () => {
    withProductRoot('^3.0.0', (root) => writeFileSync(join(root, 'src/version.ts'), "let _version = '2.0.0';\n"), (root) => {
      expect(() => syncVersionSurfaces(root)).toThrow('pinned semantic version');
      expect(readFileSync(join(root, 'src/version.ts'), 'utf8')).toBe("let _version = '2.0.0';\n");
    });
  });
  test(`${name} prebuild fails, rather than reporting "not found", when version.ts cannot be read`, () => {
    withProductRoot('3.0.0', (root) => mkdirSync(join(root, 'src/version.ts')), (root) => {
      const log = spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(() => syncVersionSurfaces(root)).toThrow();
        expect(log.mock.calls.flat().join('\n')).not.toContain('not found');
      } finally { log.mockRestore(); }
    });
  });
}
