/** Release installer behaviours exercised through the sourced shell library, one function at a time. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installer = resolve(import.meta.dir, 'install.sh');
let root: string, home: string, install: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installer-functions-')); home = join(root, 'home'); install = join(root, 'install');
  mkdirSync(home); mkdirSync(install);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function lib(body: string, env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', ['-c', `set -eu\n. "$FIXTURE_INSTALLER"\n${body}`], { encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, HOME: home, SHELL: '/bin/bash', GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_INSTALL_DIR: install,
      FIXTURE_INSTALLER: installer, ...env } });
}
test('the unit marker and description the installer writes are the ones the daemon recognizes', async () => {
  // Loaded by path at run time so this check does not pull the daemon's sources into the installer's typecheck.
  const daemon = resolve(import.meta.dir, '../products/daemon/src/runtime');
  const { INSTALLER_UNIT_MARKER } = await import(join(daemon, 'legacy-daemon-reconcile.ts')) as { INSTALLER_UNIT_MARKER: string };
  const { MANAGED_SERVICE_DESCRIPTION } = await import(join(daemon, 'legacy-daemon-migration.ts')) as { MANAGED_SERVICE_DESCRIPTION: string };
  const source = readFileSync(installer, 'utf8');
  expect(source).toContain(`\nINSTALLER_MARKER="${INSTALLER_UNIT_MARKER}"\n`);
  expect(source).toContain(`\nPRODUCT_UNIT_FINGERPRINT='${MANAGED_SERVICE_DESCRIPTION}'\n`);
});

const claimSetup = 'VERSION=v3.2.0; os_tag=linux; arch_tag=x64; VEC_OS=linux; VEC_SUFFIX=so; PLATFORM_SUFFIX=linux-x64';

test('a second install directory gets its own PATH line and uninstalling one leaves the other', () => {
  const result = lib(`PATH=/usr/bin:/bin
    INSTALL_DIR=/opt/one; ensure_path_on_shell_rc >/dev/null
    INSTALL_DIR=/opt/two; ensure_path_on_shell_rc >/dev/null
    ensure_path_on_shell_rc >/dev/null
    INSTALL_DIR=/opt/one; uninstall_shell_rc_path_line >/dev/null`);
  expect(result.status, result.stderr).toBe(0);
  const rc = readFileSync(join(home, '.bashrc'), 'utf8');
  expect(rc).toContain('/opt/two');
  expect(rc).not.toContain('/opt/one');
  expect(rc.match(/managed by goodvibes install.sh/g)).toHaveLength(1);
});

test('both install directories are exported before any uninstall', () => {
  const result = lib(`PATH=/usr/bin:/bin
    INSTALL_DIR=/opt/one; ensure_path_on_shell_rc >/dev/null
    INSTALL_DIR=/opt/two; ensure_path_on_shell_rc >/dev/null
    ensure_path_on_shell_rc >/dev/null`);
  expect(result.status, result.stderr).toBe(0);
  const rc = readFileSync(join(home, '.bashrc'), 'utf8');
  expect(rc).toContain('export PATH="/opt/one:$PATH"');
  expect(rc).toContain('export PATH="/opt/two:$PATH"');
  expect(rc.match(/managed by goodvibes install.sh/g)).toHaveLength(2);
});

test('a decision policy the daemon refuses to save does not end the install and names the command to run', () => {
  writeFileSync(join(install, 'goodvibes-daemon'), '#!/bin/sh\necho "config store is locked" >&2\nexit 1\n', { mode: 0o755 });
  const result = lib(`DECISION_POLICY=Preferred
    apply_decision_policy
    echo "continued unsaved=$DECISION_POLICY_UNSAVED"`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('continued unsaved=1');
  expect(result.stdout).toContain(`${install}/goodvibes-daemon config set judgment.policy 'Preferred'`);
});

test('a saved decision policy stays silent', () => {
  writeFileSync(join(install, 'goodvibes-daemon'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = lib(`DECISION_POLICY=Preferred; apply_decision_policy; echo "unsaved=$DECISION_POLICY_UNSAVED"`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('unsaved=0');
});

test('the wget fallback bounds the wait and retries', () => {
  const stubs = join(root, 'stubs'); mkdirSync(stubs);
  writeFileSync(join(stubs, 'wget'), `#!/bin/sh
printf '%s\\n' "$*" > "$ARGS_FILE"
while [ "$#" -gt 0 ]; do case "$1" in -O) dest=$2; shift ;; esac; shift; done
printf downloaded > "$dest"
`, { mode: 0o755 });
  const result = spawnSync('/bin/sh', ['-c', `set -eu\n. "$FIXTURE_INSTALLER"\nfetch https://example.invalid/asset "$DEST"`], { encoding: 'utf8',
    env: { PATH: stubs, HOME: home, GOODVIBES_INSTALL_SH_LIB: '1', FIXTURE_INSTALLER: installer, ARGS_FILE: join(root, 'args'), DEST: join(root, 'asset') } });
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(join(root, 'asset'), 'utf8')).toBe('downloaded');
  const args = readFileSync(join(root, 'args'), 'utf8');
  expect(args).toContain('--timeout=30');
  expect(args).toContain('--tries=3');
});

test('only the long-running daemon of this install is signalled, never a short CLI call or the terminal UI', () => {
  const result = lib(`
    pgrep() { printf '%s\\n' 101 102 103 104 105; }
    proc_exe_path() { case "$1" in 101|102) echo "$INSTALL_DIR/goodvibes-daemon" ;; 103) echo "$INSTALL_DIR/goodvibes" ;; 104) echo /elsewhere/goodvibes-daemon ;; 105) echo "$INSTALL_DIR/goodvibes-daemon.bun" ;; esac; }
    proc_subcommand() { case "$1" in 102) echo status ;; 105) echo serve ;; esac; }
    pids_owned_by_install '[g]oodvibes-daemon'`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(['101', '105']);
});

test('a headless agent run is not the agent program, the bare agent and tui are', () => {
  const result = lib(`
    pgrep() { printf '%s\\n' 201 202 203 204; }
    proc_exe_path() { echo "$INSTALL_DIR/goodvibes-agent"; }
    proc_subcommand() { case "$1" in 202) echo run ;; 203) echo tui ;; 204) echo doctor ;; esac; }
    pids_owned_by_install '[g]oodvibes-agent'`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(['201', '203']);
});

test('a bare relaunch and a flags-only launch are the server, a subcommand is not', () => {
  const result = lib(`
    echo "bare=[$(printf '' | args_subcommand)]"
    echo "flags=[$(printf '%s\\n' --port 3499 | args_subcommand)]"
    echo "bunfs=[$(printf '%s\\n' '/$bunfs/root/goodvibes-daemon-linux-x64' serve | args_subcommand)]"
    echo "cli=[$(printf '%s\\n' status --json | args_subcommand)]"`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(['bare=[]', 'flags=[]', 'bunfs=[serve]', 'cli=[status]']);
});

test('the checkout installer names itself when run outside a checkout', () => {
  const scripts = join(root, 'checkout', 'scripts'); mkdirSync(scripts, { recursive: true });
  copyFileSync(resolve(import.meta.dir, 'install-from-checkout.sh'), join(scripts, 'install-from-checkout.sh'));
  const stubs = join(root, 'stubs'); mkdirSync(stubs);
  const stub = (name: string, body: string) => { writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`); chmodSync(join(stubs, name), 0o755); };
  for (const name of ['git', 'curl', 'tar', 'unzip', 'sha256sum', 'getconf']) stub(name, 'exit 0');
  stub('id', 'echo 1000');
  stub('uname', 'case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac');
  const result = spawnSync('bash', [join(scripts, 'install-from-checkout.sh')], { encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ''}`, HOME: home } });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Run install-from-checkout.sh from a cloned goodvibes-jev repository');
  expect(result.stderr).not.toContain('Run install.sh');
});

const handWrittenUnit = (flags: string) => `[Unit]\nDescription=my own daemon\n[Service]\nExecStart=/opt/gv/goodvibes-daemon ${flags}\n`;

test('advice for a hand-written unit never tells the operator to add --daemon-home, which turns off automatic updates', () => {
  mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
  writeFileSync(join(home, '.config/systemd/user/goodvibes.service'), handWrittenUnit('--hostname 0.0.0.0 --port 4000'));
  const result = lib(`os_tag=linux; refresh_stale_canonical_unit`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Remove --hostname/--port and any --daemon-home');
  expect(result.stdout).not.toContain(`--daemon-home ${home}/.goodvibes/daemon`);
});

test('a managed unit rewrite does not claim an explicit home override it did not write', () => {
  mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
  writeFileSync(join(home, '.config/systemd/user/goodvibes.service'), `# managed by goodvibes install.sh\n${handWrittenUnit('--port 4000')}`);
  const result = lib(`os_tag=linux; RESTART_DAEMON=1
    write_systemd_unit() { printf 'ExecStart=%s/goodvibes-daemon\\n' "$INSTALL_DIR" > "$1"; }
    systemctl() { :; }
    refresh_stale_canonical_unit`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('rewrote');
  expect(result.stdout).not.toContain('--daemon-home');
});

test('a launchd pid is matched exactly, so pid 123 is not supervised just because pid 1234 is', () => {
  const result = lib(`os_tag=macos
    launchctl() { printf 'state = running\\n\\tpid = 1234\\n'; }
    echo "short=$(pid_supervision 123)"
    echo "exact=$(pid_supervision 1234)"`);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim().split('\n')).toEqual(['short=free', 'exact=supervised']);
});

test('the installer claim is JSON the native updater recognises as a live holder', () => {
  const result = lib(`${claimSetup}
    claim_release_install
    echo "shell=$$"
    cat "$INSTALL_DIR/goodvibes-daemon.update-transaction"
    release_install_claims`);
  expect(result.status, result.stderr).toBe(0);
  const lines = result.stdout.trim().split('\n');
  const shellPid = Number(lines[0]!.replace('shell=', ''));
  const claim = JSON.parse(lines.slice(1).join('\n')) as { pid: number; startedAt: number; version: string };
  expect(claim.pid).toBe(shellPid);
  expect(Number.isSafeInteger(claim.startedAt)).toBe(true);
  expect(Math.abs(Date.now() - claim.startedAt)).toBeLessThan(60_000);
  expect(claim.version).toBe('v3.2.0');
});

function seedPreviousCohort(backupMatchesInstalled: boolean) {
  writeFileSync(join(install, 'goodvibes-daemon'), 'release 3.2.0');
  writeFileSync(join(install, 'goodvibes-daemon.goodvibes-previous'), backupMatchesInstalled ? 'release 3.2.0' : 'release 3.1.0');
  for (const name of ['goodvibes-daemon.previous', 'goodvibes.previous', 'goodvibes-agent.bun.previous', 'daemon-installation.json.previous']) writeFileSync(join(install, name), 'release 3.0.0');
  mkdirSync(join(install, 'playwright-core.previous')); writeFileSync(join(install, 'playwright-core.previous', 'index.js'), 'old driver');
}
const discard = () => lib(`${claimSetup}\nclaim_release_install\ndiscard_stale_previous_cohort\nrelease_install_claims`);

test('replacing the programs with a different release drops the updater rollback copies of an older one', () => {
  seedPreviousCohort(false);
  const result = discard(); expect(result.status, result.stderr).toBe(0);
  expect(readdirSync(install).filter(name => name.endsWith('.previous')).sort()).toEqual(['playwright-core.previous']);
  expect(readFileSync(join(install, 'playwright-core.previous', 'index.js'), 'utf8')).toBe('old driver');
  expect(readFileSync(join(install, 'goodvibes-daemon'), 'utf8')).toBe('release 3.2.0');
});

test('reinstalling the same release keeps the rollback copies, which are still the true previous release', () => {
  seedPreviousCohort(true);
  const result = discard(); expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(install, 'goodvibes-daemon.previous'))).toBe(true);
  expect(existsSync(join(install, 'goodvibes.previous'))).toBe(true);
});

const PRODUCT_DESCRIPTION = 'GoodVibes daemon (shared session broker + companion host)';
function uninstallUnit(content: string, execPath: string) {
  const unit = join(home, '.config/systemd/user/goodvibes.service'); mkdirSync(join(home, '.config/systemd/user'), { recursive: true });
  writeFileSync(unit, content);
  const result = lib(`
    systemctl() { printf '%s\\n' "$*" >> "$FIXTURE_CALLS"; case "$*" in *"show -p ExecStart"*) printf '{ path=%s ; argv[]=x }' "$FIXTURE_EXEC" ;; esac; return 0; }
    uninstall_systemd_service goodvibes.service "${unit}" >/dev/null
    printf '%s' "$UNINSTALL_REMOVED|$UNINSTALL_KEPT"`, { FIXTURE_CALLS: join(root, 'calls'), FIXTURE_EXEC: execPath });
  expect(result.status, result.stderr).toBe(0);
  const calls = existsSync(join(root, 'calls')) ? readFileSync(join(root, 'calls'), 'utf8') : '';
  return { unit, calls, summary: result.stdout };
}

test('uninstall removes and disables a canonical unit the product wrote without the installer marker', () => {
  const { unit, calls } = uninstallUnit(`[Unit]\nDescription=${PRODUCT_DESCRIPTION}\n[Service]\nExecStart=/x/goodvibes-daemon\n`, '/x/goodvibes-daemon');
  expect(existsSync(unit)).toBe(false);
  expect(calls).toContain('disable --now goodvibes.service');
});

test('uninstall keeps a hand-written unit but disables it when it starts a program the uninstall removes', () => {
  const { unit, calls, summary } = uninstallUnit('[Unit]\nDescription=mine\n[Service]\nExecStart=INSTALL/goodvibes-daemon\n'.replace('INSTALL', install), `${install}/goodvibes-daemon`);
  expect(existsSync(unit)).toBe(true);
  expect(calls).toContain('disable goodvibes.service');
  expect(summary).toContain('hand-written');
});

test('uninstall neither removes nor disables a hand-written unit for an unrelated program', () => {
  const { unit, calls } = uninstallUnit('[Unit]\nDescription=mine\n[Service]\nExecStart=/opt/other/daemon\n', '/opt/other/daemon');
  expect(existsSync(unit)).toBe(true);
  expect(calls).not.toContain('disable');
});

function publishDriver() {
  const work = join(root, 'work'); rmSync(work, { recursive: true, force: true });
  const staging = join(work, 'browser-driver-staging', 'playwright-core'); mkdirSync(staging, { recursive: true });
  for (const name of ['package.json', 'index.js', 'cli.js']) writeFileSync(join(staging, name), 'Released driver');
  const result = lib(`${claimSetup}; WORKDIR="$FIXTURE_WORK"
    claim_release_install
    INSTALL_SWAP_BEGUN=1; INSTALL_JOURNAL=$FIXTURE_WORK/swap-journal; : > "$INSTALL_JOURNAL"
    install_browser_driver
    INSTALL_SWAP_FINISHED=1; commit_install_journal
    release_install_claims`, { FIXTURE_WORK: work });
  expect(result.status, result.stderr).toBe(0);
}

test('repeating an installation of the same release leaves no parked copy of the driver tree', () => {
  publishDriver(); publishDriver(); publishDriver();
  expect(readdirSync(install).filter(name => name.startsWith('.goodvibes-directory-install.'))).toEqual([]);
  expect(readFileSync(join(install, 'playwright-core', 'index.js'), 'utf8')).toBe('Released driver');
});
