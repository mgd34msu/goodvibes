/**
 * profiles-shape-and-names.test.ts
 *
 * What a profile may carry between hosts, and how a profile name maps to the
 * stored one.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileManager } from '../platform/src/platform/profiles/manager.js';
import { configSnapshotToProfileData, profileDataToConfigSnapshot } from '../platform/src/platform/profiles/shape.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

describe('profile shape', () => {
  test('approval and routing settings are never copied into a profile', () => {
    const data = configSnapshotToProfileData({
      'behavior.autoApprove': true,
      'behavior.hitlMode': 'off',
      'provider.systemPromptFile': '/tmp/prompt.md',
      'provider.decisionRouter': { enabled: true },
      'display.stream': false,
    }) as Record<string, Record<string, unknown>>;
    expect(data['display']).toEqual({ stream: false });
    expect(data['behavior']).toBeUndefined();
    expect(data['provider']).toBeUndefined();
  });

  test('a profile file that carries them (or a wrong-typed value) does not put them back', () => {
    const snapshot = profileDataToConfigSnapshot({
      behavior: { autoApprove: true, hitlMode: 'off', saveHistory: 'yes' },
      display: { stream: false, theme: 'not-a-theme' },
    } as never);
    expect(snapshot).toEqual({ 'display.stream': false });
  });
});

describe('ProfileManager names', () => {
  let dir: string;
  let manager: ProfileManager;
  beforeEach(() => {
    dir = makeProjectTempDir('gv-profile-names');
    manager = new ProfileManager(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('names that differ only in case and spacing are one profile', () => {
    manager.save('Work Laptop', {});
    manager.save('work-laptop', {});
    expect(manager.list().map((profile) => profile.name)).toEqual(['work-laptop']);
  });

  test('a name of which nothing can be stored is refused instead of overwriting the fallback profile', () => {
    manager.save('profile', { display: { stream: false } });
    expect(() => manager.save('!!!', {})).toThrow();
    expect(manager.load('profile').data.display?.stream).toBe(false);
  });

  test('a hand-placed file under a name that load() cannot address is not listed', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'My Profile.json'), JSON.stringify({ timestamp: 1 }));
    manager.save('real', {});
    expect(manager.list().map((profile) => profile.name)).toEqual(['real']);
  });

  test('a profile that cannot be removed throws instead of reporting "not found"', () => {
    manager.save('stuck', {});
    chmodSync(dir, 0o500);
    try {
      // Skipped when running as a user the directory mode does not bind (root).
      if (process.getuid?.() === 0) return;
      expect(() => manager.delete('stuck')).toThrow('Failed to delete profile');
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(manager.delete('nonexistent')).toBe(false);
  });
});
