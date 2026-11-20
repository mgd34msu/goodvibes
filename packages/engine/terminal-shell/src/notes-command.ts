/**
 * `/notes`, described once (command-actions/) for both terminal apps: notes
 * you keep beside your work. The Agent keeps them in its home, with a review
 * state, and can make a memory record, a persona, a skill or a routine from
 * one, or add its web page to Agent Knowledge. The terminal app keeps them for
 * this session and the model keeps seeing them after a compaction (a message
 * that starts with `!#` writes one too); it can keep one as a memory record. What each app does
 * is its policy; an act an app does not have is refused with the reason.
 */
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, ActionValues, CommandActionContext, FixedChoice, InputDescription } from './command-actions/types.js';
import { choiceInput, listInput, readAction, textInput, type RunResult } from './described-command-kit.js';

/** Every action of `/notes`, by id. */
export type NotesActionId =
  | 'list' | 'show' | 'search' | 'create' | 'edit' | 'review' | 'stale' | 'delete'
  | 'to-memory' | 'to-persona' | 'to-skill' | 'to-routine' | 'to-knowledge';

type NotesRun<Ctx> = (values: ActionValues, ctx: Ctx) => RunResult;

export interface NotesCommandPolicy<Ctx> {
  /** The notes as list rows, for the guided path and completion. */
  readonly rows: (ctx: Ctx) => readonly ListRow[];
  /** What each action does in this app, or the reason this app does not do it. */
  readonly run: Readonly<Record<NotesActionId, NotesRun<Ctx> | { readonly refused: string; readonly instead: string }>>;
}

/**
 * The rows of the notes list come from the app that registered `/notes` in
 * this process (a process runs one terminal app); the list is defined once.
 */
let notesRows: ((ctx: never) => readonly ListRow[]) | undefined;

const NOTES = defineList<never>({
  name: 'notes',
  async read(ctx) {
    return notesRows ? notesRows(ctx) : [];
  },
  operator: { terminalOnly: 'Notes are kept by the terminal app.' },
});

const LOCAL_ONLY = { terminalOnly: 'Notes are kept by the terminal app.' } as const;

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

