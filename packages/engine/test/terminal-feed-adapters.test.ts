import { expect, test } from 'bun:test';
import { captureModalFeedState, capturePromptKeyState, refreshCommandAutocomplete } from '../terminal-shell/src/input-feed-adapters.js';
import { withModalState } from '../terminal-shell/src/modal-input-routes.js';
import { InfiniteBuffer } from '../terminal-shell/src/conversation-history.js';
import type { SelectionResult } from '../terminal-shell/src/selection-modal.js';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { BlockMeta } from '../terminal-shell/src/terminal-conversation.js';

const key: InputToken = { type: 'key', name: 'f', logicalName: 'f', ctrl: true, shift: false, meta: false };
function modalSource() {
  const controller = { active: false }, callbacks: string[] = [], imageRegistry = new Map<string, { data: string; mediaType: string }>();
  const source = { conversationManager: controller, selectionModal: controller, bookmarkModal: controller, settingsModal: controller,
    mcpWorkspace: controller, sessionPickerModal: controller, profilePickerModal: controller, helpOverlayActive: false,
    helpScrollOffset: 0, shortcutsOverlayActive: false, shortcutsScrollOffset: 0, historySearch: controller,
    prompt: 'original prompt', cursorPos: 15, modelPicker: controller, modalStack: ['selection'], commandContext: controller,
    getViewportHeight: () => 20, requestRender() {}, handleEscape() {}, contextInspectorModal: controller, overlayFilters: controller,
    modalOpened() {}, filePicker: controller, imageRegistry, nextImageId: 7, saveUndoState() {}, blockActionsMenu: controller,
    executeBlockAction() {}, searchManager: controller, scroll() {}, getScrollTop: () => 3,
    openModelPickerWithTarget: () => false, openProviderModelPickerWithTarget: () => false, onModelPickerCommit: () => false,
    selectionCallback: ((_: SelectionResult | null) => { callbacks.push('original'); }) as ((result: SelectionResult | null) => void) | null,
    keybindingsManager: { matches(action: string, token: InputToken) { return action === 'search' && token === key; } },
    cursorCalls: 0, ensureInputCursorVisible(width?: number) { expect(this).toBe(source); expect(width).toBeUndefined(); this.cursorCalls++; } };
  return { source, callbacks, imageRegistry };
}

test('modal snapshot counters stay detached while selection callbacks remain owned by the current feed', () => {
  const { source, callbacks, imageRegistry } = modalSource(), history = new InfiniteBuffer();
  const state = captureModalFeedState(source, key, history);
  expect(state.history).toBe(history); expect(state.imageRegistry).toBe(imageRegistry); expect(state.searchShortcutMatch).toBe(true);
  source.prompt = 'changed by an owner callback'; source.nextImageId = 8;
  source.selectionCallback = () => { callbacks.push('replacement'); };
  state.getSelectionCallback()?.(null);
  expect(callbacks).toEqual(['replacement']);
  const newest = () => { callbacks.push('newest'); };
  state.setSelectionCallback(newest); expect(source.selectionCallback).toBe(newest);
  expect(state.prompt).toBe('original prompt'); expect(state.nextImageId).toBe(7);
  state.ensureInputCursorVisible(); expect(source.cursorCalls).toBe(1);
});

test('key snapshot uses the current block menu receiver without sharing mutable prompt fields', () => {
  const opened: string[] = [], menu = { open(_block: BlockMeta) { expect(this).toBe(menu); opened.push('original'); } };
  const source = { prompt: 'text', cursorPos: 4, inputScrollTop: 0, commandMode: false, contentWidth: 80, inputHistory: null,
    indicatorFocused: false, conversationManager: null, commandContext: undefined, submitConcealedInput: () => false,
    autocomplete: null, modalOpened() {}, saveUndoState() {}, ensureInputCursorVisible() {}, getWrappedPromptInfo() {},
    moveCursorVertical: () => false, handlePathCompletion: () => false, handleBlockToggle() {}, findMarkerAtPos: () => null,
    cleanupMarkerRegistry() {}, expandPrompt: (value: string) => value, scroll() {}, exitApp() {}, requestRender() {}, blockActionsMenu: menu };
  const state = capturePromptKeyState(source);
  const replacement = { open(_block: BlockMeta) { expect(this).toBe(replacement); opened.push('replacement'); } };
  source.blockActionsMenu = replacement;
  const block: BlockMeta = { type: 'code', rawContent: 'const value = 1;', blockIndex: 0, startLine: 2, lineCount: 1, collapseKey: 'block-0' };
  state.blockActionsMenu.open(block);
  expect(opened).toEqual(['replacement']);
  state.prompt = 'route edit'; expect(source.prompt).toBe('text'); expect(state.maxInputRows).toBe(8);
});

test('modal writeback preserves replacement callback ownership and explicit clears', () => {
  const { source } = modalSource();
  const state = captureModalFeedState(source, key, new InfiniteBuffer());
  const replacement = () => {};
  source.selectionCallback = replacement;
  expect(withModalState(state, true).selectionCallback).toBe(replacement);
  expect(withModalState(state, true, { selectionCallback: null }).selectionCallback).toBeNull();
  source.selectionCallback = null;
  expect(withModalState(state, true).selectionCallback).toBeNull();
  const newer = () => {};
  source.selectionCallback = newer;
  expect(withModalState(state, true).selectionCallback).toBe(newer);
});

test('opt-in shortcut repair follows command editing without changing another product’s policy', () => {
  const calls: string[] = [], state = { commandMode: true, prompt: 'ordinary text', autocomplete: {
    reset() { calls.push('reset'); }, update(query: string) { calls.push(query); } } };
  refreshCommandAutocomplete(state); expect(state.commandMode).toBe(false); expect(calls).toEqual(['reset']);
  state.commandMode = true; state.prompt = '/sessions'; refreshCommandAutocomplete(state);
  state.prompt = '/sessions list'; refreshCommandAutocomplete(state);
  expect(calls).toEqual(['reset', 'sessions', 'reset']);
});
