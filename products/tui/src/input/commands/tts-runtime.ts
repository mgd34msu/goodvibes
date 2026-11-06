import { createTtsRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/tts-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
export const { registerTtsRuntimeCommands } = createTtsRuntimeCommands<CommandContext>({
  hidden: false,
  alwaysSpeakControls: true,
  description: 'Submit a prompt for live TTS playback, or control always-speak mode',
});
