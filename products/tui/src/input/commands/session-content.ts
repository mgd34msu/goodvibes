import { join } from 'path';
import { createRetryCommand, createUndoCommands } from '@goodvibes/engine/terminal-shell/everyday-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
// Through its slot: session-capabilities.ts imports session.ts, which imports this file (session-capability-slots.ts).
import { sessionServicesOf as sessionCapabilityServices } from './session-capability-slots.ts';

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(undoCommands.undo);
  registry.register(undoCommands.redo);

  // `/retry` is the capability conversation.retry, run on this app's conversation (session-capabilities.ts).
  registry.register(createRetryCommand<CommandContext>(sessionCapabilityServices));
  // Notes, personas, routines, saved artifacts and drafts are the daemon's, controls in the Memory and knowledge place.
}

import { createSessionContentCommands } from '@goodvibes/engine/terminal-shell/session-content-commands';
export const contentCommands = createSessionContentCommands<CommandContext, Record<string, unknown>>({
  paths: requireShellPaths,
  capture: (ctx) => (ctx.session.conversationManager.toJSON() as { messages?: Record<string, unknown>[] }).messages ?? [],
  markdown(messages) {
    return messages.map((m) => ({
      role: String(m.role ?? 'user') as 'user' | 'assistant' | 'system' | 'tool',
      content: Array.isArray(m.content)
        ? (m.content as import('@goodvibes/engine/platform/platform/providers').ContentPart[])
        : String(m.content ?? ''),
      toolCalls: m.toolCalls as import('@goodvibes/engine/platform/platform/types').ToolCall[] | undefined,
      callId: m.callId as string | undefined,
      toolName: m.toolName as string | undefined,
      reasoningContent: m.reasoningContent as string | undefined,
      reasoningSummary: m.reasoningSummary as string | undefined,
      usage: m.usage as { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined,
    }));
  },
  text: (message) => (typeof message.content === 'string' ? message.content : ''),
  role: (message) => String(message.role ?? 'unknown'),
  invalidPath: 'Error: Export path must be within the current directory.',
  exported: (count, path) => `Exported ${count} messages to: ${path}`,
  failed: (_action, error) => 'Export failed: ' + summarizeError(error),
});

/** `/undo` and `/redo` are single-action commands shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const undoCommands = createUndoCommands<CommandContext>({
  // The capabilities conversation.undo and conversation.redo, run on this app's conversation (session-capabilities.ts).
  undo: sessionCapabilityServices,
  redo: sessionCapabilityServices,
});

