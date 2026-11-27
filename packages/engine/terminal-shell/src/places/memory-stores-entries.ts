/**
 * memory-stores-entries.ts, the Memory and knowledge place's notes, personas,
 * routines, document drafts and saved artifacts (the place's declaration
 * holds these as its lists and actions; capabilities/builtin/notes.ts,
 * personas.ts, routines.ts, documents.ts and artifacts.ts are the acts).
 *
 * Every list is read from the daemon through `capabilities.run` (the place
 * sends this program's project with each, so the drafts are the project's)
 * and follows the LIST_CHANGED list its store announces on every change made
 * through the daemon, from any program, the web UI, a model or a script.
 * Every action is a capability by id; the selected item fills its inputs and
 * a form asks for the rest. Starting a routine sends its steps as the next
 * message of this program's conversation.
 *
 * The live lists a form's inputs choose from (a note, a persona, a routine, a
 * draft, its comments and suggestions, an artifact, a file found to import)
 * are the terminal's side, in memory-stores-lists.ts, and read the same
 * capabilities. This file holds no terminal code: the web UI draws these
 * lists too (places/browser.ts).
 */
import type { PlaceAction, PlaceCapabilityAction, PlaceDetailLine, PlaceFollow, PlaceItem, PlaceList, PlaceProgramName, PlaceRow } from './place-types.js';

type Review = 'fresh' | 'reviewed' | 'stale';

export interface NoteItem extends PlaceItem {
  readonly kind: 'note';
  readonly state: Review;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly url: string;
  readonly tags: readonly string[];
  readonly made: readonly string[];
  readonly staleReason: string;
  readonly updatedAt: string;
}

export interface PersonaItem extends PlaceItem {
  readonly kind: 'persona';
  readonly state: `${'in-use' | 'not-in-use'}-${Review}`;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly triggers: readonly string[];
  readonly origin: string;
  readonly staleReason: string;
}

export interface RoutineItem extends PlaceItem {
  readonly kind: 'routine';
  readonly state: `${'on' | 'off'}-${Review}`;
  readonly name: string;
  readonly description: string;
  readonly steps: string;
  /** False when something it needs is missing (a setting, a program). */
  readonly ready: boolean;
  readonly readiness: string;
  readonly requirements: readonly string[];
  readonly triggers: readonly string[];
  readonly startCount: number;
  readonly lastStartedAt: string;
  readonly origin: string;
  readonly staleReason: string;
}

export interface DraftItem extends PlaceItem {
  readonly kind: 'draft';
  readonly state: 'draft' | 'reviewed' | 'archived';
  readonly title: string;
  readonly versions: number;
  readonly tags: readonly string[];
  readonly openComments: number;
  readonly waitingSuggestions: number;
  readonly attachments: number;
  readonly body: string;
  readonly updatedAt: string;
}

export interface ArtifactItem extends PlaceItem {
  readonly kind: 'artifact';
  readonly state: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly source: string;
  readonly purpose: string;
}

export interface AgentHomeItem extends PlaceItem {
  readonly kind: 'agent-home';
  readonly state: 'starts-next' | 'kept';
  readonly home: string;
  readonly starter: string;
  readonly starterName: string;
  readonly createdAt: string;
}

export interface StarterItem extends PlaceItem {
  readonly kind: 'starter';
  readonly state: 'yours' | 'built-in';
  readonly name: string;
  readonly description: string;
  readonly persona: string;
  readonly skills: readonly string[];
  readonly routines: readonly string[];
  readonly vibe: boolean;
  readonly path: string;
}

