/** Real package/path classifier regressions, authored and UNRUN during coding first. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
let root: string, home: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'installer-shadow-owner-')); home = join(root, 'home'); mkdirSync(home); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function candidate(owner: string | null, command: string, banner = `${command} 2.0.25`) {
  const target = owner === null ? join(home, 'standalone', command) : join(home, 'global', 'node_modules', owner, 'bin', command);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `#!/bin/sh\nprintf probed > "$FIXTURE_PROBED"\nprintf '%s\\n' '${banner}'\n`, { mode: 0o755 });
  const path = join(home, 'earlier', command); mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); return { path, target };
}
function plan(path: string, command: string) {
  return spawnSync('sh', ['-c', 'set -eu; . "$FIXTURE_INSTALLER"; shadow_removal_plan "$FIXTURE_CANDIDATE" "$FIXTURE_COMMAND"'], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home, GOODVIBES_INSTALL_SH_LIB: '1',
      FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), FIXTURE_CANDIDATE: path, FIXTURE_COMMAND: command, FIXTURE_PROBED: join(root, 'probed'),
    },
  });
}
for (const [owner, command] of [['@pellux/goodvibes-tui', 'goodvibes'], ['@pellux/goodvibes-daemon', 'goodvibes-daemon'], ['@pellux/goodvibes-agent', 'goodvibes-agent']] as const) {
  test(`the exact existing ${owner} product is recognized only after its command version matches`, () => {
    const copy = candidate(owner, command), result = plan(copy.path, command); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`package\t${owner}`); expect(existsSync(join(root, 'probed'))).toBe(true);
  });
}
for (const owner of ['@pellux/goodvibes-custom-tool', '@pellux/goodvibes-tui-helper', '@other/goodvibes-tui', '@goodvibes-jev/tui', '@goodvibes-jev/agent', '@goodvibes-jev/daemon', '@goodvibes-jev/engine']) {
  test(`unknown or private package ${owner} is never removed by prefix/banner or standalone fallback`, () => {
    const copy = candidate(owner, 'goodvibes'), result = plan(copy.path, 'goodvibes'); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(''); expect(existsSync(join(root, 'probed'))).toBe(false);
  });
}

test('a known package whose command does not identify this product has no removal plan', () => {
  const copy = candidate('@pellux/goodvibes-tui', 'goodvibes', 'SomeOtherProduct 2.0.25'), result = plan(copy.path, 'goodvibes');
  expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe(''); expect(existsSync(join(root, 'probed'))).toBe(true);
});

test('the innermost foreign dependency remains foreign despite a recognized outer package', () => {
  const copy = candidate('@pellux/goodvibes-tui/node_modules/foreign-tool', 'goodvibes'), result = plan(copy.path, 'goodvibes');
  expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe(''); expect(existsSync(join(root, 'probed'))).toBe(false);
});

test('the standalone fallback still recognizes a real product version outside node_modules', () => {
  const copy = candidate(null, 'goodvibes'), result = plan(copy.path, 'goodvibes'); expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(`file\t${copy.path}`);
});
