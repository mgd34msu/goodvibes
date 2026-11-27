import { sessionPickerDeleteNamedKey } from '@goodvibes/engine/terminal-shell/searchable-modal-route';
import { createSearchableModalTokenRoute } from '@goodvibes/engine/terminal-shell/searchable-modal-route';
// The settings screen is the one both programs show (terminal-shell settings-screen), a kit modal that reads its own keys.
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes/engine/terminal-shell/modal-input-routes';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { CommandContext } from './command-registry.ts';
import type { ConfigModal } from './config-modal.ts';
import { CONFIG_MODAL_ACTION_LEADER } from './config-modal-keys.ts';
import { isTextBackspace } from './delete-key-policy.ts';

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
 * The session picker's search row is always live: every printable key goes to
 * the query. Ctrl+D arms (then confirms) deleting the selected session.
 */
export const handleSessionPickerToken = createSearchableModalTokenRoute<SessionPickerRouteState>({
  modal: (state) => state.sessionPickerModal,
  enter(state) {
    const resume = state.commandContext?.resumeSession;
    if (resume) void state.sessionPickerModal.resumeSelected(resume, state.handleEscape).then(state.requestRender, state.requestRender);
  },

  namedKey: sessionPickerDeleteNamedKey,
});

type ConfigModalRouteState = {
  configModal: ConfigModal;
  commandContext?: CommandContext;
  requestRender: () => void;
  handleEscape: () => void;
};

/** The action key a key token names: a named key (`enter`), or the character of a Ctrl/Alt chord. A bare character is never an action. */
function configModalActionKey(token: Extract<InputToken, { type: 'key' }>): string {
  const name = token.logicalName ?? '';
  if ([...name].length !== 1) return name;
  if (!token.ctrl && !token.meta) return '';
  return token.shift ? name.toUpperCase() : name;
}

/**
 * Route a key to the generic config-modal host. The host owns the reserved
 * navigation keys (Esc, up/down, tab, left/right) and the always-live search
 * row: every printable key (and any multi-char paste) is typed into the query,
 * and Backspace edits it, so typing a search can never fire an action. Actions
 * fire from a named key (Enter), from the Ctrl chord of the action's letter
 * (Ctrl+D for `d`), or from the leader Ctrl+G followed by the key, which
 * reaches every action (config-modal-keys.ts says which keys need it).
 * fireAction asks for the second press of a destructive action. Any
 * unrecognised key is absorbed so the modal stays modal.
 *
 * Esc pops exactly one level: an armed leader or destructive confirm is
 * cancelled first; otherwise the modal closes through handleEscape. Esc never
 * clears the query as a separate step.
 */
export function handleConfigModalToken(state: ConfigModalRouteState, token: InputToken): boolean {
  if (!state.configModal.active) return false;

  // Every token that reaches the modal is a user interaction, after the
  // first one, structure freezes to interaction boundaries (liveness rule).
  // Before it, renders may sync structure so async onOpen loads appear
  // without a keypress (batch refutation finding 3).
  state.configModal.noteInteraction();

  let actionKey = '';
  if (token.type === 'key') {
    // The leader as bound in the key table (Ctrl+G by default); without a table, its default.
    const keys = state.commandContext?.workspace?.keybindingsManager;
    const leader = keys ? keys.matches('leader', token) : token.logicalName === CONFIG_MODAL_ACTION_LEADER && token.ctrl && !token.shift && !token.meta;
    if (leader) {
      state.configModal.armLeader();
      state.requestRender();
      return true;
    }
    if (token.logicalName === 'escape') {
      if (state.configModal.cancelPendingConfirm()) {
        state.requestRender();
        return true;
      }
      state.handleEscape();
      return true;
    }
    state.configModal.disarmLeader();
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
    // Any other 'key' token (Enter, a Ctrl/Alt chord) falls through to the
    // action table below, whatever the query holds.
    actionKey = configModalActionKey(token);
  } else if (token.type === 'text') {
    if (state.configModal.takeLeader() && [...token.value].length === 1) {
      actionKey = token.value;
    } else {
      // The WHOLE token value lands in the query in one call, including a
      // multi-char paste token, never split into per-char dispatch.
      state.configModal.appendFilterText(token.value);
      state.requestRender();
      return true;
    }
  }

  // A form's text is sent as written; only the composer reads `!`, `# ` and `@model:`.
  const submitInput = state.commandContext?.submitTurn;
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
  // absorb the key (the modal owns the keyboard while it is active). A key
  // pressed as an action that names none says so.
  state.configModal.clearConfirmOnMiss();
  if (token.type === 'text') state.configModal.noteUnboundAction(actionKey);
  state.requestRender();
  return true;
}
