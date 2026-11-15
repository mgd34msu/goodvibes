import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readFallbackVersion, VERSION_FALLBACKS, VERSIONED_WORKSPACES } from '../scripts/version-carriers.ts';

const SCRIPT = resolve(import.meta.dir, '../scripts/version-consistency-check.ts');

function writeFixture(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'version-carriers-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'goodvibes-jev', version }));
  for (const workspace of VERSIONED_WORKSPACES) {
    mkdirSync(join(root, workspace), { recursive: true });
    writeFileSync(join(root, workspace, 'package.json'), JSON.stringify({ name: `@goodvibes-jev/${workspace}`, version }));
  }
  for (const fallback of VERSION_FALLBACKS) {
    mkdirSync(dirname(join(root, fallback.path)), { recursive: true });
    writeFileSync(join(root, fallback.path), `let ${fallback.declaration} = '${version}';\nexport {};\n`);
  }
  return root;
}

function check(root: string): { status: number | null; stderr: string } {
  const result = Bun.spawnSync(['bun', SCRIPT], { env: { ...process.env, WORKSPACE_ROOT: root } });
  return { status: result.exitCode, stderr: result.stderr.toString() };
}

describe('version carriers', () => {
  test('passes when every manifest and compiled fallback is at the root version', () => {
    const root = writeFixture('1.2.3');
    try { expect(check(root).status).toBe(0); } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a stale workspace manifest fails the check and names it', () => {
    const root = writeFixture('1.2.3');
    try {
      writeFileSync(join(root, 'products/tui/package.json'), JSON.stringify({ name: '@goodvibes-jev/tui', version: '1.2.2' }));
      const result = check(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('@goodvibes-jev/tui');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a stale compiled fallback fails the check and names its file', () => {
    const root = writeFixture('1.2.3');
    try {
      writeFileSync(join(root, 'products/daemon/src/version.ts'), "let _version = '1.2.2';\n");
      const result = check(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('products/daemon/src/version.ts');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a fallback declared twice is not read as a version', () => {
    expect(readFallbackVersion("let _version = '1.0.0';\nlet _version = '1.0.1';\n", '_version')).toBeUndefined();
    expect(readFallbackVersion("let _version = '1.0.0';\n", '_version')).toBe('1.0.0');
  });
});
