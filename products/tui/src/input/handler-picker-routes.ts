export {
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleBlockActionsToken,
} from '@goodvibes/engine/terminal-shell/modal-input-routes';
import { createModelPickerTokenHandler } from '@goodvibes/engine/terminal-shell/model-picker-token-route';
import { openSettingsChoice } from '@goodvibes/engine/terminal-shell/settings-choice-actions';
import type { CommandContext } from './command-registry.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-workspace.ts';
import { ensureProviderKeyThenSelect } from './provider-key-intake.ts';
export const handleModelPickerToken = createModelPickerTokenHandler<CommandContext, ModelPickerModal>({
  chromeLines: MODEL_PICKER_CHROME_LINES,
  commitBeforeClose: false,
  commit(state, selection, applied) {
    const context = state.commandContext;
    if (context) ensureProviderKeyThenSelect(context, selection.model.provider, () => {
      if (!context.completeModelSelection) return;
      context.completeModelSelection(selection);
      applied();
    });
  },
  commitEmbedding(state, provider) {
    state.commandContext?.completeEmbeddingProviderSelection?.(provider);
  },
  commitChoice(state, target, choiceId) {
    const context = state.commandContext;
    // The decision model is chosen through the same steps Settings uses, which write the judgment.* settings.
    if (context && target === 'decision') openSettingsChoice(context, 'judgment-model', () => context.renderRequest(), undefined, { pick: choiceId });
  },
});
