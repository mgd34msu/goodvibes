/**
 * The Agent's live conversation, as the conversation capabilities
 * (capabilities/builtin/conversation.ts) take it: the same services for the
 * person's `/clear`, `/compact` and `/undo` and for the model's
 * `capability_run`. The Agent has no rewind to undo.
 */
import type { SessionCapabilityServices } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import { refuseWhileTurnRuns } from '@goodvibes/engine/terminal-shell/everyday-commands';
import { NOTHING_TO_COMPACT_YET, NothingToCompactError } from '@goodvibes/engine/platform/platform/core';
import { keysServices } from '@goodvibes/engine/terminal-shell/keys-capabilities';
import type { CommandContext } from '../command-registry.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { compactConversation } from './runtime-services.ts';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../core/notifications-feed.ts';

export function conversationOf(ctx: CommandContext): SessionCapabilityServices['conversation'] {
  return {
    isGenerating: () => ctx.isGenerating?.() === true,
    messageCount: () => ctx.session.conversationManager.getMessagesForLLM().length,
    startFresh: () => {
      const result = startFreshConversation(ctx);
      // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
      if (result.savedAs) void publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + result.savedAs + ': /session resume ' + result.savedAs + ' returns to it.');
      ctx.renderRequest();
      return result;
    },
    compact: async () => {
      refuseWhileTurnRuns(ctx, '/compact');
      ctx.print('Compacting conversation...');
      const receipt = await compactConversation(ctx);
      if (!receipt) throw new NothingToCompactError(NOTHING_TO_COMPACT_YET);
      ctx.renderRequest();
      return `Conversation compacted (${receipt.messagesBefore} to ${receipt.messagesAfter} messages).`;
    },
    undoTurn: () => {
      const undone = ctx.session.conversationManager.undo();
      if (undone) ctx.renderRequest();
      return undone;
    },
  };
}

/** Everything the conversation capabilities need from the Agent's open conversation. */
export function sessionCapabilityServices(ctx: CommandContext): SessionCapabilityServices {
  return {
    conversation: conversationOf(ctx),
    ...(ctx.workspace.fileUndoManager ? { files: ctx.workspace.fileUndoManager } : {}),
    // The key capabilities (builtin/keys.ts) act on this program's key table.
    ...(ctx.workspace.keybindingsManager ? { keys: keysServices(ctx.workspace.keybindingsManager) } : {}),
  };
}
