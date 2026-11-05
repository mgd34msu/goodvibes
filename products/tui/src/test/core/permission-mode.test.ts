import { describe, expect, test } from 'bun:test';
import {
  PERMISSION_MODE_CYCLE,
  nextPermissionMode,
  permissionModeLabel,
  permissionModeTone,
  isPlanMode,
  togglePlanMode,
} from '../../core/permission-mode.ts';

describe('permission-mode', () => {
  test('cycles the three execution modes with planning kept separate', () => {
    expect([...PERMISSION_MODE_CYCLE]).toEqual(['safe-owner', 'safe-jev', 'yolo']);
    expect(nextPermissionMode('safe-owner')).toBe('safe-jev');
    expect(nextPermissionMode('safe-jev')).toBe('yolo');
    expect(nextPermissionMode('yolo')).toBe('safe-owner');
    expect(nextPermissionMode('plan')).toBe('safe-owner');
  });

  test('decodes stored aliases before cycling, while unknown starts at safe owner', () => {
    expect(nextPermissionMode('prompt')).toBe('safe-jev');
    expect(nextPermissionMode('custom')).toBe('safe-jev');
    expect(nextPermissionMode('allow-all')).toBe('safe-owner');
    expect(nextPermissionMode(undefined)).toBe('safe-owner');
    expect(nextPermissionMode('nonsense')).toBe('safe-owner');
  });

  test('labels map config values to user-facing names', () => {
    expect(permissionModeLabel('safe-owner')).toBe('safe-owner');
    expect(permissionModeLabel('safe-jev')).toBe('safe-jev');
    expect(permissionModeLabel('yolo')).toBe('yolo');
    expect(permissionModeLabel('prompt')).toBe('safe-owner');
    expect(permissionModeLabel('allow-all')).toBe('yolo');
    expect(permissionModeLabel('plan')).toBe('plan');
    expect(permissionModeLabel('accept-edits')).toBe('safe-owner');
    expect(permissionModeLabel('custom')).toBe('safe-owner');
    expect(permissionModeLabel(undefined)).toBe('safe-owner');
  });

  test('tones: safe owner neutral, plan info, autonomous modes caution', () => {
    expect(permissionModeTone('safe-owner')).toBe('neutral');
    expect(permissionModeTone('safe-jev')).toBe('caution');
    expect(permissionModeTone('yolo')).toBe('caution');
    expect(permissionModeTone('prompt')).toBe('neutral');
    expect(permissionModeTone('plan')).toBe('info');
    expect(permissionModeTone('accept-edits')).toBe('neutral');
    expect(permissionModeTone('allow-all')).toBe('caution');
    expect(permissionModeTone('custom')).toBe('neutral');
  });

  test('planning toggles separately and returns to safe owner', () => {
    expect(isPlanMode('plan')).toBe(true);
    expect(isPlanMode('prompt')).toBe(false);
    expect(togglePlanMode('prompt')).toBe('plan');
    expect(togglePlanMode('accept-edits')).toBe('plan');
    expect(togglePlanMode('allow-all')).toBe('plan');
    expect(togglePlanMode('plan')).toBe('safe-owner');
  });
});