export type MemoryStoreItem = NoteItem | PersonaItem | RoutineItem | DraftItem | ArtifactItem | AgentHomeItem | StarterItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): readonly Readonly<Record<string, unknown>>[] => Array.isArray(value) ? value.map(record) : [];
/** Text written by a person, a model or a file, on one line: control characters out. */
const plain = (value: unknown): string => text(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
/** Longer text kept on its own lines: control characters but the line break out. */
const block = (value: unknown): string => text(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ').trim();
const strings = (value: unknown): readonly string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string').map(plain) : [];
const dataOf = (output: unknown): Readonly<Record<string, unknown>> => record(record(output)['data']);
const review = (value: unknown): Review => value === 'reviewed' || value === 'stale' ? value : 'fresh';
const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const day = (value: unknown): string => text(value) ? new Date(text(value)).toLocaleString() : 'not said';

export function noteItems(output: unknown): readonly NoteItem[] {
  return list(dataOf(output)['notes']).filter((note) => text(note['id'])).map((note): NoteItem => ({
    kind: 'note', id: text(note['id']), state: review(note['state']), title: plain(note['title']) || text(note['id']), summary: plain(note['summary']),
    body: block(note['body']), url: plain(note['url']), tags: strings(note['tags']),
    made: list(note['made']).map((entry) => `${plain(entry['kind'])} ${plain(entry['id'])}`), staleReason: plain(note['staleReason']), updatedAt: text(note['updatedAt']),
  }));
}

export function personaItems(output: unknown): readonly PersonaItem[] {
  return list(dataOf(output)['personas']).filter((persona) => text(persona['id'])).map((persona): PersonaItem => {
    const reviewState = review(persona['reviewState']);
    return {
      kind: 'persona', id: text(persona['id']), state: `${persona['inUse'] === true ? 'in-use' : 'not-in-use'}-${reviewState}`,
      name: plain(persona['name']) || text(persona['id']), description: plain(persona['description']), body: block(persona['body']),
      tags: strings(persona['tags']), triggers: strings(persona['triggers']), origin: plain(persona['origin']), staleReason: plain(persona['staleReason']),
    };
  });
}

export function routineItems(output: unknown): readonly RoutineItem[] {
  return list(dataOf(output)['routines']).filter((routine) => text(routine['id'])).map((routine): RoutineItem => {
    return {
      kind: 'routine', id: text(routine['id']), state: `${routine['enabled'] === true ? 'on' : 'off'}-${review(routine['reviewState'])}`,
      name: plain(routine['name']) || text(routine['id']), description: plain(routine['description']), steps: block(routine['steps']),
      ready: routine['ready'] !== false, readiness: plain(routine['readiness']), requirements: strings(routine['requirements']), triggers: strings(routine['triggers']),
      startCount: count(routine['startCount']), lastStartedAt: text(routine['lastStartedAt']), origin: plain(routine['origin']), staleReason: plain(routine['staleReason']),
    };
  });
}

const DRAFT_STATES = new Set(['draft', 'reviewed', 'archived']);

export function draftItems(output: unknown): readonly DraftItem[] {
  return list(dataOf(output)['documents']).filter((document) => text(document['id'])).map((document): DraftItem => ({
    kind: 'draft', id: text(document['id']), state: (DRAFT_STATES.has(text(document['status'])) ? text(document['status']) : 'draft') as DraftItem['state'],
    title: plain(document['title']) || text(document['id']), versions: count(document['versions']), tags: strings(document['tags']),
    openComments: list(document['comments']).filter((comment) => comment['state'] !== 'resolved').length,
    waitingSuggestions: list(document['suggestions']).filter((suggestion) => suggestion['state'] === 'proposed').length,
    attachments: count(document['attachments']), body: block(document['body']), updatedAt: text(document['updatedAt']),
  }));
}

export function artifactItems(output: unknown): readonly ArtifactItem[] {
  return list(dataOf(output)['artifacts']).filter((artifact) => text(artifact['id'])).map((artifact): ArtifactItem => ({
    kind: 'artifact', id: text(artifact['id']), state: plain(artifact['kind']) || 'file', name: plain(artifact['name']) || text(artifact['id']),
    mimeType: plain(artifact['mimeType']), sizeBytes: count(artifact['sizeBytes']), createdAt: text(artifact['createdAt']),
    source: plain(artifact['source']), purpose: plain(artifact['purpose']),
  }));
}

export function homeItems(output: unknown): readonly AgentHomeItem[] {
  return list(dataOf(output)['homes']).filter((home) => text(home['id'])).map((home): AgentHomeItem => ({
    kind: 'agent-home', id: text(home['id']), state: home['state'] === 'starts-next' ? 'starts-next' : 'kept', home: plain(home['home']),
    starter: plain(home['starter']), starterName: plain(home['starterName']), createdAt: text(home['createdAt']),
  }));
}

export function starterItems(output: unknown): readonly StarterItem[] {
  return list(dataOf(output)['starters']).filter((starter) => text(starter['id'])).map((starter): StarterItem => ({
    kind: 'starter', id: text(starter['id']), state: starter['state'] === 'yours' ? 'yours' : 'built-in', name: plain(starter['name']) || text(starter['id']),
    description: plain(starter['description']), persona: plain(starter['persona']), skills: strings(starter['skills']), routines: strings(starter['routines']),
    vibe: starter['vibe'] === true, path: plain(starter['path']),
  }));
}

const REVIEW_WORDS: Readonly<Record<Review, string>> = { fresh: 'not reviewed yet', reviewed: 'reviewed by you', stale: 'marked out of date' };
const reviewOf = (state: string): Review => (state.split('-').pop() as Review | undefined) ?? 'fresh';
const follow = (name: string): PlaceFollow => ({ domains: [], events: [], lists: [name] });
const run = (id: string, inputs: Readonly<Record<string, string>> = {}) => ({ id, inputs });
const size = (bytes: number): string => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

const notesList: PlaceList<MemoryStoreItem> = {
  id: 'notes',
  label: 'Notes',
  noun: 'your notes',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('notes.list'), items: noteItems },
  follows: follow('notes'),
  empty: 'No notes yet: a note keeps a thought beside your work until you need it.',
  row: (item) => {
    const note = item as NoteItem;
    return { title: note.title, ...(note.state !== 'reviewed' ? { right: REVIEW_WORDS[note.state] } : {}), mark: note.state === 'stale' ? 'attention' : note.state === 'fresh' ? 'waiting' : 'ok' };
  },
  detail: (item) => {
    const note = item as NoteItem;
    return [
      { label: 'Review', text: REVIEW_WORDS[note.state] },
      ...(note.staleReason ? [{ label: 'Out of date because', text: note.staleReason, tone: 'warning' as const }] : []),
      ...(note.url ? [{ label: 'Web page', text: note.url }] : []),
      ...(note.tags.length > 0 ? [{ label: 'Tags', text: note.tags.join(', ') }] : []),
      ...(note.made.length > 0 ? [{ label: 'Made from it', text: note.made.join(', ') }] : []),
      { label: 'Changed', text: day(note.updatedAt), tone: 'muted' as const },
      { text: '' },
      { text: note.body || 'It is empty.' },
    ];
  },
};

/**
 * Personas, Agent homes and starters are the Agent's: its voice, its separate homes and the templates they are made from.
 * The terminal app has none of them, so only the Agent (and the web view of the daemon's stores) draws them.
 */
const AGENT_HAS: readonly PlaceProgramName[] = ['agent', 'web'];

const personasList: PlaceList<MemoryStoreItem> = {
  id: 'personas',
  programs: AGENT_HAS,
  label: 'Personas',
  noun: 'your personas',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('personas.list'), items: personaItems },
  follows: follow('personas'),
  empty: 'No personas yet: the Agent talks in its own way until you give it one.',
  row: (item) => {
    const persona = item as PersonaItem;
    const inUse = persona.state.startsWith('in-use');
    const state = reviewOf(persona.state);
    return { title: persona.name, ...(inUse ? { right: 'in use' } : state !== 'reviewed' ? { right: REVIEW_WORDS[state] } : {}), mark: inUse ? 'ok' : state === 'stale' ? 'attention' : 'paused' };
  },
  detail: (item) => {
    const persona = item as PersonaItem;
    return [
      { text: persona.description || 'It says nothing about what it is for.' },
      { text: '' },
      { label: 'In use', text: persona.state.startsWith('in-use') ? 'yes, the Agent talks and behaves as this persona' : 'no' },
      { label: 'Review', text: REVIEW_WORDS[reviewOf(persona.state)] },
      ...(persona.staleReason ? [{ label: 'Out of date because', text: persona.staleReason, tone: 'warning' as const }] : []),
      { label: 'Brought up by', text: persona.triggers.join(', ') || 'only when you choose it' },
      ...(persona.tags.length > 0 ? [{ label: 'Tags', text: persona.tags.join(', ') }] : []),
      { label: 'Came from', text: persona.origin || 'not said', tone: 'muted' as const },
      { text: '' },
      { text: persona.body || 'It has no instructions.' },
    ];
  },
};

