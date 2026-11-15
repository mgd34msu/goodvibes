import { describe, expect, test, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '@goodvibes-jev/engine/platform/platform/workspace';
import {
  readCheckpointGuardSettings,
  readSessionSettings,
  readStatuslineSettings,
  readUpdateSettings,
  withCheckpointGuardSettings,
} from '@/config/tui-extension-settings.ts';
import { TuiConfigManager } from '@/config/host-settings.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = makeProjectTempDir(prefix);
  tempDirs.push(dir);
  return dir;
}

/** The TUI's own config manager over a settings file holding `settings`. */
function configWith(settings: Record<string, unknown>): TuiConfigManager {
  const root = scratch('tui-extension-settings-');
  const configDir = join(root, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings));
  return new TuiConfigManager({ homeDir: root, workingDir: root, configDir, surfaceRoot: 'tui' });
}

const OWN_SECTIONS = ['statusline', 'session', 'checkpoints', 'update'];

describe('TUI settings read through the config manager', () => {
  test('unset keys hold their defaults', () => {
    const config = configWith({});
    expect(readStatuslineSettings(config)).toEqual({ timeoutMs: 2000 });
    expect(readSessionSettings(config)).toEqual({ autoTitle: false });
    expect(readUpdateSettings(config)).toEqual({ autoUpdateAtLaunch: true, launchCheckTimeoutMs: 2500, applyTimeoutMs: 45_000 });
    expect(readCheckpointGuardSettings(config)).toEqual({
      preferGitRoot: true, allowBroadRoot: false, allowLargeFirstSnapshot: false, maxFirstSnapshotFiles: 50_000, autoRetention: true,
    });
  });

  test('values in the settings file apply, and none of them is reported as unknown', () => {
    const config = configWith({
      statusline: { command: '  git branch --show-current  ', timeoutMs: 1500 },
      session: { autoTitle: true },
      update: { autoUpdateAtLaunch: false, launchCheckTimeoutMs: 4000, applyTimeoutMs: 60_000 },
      checkpoints: { preferGitRoot: false, allowBroadRoot: true, allowLargeFirstSnapshot: true, maxFirstSnapshotFiles: 12_000, autoRetention: false },
    });
    expect(readStatuslineSettings(config)).toEqual({ command: 'git branch --show-current', timeoutMs: 1500 });
    expect(readSessionSettings(config)).toEqual({ autoTitle: true });
    expect(readUpdateSettings(config)).toEqual({ autoUpdateAtLaunch: false, launchCheckTimeoutMs: 4000, applyTimeoutMs: 60_000 });
    expect(readCheckpointGuardSettings(config)).toEqual({
      preferGitRoot: false, allowBroadRoot: true, allowLargeFirstSnapshot: true, maxFirstSnapshotFiles: 12_000, autoRetention: false,
    });
    expect(config.getIngestionQuarantine().filter((notice) => OWN_SECTIONS.includes(notice.key.split('.')[0]!))).toEqual([]);
  });

  test('a value of the wrong type or out of range is reported and the default applies', () => {
    const config = configWith({
      statusline: { command: 7, timeoutMs: 50 },
      update: { applyTimeoutMs: 'soon' },
      checkpoints: { maxFirstSnapshotFiles: -5 },
    });
    expect(readStatuslineSettings(config)).toEqual({ timeoutMs: 2000 });
    expect(readUpdateSettings(config).applyTimeoutMs).toBe(45_000);
    expect(readCheckpointGuardSettings(config).maxFirstSnapshotFiles).toBe(50_000);
    const reported = config.getIngestionQuarantine().map((notice) => notice.key);
    for (const key of ['statusline.command', 'statusline.timeoutMs', 'update.applyTimeoutMs', 'checkpoints.maxFirstSnapshotFiles']) {
      expect(reported).toContain(key);
    }
  });

  test('a misspelt key beside a TUI setting is answered with the setting', () => {
    const config = configWith({ statusline: { comand: 'date' } });
    const notice = config.getIngestionQuarantine().find((entry) => entry.key === 'statusline.comand');
    expect(notice?.reason).toContain('statusline.command');
    expect(readStatuslineSettings(config)).toEqual({ timeoutMs: 2000 });
  });
});

// The checkpoints.* values flow through withCheckpointGuardSettings into the
// real WorkspaceCheckpointManager and change its root-guard behavior.
describe('checkpoint root-guard wiring', () => {
  test('allowBroadRoot reaches the manager: false refuses a home-directory root, true permits it', async () => {
    // homeDir === workspaceRoot makes the root look "broad"; the guard then
    // hinges purely on the allowBroadRoot setting.
    const dirRefused = scratch('gv-guard-wiring');
    writeFileSync(join(dirRefused, 'f.txt'), 'hello');
    const refusingMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings({ workspaceRoot: dirRefused, homeDir: dirRefused }, configWith({ checkpoints: { allowBroadRoot: false } })),
    );
    await expect(refusingMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' }))
      .rejects.toThrow(/home directory|refus/i);

    const dirAllowed = scratch('gv-guard-wiring');
    writeFileSync(join(dirAllowed, 'f.txt'), 'hello');
    const allowingMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings({ workspaceRoot: dirAllowed, homeDir: dirAllowed }, configWith({ checkpoints: { allowBroadRoot: true } })),
    );
    const cp = await allowingMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' });
    expect(cp).not.toBeNull();
  });

  test('maxFirstSnapshotFiles + allowLargeFirstSnapshot reach the manager: a tiny ceiling refuses the first snapshot unless the override is set', async () => {
    const dirRefused = scratch('gv-guard-wiring');
    for (let i = 0; i < 5; i++) writeFileSync(join(dirRefused, `f${i}.txt`), 'x');
    const tinyCeilingMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings({ workspaceRoot: dirRefused }, configWith({ checkpoints: { maxFirstSnapshotFiles: 2, allowLargeFirstSnapshot: false } })),
    );
    await expect(tinyCeilingMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' }))
      .rejects.toThrow(/first checkpoint|sweep|refus/i);

    const dirAllowed = scratch('gv-guard-wiring');
    for (let i = 0; i < 5; i++) writeFileSync(join(dirAllowed, `f${i}.txt`), 'x');
    const overrideMgr = new WorkspaceCheckpointManager(
      withCheckpointGuardSettings({ workspaceRoot: dirAllowed }, configWith({ checkpoints: { maxFirstSnapshotFiles: 2, allowLargeFirstSnapshot: true } })),
    );
    const cp = await overrideMgr.create({ kind: 'manual', label: 'x', retentionClass: 'forensic' });
    expect(cp).not.toBeNull();
  });
});
