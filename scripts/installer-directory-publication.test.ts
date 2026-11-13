/** Actual installer function/claim regressions; intentionally UNRUN in coding-first work. */
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
function outgoingFile(parent: string, name: string): string | undefined {
  return readdirSync(parent).filter(name => name.startsWith('.goodvibes-directory-install.')).map(directory => join(parent, directory, 'outgoing', name)).find(existsSync);
}

test('driver publication preserves the original installed tree and an unrelated previous directory', () => {
  const target = oldDriver(), previous = target + '.previous'; mkdirSync(previous); writeFileSync(join(previous, 'custom.txt'), 'Previously retained custom bytes');
  const result = run('driver'); expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('New released driver');
  const retained = outgoingFile(install, 'owner.txt'); expect(retained).toBeDefined(); expect(readFileSync(retained!, 'utf8')).toBe('Original owner driver content');
  expect(readFileSync(join(previous, 'custom.txt'), 'utf8')).toBe('Previously retained custom bytes');
  expect(existsSync(target + '.directory-update.lock')).toBe(false);
  expect(result.stdout).toContain('retained');
});

test('a superseded previous driver tree is removed only at the commit step, after the whole swap finished', () => {
  const target = oldDriver(); writeFileSync(join(target, '.goodvibes-release.json'), '{"schema":1,"version":"3.0.0"}\n');
  // The swap fails after the driver was published: nothing may have been deleted.
  const failed = run('driver', '', 'rollback_install_swap; exit 9'); expect(failed.status).toBe(9);
  expect(readdirSync(install).some(name => name.startsWith('.goodvibes-directory-install.'))).toBe(true);
  expect(outgoingFile(install, 'owner.txt')).toBeDefined();
});

test('a superseded previous driver tree is removed after a successful update, leaving no staging directory', () => {
  const target = oldDriver(); writeFileSync(join(target, '.goodvibes-release.json'), '{"schema":1,"version":"3.0.0"}\n');
  const result = run('driver'); expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(target, 'index.js'), 'utf8')).toBe('New released driver');
  expect(readdirSync(install).filter(name => name.startsWith('.goodvibes-directory-install.'))).toEqual([]);
  expect(existsSync(target + '.directory-update.lock')).toBe(false);
});

test('the same release reinstalled keeps the previous driver tree', () => {
  const target = oldDriver(); writeFileSync(join(target, '.goodvibes-release.json'), '{"schema":1,"version":"3.1.2"}\n');
  const result = run('driver'); expect(result.status, result.stderr).toBe(0);
  expect(outgoingFile(install, 'owner.txt')).toBeDefined();
});

test('a WebUI tree is never deleted by an update, even one carrying another release marker', () => {
  const webui = join(install, 'webui'), old = join(webui, '3.1.2'); mkdirSync(old, { recursive: true });
  writeFileSync(join(old, 'owner.txt'), 'Original configured bundle'); writeFileSync(join(old, '.goodvibes-release.json'), '{"schema":1,"version":"3.0.0"}\n');
  const result = run('webui'); expect(result.status, result.stderr).toBe(0);
  expect(outgoingFile(webui, 'owner.txt')).toBeDefined();
});

test('a failed update still retains the parked previous tree, even one carrying a release marker', () => {
  const target = oldDriver(); writeFileSync(join(target, '.goodvibes-release.json'), '{"schema":1,"version":"3.0.0"}\n');
  const result = run('driver', `mv() { case "$1" in */incoming) return 71 ;; esac; command mv "$@"; }`);
  expect(result.status).not.toBe(0);
  expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  expect(readdirSync(install).some(name => name.startsWith('.goodvibes-directory-install.'))).toBe(true);
});

