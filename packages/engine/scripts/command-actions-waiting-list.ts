/**
 * The slash commands still described the old way (a hand-written handler,
 * usage and hints), checked by `bun run commands:check`. Converting a command
 * to one description (terminal-shell/src/command-actions/) takes its name off
 * this list in the same change. The list only shrinks, and it is empty before
 * a release is tagged.
 */
export const COMMAND_ACTIONS_WAITING_LIST: readonly string[] = [
  'checkpoint',
  'checkpoints',
  'image',
  'imagine',
  'keep',
  'media',
  'note',
  'queue',
  'replay',
  'rewind',
  'search',
  'tts',
  'voice',
];