const RUNNING_WORDS: Readonly<Record<string, string>> = { on: 'switched on', off: 'switched off', 'needs-setup': 'needs setting up' };

const routinesList: PlaceList<MemoryStoreItem> = {
  id: 'routines',
  label: 'Routines',
  noun: 'your routines',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('routines.list'), items: routineItems },
  follows: follow('routines'),
  empty: 'No routines yet: a routine is steps the Agent runs when you ask.',
  row: (item) => routineRow(item as RoutineItem),
  detail: (item) => routineDetail(item as RoutineItem),
};

function routineRow(routine: RoutineItem): PlaceRow {
  const on = routine.state.startsWith('on-');
  const state = reviewOf(routine.state);
  const right = !routine.ready ? 'needs setting up' : state !== 'reviewed' ? REVIEW_WORDS[state] : on ? undefined : 'off';
  return { title: routine.name, ...(right ? { right } : {}), mark: !routine.ready || state === 'stale' ? 'attention' : on ? 'ok' : 'paused' };
}

function routineDetail(routine: RoutineItem): readonly PlaceDetailLine[] {
    return [
      { text: routine.description || 'It says nothing about what it does.' },
      { text: '' },
      { label: 'State', text: routine.state.startsWith('on-') ? RUNNING_WORDS['on']! : RUNNING_WORDS['off']! },
      { label: 'Review', text: REVIEW_WORDS[reviewOf(routine.state)] },
      ...(routine.staleReason ? [{ label: 'Out of date because', text: routine.staleReason, tone: 'warning' as const }] : []),
      { label: 'Ready', text: routine.readiness || 'not said', ...(routine.readiness && routine.readiness !== 'ready' ? { tone: 'warning' as const } : {}) },
      { label: 'Needs', text: routine.requirements.join(', ') || 'nothing' },
      { label: 'Brought up by', text: routine.triggers.join(', ') || 'only when you ask' },
      { label: 'Started', text: `${routine.startCount} time${routine.startCount === 1 ? '' : 's'}${routine.lastStartedAt ? `, last ${day(routine.lastStartedAt)}` : ''}` },
      { label: 'Came from', text: routine.origin || 'not said', tone: 'muted' as const },
      { text: '' },
      { text: routine.steps || 'It has no steps.' },
    ];
}

