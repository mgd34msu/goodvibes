/**
 * Your conversations are one set of session capabilities shared with the
 * other terminal app (terminal-shell/session-command.ts), with `/resume` and
 * `/fork` the two that stay typed. This file holds what the terminal app does
 * for them: its resume routine, its file and upload exports, its conversation
 * branches and the cross-session task graph.
 */
import { existsSync } from 'node:fs';
import { createSessionGraphHandler } from '@goodvibes/engine/terminal-shell/session-graph-command';
import { createSessionCommands } from '@goodvibes/engine/terminal-shell/session-command';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { CommandContext, SlashCommand } from '../command-registry.ts';
import { exportSavedSession, resumeSavedSession, sessionWorkflow } from './session-workflow.ts';
import { requireBookmarkManager, requireSessionOrchestration, requireShellPaths } from './runtime-services.ts';
import { contentCommands } from './session-content.ts';
import { handleBookmarks, jumpToBookmarkedBlock } from '@goodvibes/engine/terminal-shell/bookmark-command';
import { conversationReading } from './conversation-runtime.ts';
import { localActions } from './local-runtime.ts';
import { buildCompactionHistoryText } from '../../renderer/compaction-history-modal.ts';
import { shareConversation } from './share-runtime.ts';

const handleGraph = createSessionGraphHandler<CommandContext>(
  requireSessionOrchestration,
  'The cross-session task graph is empty. Sessions, Hand-offs adds a task.',
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

function refuseWhileGenerating(ctx: CommandContext, what: string): void {
  if (ctx.isGenerating?.()) throw commandRefusal(`A turn is still running, so ${what}.`, 'Stop it with Esc or let it finish, then try again.');
}

const commands = createSessionCommands<CommandContext>({
  workflow: sessionWorkflow,
  resume: resumeSavedSession,
  exportSaved: exportSavedSession,
  fileExists: (ctx, path) => existsSync(requireShellPaths(ctx).resolveWorkspacePath(path)),
  async saveFile(ctx, input) {
    if (input.format === 'text') {
      if (!input.redact) throw commandRefusal('A plain-text file is always written with keys and paths hidden; nothing was written.', 'Choose Markdown, a web page or JSON to keep them.');
      if (input.open || input.copy) throw commandRefusal('A plain-text file is not opened or copied; nothing was written.');
      return contentCommands.exportConversation(ctx, { format: 'text', path: input.path });
    }
    await shareConversation(ctx, { format: input.format === 'markdown' ? 'md' : input.format, path: input.path, redact: input.redact, upload: false, copy: input.copy, open: input.open });
  },
  async upload(ctx, input) {
    await shareConversation(ctx, { format: input.format, path: '', redact: input.redact, upload: true, copy: input.copy, open: input.open });
  },
  branches: {
    create(ctx, name) {
      const conversation = ctx.session.conversationManager;
      if (name && conversation.hasBranch(name)) throw commandRefusal(`Branch "${name}" already exists; it was not replaced.`, 'Pick another name, or switch to it: Sessions, Branches.');
      const branchName = conversation.forkBranch(name || undefined);
      const count = conversation.getMessageCount();
      ctx.print(`Kept branch "${branchName}" (${count} message${count === 1 ? '' : 's'}).`);
    },
    list(ctx) {
      const conversation = ctx.session.conversationManager;
      const branches = conversation.listBranches();
      if (branches.length === 0) { ctx.print('No branches yet. This conversation, "Branch this chat here", keeps one of the conversation as it is now.'); return; }
      ctx.print([`Branches (current: ${conversation.getCurrentBranch()}):`, ...branches.map((branch) => `  ${branch.isCurrent ? '▶' : ' '} ${branch.name}  (${branch.messageCount} message${branch.messageCount === 1 ? '' : 's'})`)].join('\n'));
    },
    switchTo(ctx, name) {
      refuseWhileGenerating(ctx, 'the branch was not switched');
      const conversation = ctx.session.conversationManager;
      if (name === conversation.getCurrentBranch()) throw commandRefusal(`Already on branch "${name}"; nothing changed.`);
      if (!conversation.switchBranch(name)) throw commandRefusal(`No branch is named "${name}".`, 'Sessions, Branches lists them.');
      ctx.print(`Switched to branch "${name}".`);
      ctx.renderRequest();
    },
    merge(ctx, name) {
      refuseWhileGenerating(ctx, 'nothing was merged');
      const conversation = ctx.session.conversationManager;
      if (conversation.checkBranchMerge(name) === 'diverged') {
        throw commandRefusal(`Branch "${name}" and this conversation both changed after the branch was made, so it was not merged.`, 'Switch to it to go on from there: Sessions, Branches.');
      }
      if (!conversation.mergeBranch(name)) throw commandRefusal(`No branch is named "${name}".`, 'Sessions, Branches lists them.');
      ctx.print(`Added the new messages of branch "${name}" to this conversation.`);
      ctx.renderRequest();
    },
  },
  look: {
    async find(ctx, words, kind, options) {
      // The in-place search opens only for the person's press; a model's blank search reads the conversation instead.
      if (!words.trim() && options?.opensScreen !== false && ctx.openTranscriptSearch) { ctx.openTranscriptSearch(); return; }
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
    compactions: (ctx) => { ctx.print(buildCompactionHistoryText()); ctx.renderRequest(); },
  },
  graphOwnTasksOnly: undefined,
  graph(ctx, input) {
    handleGraph(input, ctx);
  },
});

export const resumeCommand: SlashCommand = commands.resume;
export const forkCommand: SlashCommand = commands.fork;
/** This app's routines for the conversation's record, as its controls take them (session-capabilities.ts). */
export const conversationRecord = commands.record;
/** This app's session routines, as the session capabilities take them (session-capabilities.ts). */
export const liveSessions = commands.live;
