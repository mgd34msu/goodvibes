import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '../platform/src/platform/config/index.ts';
import {
  applySettingsSyncBundle, applyStagedManagedBundle, getSettingsControlPlaneSnapshot,
  inspectManagedSettingsBundle, isManagedSettingLocked, recordSettingsSyncEvent,
  rollbackManagedApply, setManagedSettingLock, stageManagedSettingsBundle,
} from '../platform/src/platform/runtime/settings.ts';
import type { ManagedSettingsBundle } from '../platform/src/platform/runtime/sandbox/types.ts';

const roots: string[] = [];
let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(fakePort((name: string, question: Question, _state: EntryType) => choiceAnswer(question, 'low', 0.95)).port);
});
afterEach(() => {
  installJudgmentPort(previousPort);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-control-plane-'));
  roots.push(root);
  const workingDir = join(root, 'project');
  mkdirSync(workingDir);
  const configDir = join(root, 'config');
  const config = new ConfigManager({ configDir, workingDir, surfaceRoot: 'agent', hostSettings: [] });
  return { config, configDir };
}
const bundle = (settings: Record<string, unknown>, profileName = 'team'): ManagedSettingsBundle => ({ version: 1, exportedAt: 0, profileName, settings });

describe('managed bundle staging', () => {
  test('refuses a bundle with an unsupported version or without settings, naming the problem', async () => {
    const { config } = fixture();
    await expect(stageManagedSettingsBundle(config, { ...bundle({}), version: 2 } as unknown as ManagedSettingsBundle, 'b.json')).rejects.toThrow('version 2');
    await expect(stageManagedSettingsBundle(config, {} as ManagedSettingsBundle, 'b.json')).rejects.toThrow('version');
    await expect(stageManagedSettingsBundle(config, { version: 1, profileName: 'x' } as unknown as ManagedSettingsBundle, 'b.json')).rejects.toThrow('settings must be an object');
    expect(getSettingsControlPlaneSnapshot(config).stagedManagedBundle).toBeUndefined();
  });

  test('lists keys it does not manage instead of dropping them silently', async () => {
    const { config } = fixture();
    const stage = await stageManagedSettingsBundle(config, bundle({ 'future.key': 1, 'conversationGate.mode': 'off' }), 'b.json');
    expect(stage.ignoredKeys).toEqual(['future.key']);
    expect(stage.changes.map((change) => change.key)).toEqual(['conversationGate.mode']);
  });

  test('inspecting a bundle leaves the staged bundle alone', async () => {
    const { config } = fixture();
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'off' }, 'first'), 'a.json');
    const review = await inspectManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'confirm-all' }, 'second'), 'b.json');
    expect(review).toContain('second');
    expect(getSettingsControlPlaneSnapshot(config).stagedManagedBundle).toMatchObject({ path: 'a.json', profileName: 'first' });
  });
});