test('a fixed incoming tree and native directory claim are never deleted or adopted', () => {
  const target = oldDriver(), incoming = target + '.incoming'; mkdirSync(incoming); writeFileSync(join(incoming, 'foreign.txt'), 'Foreign interrupted stage');
  let result = run('driver'); expect(result.status).not.toBe(0);
  expect(readFileSync(join(incoming, 'foreign.txt'), 'utf8')).toBe('Foreign interrupted stage'); expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  // A separate real installation fixture is not needed to prove an occupied
  // native lock; remove only this test's exact original suite claims first.
  for (const name of readdirSync(install)) if (name.endsWith('.update-transaction')) rmSync(join(install, name));
  rmSync(incoming, { recursive: true }); writeFileSync(target + '.directory-update.lock', 'Foreign active native directory owner');
  result = run('driver'); expect(result.status).not.toBe(0);
  expect(readFileSync(target + '.directory-update.lock', 'utf8')).toBe('Foreign active native directory owner');
  expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
});

test('a failed incoming rename restores the exact parked original without deleting staging', () => {
  const target = oldDriver();
  const result = run('driver', `mv() { case "$1" in */incoming) return 71 ;; esac; command mv "$@"; }`);
  expect(result.status).not.toBe(0); expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  expect(existsSync(join(target, 'index.js'))).toBe(false); expect(existsSync(target + '.directory-update.lock')).toBe(false);
  expect(result.stderr).toContain('kept or restored');
  expect(readdirSync(install).some(name => name.startsWith('.goodvibes-directory-install.'))).toBe(true);
});

test('a rename that completed before returning failure is compensated using the original incoming descriptor', () => {
  const target = oldDriver();
  const result = run('driver', `_fault_once=0
    mv() { case "$1" in */incoming) if [ "$_fault_once" = 0 ]; then _fault_once=1; command mv "$@"; return 72; fi ;; esac; command mv "$@"; }`);
  expect(result.status).not.toBe(0); expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  expect(existsSync(target + '.directory-update.lock')).toBe(false); expect(result.stderr).toContain('kept or restored');
});

test('a foreign live replacement blocks compensation without overwriting it or deleting the retained original', () => {
  const target = oldDriver();
  const result = run('driver', `mv() { case "$1" in */incoming) mkdir "$2"; printf 'Foreign live directory' > "$2/foreign.txt"; return 73 ;; esac; command mv "$@"; }`);
  expect(result.status).not.toBe(0); expect(readFileSync(join(target, 'foreign.txt'), 'utf8')).toBe('Foreign live directory');
  const retained = outgoingFile(install, 'owner.txt'); expect(retained).toBeDefined(); expect(readFileSync(retained!, 'utf8')).toBe('Original owner driver content');
  expect(existsSync(target + '.directory-update.lock')).toBe(true); expect(result.stderr).toContain('needs inspection');
});

test('WebUI installation keeps other versions, owner-created directories and aliases', () => {
  const webui = join(install, 'webui'); mkdirSync(join(webui, '3.0.0'), { recursive: true }); mkdirSync(join(webui, 'custom'));
  writeFileSync(join(webui, '3.0.0', 'index.html'), 'A still-served previous bundle'); writeFileSync(join(webui, 'custom', 'owner.txt'), 'Owner custom deployment');
  const outside = join(root, 'outside-webui'); mkdirSync(outside); writeFileSync(join(outside, 'outside.txt'), 'Foreign target'); symlinkSync(outside, join(webui, 'custom-link'));
  const result = run('webui'); expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(webui, '3.1.2', 'index.html'), 'utf8')).toBe('New released WebUI');
  expect(readFileSync(join(webui, '3.0.0', 'index.html'), 'utf8')).toBe('A still-served previous bundle');
  expect(readFileSync(join(webui, 'custom', 'owner.txt'), 'utf8')).toBe('Owner custom deployment'); expect(lstatSync(join(webui, 'custom-link')).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, 'outside.txt'), 'utf8')).toBe('Foreign target');
});

