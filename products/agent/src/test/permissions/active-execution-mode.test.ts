import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate';
import { bindActiveExecutionMode, readExecutionMode, readInitialExecutionMode, setExecutionMode } from '../../permissions/execution-mode.ts';
import { readApprovalPostureFromConfig } from '../../permissions/approval-posture.ts';
import { setHarnessSetting, resetHarnessSetting } from '../../agent/harness-control.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function config() {
  const root = mkdtempSync(join(tmpdir(), 'agent-active-mode-')); roots.push(root);
  const manager = new ConfigManager({ configDir: root, surfaceRoot: 'agent', homeDir: root });
  manager.set('permissions.mode', 'safe-owner');
  return manager;
}

test('local selection changes the real local configuration when no hosted conversation owns it', async () => {
  const manager = config();
  await setExecutionMode(manager, 'safe-jev');
  expect(manager.get('permissions.mode')).toBe('safe-jev');
  expect(readExecutionMode(manager)).toBe('safe-jev');
});

test('hosted selection and harness settings change the actual session owner, leaving defaults untouched', async () => {
  const manager = config();
  let mode: GatePresetName = 'safe-jev';
  const changed: GatePresetName[] = [];
  const unbind = bindActiveExecutionMode(manager, { hostedSessionId: () => 'hosted-one', executionMode: () => mode, setExecutionMode: async next => { changed.push(next); mode = next; } });
  try {
    expect(readApprovalPostureFromConfig(manager).mode).toBe('safe-jev');
    await setHarnessSetting(manager, null, 'permissions.mode', 'yolo');
    expect(changed).toEqual(['yolo']);
    expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'yolo', automaticApprovals: true });
    expect(manager.get('permissions.mode')).toBe('safe-owner');
    await resetHarnessSetting(manager, null, 'permissions.mode');
    expect(changed).toEqual(['yolo', 'safe-owner']);
    expect(manager.get('permissions.mode')).toBe('safe-owner');
  } finally { unbind(); }
});

test('host failures never fall back to changing local default permissions', async () => {
  const manager = config();
  const unbind = bindActiveExecutionMode(manager, { hostedSessionId: () => 'hosted-one', executionMode: () => 'safe-jev', setExecutionMode: async () => { throw new Error('Host refused current session update'); } });
  try {
    await expect(setExecutionMode(manager, 'yolo')).rejects.toThrow('Host refused');
    expect(manager.get('permissions.mode')).toBe('safe-owner');
    expect(readApprovalPostureFromConfig(manager).mode).toBe('safe-jev');
  } finally { unbind(); }
});

test('an unconfirmed hosted mode is displayed as unavailable instead of the local default', () => {
  const manager = config();
  const unbind = bindActiveExecutionMode(manager, { hostedSessionId: () => 'hosted-one', executionMode: () => undefined, setExecutionMode: async () => {} });
  try {
    expect(readExecutionMode(manager)).toBeUndefined();
    expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'unavailable', label: 'Execution mode unavailable', automaticApprovals: false });
  } finally { unbind(); }
});

test('detaching an old binding cannot clear its replacement owner', async () => {
  const manager = config();
  const first = bindActiveExecutionMode(manager, { hostedSessionId: () => 'first', executionMode: () => 'safe-jev', setExecutionMode: async () => {} });
  const second = bindActiveExecutionMode(manager, { hostedSessionId: () => 'second', executionMode: () => 'yolo', setExecutionMode: async () => {} });
  first();
  expect(readExecutionMode(manager)).toBe('yolo');
  second();
  expect(readExecutionMode(manager)).toBe('safe-owner');
});

test('a new hosted session uses the configured initial mode while its intake is pending', async () => {
  const manager = config(); manager.set('permissions.mode', 'safe-jev');
  const unbind = bindActiveExecutionMode(manager, { hostedSessionId: () => null, hasHostedOwner: () => true, executionMode: () => undefined, setExecutionMode: async () => { throw new Error('No session yet'); } });
  try {
    expect(readExecutionMode(manager)).toBeUndefined();
    expect(readInitialExecutionMode(manager)).toBe('safe-jev');
    expect(manager.get('permissions.mode')).toBe('safe-jev');
  } finally { unbind(); }
});
