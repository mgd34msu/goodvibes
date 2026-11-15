import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'version-consistency-check.ts');

const fixtures: string[] = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal fixture workspace: a root at 1.0.0 and one package per given version. */
function workspace(versions: Record<string, string>): { root: string; packagesJson: string } {
  const root = makeProjectTempDir('version-check');
  fixtures.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', version: '1.0.0' }));
  for (const [name, version] of Object.entries(versions)) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ name: `@scope/${name}`, version }));
  }
  return { root, packagesJson: JSON.stringify(Object.keys(versions).map((name) => `packages/${name}`)) };
}

function check(fixture: { root: string; packagesJson: string }) {
  return spawnSync('bun', [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_ROOT: fixture.root, WORKSPACE_PACKAGES_JSON: fixture.packagesJson },
  });
}

describe('version-consistency-check', () => {
  test('exits 0 when every package matches the root version', () => {
    const r = check(workspace({ a: '1.0.0', b: '1.0.0' }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('version-consistency-check PASSED');
  });

  test('exits 1 and names only the package whose version diverges', () => {
    const r = check(workspace({ a: '1.0.0', b: '0.9.0' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('@scope/b: 0.9.0 (expected 1.0.0)');
    expect(r.stderr).not.toContain('@scope/a:');
  });

  test('a package manifest without a version is reported as diverging, not skipped', () => {
    const fixture = workspace({ a: '1.0.0' });
    writeFileSync(join(fixture.root, 'packages', 'a', 'package.json'), JSON.stringify({ name: '@scope/a' }));
    const r = check(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('@scope/a: (missing) (expected 1.0.0)');
  });

  test('a listed package whose manifest does not exist fails the check', () => {
    const fixture = workspace({ a: '1.0.0' });
    const r = check({ ...fixture, packagesJson: JSON.stringify(['packages/a', 'packages/gone']) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('packages/gone');
  });
});
