/** Native held-object regressions for the sourced release installer. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let root: string, directory: string, file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installer-open-file-'));
  directory = join(root, "owner's directory;$(touch PWNED)");
  mkdirSync(directory);
  file = join(directory, 'original');
  writeFileSync(file, 'Original held bytes');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function shell(source: string) {
  return spawnSync('sh', ['-c', `set -eu
    . "$FIXTURE_INSTALLER"
    ${source}
  `], { encoding: 'utf8', timeout: 15_000, cwd: root, env: { ...process.env,
    HOME: root, GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_INSTALL_DIR: directory,
    FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), DIRECTORY: directory, FILE: file,
    // Deliberately disagree with the actual filesystem host.
    FIXTURE_RELEASE_OS: process.platform === 'darwin' ? 'linux' : 'macos',
  } });
}

function succeeds(source: string) {
  const result = shell(source);
  expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(root, 'PWNED'))).toBe(false);
  return result;
}

test('all installer descriptor slots retain real files and directories independently of release selection', () => {
  succeeds(`
    os_tag=$FIXTURE_RELEASE_OS
    exec 0< "$DIRECTORY"
    exec 3< "$FILE"
    exec 4< "$DIRECTORY"
    exec 5< "$FILE"
    exec 6< "$DIRECTORY"
    exec 7< "$FILE"
    exec 8< "$DIRECTORY"
    exec 9< "$DIRECTORY"
    for fd in 0 3 4 5 6 7 8 9; do
      case "$fd" in 3|5|7) selected=$FILE ;; *) selected=$DIRECTORY ;; esac
      installer_open_file_matches "$fd" "$selected"
    done
    exec 7<&-
    if installer_open_file_matches 7 "$FILE"; then exit 91; fi
  `);
});

test('file replacement cannot be adopted and held revision observes the retained inode', () => {
  succeeds(`
    exec 3< "$FILE"
    [ "$(shadow_target_stamp)" = "$(shadow_entry_stamp "$FILE")" ]
    mv "$FILE" "$FILE.retained"
    printf 'Foreign replacement' > "$FILE"
    if installer_open_file_matches 3 "$FILE"; then exit 91; fi
    installer_open_file_matches 3 "$FILE.retained"
    [ "$(shadow_target_stamp)" = "$(shadow_entry_stamp "$FILE.retained")" ]
    [ "$(shadow_target_stamp)" != "$(shadow_entry_stamp "$FILE")" ]
    original_revision=$(shadow_target_stamp)
    printf ' changed in place' >> "$FILE.retained"
    installer_open_file_matches 3 "$FILE.retained"
    [ "$(shadow_target_stamp)" != "$original_revision" ]
  `);
  expect(readFileSync(file, 'utf8')).toBe('Foreign replacement');
});

test('directory replacement cannot satisfy its original held descriptor', () => {
  succeeds(`
    exec 9< "$DIRECTORY"
    mv "$DIRECTORY" "$DIRECTORY.retained"
    mkdir "$DIRECTORY"
    if installer_open_file_matches 9 "$DIRECTORY"; then exit 91; fi
    installer_open_file_matches 9 "$DIRECTORY.retained"
  `);
});

test('uninstall suite claims capture fd0 and release every original regular claim', () => {
  succeeds(`
    VERSION=v3.1.2; os_tag=$FIXTURE_RELEASE_OS
    exec 0< "$DIRECTORY"
    claim_release_install uninstall
    assert_install_claims
    release_install_claims
    for product in goodvibes-daemon goodvibes goodvibes-agent; do
      [ ! -e "$DIRECTORY/$product.update-transaction" ]
    done
  `);
});

test('a symlink to the original private directory remains ineligible for claim cleanup', () => {
  succeeds(`
    VERSION=v3.1.2
    exec 0< "$DIRECTORY"
    claim_release_install uninstall
    mv "$INSTALL_CLAIM_OWNER" "$INSTALL_CLAIM_OWNER.retained"
    ln -s "$INSTALL_CLAIM_OWNER.retained" "$INSTALL_CLAIM_OWNER"
    installer_open_file_matches 8 "$INSTALL_CLAIM_OWNER"
    if release_install_claims; then exit 91; fi
    [ -f "$DIRECTORY/goodvibes-daemon.update-transaction" ]
    [ -f "$INSTALL_CLAIM_OWNER.retained/goodvibes-daemon" ]
  `);
});

test('a symlink to an original claim cannot authorize deleting that public entry', () => {
  succeeds(`
    VERSION=v3.1.2
    exec 0< "$DIRECTORY"
    claim_release_install uninstall
    claim="$DIRECTORY/goodvibes-daemon.update-transaction"
    mv "$claim" "$claim.retained"
    ln -s "$claim.retained" "$claim"
    installer_open_file_matches 5 "$claim"
    if release_install_claims; then exit 91; fi
    [ -L "$claim" ] && [ -f "$claim.retained" ]
    [ -f "$INSTALL_CLAIM_OWNER/goodvibes-daemon" ]
  `);
});

const darwinTest = process.platform === 'darwin' ? test : test.skip;
darwinTest('native Darwin fstat and lstat revisions ignore an incompatible stat selected through PATH', () => {
  const gnubin = join(root, 'gnubin');
  mkdirSync(gnubin);
  writeFileSync(join(gnubin, 'stat'), '#!/bin/sh\nprintf "incompatible GNU stat format\\n"\n', { mode: 0o755 });
  succeeds(`
    PATH="$HOME/gnubin:$PATH"
    exec 3< "$FILE"
    installer_open_file_matches 3 "$FILE"
    native_revision=$(/usr/bin/stat -f '%d:%i:%u:%g:%p:%z:%m:%c' -- "$FILE")
    [ "$(shadow_target_stamp)" = "$native_revision" ]
    [ "$(shadow_target_stamp)" = "$(shadow_entry_stamp "$FILE")" ]
    ln -s "$FILE" "$FILE.link"
    installer_open_file_matches 3 "$FILE.link"
    [ "$(shadow_target_stamp)" != "$(shadow_entry_stamp "$FILE.link")" ]
  `);
});
