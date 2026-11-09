/** Structured shadow cleanup regressions, authored and UNRUN during coding first. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
let root: string, home: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'installer-shadow-removal-')); home = join(root, 'home'); mkdirSync(home); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function binary(path: string, body = 'printf "goodvibes 2.0.25\\n"') {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); return path;
}
function shell(source: string, values: Record<string, string> = {}) {
  return spawnSync('sh', ['-c', `set -eu; . "$FIXTURE_INSTALLER"; ${source}`], { encoding: 'utf8', timeout: 12_000,
    env: { ...process.env, HOME: home, GOODVIBES_INSTALL_SH_LIB: '1', FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), ...values } });
}
test('quoted display arguments preserve spaces, apostrophes, substitutions and separators', () => {
  const value = `${home}/o'wner/$(touch NOT_A_COMMAND);file`;
  const result = shell('shadow_quote "$VALUE"', { VALUE: value });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe(`'${value.replaceAll("'", "'\\''")}'`);
  expect(existsSync(join(root, 'NOT_A_COMMAND'))).toBe(false);
});
test('a standalone path with shell metacharacters is removed only through structured argv', () => {
  const copy = binary(join(home, "o'wner;$(touch PWNED)", 'goodvibes'));
  const result = shell(`
    plan=$(shadow_removal_plan "$COPY" goodvibes)
    shadow_confirm() { return 0; }
    confirm_shadow_removal "$plan" "$COPY" goodvibes "$(shadow_existing_path "$COPY")"
  `, { COPY: copy });
  expect(result.status, result.stderr).toBe(0); expect(existsSync(copy)).toBe(false);
  expect(existsSync(join(root, 'PWNED'))).toBe(false);
});
test('candidate replacement while prompting preserves both the foreign replacement and original', () => {
  const copy = binary(join(home, 'bin', 'goodvibes')), saved = `${copy}.original`;
  const result = shell(`
    plan=$(shadow_removal_plan "$COPY" goodvibes)
    shadow_confirm() { mv "$COPY" "$SAVED"; printf foreign > "$COPY"; return 0; }
    if confirm_shadow_removal "$plan" "$COPY" goodvibes "$(shadow_existing_path "$COPY")"; then exit 9; fi
  `, { COPY: copy, SAVED: saved });
  expect(result.status, result.stderr).toBe(0); expect(readFileSync(copy, 'utf8')).toBe('foreign'); expect(existsSync(saved)).toBe(true);
});
test('same target symlink replacement during confirmation does not adopt a new cleanup entry', () => {
  const target = binary(join(home, 'program', 'goodvibes')), copy = join(home, 'bin', 'goodvibes'); mkdirSync(dirname(copy)); symlinkSync(target, copy);
  const result = shell(`
    plan=$(shadow_removal_plan "$COPY" goodvibes)
    shadow_confirm() { mv "$COPY" "$COPY.saved"; ln -s "$TARGET" "$COPY"; return 0; }
    if confirm_shadow_removal "$plan" "$COPY" goodvibes "$(shadow_existing_path "$COPY")"; then exit 9; fi
  `, { COPY: copy, TARGET: target });
  expect(result.status, result.stderr).toBe(0); expect(existsSync(copy)).toBe(true); expect(existsSync(`${copy}.saved`)).toBe(true);
});
test('a borrowed reprobe replacing the target after confirmation is rejected before unlink', () => {
  const copy = binary(join(home, 'bin', 'goodvibes')), saved = `${copy}.original`;
  const result = shell(`
    plan=$(shadow_removal_plan "$COPY" goodvibes)
    shadow_confirm() {
      shadow_version_of() { mv "$COPY" "$SAVED"; printf foreign > "$COPY"; printf '2.0.25\\n'; }
      return 0
    }
    if confirm_shadow_removal "$plan" "$COPY" goodvibes "$(shadow_existing_path "$COPY")"; then exit 9; fi
  `, { COPY: copy, SAVED: saved });
  expect(result.status, result.stderr).toBe(0); expect(readFileSync(copy, 'utf8')).toBe('foreign'); expect(existsSync(saved)).toBe(true);
});
test('npm removal names the actual captured global prefix and never evaluates formatted text', () => {
  const prefix = join(home, "npm glo'bal;literal"), target = binary(join(prefix, 'lib/node_modules/@pellux/goodvibes-tui/bin/goodvibes'));
  const copy = join(home, 'bin', 'goodvibes'), log = join(root, 'argv'); mkdirSync(dirname(copy)); symlinkSync(target, copy);
  const result = shell(`
    shadow_manager_output() {
      case "$*" in
        'npm root --global') printf '%s/lib/node_modules\\n' "$PREFIX" ;;
        'npm prefix --global') printf '%s\\n' "$PREFIX" ;;
        bun*) return 1 ;;
        *) "$@" ;;
      esac
    }
    npm() { printf '%s\\0' "$@" > "$ARGV_LOG"; }
    plan=$(shadow_removal_plan "$COPY" goodvibes)
    shadow_confirm() { return 0; }
    confirm_shadow_removal "$plan" "$COPY" goodvibes "$(shadow_existing_path "$COPY")"
  `, { PREFIX: prefix, COPY: copy, ARGV_LOG: log });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(log, 'utf8').split('\0')).toEqual(['--prefix', prefix, 'rm', '-g', '--ignore-scripts', '@pellux/goodvibes-tui', '']);
});
test('bounded probe refuses oversized output and nonzero-exit banners', () => {
  const oversized = binary(join(home, 'oversized'), 'perl -e \'print "x" x 65537\''), failed = binary(join(home, 'failed'), 'printf "goodvibes 2.0.25\\n"; exit 7');
  const result = shell('if shadow_manager_output "$LARGE"; then exit 9; fi; test -z "$(shadow_version_of "$FAILED" goodvibes)"', { LARGE: oversized, FAILED: failed });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('');
});