describe('managed apply and rollback', () => {
  test('rolling back a bundle of unchanged values releases the locks it created', async () => {
    const { config, configDir } = fixture();
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'propose' }), 'b.json');
    const applied = await applyStagedManagedBundle(config);
    expect(applied.appliedCount).toBe(0);
    expect(isManagedSettingLocked('conversationGate.mode', configDir)).toBe(true);
    rollbackManagedApply(config, applied.rollbackToken);
    expect(isManagedSettingLocked('conversationGate.mode', configDir)).toBe(false);
  });

  test('a rollback restores the value in effect at apply time and works once', async () => {
    const { config } = fixture();
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'off' }), 'b.json');
    config.set('conversationGate.mode', 'confirm-all');
    const applied = await applyStagedManagedBundle(config);
    expect(config.get('conversationGate.mode')).toBe('off');
    rollbackManagedApply(config, applied.rollbackToken);
    expect(config.get('conversationGate.mode')).toBe('confirm-all');
    config.set('conversationGate.mode', 'propose');
    expect(() => rollbackManagedApply(config, applied.rollbackToken)).toThrow('Unknown managed rollback token');
    expect(config.get('conversationGate.mode')).toBe('propose');
    expect(getSettingsControlPlaneSnapshot(config).rollbackHistory).toEqual([]);
  });

  test('rolling back the second bundle on a key puts the first bundle back in force', async () => {
    const { config, configDir } = fixture();
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'off' }, 'a'), 'a.json');
    await applyStagedManagedBundle(config);
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'confirm-all' }, 'b'), 'b.json');
    const second = await applyStagedManagedBundle(config);
    rollbackManagedApply(config, second.rollbackToken);
    expect(config.get('conversationGate.mode')).toBe('off');
    expect(isManagedSettingLocked('conversationGate.mode', configDir)).toBe(true);
    expect(getSettingsControlPlaneSnapshot(config).resolvedEntries.find((entry) => entry.key === 'conversationGate.mode')).toMatchObject({ effectiveSource: 'managed', effectiveValue: 'off' });
  });

  test('rolling back an earlier apply while a later one covers the same key is refused and changes nothing', async () => {
    const { config, configDir } = fixture();
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'off' }, 'a'), 'a.json');
    const first = await applyStagedManagedBundle(config);
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'confirm-all' }, 'b'), 'b.json');
    const second = await applyStagedManagedBundle(config);
    expect(() => rollbackManagedApply(config, first.rollbackToken)).toThrow(`Roll back ${second.rollbackToken} first`);
    expect(config.get('conversationGate.mode')).toBe('confirm-all');
    expect(getSettingsControlPlaneSnapshot(config).rollbackHistory).toHaveLength(2);
    rollbackManagedApply(config, second.rollbackToken);
    rollbackManagedApply(config, first.rollbackToken);
    expect(config.get('conversationGate.mode')).toBe('propose');
    expect(isManagedSettingLocked('conversationGate.mode', configDir)).toBe(false);
  });

  test('a bundle with one invalid value changes nothing', async () => {
    const { config } = fixture();
    config.set('display.showThinking', true);
    const staged = await stageManagedSettingsBundle(config, bundle({ 'display.showThinking': false, 'conversationGate.mode': 'nonsense' }), 'b.json');
    expect(staged.changes).toHaveLength(2);
    await expect(applyStagedManagedBundle(config)).rejects.toThrow('conversationGate.mode');
    expect(config.get('display.showThinking')).toBe(true);
    expect(getSettingsControlPlaneSnapshot(config).rollbackHistory).toEqual([]);
  });

  test('a lock written while the apply waits is kept', async () => {
    const { config, configDir } = fixture();
    await stageManagedSettingsBundle(config, bundle({ 'conversationGate.mode': 'off', 'display.showThinking': false }), 'b.json');
    const pending = applyStagedManagedBundle(config, ['conversationGate.mode']);
    setManagedSettingLock('conversationGate.proposalTtlMs', 'ops', 'held', configDir);
    await pending;
    expect(isManagedSettingLocked('conversationGate.proposalTtlMs', configDir)).toBe(true);
    expect(isManagedSettingLocked('conversationGate.mode', configDir)).toBe(true);
  });
});

describe('settings sync pull', () => {
  test('a managed lock outranks a pulled value, and the skip is reported', () => {
    const { config, configDir } = fixture();
    setManagedSettingLock('conversationGate.mode', 'ops', 'policy', configDir);
    const result = applySettingsSyncBundle(config, {
      version: 1, exportedAt: 0, source: 'settings-sync',
      settings: { 'conversationGate.mode': 'off', 'display.showThinking': false },
    }, 'pull.json');
    expect(config.get('conversationGate.mode')).toBe('propose');
    expect(config.get('display.showThinking')).toBe(false);
    expect(result.skippedLockedKeys).toEqual(['conversationGate.mode']);
  });

  test('a bundle with one invalid value changes nothing', () => {
    const { config } = fixture();
    config.set('display.showThinking', true);
    expect(() => applySettingsSyncBundle(config, {
      version: 1, exportedAt: 0, source: 'settings-sync',
      settings: { 'display.showThinking': false, 'conversationGate.mode': 'nonsense' },
    }, 'pull.json')).toThrow('conversationGate.mode');
    expect(config.get('display.showThinking')).toBe(true);
  });
});

describe('control-plane store writes', () => {
  test('an unreadable store is refused rather than overwritten, so locks survive', () => {
    const { configDir } = fixture();
    setManagedSettingLock('conversationGate.mode', 'ops', 'policy', configDir);
    const file = join(configDir, 'settings-sync.json');
    chmodSync(file, 0);
    try {
      expect(() => recordSettingsSyncEvent({ surface: 'managed', direction: 'apply', path: 'x', timestamp: 1, detail: 'x' }, configDir)).toThrow('could not be read');
      expect(() => setManagedSettingLock('display.showThinking', 'ops', 'policy', configDir)).toThrow('could not be read');
    } finally { chmodSync(file, 0o600); }
    expect(isManagedSettingLocked('conversationGate.mode', configDir)).toBe(true);
    expect(isManagedSettingLocked('display.showThinking', configDir)).toBe(false);
  });

  test('a setting change is refused while the lock store is unreadable, then refused as locked once readable', () => {
    const { config, configDir } = fixture();
    setManagedSettingLock('conversationGate.mode', 'ops', 'policy', configDir);
    const file = join(configDir, 'settings-sync.json');
    chmodSync(file, 0);
    try {
      expect(() => config.set('conversationGate.mode', 'off')).toThrow('could not be read');
    } finally { chmodSync(file, 0o600); }
    expect(() => config.set('conversationGate.mode', 'off')).toThrow('locked by ops');
    expect(config.get('conversationGate.mode')).toBe('propose');
  });
});
