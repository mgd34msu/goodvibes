import { syncRuntimeAfterSettingReset } from '@goodvibes-jev/engine/terminal-shell/runtime-setting-reset';
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { servingEffortForLevel, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { CommandContext } from './command-registry.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { openDaemonTimezonePicker } from './daemon-settings-actions.ts';
import { isTextBackspace } from '@goodvibes-jev/engine/terminal-shell';





type SettingsRouteState = {
  settingsModal: {
    active: boolean;
    editingMode: boolean;
    currentCategory: string;
    focusPane?: 'categories' | 'settings';
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    activateSelected: () => void;
    adjustSelected: (direction: 'left' | 'right', step?: number) => void;
    moveFocusedUp?: () => void;
    moveFocusedDown?: () => void;
    moveUp?: () => void;
    moveDown?: () => void;
    focusCategories?: () => void;
    focusSettings?: () => void;
    toggleFocusPane?: () => void;
    nextCategory: () => void;
    prevCategory?: () => void;
    editBackspace: () => void;
    editChar: (char: string) => void;
    pendingModelPickerTarget: import('./model-picker.ts').ModelPickerTarget | null;
    pendingProviderModelPickerTarget?: import('./model-picker.ts').ModelPickerTarget | null;
    pendingSettingsPickerAction?: 'tts-provider' | 'tts-voice' | 'daemon-timezone' | 'theme' | null;
    resetSelected?: () => { key: string; value: unknown } | null;
    searchQuery: string;
    setSearchQuery: (query: string) => void;
    clearSearch: () => void;
    scrollContext?: (delta: number) => void;
  };
  commandContext?: CommandContext;
  /** Called when the settings modal requests the model picker for a non-main target. */
  openModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => void;
  /** Called when the settings modal requests provider selection before model selection. */
  openProviderModelPickerWithTarget?: (target: import('./model-picker.ts').ModelPickerTarget) => void;
  requestRender: () => void;
  handleEscape: () => void;
};



function consumeSettingsPickerRequest(state: SettingsRouteState): void {
  const settingsAction = state.settingsModal.pendingSettingsPickerAction ?? null;
  if (settingsAction !== null) {
    state.settingsModal.pendingSettingsPickerAction = null;
    if (!state.commandContext) return;
    if (settingsAction === 'tts-provider') {
      openTtsProviderPicker(state.commandContext);
      return;
    }
    if (settingsAction === 'daemon-timezone') {
      openDaemonTimezonePicker(state.commandContext);
      return;
    }
    if (settingsAction === 'theme') {
      openThemePicker(state.commandContext);
      return;
    }
    void openTtsVoicePicker(state.commandContext).catch((error: unknown) => {
      state.commandContext?.print(`Unable to list TTS voices: ${error instanceof Error ? error.message : String(error)}`);
      state.requestRender();
    });
    return;
  }

  const providerModelTarget = state.settingsModal.pendingProviderModelPickerTarget ?? null;
  if (providerModelTarget !== null) {
    state.settingsModal.pendingProviderModelPickerTarget = null;
    state.openProviderModelPickerWithTarget?.(providerModelTarget);
    return;
  }
  const pickerTarget = state.settingsModal.pendingModelPickerTarget;
  if (pickerTarget !== null) {
    state.settingsModal.pendingModelPickerTarget = null;
    state.openModelPickerWithTarget?.(pickerTarget);
  }
}

export function handleSettingsModalToken(state: SettingsRouteState, token: InputToken): boolean {
  if (!state.settingsModal.active) return false;

  // The search row is always live: printable text goes to the query. While
  // the query is non-empty the list shows ranked matches across every
  // category; clearing it returns to the category view. Space toggles the
  // selected setting only while the query is empty, and reset is ctrl+r, so
  // every letter can be searched for.
  const modal = state.settingsModal;
  const searching = modal.searchQuery.length > 0;
  const setQuery = (query: string): void => {
    if (query.length === 0) modal.clearSearch();
    else modal.setSearchQuery(query);
  };
  const activate = (): void => {
    if (modal.currentCategory === 'flags' && !searching) modal.toggleSelectedFlag();
    else {
      modal.activateSelected();
      consumeSettingsPickerRequest(state);
    }
  };

  if (token.type === 'key') {
    const focusPane = modal.focusPane ?? 'settings';
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter' || (token.logicalName === 'space' && !modal.editingMode && !searching)) {
      if (modal.editingMode) modal.commitEdit();
      else if (focusPane === 'categories' && !searching) modal.focusSettings?.();
      else activate();
    } else if (token.logicalName === 'space' && searching && !modal.editingMode) {
      setQuery(`${modal.searchQuery} `);
    } else if ((token.logicalName === 'left' || token.logicalName === 'right') && !modal.editingMode && !searching) {
      if (token.logicalName === 'left') modal.focusCategories?.();
      else modal.focusSettings?.();
    } else if (token.logicalName === 'up') {
      if (searching) modal.moveUp?.();
      else if (modal.moveFocusedUp) modal.moveFocusedUp();
      else modal.moveUp?.();
    } else if (token.logicalName === 'down') {
      if (searching) modal.moveDown?.();
      else if (modal.moveFocusedDown) modal.moveFocusedDown();
      else modal.moveDown?.();
    } else if ((token.logicalName === 'pageup' || token.logicalName === 'pagedown') && !modal.editingMode) {
      modal.scrollContext?.(token.logicalName === 'pageup' ? -3 : 3);
    } else if (token.logicalName === 'r' && token.ctrl && !modal.editingMode) {
      const reset = modal.resetSelected?.();
      if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
    } else if (token.logicalName === 'tab' && !searching) {
      if (modal.toggleFocusPane) modal.toggleFocusPane();
      else if (focusPane === 'categories') modal.focusSettings?.();
      else modal.focusCategories?.();
    } else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.editingMode) modal.editBackspace();
      else if (searching) setQuery(modal.searchQuery.slice(0, -1));
    }
  } else if (token.type === 'text') {
    if (modal.editingMode) {
      // An inline edit takes priority over search: characters go to the edit buffer.
      modal.editChar(token.value);
    } else if (searching) {
      setQuery(modal.searchQuery + token.value);
    } else if (token.value === ' ') {
      if ((modal.focusPane ?? 'settings') === 'categories') modal.focusSettings?.();
      else activate();
    } else if (token.value !== '/') {
      // '/' used to arm search; search is always live, so it is ignored as a first character.
      setQuery(token.value);
    }
  }

  state.requestRender();
  return true;
}

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (conversationManager: CommandContext['session']['conversationManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    query: string;
    setQuery: (query: string) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleSessionPickerToken(state: SessionPickerRouteState, token: InputToken): boolean {
  if (!state.sessionPickerModal.active) return false;
  const modal = state.sessionPickerModal;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const conversationManager = state.commandContext?.session.conversationManager;
      if (conversationManager) {
        modal.loadSelected(conversationManager);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) modal.setQuery(modal.query.slice(0, -1));
    else if (token.logicalName === 'd' && !token.ctrl && modal.query.length === 0) modal.deleteSelected();
  } else if (token.type === 'text') {
    // The search row is always live: d asks about deleting while it is empty, otherwise it is typed.
    if (token.value === 'd' && modal.query.length === 0) modal.deleteSelected();
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type ProfilePickerRouteState = {
  profilePickerModal: {
    active: boolean;
    loadSelected: (configManager: CommandContext['platform']['configManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    saveCurrentAs: (name: string, configManager: CommandContext['platform']['configManager']) => void;
    query: string;
    setQuery: (query: string) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

export function handleProfilePickerToken(state: ProfilePickerRouteState, token: InputToken): boolean {
  if (!state.profilePickerModal.active) return false;
  const modal = state.profilePickerModal;

  const saveCurrent = (): void => {
    if (state.commandContext?.platform.configManager) {
      const name = `profile-${Date.now()}`;
      modal.saveCurrentAs(name, state.commandContext.platform.configManager);
    }
  };
  const act = (key: string): void => {
    if (key === 'd') modal.deleteSelected();
    else if (key === 's') saveCurrent();
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      if (state.commandContext?.platform.configManager) {
        modal.loadSelected(state.commandContext.platform.configManager);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.query.length > 0) modal.setQuery(modal.query.slice(0, -1));
    } else if (token.logicalName) act(token.logicalName);
  } else if (token.type === 'text') {
    // The search row is always live: d and s act while it is empty, otherwise they are typed.
    if (modal.query.length === 0 && (token.value === 'd' || token.value === 's')) act(token.value);
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}
