export {
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleBlockActionsToken,
} from '@goodvibes/engine/terminal-shell/modal-input-routes';
import { createModelPickerTokenHandler, closeModelPickerRoute } from '@goodvibes/engine/terminal-shell/model-picker-token-route';
import { openSettingsChoice } from '@goodvibes/engine/terminal-shell/settings-choice-actions';
import type { CommandContext } from './command-registry.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-workspace.ts';
import type { InputToken } from '@goodvibes/engine/platform/platform/core';
import type { ProcessEntry } from '../renderer/process-modal.ts';
import { isLocalFitRecommendation, isProviderSignInRow } from './model-picker-local-fit.ts';
export const handleModelPickerToken = createModelPickerTokenHandler<CommandContext, ModelPickerModal>({
  chromeLines: MODEL_PICKER_CHROME_LINES,
  commitBeforeClose: true,
  commit(state, selection, applied) {
    const context = state.commandContext;
    if (!context?.completeModelSelection) return;
    context.completeModelSelection(selection);
    applied();
  },
  commitChoice(state, target, choiceId) {
    const context = state.commandContext;
    // The decision model is chosen through the same steps Settings uses, which write the judgment.* settings.
    if (context && target === 'decision') openSettingsChoice(context, 'judgment-model', () => context.renderRequest(), undefined, { pick: choiceId });
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
    armStop: () => boolean;
    cancelStop: () => void;
    confirmStop: () => boolean;
    refresh: () => void;
  };
  liveTailModal: {
    open: (entry: ProcessEntry) => void;
  };
  requestRender: () => void;
  handleEscape: () => void;
  /** Open a process's output full screen (shell/session-views.ts); false when it cannot be opened here. */
  openProcessView?: (processId: string) => boolean;
};
/**
 * The process monitor's keys: arrows and j/k move, as in every list; Enter
 * opens the output; x or Delete asks to stop the selected running process and
 * only y then stops it. Any other key withdraws the request.
 */
export function handleProcessModalToken(state: ProcessRouteState, token: InputToken): boolean {
  if (!state.processModal.active) return false;
  const modal = state.processModal;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'delete') modal.armStop();
    else if (token.logicalName === 'up') modal.moveUp();
    else if (token.logicalName === 'down') modal.moveDown();
    else if (token.logicalName === 'enter') {
      modal.cancelStop();
      const entry = modal.getSelected();
      // The process opens full screen; the monitor closes behind it the way Esc closes it (one stack level).
      if (entry && state.openProcessView?.(entry.id)) state.handleEscape();
      else if (entry) {
        // The monitor comes back when Esc closes the live tail (one stack level).
        modal.close();
        state.liveTailModal.open(entry);
      }
    } else modal.cancelStop();
  } else if (token.type === 'text') {
    if (token.value === 'k') modal.moveUp();
    else if (token.value === 'j') modal.moveDown();
    else if (token.value === 'x') modal.armStop();
    else if (token.value === 'y') {
      if (modal.confirmStop()) modal.refresh();
    } else modal.cancelStop();
  }

  state.requestRender();
  return true;
}
type LiveTailRouteState = {
  liveTailModal: {
    active: boolean;
    /** x or Delete asked to stop the process; the footer then asks for y. */
    stopRequested: boolean;
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
/**
 * The live tail's keys: arrows and j/k scroll; x or Delete asks to stop the
 * process and only y then stops it and goes back; any other key withdraws the
 * request.
 */
export function handleLiveTailToken(state: LiveTailRouteState, token: InputToken): boolean {
  const modal = state.liveTailModal;
  if (!modal.active) return false;
  const requested = modal.stopRequested;
  modal.stopRequested = false;

  if (token.type === 'key') {
    if (token.logicalName === 'escape') {
      state.handleEscape();
      return true;
    }
    if (token.logicalName === 'up') modal.scrollUp();
    else if (token.logicalName === 'down') modal.scrollDown();
    else if (token.logicalName === 'delete') modal.stopRequested = true;
  } else if (token.type === 'text') {
    if (token.value === 'k') modal.scrollUp();
    else if (token.value === 'j') modal.scrollDown();
    else if (token.value === 'x') modal.stopRequested = true;
    else if (token.value === 'y' && requested && modal.stopProcess()) state.handleEscape();
  }

  state.requestRender();
  return true;
}