test('a replaced WebUI parent receives no publication or cleanup after a borrowed copy returns', () => {
  const webui = join(install, 'webui'), old = join(webui, '3.1.2'); mkdirSync(old, { recursive: true }); writeFileSync(join(old, 'owner.txt'), 'Original configured bundle');
  const result = run('webui', `cp() { command cp "$@" || return; command mv "$WEBUI_ROOT" "$INSTALL_DIR/retained-webui-root"; mkdir "$WEBUI_ROOT"; printf 'Foreign parent' > "$WEBUI_ROOT/foreign.txt"; }`);
  expect(result.status).not.toBe(0); expect(readdirSync(webui)).toEqual(['foreign.txt']); expect(readFileSync(join(webui, 'foreign.txt'), 'utf8')).toBe('Foreign parent');
  expect(readFileSync(join(install, 'retained-webui-root', '3.1.2', 'owner.txt'), 'utf8')).toBe('Original configured bundle');
  expect(result.stderr).toContain('needs inspection');
});

test('replacing both hardlink names cannot mint a fresh original suite claim', () => {
  const target = oldDriver();
  const result = run('driver', `command rm -f "$INSTALL_DIR/goodvibes-daemon.update-transaction" "$INSTALL_CLAIM_OWNER/goodvibes-daemon"
    printf 'Foreign replacement claim' > "$INSTALL_DIR/goodvibes-daemon.update-transaction"
    command ln "$INSTALL_DIR/goodvibes-daemon.update-transaction" "$INSTALL_CLAIM_OWNER/goodvibes-daemon"`);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('Original installation claim ownership changed');
  expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  expect(readFileSync(join(install, 'goodvibes-daemon.update-transaction'), 'utf8')).toBe('Foreign replacement claim');
});

test('a substituted private claim directory is not adopted even when it contains matching links', () => {
  const target = oldDriver();
  const result = run('driver', `command mv "$INSTALL_CLAIM_OWNER" "$INSTALL_DIR/retained-original-claims"
    mkdir "$INSTALL_CLAIM_OWNER"
    for product in goodvibes-daemon goodvibes goodvibes-agent; do command ln "$INSTALL_DIR/$product.update-transaction" "$INSTALL_CLAIM_OWNER/$product"; done`);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('private claim directory changed');
  expect(readFileSync(join(target, 'owner.txt'), 'utf8')).toBe('Original owner driver content');
  expect(existsSync(join(install, 'retained-original-claims', 'goodvibes-daemon'))).toBe(true);
});

test('suite cleanup never unlinks a foreign private reference substituted after the public unlink', () => {
  oldDriver();
  const result = run('driver', `rm() { command rm "$@" || return
    if [ "\${2:-}" = "$INSTALL_DIR/goodvibes-daemon.update-transaction" ]; then
      command mv "$INSTALL_CLAIM_OWNER/goodvibes-daemon" "$INSTALL_CLAIM_OWNER/original-daemon-reference"
      printf 'Foreign private reference' > "$INSTALL_CLAIM_OWNER/goodvibes-daemon"
    fi
  }`);
  expect(result.status).not.toBe(0);
  const owner = readdirSync(install).find(name => name.startsWith('.goodvibes-install-claim.')); expect(owner).toBeDefined();
  expect(readFileSync(join(install, owner!, 'goodvibes-daemon'), 'utf8')).toBe('Foreign private reference');
  expect(existsSync(join(install, owner!, 'original-daemon-reference'))).toBe(true);
  expect(existsSync(join(install, 'goodvibes.update-transaction'))).toBe(true);
});

test('directory cleanup preserves a foreign private claim reference after publishing', () => {
  oldDriver();
  const result = run('driver', `rm() { command rm "$@" || return
    if [ "\${2:-}" = "$INSTALL_DIR/playwright-core.directory-update.lock" ]; then
      command mv "$_directory_work/claim" "$_directory_work/original-claim"
      printf 'Foreign directory reference' > "$_directory_work/claim"
    fi
  }`);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('directory is published');
  const owned = readdirSync(install).find(name => name.startsWith('.goodvibes-directory-install.')); expect(owned).toBeDefined();
  expect(readFileSync(join(install, owned!, 'claim'), 'utf8')).toBe('Foreign directory reference');
  expect(existsSync(join(install, owned!, 'original-claim'))).toBe(true);
  expect(readFileSync(join(install, 'playwright-core', 'index.js'), 'utf8')).toBe('New released driver');
});
