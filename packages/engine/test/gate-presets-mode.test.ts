import { describe, expect, test } from 'bun:test';
import {
  decideByPreset, effectivePermissionMode, GATE_PRESETS, GATE_STAKES,
  isPlanMode, nextPermissionMode, normalizePermissionMode, parsePermissionMode,
  PERMISSION_MODE_CYCLE, permissionModeLabel, permissionModeTone, presetForMode,
  SESSION_GATE_PRESET_NAMES, togglePlanMode,
} from '../sdk/src/platform/gate/presets.ts';

describe('shared execution modes', () => {
  test('the execution cycle contains exactly owner safety, Jev safety and YOLO', () => {
    expect([...PERMISSION_MODE_CYCLE]).toEqual(['safe-owner', 'safe-jev', 'yolo']);
    expect(nextPermissionMode('safe-owner')).toBe('safe-jev');
    expect(nextPermissionMode('safe-jev')).toBe('yolo');
    expect(nextPermissionMode('yolo')).toBe('safe-owner');
    expect(SESSION_GATE_PRESET_NAMES).toEqual(['safe-owner', 'safe-jev', 'yolo', 'plan']);
  });

  test.each([undefined, 'nonsense', 'plan'])('cycling from %s starts with owner safety', mode => {
    expect(nextPermissionMode(mode)).toBe('safe-owner');
  });

  test.each([
    ['prompt', 'safe-owner'], ['normal', 'safe-owner'], ['accept-edits', 'safe-owner'],
    ['custom', 'safe-owner'], ['auto', 'safe-jev'], ['allow-all', 'yolo'],
  ] as const)('saved %s selects %s without retaining a separate execution policy', (saved, canonical) => {
    expect(parsePermissionMode(saved)).toBe(canonical);
    expect(normalizePermissionMode(saved)).toBe(canonical);
    expect(presetForMode(saved)).toBe(GATE_PRESETS[canonical]);
    expect(permissionModeLabel(saved)).toBe(canonical);
    expect(nextPermissionMode(saved)).toBe(nextPermissionMode(canonical));
  });

  test('unrecognized mutations remain distinguishable from an absent saved mode', () => {
    expect(parsePermissionMode('ALLOW-ALL')).toBeUndefined();
    expect(parsePermissionMode({ mode: 'yolo' })).toBeUndefined();
    expect(presetForMode(undefined)).toBe(GATE_PRESETS['safe-owner']);
    expect(presetForMode('nonsense')).toBe(GATE_PRESETS['safe-owner']);
  });

  test('legacy auto-approve is an effective YOLO alias', () => {
    expect(effectivePermissionMode('safe-owner', true)).toBe('yolo');
    expect(effectivePermissionMode('safe-jev', true)).toBe('yolo');
    expect(effectivePermissionMode('safe-owner', false)).toBe('safe-owner');
  });

  test('every canonical preset selects itself and carries the same mode', () => {
    for (const preset of Object.values(GATE_PRESETS)) {
      expect(preset.mode).toBe(preset.name);
      expect(presetForMode(preset.mode)).toBe(preset);
    }
  });

  test('mode colors distinguish planning and unconstrained execution', () => {
    expect(permissionModeTone('safe-owner')).toBe('neutral');
    expect(permissionModeTone('safe-jev')).toBe('caution');
    expect(permissionModeTone('yolo')).toBe('caution');
    expect(permissionModeTone('plan')).toBe('info');
  });

  test('planning is a separate read-only posture with a return to owner safety', () => {
    expect(isPlanMode('plan')).toBe(true);
    for (const mode of PERMISSION_MODE_CYCLE) {
      expect(isPlanMode(mode)).toBe(false);
      expect(togglePlanMode(mode)).toBe('plan');
    }
    expect(togglePlanMode('plan')).toBe('safe-owner');
  });
});

describe('execution stakes policy', () => {
  test.each(['safe-owner', 'safe-jev'] as const)('%s permits ordinary writes, commands and network effects', mode => {
    for (const stakes of ['low', 'medium', 'high'] as const) {
      for (const family of ['generic', 'file-mutation', 'network-egress'] as const) {
        expect(decideByPreset(GATE_PRESETS[mode], { stakes, family, changesState: true }))
          .toEqual({ action: 'allow', reason: 'stakes' });
      }
    }
    expect(decideByPreset(GATE_PRESETS[mode], { stakes: 'critical', family: 'generic', changesState: true }))
      .toEqual({ action: 'ask', reason: 'stakes' });
  });

  test('YOLO never asks or denies at any stakes level', () => {
    for (const stakes of GATE_STAKES) {
      expect(decideByPreset(GATE_PRESETS.yolo, { stakes, family: 'shell-destructive', changesState: true }))
        .toEqual({ action: 'allow', reason: 'stakes' });
    }
  });

  test('planning refuses every state-changing action even at low stakes', () => {
    for (const stakes of GATE_STAKES) {
      expect(decideByPreset(GATE_PRESETS.plan, { stakes, family: 'generic', changesState: true }))
        .toEqual({ action: 'deny', reason: 'plan-read-only' });
    }
    expect(decideByPreset(GATE_PRESETS.plan, { stakes: 'low', family: 'generic', changesState: false }).action)
      .toBe('allow');
  });
});
