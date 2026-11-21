import { createTtsSettingsActions } from '@goodvibes/engine/terminal-shell/tts-settings-actions';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';
export const { openTtsProviderPicker, openTtsVoicePicker } = createTtsSettingsActions<CommandContext>({
  describeError: summarizeError,
});
