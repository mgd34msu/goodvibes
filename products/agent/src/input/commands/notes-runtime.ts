/**
 * `/notes`, described once (command-actions/): the Agent's scratchpad notes,
 * kept in this Agent's home. A note is working context, not memory and not
 * Agent Knowledge; the "Make a … from a note" actions turn one into a memory
 * record, a persona, a skill or a routine, or add its web page to Agent
 * Knowledge, and the note records what was made from it.
 */
import { AgentNoteRegistry, type AgentNoteRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn/note-registry';
import { AgentPersonaRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/persona-registry';
import { AgentSkillRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/skill-registry';
import { AgentRoutineRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/routine-registry';
import { formatAgentRecordReviewState } from '@goodvibes-jev/engine/terminal-shell/agent-turn/record-labels';
import { assertActorMayEnable } from '@goodvibes-jev/engine/terminal-shell/agent-turn/review-authority';
import { defineCommand, defineList, describedCommandByName, type ActionDescription, type FixedChoice, type InputDescription, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import type { MemoryClass, MemoryScope } from '@goodvibes-jev/engine/platform/platform/state';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { splitWords } from './owner-tool-call.ts';

const LOCAL_ONLY = { terminalOnly: 'Notes are kept in this Agent\'s home.' } as const;

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
  if (notes.length === 0) return `${title}\n  No notes yet. Write one: /notes create --title <title> <text>.`;
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

const NOTES = defineList<CommandContext>({
  name: 'notes',
  async read(ctx) {
    return notesOf(ctx).list().map((note): ListRow => ({ value: note.id, label: note.title, detail: noteSummary(note), state: formatAgentRecordReviewState(note.reviewState) }));
  },
  operator: LOCAL_ONLY,
});

const NOTE: InputDescription = listInput({ id: 'note', label: 'Note', help: 'Your notes', list: NOTES, other: 'a note id or title' });
const ENABLE: InputDescription = choiceInput({
  id: 'enabled', label: 'Switch it on', help: 'At once, or after you review it',
  choices: [{ value: 'no', label: 'After I review it' }, { value: 'yes', label: 'At once' }],
  typed: { flag: '--enable', switchOn: 'yes' }, optional: { default: 'no', means: 'after you review it' },
});
const MEMORY_KINDS: readonly FixedChoice[] = [
  { value: 'fact', label: 'A fact' }, { value: 'decision', label: 'A decision' }, { value: 'constraint', label: 'A constraint' },
  { value: 'pattern', label: 'A pattern' }, { value: 'runbook', label: 'A runbook' }, { value: 'risk', label: 'A risk' },
  { value: 'incident', label: 'An incident' }, { value: 'architecture', label: 'Architecture' }, { value: 'ownership', label: 'Who owns what' },
];
const MEMORY_SCOPES: readonly FixedChoice[] = [
  { value: 'project', label: 'This project' }, { value: 'session', label: 'This session' }, { value: 'team', label: 'Shared with the team' },
];

type NoteAction = ActionDescription<CommandContext>;
function change(fields: Pick<NoteAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example' | 'run'> & Partial<Pick<NoteAction, 'risk' | 'undoneBy' | 'lasts' | 'operator'>>): NoteAction {
  return { done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ...fields };
}

export function registerNotesRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'notes',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Notes',
    summary: 'Your scratchpad notes: working context you can later keep as memory, a persona, a skill or a routine',
    group: 'Agent',
    report: 'list',
    firstScreenRows: [
      'list', 'create', 'show', 'search',
      { label: 'Change a note…', actions: ['edit', 'review', 'stale', 'delete'] },
      { label: 'Make something from a note…', actions: ['to-memory', 'to-persona', 'to-skill', 'to-routine', 'to-knowledge'] },
    ],
    actions: [
      readAction<CommandContext>({
        id: 'list', label: 'See your notes', word: 'list', operator: LOCAL_ONLY,
        sentence: 'Lists your notes, newest last, with whether you reviewed each.',
        async rowValue(ctx) { const count = notesOf(ctx).list().length; return count === 1 ? '1 note' : `${count} notes`; },
        async run(_values, ctx) { return renderList('Notes', notesOf(ctx).list()); },
      }),
      readAction<CommandContext>({
        id: 'show', label: 'Read one note', word: 'show', inputs: [NOTE], operator: LOCAL_ONLY,
        sentence: 'Shows note {note} in full, with what was made from it.', example: { note: 'vendor-call' },
        async run(values, ctx) { return renderNote(noteOrRefuse(ctx, values.note!)); },
      }),
      readAction<CommandContext>({
        id: 'search', label: 'Find a note', word: 'search', operator: LOCAL_ONLY,
        inputs: [textInput({ id: 'words', label: 'Words', help: 'What to look for in titles, text, tags and web pages', why: 'your own words', typed: { tail: true } })],
        sentence: 'Lists the notes that mention {words}.', example: { words: 'vendor' },
        async run(values, ctx) { return renderList(`Notes matching "${values.words}"`, notesOf(ctx).search(values.words!)); },
      }),
      change({
        id: 'create', label: 'Write a note', word: 'create',
        inputs: [
          textInput({ id: 'title', label: 'Title', help: 'What it is called', why: 'your own words', typed: { flag: '--title' } }),
          textInput({ id: 'body', label: 'Text', help: 'What you want to keep for now', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          textInput({ id: 'url', label: 'Web page', help: 'The page it is about, if any', why: 'a web address', typed: { flag: '--url' }, optional: { default: '', means: 'none' } }),
          textInput({ id: 'tags', label: 'Tags', help: 'Words to find it by, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: { default: '', means: 'none' } }),
        ],
        sentence: 'A note "{title}" is kept with the text "{body}", until you change it.', example: { title: 'Vendor call', body: 'They can ship in May.' },
        undoneBy: 'delete',
        async run(values, ctx) {
          const note = step(() => notesOf(ctx).create({ title: values.title!, body: values.body!, tags: splitWords(values.tags), sourceUrl: values.url || undefined, source: 'user', provenance: 'Command' }));
          return `Wrote note ${note.id} (${note.title}).`;
        },
      }),
      change({
        id: 'edit', label: 'Change a note', word: 'edit',
        inputs: [
          NOTE,
          textInput({ id: 'title', label: 'Title', help: 'A new title', why: 'your own words', typed: { flag: '--title' }, optional: { default: '', means: 'keep it' } }),
          textInput({ id: 'body', label: 'Text', help: 'New text', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'keep it' } }),
          textInput({ id: 'url', label: 'Web page', help: 'A new web page', why: 'a web address', typed: { flag: '--url' }, optional: { default: '', means: 'keep it' } }),
          textInput({ id: 'tags', label: 'Tags', help: 'New tags, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: { default: '', means: 'keep them' } }),
        ],
        sentence: 'Note {note} takes the changes given and is no longer marked reviewed, until you change it.', example: { note: 'vendor-call', body: 'They can ship in June.' },
        async run(values, ctx) {
          const note = step(() => notesOf(ctx).update(values.note!, {
            title: values.title || undefined, body: values.body || undefined, sourceUrl: values.url || undefined,
            tags: values.tags ? splitWords(values.tags) : undefined, provenance: 'Command',
          }));
          return `Changed note ${note.id} (${note.title}).`;
        },
      }),
      change({
        id: 'review', label: 'Mark a note reviewed', word: 'review', inputs: [NOTE],
        sentence: 'Note {note} is marked reviewed, until you change it.', example: { note: 'vendor-call' }, undoneBy: 'stale',
        async run(values, ctx) { const note = step(() => notesOf(ctx).markReviewed(values.note!)); return `Marked note ${note.id} reviewed.`; },
      }),
      change({
        id: 'stale', label: 'Mark a note out of date', word: 'stale',
        inputs: [NOTE, textInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'Note {note} is marked out of date because "{reason}", until you change it.', example: { note: 'vendor-call', reason: 'the date moved' },
        async run(values, ctx) { const note = step(() => notesOf(ctx).markStale(values.note!, values.reason!)); return `Marked note ${note.id} out of date.`; },
      }),
      change({
        id: 'delete', label: 'Delete a note', word: 'delete', inputs: [NOTE],
        sentence: 'Note {note} is removed from this Agent.', example: { note: 'vendor-call' }, risk: 'cannot-be-undone',
        async run(values, ctx) { const note = step(() => notesOf(ctx).deleteNote(values.note!)); return `Deleted note ${note.id} (${note.title}).`; },
      }),
      change({
        id: 'to-memory', label: 'Keep a note as a memory', word: 'to-memory',
        inputs: [
          NOTE,
          choiceInput({ id: 'class', label: 'Kind', help: 'What sort of thing it is', choices: MEMORY_KINDS, typed: { flag: '--kind' }, optional: { default: 'fact', means: 'a fact' } }),
          choiceInput({ id: 'scope', label: 'Where it applies', help: 'This project, this session, or shared with the team', choices: MEMORY_SCOPES, typed: { flag: '--scope' }, optional: { default: 'project', means: 'this project' } }),
        ],
        sentence: 'Note {note} becomes a memory record (its title the summary, its text the detail), until you change it; the note stays.', example: { note: 'vendor-call' },
        async run(values, ctx) {
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
      }),
      change({
        id: 'to-persona', label: 'Make a persona from a note', word: 'to-persona', inputs: [NOTE],
        sentence: 'Note {note} becomes a persona (its text the instructions), not in use, until you change it; the note stays.', example: { note: 'house-style' },
        async run(values, ctx) {
          const note = noteOrRefuse(ctx, values.note!);
          refuseIfMade(note, 'persona', '/personas update');
          const persona = step(() => AgentPersonaRegistry.fromShellPaths(requireShellPaths(ctx)).create({
            name: note.title, description: noteSummary(note), body: note.body, tags: noteTags(note), triggers: [], source: 'user', provenance: `Note ${note.id}`,
          }));
          step(() => notesOf(ctx).recordPromotion(note.id, { domain: 'persona', id: persona.id }));
          return `Made persona ${persona.id} from note ${note.id}. Use it with /personas use ${persona.id}.`;
        },
      }),
      change({
        id: 'to-skill', label: 'Make a skill from a note', word: 'to-skill', inputs: [NOTE, ENABLE],
        sentence: 'Note {note} becomes a skill (its text the steps), until you change it; the note stays.', example: { note: 'release-steps' },
        async run(values, ctx) {
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
      }),
      change({
        id: 'to-routine', label: 'Make a routine from a note', word: 'to-routine', inputs: [NOTE, ENABLE],
        sentence: 'Note {note} becomes a routine (its text the steps), until you change it; the note stays.', example: { note: 'morning-check' },
        async run(values, ctx) {
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
      }),
      change({
        id: 'to-knowledge', label: 'Add a note\'s web page to Agent Knowledge', word: 'to-knowledge', inputs: [NOTE],
        sentence: 'The web page of note {note} is fetched and added to Agent Knowledge, until you change it; the note stays.', example: { note: 'vendor-call' },
        async run(values, ctx) {
          const note = noteOrRefuse(ctx, values.note!);
          const url = note.sourceUrl?.trim();
          if (!url) throw commandRefusal(`Note ${note.id} names no web page; nothing was added.`, `Give it one: /notes edit ${note.id} --url <address>`);
          const ingest = describedCommandByName('knowledge')?.actions.find((action) => action.id === 'ingest-url');
          if (!ingest) throw commandRefusal('Agent Knowledge is not available in this Agent; nothing was added.');
          // The same action /knowledge ingest-url runs, with the note's page.
          const out = await (ingest.run as (values: Readonly<Record<string, string>>, context: CommandContext) => ReturnType<typeof ingest.run>)({ url, tags: noteTags(note).join(', '), folder: 'notes' }, ctx);
          return typeof out === 'string' ? out : `Added ${url} to Agent Knowledge.`;
        },
      }),
    ],
  }));
}
