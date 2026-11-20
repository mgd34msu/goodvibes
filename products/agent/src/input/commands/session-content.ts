import { createSessionListCommand } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { join } from 'path';
import 'node:fs';
import 'node:fs/promises';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

import { extractText } from '@goodvibes-jev/engine/platform/platform/export';
import { requireSessionManager, requireShellPaths } from './runtime-services.ts';
import { sessionCommand } from './session.ts';
import { saveCommand } from './session-workflow.ts';
import { loadSavedSessionIntoLive } from './session-load.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import './confirmation.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';
import { createCheckpointsCommand, dropFileChange, redoLastFileChange, undoLastFileChange } from '@goodvibes-jev/engine/terminal-shell/recovery-commands';

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
  registry.register(contentCommands.exportCommand);

  registry.register(contentCommands.titleCommand);

  registry.register(saveCommand);

  registry.register({
    name: 'load',
    effect: 'session-lifecycle',
    description: 'Load a saved session',
    usage: '<name>',
    argsHint: '<name>',
    async handler(args, ctx) {
      if (!args[0]) {
        throw commandRefusal('Usage: /load <session-name>\nRun /sessions to list available sessions.');
      }
      const sessionManager = requireSessionManager(ctx);
      try {
        const loaded = await loadSavedSessionIntoLive(ctx, sessionManager, args[0]);
        ctx.renderRequest();
        ctx.print(
          [
            'Session loaded',
            `  id ${args[0]}`,
            `  messages ${loaded.messageCount}`,
            ...(loaded.agentRecordCount > 0 ? [`  ignored connected-host records ${loaded.agentRecordCount}`] : []),
            ...(loaded.restoredAnchorCount > 0 ? [`  rewind points ${loaded.restoredAnchorCount} restored`] : []),
            ...loaded.notices.map((line) => `  ${line}`),
          ].join('\n'),
        );
      } catch (e) {
        throw commandRefusal(formatSessionFailure('load session', e));
      }
    },
  });

  registry.register({
    name: 'undo',
    effect: 'session-lifecycle',
    aliases: [],
    description: 'Undo the last conversation turn. /undo file reverts every file the last write/edit call changed (/undo file drop sets aside an entry a later change blocks)',
    usage: '[file [drop]]',
    argsHint: '[file]',
    subcommands: { file: '' },
    handler(args, ctx) {
      if (args[0] === 'file' && args.length === 1) {
        undoLastFileChange(ctx.workspace.fileUndoManager, (text) => ctx.print(text));
        return;
      }
      if (args[0] === 'file' && args[1] === 'drop' && args.length === 2) {
        dropFileChange(ctx.workspace.fileUndoManager, 'undo', (text) => ctx.print(text));
        return;
      }
      if (args.length > 0) {
        throw commandRefusal('Usage: /undo [file [drop]]\n  /undo removes the last conversation turn; /undo file reverts every file the last write/edit call changed; /undo file drop sets that entry aside without changing a file.');
      }
      if (ctx.isGenerating?.()) {
        ctx.print('A turn is still running. Stop it with Esc or let it finish, then /undo.');
        return;
      }
      const success = ctx.session.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore. Tip: /undo file to revert a file write/edit.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo. Tip: use /undo file to revert the last file write/edit.');
      }
    },
  });

  registry.register({
    name: 'redo',
    effect: 'session-lifecycle',
    description: 'Redo the last undone conversation turn. /redo file re-applies the last reverted file change (/redo file drop sets aside an entry a later change blocks)',
    usage: '[file [drop]]',
    argsHint: '[file]',
    subcommands: { file: '' },
    handler(args, ctx) {
      if (args[0] === 'file' && args.length === 1) {
        redoLastFileChange(ctx.workspace.fileUndoManager, (text) => ctx.print(text));
        return;
      }
      if (args[0] === 'file' && args[1] === 'drop' && args.length === 2) {
        dropFileChange(ctx.workspace.fileUndoManager, 'redo', (text) => ctx.print(text));
        return;
      }
      if (args.length > 0) {
        throw commandRefusal('Usage: /redo [file [drop]]\n  /redo restores the last undone conversation turn; /redo file re-applies the last reverted file change; /redo file drop sets that entry aside without changing a file.');
      }
      if (ctx.isGenerating?.()) {
        ctx.print('A turn is still running. Stop it with Esc or let it finish, then /redo.');
        return;
      }
      const success = ctx.session.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored. Tip: /redo file to re-apply a reverted file.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo. Tip: use /redo file to re-apply the last reverted file.');
      }
    },
  });

  // /checkpoints and /checkpoints restore: the same lines the terminal app runs.
  registry.register(createCheckpointsCommand<CommandContext>({
    manager: (ctx) => ctx.workspace.workspaceCheckpointManager,
    record: (ctx, text) => ctx.print(text),
    emptyHint: 'The Agent takes checkpoints only in a registered workspace (goodvibes-agent workspaces register --yes).',
    listFooter: '',
  }));

  registry.register(contentCommands.retryCommand);

  registry.register(sessionsCommand);
}

import { createSessionContentCommands } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { commandRefusal } from './confirmation.ts';
const contentCommands = createSessionContentCommands<CommandContext, ReturnType<typeof getCurrentConversationMessages>[number]>({
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
  retryDescription: 'Re-send the last user message',
  retryRemovesLastTurn: true,
});

const sessionsCommand = createSessionListCommand<CommandContext>({
  manager: requireSessionManager,
  forward: (args, ctx) => sessionCommand.handler(args, ctx),
  emptyDetail: 'Open Agent Workspace -> Conversation -> Save current session',
  actions: 'Enter to load',
  options: { allowSearch: true },
  selected: (ctx, sessionManager, _sessions, result) => {
    if (!result) return;
    void loadSavedSessionIntoLive(ctx, sessionManager, result.item.id).then((loaded) => {
      ctx.renderRequest();
      ctx.print(['Session loaded', `  id ${result.item.id}`, `  messages ${loaded.messageCount}`, ...loaded.notices.map((line) => `  ${line}`)].join('\n'));
    }, (e: unknown) => {
      ctx.print(formatSessionFailure('load session', e));
    });
  },
  heading: 'Saved sessions',
});
