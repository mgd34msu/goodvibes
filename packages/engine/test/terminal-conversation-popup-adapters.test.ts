import { expect, test } from 'bun:test';
import { createEmptyLine } from '../sdk/src/platform/types/grid.js';
import { applyConversationPopupRows, isCommonConversationModalOpen } from '../terminal-shell/src/renderer/conversation-overlays.js';

function fixture() {
  const input = { filePicker: { active: true }, searchManager: { active: false }, historySearch: { active: false },
    commandMode: true, autocomplete: { isActive: true } };
  const calls: string[] = [], file = createEmptyLine(8), search = createEmptyLine(8), history = createEmptyLine(8), autocomplete = createEmptyLine(8);
  const renderers = {
    filePicker(controller: typeof input.filePicker) { expect(controller).toBe(input.filePicker); calls.push('file'); return [file]; },
    search(controller: typeof input.searchManager) { expect(controller).toBe(input.searchManager); calls.push('search'); return [search]; },
    historySearch(controller: typeof input.historySearch) { expect(controller).toBe(input.historySearch); calls.push('history'); return [history]; },
    autocomplete(controller: typeof input.autocomplete) { expect(controller).toBe(input.autocomplete); calls.push('autocomplete'); return [autocomplete]; },
  };
  return { input, calls, file, search, history, autocomplete, renderers };
}

test('covering modal suppresses composer popups while retaining search rows', () => {
  const f = fixture(), viewport = [createEmptyLine(8)]; f.input.searchManager.active = true;
  const result = applyConversationPopupRows(viewport, f.input, { width: 8, height: 5, covered: true, mutateSearchRows: false }, f.renderers);
  expect(f.calls).toEqual(['search']); expect(result).toContain(f.search); expect(viewport).toHaveLength(1);
});

test('a product’s full-screen flow owns the viewport without rendering file or autocomplete underlays', () => {
  const f = fixture(), onboarding = [createEmptyLine(8)], viewport = [createEmptyLine(8)];
  const result = applyConversationPopupRows(viewport, f.input, { width: 8, height: 5, covered: false,
    mutateSearchRows: true, replaceViewport: () => onboarding }, f.renderers);
  expect(result).toBe(onboarding); expect(f.calls).toEqual([]); expect(viewport).toHaveLength(1);
});

test.each([true, false])('search-row mutation policy remains explicitly %s at the product boundary', mutateSearchRows => {
  const f = fixture(), viewport = [createEmptyLine(8)]; f.input.filePicker.active = false;
  f.input.commandMode = false; f.input.historySearch.active = true;
  const result = applyConversationPopupRows(viewport, f.input, { width: 8, height: 5, covered: false, mutateSearchRows }, f.renderers);
  expect(f.calls).toEqual(['history']); expect(result).toContain(f.history);
  expect(viewport).toHaveLength(mutateSearchRows ? 2 : 1);
});

test('shared coverage includes selection/help/surface hosts; product-specific coverage remains a separate choice', () => {
  const input = { modelPicker: { active: false }, settingsModal: { active: false }, mcpWorkspace: { active: false },
    sessionPickerModal: { active: false }, profilePickerModal: { active: false }, bookmarkModal: { active: false },
    blockActionsMenu: { active: false }, selectionModal: { active: false }, contextInspectorModal: { active: false },
    surfaceModals: { active: false }, helpOverlayActive: false, shortcutsOverlayActive: false };
  expect(isCommonConversationModalOpen(input)).toBe(false);
  input.selectionModal.active = true; expect(isCommonConversationModalOpen(input)).toBe(true);
  input.selectionModal.active = false; input.helpOverlayActive = true; expect(isCommonConversationModalOpen(input)).toBe(true);
  input.helpOverlayActive = false; input.surfaceModals.active = true; expect(isCommonConversationModalOpen(input)).toBe(true);
});
