/**
 * A modal that closes itself (the file picker on a pick, the block actions
 * menu on an action key) leaves the modal stack as it found it, so the next
 * Esc reaches the prompt instead of popping a modal that is no longer shown.
 */
import { expect, test } from 'bun:test';
import { handleBlockActionsToken, handleFilePickerToken } from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';
import { handleEscape, modalOpened, pruneStaleModalStack, type EscapeState } from '@goodvibes-jev/engine/terminal-shell/modal-stack';

function flag(active = false) {
  return { active, close() { this.active = false; }, open() { this.active = true; }, reopen() { this.active = true; } };
}

function escapeState(modalStack: string[], prompt: string): EscapeState {
  return {
    helpOverlayActive: false, shortcutsOverlayActive: false, bookmarkModal: flag(),
    settingsModal: { ...flag(), editingMode: false, cancelEdit() {} },
    sessionPickerModal: flag(), profilePickerModal: flag(), contextInspectorModal: flag(), modelPicker: flag(),
    filePicker: flag(), blockActionsMenu: flag(), selectionModal: flag(), commandMode: false,
    modalStack, modalReturnFocus: 'prompt', indicatorFocused: false, prompt, cursorPos: prompt.length,
    helpScrollOffset: 0, shortcutsScrollOffset: 0, requestRender() {}, saveUndoState() {},
    cancelGeneration: undefined, selectionCallback: null, autocompleteReset() {},
  } as unknown as EscapeState;
}

test('a file pick closes the picker and the next Esc clears the prompt', () => {
  const modalStack: string[] = [];
  const picker = { ...flag(true), query: '', searchFocused: false, insertPos: 0, injectMode: false, setQuery() {}, focusSearch() {}, blurSearch() {},
    getSelected: () => 'src/a.ts', selectedIndex: 0, moveUp() {}, moveDown() {} };
  modalOpened({ ...escapeState(modalStack, ''), filePicker: picker } as unknown as EscapeState, 'filePicker');
  expect(modalStack).toEqual(['filePicker']);
  const route = {
    filePicker: picker, prompt: '@', cursorPos: 1, modalStack, imageRegistry: new Map(), nextImageId: 1,
    requestRender() {}, handleEscape() {}, saveUndoState() {}, ensureInputCursorVisible() {},
    formatFileSize: String, mediaTypeFromExt: () => 'image/png', imageExtensions: ['.png'],
  };
  handleFilePickerToken(route, { type: 'key', logicalName: 'enter' } as never);
  expect(picker.active).toBe(false);
  expect(modalStack).toEqual([]);
  expect(handleEscape(escapeState(modalStack, route.prompt)).prompt).toBe('');
});

test('an action key closes the block actions menu without leaving its stack entry', () => {
  const modalStack = ['blockActions'];
  const executed: string[] = [];
  const menu = { ...flag(true), moveUp() {}, moveDown() {}, getSelected: () => ({ id: 'copy' }), getActionForKey: () => ({ id: 'copy' }) };
  handleBlockActionsToken({ blockActionsMenu: menu, executeBlockAction: (id) => { executed.push(id); }, modalStack, requestRender() {}, handleEscape() {} },
    { type: 'text', value: 'c' } as never);
  expect(executed).toEqual(['copy']);
  expect(modalStack).toEqual([]);
});

test('a stale stack name from any self-closed modal does not swallow the next Esc', () => {
  const modalStack = ['sessionPicker'];
  const state = escapeState(modalStack, 'typed text');
  expect(handleEscape(state).prompt).toBe('');
  expect(modalStack).toEqual([]);
});

test('a name below a modal that is still on screen stays stacked', () => {
  const modalStack = ['settings', 'sessionPicker'];
  const state = escapeState(modalStack, '');
  (state as unknown as { sessionPickerModal: { active: boolean } }).sessionPickerModal.active = true;
  pruneStaleModalStack(state);
  expect(modalStack).toEqual(['settings', 'sessionPicker']);
});
