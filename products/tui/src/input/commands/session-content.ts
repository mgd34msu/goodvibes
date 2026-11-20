import { join } from 'path';
import { createUndoCommands, refuseWhileTurnRuns } from '@goodvibes-jev/engine/terminal-shell/everyday-commands';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';
import { templateCommand } from './template-command.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { undoLastRewind, redoLastRewind } from './rewind-runtime.ts';
import { dropFileChange, redoLastFileChange, undoLastFileChange } from '@goodvibes-jev/engine/terminal-shell/recovery-commands';

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(contentCommands.titleCommand);
  registry.register(undoCommands.undo);
  registry.register(undoCommands.redo);



  registry.register(contentCommands.retryCommand);


  registry.register(templateCommand);

  // From the core-verb naming pass (MEMORY fragmentation, worst-class
  // collision #2): this command used to be named /memory, colliding with
  // the agent's /memory (an alias that forwards to /recall, the durable
  // cross-session MemoryStore), same command name, two unrelated features.
  // Renamed to /note (this feature manages EPHEMERAL, session-scoped sticky
  // notes pinned across context compaction, an entirely different resource
  // from /recall's durable records). /memory is now registered as an alias
  // of /recall below (memory.ts), matching the agent, so the word means the
  // same thing on both surfaces. See
  // docs/decisions/2026-07-06-core-verb-spec.md (in the platform repo) for the
  // full writeup.
  registry.register({
    name: 'note',
    // A note is kept exactly as typed.
    rawRest: (args) => ((args[0] ?? '').toLowerCase() === 'add' ? 1 : undefined),
    description: 'Manage session notes (pinned across context compaction)',
    usage: '[list|add <text>|remove <id>]',
    argsHint: '[list|add|remove]',
    handler(args, ctx) {
      const sub = args[0] ?? 'list';
      if (sub === 'list' || args.length === 0) {
        const memories = requireSessionMemoryStore(ctx).list();
        ctx.print(
          memories.length === 0
            ? 'No session notes. Use !# prefix or /note add <text> to create one.'
            : [`Session Notes (${memories.length}):`, ...memories.map((m) => `  [${m.id}] ${m.text}`)].join('\n'),
        );
      } else if (sub === 'add') {
        const text = args.slice(1).join(' ').trim();
        if (!text) {
          ctx.print('Usage: /note add <text>');
          return;
        }
        const id = requireSessionMemoryStore(ctx).add(text);
        ctx.print(`Note added: [${id}] ${text}`);
      } else if (sub === 'remove') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /note remove <id>');
          return;
        }
        const store = requireSessionMemoryStore(ctx);
        ctx.print(store.remove(id) ? `Note removed: [${id}]` : `Note not found: ${id}`);
      } else {
        ctx.print(
          'Usage: /note [list|add <text>|remove <id>]\n  /note              — list all session notes\n  /note list         — list all session notes\n  /note add <text>   — add a note without sending a message\n  /note remove <id>  — remove a specific note',
        );
      }
    },
  });
}

import { createSessionContentCommands } from '@goodvibes-jev/engine/terminal-shell/session-content-commands';
export const contentCommands = createSessionContentCommands<CommandContext, Record<string, unknown>>({
  paths: requireShellPaths,
  capture: (ctx) => (ctx.session.conversationManager.toJSON() as { messages?: Record<string, unknown>[] }).messages ?? [],
  markdown(messages) {
    return messages.map((m) => ({
      role: String(m.role ?? 'user') as 'user' | 'assistant' | 'system' | 'tool',
      content: Array.isArray(m.content)
        ? (m.content as import('@goodvibes-jev/engine/platform/platform/providers').ContentPart[])
        : String(m.content ?? ''),
      toolCalls: m.toolCalls as import('@goodvibes-jev/engine/platform/platform/types').ToolCall[] | undefined,
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
  title: (title) => `Conversation title: ${title}`,
  titleSet: (title) => `Title set to: ${title}`,
  retryRemovesLastTurn: false,
});

/** `/undo` and `/redo` are single-action commands shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const undoCommands = createUndoCommands<CommandContext>({
  async undo(values, ctx) {
    const print = (text: string) => ctx.print(text);
    if (values.what === 'file') { undoLastFileChange(ctx.workspace.fileUndoManager, print); return; }
    if (values.what === 'set-aside') { dropFileChange(ctx.workspace.fileUndoManager, 'undo', print); return; }
    if (values.what === 'rewind')  return (await undoLastRewind(ctx)).message; 
    refuseWhileTurnRuns(ctx, '/undo');
    if (!ctx.session.conversationManager.undo()) throw commandRefusal('There is nothing to undo.', 'To take back the last file write or edit: /undo file');
    ctx.renderRequest();
    return 'Last turn undone; /redo brings it back.';
  },
  async redo(values, ctx) {
    const print = (text: string) => ctx.print(text);
    if (values.what === 'file') { redoLastFileChange(ctx.workspace.fileUndoManager, print); return; }
    if (values.what === 'set-aside') { dropFileChange(ctx.workspace.fileUndoManager, 'redo', print); return; }
    if (values.what === 'rewind')  return (await redoLastRewind(ctx)).message; 
    refuseWhileTurnRuns(ctx, '/redo');
    if (!ctx.session.conversationManager.redo()) throw commandRefusal('There is nothing to redo.', 'To write a reverted file change again: /redo file');
    ctx.renderRequest();
    return 'Turn restored.';
  },
});
