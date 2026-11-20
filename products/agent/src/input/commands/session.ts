/**
 * `/session`, `/resume` and `/save` are one description shared with the other
 * terminal app (terminal-shell/session-command.ts). The Agent resumes, saves,
 * copies and exports sessions as Markdown or text; it reads the cross-session
 * task graph but does not change it, keeps no conversation branches and
 * uploads nothing.
 */
import { existsSync } from 'node:fs';
import { createSessionGraphHandler } from '@goodvibes-jev/engine/terminal-shell/session-graph-command';
import { createSessionCommands } from '@goodvibes-jev/engine/terminal-shell/session-command';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { exportSavedSession, resumeSavedSession, sessionWorkflow } from './session-workflow.ts';
import { requireBookmarkManager, requireSessionOrchestration, requireShellPaths } from './runtime-services.ts';
import { contentCommands } from './session-content.ts';
import { handleBookmarks } from '@goodvibes-jev/engine/terminal-shell/bookmark-command';
import { conversationReading } from './conversation-runtime.ts';
import { localActions } from './local-runtime.ts';
import { commandRefusal } from './confirmation.ts';

const handleGraph = createSessionGraphHandler<CommandContext>(
  requireSessionOrchestration,
  'Task graph is empty.',
  (ctx) => ctx.session.runtime.sessionId,
);

const NO_BRANCHES = 'The Agent keeps one line of conversation and no branches. Save a copy to try another way: /session fork';

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
    throw commandRefusal('The Agent does not upload conversations.', 'Save it as a file: /session save-file');
  },
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
    bookmarks: (ctx) => handleBookmarks(ctx, () => requireBookmarkManager(ctx)),
    compactions: undefined,
  },
  graphReadOnly: 'The Agent reads the cross-session task graph but does not change it; hand work over with /agents hand-off <the work>.',
  graph(ctx, input) {
    handleGraph(input, ctx);
  },
});

export const sessionCommand: SlashCommand = commands.session;
export const resumeCommand: SlashCommand = commands.resume;
export const saveCommand: SlashCommand = commands.save;
