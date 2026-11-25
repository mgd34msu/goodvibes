/**
 * Notes you keep beside your work, kept by the daemon in one list
 * (`~/.goodvibes/agent/notes/notes.json`), with a review state, and what was
 * made from each: a memory record, a persona, a skill or a routine, or its web
 * page added to Agent Knowledge.
 */
import type { FixedChoice, InputDescription, ListName } from '../types.js';
import { fixedInput, pickedInput, storeCapability, storeRead, wordsInput } from './agent-stores.js';

/** Your notes (terminal-shell's list reads them from notes.list). */
export const NOTES_LIST = 'notes' as ListName;

const NOTE: InputDescription = pickedInput({ id: 'note', label: 'Note', help: 'Your notes', list: NOTES_LIST, other: 'a note id or title' });
const ENABLE: InputDescription = fixedInput({
  id: 'enabled', label: 'Switch it on', help: 'At once, or after you review it',
  choices: [{ value: 'no', label: 'After I review it' }, { value: 'yes', label: 'At once', help: 'It may be used before anyone reviewed it.', risk: 'loosens-a-protection' }],
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
const words = (id: string, label: string, help: string, flag: `--${string}`, means: string): InputDescription =>
  wordsInput({ id, label, help, why: 'your own words', typed: { flag }, optional: { default: '', means } });

export const NOTES_LIST_ALL = storeRead({
  id: 'notes.list', actionId: 'list', label: 'See your notes', word: 'list', inputs: [],
  sentence: 'Lists your notes, newest last, with whether you reviewed each.', example: {},
});
export const NOTES_SHOW = storeRead({
  id: 'notes.show', actionId: 'show', label: 'Read one note', word: 'show', inputs: [NOTE],
  sentence: 'Shows note {note} in full, with what was made from it.', example: { note: 'vendor-call' },
});
export const NOTES_SEARCH = storeRead({
  id: 'notes.search', actionId: 'search', label: 'Find a note', word: 'search',
  inputs: [wordsInput({ id: 'words', label: 'Words', help: 'What to look for in titles, text, tags and web pages', why: 'your own words', typed: { tail: true } })],
  sentence: 'Lists the notes that mention {words}.', example: { words: 'vendor' },
});
export const NOTES_CREATE = storeCapability({
  id: 'notes.create', actionId: 'create', label: 'Write a note', word: 'create',
  inputs: [
    wordsInput({ id: 'body', label: 'Text', help: 'What you want to keep for now', why: 'your own words', kind: 'long-text', typed: { tail: true } }),
    words('title', 'Title', 'What it is called', '--title', 'its first words'),
    wordsInput({ id: 'url', label: 'Web page', help: 'The page it is about, if any', why: 'a web address', typed: { flag: '--url' }, optional: { default: '', means: 'none' } }),
    words('tags', 'Tags', 'Words to find it by, separated by commas', '--tags', 'none'),
  ],
  sentence: 'A note with the text "{body}" is kept, until you change it.', example: { body: 'They can ship in May.', title: 'Vendor call' },
  undoneBy: 'delete',
});
export const NOTES_EDIT = storeCapability({
  id: 'notes.edit', actionId: 'edit', label: 'Change a note', word: 'edit',
  inputs: [
    NOTE,
    words('title', 'Title', 'A new title', '--title', 'keep it'),
    wordsInput({ id: 'body', label: 'Text', help: 'New text', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'keep it' } }),
    wordsInput({ id: 'url', label: 'Web page', help: 'A new web page', why: 'a web address', typed: { flag: '--url' }, optional: { default: '', means: 'keep it' } }),
    words('tags', 'Tags', 'New tags, separated by commas', '--tags', 'keep them'),
  ],
  sentence: 'Note {note} takes the changes given and is no longer marked reviewed, until you change it.', example: { note: 'vendor-call', body: 'They can ship in June.' },
  repeat: 'safe',
});
export const NOTES_REVIEW = storeCapability({
  id: 'notes.review', actionId: 'review', label: 'Mark a note reviewed', word: 'review', inputs: [NOTE],
  sentence: 'Note {note} is marked reviewed, until you change it.', example: { note: 'vendor-call' }, undoneBy: 'stale', repeat: 'safe',
  ownerOnly: { reason: 'marking a note reviewed is your own judgement of it', instead: 'Ask the owner to review it in Memory and knowledge, on the note.' },
});
export const NOTES_STALE = storeCapability({
  id: 'notes.stale', actionId: 'stale', label: 'Mark a note out of date', word: 'stale',
  inputs: [NOTE, wordsInput({ id: 'reason', label: 'Why', help: 'What is out of date', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
  sentence: 'Note {note} is marked out of date because "{reason}", until you change it.', example: { note: 'vendor-call', reason: 'the date moved' }, repeat: 'safe',
});
export const NOTES_DELETE = storeCapability({
  id: 'notes.delete', actionId: 'delete', label: 'Delete a note', word: 'delete', inputs: [NOTE],
  sentence: 'Note {note} is removed.', example: { note: 'vendor-call' }, risk: 'cannot-be-undone', repeat: 'safe',
});
export const NOTES_TO_MEMORY = storeCapability({
  id: 'notes.to-memory', actionId: 'to-memory', label: 'Keep a note as a memory', word: 'to-memory',
  inputs: [
    NOTE,
    fixedInput({ id: 'class', label: 'Kind', help: 'What sort of thing it is', choices: MEMORY_KINDS, typed: { flag: '--kind' }, optional: { default: 'fact', means: 'a fact' } }),
    fixedInput({ id: 'scope', label: 'Where it applies', help: 'This project, this session, or shared with the team', choices: MEMORY_SCOPES, typed: { flag: '--scope' }, optional: { default: 'project', means: 'this project' } }),
  ],
  sentence: 'Note {note} becomes a memory record (its title the summary, its text the detail), until you change it; the note stays.', example: { note: 'vendor-call' },
});
export const NOTES_TO_PERSONA = storeCapability({
  id: 'notes.to-persona', actionId: 'to-persona', label: 'Make a persona from a note', word: 'to-persona', inputs: [NOTE],
  sentence: 'Note {note} becomes a persona (its text the instructions), not in use, until you change it; the note stays.', example: { note: 'house-style' },
});
export const NOTES_TO_SKILL = storeCapability({
  id: 'notes.to-skill', actionId: 'to-skill', label: 'Make a skill from a note', word: 'to-skill', inputs: [NOTE, ENABLE],
  sentence: 'Note {note} becomes a skill (its text the steps), until you change it; the note stays.', example: { note: 'release-steps' },
});
export const NOTES_TO_ROUTINE = storeCapability({
  id: 'notes.to-routine', actionId: 'to-routine', label: 'Make a routine from a note', word: 'to-routine', inputs: [NOTE, ENABLE],
  sentence: 'Note {note} becomes a routine (its text the steps), until you change it; the note stays.', example: { note: 'morning-check' },
});
export const NOTES_TO_KNOWLEDGE = storeCapability({
  id: 'notes.to-knowledge', actionId: 'to-knowledge', label: 'Add a note\'s web page to Agent Knowledge', word: 'to-knowledge', inputs: [NOTE],
  sentence: 'The web page of note {note} is fetched and added to Agent Knowledge, until you change it; the note stays.', example: { note: 'vendor-call' },
  touches: 'another-machine',
});

export const NOTES_CAPABILITIES = [
  NOTES_LIST_ALL, NOTES_SHOW, NOTES_SEARCH, NOTES_CREATE, NOTES_EDIT, NOTES_REVIEW, NOTES_STALE, NOTES_DELETE,
  NOTES_TO_MEMORY, NOTES_TO_PERSONA, NOTES_TO_SKILL, NOTES_TO_ROUTINE, NOTES_TO_KNOWLEDGE,
] as const;
