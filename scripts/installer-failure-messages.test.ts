/** Failure-path notices of the sourced release installer name exactly what had already happened. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let root: string, units: string, install: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'installer-failure-messages-')); units = join(root, 'units'); install = join(root, 'install');
  mkdirSync(units); mkdirSync(install);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function shell(body: string) {
  return spawnSync('sh', ['-c', `set -eu
    . "$FIXTURE_INSTALLER"
    ${body}
  `], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, HOME: root, GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_INSTALL_DIR: install,
    FIXTURE_INSTALLER: resolve(import.meta.dir, 'install.sh'), FIXTURE_UNITS: units } });
}

// Every service-manager call is a shell function; the real systemctl is never reachable from here.
function transfer(systemctlBody: string) {
  writeFileSync(join(units, 'goodvibes-daemon.service'), '# managed by goodvibes install.sh\n');
  writeFileSync(join(units, 'goodvibes.service'), 'stale canonical unit with pinned flags\n');
  return shell(`
    os_tag=linux; RESTART_DAEMON=1; VERIFY_SETTLE_SECS=0
    systemd_unit_path() { printf '%s/%s' "$FIXTURE_UNITS" "$1"; }
    systemd_daemon_unit_path() { printf '%s/goodvibes.service' "$FIXTURE_UNITS"; }
    legacy_unit_provenance() { echo installer-managed; }
    canonical_unit_provenance() { echo managed; }
    unit_launch_stale_reason() { echo 'pins an endpoint'; }
    unit_active_state() { case "$1" in "$LEGACY_SYSTEMD_DAEMON_UNIT") echo active ;; *) echo inactive ;; esac; }
    unit_enabled_state() { echo no; }
    write_systemd_unit() { printf 'corrected launch form\\n' > "$1"; }
    systemctl() { ${systemctlBody}; }
    migrate_legacy_systemd_unit
  `);
}

test('A36: legacy stop failing after the canonical unit was rewritten says so and names the kept backup', () => {
  const result = transfer('case "$*" in *"stop $LEGACY_SYSTEMD_DAEMON_UNIT"*) return 1 ;; esac; return 0');
  expect(result.status, result.stderr).toBe(0);
  const backup = readdirSync(units).find(name => name.startsWith('goodvibes.service.bak.'))!;
  expect(readFileSync(join(units, 'goodvibes.service'), 'utf8')).toBe('corrected launch form\n');
  expect(result.stdout).not.toContain('nothing was changed');
  expect(result.stdout).toContain(join(units, backup));
  expect(result.stdout).toContain('corrected launch form already written');
});

test('A36: a failed transfer rollback names the kept canonical unit and the exact command to restore its backup', () => {
  const result = transfer('case "$*" in *"enable --now"*) return 1 ;; esac; return 0');
  expect(result.status, result.stderr).toBe(0);
  const backup = join(units, readdirSync(units).find(name => name.startsWith('goodvibes.service.bak.'))!);
  expect(result.stdout).toContain('rolling back');
  expect(result.stdout).toContain('kept');
  expect(result.stdout).toContain(`mv ${backup} ${join(units, 'goodvibes.service')} && systemctl --user daemon-reload`);
  expect(readFileSync(backup, 'utf8')).toBe('stale canonical unit with pinned flags\n');
});

test('A41: an uninstall that fails in the service step says its completed parts stay done and how to finish', () => {
  const result = shell(`
    os_tag=linux
    uninstall_services_and_processes() { fail 'fixture service failure'; }
    run_uninstall
  `);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('fixture service failure');
  expect(result.stderr).toContain('stay stopped or removed');
  expect(result.stderr).toContain('GOODVIBES_UNINSTALL=1');
  expect(readdirSync(install).filter(name => /update-transaction|install-claim/.test(name))).toEqual([]);
  expect(existsSync(install)).toBe(true);
});
