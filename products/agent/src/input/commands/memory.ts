/**
 * `/memory` is one description shared with the other terminal app
 * (terminal-shell/memory-command.ts). The Agent opens its workspace's Memory
 * page and records no per-turn memory.
 */
import { createMemoryCommand } from '@goodvibes-jev/engine/terminal-shell/memory-command';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';

export const memoryCommand: SlashCommand = createMemoryCommand<CommandContext>({
  open(ctx) {
    if (!ctx.openAgentWorkspace) throw commandRefusal('This surface has no workspace.', '/memory list shows the records.');
    ctx.openAgentWorkspace('memory');
  },
  injections: undefined,
});
