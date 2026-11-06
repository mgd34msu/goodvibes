import { syncRuntimeAfterSettingReset } from '@goodvibes-jev/engine/terminal-shell/runtime-setting-reset';
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { servingEffortForLevel, toEffortModel } from '../providers/reasoning-effort-surface.ts';
import type { CommandContext } from './command-registry.ts';
import type { ConfigModal } from './config-modal.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';





type SettingsRouteState = {
  settingsModal: {
    active: boolean;
    editingMode: boolean;
    currentCategory: string;
    focusRegion?: 'categories' | 'settings';
    /** True when the user is actively typing into the search input bar. */
    searchFocused: boolean;
    /** Current cross-category search query. */
    searchQuery: string;
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    /** Scroll the documentation region (PgUp/PgDn); the renderer clamps and shows honest markers. */
    scrollContext?: (delta: number) => void;
    activateSelected: () => void;
    handleSubscriptionLogoutKey?: (key: string) => 'confirmed' | 'cancelled' | 'absorbed' | 'inactive';
    adjustSelected: (direction: 'left' | 'right', step?: number) => void;
    moveFocusedUp?: () => void;
    moveFocusedDown?: () => void;
    moveUp?: () => void;
    moveDown?: () => void;
    focusCategories?: () => void;
    focusSettings?: () => void;
    toggleFocusRegion?: () => void;
    nextCategory: () => void;
    prevCategory?: () => void;
    editBackspace: () => void;
    editChar: (char: string) => void;
    /** Enter search mode (focus the search input bar). */
    focusSearch: () => void;
    /** Exit search mode without clearing the query. */
    blurSearch: () => void;
    /** Set search query and recompute results. */
    setSearchQuery: (query: string) => void;
    /** Clear search query, results, and exit search mode. */
    clearSearch: () => void;
    /** Cancel inline edit without saving (mirrors SettingsModal.cancelEdit). */
    cancelEdit: () => void;
    pendingModelPickerTarget: import('./model-picker.ts').ModelPickerTarget | null;
    pendingProviderModelPickerTarget?: import('./model-picker.ts').ModelPickerTarget | null;
    pendingSettingsPickerAction?: 'tts-provider' | 'tts-voice' | 'theme' | null;
    resetSelected?: () => { key: string; value: unknown } | null;
    initiateResetCategory?: () => void;
    initiateResetAll?: () => void;
    handleResetConfirmKey?: (
      key: string,
    ) =>
      | { result: 'confirmed'; entries: ReadonlyArray<{ key: string; value: unknown }> }
      | 'cancelled'
      | 'absorbed'
      | 'inactive';
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
    if (settingsAction === 'theme') {
      openThemePicker(state.commandContext);
      return;
    }
    void openTtsVoicePicker(state.commandContext).catch((error: unknown) => {
      state.commandContext?.print(`Unable to list TTS voices: ${summarizeError(error)}`);
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

  // Subscription logout confirm gate: routes all keys through the unified
  // confirm contract before normal dispatch when a confirm is pending.
  if (state.settingsModal.handleSubscriptionLogoutKey) {
    const key = token.type === 'key'
      ? (token.logicalName ?? '')
      : token.type === 'text'
        ? token.value
        : '';
    const logoutResult = state.settingsModal.handleSubscriptionLogoutKey(key);
    if (logoutResult !== 'inactive') {
      state.requestRender();
      return true;
    }
  }

  // Reset confirm gate: routes all keys through the confirm contract before
  // normal dispatch when a category or all-settings reset is pending.
  if (state.settingsModal.handleResetConfirmKey) {
    const key = token.type === 'key'
      ? (token.logicalName ?? '')
      : token.type === 'text'
        ? token.value
        : '';
    const resetResult = state.settingsModal.handleResetConfirmKey(key);
    if (resetResult !== 'inactive') {
      if (typeof resetResult === 'object' && resetResult.result === 'confirmed') {
        // Sync runtime for every reset entry so provider.model / reasoningEffort
        // stay consistent with the live session without requiring a restart.
        for (const entry of resetResult.entries) {
          syncRuntimeAfterSettingReset(state.commandContext, entry.key, entry.value);
        }
      }
      state.requestRender();
      return true;
    }
  }

  // The search row is always live: printable text goes to the query. While
  // the query is non-empty the list shows search results across every
  // category (searchFocused); clearing it returns to the category view. Space
  // toggles the selected setting only while the query is empty; resets are
  // key chords (ctrl+r selected, shift+R category, ctrl+shift+R all) so every
  // letter can be searched for.
  const modal = state.settingsModal;
  const searching = modal.searchQuery.length > 0;
  const setQuery = (query: string): void => {
    if (query.length === 0) modal.clearSearch();
    else modal.setSearchQuery(query);
  };
  const resetSelected = (): void => {
    const reset = modal.resetSelected?.();
    if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
  };

  if (token.type === 'key') {
    const focusRegion = modal.focusRegion ?? 'settings';
    if (token.logicalName === 'escape') {
      // One level per press: an inline edit is a sub-dialog and is cancelled
      // first (mirrors handler-modal-stack.ts); otherwise the modal closes.
      if (modal.editingMode) {
        modal.cancelEdit();
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter' || (token.logicalName === 'space' && !modal.editingMode && !searching)) {
      if (modal.editingMode) modal.commitEdit();
      else if (focusRegion === 'categories' && !searching) modal.focusSettings?.();
      else {
        // Feature-unit toggle headers are boolean settings rows, so
        // activateSelected toggles them the same way it edits/toggles any
        // other setting (search results included).
        modal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
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
    }
    else if (token.logicalName === 'r' && token.shift && token.ctrl && !modal.editingMode && !searching) {
      modal.initiateResetAll?.();
    }
    else if (token.logicalName === 'r' && token.ctrl && !modal.editingMode) {
      resetSelected();
    }
    else if (token.logicalName === 'r' && token.shift && !modal.editingMode && !searching) {
      modal.initiateResetCategory?.();
    }
    else if (token.logicalName === 'pageup' && !modal.editingMode) {
      modal.scrollContext?.(-3);
    }
    else if (token.logicalName === 'pagedown' && !modal.editingMode) {
      modal.scrollContext?.(3);
    }
    else if (token.logicalName === 'tab' && !searching) {
      if (modal.toggleFocusRegion) modal.toggleFocusRegion();
      else if (focusRegion === 'categories') modal.focusSettings?.();
      else modal.focusCategories?.();
    }
    else if (isTextBackspace(token.logicalName ?? '')) {
      if (modal.editingMode) modal.editBackspace();
      else if (searching) setQuery(modal.searchQuery.slice(0, -1));
    }
    // token.logicalName === 'delete' is intentionally absent: search filters
    // are end-anchored with no cursor, so forward-delete is a no-op per
    // delete-key policy (src/input/delete-key-policy.ts).
  } else if (token.type === 'text') {
    if (modal.editingMode) {
      // Inline edit takes priority over search: characters go to the edit buffer.
      modal.editChar(token.value);
    } else if (searching) {
      setQuery(modal.searchQuery + token.value);
    } else if (token.value === ' ') {
      const focusRegion = modal.focusRegion ?? 'settings';
      if (focusRegion === 'categories') modal.focusSettings?.();
      else {
        modal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
    } else if (token.value !== '/') {
      // '/' used to arm search; search is always live now, so it is ignored
      // as a first character rather than searched for.
      setQuery(token.value);
    }
  }

  state.requestRender();
  return true;
}

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    query: string;
    setQuery: (query: string) => void;
    resumeSelected: (resumeSession: NonNullable<CommandContext['resumeSession']>, dismiss: () => void) => Promise<void>;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
  };
  commandContext?: Pick<CommandContext, 'resumeSession'>;
  requestRender: () => void;
  handleEscape: () => void;
};

/**
 * The session picker's search row is always live: printable keys go to the
 * query. `d` arms (then confirms) delete only while the query is empty, so a
 * search can still contain the letter d.
 */
export function handleSessionPickerToken(state: SessionPickerRouteState, token: InputToken): boolean {
  if (!state.sessionPickerModal.active) return false;
  const modal = state.sessionPickerModal;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'enter') {
      const resumeSession = state.commandContext?.resumeSession;
      if (resumeSession) {
        void modal.resumeSelected(resumeSession, state.handleEscape).then(state.requestRender, state.requestRender);
      }
    } else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (isTextBackspace(token.logicalName ?? '')) modal.setQuery(modal.query.slice(0, -1));
    else if (token.logicalName === 'd' && !token.ctrl && modal.query.length === 0) modal.deleteSelected();
  } else if (token.type === 'text') {
    if (token.value === 'd' && modal.query.length === 0) modal.deleteSelected();
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type ProfilePickerRouteState = {
  profilePickerModal: {
    active: boolean;
    query: string;
    setQuery: (query: string) => void;
    cancelDeleteConfirmation: () => boolean;
    loadSelected: (configManager: CommandContext['platform']['configManager']) => void;
    moveUp: () => void;
    moveDown: () => void;
    deleteSelected: () => void;
    saveCurrentAs: (name: string, configManager: CommandContext['platform']['configManager']) => void;
  };
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

/**
 * Profiles: the search row is always live. `d` (arm, then delete) and `s`
 * (save the current settings) fire while the query is empty; otherwise every
 * printable key is typed into the query. Esc drops an armed delete first,
 * otherwise it closes.
 */
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
      if (modal.cancelDeleteConfirmation()) {
        state.requestRender();
        return true;
      }
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
    if (modal.query.length === 0 && (token.value === 'd' || token.value === 's')) act(token.value);
    else modal.setQuery(modal.query + token.value);
  }

  state.requestRender();
  return true;
}

type ConfigModalRouteState = {
  configModal: ConfigModal;
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

/**
 * Route a key to the generic config-modal host (MIGRATE-TO-MODAL
 * surfaces). The host owns the reserved navigation keys (Esc, up/down, tab,
 * left/right) and the always-live search row: a printable key the surface
 * claims as an action fires the action while the query is empty; every other
 * printable key (and any multi-char paste) is typed into the query, and
 * Backspace edits it. Other named keys (Enter, ctrl chords) go to the
 * surface's declarative action table (fireAction handles the two-press
 * confirm for destructive actions). Any unrecognised key is absorbed so the
 * modal stays modal.
 *
 * Esc pops exactly one level: an armed destructive confirm is cancelled
 * first; otherwise the modal closes through handleEscape. Esc never clears
 * the query as a separate step.
 */
export function handleConfigModalToken(state: ConfigModalRouteState, token: InputToken): boolean {
  if (!state.configModal.active) return false;

  // Every token that reaches the modal is a user interaction, after the
  // first one, structure freezes to interaction boundaries (liveness rule).
  // Before it, renders may sync structure so async onOpen loads appear
  // without a keypress (batch refutation finding 3).
  state.configModal.noteInteraction();

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      if (state.configModal.cancelPendingConfirm()) {
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    if (isTextBackspace(token.logicalName ?? '')) {
      state.configModal.backspaceFilter();
      state.requestRender();
      return true;
    }
    switch (token.logicalName) {
      case 'up':
        state.configModal.moveUp();
        state.requestRender();
        return true;
      case 'down':
        state.configModal.moveDown();
        state.requestRender();
        return true;
      case 'left':
        state.configModal.prevTab();
        state.requestRender();
        return true;
      case 'right':
      case 'tab':
        state.configModal.nextTab();
        state.requestRender();
        return true;
    }
    // Any other 'key' token (Enter, a ctrl chord) falls through to the
    // action table below, whatever the query holds.
  } else if (token.type === 'text') {
    const claimed = state.configModal.getFilterQuery().length === 0
      && [...token.value].length === 1
      && state.configModal.resolveAction(token.value) !== null;
    if (!claimed) {
      // The WHOLE token value lands in the query in one call, including a
      // multi-char paste token, never split into per-char dispatch.
      state.configModal.appendFilterText(token.value);
      state.requestRender();
      return true;
    }
  }

  const actionKey = token.type === 'key' ? (token.logicalName ?? '') : token.type === 'text' ? token.value : '';
  const submitInput = state.commandContext?.submitInput;
  const fired = actionKey.length > 0 && state.configModal.fireAction(actionKey, {
    print: (message: string) => state.commandContext?.print(message),
    executeCommand: state.commandContext?.executeCommand,
    openModal: state.commandContext?.openModal,
    ...(submitInput ? { submitInput: (text: string) => submitInput(text) } : {}),
  });
  if (fired) {
    state.requestRender();
    return true;
  }

  // Unhandled key while a config modal is open: drop any pending confirm and
  // absorb the key (the modal owns the keyboard while it is active).
  state.configModal.clearConfirmOnMiss();
  state.requestRender();
  return true;
}
