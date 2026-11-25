import { join } from 'path';
import { createUndoCommands, refuseWhileTurnRuns } from '@goodvibes/engine/terminal-shell/everyday-commands';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireSessionMemoryStore, requireShellPaths } from './runtime-services.ts';
import { createNotesCommand } from '@goodvibes/engine/terminal-shell/notes-command';
import type { MemoryClass, MemoryScope } from '@goodvibes/engine/platform/platform/state';
import { buildPinSuccessText } from '../../renderer/compaction-preview.ts';
import { templateCommand } from './template-command.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { redoLastRewind } from './rewind-runtime.ts';
import { dropFileChange, redoLastFileChange } from '@goodvibes/engine/terminal-shell/recovery-commands';
import { sessionCapabilityServices } from './session-capabilities.ts';

export function registerSessionContentCommands(registry: CommandRegistry): void {
  registry.register(contentCommands.titleCommand);
  registry.register(undoCommands.undo);
  registry.register(undoCommands.redo);



  registry.register(contentCommands.retryCommand);


  registry.register(templateCommand);

  // `/notes` is one description shared with the Agent (terminal-shell/notes-command.ts).
  registry.register(notesCommand);
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
  title: (title) => `Conversation title: ${title}`,
  titleSet: (title) => `Title set to: ${title}`,
  retryRemovesLastTurn: false,
});

/** `/undo` and `/redo` are single-action commands shared with the other terminal app (terminal-shell/everyday-commands.ts). */
const undoCommands = createUndoCommands<CommandContext>({
  // The capability conversation.undo, run on this app's conversation (session-capabilities.ts).
  undo: sessionCapabilityServices,
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

/** A session note found by its id, or by text that names it; refused when none matches. */
function sessionNote(ctx: CommandContext, ref: string): { readonly id: string; readonly text: string } {
  const notes = requireSessionMemoryStore(ctx).list();
  const wanted = ref.trim().toLowerCase();
  const note = notes.find((entry) => entry.id === ref) ?? notes.find((entry) => entry.text.toLowerCase().startsWith(wanted));
  if (!note) throw commandRefusal(`No note ${ref}.`, '/notes list shows them.');
  return note;
}

/** The text a note is kept as: its title, its text, its web page and its tags on one line. */
function sessionNoteText(values: Readonly<Record<string, string>>, body: string): string {
  const tags = (values.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
  return `${values.title ? `${values.title}: ` : ''}${body}${values.url ? ` <${values.url}>` : ''}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}`;
}

const NO_REVIEW = { refused: 'Notes in the terminal app last for this session and have no review state.', instead: 'Change one with /notes edit, or keep it for good with /notes to-memory.' } as const;
const AGENT_ONLY = { refused: 'Personas, skills and routines made from a note, and Agent Knowledge, are the Agent\'s.', instead: 'Keep the note as a memory instead: /notes to-memory' } as const;

/** `/notes` in the terminal app: the session's notes, which the model keeps seeing after a compaction (prefix a message with !# to write one too). */
const notesCommand = createNotesCommand<CommandContext>({
  rows: (ctx) => (ctx.session.sessionMemoryStore?.list() ?? []).map((note) => ({ value: note.id, label: note.text.slice(0, 60), detail: note.text })),
  run: {
    async list(_values, ctx) {
      const notes = requireSessionMemoryStore(ctx).list();
      return notes.length === 0
        ? 'Notes\n  No notes yet. Write one: /notes create <text>, or start a message with !#.'
        : [`Notes (${notes.length}), kept for this session:`, ...notes.map((note) => `  ${note.id}  ${note.text}`)].join('\n');
    },
    async show(values, ctx) { const note = sessionNote(ctx, values.note!); return `Note ${note.id}\n\n${note.text}`; },
    async search(values, ctx) {
      const words = values.words!.toLowerCase();
      const found = requireSessionMemoryStore(ctx).list().filter((note) => note.text.toLowerCase().includes(words));
      return found.length === 0 ? `No note mentions "${values.words}".` : [`Notes matching "${values.words}" (${found.length})`, ...found.map((note) => `  ${note.id}  ${note.text}`)].join('\n');
    },
    async create(values, ctx) {
      const store = requireSessionMemoryStore(ctx);
      const text = sessionNoteText(values, values.body!.trim());
      const id = store.add(text);
      if (!id) throw commandRefusal('The note was empty, so nothing was kept.');
      ctx.renderRequest();
      return buildPinSuccessText(id, text, store.list().length);
    },
    async edit(values, ctx) {
      const note = sessionNote(ctx, values.note!);
      const text = values.body || values.title || values.url || values.tags ? sessionNoteText(values, values.body || note.text) : note.text;
      if (!requireSessionMemoryStore(ctx).update(note.id, text)) throw commandRefusal(`Note ${note.id} was not changed.`);
      return `Changed note ${note.id}.`;
    },
    review: NO_REVIEW,
    stale: NO_REVIEW,
    async delete(values, ctx) {
      const note = sessionNote(ctx, values.note!);
      requireSessionMemoryStore(ctx).remove(note.id);
      return `Deleted note ${note.id}.`;
    },
    async 'to-memory'(values, ctx) {
      const note = sessionNote(ctx, values.note!);
      const spine = ctx.clients?.memorySpine;
      if (!spine) throw commandRefusal('Memory is not available in this session; nothing was kept.');
      const summary = note.text.split(/(?<=[.!?])\s+/)[0]!.slice(0, 160);
      const record = await spine.add({
        scope: (values.scope || 'project') as MemoryScope, cls: (values.class || 'fact') as MemoryClass, summary, detail: note.text, tags: ['from-note'],
        provenance: [{ kind: 'session' as const, ref: ctx.session.runtime.sessionId }],
      });
      return `Kept note ${note.id} as memory record ${record.id}.`;
    },
    'to-persona': AGENT_ONLY,
    'to-skill': AGENT_ONLY,
    'to-routine': AGENT_ONLY,
    'to-knowledge': AGENT_ONLY,
  },
});
