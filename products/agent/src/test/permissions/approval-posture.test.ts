import { expect, test } from 'bun:test';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GATE_PRESETS, normalizePermissionMode } from '@goodvibes-jev/engine/platform/platform/gate';
import { computeApprovalPosture, readApprovalPostureFromConfig } from '../../permissions/approval-posture.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

test('all execution modes report the authoritative preset label and behavior', () => {
  for (const preset of Object.values(GATE_PRESETS)) {
    const posture = computeApprovalPosture({ mode: preset.mode, autoApprove: false });
    expect(posture).toEqual({
      kind: preset.name, mode: preset.name, autoApprove: false,
      automaticApprovals: preset.name === 'yolo',
      bypassesPrompts: preset.name === 'yolo' || preset.name === 'safe-jev',
      label: preset.label, detail: preset.summary,
    });
  }
});

test.each(['prompt', 'normal', 'accept-edits', 'custom', 'auto', 'allow-all'])(
  'saved %s mode uses the shared canonical interpretation', mode => {
    const canonical = normalizePermissionMode(mode);
    expect(computeApprovalPosture({ mode, autoApprove: false })).toEqual(
      computeApprovalPosture({ mode: canonical, autoApprove: false }));
  });

test('legacy auto-approve reports the effective YOLO mode instead of the underlying safe mode', () => {
  const posture = computeApprovalPosture({ mode: 'safe-owner', autoApprove: true });
  expect(posture).toMatchObject({ mode: 'yolo', kind: 'yolo', automaticApprovals: true, bypassesPrompts: true });
  expect(posture.detail).toBe(GATE_PRESETS.yolo.summary);
});

test('config-backed posture reflects live mode changes', () => {
  const manager = new ConfigManager({ surfaceRoot: 'tui', configDir: makeProjectTempDir('execution-posture') });
  manager.set('permissions.mode', 'safe-jev');
  expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'safe-jev', bypassesPrompts: true, automaticApprovals: false });
  manager.set('permissions.mode', 'yolo');
  expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'yolo', automaticApprovals: true });
  manager.set('permissions.mode', 'safe-owner');
  expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'safe-owner', bypassesPrompts: false, automaticApprovals: false });
});

test('choosing a safe mode replaces the legacy automatic-approval override', () => {
  const manager = new ConfigManager({ surfaceRoot: 'tui', configDir: makeProjectTempDir('execution-posture-choice') });
  manager.set('behavior.autoApprove', true);
  expect(readApprovalPostureFromConfig(manager).mode).toBe('yolo');
  manager.set('permissions.mode', 'safe-owner');
  expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'safe-owner', autoApprove: false, bypassesPrompts: false });
  manager.set('behavior.autoApprove', true);
  manager.set('permissions.mode', 'safe-jev');
  expect(readApprovalPostureFromConfig(manager)).toMatchObject({ mode: 'safe-jev', autoApprove: false, bypassesPrompts: true });
});
