import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ManagedServiceStatus } from '@goodvibes-jev/engine/platform/platform/daemon';
import {
  syncServiceSettingToPlatform,
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

  test('turning autostart on installs and starts the OS service and says whether it starts at boot', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: false, running: false }));
    const lingerNote = 'lingering: could not be enabled, the daemon starts at login rather than at boot';
    const manager: ServiceManagerLike = { ...base, install: () => ({ ...base.install(), lingerNote }) };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      { createManager: () => manager },
    );

    expect(configManager.get('service.enabled')).toBe(true);
    expect(calls).toEqual(['install', 'start']);
    expect(result.message).toBe(`OS service installed and started; ${lingerNote}`);
  });

  test('a failed install removes what it wrote and turns the settings back off', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: false, running: false }));
    const failing: ServiceManagerLike = {
      ...base,
      install: () => { calls.push('install'); return createStatus({ installed: true, actionError: 'systemctl --user failed: boom' }); },
    };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      { createManager: () => failing },
    );

    expect(calls).toEqual(['install', 'uninstall']);
    expect(result.error).toBe('systemctl --user failed: boom');
    expect(result.message).toContain('Service install failed: systemctl --user failed: boom');
    expect(result.message).toContain('turned back off');
    expect(configManager.get('service.autostart')).toBe(false);
    expect(configManager.get('service.enabled')).toBe(false);
  });

  test('a failed start after install removes the installed service before the settings turn back off', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: false, running: false }));
    const failing: ServiceManagerLike = {
      ...base,
      start: () => { calls.push('start'); return createStatus({ installed: true, actionError: 'unit failed to start' }); },
    };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      { createManager: () => failing },
    );

    expect(calls).toEqual(['install', 'start', 'uninstall']);
    expect(result.status?.installed).toBe(false);
    expect(result.error).toBe('unit failed to start');
    expect(result.message).toContain('Service start failed: unit failed to start');
    expect(configManager.get('service.autostart')).toBe(false);
    expect(configManager.get('service.enabled')).toBe(false);
  });

  test('a start failure whose cleanup also fails keeps the settings on, because a service is installed', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: false, running: false }));
    const failing: ServiceManagerLike = {
      ...base,
      start: () => { calls.push('start'); return createStatus({ installed: true, actionError: 'unit failed to start' }); },
      uninstall: () => { calls.push('uninstall'); return createStatus({ installed: true, actionError: 'disable failed' }); },
    };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: false, value: true },
      { createManager: () => failing },
    );

    expect(result.message).toContain('installed but could not be removed');
    expect(configManager.get('service.autostart')).toBe(true);
    expect(configManager.get('service.enabled')).toBe(true);
  });

  test('a failed disable keeps the settings on and says the service still runs', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', false);
    const calls: string[] = [];
    const base = createManager(calls, createStatus({ installed: true, running: true }));
    const failing: ServiceManagerLike = {
      ...base,
      uninstall: () => { calls.push('uninstall'); return createStatus({ installed: false, running: true, actionError: 'systemctl --user failed, so the service may still be running: boom' }); },
    };

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: true, value: false },
      { createManager: () => failing },
    );

    expect(calls).toEqual(['uninstall']);
    expect(result.error).toContain('boom');
    expect(result.message).toContain('Service disable failed');
    expect(result.message).toContain('still running');
    expect(configManager.get('service.autostart')).toBe(true);
    expect(configManager.get('service.enabled')).toBe(true);
  });

  test('turning autostart off removes the service through the manager alone', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', false);
    const calls: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: true, value: false },
      { createManager: () => createManager(calls, createStatus({ installed: true, running: true })) },
    );

    expect(calls).toEqual(['uninstall']);
    expect(result.message).toBe('OS service disabled');
  });

  test('a service still running after its definition is gone is stopped by name', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', false);
    const calls: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.autostart', previousValue: true, value: false },
      { createManager: () => createManager(calls, createStatus({ installed: false, running: true })) },
    );

    expect(calls).toEqual(['stop']);
    expect(result.message).toBe('OS service disabled');
  });

  test('turning service mode off also clears autostart and disables the OS service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', false);
    configManager.setDynamic('service.autostart', true);
    const calls: string[] = [];

    syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.enabled', previousValue: true, value: false },
      { createManager: () => createManager(calls, createStatus({ installed: true, running: true })) },
    );

    expect(configManager.get('service.autostart')).toBe(false);
    expect(calls).toEqual(['uninstall']);
  });

  test('service definition changes rewrite and restart an installed autostart service', () => {
    const configManager = createConfig();
    configManager.setDynamic('service.enabled', true);
    configManager.setDynamic('service.autostart', true);
    configManager.setDynamic('service.restartOnFailure', false);
    const calls: string[] = [];

    const result = syncServiceSettingToPlatform(
      { configManager, workingDirectory: root, homeDirectory: root },
      { key: 'service.restartOnFailure', previousValue: true, value: false },
      { createManager: () => createManager(calls, createStatus({ installed: true, running: true })) },
    );

    expect(calls).toEqual(['install', 'restart']);
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
