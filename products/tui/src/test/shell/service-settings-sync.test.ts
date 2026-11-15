import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ManagedServiceStatus } from '@goodvibes-jev/engine/platform/platform/daemon';
import {
  syncServiceSettingToPlatform,
  type CommandResult,
  type ServiceManagerLike,
} from '../../shell/service-settings-sync.ts';

function createStatus(overrides: Partial<ManagedServiceStatus> = {}): ManagedServiceStatus {
  return {
    platform: 'systemd',
    serviceName: 'goodvibes',
    path: '/tmp/goodvibes.service',
    installed: true,
    autostart: true,
    running: false,
    commandPreview: 'goodvibes-daemon',
    suggestedCommands: [],
    lastAction: 'status',
    ...overrides,
  };
}

function createManager(calls: string[], status: ManagedServiceStatus = createStatus()): ServiceManagerLike {
  return {
    status: () => status,
    install: () => {
      calls.push('install');
      status = { ...status, installed: true, lastAction: 'install' };
      return status;
    },
    uninstall: () => {
      calls.push('uninstall');
      status = { ...status, installed: false, running: false, lastAction: 'uninstall' };
      return status;
    },
    start: () => {
      calls.push('start');
      status = { ...status, running: true, lastAction: 'start' };
      return status;
    },
    stop: () => {
      calls.push('stop');
      status = { ...status, running: false, lastAction: 'stop' };
      return status;
    },
    restart: () => {
      calls.push('restart');
      status = { ...status, running: true, lastAction: 'restart' };
      return status;
    },
  };
}

describe('syncServiceSettingToPlatform', () => {
  let root = '';

  beforeEach(() => {
    const testRoot = join(import.meta.dir, '../../../.tmp-tests');
    mkdirSync(testRoot, { recursive: true });
    root = mkdtempSync(join(testRoot, 'gv-service-sync-'));
    mkdirSync(join(root, '.goodvibes', 'tui'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function createConfig(): ConfigManager {
    return new ConfigManager({
      surfaceRoot: 'tui',
      workingDir: root,
      homeDir: root,
      configDir: join(root, '.goodvibes', 'tui'),
    });
  }

  test('turning autostart on installs, reloads, and starts the OS service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const commands: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      {
        createManager: () => createManager(calls, createStatus({ installed: false, running: false })),
        runCommand: (command, args): CommandResult => {
          commands.push([command, ...args].join(' '));
          return { status: 0 };
        },
      },
    );

    expect(configManager.get('service.enabled')).toBe(true);
    expect(calls).toEqual(['install', 'start']);
    expect(commands).toEqual(['systemctl --user daemon-reload']);
    expect(result.message).toBe('OS service installed and started');
  });

  test('a failed install turns the settings back off so the toggle does not read ON with no service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: false, running: false }));
    const failing: ServiceManagerLike = {
      ...base,
      install: () => { calls.push('install'); return createStatus({ installed: false, actionError: 'systemctl not found' }); },
    };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      { createManager: () => failing, runCommand: () => ({ status: 0 }) },
    );

    expect(result.error).toBe('systemctl not found');
    expect(result.message).toContain('Service install failed: systemctl not found');
    expect(result.message).toContain('turned back off');
    expect(configManager.get('service.autostart')).toBe(false);
    expect(configManager.get('service.enabled')).toBe(false);
  });

  test('a failed systemctl reload after install is reported as a failure, never as installed and started, and the settings turn back off', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      {
        createManager: () => createManager(calls, createStatus({ installed: false, running: false })),
        runCommand: (): CommandResult => ({ status: 1, stderr: 'boom' }),
      },
    );

    expect(result.error).toBe('boom');
    expect(result.message).toContain('Service install failed: boom');
    expect(result.message).not.toContain('installed and started');
    // The service is never started after a reload that did not take.
    expect(calls).toEqual(['install']);
    expect(configManager.get('service.autostart')).toBe(false);
    expect(configManager.get('service.enabled')).toBe(false);
  });

  test('a failed start after install is reported as a failure and the settings turn back off', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: false, running: false }));
    const failing: ServiceManagerLike = {
      ...base,
      start: () => { calls.push('start'); return createStatus({ actionError: 'unit failed to start' }); },
    };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      { createManager: () => failing, runCommand: () => ({ status: 0 }) },
    );

    expect(calls).toEqual(['install', 'start']);
    expect(result.error).toBe('unit failed to start');
    expect(result.message).toContain('Service start failed: unit failed to start');
    expect(result.message).not.toContain('installed and started');
    expect(configManager.get('service.autostart')).toBe(false);
    expect(configManager.get('service.enabled')).toBe(false);
  });

  test('a failed systemctl disable is reported as a failure, not as disabled', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', false);
    const calls: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: true, value: false },
      {
        createManager: () => createManager(calls, createStatus({ installed: true, running: true })),
        runCommand: (): CommandResult => ({ status: 1, stderr: 'boom' }),
      },
    );

    expect(result.error).toBe('boom');
    expect(result.message).toBe('Service disable failed: boom');
  });

  test('turning autostart off disables and removes the systemd service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', false);
    const calls: string[] = [];
    const commands: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: true, value: false },
      {
        createManager: () => createManager(calls, createStatus({ installed: true, running: true })),
        runCommand: (command, args): CommandResult => {
          commands.push([command, ...args].join(' '));
          return { status: 0 };
        },
      },
    );

    expect(calls).toEqual(['uninstall']);
    expect(commands).toEqual([
      'systemctl --user disable --now goodvibes-jev.service',
      'systemctl --user daemon-reload',
    ]);
    expect(result.message).toBe('OS service disabled');
  });

  test('turning service mode off also clears autostart and disables the OS service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const commands: string[] = [];

    syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.enabled', previousValue: true, value: false },
      {
        createManager: () => createManager(calls, createStatus({ installed: true, running: true })),
        runCommand: (command, args): CommandResult => {
          commands.push([command, ...args].join(' '));
          return { status: 0 };
        },
      },
    );

    expect(configManager.get('service.autostart')).toBe(false);
    expect(calls).toEqual(['uninstall']);
    expect(commands).toContain('systemctl --user disable --now goodvibes-jev.service');
  });

  test('service definition changes rewrite and restart an installed autostart service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', true);
    configManager.setDynamic('service.restartOnFailure', false);
    const calls: string[] = [];
    const commands: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.restartOnFailure', previousValue: true, value: false },
      {
        createManager: () => createManager(calls, createStatus({ installed: true, running: true })),
        runCommand: (command, args): CommandResult => {
          commands.push([command, ...args].join(' '));
          return { status: 0 };
        },
      },
    );

    expect(calls).toEqual(['install', 'restart']);
    expect(commands).toEqual(['systemctl --user daemon-reload']);
    expect(result.message).toBe('OS service updated');
  });

  test('ignores non-service settings', () => {
    const configManager = createConfig();
    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'display.stream', previousValue: true, value: false },
      { createManager: () => createManager([]) },
    );

    expect(result.handled).toBe(false);
  });
});