/**
 * Automation's view of the same routines (automation-place.ts adds it): routines are steps that can run by
 * themselves once switched on and put on a schedule, so a person looking in Automation finds them and the six
 * controls that make them run there. The same source and follows as the Routines tab of Memory and knowledge.
 */
export const AUTOMATION_ROUTINES_LIST: PlaceList<MemoryStoreItem> = {
  ...routinesList,
  noun: 'your routines, which run by themselves once switched on and put on a schedule',
  empty: 'No routines yet: make one in Memory and knowledge, then switch it on and put it on a schedule here.',
};

/** The routine states switched on, or off, whatever their review. */
function ROUTINE_ON_OFF(running: 'on' | 'off'): readonly string[] {
  return (['fresh', 'reviewed', 'stale'] as const).map((state) => `${running}-${state}`);
}

/** The controls of Automation's Routines list: what makes a routine run by itself. */
export const AUTOMATION_ROUTINE_ACTIONS: readonly PlaceAction<MemoryStoreItem>[] = [
  { key: 'u', id: 'automation-routine-switch-on', list: 'routines', states: ROUTINE_ON_OFF('off'), capability: 'routines.enable', label: 'switch on', fill: { routine: 'id' } },
  { key: 'u', id: 'automation-routine-switch-off', list: 'routines', states: ROUTINE_ON_OFF('on'), capability: 'routines.disable', label: 'switch off', fill: { routine: 'id' } },
  { key: 'p', id: 'automation-routine-schedule', list: 'routines', capability: 'routines.promote', label: 'run on a schedule', fill: { routine: 'id' } },
  { key: 'j', id: 'automation-routine-receipts', list: 'routines', whole: true, capability: 'routines.receipts', label: 'put on a schedule so far' },
  { key: 'k', id: 'automation-routine-receipt', list: 'routines', whole: true, capability: 'routines.receipt', label: 'one receipt' },
  { key: 'y', id: 'automation-routine-check', list: 'routines', whole: true, capability: 'routines.reconcile', label: 'check against the schedules' },
];

const DRAFT_WORDS: Readonly<Record<DraftItem['state'], string>> = { draft: 'a draft', reviewed: 'reviewed', archived: 'put away' };

const draftsList: PlaceList<MemoryStoreItem> = {
  id: 'drafts',
  label: 'Drafts',
  noun: 'your document drafts in this project',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('documents.list', { limit: '1000' }), items: draftItems },
  follows: follow('documents'),
  empty: 'No drafts in this project yet.',
  row: (item) => {
    const draft = item as DraftItem;
    const waiting = draft.waitingSuggestions + draft.openComments;
    return { title: draft.title, ...(waiting > 0 ? { right: `${waiting} waiting for you` } : draft.state !== 'draft' ? { right: DRAFT_WORDS[draft.state] } : {}), mark: waiting > 0 ? 'waiting' : draft.state === 'archived' ? 'paused' : 'ok' };
  },
  detail: (item) => {
    const draft = item as DraftItem;
    return [
      { label: 'Status', text: DRAFT_WORDS[draft.state] },
      { label: 'Versions', text: String(draft.versions) },
      { label: 'Open comments', text: String(draft.openComments) },
      { label: 'Suggestions waiting', text: String(draft.waitingSuggestions) },
      { label: 'Attached artifacts', text: String(draft.attachments) },
      ...(draft.tags.length > 0 ? [{ label: 'Tags', text: draft.tags.join(', ') }] : []),
      { label: 'Changed', text: day(draft.updatedAt), tone: 'muted' as const },
      { text: '' },
      { text: draft.body || 'It is empty.' },
    ];
  },
};