export function createNotesCommand<Ctx extends CommandActionContext>(policy: NotesCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  notesRows = policy.rows as (ctx: never) => readonly ListRow[];
  const run = (id: NotesActionId): NotesRun<Ctx> => {
    const act = policy.run[id];
    if (typeof act === 'function') return act;
    return async () => { throw commandRefusal(act.refused, act.instead); };
  };
  type NoteAction = ActionDescription<Ctx>;
  const change = (fields: Pick<NoteAction, 'id' | 'label' | 'word' | 'inputs' | 'sentence' | 'example'> & Partial<Pick<NoteAction, 'risk' | 'undoneBy' | 'lasts'>>): NoteAction => ({
    done: '', touches: 'this-machine', lasts: 'kept', risk: 'none', operator: LOCAL_ONLY, ...fields, run: run(fields.id as NotesActionId),
  });
  return defineCommand<Ctx>({
    name: 'notes',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'Notes',
    summary: 'Notes you keep beside your work: write, find and change them, and keep one as a memory, a persona, a skill or a routine',
    group: 'Conversation',
    report: 'list',
    firstScreenRows: [
      'list', 'create', 'show', 'search',
      { label: 'Change a note…', actions: ['edit', 'review', 'stale', 'delete'] },
      { label: 'Make something from a note…', actions: ['to-memory', 'to-persona', 'to-skill', 'to-routine', 'to-knowledge'] },
    ],
    actions: [
      readAction<Ctx>({
        id: 'list', label: 'See your notes', readsOnlyThisMachine: true, word: 'list', operator: LOCAL_ONLY,
        sentence: 'Lists your notes, newest last, with whether you reviewed each.',
        async rowValue(ctx) { const count = policy.rows(ctx).length; return count === 1 ? '1 note' : `${count} notes`; },
        run: run('list'),
      }),
      readAction<Ctx>({
        id: 'show', label: 'Read one note', word: 'show', inputs: [NOTE], operator: LOCAL_ONLY,
        sentence: 'Shows note {note} in full, with what was made from it.', example: { note: 'vendor-call' },
        run: run('show'),
      }),
      readAction<Ctx>({
        id: 'search', label: 'Find a note', word: 'search', operator: LOCAL_ONLY,
        inputs: [textInput({ id: 'words', label: 'Words', help: 'What to look for in titles, text, tags and web pages', why: 'your own words', typed: { tail: true } })],
        sentence: 'Lists the notes that mention {words}.', example: { words: 'vendor' },
        run: run('search'),
      }),
      change({
        id: 'create', label: 'Write a note', word: 'create',
        inputs: [
          textInput({ id: 'body', label: 'Text', help: 'What you want to keep for now', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
          textInput({ id: 'title', label: 'Title', help: 'What it is called', why: 'your own words', typed: { flag: '--title' }, optional: { default: '', means: 'its first words' } }),
          textInput({ id: 'url', label: 'Web page', help: 'The page it is about, if any', why: 'a web address', typed: { flag: '--url' }, optional: { default: '', means: 'none' } }),
          textInput({ id: 'tags', label: 'Tags', help: 'Words to find it by, separated by commas', why: 'your own words', typed: { flag: '--tags' }, optional: { default: '', means: 'none' } }),
        ],
        sentence: 'A note with the text "{body}" is kept until you change it; in the terminal app it lasts for this session, and the model keeps seeing it after a compaction.',
        example: { body: 'They can ship in May.', title: 'Vendor call' },
        undoneBy: 'delete',
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
      }),
      change({
        id: 'review', label: 'Mark a note reviewed', word: 'review', inputs: [NOTE],
        sentence: 'Note {note} is marked reviewed, until you change it.', example: { note: 'vendor-call' }, undoneBy: 'stale',
      }),
      change({
        id: 'stale', label: 'Mark a note out of date', word: 'stale',
        inputs: [NOTE, textInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: 'Note {note} is marked out of date because "{reason}", until you change it.', example: { note: 'vendor-call', reason: 'the date moved' },
      }),
      change({
        id: 'delete', label: 'Delete a note', word: 'delete', inputs: [NOTE],
        sentence: 'Note {note} is removed.', example: { note: 'vendor-call' }, risk: 'cannot-be-undone',
      }),
      change({
        id: 'to-memory', label: 'Keep a note as a memory', word: 'to-memory',
        inputs: [
          NOTE,
          choiceInput({ id: 'class', label: 'Kind', help: 'What sort of thing it is', choices: MEMORY_KINDS, typed: { flag: '--kind' }, optional: { default: 'fact', means: 'a fact' } }),
          choiceInput({ id: 'scope', label: 'Where it applies', help: 'This project, this session, or shared with the team', choices: MEMORY_SCOPES, typed: { flag: '--scope' }, optional: { default: 'project', means: 'this project' } }),
        ],
        sentence: 'Note {note} becomes a memory record (its title the summary, its text the detail), until you change it; the note stays.', example: { note: 'vendor-call' },
      }),
      change({
        id: 'to-persona', label: 'Make a persona from a note', word: 'to-persona', inputs: [NOTE],
        sentence: 'Note {note} becomes a persona (its text the instructions), not in use, until you change it; the note stays.', example: { note: 'house-style' },
      }),
      change({
        id: 'to-skill', label: 'Make a skill from a note', word: 'to-skill', inputs: [NOTE, ENABLE],
        sentence: 'Note {note} becomes a skill (its text the steps), until you change it; the note stays.', example: { note: 'release-steps' },
      }),
      change({
        id: 'to-routine', label: 'Make a routine from a note', word: 'to-routine', inputs: [NOTE, ENABLE],
        sentence: 'Note {note} becomes a routine (its text the steps), until you change it; the note stays.', example: { note: 'morning-check' },
      }),
      change({
        id: 'to-knowledge', label: 'Add a note\'s web page to Agent Knowledge', word: 'to-knowledge', inputs: [NOTE],
        sentence: 'The web page of note {note} is fetched and added to Agent Knowledge, until you change it; the note stays.', example: { note: 'vendor-call' },
      }),
    ],
  });
}

/** A title from the first words of a note's text, for a note written without one. */
export function noteTitleFromText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  const words = compact.split(' ').slice(0, 8).join(' ');
  return (words.length > 60 ? `${words.slice(0, 57)}...` : words) || 'Note';
}
