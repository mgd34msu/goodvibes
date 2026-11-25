/**
 * Your conversations are one set of session capabilities shared with the
 * other terminal app (terminal-shell/session-command.ts), with `/resume` and
 * `/fork` the two that stay typed. The Agent resumes, saves, copies and exports
 * sessions as Markdown or text; it reads the project's cross-session task graph
 * but does not change it, keeps no conversation branches and uploads nothing.
 */
import { existsSync } from 'node:fs';
import { createSessionGraphHandler } from '@goodvibes/engine/terminal-shell/session-graph-command';
import { createSessionCommands } from '@goodvibes/engine/terminal-shell/session-command';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { exportSavedSession, resumeSavedSession, sessionWorkflow } from './session-workflow.ts';
import { requireBookmarkManager, requireSessionOrchestration, requireShellPaths } from './runtime-services.ts';
import { contentCommands } from './session-content.ts';
import { handleBookmarks, jumpToBookmarkedBlock } from '@goodvibes/engine/terminal-shell/bookmark-command';
import { conversationReading } from './conversation-runtime.ts';
import { localActions } from './local-runtime.ts';
import { commandRefusal } from './confirmation.ts';

const handleGraph = createSessionGraphHandler<CommandContext>(
  requireSessionOrchestration,
  'The cross-session task graph is empty.',
  (ctx) => ctx.session.runtime.sessionId,
  savedSessionName,
);

/** A session of the graph by its saved title, else its whole id. */
function savedSessionName(ctx: CommandContext, id: string): string {
  try {
    const title = ctx.session.sessionManager?.list().find((meta) => meta.name === id)?.title;
    if (title) return `"${title}"`;
  } catch {
    // The id names it when the saved sessions cannot be read.
  }
  return `session ${id}`;
}

const NO_BRANCHES = 'The Agent keeps one line of conversation and no branches. Continue in a copy to try another way: Sessions, "continue in a copy".';

const commands = createSessionCommands<CommandContext>({
  workflow: sessionWorkflow,
  resume: resumeSavedSession,
  exportSaved: exportSavedSession,
  fileExists: (ctx, path) => existsSync(requireShellPaths(ctx).resolveWorkspacePath(path)),
  async saveFile(ctx, input) {
    if (input.format !== 'markdown' && input.format !== 'text') throw commandRefusal('The Agent writes a conversation as Markdown or plain text; nothing was written.');
    if (!input.redact) throw commandRefusal('The Agent always hides keys and paths in a conversation file; nothing was written.');
    if (input.open || input.copy) throw commandRefusal('The Agent does not open or copy a conversation file; nothing was written.');
    return contentCommands.exportConversation(ctx, { format: input.format, path: input.path });
  },
  async upload() {
    throw commandRefusal('The Agent does not upload conversations.', 'Save it as a file: This conversation, "Save or export this conversation as a file".');
  },
  // The Sessions place offers no branch or upload control here (capabilities/builtin/sessions.ts `available`).
  keepsBranches: false,
  uploads: false,
  branches: {
    create() { throw commandRefusal(NO_BRANCHES); },
    list() { throw commandRefusal(NO_BRANCHES); },
    switchTo() { throw commandRefusal(NO_BRANCHES); },
    merge() { throw commandRefusal(NO_BRANCHES); },
  },
  look: {
    async find(ctx, words, kind) {
      await conversationReading.find(ctx, words, kind);
    },
    async jump(ctx, direction, kind) {
      if (kind !== 'error') { await conversationReading.jump(ctx, direction, kind); return; }
      const conversation = ctx.session.conversationManager;
      const line = direction === 'next' ? conversation.nextErrorLine(ctx.getScrollTop?.() ?? 0) : conversation.prevErrorLine(ctx.getScrollTop?.() ?? 0);
      if (line < 0) throw commandRefusal('No error messages in this conversation.');
      ctx.scrollToLine?.(line);
    },
    composer: (ctx) => conversationReading.composer(ctx),
    restored: (ctx) => conversationReading.restored(ctx),
    blocks: (ctx, type, fold) => localActions.toggleBlocks(type, fold, ctx),
    // With a block's key the conversation moves to it; the model asking for the list gets it as words, not a picker on the person's screen.
    bookmarks: (ctx, block, asWords) => block ? jumpToBookmarkedBlock(ctx, () => requireBookmarkManager(ctx), block)
      : handleBookmarks(asWords ? { print: ctx.print } : ctx, () => requireBookmarkManager(ctx)),
    compactions: undefined,
  },
  graphOwnTasksOnly: 'the Agent changes only its own session\'s part of the cross-session task graph (its own tasks, handing them off, what is handed to it or from it); the terminal app changes any session\'s part.',
  graph(ctx, input) {
    handleGraph(input, ctx);
  },
});

export const resumeCommand: SlashCommand = commands.resume;
export const forkCommand: SlashCommand = commands.fork;
/** The Agent's routines for the conversation's record, as its controls take them (session-capabilities.ts). */
export const conversationRecord = commands.record;
/** This app's session routines, as the session capabilities take them (session-capabilities.ts). */
export const liveSessions = commands.live;
