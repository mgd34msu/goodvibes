/** Pinned daemon service assertions 5c85003cde26cc618fda3d58e7a5cf1b78594594.
 * Reconstructed after executor replacement; see the bounded source-proof audit.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { PlatformServiceManager } from '@goodvibes-jev/engine/platform/platform/daemon';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { buildManagedDaemonServiceManager, MANAGED_SERVICE_NAME } from '../../runtime/legacy-daemon-migration.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const surfaceRoot = GOODVIBES_DAEMON_SURFACE_ROOT;
type Call = { command: string; args: readonly string[] };
describe('canonical service lifecycle and product command composition', () => {
  let root = '';
  beforeEach(() => { root = makeOwnedTempDir('gv-service-manager'); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  function config(platform: 'manual' | 'systemd' | 'launchd' | 'windows', serviceName = 'goodvibes-test') {
    const value = new ConfigManager({ surfaceRoot, workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', surfaceRoot) });
    value.set('service.platform', platform);
    value.set('service.serviceName', serviceName);
    return value;
  }
  function manager(value: ConfigManager, calls: Call[]) {
    return new PlatformServiceManager(value, {
      workingDirectory: root, homeDirectory: root, surfaceRoot,
      actionRunner: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: '', stderr: '' }; },
    });
  }

  test('canonical manual definition preserves original default source-command contract', () => {
    const value = config('manual');
    value.set('service.autostart', true);
    value.set('service.restartOnFailure', true);
    value.set('service.logPath', `.goodvibes/${surfaceRoot}/service/manual-custom.log`);
    const service = manager(value, []);
    expect(service.status()).toMatchObject({ platform: 'manual', installed: false,
      logPath: join(root, '.goodvibes', surfaceRoot, 'service', 'manual-custom.log') });
    const installed = service.install();
    expect(installed.installed).toBe(true);
    expect(installed.path).toBe(join(root, '.goodvibes', surfaceRoot, 'service', 'manual-service.txt'));
    // Generic engine default only. Production daemon supplies an explicit binary below.
    expect(installed.contents).toContain('src/daemon/cli.ts');
    expect(installed.commandPreview).toContain('manual-service.txt');
    expect(service.uninstall().installed).toBe(false);
  });

  test('product manager installs the supplied executable and daemon state home, without legacy source or endpoint flags', () => {
    const value = config('systemd', 'gv-product');
    const binaryPath = new URL('../../../bin/goodvibes-daemon', import.meta.url).pathname;
    expect(existsSync(binaryPath)).toBe(true);
    const service = buildManagedDaemonServiceManager({
      configManager: value, binaryPath, homeDir: root, unitHomeDir: root,
      workingDirectory: root, host: '127.0.0.1', port: 31111,
      actionRunner: () => ({ status: 0, stdout: '', stderr: '' }),
    });
    const installed = service.install();
    expect(installed.path).toBe(join(root, '.config', 'systemd', 'user', 'gv-product.service'));
    expect(installed.contents).toContain(binaryPath);
    expect(installed.contents).toContain('--daemon-home');
    expect(installed.contents).toContain(join(root, '.goodvibes', 'daemon'));
    expect(installed.contents).not.toContain('src/daemon/cli.ts');
    expect(installed.contents).not.toContain('--hostname');
    expect(installed.contents).not.toContain('--port');
    expect(service.uninstall().installed).toBe(false);
  });

  test('product launchd definition label, selected path and operations use the same default or explicit name', () => {
    for (const [index, configured] of [undefined, 'goodvibes', 'owner.goodvibes.daemon'].entries()) {
      const value = new ConfigManager({ configDir: join(root, String(index)), surfaceRoot });
      value.set('service.platform', 'launchd');
      if (configured !== undefined) value.set('service.serviceName', configured);
      const expected = configured ?? MANAGED_SERVICE_NAME, calls: Call[] = [];
      const service = buildManagedDaemonServiceManager({ configManager: value,
        binaryPath: join(root, 'goodvibes-daemon'), homeDir: root, unitHomeDir: root, workingDirectory: root,
        host: '127.0.0.1', port: 3421,
        actionRunner: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: `4242\t0\t${expected}\n`, stderr: '' }; } });
      const installed = service.install(), path = join(root, 'Library/LaunchAgents', expected + '.plist');
      expect(installed.serviceName).toBe(expected); expect(installed.path).toBe(path);
      expect(installed.contents).toContain(`<key>Label</key>\n  <string>${expected}</string>`);
      expect(installed.running).toBe(true);
      service.restart();
      expect(calls.filter(call => call.args[0] !== 'list')).toEqual([
        { command: 'launchctl', args: ['unload', path] }, { command: 'launchctl', args: ['load', path] },
      ]);
    }
  });

  test('product default selection uses the login unit home rather than a relocated data home', () => {
    const dataHome = join(root, 'data'), unitHome = join(root, 'login');
    const legacy = join(unitHome, 'Library/LaunchAgents/goodvibes.plist');
    const otherCanonical = join(dataHome, 'Library/LaunchAgents/sh.goodvibes.daemon.plist');
    mkdirSync(join(unitHome, 'Library/LaunchAgents'), { recursive: true });
    mkdirSync(join(dataHome, 'Library/LaunchAgents'), { recursive: true });
    writeFileSync(legacy, 'Original login-home definition'); writeFileSync(otherCanonical, 'Unrelated selected-tree definition');
    const value = new ConfigManager({ configDir: join(root, 'config'), surfaceRoot }); value.set('service.platform', 'launchd');
    const service = buildManagedDaemonServiceManager({ configManager: value, binaryPath: join(root, 'goodvibes-daemon'),
      homeDir: dataHome, unitHomeDir: unitHome, workingDirectory: root, host: '127.0.0.1', port: 3421,
      actionRunner: () => ({ status: 0, stdout: '4242\t0\tgoodvibes\n', stderr: '' }) });
    expect(service.status()).toMatchObject({ serviceName: 'goodvibes', path: legacy, installed: true, running: true });
    expect(readFileSync(legacy, 'utf8')).toBe('Original login-home definition');
    expect(readFileSync(otherCanonical, 'utf8')).toBe('Unrelated selected-tree definition');
  });

  test('real manual child install/start/status/restart/stop preserves pid and log path', () => {
    const value = config('manual');
    const logPath = join(root, '.goodvibes', surfaceRoot, 'service', 'manual.log');
    value.set('service.logPath', logPath);
    const service = new PlatformServiceManager(value, {
      workingDirectory: root, homeDirectory: root, surfaceRoot,
      definitionOverride: { name: 'test-daemon', description: 'test daemon', workingDirectory: root,
        command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: {}, restartOnFailure: false },
    });
    try {
      expect(service.install().logPath).toBe(logPath);
      const started = service.start();
      expect(started.running).toBe(true);
      expect(typeof started.pid).toBe('number');
      expect(started.logPath).toBe(logPath);
      const restarted = service.restart();
      expect(restarted.running).toBe(true);
      expect(typeof restarted.pid).toBe('number');
      expect(restarted.pid).not.toBe(started.pid);
      expect(service.status().pid).toBe(restarted.pid);
      expect(service.status().running).toBe(true);
      expect(service.stop().running).toBe(false);
    } finally { service.stop(); service.uninstall(); }
  });

  test('systemd configured-name artifact and exact mutating command sequence', () => {
    const calls: Call[] = [];
    const value = config('systemd', 'gv-ops');
    value.set('service.restartOnFailure', false);
    value.set('service.autostart', true);
    const logPath = join(root, '.goodvibes', surfaceRoot, 'service', 'systemd.log');
    value.set('service.logPath', logPath);
    const service = manager(value, calls);
    const installed = service.install();
    expect(installed.path.endsWith('gv-ops.service')).toBe(true);
    expect(installed.contents).toContain('Restart=no');
    expect(installed.contents).toContain('ExecStart=');
    expect(installed.logPath).toBe(logPath);
    service.start(); service.stop(); service.restart();
    const statusQueries = calls.filter(c => c.args.includes('is-active'));
    for (const call of calls.filter(c => c.command === 'loginctl')) expect(['show-user', 'enable-linger']).toContain(call.args[0]!);
    expect(calls.filter(c => !c.args.includes('is-active') && !c.args.includes('--version') && c.command !== 'loginctl')).toEqual([
      { command: 'systemctl', args: ['--user', 'enable', '--now', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'stop', 'gv-ops.service'] },
      { command: 'systemctl', args: ['--user', 'restart', 'gv-ops.service'] },
    ]);
    for (const query of statusQueries) expect(query).toEqual({ command: 'systemctl', args: ['--user', 'is-active', 'gv-ops.service'] });
  });

  test('launchd and Windows configured-name artifacts and exact actions', () => {
    const launchdCalls: Call[] = [];
    const launchd = manager(config('launchd', 'dev.goodvibes.launchd'), launchdCalls);
    const installed = launchd.install();
    expect(installed.path.endsWith('dev.goodvibes.launchd.plist')).toBe(true);
    expect(installed.contents).toContain('<key>Label</key>');
    expect(installed.contents).toContain('<string>dev.goodvibes.launchd</string>');
    launchd.start(); launchd.stop(); launchd.restart();
    expect(launchdCalls.filter(c => c.args[0] !== 'list')).toEqual([
      { command: 'launchctl', args: ['load', installed.path] },
      { command: 'launchctl', args: ['unload', installed.path] },
      { command: 'launchctl', args: ['unload', installed.path] },
      { command: 'launchctl', args: ['load', installed.path] },
    ]);
    const windowsCalls: Call[] = [];
    const windows = manager(config('windows', 'GoodVibesTask'), windowsCalls);
    expect(windows.install().contents).toContain('schtasks /Create /SC ONLOGON /TN "GoodVibesTask"');
    windows.start(); windows.stop(); windows.restart();
    expect(windowsCalls).toEqual([
      { command: 'schtasks', args: ['/Run', '/TN', 'GoodVibesTask'] },
      { command: 'schtasks', args: ['/End', '/TN', 'GoodVibesTask'] },
      { command: 'schtasks', args: ['/Run', '/TN', 'GoodVibesTask'] },
    ]);
  });
});
