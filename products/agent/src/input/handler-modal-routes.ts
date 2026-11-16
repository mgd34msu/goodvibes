import { openDecisionRouterSettings } from '@goodvibes-jev/engine/terminal-shell/decision-router-settings-actions';
import { openSettingsChoice, type SettingsChoiceAction } from '@goodvibes-jev/engine/terminal-shell/settings-choice-actions';
import { sessionPickerDeleteNamedKey, sessionPickerDeleteTextAction } from '@goodvibes-jev/engine/terminal-shell/searchable-modal-route';
import {
  createSearchableModalTokenRoute,
  createProfilePickerTokenRoute,
} from '@goodvibes-jev/engine/terminal-shell/searchable-modal-route';
import { createSettingsModalRoute } from '@goodvibes-jev/engine/terminal-shell/settings-modal-route';
export const { handleSettingsModalToken } = createSettingsModalRoute<
  CommandContext,
  import('./model-picker.ts').ModelPickerTarget,
  'tts-provider' | 'tts-voice' | 'theme' | SettingsChoiceAction | 'daemon-timezone'
>({
  focusKey: 'focusPane',
  toggleFocusKey: 'toggleFocusPane',
  cancelInlineEditOnEscape: false,
  toggleFlagCategory: true,
  openSettingsAction(context, action, requestRender, changed, setExecutionMode) {
    if (action === 'decision-router') { openDecisionRouterSettings(context, changed); return; }
    if (action === 'judgment-provider' || action === 'judgment-model' || action === 'judgment-fallbacks' || action === 'decision-policy' || action === 'permission-mode') {
      openSettingsChoice(context, action, changed, setExecutionMode);
      return;
    }
    if (action === 'tts-provider') {
      openTtsProviderPicker(context);
      return;
    }
    if (action === 'theme') {
      openThemePicker(context);
      return;
    }
    if (action === 'daemon-timezone') {
      openDaemonTimezonePicker(context);
      return;
    }
    void openTtsVoicePicker(context).catch((error: unknown) => {
      context.print('Unable to list TTS voices: ' + (error instanceof Error ? error.message : String(error)));
      requestRender();
    });
  },
});
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';

import type { CommandContext } from './command-registry.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { openDaemonTimezonePicker } from './daemon-settings-actions.ts';

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (context: CommandContext) => Promise<unknown>;
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

export const handleSessionPickerToken = createSearchableModalTokenRoute<SessionPickerRouteState>({
  modal: (state) => state.sessionPickerModal,
  enter(state) {
    // The load re-resolves the saved model, so its status line arrives after this key returns.
    if (state.commandContext) void state.sessionPickerModal.loadSelected(state.commandContext).then(() => state.requestRender());
  },

  namedKey: sessionPickerDeleteNamedKey,
  textAction: sessionPickerDeleteTextAction,
});

export const handleProfilePickerToken = createProfilePickerTokenRoute<CommandContext['platform']['configManager']>(false);