const artifactsList: PlaceList<MemoryStoreItem> = {
  id: 'artifacts',
  label: 'Artifacts',
  noun: 'your saved artifacts',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('artifacts.list', { limit: '1000' }), items: artifactItems },
  follows: follow('artifacts'),
  empty: 'No saved artifacts yet: uploads, exports, reports and comparisons are kept here.',
  row: (item) => {
    const artifact = item as ArtifactItem;
    return { title: artifact.name, right: artifact.state, mark: 'ok' };
  },
  detail: (item) => {
    const artifact = item as ArtifactItem;
    return [
      { label: 'Kind', text: artifact.state },
      { label: 'Type', text: artifact.mimeType || 'not said' },
      { label: 'Size', text: size(artifact.sizeBytes) },
      { label: 'Saved', text: day(artifact.createdAt) },
      ...(artifact.purpose ? [{ label: 'Made for', text: artifact.purpose }] : []),
      ...(artifact.source ? [{ label: 'Came from', text: artifact.source }] : []),
      { label: 'Id', text: artifact.id, tone: 'muted' as const },
    ];
  },
};

const agentHomesList: PlaceList<MemoryStoreItem> = {
  id: 'agent-homes',
  programs: AGENT_HAS,
  label: 'Agent homes',
  noun: 'the Agent\'s separate homes',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('agent-home.list'), items: homeItems },
  follows: follow('agent-homes'),
  empty: 'No separate Agent homes: the Agent starts in its base home. Press w to make one.',
  row: (item) => {
    const home = item as AgentHomeItem;
    return { title: home.id, ...(home.state === 'starts-next' ? { right: 'starts next' } : home.starter ? { right: `from ${home.starter}` } : {}), mark: home.state === 'starts-next' ? 'ok' : 'paused' };
  },
  detail: (item) => {
    const home = item as AgentHomeItem;
    return [
      { label: 'Folder', text: home.home },
      { label: 'Starts next', text: home.state === 'starts-next' ? 'yes, the Agent starts in it' : 'no' },
      { label: 'Made from', text: home.starterName || home.starter || 'no starter (an empty home)' },
      { label: 'Made', text: day(home.createdAt) },
      { text: '' },
      { text: `Launch it once: goodvibes-agent --agent-profile ${home.id}`, tone: 'muted' as const },
    ];
  },
};

const startersList: PlaceList<MemoryStoreItem> = {
  id: 'starters',
  programs: AGENT_HAS,
  label: 'Starters',
  noun: 'the starter templates an Agent home is made from',
  source: { kind: 'daemon', method: 'capabilities.run', input: run('agent-home.starters'), items: starterItems },
  follows: follow('agent-homes'),
  empty: 'No starter templates.',
  row: (item) => {
    const starter = item as StarterItem;
    return { title: starter.name, right: starter.state === 'yours' ? 'yours' : 'built in', mark: 'ok' };
  },
  detail: (item) => {
    const starter = item as StarterItem;
    return [
      { text: starter.description },
      { text: '' },
      { label: 'Persona', text: starter.persona },
      { label: 'Skills', text: starter.skills.join(', ') || 'none' },
      { label: 'Routines', text: starter.routines.join(', ') || 'none' },
      { label: 'VIBE.md', text: starter.vibe ? 'included' : 'not included' },
      ...(starter.path ? [{ label: 'File', text: starter.path }] : []),
      { label: 'Id', text: starter.id, tone: 'muted' as const },
    ];
  },
};

/** The notes, personas, routines, drafts, saved artifacts, Agent homes and starters lists, in the place's tab order. */
export const MEMORY_STORE_LISTS: readonly PlaceList<MemoryStoreItem>[] = [notesList, personasList, routinesList, draftsList, artifactsList, agentHomesList, startersList];

const NOT_REVIEWED: readonly Review[] = ['fresh', 'stale'];
const NOT_STALE: readonly Review[] = ['fresh', 'reviewed'];
const PERSONA_STATES = (inUse: readonly ('in-use' | 'not-in-use')[], reviews: readonly Review[]): readonly string[] => inUse.flatMap((use) => reviews.map((state) => `${use}-${state}`));
const ROUTINE_STATES = (reviews: readonly Review[]): readonly string[] => (['on', 'off'] as const).flatMap((running) => reviews.map((state) => `${running}-${state}`));
const BOTH = ['in-use', 'not-in-use'] as const;
const ALL: readonly Review[] = ['fresh', 'reviewed', 'stale'];

