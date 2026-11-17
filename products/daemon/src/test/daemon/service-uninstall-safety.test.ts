import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runDaemonServiceCli, SERVICE_EXIT_NOT_OURS, type ManagedServiceActionRunner } from '../../daemon/service-commands.js';
import { MANAGED_SERVICE_DESCRIPTION } from '../../runtime/managed-daemon-service.js';
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
  // A definition this product wrote names its description; anything else is the owner's and is never removed.
  writeFileSync(unit, platform === 'systemd'
    ? `[Unit]\nDescription=${MANAGED_SERVICE_DESCRIPTION}\n[Service]\nExecStart=/fixture/goodvibes-daemon\n`
    : `<plist><dict><key>Label</key><string>owned-service</string><key>ProgramArguments</key><array><string>/fixture/goodvibes-daemon</string></array></dict></plist>\n`);
  const input = { subcommand: 'uninstall-service' as const, binaryPath: '/fixture/goodvibes-daemon',
    homeDir, unitHomeDir, host: '127.0.0.1', port: 4567, legacyUnitFileExists: () => false };
  return { input, unit, settings };
}

test('an uninstall stops, disables and removes only the managed definition and keeps the data', async () => {
  const { input, unit, settings } = fixture();
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
  // The daemon's data and the owner's settings stay.
  expect(existsSync(settings)).toBe(true);
});

test('a definition GoodVibes did not write is never stopped or removed', async () => {
  const { input, unit } = fixture();
  writeFileSync(unit, '[Unit]\nDescription=The owner\'s own service\n[Service]\nExecStart=/usr/bin/true\n');
  const actions: string[][] = [];
  const runner: ManagedServiceActionRunner = (command, args) => {
    if (args.includes('is-active')) return { status: 0, stdout: 'active\n' };
    actions.push([command, ...args]);
    return { status: 0 };
  };
  const result = await runDaemonServiceCli({ ...input, actionRunner: runner });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(SERVICE_EXIT_NOT_OURS);
  expect(actions).toEqual([]);
  expect(readFileSync(unit, 'utf8')).toContain('The owner');
});
