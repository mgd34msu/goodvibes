/**
 * `/memory` is one description shared with the other terminal app
 * (terminal-shell/memory-command.ts): it opens Memory and knowledge. The
 * Agent records no per-turn memory.
 */
import { createMemoryCommand } from '@goodvibes/engine/terminal-shell/memory-command';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';

export const memoryCommand: SlashCommand = createMemoryCommand<CommandContext>({
  injections: undefined,
  daemon: capabilityBinding,
});
