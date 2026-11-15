import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDaemonServiceCli, type ManagedServiceActionRunner } from '../../daemon/service-commands.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

function fixture(platform: 'systemd' | 'launchd' = 'systemd') {
  const root = makeOwnedTempDir('service-uninstall-safety');
  const homeDir = join(root, 'state');
  const unitHomeDir = join(root, 'login');
  const settings = join(homeDir, '.goodvibes', 'tui', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ service: { platform, serviceName: 'owned-service' } }));
  const unit = platform === 'systemd'
    ? join(unitHomeDir, '.config', 'systemd', 'user', 'owned-service.service')
    : join(unitHomeDir, 'Library', 'LaunchAgents', 'owned-service.plist');
  mkdirSync(dirname(unit), { recursive: true });
  writeFileSync(unit, 'owned recovery definition\n');
  const input = { subcommand: 'uninstall-service' as const, binaryPath: '/fixture/goodvibes-daemon',
    homeDir, unitHomeDir, host: '127.0.0.1', port: 4567, legacyUnitFileExists: () => false };
  return { input, unit };
}

test('a stopped launchd service is uninstalled with one unload, even though unloading it exits non-zero', async () => {
  const { input, unit } = fixture('launchd');
  const actions: string[][] = [];
  const runner: ManagedServiceActionRunner = (command, args) => {
    if (args[0] === 'list') return { status: 1, stdout: '' };
    actions.push([command, ...args]);
    return { status: 1, stderr: 'Could not find specified service' };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.exitCode).toBe(0);
  expect(existsSync(unit)).toBe(false);
  expect(actions).toEqual([['launchctl', 'unload', unit]]);
});

test('with nothing installed it exits 4 and runs no service action', async () => {
  const { input, unit } = fixture();
  rmSync(unit);
  const actions: string[][] = [];
  const runner: ManagedServiceActionRunner = (command, args) => {
    if (args.includes('is-active')) return { status: 3, stdout: 'inactive\n' };
    actions.push([command, ...args]);
    return { status: 5 };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.exitCode).toBe(4);
  expect(result.lines.join('\n')).toContain('nothing to uninstall');
  expect(actions).toEqual([]);
});

test('a refused systemd teardown is reported as a failure that names it', async () => {
  const { input } = fixture();
  const runner: ManagedServiceActionRunner = (_command, args) => {
    if (args.includes('is-active')) return { status: 0, stdout: 'active\n' };
    if (args.includes('disable')) return { status: 1, stderr: 'Access denied' };
    return { status: 0 };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(result.lines.join('\n')).toContain('may still be running');
});

test('an uninstall stops, disables and removes only the managed definition', async () => {
  const { input, unit } = fixture();
  const neighbor = join(dirname(unit), 'unrelated.service');
  writeFileSync(neighbor, 'unrelated definition\n');
  let active = true;
  const actions: string[][] = [];
  const runner: ManagedServiceActionRunner = (_command, args) => {
    if (args.includes('is-active')) return active
      ? { status: 0, stdout: 'active\n' } : { status: 3, stdout: 'inactive\n' };
    actions.push([...args]);
    if (args.includes('disable')) active = false;
    return { status: 0 };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(result.status.running).toBe(false);
  expect(existsSync(unit)).toBe(false);
  expect(actions).toEqual([['--user', 'disable', '--now', 'owned-service.service'], ['--user', 'daemon-reload']]);
  expect(readFileSync(neighbor, 'utf8')).toBe('unrelated definition\n');
  expect(result.lines.join('\n')).toContain('stopped and removed the systemd service');
});

test('a service still running after removal is reported incomplete', async () => {
  const { input } = fixture();
  const runner: ManagedServiceActionRunner = (_command, args) => {
    if (args.includes('is-active')) return { status: 0, stdout: 'active\n' };
    return { status: 0 };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(result.status.installed).toBe(false);
  expect(result.status.running).toBe(true);
  expect(result.lines.join('\n')).toContain('incomplete');
});

test('a final status query that throws after removal leaves an honest incomplete receipt', async () => {
  const { input, unit } = fixture();
  const runner: ManagedServiceActionRunner = (_command, args) => {
    if (args.includes('is-active')) {
      if (!existsSync(unit)) throw new Error('fixture final query failed');
      return { status: 3, stdout: 'inactive\n' };
    }
    return { status: 0 };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(existsSync(unit)).toBe(false);
  expect(result.lines.join('\n')).toContain('removal may already have happened');
  expect(result.lines.join('\n')).toContain('last confirmed state before removal');
});
