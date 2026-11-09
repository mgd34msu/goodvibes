/** Real uninstall/claim behavior, authored and intentionally UNRUN during coding first. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

test('program removal retains custom browser, WebUI, rollback and failed publication trees with guidance', () => {
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
  expect(result.stdout).toContain('Review the retained directory paths'); expect(result.stdout).toContain(join(install, 'webui'));
  expect(readdirSync(install).some(name => name.endsWith('.update-transaction'))).toBe(false);
});

test('uninstall does not follow or remove custom directory aliases', () => {
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'owner.txt'), 'Foreign deployment');
  symlinkSync(outside, join(install, 'webui')); symlinkSync(outside, join(install, 'playwright-core'));
  const result = run(); expect(result.status, result.stderr).toBe(0);
  expect(lstatSync(join(install, 'webui')).isSymbolicLink()).toBe(true); expect(lstatSync(join(install, 'playwright-core')).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(outside, 'owner.txt'), 'utf8')).toBe('Foreign deployment');
});

for (const path of ['goodvibes.update-transaction', 'goodvibes.bun.update-download', 'playwright-core.directory-update.lock', 'daemon-installation.json.update-download', 'lib/sqlite-vec-linux-x64/vec0.so.update-download']) {
  test(`retained ${path} refuses before service stops or program deletion`, () => {
    mkdirSync(dirname(join(install, path)), { recursive: true }); writeFileSync(join(install, path), 'Foreign retained update source');
    const result = run('printf called > "$FIXTURE_ROOT/stopped-service"'); expect(result.status).not.toBe(0);
    expect(existsSync(join(root, 'stopped-service'))).toBe(false); expect(readFileSync(join(install, path), 'utf8')).toBe('Foreign retained update source');
    for (const name of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) expect(readFileSync(join(install, name), 'utf8')).toBe('Original product program');
  });
}

test('uninstall holds actual program exclusions throughout a delayed service stop', () => {
  const result = run(`if (set -C; printf foreign > "$INSTALL_DIR/goodvibes.update-transaction") 2>/dev/null; then printf bypass > "$FIXTURE_ROOT/unsafe-claim"; fi`);
  expect(result.status, result.stderr).toBe(0); expect(existsSync(join(root, 'unsafe-claim'))).toBe(false);
  expect(existsSync(join(install, 'goodvibes'))).toBe(false); expect(existsSync(join(install, 'goodvibes.update-transaction'))).toBe(false);
});

test('a replaced root during service stop receives no program deletion', () => {
  const result = run(`mv "$INSTALL_DIR" "$FIXTURE_ROOT/retained-original"; mkdir "$INSTALL_DIR"; printf 'Foreign new program' > "$INSTALL_DIR/goodvibes"`);
  expect(result.status).not.toBe(0); expect(readFileSync(join(install, 'goodvibes'), 'utf8')).toBe('Foreign new program');
  for (const name of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) expect(readFileSync(join(root, 'retained-original', name), 'utf8')).toBe('Original product program');
  expect(result.stderr).toContain('original');
});

test('a root absent at entry is not adopted if another installation appears during service inspection', () => {
  rmSync(install, { recursive: true });
  const result = run(`mkdir "$INSTALL_DIR"; printf 'Newly installed elsewhere' > "$INSTALL_DIR/goodvibes"`);
  expect(result.status, result.stderr).toBe(0); expect(readFileSync(join(install, 'goodvibes'), 'utf8')).toBe('Newly installed elsewhere');
  expect(result.stdout).toContain('appeared after initial absence');
});


test('a native library parent replaced after one unlink cannot redirect the next backup deletion', () => {
  const parent = join(install, 'lib', 'sqlite-darwin-x64'), outside = join(root, 'outside-native');
  mkdirSync(parent, { recursive: true }); mkdirSync(outside);
  writeFileSync(join(parent, 'libsqlite3.dylib'), 'Installed native library'); writeFileSync(join(parent, 'libsqlite3.dylib.previous'), 'Original native backup');
  writeFileSync(join(outside, 'libsqlite3.dylib.previous'), 'Foreign native backup');
  const result = run(':', `rm() { command rm "$@" || return
    if [ "\${2:-}" = "$INSTALL_DIR/lib/sqlite-darwin-x64/libsqlite3.dylib" ]; then
      command mv "$INSTALL_DIR/lib/sqlite-darwin-x64" "$FIXTURE_ROOT/retained-native"
      command ln -s "$FIXTURE_ROOT/outside-native" "$INSTALL_DIR/lib/sqlite-darwin-x64"
    fi
  }`);
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('original native library directory changed');
  expect(readFileSync(join(outside, 'libsqlite3.dylib.previous'), 'utf8')).toBe('Foreign native backup');
  expect(readFileSync(join(root, 'retained-native', 'libsqlite3.dylib.previous'), 'utf8')).toBe('Original native backup');
});

test('a later shell configuration failure does not strand claims after settled program removal', () => {
  const result = run(':', '', 'return 91'); expect(result.status).not.toBe(0);
  for (const name of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) expect(existsSync(join(install, name))).toBe(false);
  expect(readdirSync(install).some(name => name.endsWith('.update-transaction'))).toBe(false);
  expect(result.stderr).not.toContain('uninstall did not finish');
});
