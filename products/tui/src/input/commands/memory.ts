/**
 * `/memory` is one description shared with the other terminal app
 * (terminal-shell/memory-command.ts). This app opens the Memory screen and
 * shows the memory each recorded turn was given.
 */
import { createMemoryCommand } from '@goodvibes-jev/engine/terminal-shell/memory-command';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { buildMainSessionTurnInjectionsText, buildTurnInjectionsText } from '../../renderer/turn-injection.ts';

/** This app's own memory store, for the reads that stay local (`/incident`, `/orchestration`). Prints why when absent. */
export function getMemoryApi(context: CommandContext): MemoryApi | null {
  const memoryApi = context.clients?.knowledgeApi?.memory;
  if (!memoryApi) context.print('Memory is not available in this session.');
  return memoryApi ?? null;
}

/** The memory spine: this app's store, or the attached daemon's. Prints why when absent. */
export function getMemorySpine(context: CommandContext): MemorySpineClient | null {
  const memorySpine = context.clients?.memorySpine;
  if (!memorySpine) context.print('Memory is not available in this session.');
  return memorySpine ?? null;
}

export const memoryCommand: SlashCommand = createMemoryCommand<CommandContext>({
  open(ctx) {
    if (!ctx.openModal) throw commandRefusal('This surface has no Memory screen.', '/memory list shows the records.');
    ctx.openModal('memory-modal');
  },
  injections(ctx, agentId) {
    if (!agentId) return buildMainSessionTurnInjectionsText(ctx.session.getMainSessionTurnInjections?.() ?? []);
    const record = (ctx.ops.agentManager?.exportState() ?? []).find((candidate) => candidate.id === agentId);
    if (!record) throw commandRefusal(`No agent is ${agentId}.`, '/agents lists them.');
    return buildTurnInjectionsText(agentId, record.turnInjections ?? []);
  },
});
