export {
  handleEscapeOnlyModalToken,
  handleFilePickerToken,
  handleBlockActionsToken,
} from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';
import { createModelPickerTokenHandler } from '@goodvibes-jev/engine/terminal-shell/model-picker-token-route';
import type { CommandContext } from './command-registry.ts';
import type { ModelPickerModal } from './model-picker.ts';
import { MODEL_PICKER_CHROME_LINES } from '../renderer/model-picker-overlay.ts';
import { ensureProviderKeyThenSelect } from './provider-key-intake.ts';
export const handleModelPickerToken = createModelPickerTokenHandler<CommandContext, ModelPickerModal>({
  chromeLines: MODEL_PICKER_CHROME_LINES,
  validateContextCap: true,
  extraControls: true,
  commitBeforeClose: false,
  commit(state, selection) {
    const context = state.commandContext;
    if (context) ensureProviderKeyThenSelect(context, selection.model.provider, () => context.completeModelSelection?.(selection));
  },
  commitEmbedding(state, provider) {
    state.commandContext?.completeEmbeddingProviderSelection?.(provider);
  },
});
