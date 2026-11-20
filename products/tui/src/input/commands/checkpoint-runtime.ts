// ---------------------------------------------------------------------------
// checkpoint-runtime.ts, /checkpoint
//
// One description shared with the Agent (terminal-shell/checkpoint-command.ts)
// over WorkspaceCheckpointManager (@goodvibes/engine/platform/platform/workspace),
// the whole-workspace, git-backed snapshot engine wired onto RuntimeServices as
// `workspaceCheckpointManager` (src/runtime/services.ts). This app makes a
// checkpoint on request and goes back to a completed turn (rewind-runtime.ts),
// files and/or conversation, reusing the same store for the files half.
// ---------------------------------------------------------------------------

import { createCheckpointCommand } from '@goodvibes/engine/terminal-shell/checkpoint-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { rewindToTurn } from './rewind-runtime.ts';

export function registerCheckpointRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createCheckpointCommand<CommandContext>({
    record: (ctx, text) => ctx.session.conversationManager.addTypedSystemMessage(text, 'operational'),
    emptyHint: 'Turns and agent runs take one by themselves; /checkpoint make takes one now.',
    async make(ctx, label) {
      const manager = ctx.workspace.workspaceCheckpointManager;
      if (!manager) throw new Error('checkpoints are not available in this session');
      return manager.create({ kind: 'manual', label: label.trim() || undefined, retentionClass: 'forensic' });
    },
    rewind: rewindToTurn,
  }));
}
