import { createTtsRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/tts-runtime-commands';
import type { CommandContext } from '../command-registry.ts';
export const { registerTtsRuntimeCommands } = createTtsRuntimeCommands<CommandContext>({
  hidden: true,
  alwaysSpeakControls: false,
  description: 'Submit a normal prompt and play the assistant response through live TTS',
});
