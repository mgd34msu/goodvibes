import { expect, test } from 'bun:test';
import { isPinnedWorkspaceVersion } from '../toolchain/src/lib/workspace-version.ts';
import { syncVersionSurfaces } from '../../../products/agent/scripts/project-surfaces.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('build versions accept pinned development versions while rejecting ranges, invalid identifiers and leading zeros', () => {
  for (const version of ['3.0.0', '3.0.0-dev.0', '3.0.0-rc.1+build.7']) expect(isPinnedWorkspaceVersion(version)).toBe(true);
  for (const version of ['latest', '^3.0.0', 'v3.0.0', '03.0.0', '3.0.0-dev.01', '3.0.0-', '3.0', ' 3.0.0']) expect(isPinnedWorkspaceVersion(version)).toBe(false);
});
test('Agent prebuild stamps the unified development version without changing stable release policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-version-'));
  try {
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/version.ts'), "let _version = '2.0.0';\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '3.0.0-dev.0' }));
    expect(syncVersionSurfaces(root)).toBe('3.0.0-dev.0');
    expect(readFileSync(join(root, 'src/version.ts'), 'utf8')).toContain('3.0.0-dev.0');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