/** Every action on those lists, by capability id. */
const EVERY_PROGRAM_ACTIONS: readonly PlaceCapabilityAction<MemoryStoreItem>[] = [
  // Notes
  { key: 'enter', id: 'note-change', list: 'notes', capability: 'notes.edit', label: 'change', fill: { note: 'id' } },
  { key: 'c', id: 'note-new', list: 'notes', whole: true, capability: 'notes.create', label: 'new note' },
  { key: 'f', id: 'note-search', list: 'notes', whole: true, capability: 'notes.search', label: 'search' },
  { key: 'v', id: 'note-reviewed', list: 'notes', states: NOT_REVIEWED, capability: 'notes.review', label: 'mark reviewed', fill: { note: 'id' } },
  { key: 't', id: 'note-out-of-date', list: 'notes', states: NOT_STALE, capability: 'notes.stale', label: 'out of date', fill: { note: 'id' } },
  { key: 'm', id: 'note-to-memory', list: 'notes', capability: 'notes.to-memory', label: 'keep as memory', fill: { note: 'id' } },
  { key: 'p', id: 'note-to-persona', list: 'notes', capability: 'notes.to-persona', label: 'make a persona', fill: { note: 'id' } },
  { key: 'k', id: 'note-to-skill', list: 'notes', capability: 'notes.to-skill', label: 'make a skill', fill: { note: 'id' } },
  { key: 'o', id: 'note-to-routine', list: 'notes', capability: 'notes.to-routine', label: 'make a routine', fill: { note: 'id' } },
  { key: 'w', id: 'note-to-knowledge', list: 'notes', capability: 'notes.to-knowledge', label: 'add its page to knowledge', fill: { note: 'id' } },
  { key: 's', id: 'note-read', list: 'notes', capability: 'notes.show', label: 'read in full', fill: { note: 'id' } },
  { key: 'x', id: 'note-delete', list: 'notes', capability: 'notes.delete', label: 'delete', fill: { note: 'id' } },
  // Personas
  { key: 'enter', id: 'persona-change', list: 'personas', capability: 'personas.update', label: 'change', fill: { persona: 'id' } },
  { key: 'u', id: 'persona-use', list: 'personas', states: PERSONA_STATES(['not-in-use'], ALL), capability: 'personas.use', label: 'use it', fill: { persona: 'id' } },
  { key: 'u', id: 'persona-stop-using', list: 'personas', states: PERSONA_STATES(['in-use'], ALL), capability: 'personas.stop-using', label: 'stop using it' },
  { key: 'v', id: 'persona-reviewed', list: 'personas', states: PERSONA_STATES(BOTH, NOT_REVIEWED), capability: 'personas.review', label: 'mark reviewed', fill: { persona: 'id' } },
  { key: 't', id: 'persona-out-of-date', list: 'personas', states: PERSONA_STATES(BOTH, NOT_STALE), capability: 'personas.stale', label: 'out of date', fill: { persona: 'id' } },
  { key: 's', id: 'persona-read', list: 'personas', capability: 'personas.show', label: 'read in full', fill: { persona: 'id' } },
  { key: 'x', id: 'persona-delete', list: 'personas', capability: 'personas.delete', label: 'delete', fill: { persona: 'id' } },
  { key: 'c', id: 'persona-new', list: 'personas', whole: true, capability: 'personas.create', label: 'new persona' },
  { key: 'f', id: 'persona-search', list: 'personas', whole: true, capability: 'personas.search', label: 'search' },
  { key: 'e', id: 'persona-in-use', list: 'personas', whole: true, capability: 'personas.active', label: 'the one in use' },
  { key: 'd', id: 'persona-files', list: 'personas', whole: true, capability: 'personas.discover', label: 'persona files found' },
  { key: 'i', id: 'persona-import', list: 'personas', whole: true, capability: 'personas.import', label: 'import a file' },
  { key: 'g', id: 'vibe-files', list: 'personas', whole: true, capability: 'personas.vibe', label: 'VIBE.md files' },
  { key: 'h', id: 'vibe-read', list: 'personas', whole: true, capability: 'personas.vibe-show', label: 'read a VIBE.md' },
  { key: 'm', id: 'vibe-new', list: 'personas', whole: true, capability: 'personas.vibe-create', label: 'make a VIBE.md' },
  { key: 'b', id: 'vibe-import', list: 'personas', whole: true, capability: 'personas.vibe-import', label: 'VIBE.md as a persona' },
  // Routines
  { key: 'enter', id: 'routine-change', list: 'routines', capability: 'routines.update', label: 'change', fill: { routine: 'id' } },
  { key: 'g', id: 'routine-start', list: 'routines', capability: 'routines.start', label: 'start it now', fill: { routine: 'id' } },
  { key: 'v', id: 'routine-reviewed', list: 'routines', states: ROUTINE_STATES(NOT_REVIEWED), capability: 'routines.review', label: 'mark reviewed', fill: { routine: 'id' } },
  { key: 't', id: 'routine-out-of-date', list: 'routines', states: ROUTINE_STATES(NOT_STALE), capability: 'routines.stale', label: 'out of date', fill: { routine: 'id' } },
  { key: 's', id: 'routine-read', list: 'routines', capability: 'routines.show', label: 'read in full', fill: { routine: 'id' } },
  { key: 'x', id: 'routine-delete', list: 'routines', capability: 'routines.delete', label: 'delete', fill: { routine: 'id' } },
  { key: 'c', id: 'routine-new', list: 'routines', whole: true, capability: 'routines.create', label: 'new routine' },
  { key: 'f', id: 'routine-search', list: 'routines', whole: true, capability: 'routines.search', label: 'search' },
  { key: 'o', id: 'routines-some', list: 'routines', whole: true, capability: 'routines.list', label: 'only some' },
  { key: 'd', id: 'routine-files', list: 'routines', whole: true, capability: 'routines.discover', label: 'routine files found' },
  { key: 'i', id: 'routine-import', list: 'routines', whole: true, capability: 'routines.import', label: 'import a file' },
  { key: 'u', id: 'routine-switch-on', list: 'routines', states: ROUTINE_ON_OFF('off'), capability: 'routines.enable', label: 'switch on', fill: { routine: 'id' } },
  { key: 'u', id: 'routine-switch-off', list: 'routines', states: ROUTINE_ON_OFF('on'), capability: 'routines.disable', label: 'switch off', fill: { routine: 'id' } },
  { key: 'p', id: 'routine-schedule', list: 'routines', capability: 'routines.promote', label: 'run on a schedule', fill: { routine: 'id' } },
  { key: 'j', id: 'routine-receipts', list: 'routines', whole: true, capability: 'routines.receipts', label: 'put on a schedule so far' },
  { key: 'k', id: 'routine-receipt', list: 'routines', whole: true, capability: 'routines.receipt', label: 'one receipt' },
  { key: 'y', id: 'routine-check', list: 'routines', whole: true, capability: 'routines.reconcile', label: 'check against the schedules' },
  // Drafts
  { key: 'enter', id: 'draft-revise', list: 'drafts', capability: 'documents.revise', label: 'revise', fill: { document: 'id' } },
  { key: 's', id: 'draft-read', list: 'drafts', capability: 'documents.show', label: 'read in full', fill: { document: 'id' } },
  { key: 'v', id: 'draft-reviewed', list: 'drafts', states: ['draft', 'archived'], capability: 'documents.mark-reviewed', label: 'mark reviewed', fill: { document: 'id' } },
  { key: 'c', id: 'draft-comment', list: 'drafts', capability: 'documents.comment', label: 'comment', fill: { document: 'id' } },
  { key: 'o', id: 'draft-resolve-comment', list: 'drafts', capability: 'documents.resolve-comment', label: 'resolve a comment', fill: { document: 'id' } },
  { key: 'g', id: 'draft-suggest', list: 'drafts', capability: 'documents.suggest', label: 'suggest a change', fill: { document: 'id' } },
  { key: 'y', id: 'draft-take-suggestion', list: 'drafts', capability: 'documents.accept-suggestion', label: 'take a suggestion', fill: { document: 'id' } },
  { key: 'l', id: 'draft-leave-suggestion', list: 'drafts', capability: 'documents.reject-suggestion', label: 'leave a suggestion', fill: { document: 'id' } },
  { key: 'i', id: 'draft-insert-artifact', list: 'drafts', capability: 'documents.insert-artifact', label: 'put an artifact in', fill: { document: 'id' } },
  { key: 'k', id: 'draft-attach-artifact', list: 'drafts', capability: 'documents.attach-artifact', label: 'attach an artifact', fill: { document: 'id' } },
  { key: 'e', id: 'draft-save-artifact', list: 'drafts', capability: 'documents.export', label: 'save as an artifact', fill: { document: 'id' } },
  { key: 'p', id: 'draft-save-preset', list: 'drafts', capability: 'documents.save-preset', label: 'save a review packet preset', fill: { document: 'id' } },
  { key: 'w', id: 'draft-new', list: 'drafts', whole: true, capability: 'documents.create', label: 'new draft' },
  { key: 'f', id: 'draft-search', list: 'drafts', whole: true, capability: 'documents.list', label: 'search' },
  { key: 'd', id: 'draft-readiness', list: 'drafts', whole: true, capability: 'documents.readiness', label: 'ready for review?' },
  { key: 't', id: 'draft-packet-steps', list: 'drafts', whole: true, capability: 'documents.packet-steps', label: 'review packet steps' },
  { key: 'h', id: 'draft-timeline', list: 'drafts', whole: true, capability: 'documents.timeline', label: 'review packet timeline' },
  // Saved artifacts
  { key: 'enter', id: 'artifact-look', list: 'artifacts', capability: 'artifacts.show', label: 'look at it', fill: { artifact: 'id' } },
  { key: 'e', id: 'artifact-copy', list: 'artifacts', capability: 'artifacts.export', label: 'copy to a file', fill: { artifact: 'id' } },
  { key: 'k', id: 'artifact-package', list: 'artifacts', capability: 'artifacts.package', label: 'copy into a package', fill: { artifacts: 'id' } },
  { key: 'u', id: 'artifact-refresh-preset', list: 'artifacts', capability: 'documents.refresh-preset', label: 'refresh as a preset', fill: { preset: 'id' } },
  { key: 'd', id: 'artifact-send-packet', list: 'artifacts', capability: 'documents.share-packet', label: 'send as a review packet', fill: { archive: 'id' } },
  { key: 'f', id: 'artifact-search', list: 'artifacts', whole: true, capability: 'artifacts.list', label: 'search' },
  // Keeping a text of your own as an artifact (commands-final: it had no control; a turn saves what it makes the same way).
  { key: 's', id: 'artifact-save', list: 'artifacts', whole: true, capability: 'artifacts.save', label: 'save one' },
  // Agent homes
  { key: 'enter', id: 'home-show', list: 'agent-homes', capability: 'agent-home.show', label: 'look at it', fill: { home: 'id' } },
  { key: 'u', id: 'home-use', list: 'agent-homes', states: ['kept'], capability: 'agent-home.use', label: 'start the Agent in it', fill: { home: 'id' } },
  { key: 'u', id: 'home-use-base', list: 'agent-homes', states: ['starts-next'], capability: 'agent-home.use-base', label: 'start in the base home instead' },
  { key: 'x', id: 'home-delete', list: 'agent-homes', capability: 'agent-home.delete', label: 'delete', fill: { home: 'id' } },
  { key: 'w', id: 'home-new', list: 'agent-homes', whole: true, capability: 'agent-home.create', label: 'new Agent home' },
  { key: 'l', id: 'home-new-learned', list: 'agent-homes', whole: true, capability: 'agent-home.create-learned', label: 'new home from what the Agent learned' },
  { key: 'm', id: 'home-next', list: 'agent-homes', whole: true, capability: 'agent-home.next', label: 'which starts next' },
  { key: 'b', id: 'home-base', list: 'agent-homes', whole: true, capability: 'agent-home.use-base', label: 'start in the base home' },
  // Starter templates
  { key: 'enter', id: 'starter-show', list: 'starters', capability: 'agent-home.starter', label: 'look at it', fill: { starter: 'id' } },
  { key: 'w', id: 'starter-new-home', list: 'starters', capability: 'agent-home.create', label: 'make an Agent home from it', fill: { starter: 'id' } },
  { key: 'e', id: 'starter-export', list: 'starters', capability: 'agent-home.export-starter', label: 'save to a file', fill: { starter: 'id' } },
  { key: 'i', id: 'starter-import', list: 'starters', whole: true, capability: 'agent-home.import-starter', label: 'add from a file' },
  { key: 'l', id: 'starter-learned', list: 'starters', whole: true, capability: 'agent-home.starter-learned', label: 'make one from what the Agent learned' },
  { key: 'g', id: 'starter-guide', list: 'starters', whole: true, capability: 'agent-home.guide', label: 'how to write one' },
];

/** The controls of the Agent's own lists (and "make a persona" on a note) are drawn only where the lists are. */
const AGENT_LISTS: ReadonlySet<string> = new Set(['personas', 'agent-homes', 'starters']);
export const MEMORY_STORE_ACTIONS: readonly PlaceAction<MemoryStoreItem>[] = EVERY_PROGRAM_ACTIONS.map((action) => (
  AGENT_LISTS.has(action.list) || action.id === 'note-to-persona' ? { ...action, programs: AGENT_HAS } : action
));

/** What the terminal side of these lists reads (memory-stores-lists.ts: the live lists a form's inputs choose from). */
export { DRAFT_WORDS, REVIEW_WORDS, RUNNING_WORDS, reviewOf };
