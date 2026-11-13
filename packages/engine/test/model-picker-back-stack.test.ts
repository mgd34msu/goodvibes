/**
 * model-picker-back-stack.test.ts, Esc pops exactly one level of the picker.
 *
 * providers -> models -> effort used to keep a one-slot back pointer that the
 * effort step overwrote, so the second Esc closed the picker instead of
 * returning to the provider list.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelDefinition } from '@goodvibes-jev/engine/platform/platform/providers';
import { reasoningEffortSpecFromLevels } from '@goodvibes-jev/engine/platform/platform/providers';
import { ModelPickerModal } from '@goodvibes-jev/engine/terminal-shell/model-picker';
import { createModelPickerTokenHandler } from '@goodvibes-jev/engine/terminal-shell/model-picker-token-route';

const MODEL: ModelDefinition = {
  id: 'm1',
  provider: 'provA',
  registryKey: 'provA:m1',
  displayName: 'M1',
  description: '',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: true, multimodal: false },
  contextWindow: 8192,
  selectable: true,
  tier: 'free',
  reasoningEffort: reasoningEffortSpecFromLevels(['low', 'medium', 'high']),
};

function makePicker(): ModelPickerModal {
  return new ModelPickerModal(
    { getRecentModels: () => [] } as never,
    { getBenchmarks: () => [] } as never,
    { getSyntheticModelInfoFromCatalog: () => [] } as never,
  );
}

const handler = createModelPickerTokenHandler({
  chromeLines: 4,
  validateContextCap: false,
  extraControls: false,
  commitBeforeClose: true,
  commit: () => {},
});

function harness() {
  const picker = makePicker();
  let escapes = 0;
  const state = {
    modelPicker: picker,
    modalStack: ['modelPicker'],
    getViewportHeight: () => 24,
    requestRender: () => {},
    handleEscape: () => { escapes++; picker.close(); },
  };
  const esc = () => handler(state as never, { type: 'key', logicalName: 'escape' } as never);
  return { picker, esc, escapes: () => escapes };
}

describe('model picker Esc pops one level', () => {
  test('providers -> models -> effort -> Esc -> Esc returns to providers, third Esc closes', () => {
    const { picker, esc, escapes } = harness();
    picker.openProviders(['provA'], 'provA');
    picker.showModelsForProvider([MODEL], 'provA');
    picker.showEffortPicker(MODEL, 'medium');
    expect(picker.mode).toBe('effort');

    esc();
    expect(picker.mode).toBe('model');
    expect(picker.pendingModel).toBeNull();
    expect(picker.effortPresentation).toBeNull();

    esc();
    expect(picker.mode).toBe('provider');
    expect(picker.active).toBe(true);
    expect(escapes()).toBe(0);

    esc();
    expect(escapes()).toBe(1);
    expect(picker.active).toBe(false);
  });

  test('providers -> models -> context cap -> Esc -> Esc returns to providers', () => {
    const { picker, esc } = harness();
    picker.openProviders(['provA'], 'provA');
    picker.showModelsForProvider([MODEL], 'provA');
    picker.enterContextCapMode(MODEL);
    esc();
    expect(picker.mode).toBe('model');
    esc();
    expect(picker.mode).toBe('provider');
  });

  test('model-first open: effort -> Esc -> model -> Esc closes', () => {
    const { picker, esc, escapes } = harness();
    picker.openAllModels([MODEL], 'm1');
    picker.showEffortPicker(MODEL, 'medium');
    esc();
    expect(picker.mode).toBe('model');
    esc();
    expect(escapes()).toBe(1);
  });

  test('a stale path does not survive close and reopen', () => {
    const { picker, esc, escapes } = harness();
    picker.openProviders(['provA'], 'provA');
    picker.showModelsForProvider([MODEL], 'provA');
    picker.close();
    picker.openAllModels([MODEL], 'm1');
    esc();
    expect(escapes()).toBe(1);
  });

  test('previousMode stays readable', () => {
    const picker = makePicker();
    picker.enterContextCapMode(MODEL);
    expect(picker.previousMode).toBe('model');
  });
});
