/** Installer plist generation and migration preserve the selected service context. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

let root: string, home: string, install: string, plist: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installer-launchd-context-'));
  home = join(root, `Home & <workspace> "quoted" 'apostrophe'`);
  install = join(root, `Programs & <native> "quoted" 'apostrophe'`);
  plist = join(home, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
  mkdirSync(home); mkdirSync(install);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(body: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('sh', ['-c', `set -eu
    . "$FIXTURE_INSTALLER"
    launchctl() { printf '%s\n' "$1" >> "$FIXTURE_ROOT/launchctl-calls"; return 1; }
    ${body}
  `], { encoding: 'utf8', timeout: 10_000, env: { ...process.env,
    HOME: home, GOODVIBES_INSTALL_DIR: install, GOODVIBES_INSTALL_SH_LIB: '1',
    FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), FIXTURE_ROOT: root, FIXTURE_PLIST: plist, ...env,
  } });
}

// Parse with the standard-library plist reader, independently of the shell
// writer. This catches malformed XML and verifies decoded path/label bytes.
function readPlist(): Record<string, unknown> {
  const result = spawnSync('python3', ['-c',
    'import json, plistlib, sys\nwith open(sys.argv[1], "rb") as f: print(json.dumps(plistlib.load(f)))', plist],
  { encoding: 'utf8', timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function expectContext(label = 'sh.goodvibes.daemon', workingDirectory = home) {
  expect(readPlist()).toEqual({
    Label: label, GoodVibesManagedBy: 'managed by goodvibes install.sh',
    ProgramArguments: [join(install, 'goodvibes-daemon')], WorkingDirectory: workingDirectory,
    RunAtLoad: true, KeepAlive: { SuccessfulExit: false },
  });
}

test.each([undefined, 'goodvibes', `label & <native> "quoted" 'apostrophe'`])(
  'launchd writer provides an explicit home workspace and valid XML for label %s', label => {
    const result = run('write_launchd_plist "$FIXTURE_PLIST" "${FIXTURE_LABEL:-$LAUNCHD_DAEMON_LABEL}"',
      label === undefined ? {} : { FIXTURE_LABEL: label });
    expect(result.status, result.stderr).toBe(0);
    expectContext(label);
    expect(readFileSync(plist, 'utf8')).toContain('<!-- managed by goodvibes install.sh -->');
  },
);

test.each(['sh.goodvibes.daemon', 'goodvibes'])('migration repairs a managed %s plist missing its cwd without starting it', label => {
  const generated = run('write_launchd_plist "$FIXTURE_PLIST" "$FIXTURE_LABEL"', { FIXTURE_LABEL: label });
  expect(generated.status, generated.stderr).toBe(0);
  const previous = readFileSync(plist, 'utf8').replace(/  <key>WorkingDirectory<\/key>\n  <string>[^\n]*<\/string>\n/, '');
  writeFileSync(plist, previous);
  const result = run('migrate_one_launchd_plist "$FIXTURE_PLIST" "$FIXTURE_LABEL"', { FIXTURE_LABEL: label });
  expect(result.status, result.stderr).toBe(0); expectContext(label);
  expect(result.stdout).toContain('leaving it stopped');
  expect(readFileSync(join(root, 'launchctl-calls'), 'utf8').trim()).toBe('print');
  const backups = readdirSync(dirname(plist)).filter(name => name.includes('.bak.'));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(dirname(plist), backups[0]!), 'utf8')).toBe(previous);
});

test('a custom plist missing cwd remains byte-for-byte unchanged', () => {
  mkdirSync(dirname(plist), { recursive: true });
  const custom = '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>custom</string><key>ProgramArguments</key><array><string>/custom/daemon</string></array></dict></plist>\n';
  writeFileSync(plist, custom);
  const result = run('migrate_one_launchd_plist "$FIXTURE_PLIST" custom');
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(plist, 'utf8')).toBe(custom);
  expect(readdirSync(dirname(plist))).toEqual(['sh.goodvibes.daemon.plist']);
});

test('migration preserves an explicitly selected service workspace', () => {
  const generated = run('write_launchd_plist "$FIXTURE_PLIST"');
  expect(generated.status, generated.stderr).toBe(0);
  const previous = readFileSync(plist, 'utf8').replace(/(<key>WorkingDirectory<\/key>\n  <string>)[^\n]*(<\/string>)/, '$1/custom/workspace$2');
  writeFileSync(plist, previous);
  const result = run('migrate_one_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL"');
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(plist, 'utf8')).toBe(previous);
  expect(readdirSync(dirname(plist))).toEqual(['sh.goodvibes.daemon.plist']);
});

// Exercise the native tool contract on Linux too: Python only supplies the
// fixture's decoded stdout; production uses macOS plutil without a runtime.
const plutilFixture = `plutil() {
  [ "$#" = 10 ] && [ "$1" = -extract ] && [ "$2" = WorkingDirectory ] &&
    [ "$3" = raw ] && [ "$4" = -expect ] && [ "$5" = string ] &&
    [ "$6" = -n ] && [ "$7" = -o ] && [ "$8" = - ] && [ "$9" = -- ] || return 1
  python3 -c 'import plistlib, sys; value = plistlib.load(open(sys.argv[1], "rb"))["WorkingDirectory"]; assert isinstance(value, str); sys.stdout.write(value)' "\${10}"
}`;

test.each(['--hostname', '--daemon-home'])('migration of legacy %s retains the decoded explicit project workspace', flag => {
  const workspace = join(root, `Project & <chosen> "quoted" 'apostrophe'`);
  const generated = run('write_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL" "$FIXTURE_WORKSPACE"', { FIXTURE_WORKSPACE: workspace });
  expect(generated.status, generated.stderr).toBe(0);
  const previous = readFileSync(plist, 'utf8').replace('  </array>', `    <string>${flag}</string>\n    <string>old-value</string>\n  </array>`);
  writeFileSync(plist, previous);
  const result = run(`${plutilFixture}\nmigrate_one_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL"`);
  expect(result.status, result.stderr).toBe(0); expectContext('sh.goodvibes.daemon', workspace);
  expect(result.stdout).toContain('leaving it stopped');
  expect(readFileSync(join(root, 'launchctl-calls'), 'utf8').trim()).toBe('print');
  const backups = readdirSync(dirname(plist)).filter(name => name.includes('.bak.'));
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(dirname(plist), backups[0]!), 'utf8')).toBe(previous);
});

test.each(['decode-failure', 'empty', 'trailing-newline', 'tab', 'wrong-type'])('migration leaves explicit cwd unchanged on %s', scenario => {
  const generated = run('write_launchd_plist "$FIXTURE_PLIST"');
  expect(generated.status, generated.stderr).toBe(0);
  const value = scenario === 'empty' ? '<string></string>'
    : scenario === 'trailing-newline' ? '<string>/chosen/workspace&#10;</string>'
      : scenario === 'tab' ? '<string>/chosen/&#9;workspace</string>'
        : scenario === 'wrong-type' ? '<integer>123</integer>' : '<string>/chosen/workspace</string>';
  const previous = readFileSync(plist, 'utf8')
    .replace(/(<key>WorkingDirectory<\/key>\n  )<string>[^\n]*<\/string>/, `$1${value}`)
    .replace('  </array>', '    <string>--hostname</string>\n    <string>old-host</string>\n  </array>');
  writeFileSync(plist, previous);
  const result = run(`${scenario === 'decode-failure' ? 'plutil() { return 1; }' : plutilFixture}\nmigrate_one_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL"`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('leaving the file untouched');
  expect(readFileSync(plist, 'utf8')).toBe(previous);
  expect(readdirSync(dirname(plist))).toEqual(['sh.goodvibes.daemon.plist']);
});

// A38: a failed reload restores the previous plist and loads it. launchctl is a shell function here.
function staleLoadedPlist() {
  const generated = run('write_launchd_plist "$FIXTURE_PLIST"');
  expect(generated.status, generated.stderr).toBe(0);
  const previous = readFileSync(plist, 'utf8').replace(/  <key>WorkingDirectory<\/key>\n  <string>[^\n]*<\/string>\n/, '');
  writeFileSync(plist, previous);
  return previous;
}
const fakeLaunchctl = (bootstrapOk: string) => `launchctl() {
  printf '%s %s\\n' "$1" "$(grep -c WorkingDirectory "$FIXTURE_PLIST" || true)" >> "$FIXTURE_ROOT/launchctl-calls"
  case "$1" in
    print|bootout) return 0 ;;
    bootstrap|load) ${bootstrapOk} ;;
  esac
  return 1
}`;

test('a failed bootstrap of the rewritten plist restores the previous file and loads it again', () => {
  const previous = staleLoadedPlist();
  // Loading succeeds only for the previous file (no WorkingDirectory key), not for the rewritten one.
  const result = run(`${fakeLaunchctl('[ "$(grep -c WorkingDirectory "$FIXTURE_PLIST" || true)" = 0 ] && return 0')}\nmigrate_one_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL"`);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(plist, 'utf8')).toBe(previous);
  expect(result.stdout).toContain('previous');
  expect(result.stdout).toContain('running as before');
  const calls = readFileSync(join(root, 'launchctl-calls'), 'utf8').trim().split('\n');
  expect(calls.filter(call => call.startsWith('bootstrap'))).toEqual(['bootstrap 1', 'bootstrap 0']);
  expect(readdirSync(dirname(plist)).filter(name => name.includes('.bak.'))).toHaveLength(1);
});

test('if even the restored plist cannot be loaded, it is still restored and the exact command is printed', () => {
  const previous = staleLoadedPlist();
  const result = run(`${fakeLaunchctl('return 1')}\nmigrate_one_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL"`);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(plist, 'utf8')).toBe(previous);
  expect(result.stdout).toContain(`launchctl bootstrap gui/`);
  expect(result.stdout).toContain('could not be loaded either');
});

test('a successful reload is unchanged: the rewritten plist stays and no restore happens', () => {
  const previous = staleLoadedPlist();
  const result = run(`${fakeLaunchctl('return 0')}\nmigrate_one_launchd_plist "$FIXTURE_PLIST" "$LAUNCHD_DAEMON_LABEL"`);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(plist, 'utf8')).not.toBe(previous);
  expect(result.stdout).toContain('reloaded');
  expectContext();
});
