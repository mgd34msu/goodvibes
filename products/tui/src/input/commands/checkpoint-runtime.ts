// ---------------------------------------------------------------------------
// checkpoint-runtime.ts, /checkpoints, /checkpoint
//
// UX over WorkspaceCheckpointManager (@goodvibes-jev/engine/platform/platform/workspace),
// the whole-workspace, git-backed snapshot engine wired onto RuntimeServices as
// `workspaceCheckpointManager` (src/runtime/services.ts) and threaded through
// CommandContext.workspace exactly like FileUndoManager already is.
//
// /checkpoints restore <n|id> restores the files of one checkpoint (shared
// with the Agent, terminal-shell/recovery-commands.ts). The unified,
// message-anchored /rewind (rewind-runtime.ts) rewinds files AND/OR
// conversation to a completed turn, reusing this same store for the files half.
// ---------------------------------------------------------------------------

import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { createCheckpointsCommand, shortCheckpointId } from '@goodvibes-jev/engine/terminal-shell/recovery-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

/** Exported for /rewind's no-anchors checkpoint fallback (rewind-runtime.ts), which lists checkpoints the same way. */
export { shortCheckpointId as shortId } from '@goodvibes-jev/engine/terminal-shell/recovery-commands';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerCheckpointRuntimeCommands(registry: CommandRegistry): void {
  // /checkpoints and /checkpoints restore: the same lines the Agent runs.
  registry.register(createCheckpointsCommand<CommandContext>({
    aliases: ['ckpts'],
    manager: (ctx) => ctx.workspace.workspaceCheckpointManager,
    record: (ctx, text) => ctx.session.conversationManager.addTypedSystemMessage(text, 'operational'),
    emptyHint: '/checkpoint <label> creates one manually; turns and agent runs snapshot automatically.',
    listFooter: '/rewind restores a completed turn instead (files and/or conversation), reusing these checkpoints for the files half. /checkpoint <label> creates one.',
  }));

  registry.register({
    name: 'checkpoint',
    description: 'Create a manual workspace checkpoint (forensic retention)',
    usage: '[label]',
    argsHint: '[label]',
    rawRest: 0,
    handler: async (args, ctx: CommandContext) => {
      const mgr = ctx.workspace.workspaceCheckpointManager;
      if (!mgr) {
        ctx.print('Checkpoints are not available in this session.');
        return;
      }
      const label = args.join(' ').trim() || undefined;
      try {
        const checkpoint = await mgr.create({ kind: 'manual', label, retentionClass: 'forensic' });
        if (!checkpoint) {
          ctx.print('No changes since the last checkpoint; nothing to save.');
          return;
        }
        ctx.print(`Checkpoint created: ${shortCheckpointId(checkpoint.id)} "${checkpoint.label}" (forensic retention).`);
      } catch (err) {
        ctx.print(`Checkpoint failed: ${summarizeError(err)}`);
      }
    },
  });
}
