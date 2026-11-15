import { expect, spyOn, test } from 'bun:test';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { ignoredCheckpointSettingKeys, readCheckpointGuardSettings } from '../../config/checkpoint-settings.ts';

test('a mistyped value, a bad ceiling and a misspelt key are each named; valid entries are not', () => {
  expect(ignoredCheckpointSettingKeys({
    preferGitRoot: 'false', allowBroadRoot: true, maxFirstSnapshotFiles: 0, autoRetention: false,
    unregisteredWorkspaces: 'Guarded', allowBroadRoots: true,
  })).toEqual(['preferGitRoot', 'maxFirstSnapshotFiles', 'unregisteredWorkspaces', 'allowBroadRoots']);
});

test('a fully valid block reports nothing', () => {
  expect(ignoredCheckpointSettingKeys({ preferGitRoot: true, maxFirstSnapshotFiles: 10, unregisteredWorkspaces: 'guarded' })).toEqual([]);
});

test('reading the settings logs the names of ignored entries and never their values', () => {
  const warnings: unknown[][] = [];
  const spy = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
  try {
    const settings = readCheckpointGuardSettings({ getRaw: () => ({ checkpoints: { preferGitRoot: 'SECRET_VALUE', autoRetention: false } }) } as never);
    expect(settings).toEqual({ autoRetention: false });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[1]).toEqual({ keys: ['preferGitRoot'] });
    expect(JSON.stringify(warnings)).not.toContain('SECRET_VALUE');
  } finally { spy.mockRestore(); }
});

test('reading a valid block logs nothing', () => {
  const warnings: unknown[][] = [];
  const spy = spyOn(logger, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
  try {
    readCheckpointGuardSettings({ getRaw: () => ({ checkpoints: { preferGitRoot: true, unregisteredWorkspaces: 'guarded' } }) } as never);
    expect(warnings).toEqual([]);
  } finally { spy.mockRestore(); }
});
