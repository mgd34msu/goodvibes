import { afterEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_PACKAGES } from '../../../scripts/platform-packages.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** The script runs from a copy against a stub `npm`; nothing real is packed or published. */
function run(npmExit: number) {
  const root = mkdtempSync(join(tmpdir(), 'tui-platform-publish-')); roots.push(root);
  mkdirSync(join(root, 'scripts'));
  for (const file of ['publish-platform-packages.ts', 'platform-packages.ts']) copyFileSync(new URL(`../../../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'main', version: '1.2.3' }));
  const manifests = new Map<string, string>();
  for (const pkg of PLATFORM_PACKAGES) {
    mkdirSync(join(root, 'platform-packages', pkg.dir, 'bin'), { recursive: true });
    writeFileSync(join(root, 'platform-packages', pkg.dir, 'bin', pkg.appArtifact), 'binary');
    const text = `${JSON.stringify({ name: pkg.name, version: '1.2.3' }, null, 2)}\n`;
    writeFileSync(join(root, 'platform-packages', pkg.dir, 'package.json'), text);
    manifests.set(pkg.dir, text);
  }
  const bin = join(root, 'stub-bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexit ${npmExit}\n`); chmodSync(join(bin, 'npm'), 0o755);
  const result = Bun.spawnSync([process.execPath, join(root, 'scripts', 'publish-platform-packages.ts'), '--dry-run'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GOODVIBES_PUBLIC_PACKAGE_SCOPE: '@mirror' },
  });
  const current = (dir: string) => readFileSync(join(root, 'platform-packages', dir, 'package.json'), 'utf8');
  return { result, manifests, current };
}

test.each([0, 1])('a mirror-scope run leaves every checked-in platform manifest unchanged (npm exit %i)', npmExit => {
  const { result, manifests, current } = run(npmExit);
  expect(result.exitCode).toBe(npmExit === 0 ? 0 : 1);
  for (const [dir, original] of manifests) expect(current(dir)).toBe(original);
});
