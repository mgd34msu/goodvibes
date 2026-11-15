import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ManagedServiceStatus } from '@goodvibes-jev/engine/platform/platform/daemon';
import { buildCliServicePosture, createPlatformServiceManager } from '../../cli/service-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root = '';
beforeEach(() => { root = makeProjectTempDir('goodvibes-service-name'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function createManagedStatus(overrides: Partial<ManagedServiceStatus> = {}): ManagedServiceStatus {
  return {
    platform: 'systemd',
    serviceName: 'goodvibes',
    path: '/tmp/goodvibes.service',
    installed: true,
    autostart: true,
    running: false,
    commandPreview: '/tmp/goodvibes.service',
    suggestedCommands: [],
    lastAction: 'status',
    ...overrides,
  };
}

test('with no configured name the CLI inspects the unit the installer registers', async () => {
  const projectRoot = join(root, 'project'), homeRoot = join(root, 'home');
  mkdirSync(projectRoot, { recursive: true }); mkdirSync(homeRoot, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: projectRoot, homeDir: homeRoot });
  const asked: string[] = [];
  const posture = await buildCliServicePosture(
    { configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot },
    {
      manager: { status: () => createManagedStatus({ installed: false, autostart: false, running: false }) },
      runCommand: (_command, args) => {
        asked.push(args[2] ?? '');
        return args[2] === 'goodvibes-jev.service'
          ? { status: 0, stdout: 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=42' }
          : { status: 1, stdout: '' };
      },
    },
  );
  expect(asked).toEqual(['goodvibes-jev.service']);
  expect(posture.managed.installed).toBe(true);
  expect(posture.managed.running).toBe(true);
  expect(createPlatformServiceManager({ configManager: config, workingDirectory: projectRoot, homeDirectory: homeRoot }).status().serviceName).toBe('goodvibes-jev');
});
