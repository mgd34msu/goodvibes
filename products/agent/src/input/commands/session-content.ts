import { createSessionListCommand } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { createSessionSaveCommand, restoreConversationContent } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
import { join } from 'path';
import 'node:fs';
import 'node:fs/promises';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

import { extractText } from '@goodvibes-jev/engine/platform/platform/export';
import { requireSessionManager, requireShellPaths } from './runtime-services.ts';
import { sessionCommand } from './session.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import './confirmation.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';

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
    description: 'Load a saved session',
    usage: '<name>',
    argsHint: '<name>',
    handler(args, ctx) {
      if (!args[0]) {
        ctx.print('Usage: /load <session-name>\nRun /sessions to list available sessions.');
        return;
      }
      const sessionManager = requireSessionManager(ctx);
      try {
        const { meta, messages, agentRecords } = sessionManager.load(args[0]);
        restoreConversationContent(ctx.session.conversationManager, readConversationMessageSnapshots(messages), meta.title);
        ctx.renderRequest();
        ctx.print(
          [
            'Session loaded',
            `  id ${args[0]}`,
            `  messages ${messages.length}`,
            ...(agentRecords.length > 0 ? [`  ignored connected-host records ${agentRecords.length}`] : []),
          ].join('\n'),
        );
      } catch (e) {
        ctx.print(formatSessionFailure('load session', e));
      }
    },
  });

  registry.register({
    name: 'undo',
    aliases: [],
    description: 'Undo the last conversation turn',
    usage: '',
    argsHint: '',
    handler(args, ctx) {
      if (args.length > 0) {
        ctx.print('Usage: /undo\n  Removes the last conversation turn. Use execution action:"recovery" for local file edit undo.');
        return;
      }
      const success = ctx.session.conversationManager.undo();
      if (success) {
        ctx.print('Last turn undone. Use /redo to restore.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to undo.');
      }
    },
  });

  registry.register({
    name: 'redo',
    description: 'Redo the last undone conversation turn',
    usage: '',
    argsHint: '',
    handler(args, ctx) {
      if (args.length > 0) {
        ctx.print('Usage: /redo\n  Restores the last undone conversation turn. Use execution action:"recovery" for local file edit redo.');
        return;
      }
      const success = ctx.session.conversationManager.redo();
      if (success) {
        ctx.print('Turn restored.');
        ctx.renderRequest();
      } else {
        ctx.print('Nothing to redo.');
      }
    },
  });

  registry.register(contentCommands.retryCommand);

  registry.register(sessionsCommand);
}

import { createSessionContentCommands } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
const contentCommands = createSessionContentCommands<CommandContext, ReturnType<typeof getCurrentConversationMessages>[number]>({
  paths: requireShellPaths,
  capture: getCurrentConversationMessages,
  markdown(messages) {
    return [...messages];
  },
  text: (message) => extractText(message.content),
  role: (message) => message.role,
  confirmExport: true,
  invalidPath: 'Error\n  message Export path must be within the current directory.',
  exported: (count, path) => `Exported conversation\n  messages ${count}\n  path ${path}`,
  failed: formatSessionFailure,
  title: (title) => `Conversation title\n  title ${title}`,
  titleSet: (title) => `Title set\n  title ${title}`,
  retryDescription: 'Re-send the last user message',
  retryRemovesLastTurn: true,
});

const saveCommand = createSessionSaveCommand<CommandContext>({
  manager: requireSessionManager,
  messages: (ctx) => ctx.session.conversationManager.getMessageSnapshot(),
  extraMeta: (ctx) => ({ titleSource: ctx.session.conversationManager.getTitleSource() }),
  records: () => undefined,
  description: 'Save current session to .goodvibes/agent/sessions/',
  saved: (rawName, { filePath, sanitizedName }) =>
    [
      'Session saved',
      `  name ${rawName}`,
      ...(sanitizedName !== rawName ? [`  saved as ${sanitizedName}`] : []),
      `  path ${filePath}`,
    ].join('\n'),
  failed: (error) => formatSessionFailure('save session', error),
});

const sessionsCommand = createSessionListCommand<CommandContext>({
  manager: requireSessionManager,
  forward: (args, ctx) => sessionCommand.handler(args, ctx),
  filter: (sessions) => sessions,
  emptyDetail: 'Open Agent Workspace -> Conversation -> Save current session',
  actions: 'Enter to load',
  options: { allowSearch: true },
  selected: (ctx, sessionManager, _sessions, result) => {
    if (!result) return;
    try {
      const { meta, messages } = sessionManager.load(result.item.id);
      restoreConversationContent(ctx.session.conversationManager, readConversationMessageSnapshots(messages), meta.title);
      ctx.renderRequest();
      ctx.print(['Session loaded', `  id ${result.item.id}`, `  messages ${messages.length}`].join('\n'));
    } catch (e) {
      ctx.print(formatSessionFailure('load session', e));
    }
  },
  heading: 'Saved sessions',
});
