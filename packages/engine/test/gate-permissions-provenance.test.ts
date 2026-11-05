// Ported from goodvibes-tui src/test/input/permissions-provenance.test.ts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRuntimeConfigValue } from '@goodvibes-jev/engine/terminal-shell';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { buildPermissionProvenance, renderPermissionProvenance } from '../sdk/src/platform/gate/policy/permissions-provenance.ts';

function findRow(prov: ReturnType<typeof buildPermissionProvenance>, key: string) {
  const row = prov.rows.find((r) => r.key === key);
  if (!row) throw new Error(`missing row ${key}`);
  return row;
}

describe('permission provenance', () => {
  let root = '';
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gv-prov-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('an unset value reports the built-in default and the session mode', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    const prov = buildPermissionProvenance(cm);
    expect(prov.sessionMode).toBe(String(cm.get('permissions.mode')));
    const mode = findRow(prov, 'permissions.mode');
    expect(mode.origin).toBe('built-in default');
    expect(mode.recorded).toBe(true);
    expect(mode.overridden).toBe(false);
  });

  test('a persisted value is attributed to the global config file with its path', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    cm.set('permissions.mode', 'safe-jev'); // set() auto-persists to disk
    const mode = findRow(buildPermissionProvenance(cm), 'permissions.mode');
    expect(mode.value).toBe('safe-jev');
    expect(mode.recorded).toBe(true);
    expect(mode.overridden).toBe(false);
    expect(mode.origin).toContain('config file');
    expect(mode.originPath).toBe(cm.getConfigPath());
  });

  test('a runtime --config override is labelled not-recorded-on-disk, not mis-attributed', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    // Mutates the in-memory config WITHOUT persisting, exactly what CLI --config does.
    applyRuntimeConfigValue(cm as never, 'permissions.mode', 'yolo');
    const mode = findRow(buildPermissionProvenance(cm), 'permissions.mode');
    expect(mode.value).toBe('yolo');
    expect(mode.overridden).toBe(true);
    expect(mode.recorded).toBe(false);
    expect(mode.origin).toContain('not recorded on disk');
    // The recorded on-disk / default value is preserved for the reader.
    expect(mode.recordedValue).not.toBe('yolo');
  });

  test('render traces the execution mode and explicit tool restrictions', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    const text = renderPermissionProvenance(buildPermissionProvenance(cm));
    expect(text).toContain('session mode:');
    expect(text).toContain('Execution mode');
    expect(text).toContain('Tool restriction: exec');
    expect(text).not.toContain('Background-agent mode');
    expect(text).toContain('origin not recorded');
    expect(text).toContain('origin:');
  });

  test('a saved auto-approve alias reports the effective YOLO mode until explicitly changed', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    cm.set('behavior.autoApprove', true);
    const legacy = buildPermissionProvenance(cm);
    expect(legacy.sessionMode).toBe('yolo');
    expect(findRow(legacy, 'behavior.autoApprove').label).toBe('Saved YOLO alias');
    cm.set('permissions.mode', 'safe-owner');
    const selected = buildPermissionProvenance(cm);
    expect(selected.sessionMode).toBe('safe-owner');
    expect(selected.rows.some(row => row.key === 'behavior.autoApprove')).toBe(false);
  });

  test('reads of secrets are described as the gate\'s reading, not a shipped path list', () => {
    const cm = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
    const text = renderPermissionProvenance(buildPermissionProvenance(cm));
    expect(text).toContain('engine.gate.read-secrets');
    expect(text).toContain('YOLO skips execution safety readings');
    expect(text).not.toContain('Shipped policy rules');
  });
});
