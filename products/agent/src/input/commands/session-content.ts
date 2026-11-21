import { join } from 'path';
import { createUndoCommands, refuseWhileTurnRuns } from '@goodvibes/engine/terminal-shell/everyday-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

import { extractText } from '@goodvibes/engine/platform/platform/export';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';
import { dropFileChange, redoLastFileChange, undoLastFileChange } from '@goodvibes/engine/terminal-shell/recovery-commands';
import { createCheckpointCommand } from '@goodvibes/engine/terminal-shell/checkpoint-command';

function formatSessionFailure(action: string, error: unknown): string {
  return [`Failed to ${action}`, `  error ${summarizeError(error)}`].join('\n');
}

type ConversationSnapshotReader = {
  readonly getMessageSnapshot?: () => ReturnType<typeof readConversationMessageSnapshots>;
  readonly toJSON?: () => unknown;
};

function isObjectArray(value: unknown): value is readonly object[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'object' && entry !== null);
}

function getCurrentConversationMessages(ctx: CommandContext): ReturnType<typeof readConversationMessageSnapshots> {
  const manager = ctx.session.conversationManager as unknown as ConversationSnapshotReader;
  if (typeof manager.getMessageSnapshot === 'function') return manager.getMessageSnapshot();
  if (typeof manager.toJSON === 'function') {
    const serialized = manager.toJSON();
    if (serialized && typeof serialized === 'object' && 'messages' in serialized) {
      const messages = (serialized as { readonly messages?: unknown }).messages;
      if (isObjectArray(messages)) return readConversationMessageSnapshots(messages);
    }
  }
  throw new Error('Conversation manager cannot export message snapshots.');
}

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(contentCommands.titleCommand);
  registry.register(undoCommands.undo);
  registry.register(undoCommands.redo);



  // `/checkpoint` is one description shared with the terminal app (terminal-shell/checkpoint-command.ts).
  registry.register(createCheckpointCommand<CommandContext>({
    record: (ctx, text) => ctx.print(text),
    emptyHint: 'The Agent takes checkpoints only in a registered workspace (goodvibes-agent workspaces register --yes).',
    make: { refused: 'The Agent takes checkpoints by itself, at the end of each turn, and only in a registered workspace (goodvibes-agent workspaces register --yes); it makes none on request.' },
    rewind: { refused: 'The Agent does not go back to an earlier turn; /undo takes back the last turn.' },
  }));

  registry.register(contentCommands.retryCommand);

}

import { createSessionContentCommands } from '@goodvibes/engine/terminal-shell/session-content-commands';
import { commandRefusal } from './confirmation.ts';
export const contentCommands = createSessionContentCommands<CommandContext, ReturnType<typeof getCurrentConversationMessages>[number]>({
  paths: requireShellPaths,
  capture: getCurrentConversationMessages,
  markdown(messages) {
    return [...messages];
  },
  text: (message) => extractText(message.content),
  role: (message) => message.role,
  invalidPath: 'Error\n  message Export path must be within the current directory.',
  exported: (count, path) => `Exported conversation\n  messages ${count}\n  path ${path}`,
  failed: formatSessionFailure,
  title: (title) => `Conversation title\n  title ${title}`,
  titleSet: (title) => `Title set\n  title ${title}`,
  retryRemovesLastTurn: true,
});

/** `/undo` and `/redo` are single-action commands shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const undoCommands = createUndoCommands<CommandContext>({
  async undo(values, ctx) {
    const print = (text: string) => ctx.print(text);
    if (values.what === 'file') { undoLastFileChange(ctx.workspace.fileUndoManager, print); return; }
    if (values.what === 'set-aside') { dropFileChange(ctx.workspace.fileUndoManager, 'undo', print); return; }
    if (values.what === 'rewind') throw commandRefusal('The Agent has no rewind to undo: /checkpoint rewind goes back to a turn only in the terminal app.');
    refuseWhileTurnRuns(ctx, '/undo');
    if (!ctx.session.conversationManager.undo()) throw commandRefusal('There is nothing to undo.', 'To take back the last file write or edit: /undo file');
    ctx.renderRequest();
    return 'Last turn undone; /redo brings it back.';
  },
  async redo(values, ctx) {
    const print = (text: string) => ctx.print(text);
    if (values.what === 'file') { redoLastFileChange(ctx.workspace.fileUndoManager, print); return; }
    if (values.what === 'set-aside') { dropFileChange(ctx.workspace.fileUndoManager, 'redo', print); return; }
    if (values.what === 'rewind') throw commandRefusal('The Agent has no rewind to redo: /checkpoint rewind goes back to a turn only in the terminal app.');
    refuseWhileTurnRuns(ctx, '/redo');
    if (!ctx.session.conversationManager.redo()) throw commandRefusal('There is nothing to redo.', 'To write a reverted file change again: /redo file');
    ctx.renderRequest();
    return 'Turn restored.';
  },
});
