import { sessionPickerDeleteNamedKey, sessionPickerDeleteTextAction } from '@goodvibes-jev/engine/terminal-shell/searchable-modal-route';
import {
  createSearchableModalTokenRoute,
  createProfilePickerTokenRoute,
} from '@goodvibes-jev/engine/terminal-shell/searchable-modal-route';
import { createSettingsModalRoute } from '@goodvibes-jev/engine/terminal-shell/settings-modal-route';
export const { handleSettingsModalToken } = createSettingsModalRoute<
  CommandContext,
  import('./model-picker.ts').ModelPickerTarget,
  'tts-provider' | 'tts-voice' | 'theme' | 'daemon-timezone'
>({
  focusKey: 'focusPane',
  toggleFocusKey: 'toggleFocusPane',
  cancelInlineEditOnEscape: false,
  toggleFlagCategory: true,
  extendedResetShortcuts: false,
  openSettingsAction(context, action, requestRender) {
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
import '@goodvibes-jev/engine/terminal-shell/runtime-setting-reset';
export { handleSelectionModalToken, handleBookmarkModalToken } from '@goodvibes-jev/engine/terminal-shell/modal-input-routes';

import '../providers/reasoning-effort-surface.ts';
import type { CommandContext } from './command-registry.ts';
import { openTtsProviderPicker, openTtsVoicePicker } from './tts-settings-actions.ts';
import { openThemePicker } from './theme-settings-actions.ts';
import { openDaemonTimezonePicker } from './daemon-settings-actions.ts';
import '@goodvibes-jev/engine/terminal-shell';

type SessionPickerRouteState = {
  sessionPickerModal: {
    active: boolean;
    loadSelected: (conversationManager: CommandContext['session']['conversationManager']) => void;
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
    const conversation = state.commandContext?.session.conversationManager;
    if (conversation) state.sessionPickerModal.loadSelected(conversation);
  },

  namedKey: sessionPickerDeleteNamedKey,
  textAction: sessionPickerDeleteTextAction,
});

export const handleProfilePickerToken = createProfilePickerTokenRoute<CommandContext['platform']['configManager']>(false);
