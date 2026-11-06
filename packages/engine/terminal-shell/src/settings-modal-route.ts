import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import { isTextBackspace } from './delete-key-policy.js';
import { syncRuntimeAfterSettingReset, type RuntimeSettingResetContext } from './runtime-setting-reset.js';
export type SettingsRouteState<Context, Target, Action extends string> = {
  settingsModal: {
    active: boolean;
    editingMode: boolean;
    currentCategory: string;
    focusRegion?: ('categories' | 'settings') | undefined;
    focusPane?: ('categories' | 'settings') | undefined;
    toggleFocusPane?: (() => void) | undefined;
    /** True when the user is actively typing into the search input bar. */
    searchFocused?: boolean | undefined;
    /** Current cross-category search query. */
    searchQuery: string;
    commitEdit: () => void;
    toggleSelectedFlag: () => void;
    /** Scroll the documentation region (PgUp/PgDn); the renderer clamps and shows honest markers. */
    scrollContext?: ((delta: number) => void) | undefined;
    activateSelected: () => void;
    handleSubscriptionLogoutKey?: ((key: string) => 'confirmed' | 'cancelled' | 'absorbed' | 'inactive') | undefined;
    adjustSelected: (direction: 'left' | 'right', step?: number | undefined) => void;
    moveFocusedUp?: (() => void) | undefined;
    moveFocusedDown?: (() => void) | undefined;
    moveUp?: (() => void) | undefined;
    moveDown?: (() => void) | undefined;
    focusCategories?: (() => void) | undefined;
    focusSettings?: (() => void) | undefined;
    toggleFocusRegion?: (() => void) | undefined;
    nextCategory: () => void;
    prevCategory?: (() => void) | undefined;
    editBackspace: () => void;
    editChar: (char: string) => void;
    /** Enter search mode (focus the search input bar). */
    focusSearch?: (() => void) | undefined;
    /** Exit search mode without clearing the query. */
    blurSearch?: (() => void) | undefined;
    /** Set search query and recompute results. */
    setSearchQuery: (query: string) => void;
    /** Clear search query, results, and exit search mode. */
    clearSearch: () => void;
    /** Cancel inline edit without saving (mirrors SettingsModal.cancelEdit). */
    cancelEdit?: (() => void) | undefined;
    pendingModelPickerTarget: Target | null;
    pendingProviderModelPickerTarget?: (Target | null) | undefined;
    pendingSettingsPickerAction?: (Action | null) | undefined;
    resetSelected?:
      | (() => {
          key: string;
          value: unknown;
        } | null)
      | undefined;
    initiateResetCategory?: (() => void) | undefined;
    initiateResetAll?: (() => void) | undefined;
    handleResetConfirmKey?:
      | ((key: string) =>
          | {
              result: 'confirmed';
              entries: ReadonlyArray<{
                key: string;
                value: unknown;
              }>;
            }
          | 'cancelled'
          | 'absorbed'
          | 'inactive')
      | undefined;
  };
  commandContext?: Context | undefined;
  /** Called when the settings modal requests the model picker for a non-main target. */
  openModelPickerWithTarget?: ((target: Target) => void) | undefined;
  /** Called when the settings modal requests provider selection before model selection. */
  openProviderModelPickerWithTarget?: ((target: Target) => void) | undefined;
  requestRender: () => void;
  handleEscape: () => void;
};
/** Keyboard state machine shared by terminal settings, with explicit product focus and action policies. */
export function createSettingsModalRoute<Context extends RuntimeSettingResetContext, Target, Action extends string>(policy: {
  readonly focusKey: 'focusRegion' | 'focusPane';
  readonly toggleFocusKey: 'toggleFocusRegion' | 'toggleFocusPane';
  readonly cancelInlineEditOnEscape: boolean;
  readonly toggleFlagCategory: boolean;
  readonly extendedResetShortcuts: boolean;
  readonly openSettingsAction: (context: Context, action: Action, requestRender: () => void) => void;
}) {
  function consumeSettingsPickerRequest(state: SettingsRouteState<Context, Target, Action>): void {
    const settingsAction = state.settingsModal.pendingSettingsPickerAction ?? null;
    if (settingsAction !== null) {
      state.settingsModal.pendingSettingsPickerAction = null;
      if (!state.commandContext) return;
      policy.openSettingsAction(state.commandContext, settingsAction, state.requestRender);
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
  function handleSettingsModalToken(state: SettingsRouteState<Context, Target, Action>, token: InputToken): boolean {
    if (!state.settingsModal.active) return false;
    // Subscription logout confirm gate: routes all keys through the unified
    // confirm contract before normal dispatch when a confirm is pending.
    if (state.settingsModal.handleSubscriptionLogoutKey) {
      const key = token.type === 'key' ? (token.logicalName ?? '') : token.type === 'text' ? token.value : '';
      const logoutResult = state.settingsModal.handleSubscriptionLogoutKey(key);
      if (logoutResult !== 'inactive') {
        state.requestRender();
        return true;
      }
    }
    // Reset confirm gate: routes all keys through the confirm contract before
    // normal dispatch when a category or all-settings reset is pending.
    if (state.settingsModal.handleResetConfirmKey) {
      const key = token.type === 'key' ? (token.logicalName ?? '') : token.type === 'text' ? token.value : '';
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
    const activate = (): void => {
      if (policy.toggleFlagCategory && modal.currentCategory === 'flags' && !searching) modal.toggleSelectedFlag();
      else {
        modal.activateSelected();
        consumeSettingsPickerRequest(state);
      }
    };
    const setQuery = (query: string): void => {
      if (query.length === 0) modal.clearSearch();
      else modal.setSearchQuery(query);
    };
    const resetSelected = (): void => {
      const reset = modal.resetSelected?.();
      if (reset) syncRuntimeAfterSettingReset(state.commandContext, reset.key, reset.value);
    };
    if (token.type === 'key') {
      const focusRegion = modal[policy.focusKey] ?? 'settings';
      if (token.logicalName === 'escape') {
        // One level per press: an inline edit is a sub-dialog and is cancelled
        // first (mirrors handler-modal-stack.ts); otherwise the modal closes.
        if (policy.cancelInlineEditOnEscape && modal.editingMode) {
          modal.cancelEdit?.();
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
          activate();
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
      } else if (
        policy.extendedResetShortcuts &&
        token.logicalName === 'r' &&
        token.shift &&
        token.ctrl &&
        !modal.editingMode &&
        !searching
      ) {
        modal.initiateResetAll?.();
      } else if (token.logicalName === 'r' && token.ctrl && !modal.editingMode) {
        resetSelected();
      } else if (policy.extendedResetShortcuts && token.logicalName === 'r' && token.shift && !modal.editingMode && !searching) {
        modal.initiateResetCategory?.();
      } else if (token.logicalName === 'pageup' && !modal.editingMode) {
        modal.scrollContext?.(-3);
      } else if (token.logicalName === 'pagedown' && !modal.editingMode) {
        modal.scrollContext?.(3);
      } else if (token.logicalName === 'tab' && !searching) {
        if (modal[policy.toggleFocusKey]) modal[policy.toggleFocusKey]?.();
        else if (focusRegion === 'categories') modal.focusSettings?.();
        else modal.focusCategories?.();
      } else if (isTextBackspace(token.logicalName ?? '')) {
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
        const focusRegion = modal[policy.focusKey] ?? 'settings';
        if (focusRegion === 'categories') modal.focusSettings?.();
        else {
          activate();
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
  return { handleSettingsModalToken };
}
