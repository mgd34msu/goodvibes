/**
 * `/notes` in the Agent (terminal-shell/notes-command.ts): the scratchpad notes,
 * kept in this Agent's home. A note is working context, not memory and not
 * Agent Knowledge; the "Make a … from a note" actions turn one into a memory
 * record, a persona, a skill or a routine, or add its web page to Agent
 * Knowledge, and the note records what was made from it.
 */
import { AgentNoteRegistry, type AgentNoteRecord } from '@goodvibes/engine/terminal-shell/agent-turn/note-registry';
import { AgentPersonaRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/persona-registry';
import { AgentSkillRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/skill-registry';
import { AgentRoutineRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/routine-registry';
import { formatAgentRecordReviewState } from '@goodvibes/engine/terminal-shell/agent-turn/record-labels';
import { assertActorMayEnable } from '@goodvibes/engine/terminal-shell/agent-turn/review-authority';
import { describedCommandByName, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { createNotesCommand, noteTitleFromText, type NotesActionId } from '@goodvibes/engine/terminal-shell/notes-command';
import type { MemoryClass, MemoryScope } from '@goodvibes/engine/platform/platform/state';
import { readRefusal } from '@goodvibes/engine/errors';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { splitWords } from './owner-tool-call.ts';

function notesOf(ctx: CommandContext): AgentNoteRegistry {
  return AgentNoteRegistry.fromShellPaths(requireShellPaths(ctx));
}

/** Run one step against a local store; a failure that is not a refusal is reported as one. */
function step<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

function noteOrRefuse(ctx: CommandContext, idOrTitle: string): AgentNoteRecord {
  const note = notesOf(ctx).get(idOrTitle);
  if (!note) throw commandRefusal(`No note ${idOrTitle}.`, '/notes list shows them.');
  return note;
}

function summarize(note: AgentNoteRecord): string {
  const source = note.sourceUrl ? `  ${note.sourceUrl}` : '';
  const tags = note.tags.length > 0 ? `  tags ${note.tags.join(', ')}` : '';
  return `  ${note.id}  ${formatAgentRecordReviewState(note.reviewState)}  ${note.title}${source}${tags}`;
}

function renderList(title: string, notes: readonly AgentNoteRecord[]): string {
  if (notes.length === 0) return `${title}\n  No notes yet. Write one: /notes create <text>.`;
  return [`${title} (${notes.length})`, ...notes.map(summarize)].join('\n');
}

function renderNote(note: AgentNoteRecord): string {
  const made = (note.promoted ?? []).map((entry) => `${entry.domain} ${entry.id}`).join(', ');
  return [
    `Note ${note.title}`,
    `  id ${note.id}`,
    `  review: ${formatAgentRecordReviewState(note.reviewState)}`,
    note.staleReason ? `  out of date because: ${note.staleReason}` : '',
    `  web page: ${note.sourceUrl ?? '(none)'}`,
    `  tags: ${note.tags.join(', ') || '(none)'}`,
    made ? `  made from it: ${made}` : '',
    `  updated: ${note.updatedAt}`,
  ].filter(Boolean).concat('', note.body).join('\n');
}

/** The first sentence of the note, as a one-line summary of what was made from it. */
function noteSummary(note: AgentNoteRecord): string {
  const compact = note.body.replace(/\s+/g, ' ').trim();
  const first = compact.split(/(?<=[.!?])\s+/)[0]?.trim() ?? compact;
  return (first.length > 160 ? `${first.slice(0, 157)}...` : first) || note.title;
}

function noteTags(note: AgentNoteRecord): string[] {
  return [...new Set([...note.tags, 'from-note'])];
}

/** A record of that kind already made from this note: making another is refused. */
function refuseIfMade(note: AgentNoteRecord, domain: 'memory' | 'persona' | 'skill' | 'routine', command: string): void {
  const made = (note.promoted ?? []).find((entry) => entry.domain === domain);
  if (made) throw commandRefusal(`Note ${note.id} already made ${domain} ${made.id}; nothing new was made.`, `Change that one with ${command}.`);
}

type Run = (values: Readonly<Record<string, string>>, ctx: CommandContext) => Promise<string>;

const run: Readonly<Record<NotesActionId, Run>> = {
  async list(_values, ctx) { return renderList('Notes', notesOf(ctx).list()); },
  async show(values, ctx) { return renderNote(noteOrRefuse(ctx, values.note!)); },
  async search(values, ctx) { return renderList(`Notes matching "${values.words}"`, notesOf(ctx).search(values.words!)); },
  async create(values, ctx) {
    const note = step(() => notesOf(ctx).create({ title: values.title || noteTitleFromText(values.body!), body: values.body!, tags: splitWords(values.tags), sourceUrl: values.url || undefined, source: 'user', provenance: 'Command' }));
    return `Wrote note ${note.id} (${note.title}).`;
  },
  async edit(values, ctx) {
    const note = step(() => notesOf(ctx).update(values.note!, {
      title: values.title || undefined, body: values.body || undefined, sourceUrl: values.url || undefined,
      tags: values.tags ? splitWords(values.tags) : undefined, provenance: 'Command',
    }));
    return `Changed note ${note.id} (${note.title}).`;
  },
  async review(values, ctx) { const note = step(() => notesOf(ctx).markReviewed(values.note!)); return `Marked note ${note.id} reviewed.`; },
  async stale(values, ctx) { const note = step(() => notesOf(ctx).markStale(values.note!, values.reason!)); return `Marked note ${note.id} out of date.`; },
  async delete(values, ctx) { const note = step(() => notesOf(ctx).deleteNote(values.note!)); return `Deleted note ${note.id} (${note.title}).`; },
  async 'to-memory'(values, ctx) {
    const note = noteOrRefuse(ctx, values.note!);
    refuseIfMade(note, 'memory', '/memory edit');
    const spine = ctx.clients?.memorySpine;
    if (!spine) throw commandRefusal('Memory is not available in this session; nothing was kept.', 'Restart the Agent; memory loads with it.');
    const record = await spine.add({
      scope: (values.scope || 'project') as MemoryScope, cls: (values.class || 'fact') as MemoryClass, summary: note.title,
      detail: note.sourceUrl ? `${note.body}\n\nOrigin URL: ${note.sourceUrl}` : note.body, tags: noteTags(note),
      provenance: [...(ctx.session.runtime.sessionId ? [{ kind: 'session' as const, ref: ctx.session.runtime.sessionId }] : [])],
    });
    step(() => notesOf(ctx).recordPromotion(note.id, { domain: 'memory', id: record.id }));
    return `Kept note ${note.id} as memory record ${record.id}.`;
  },
  async 'to-persona'(values, ctx) {
    const note = noteOrRefuse(ctx, values.note!);
    refuseIfMade(note, 'persona', '/personas update');
    const persona = step(() => AgentPersonaRegistry.fromShellPaths(requireShellPaths(ctx)).create({
      name: note.title, description: noteSummary(note), body: note.body, tags: noteTags(note), triggers: [], source: 'user', provenance: `Note ${note.id}`,
    }));
    step(() => notesOf(ctx).recordPromotion(note.id, { domain: 'persona', id: persona.id }));
    return `Made persona ${persona.id} from note ${note.id}. Use it with /personas use ${persona.id}.`;
  },
  async 'to-skill'(values, ctx) {
    const note = noteOrRefuse(ctx, values.note!);
    refuseIfMade(note, 'skill', '/my-skills update');
    if (values.enabled === 'yes') assertActorMayEnable(ctx.invokedByModel === true ? 'model' : 'owner', 'skill', note.title, 'fresh');
    const skill = step(() => AgentSkillRegistry.fromShellPaths(requireShellPaths(ctx)).create({
      name: note.title, description: noteSummary(note), procedure: note.body, tags: noteTags(note), triggers: [],
      enabled: values.enabled === 'yes', source: 'user', provenance: `Note ${note.id}`,
    }));
    step(() => notesOf(ctx).recordPromotion(note.id, { domain: 'skill', id: skill.id }));
    return `Made skill ${skill.id} from note ${note.id}${values.enabled === 'yes' ? ', switched on' : '; switch it on with /my-skills enable'}.`;
  },
  async 'to-routine'(values, ctx) {
    const note = noteOrRefuse(ctx, values.note!);
    refuseIfMade(note, 'routine', '/routines update');
    if (values.enabled === 'yes') assertActorMayEnable(ctx.invokedByModel === true ? 'model' : 'owner', 'routine', note.title, 'fresh');
    const routine = step(() => AgentRoutineRegistry.fromShellPaths(requireShellPaths(ctx)).create({
      name: note.title, description: noteSummary(note), steps: note.body, tags: noteTags(note), triggers: [],
      enabled: values.enabled === 'yes', source: 'user', provenance: `Note ${note.id}`,
    }));
    step(() => notesOf(ctx).recordPromotion(note.id, { domain: 'routine', id: routine.id }));
    return `Made routine ${routine.id} from note ${note.id}${values.enabled === 'yes' ? ', switched on' : '; switch it on with /routines enable'}.`;
  },
  async 'to-knowledge'(values, ctx) {
    const note = noteOrRefuse(ctx, values.note!);
    const url = note.sourceUrl?.trim();
    if (!url) throw commandRefusal(`Note ${note.id} names no web page; nothing was added.`, `Give it one: /notes edit ${note.id} --url <address>`);
    const ingest = describedCommandByName('knowledge')?.actions.find((action) => action.id === 'ingest-url');
    if (!ingest) throw commandRefusal('Agent Knowledge is not available in this Agent; nothing was added.');
    // The same action /knowledge ingest-url runs, with the note's page.
    const out = await (ingest.run as (values: Readonly<Record<string, string>>, context: CommandContext) => ReturnType<NonNullable<typeof ingest>['run']>)({ url, tags: noteTags(note).join(', '), folder: 'notes' }, ctx);
    return typeof out === 'string' ? out : `Added ${url} to Agent Knowledge.`;
  },
};

/** `/notes` is one description shared with the other terminal app (terminal-shell/notes-command.ts). */
export function registerNotesRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createNotesCommand<CommandContext>({
    rows: (ctx) => notesOf(ctx).list().map((note): ListRow => ({ value: note.id, label: note.title, detail: noteSummary(note), state: formatAgentRecordReviewState(note.reviewState) })),
    run,
  }));
}
