// Proves: The released installer, working in a directory it may share with other things, removes nothing beside its own version directory, and a failed directory swap leaves the old tree in force.
// Red when: A failed swap leaves the browser-driver directory missing or mixed, or an update removes another version's bundle, an owner-made directory, or something outside the install directory through a link.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let root: string, install: string, work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installer-owned-directories-')); install = join(root, 'install'); work = join(root, 'work');
  mkdirSync(install); mkdirSync(join(work, 'browser-driver-staging', 'playwright-core'), { recursive: true });
  for (const name of ['package.json', 'index.js', 'cli.js']) writeFileSync(join(work, 'browser-driver-staging', 'playwright-core', name), 'New released driver');
  mkdirSync(join(work, 'webui-staging', 'goodvibes-webui'), { recursive: true });
  writeFileSync(join(work, 'webui-staging', 'goodvibes-webui', 'index.html'), 'New released WebUI');
  writeFileSync(join(install, 'goodvibes-daemon'), '#!/bin/sh\nprintf "http://127.0.0.1:3421\\n"\n', { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(kind: 'driver' | 'webui', injection = '', afterInstall = '') {
  return spawnSync('sh', ['-c', `set -eu
    . "$FIXTURE_INSTALLER"
    VERSION=v3.1.2; WORKDIR=$FIXTURE_WORK
    os_tag=linux; arch_tag=x64; VEC_OS=linux; VEC_SUFFIX=so; PLATFORM_SUFFIX=linux-x64
    claim_release_install
    INSTALL_SWAP_BEGUN=1
    INSTALL_JOURNAL=$FIXTURE_WORK/swap-journal; : > "$INSTALL_JOURNAL"
    ${injection}
    ${kind === 'driver' ? 'install_browser_driver' : 'install_webui'}
    ${afterInstall}
    INSTALL_SWAP_FINISHED=1; commit_install_journal
    release_install_claims
  `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: root,
    GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_INSTALL_DIR: install,
    FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), FIXTURE_WORK: work,
  } });
}
function oldDriver() {
  const target = join(install, 'playwright-core'); mkdirSync(target); writeFileSync(join(target, 'owner.txt'), 'Original owner driver content'); return target;
}

test('a failed incoming rename restores the exact parked original without deleting staging', () => {
  const target = oldDriver();
  const result = run('driver', `mv() { case "$1" in */incoming) return 71 ;; esac; command mv "$@"; }`);
  expect(result.status).not.toBe(0); expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  expect(existsSync(join(target, 'index.js'))).toBe(false); expect(existsSync(target + '.directory-update.lock')).toBe(false);
  expect(readdirSync(install).some(name => name.startsWith('.goodvibes-directory-install.'))).toBe(true);
});

test('WebUI installation keeps other versions, owner-created directories and aliases', () => {
  const webui = join(install, 'webui'); mkdirSync(join(webui, '3.0.0'), { recursive: true }); mkdirSync(join(webui, 'custom'));
  writeFileSync(join(webui, '3.0.0', 'index.html'), 'A still-served previous bundle'); writeFileSync(join(webui, 'custom', 'owner.txt'), 'Owner custom deployment');
  const outside = join(root, 'outside-webui'); mkdirSync(outside); writeFileSync(join(outside, 'outside.txt'), 'Foreign target'); symlinkSync(outside, join(webui, 'custom-link'));
  const result = run('webui'); expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(webui, 'current', 'index.html'), 'utf8')).toBe('New released WebUI');
  expect(readFileSync(join(webui, '3.0.0', 'index.html'), 'utf8')).toBe('A still-served previous bundle');
  expect(readFileSync(join(webui, 'custom', 'owner.txt'), 'utf8')).toBe('Owner custom deployment'); expect(lstatSync(join(webui, 'custom-link')).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, 'outside.txt'), 'utf8')).toBe('Foreign target');
});
