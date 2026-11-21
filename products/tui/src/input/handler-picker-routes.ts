export {
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleBlockActionsToken,
} from '@goodvibes/engine/terminal-shell/modal-input-routes';
import { createModelPickerTokenHandler } from '@goodvibes/engine/terminal-shell/model-picker-token-route';
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
});
