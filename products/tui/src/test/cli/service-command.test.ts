import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { handleServiceCommand } from '../../cli/service-command.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let root = '';
beforeEach(() => { root = makeProjectTempDir('goodvibes-service-command'); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function runtimeFor(sub: string): { runtime: CliCommandRuntime; config: ConfigManager; home: string } {
  const project = join(root, 'project'), home = join(root, 'home');
  mkdirSync(project, { recursive: true }); mkdirSync(home, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: project, homeDir: home });
  config.setDynamic('service.platform', 'manual');
  return {
    config, home,
    runtime: { cli: { commandArgs: [sub], flags: { outputFormat: 'text' }, positionals: [] }, configManager: config, workingDirectory: project, homeDirectory: home } as unknown as CliCommandRuntime,
  };
}

test('a service install that cannot run leaves the service flags as they were', async () => {
  const { runtime, config, home } = runtimeFor('install');
  config.setDynamic('service.enabled', false);
  config.setDynamic('service.autostart', false);
  // A file where the daemon state directory belongs makes the install fail before the manager acts.
  mkdirSync(join(home, '.goodvibes'), { recursive: true });
  writeFileSync(join(home, '.goodvibes', 'daemon'), 'not a directory');
  await expect(handleServiceCommand(runtime)).rejects.toThrow();
  expect(config.get('service.enabled')).toBe(false);
  expect(config.get('service.autostart')).toBe(false);
});

test('a successful install enables the service and uninstall turns the flags off again', async () => {
  const installed = runtimeFor('install');
  const result = await handleServiceCommand(installed.runtime);
  expect(result.exitCode).toBe(0);
  expect(installed.config.get('service.enabled')).toBe(true);
  const removed = await handleServiceCommand({ ...installed.runtime, cli: { ...installed.runtime.cli, commandArgs: ['uninstall'] } } as CliCommandRuntime);
  expect(removed.exitCode).toBe(0);
  expect(installed.config.get('service.enabled')).toBe(false);
  expect(installed.config.get('service.autostart')).toBe(false);
});
