// Proves: When the installer offers to remove an older copy that shadows the new command (and removes it unasked with GOODVIBES_SHADOW_REMOVE=1), it never plans to remove a package or file that is not this product.
// Red when: A command that belongs to another npm package gets a removal plan, by name prefix, by its version banner, or as a standalone file.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
let root: string, home: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'installer-shadow-owner-')); home = join(root, 'home'); mkdirSync(home); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function candidate(owner: string | null, command: string, banner = `${command} 2.0.25`) {
  const target = owner === null ? join(home, 'standalone', command) : join(home, 'global', 'lib', 'node_modules', owner, 'bin', command);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `#!/bin/sh\nprintf probed > "$FIXTURE_PROBED"\nprintf '%s\\n' '${banner}'\n`, { mode: 0o755 });
  const path = join(home, 'earlier', command); mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path); return { path, target };
}
function plan(path: string, command: string, globalPrefix = join(home, 'global')) {
  return spawnSync('sh', ['-c', 'set -eu; . "$FIXTURE_INSTALLER"; shadow_manager_output() { case "$*" in "npm root --global") printf \'%s/lib/node_modules\\n\' "$FIXTURE_GLOBAL_PREFIX" ;; "npm prefix --global") printf \'%s\\n\' "$FIXTURE_GLOBAL_PREFIX" ;; bun*) return 1 ;; *) "$@" ;; esac; }; shadow_removal_plan "$FIXTURE_CANDIDATE" "$FIXTURE_COMMAND"'], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: home, GOODVIBES_INSTALL_SH_LIB: '1',
      FIXTURE_GLOBAL_PREFIX: globalPrefix, FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), FIXTURE_CANDIDATE: path, FIXTURE_COMMAND: command, FIXTURE_PROBED: join(root, 'probed'),
    },
  });
}
for (const owner of ['@pellux/goodvibes-custom-tool', '@pellux/goodvibes-tui-helper', '@other/goodvibes-tui', '@goodvibes/tui', '@goodvibes/agent', '@goodvibes/daemon', '@goodvibes/engine']) {
  test(`unknown or private package ${owner} is never removed by prefix/banner or standalone fallback`, () => {
    const copy = candidate(owner, 'goodvibes'), result = plan(copy.path, 'goodvibes'); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(''); expect(existsSync(join(root, 'probed'))).toBe(false);
  });
}
