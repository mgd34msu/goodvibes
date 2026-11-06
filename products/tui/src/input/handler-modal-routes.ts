import {
  createSearchableModalTokenRoute,
  createProfilePickerTokenRoute,
} from '@goodvibes-jev/engine/terminal-shell/searchable-modal-route';
import { createSettingsModalRoute } from '@goodvibes-jev/engine/terminal-shell/settings-modal-route';
export const { handleSettingsModalToken } = createSettingsModalRoute<
  CommandContext,
  import('./model-picker.ts').ModelPickerTarget,
  'tts-provider' | 'tts-voice' | 'theme'
>({
  focusKey: 'focusRegion',
  toggleFocusKey: 'toggleFocusRegion',
  cancelInlineEditOnEscape: true,
  toggleFlagCategory: false,
  extendedResetShortcuts: true,
  openSettingsAction(context, action, requestRender) {
    if (action === 'tts-provider') {
      openTtsProviderPicker(context);
      return;
    }
    if (action === 'theme') {
      openThemePicker(context);
      return;
    }

    void openTtsVoicePicker(context).catch((error: unknown) => {
      context.print('Unable to list TTS voices: ' + summarizeError(error));
      requestRender();
    });
  },
});
import '@goodvibes-jev/engine/terminal-shell/runtime-setting-reset';
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';
import type { InputToken } from '@goodvibes-jev/engine/sdk/platform/core';
import '../providers/reasoning-effort-surface.ts';
import type { CommandContext } from './command-registry.ts';
import type { ConfigModal } from './config-modal.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { isTextBackspace } from './delete-key-policy.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';

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
export const handleSessionPickerToken = createSearchableModalTokenRoute<SessionPickerRouteState>({
  modal: (state) => state.sessionPickerModal,
  enter(state) {
    const resume = state.commandContext?.resumeSession;
    if (resume) void state.sessionPickerModal.resumeSelected(resume, state.handleEscape).then(state.requestRender, state.requestRender);
  },

  namedKey(state, key, ctrl) {
    if (key === 'd' && !ctrl && !state.sessionPickerModal.query.length) state.sessionPickerModal.deleteSelected();
  },
  textAction(state, value) {
    if (value !== 'd' || state.sessionPickerModal.query.length) return false;
    state.sessionPickerModal.deleteSelected();
    return true;
  },
});

/**
 * Profiles: the search row is always live. `d` (arm, then delete) and `s`
 * (save the current settings) fire while the query is empty; otherwise every
 * printable key is typed into the query. Esc drops an armed delete first,
 * otherwise it closes.
 */
export const handleProfilePickerToken = createProfilePickerTokenRoute<CommandContext['platform']['configManager']>(true);

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
    const claimed =
      state.configModal.getFilterQuery().length === 0 &&
      [...token.value].length === 1 &&
      state.configModal.resolveAction(token.value) !== null;
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
  const fired =
    actionKey.length > 0 &&
    state.configModal.fireAction(actionKey, {
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
