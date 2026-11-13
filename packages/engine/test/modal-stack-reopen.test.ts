/**
 * modal-stack-reopen.test.ts, popping the modal stack never ends as a silent no-op.
 *
 * Esc closes the top modal and returns to the one beneath. A name that cannot
 * be reopened and is no longer on screen used to stay on the stack with focus
 * never restored; it is now dropped and the next entry tried.
 */
import { describe, expect, test } from 'bun:test';
import {
  MODAL_NAMES,
  closeModalByName,
  getActiveModalName,
  isModalActive,
  reopenModalByName,
  type ModalCloseOps,
  type ModalOpenOps,
} from '@goodvibes-jev/engine/terminal-shell/modal-state';
import { handleEscape, modalOpened, type EscapeState } from '@goodvibes-jev/engine/terminal-shell/modal-stack';

function flag(active = false) {
  return { active, close() { this.active = false; }, open() { this.active = true; }, reopen() { this.active = true; } };
}

function makeState(overrides: Record<string, unknown> = {}): EscapeState {
  return {
    helpOverlayActive: false,
    shortcutsOverlayActive: false,
    bookmarkModal: flag(),
    settingsModal: { ...flag(), editingMode: false, cancelEdit() {} },
    sessionPickerModal: flag(),
    profilePickerModal: flag(),
    contextInspectorModal: flag(),
    modelPicker: flag(),
    filePicker: flag(),
    blockActionsMenu: flag(),
    selectionModal: flag(),
    commandMode: false,
    modalStack: [],
    modalReturnFocus: 'prompt',
    indicatorFocused: false,
    prompt: '',
    cursorPos: 0,
    helpScrollOffset: 0,
    shortcutsScrollOffset: 0,
    requestRender() {},
    saveUndoState() {},
    cancelGeneration: undefined,
    selectionCallback: null,
    autocompleteReset() {},
    ...overrides,
  } as unknown as EscapeState;
}

describe('popping the modal stack', () => {
  test('a non-reopenable modal that is no longer active is dropped and focus is restored', () => {
    const state = makeState({ modalReturnFocus: 'indicator', modalStack: ['settings', 'modelPicker'] });
    state.modelPicker.active = true;
    const result = handleEscape(state);
    expect(state.modelPicker.active).toBe(false);
    expect(state.modalStack).toEqual([]);
    expect(result.indicatorFocused).toBe(true);
    expect(result.modalReturnFocus).toBe('prompt');
  });

  test('a non-reopenable modal still on screen stays on the stack', () => {
    const state = makeState({ modalStack: ['settings', 'modelPicker'] });
    state.modelPicker.active = true;
    state.settingsModal.active = true;
    handleEscape(state);
    expect(state.modalStack).toEqual(['settings']);
    expect(state.settingsModal.active).toBe(true);
  });

  test('a dropped entry does not hide a reopenable one beneath it', () => {
    const state = makeState({ modalStack: ['help', 'filePicker', 'modelPicker'] });
    state.modelPicker.active = true;
    const result = handleEscape(state);
    expect(result.helpOverlayActive).toBe(true);
    expect(state.modalStack).toEqual(['help']);
  });

  test('an optional modal that is absent cannot be reopened and is dropped', () => {
    const state = makeState({ modalStack: ['process', 'modelPicker'] });
    state.modelPicker.active = true;
    handleEscape(state);
    expect(state.modalStack).toEqual([]);
  });

  test('a name outside the declared list is not stacked', () => {
    const state = makeState();
    modalOpened(state, 'not-a-modal');
    expect(state.modalStack).toEqual([]);
    state.helpOverlayActive = true;
    modalOpened(state, 'help');
    expect(state.modalStack).toEqual(['help']);
  });
});

describe('modal name table', () => {
  const closeOps: ModalCloseOps = new Proxy({} as ModalCloseOps, { get: () => () => {} });
  const openOps: ModalOpenOps = new Proxy({} as ModalOpenOps, { get: () => () => {} });

  test('every declared name is handled by close, reopen and the active ladder', () => {
    const state = makeState();
    for (const name of MODAL_NAMES) {
      expect(() => closeModalByName(name, closeOps)).not.toThrow();
      expect(typeof reopenModalByName(name, openOps)).toBe('boolean');
      expect(isModalActive(state, name)).toBe(false);
    }
    expect(getActiveModalName(state)).toBeNull();
  });

  test('exactly the data-bound modals report that they cannot be reopened', () => {
    const cannot: string[] = MODAL_NAMES.filter((name) => !reopenModalByName(name, openOps)).sort();
    expect(cannot).toEqual(
      ['blockActions', 'filePicker', 'liveTail', 'modelPicker', 'profilePicker', 'selection', 'sessionPicker', 'settings'].sort(),
    );
  });

  test('the active ladder keeps its screen order', () => {
    const state = makeState({ helpOverlayActive: true });
    state.modelPicker.active = true;
    expect(getActiveModalName(state)).toBe('help');
    state.helpOverlayActive = false;
    expect(getActiveModalName(state)).toBe('modelPicker');
  });
});
