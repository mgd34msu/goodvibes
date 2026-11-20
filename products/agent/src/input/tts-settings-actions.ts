import { createTtsSettingsActions } from '@goodvibes/engine/terminal-shell/tts-settings-actions';
import type { CommandContext } from './command-registry.ts';
export const { openTtsProviderPicker, openTtsVoicePicker } = createTtsSettingsActions<CommandContext>({
  describeError: (error) => (error instanceof Error ? error.message : String(error)),
});
