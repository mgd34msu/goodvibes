/**
 * The terminal app's live conversation, as the conversation capabilities
 * (capabilities/builtin/conversation.ts) take it: the same services for the
 * person's `/clear`, `/compact` and `/undo` and for the model's
 * `capability_run`.
 */
import type { SessionCapabilityServices } from '@goodvibes/engine/terminal-shell/agent-turn/capability-tools';
import { keysServices } from '@goodvibes/engine/terminal-shell/keys-capabilities';
import type { CommandContext } from '../command-registry.ts';
import { startFreshConversation } from './fresh-conversation.ts';
import { CompactBusyError, compactConversation } from './runtime-services.ts';
import { undoLastRewind } from './rewind-runtime.ts';
import { buildCompactionAfterNotice, buildCompactionPreview } from '../../renderer/compaction-preview.ts';
import { publishNotice } from '../../core/notices.ts';
import { getSharedNotificationFeed } from '../../views/notifications-feed.ts';

/** `/compact`'s own compaction: the preview, then what happened, in words. */
export async function compactInWords(ctx: CommandContext): Promise<string> {
  const messages = ctx.session.conversationManager.getMessagesForLLM();
  // 0 when the window is unknown: the preview then leaves out the capacity clause.
  const contextWindow = ctx.provider.providerRegistry.getKnownContextWindowForModel(ctx.provider.providerRegistry.getCurrentModel()) ?? 0;
  const memStore = ctx.session.sessionMemoryStore;
  const pinnedMemoryCount = memStore ? memStore.list().length : 0;
  // Pre-compact preview: honest estimate, clearly labelled.
  ctx.print(buildCompactionPreview({ messages, contextWindow, pinnedMemoryCount, trigger: 'manual' }));
  let result: Awaited<ReturnType<typeof compactConversation>>;
  try {
    result = await compactConversation(ctx);
  } catch (error) {
    if (!(error instanceof CompactBusyError)) throw error;
    return error.message;
  }
  if (result.kind === 'summarised') return buildCompactionAfterNotice({ event: result.event, pinnedMemoryCount, qualityScore: result.qualityScore });
  if (result.kind === 'dropped') return `[Context] Dropped the ${result.dropped} oldest message(s) without a summary and kept the last ${result.kept}: this model's context window is too small to summarise them. Their tool results are gone; re-read any file you still need. /session compactions lists it.`;
  return `[Context] Nothing was compacted: ${result.reason}.`;
}

export function conversationOf(ctx: CommandContext): SessionCapabilityServices['conversation'] {
  return {
    isGenerating: () => ctx.isGenerating?.() === true,
    messageCount: () => ctx.session.conversationManager.getMessagesForLLM().length,
    startFresh: () => {
      const result = startFreshConversation(ctx);
      // A notice (the status bar's count, ctrl+n), never a row: a row would retire the empty conversation's splash.
      if (result.savedAs) publishNotice(getSharedNotificationFeed(), '[Session] Fresh conversation. The previous one is saved as ' + result.savedAs + ': /session resume ' + result.savedAs + ' returns to it.');
      ctx.renderRequest();
      return result;
    },
    compact: async () => {
      const words = await compactInWords(ctx);
      ctx.renderRequest();
      return words;
    },
    undoTurn: () => {
      const undone = ctx.session.conversationManager.undo();
      if (undone) ctx.renderRequest();
      return undone;
    },
  };
}

/** Everything the conversation capabilities need from this app's open conversation. */
export function sessionCapabilityServices(ctx: CommandContext): SessionCapabilityServices {
  return {
    conversation: conversationOf(ctx),
    ...(ctx.workspace.fileUndoManager ? { files: ctx.workspace.fileUndoManager } : {}),
    rewind: { undo: async () => (await undoLastRewind(ctx)).message },
    // The key capabilities (builtin/keys.ts) act on this program's key table.
    ...(ctx.workspace.keybindingsManager ? { keys: keysServices(ctx.workspace.keybindingsManager) } : {}),
  };
}
