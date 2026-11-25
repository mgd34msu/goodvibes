import { join } from 'path';
import { createRetryCommand, createUndoCommands } from '@goodvibes/engine/terminal-shell/everyday-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

import { extractText } from '@goodvibes/engine/platform/platform/export';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';
import { sessionCapabilityServices } from './session-capabilities.ts';
import { createCheckpointCommand, type CheckpointCommandPolicy } from '@goodvibes/engine/terminal-shell/checkpoint-command';

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

/** The Agent's checkpoints: taken by itself in a registered workspace; it makes none on request and goes back to no turn. */
export const checkpointPolicy: CheckpointCommandPolicy<CommandContext> = {
  emptyHint: 'The Agent takes checkpoints only in a registered workspace (goodvibes-agent workspaces register --yes).',
  make: { refused: 'The Agent takes checkpoints by itself, at the end of each turn, and only in a registered workspace (goodvibes-agent workspaces register --yes); it makes none on request.' },
  rewind: { refused: 'The Agent does not go back to an earlier turn; /undo takes back the last turn.' },
};

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(undoCommands.undo);
  registry.register(undoCommands.redo);

  // `/checkpoint` is one description shared with the terminal app (terminal-shell/checkpoint-command.ts).
  registry.register(createCheckpointCommand<CommandContext>(checkpointPolicy));

  // `/retry` is the capability conversation.retry, run on the Agent's conversation (session-capabilities.ts).
  registry.register(createRetryCommand<CommandContext>(sessionCapabilityServices));
}

import { createSessionContentCommands } from '@goodvibes/engine/terminal-shell/session-content-commands';
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
});

/** `/undo` and `/redo` are single-action commands shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const undoCommands = createUndoCommands<CommandContext>({
  // The capabilities conversation.undo and conversation.redo, run on the Agent's conversation (session-capabilities.ts).
  undo: sessionCapabilityServices,
  redo: sessionCapabilityServices,
});
