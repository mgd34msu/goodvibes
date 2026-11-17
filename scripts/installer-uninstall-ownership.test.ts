import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let root: string, install: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installer-preserved-uninstall-')); install = join(root, 'install'); mkdirSync(install);
  for (const name of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) writeFileSync(join(install, name), 'Original product program');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(serviceHook = ':', setup = '', rcHook = ':') {
  return spawnSync('sh', ['-c', `set -eu
    . "$FIXTURE_INSTALLER"
    os_tag=linux; arch_tag=x64; VEC_OS=linux; VEC_SUFFIX=so; PLATFORM_SUFFIX=linux-x64
    uninstall_services_and_processes() { ${serviceHook}; }
    uninstall_shell_rc_path_line() { ${rcHook}; }
    ${setup}
    run_uninstall
  `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: root, GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_INSTALL_DIR: install,
    FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), FIXTURE_ROOT: root,
  } });
}

test('program removal retains custom browser, WebUI, rollback and failed publication trees and user memory', () => {
  for (const directory of ['playwright-core', 'playwright-core.previous', 'playwright-core.incoming', 'webui/3.1.2', 'webui/custom', '.goodvibes-directory-install.owner']) {
    mkdirSync(join(install, directory), { recursive: true }); writeFileSync(join(install, directory, 'owner.txt'), 'Keep these original custom bytes');
  }
  // Incoming program files are transaction evidence; this is a directory
  // support tree, which is preserved rather than interpreted as program work.
  mkdirSync(join(root, '.goodvibes')); writeFileSync(join(root, '.goodvibes', 'owner-memory'), 'Retained user memory');
  const result = run(); expect(result.status, result.stderr).toBe(0);
  for (const name of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) expect(existsSync(join(install, name))).toBe(false);
  for (const directory of ['playwright-core', 'playwright-core.previous', 'playwright-core.incoming', 'webui/3.1.2', 'webui/custom', '.goodvibes-directory-install.owner']) {
    expect(readFileSync(join(install, directory, 'owner.txt'), 'utf8')).toBe('Keep these original custom bytes');
  }
  expect(readFileSync(join(root, '.goodvibes', 'owner-memory'), 'utf8')).toBe('Retained user memory');
  expect(readdirSync(install).some(name => name.endsWith('.update-transaction'))).toBe(false);
});
