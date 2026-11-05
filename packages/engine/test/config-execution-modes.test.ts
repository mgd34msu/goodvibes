import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { isEffectiveDangerMode } from '../sdk/src/platform/config/index.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gv-config-execution-mode-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const workingDir = join(root, 'workspace');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(workingDir, { recursive: true });
  const options = { configDir, workingDir, surfaceRoot: 'agent' };
  return { options, settings: join(configDir, 'settings.json'), open: () => new ConfigManager(options) };
}

test('settings expose execution mode and explicit owner restrictions while saved aliases remain readable', () => {
  const { open, settings } = fixture();
  writeFileSync(settings, JSON.stringify({ permissions: { mode: 'prompt', tools: { read: 'deny' } }, behavior: { autoApprove: true } }));
  const manager = open();
  const schema = manager.getSchema();
  expect(manager.getSchema()).toBe(schema);
  const keys = new Set(manager.getSchema().map(setting => setting.key));
  expect(keys.has('permissions.mode')).toBe(true);
  expect(keys.has('behavior.autoApprove')).toBe(false);
  expect(keys.has('permissions.backgroundAgents')).toBe(false);
  expect(keys.has('permissions.tools.exec')).toBe(true);
  expect(keys.has('permissions.tools.read')).toBe(true);
  expect(manager.get('permissions.tools.read')).toBe('deny');
  expect(manager.get('behavior.autoApprove')).toBe(true);
  expect(isEffectiveDangerMode(manager)).toBe(true);
  manager.set('permissions.mode', 'safe-owner');
  expect(manager.getSchema()).toBe(schema);
  expect(isEffectiveDangerMode(manager)).toBe(false);
});

test.each([
  ['prompt', 'safe-owner'], ['normal', 'safe-owner'], ['accept-edits', 'safe-owner'],
  ['custom', 'safe-owner'], ['auto', 'safe-jev'], ['allow-all', 'yolo'],
] as const)('loading saved %s retains its canonical %s behavior without rewriting the file', (stored, expected) => {
  const f = fixture();
  const bytes = JSON.stringify({ permissions: { mode: stored } });
  writeFileSync(f.settings, bytes);
  const manager = f.open();
  expect(manager.get('permissions.mode')).toBe(expected);
  expect(isEffectiveDangerMode(manager)).toBe(expected === 'yolo');
  expect(readFileSync(f.settings, 'utf8')).toBe(bytes);
});

test('invalid explicit mode mutations fail without replacing the selected mode or clearing YOLO', () => {
  const manager = fixture().open();
  manager.set('permissions.mode', 'safe-jev');
  manager.set('behavior.autoApprove', true);
  expect(() => manager.setDynamic('permissions.mode', 'not-an-execution-mode')).toThrow();
  expect(manager.get('permissions.mode')).toBe('safe-jev');
  expect(manager.get('behavior.autoApprove')).toBe(true);
  expect(isEffectiveDangerMode(manager)).toBe(true);
});

test.each(['safe-owner', 'safe-jev'] as const)('selecting %s durably clears the saved legacy auto-approve override', mode => {
  const f = fixture();
  const manager = f.open();
  manager.set('behavior.autoApprove', true);
  manager.set('permissions.mode', mode);
  expect(manager.get('permissions.mode')).toBe(mode);
  expect(manager.get('behavior.autoApprove')).toBe(false);
  expect(isEffectiveDangerMode(manager)).toBe(false);
  const reopened = f.open();
  expect(reopened.get('permissions.mode')).toBe(mode);
  expect(reopened.get('behavior.autoApprove')).toBe(false);
});

test('a runtime safe-mode selection retires the runtime auto-approve override', () => {
  const manager = fixture().open();
  manager.setRuntimeOverride('behavior.autoApprove', true);
  expect(isEffectiveDangerMode(manager)).toBe(true);
  manager.setRuntimeOverride('permissions.mode', 'safe-jev');
  expect(manager.get('permissions.mode')).toBe('safe-jev');
  expect(manager.get('behavior.autoApprove')).toBe(false);
  expect(isEffectiveDangerMode(manager)).toBe(false);
});

test('a project safe-mode selection clears the effective override for that project', () => {
  const f = fixture();
  const manager = f.open();
  manager.set('behavior.autoApprove', true);
  manager.setProjectValue('permissions.mode', 'safe-owner');
  expect(manager.get('permissions.mode')).toBe('safe-owner');
  expect(manager.get('behavior.autoApprove')).toBe(false);
  expect(isEffectiveDangerMode(manager)).toBe(false);
  const reopened = f.open();
  expect(reopened.get('permissions.mode')).toBe('safe-owner');
  expect(reopened.get('behavior.autoApprove')).toBe(false);
});

test('a prepared safe-mode mutation captures its legacy override companion before any effects', () => {
  const manager = fixture().open();
  manager.set('behavior.autoApprove', true);
  const prepared = manager.prepareSettingMutation({ operation: 'set', key: 'permissions.mode', value: 'safe-jev' });
  const facts = manager.inspectPreparedMutation(prepared);
  expect(facts.effects?.map(effect => ({ key: effect.key, value: effect.value }))).toEqual([
    { key: 'permissions.mode', value: 'safe-jev' },
    { key: 'behavior.autoApprove', value: false },
  ]);
  expect(manager.get('behavior.autoApprove')).toBe(true);
  const transition = manager.beginPreparedMutation(prepared);
  const receipt = manager.finishPreparedMutation(prepared, transition);
  expect(receipt.status).toBe('committed');
  expect(manager.get('permissions.mode')).toBe('safe-jev');
  expect(manager.get('behavior.autoApprove')).toBe(false);
  expect(isEffectiveDangerMode(manager)).toBe(false);
});
