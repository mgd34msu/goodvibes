export {
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleBlockActionsToken,
} from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';
import { createModelPickerTokenHandler, closeModelPickerRoute } from '@goodvibes-jev/engine/terminal-shell/model-picker-token-route';
import type { CommandContext } from './command-registry.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-workspace.ts';
import type { InputToken } from '@goodvibes-jev/engine/platform/platform/core';
import type { ProcessEntry } from '../renderer/process-modal.ts';
import { isLocalFitRecommendation, isProviderSignInRow } from './model-picker-local-fit.ts';
export const handleModelPickerToken = createModelPickerTokenHandler<CommandContext, ModelPickerModal>({
  chromeLines: MODEL_PICKER_CHROME_LINES,
  validateContextCap: false,
  extraControls: false,
  commitBeforeClose: true,
  commit(state, selection) {
    state.commandContext?.completeModelSelection?.(selection);
  },
  selectSpecial(state, selected) {
    if (isProviderSignInRow(selected)) {
      closeModelPickerRoute(state);
      state.commandContext?.openProviderPicker?.();
      return true;
    }
    if (isLocalFitRecommendation(selected)) {
      closeModelPickerRoute(state);
      state.commandContext?.print?.(
        [
          selected.displayName + ' is not installed yet.',
          'To use a local model, add a custom provider:',
          '  /provider add <name> <baseURL>  (e.g. /provider add ollama http://localhost:11434/v1)',
          'Or sign in to a cloud provider via the provider picker.',
        ].join('\n'),
      );
      return true;
    }
    return false;
  },
});
type ProcessRouteState = {
  processModal: {
    active: boolean;
    moveUp: () => void;
    moveDown: () => void;
    getSelected: () => ProcessEntry | undefined;
    close: () => void;
    open: () => void;
    stopSelected: () => boolean;
    refresh: () => void;
  };
  liveTailModal: {
    open: (entry: ProcessEntry) => void;
  };
  modalOpened: (name: string) => void;
  requestRender: () => void;
  handleEscape: () => void;
  /** Open a process's output full screen (shell/session-views.ts); false when it cannot be opened here. */
  openProcessView?: (processId: string) => boolean;
};
export function handleProcessModalToken(state: ProcessRouteState, token: InputToken): boolean {
  if (!state.processModal.active) return false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') state.processModal.moveUp();
    else if (token.logicalName === 'down') state.processModal.moveDown();
    else if (token.logicalName === 'enter') {
      const entry = state.processModal.getSelected();
      // The process opens full screen; the monitor closes behind it the way Esc closes it (one stack level).
      if (entry && state.openProcessView?.(entry.id)) state.handleEscape();
      else if (entry) {
        state.modalOpened('liveTail');
        state.processModal.close();
        state.liveTailModal.open(entry);
      }
    }
  } else if (token.type === 'text' && token.value === 'k') {
    const stopped = state.processModal.stopSelected();
    if (stopped) state.processModal.refresh();
  }

  state.requestRender();
  return true;
}
type LiveTailRouteState = {
  liveTailModal: {
    active: boolean;
    scrollUp: () => void;
    scrollDown: () => void;
    stopProcess: () => boolean;
    close: () => void;
  };
  processModal: {
    open: () => void;
  };
  requestRender: () => void;
  handleEscape: () => void;
};
export function handleLiveTailToken(state: LiveTailRouteState, token: InputToken): boolean {
  if (!state.liveTailModal.active) return false;

  const stopAndReturn = (): void => {
    if (state.liveTailModal.stopProcess()) state.handleEscape();
  };

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') state.liveTailModal.scrollUp();
    else if (token.logicalName === 'down') state.liveTailModal.scrollDown();
    else if (token.logicalName === 'k') stopAndReturn();
  } else if (token.type === 'text' && token.value === 'k') {
    stopAndReturn();
  }

  state.requestRender();
  return true;
}
