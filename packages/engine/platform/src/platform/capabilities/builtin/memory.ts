/**
 * Memory: what the project remembers (decisions, constraints, incidents,
 * patterns), kept in the one memory store every program reads
 * (`~/.goodvibes/shared/memory.sqlite`), whose single writer is the daemon.
 *
 * Home `daemon`: every read and write of the records, their review, links,
 * copies and search index, what a task would be given, and saving memory to
 * a file or loading one (a path is the caller's project's; a model's path
 * stays inside that project).
 *
 * Home `session`: what the program holding the conversation alone knows or
 * does: the memory its turns were given, the incident reports and trust it
 * holds, and memory kept as files in the project (written, compared and taken
 * back by the program working in that project).
 */
import { basename } from 'node:path';
import { callerPathOf, readCallerJson } from '../path-inputs.js';
import { isMemoryForProject, memoryProjectOf } from '../../state/memory-project.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import type { MemoryApi } from '../../knowledge/knowledge-api.js';
import type { MemoryRegistry } from '../../state/memory-registry.js';
import { memoryRecordTemporalStatus } from '../../state/memory-temporal.js';
import type {
  MemoryBundle, MemoryClass, MemoryRecord, MemoryReviewState, MemoryScope, MemorySearchFilter, ProvenanceLink,
} from '../../state/memory-store.js';
import type { MemoryRestoreResult, MemorySnapshotInfo } from '../../state/memory-snapshots.js';
import { CapabilityRefusal, UNNAMED_AUTHOR, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';

export interface MemoryCapabilityServices {
  readonly memory: MemoryApi;
  /** The copies of memory taken each day, before a migration and before a restore. */
  readonly memoryCopies: Pick<MemoryRegistry, 'listSnapshots' | 'restoreSnapshot' | 'decideConsolidationProposal'>;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const CLASS_VALUES: readonly MemoryClass[] = ['decision', 'constraint', 'incident', 'pattern', 'fact', 'risk', 'runbook', 'architecture', 'ownership'];
const SCOPE_VALUES: readonly MemoryScope[] = ['session', 'project', 'team'];
const STATE_VALUES: readonly MemoryReviewState[] = ['fresh', 'reviewed', 'stale', 'contradicted'];

export const MEMORY_CLASS_LABELS: Readonly<Record<MemoryClass, string>> = {
  decision: 'A decision', constraint: 'A constraint', incident: 'An incident', pattern: 'A pattern', fact: 'A fact',
  risk: 'A risk', runbook: 'A runbook', architecture: 'Architecture', ownership: 'Who owns what',
};
const SCOPE_LABELS: Readonly<Record<MemoryScope, { label: string; help: string }>> = {
  session: { label: 'This session', help: 'Given to this session\'s turns only.' },
  project: { label: 'This project', help: 'Given to work in this project.' },
  team: { label: 'Shared with the team', help: 'Part of what a team handoff carries.' },
};
export const MEMORY_STATE_LABELS: Readonly<Record<MemoryReviewState, string>> = {
  fresh: 'Not reviewed yet', reviewed: 'Reviewed and right', stale: 'Out of date', contradicted: 'Contradicted by something newer',
};
const CLASSES: readonly FixedChoice[] = CLASS_VALUES.map((cls) => ({ value: cls, label: MEMORY_CLASS_LABELS[cls] }));
const SCOPES: readonly FixedChoice[] = SCOPE_VALUES.map((scope) => ({ value: scope, ...SCOPE_LABELS[scope] }));
const REVIEW_STATES: readonly FixedChoice[] = STATE_VALUES.map((state) => ({ value: state, label: MEMORY_STATE_LABELS[state] }));

const RECORD: InputDescription = {
  id: 'record', label: 'Record', help: 'Your memory records', kind: 'choice',
  choices: { list: 'memory.records' as ListName, allowOther: { reason: 'a record id' } }, required: true, typed: { position: 1 },
};
const CLASS_FILTER: InputDescription = {
  id: 'class', label: 'Kind', help: 'Only records of one kind', kind: 'choice', choices: CLASSES,
  required: { default: '', defaultMeans: 'every kind' }, typed: { flag: '--class' },
};
const SCOPE_FILTER: InputDescription = {
  id: 'scope', label: 'Where it applies', help: 'Only records for this session, project or team', kind: 'choice', choices: SCOPES,
  required: { default: '', defaultMeans: 'everywhere' }, typed: { flag: '--scope' },
};
const FILE: InputDescription = {
  id: 'path', label: 'File', help: 'A path in this project, or an absolute path', kind: 'path', freeTextReason: 'a file path', required: true, typed: { position: 1 },
};
const TAGS: InputDescription = {
  id: 'tags', label: 'Tags', help: 'Words to find it by, separated by commas', kind: 'text', freeTextReason: 'your own words',
  required: { default: '', defaultMeans: 'none' }, typed: { flag: '--tags' },
};
const DETAIL: InputDescription = {
  id: 'detail', label: 'Detail', help: 'More about it, as long as you like', kind: 'long-text', freeTextReason: 'your own words',
  required: { default: '', defaultMeans: 'none' }, typed: { flag: '--detail' },
};

function splitTags(text: string | undefined): string[] {
  return (text ?? '').split(',').map((tag) => tag.trim()).filter(Boolean);
}
function shortTime(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}
function temporalLabel(record: MemoryRecord): string {
  const status = memoryRecordTemporalStatus(record);
  return status === 'active' ? '' : ` [${status}]`;
}
/** Who wrote a record, in words (memory-store.ts MemoryAuthor); the owner's own says nothing. */
function authorLine(record: MemoryRecord): string {
  const author = record.author;
  if (author === undefined || author.kind === 'owner') return 'you';
  if (author.kind === 'owner-model') return 'your model, in your own conversation';
  return `someone else (${author.who ?? 'not named'}); its write was decided under your permission mode, and a conversation it enters counts as having read text from outside`;
}

/** One record on one line: its id, where it applies (and for which project), its kind, its tags and its summary. */
export function memoryRecordLine(record: MemoryRecord): string {
  const tags = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
  const where = record.scope === 'project' ? (record.project ? ` (${basename(record.project)})` : ' (every project)') : '';
  const others = record.author?.kind === 'other' ? ' [written by someone else]' : '';
  return `  ${record.id}  ${record.scope}/${record.cls}${where}${tags}  ${record.summary}${temporalLabel(record)}${others}`;
}

/** The asking project's identity: the folder the caller named. A caller with none reads only the records of no project. */
function callerProject(caller: CapabilityCaller): string | undefined {
  return memoryProjectOf(caller.workingDirectory);
}

/** The project a record made or kept "this project" is for: the caller's; refused when the caller named none. */
function projectFor(scope: string, caller: CapabilityCaller, what: string): string | undefined {
  if (scope !== 'project') return undefined;
  const project = callerProject(caller);
  if (project === undefined) {
    throw new CapabilityRefusal(`${what}: "This project" needs the project, and this call named no folder; nothing was changed.`,
      'Send the project folder with the call (workingDirectory), or choose "Shared with the team" for a record every project is given.');
  }
  return project;
}
/**
 * A "this project" record taken out of its project (moved to another, or made to apply everywhere) is the owner's own
 * act: anyone else's call doing it is refused. Which records a caller may name at all is the dispatch's one check
 * (control-plane/caller-reach.ts); this is what it may do with one of its own projects' records.
 */
function refuseMoveOutOfProject(services: MemoryCapabilityServices, id: string, scope: string, project: string | undefined, caller: CapabilityCaller): void {
  const record = services.memory.get(id);
  if (!record || record.scope !== 'project' || !record.project || caller.ownerHimself === true) return;
  if (scope === 'project' && project === record.project) return;
  throw new CapabilityRefusal(`Memory record ${id} is unchanged: moving a record out of the project it belongs to is the owner's own act.`,
    'Ask the owner to move it in Memory and knowledge.');
}
/**
 * Whether one of these ids names one of the owner's shared records (a record of no project: one that applies everywhere,
 * as the reach rule reads it, control-plane/caller-reach.ts `memory-record`). Changing one (marking it, correcting it,
 * moving it, linking it, forgetting it) is the owner's own act: anyone but the owner and their own turns is put to them
 * (`ownersActWhen`, routes/capabilities.ts).
 */
export function namesSharedMemoryRecord(services: MemoryCapabilityServices, ids: readonly (string | undefined)[]): boolean {
  return ids.some((id) => {
    if (!id) return false;
    const record = services.memory.get(id);
    return record !== null && record !== undefined && !(record.scope === 'project' && record.project);
  });
}
const sharedRecordNamed = (values: Readonly<Record<string, string>>, services: MemoryCapabilityServices): boolean => namesSharedMemoryRecord(services, [values.record]);
const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

function missing(id: string, what = 'nothing was changed'): CapabilityRefusal {
  return new CapabilityRefusal(`No memory record is ${id}; ${what}.`, 'The Memory place lists every record.');
}

/** The file a path input names, as capabilities/path-inputs.ts places it for this caller (a relative one in its project). */
function filePath(path: string, caller: CapabilityCaller): string {
  return callerPathOf(caller, path);
}

function readBundle(path: string, caller: CapabilityCaller): MemoryBundle {
  // Never the parser's message or the file's text (path-inputs.ts `unreadableFile`).
  const parsed = readCallerJson(path, 'a memory file', caller, 'Nothing was loaded.');
  const bundle = parsed as Partial<MemoryBundle> | null;
  if (!bundle || bundle.schemaVersion !== 'v1' || typeof bundle.exportedAt !== 'number' || !Array.isArray(bundle.records) || !Array.isArray(bundle.links)) {
    throw new CapabilityRefusal(`${path} is not a memory file (expected schemaVersion "v1" with records and links). Nothing was loaded.`);
  }
  return parsed as MemoryBundle;
}

/** One line per copy, newest first. */
export function formatMemorySnapshots(copies: readonly MemorySnapshotInfo[]): string {
  if (copies.length === 0) return 'No copies of memory yet: the first daily copy is taken within an hour of start.';
  const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return ['Copies of memory (newest first):', ...copies.map((copy) => `  ${copy.name}  ${copy.reason}  ${shortTime(copy.createdAt)} UTC  ${size(copy.sizeBytes)}  ${copy.recordCount === null ? 'records unreadable' : plural(copy.recordCount, 'record')}`)].join('\n');
}

/** What a restore did, in one paragraph. */
export function formatMemoryRestore(result: MemoryRestoreResult): string {
  return [
    `Restored memory from ${result.restored} (${result.restoredReason}, taken ${shortTime(result.restoredCreatedAt)} UTC): ${plural(result.recordsBefore, 'record')} before, ${result.recordsAfter} now, ${plural(result.linksAfter, 'link')}.`,
    `The records it replaced were copied to ${result.undoSnapshot}; replacing memory with that copy puts them back.`,
    result.vectorIndex === 'updating'
      ? 'Semantic search catches up in the background: records whose text changed are embedded again.'
      : 'This store keeps no semantic index.',
  ].join('\n');
}

function formatVectorStats(stats: ReturnType<MemoryApi['vectorStats']>, title: string): string {
  return [
    title,
    `  works: ${stats.enabled && stats.available ? 'yes' : stats.enabled ? 'no (not available)' : 'no (turned off)'}`,
    `  records in it: ${stats.indexedRecords} (${stats.dimensions} dimensions, ${stats.backend})`,
    ...(stats.awaitingReembed > 0 ? [`  waiting to be embedded again: ${stats.awaitingReembed} (embedded by an earlier provider or model; left out of search until a rebuild)`] : []),
    ...(stats.path ? [`  kept at: ${stats.path}`] : []),
    ...(stats.error ? [`  error: ${stats.error}`] : []),
  ].join('\n');
}

/**
 * The values' filter, for the caller's project when it named one: its records and the person's own, never another
 * project's. A caller naming no project reads only the records that belong to no project (the person's own); every
 * project's at once is the owner's choice in their place's project chooser, never a capability's.
 */
function filterOf(values: Readonly<Record<string, string>>, caller?: CapabilityCaller): MemorySearchFilter {
  const project = caller ? callerProject(caller) : undefined;
  return {
    ...(values.class ? { cls: values.class as MemoryClass } : {}), ...(values.scope ? { scope: values.scope as MemoryScope } : {}),
    ...(project !== undefined ? { project } : caller && caller.everyProject !== true ? { projectless: true } : {}),
  };
}

type MemoryDefinition = CapabilityDefinition<MemoryCapabilityServices>;
const daemon = (id: string, repeat: 'safe' | 'unsafe') => ({ id, group: 'memory' as const, home: 'daemon' as const, repeat });

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

export const MEMORY_LIST: MemoryDefinition = {
  capability: daemon('memory.list', 'safe'),
  actionId: 'see-memory', label: 'See your memory', word: 'list', inputs: [CLASS_FILTER, SCOPE_FILTER],
  sentence: 'Lists everything the project remembers, by kind, newest first, with where each applies.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { class: 'decision' },
  async run(values, services, caller) {
    const records = await services.memory.search(filterOf(values, caller));
    if (records.length === 0) return { text: 'No memory records yet.', data: { records: [] } };
    const grouped = new Map<string, MemoryRecord[]>();
    for (const record of records) {
      const group = grouped.get(record.cls);
      if (group) group.push(record); else grouped.set(record.cls, [record]);
    }
    return {
      text: [...grouped].flatMap(([cls, group]) => [`${MEMORY_CLASS_LABELS[cls as MemoryClass] ?? cls} (${group.length})`, ...group.map(memoryRecordLine)]).join('\n'),
      data: { records },
    };
  },
};

export const MEMORY_ADD: MemoryDefinition = {
  capability: daemon('memory.add', 'unsafe'),
  actionId: 'remember', label: 'Remember something', word: 'add',
  inputs: [
    { id: 'class', label: 'Kind', help: 'What sort of thing it is: something decided, a rule to keep to, an incident, a fact', kind: 'choice', choices: CLASSES, required: true, typed: { position: 1 } },
    { id: 'summary', label: 'Summary', help: 'One line that says it', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    DETAIL,
    TAGS,
    { ...SCOPE_FILTER, help: 'Where it applies', required: { default: 'project', defaultMeans: 'this project' } },
    { id: 'session', label: 'From session', help: 'The session it came from', kind: 'text', freeTextReason: 'a session id', required: { default: '', defaultMeans: 'the conversation you are in' }, typed: { flag: '--session' } },
    { id: 'task', label: 'From task', help: 'The task it came from', kind: 'text', freeTextReason: 'a task id', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--task' } },
    { id: 'file', label: 'From file', help: 'The file it is about', kind: 'path', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--file' } },
  ],
  sentence: '"{summary}" will be remembered as {class} for {scope}, so later work uses it, until you change it.',
  done: 'Remembered "{summary}".',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'forget', steersModel: true,
  example: { class: 'decision', summary: 'Use SQLite for local state' },
  // Kept for "this project": only that project's screens show it.
  changesCallerProject: (values) => (values.scope || 'project') === 'project',
  async run(values, services, caller) {
    const summary = (values.summary ?? '').trim();
    if (!summary) throw new CapabilityRefusal('Nothing was remembered: the summary is empty.');
    const provenance: ProvenanceLink[] = [];
    // The session it came from: the one named, else the asking program's conversation; only a session this caller
    // registered (its own conversation), never one it merely names.
    const named = values.session && caller.registeredSession?.(values.session) === true ? values.session : undefined;
    const session = named ?? caller.sessionId;
    if (session) provenance.push({ kind: 'session', ref: session });
    if (values.task) provenance.push({ kind: 'task', ref: values.task });
    if (values.file) provenance.push({ kind: 'file', ref: values.file });
    const scope = (values.scope || 'project') as MemoryScope;
    // "This project" is the asking project's, and is given only to work there.
    const project = projectFor(scope, caller, 'Nothing was remembered');
    // Who wrote it, as the daemon authenticated the caller: kept on the record, so a conversation given someone else's
    // record counts as having read text from outside (state/memory-author.ts `noteOthersWritingRead`).
    const author = caller.author ?? UNNAMED_AUTHOR;
    const record = await services.memory.add({
      scope, ...(project !== undefined ? { project } : {}), cls: values.class as MemoryClass, summary,
      ...(values.detail ? { detail: values.detail } : {}), tags: splitTags(values.tags), provenance, author,
    });
    return { text: `Its id is ${record.id}.`, data: { record } };
  },
};

export const MEMORY_SEARCH: MemoryDefinition = {
  capability: daemon('memory.search', 'safe'),
  actionId: 'search', label: 'Search memory', word: 'search',
  inputs: [
    { id: 'query', label: 'Words', help: 'What to look for', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'every record' }, typed: { tail: true } },
    CLASS_FILTER,
    SCOPE_FILTER,
    { id: 'limit', label: 'At most', help: 'How many records to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: 'the usual number' }, typed: { flag: '--limit' } },
    { id: 'meaning', label: 'Match by', help: 'The words, or what they mean', kind: 'choice', choices: [{ value: 'words', label: 'The words' }, { value: 'meaning', label: 'What they mean', help: 'Uses the semantic search index.' }], required: { default: 'words', defaultMeans: 'the words' }, typed: { flag: '--semantic', switchOn: 'meaning' } },
  ],
  sentence: 'Finds memory records that match {query}.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { query: 'sqlite' },
  async run(values, services, caller) {
    const filter: MemorySearchFilter = { ...(values.query ? { query: values.query } : {}), ...filterOf(values, caller) };
    if (values.limit) {
      if (!/^[1-9]\d*$/.test(values.limit)) throw new CapabilityRefusal(`"At most" takes a positive whole number, not "${values.limit}".`);
      filter.limit = Number(values.limit);
    }
    const semantic = values.meaning === 'meaning';
    const scored = semantic ? await services.memory.searchSemantic({ ...filter, semantic: true }) : [];
    const records = semantic ? scored.map((entry) => entry.record) : await services.memory.search(filter);
    if (records.length === 0) return { text: 'No records match.', data: { records: [] } };
    return {
      text: [`${plural(records.length, 'record')}${semantic ? ', closest meaning first' : ''}:`, ...records.map((record) => {
        const score = scored.find((entry) => entry.record.id === record.id);
        return `${memoryRecordLine(record)}${score ? `  ${Math.round(score.similarity * 100)}% alike` : ''}`;
      })].join('\n'),
      data: { records },
    };
  },
};

export const MEMORY_SHOW: MemoryDefinition = {
  capability: daemon('memory.show', 'safe'),
  actionId: 'see-record', label: 'See one record', word: 'show', inputs: [RECORD],
  sentence: 'Shows {record} in full: where it applies, its detail, tags, where it came from and what it is linked to.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { record: 'mem-1' },
  async run(values, services) {
    const record = services.memory.get(values.record!);
    if (!record) throw new CapabilityRefusal(`No memory record is ${values.record}.`, 'The Memory place lists every record.');
    const links = services.memory.linksFor(record.id);
    const when = (value: number | undefined) => value === undefined ? '(none)' : new Date(value).toISOString().slice(0, 19).replace('T', ' ');
    return {
      text: [
        `${record.id}  ${record.summary}`,
        `  kind: ${MEMORY_CLASS_LABELS[record.cls] ?? record.cls}; applies to: ${record.scope}; review: ${MEMORY_STATE_LABELS[record.reviewState] ?? record.reviewState}, ${record.confidence}%`,
        ...(record.detail ? [`  detail: ${record.detail}`] : []),
        ...(record.tags.length ? [`  tags: ${record.tags.join(', ')}`] : []),
        `  remembered: ${when(record.createdAt)}`,
        ...(record.author !== undefined && record.author.kind !== 'owner' ? [`  written by: ${authorLine(record)}`] : []),
        ...(record.validFrom !== undefined || record.validUntil !== undefined ? [`  valid: ${when(record.validFrom)} to ${when(record.validUntil)}${temporalLabel(record)}`] : []),
        ...(record.provenance.length ? ['  came from:', ...record.provenance.map((ref) => `    ${ref.kind}: ${ref.ref}${ref.label ? ` (${ref.label})` : ''}`)] : []),
        ...(links.length ? ['  linked:', ...links.map((link) => `    ${link.fromId === record.id ? '->' : '<-'} ${link.fromId === record.id ? link.toId : link.fromId}  ${link.relation}`)] : []),
      ].join('\n'),
      data: { record, links },
    };
  },
};

export const MEMORY_EDIT: MemoryDefinition = {
  capability: daemon('memory.edit', 'safe'),
  actionId: 'edit', label: 'Correct a record', word: 'edit',
  inputs: [
    RECORD,
    { id: 'summary', label: 'Summary', help: 'The new one-line summary', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--summary' } },
    { ...DETAIL, required: { default: '', defaultMeans: 'unchanged' } },
    { ...TAGS, required: { default: '', defaultMeans: 'unchanged' } },
    { ...SCOPE_FILTER, help: 'Where it applies', required: { default: '', defaultMeans: 'unchanged' } },
  ],
  sentence: '{record} will be corrected in place (its id, kind, origin and links stay) until you change it.',
  done: 'Corrected {record}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', steersModel: true, ownersActWhen: sharedRecordNamed,
  example: { record: 'mem-1', summary: 'Use SQLite for all local state' },
  async run(values, services, caller) {
    const project = values.scope ? projectFor(values.scope, caller, `Memory record ${values.record} is unchanged`) : undefined;
    if (values.scope) refuseMoveOutOfProject(services, values.record!, values.scope, project, caller);
    const patch = {
      ...(values.summary ? { summary: values.summary.trim() } : {}),
      ...(values.detail ? { detail: values.detail.trim() } : {}),
      ...(values.tags ? { tags: splitTags(values.tags) } : {}),
      ...(values.scope ? { scope: values.scope as MemoryScope } : {}),
      ...(project !== undefined ? { project } : {}),
    };
    if (Object.keys(patch).length === 0) throw new CapabilityRefusal('Nothing was changed: give a new summary, detail, tags or where it applies.');
    // Someone else's correction makes the record someone else's words (kept on the record).
    const record = services.memory.update(values.record!, { ...patch, by: caller.author ?? UNNAMED_AUTHOR });
    if (!record) throw missing(values.record!);
    return { text: `Changed: ${Object.keys(patch).join(', ')}.`, data: { record } };
  },
};

export const MEMORY_REVIEW: MemoryDefinition = {
  capability: daemon('memory.review', 'safe'),
  actionId: 'review', label: 'Say whether a record is still right', word: 'review',
  inputs: [
    RECORD,
    { id: 'state', label: 'It is', help: 'Whether it still holds', kind: 'choice', choices: REVIEW_STATES, required: true, typed: { position: 2 } },
    { id: 'confidence', label: 'Confidence', help: 'How sure, from 0 to 100', kind: 'number', freeTextReason: 'a number from 0 to 100', required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--confidence' } },
    { id: 'reason', label: 'Why', help: 'A note for whoever reads it next', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--reason' } },
    { id: 'by', label: 'Reviewed by', help: 'Who reviewed it', kind: 'text', freeTextReason: 'a name', required: { default: '', defaultMeans: 'you (operator)' }, typed: { flag: '--by' } },
  ],
  sentence: '{record} will be marked "{state}" until you change it.',
  done: 'Marked {record} as {state}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', ownersActWhen: sharedRecordNamed,
  example: { record: 'mem-1', state: 'stale' },
  async run(values, services, caller) {
    if (values.confidence && !/^(100|[1-9]?\d)$/.test(values.confidence)) throw new CapabilityRefusal(`Confidence takes a whole number from 0 to 100, not "${values.confidence}". Nothing was changed.`);
    // "Reviewed" lets the record's text into later prompts as something the owner checked: only the owner in person counts
    // (their own press or typed words, their yes in Waiting for you), never another credential's claim to be a person.
    if (values.state === 'reviewed' && caller.author?.kind !== 'owner') {
      throw new CapabilityRefusal(`Memory record ${values.record} is unchanged: marking a record reviewed is the owner's decision that its text may reach the prompt, so it only counts when the owner asks for it in person.`, 'Ask the owner to mark it reviewed in the Memory place.');
    }
    const record = services.memory.review(values.record!, {
      state: values.state as MemoryReviewState,
      ...(values.confidence ? { confidence: Number(values.confidence) } : {}),
      reviewedBy: values.by || 'operator',
      ...(values.reason ? { staleReason: values.reason } : {}),
    });
    if (!record) throw missing(values.record!);
    return { text: `Confidence ${record.confidence}%.`, data: { record } };
  },
};

export const MEMORY_PROMOTE: MemoryDefinition = {
  capability: daemon('memory.promote', 'safe'),
  actionId: 'move', label: 'Change where a record applies', word: 'promote',
  inputs: [RECORD, { ...SCOPE_FILTER, label: 'Applies to', help: 'This session, this project or the team', required: true, typed: { position: 2 } }],
  sentence: '{record} will apply to {scope} until you change it.',
  done: '{record} now applies to {scope}.',
  touches: 'this-machine', lasts: 'kept', risk: 'none', steersModel: true, ownersActWhen: sharedRecordNamed,
  example: { record: 'mem-1', scope: 'team' },
  async run(values, services, caller) {
    const project = projectFor(values.scope!, caller, `Memory record ${values.record} is unchanged`);
    refuseMoveOutOfProject(services, values.record!, values.scope!, project, caller);
    // Where a record is given is part of what it steers: someone else's move makes it someone else's words again.
    const record = services.memory.update(values.record!, { scope: values.scope as MemoryScope, ...(project !== undefined ? { project } : {}), by: caller.author ?? UNNAMED_AUTHOR });
    if (!record) throw missing(values.record!);
    return { text: '', data: { record } };
  },
};

export const MEMORY_LINK: MemoryDefinition = {
  capability: daemon('memory.link', 'safe'),
  actionId: 'link', label: 'Link two records', word: 'link',
  inputs: [
    { ...RECORD, id: 'from', label: 'From', help: 'The record the link starts at' },
    { ...RECORD, id: 'to', label: 'To', help: 'The record it points to', typed: { position: 2 } },
    { id: 'relation', label: 'How they relate', help: 'A word such as supersedes, explains or depends-on', kind: 'text', freeTextReason: 'your own word for it', required: true, typed: { tail: true } },
  ],
  sentence: '{from} will be linked to {to} as "{relation}" until you change it.',
  done: 'Linked {from} to {to} ({relation}).',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  ownersActWhen: (values, services) => namesSharedMemoryRecord(services, [values.from, values.to]),
  example: { from: 'mem-1', to: 'mem-2', relation: 'supersedes' },
  async run(values, services) {
    const link = await services.memory.link(values.from!, values.to!, values.relation!);
    if (!link) throw new CapabilityRefusal('Not linked: check that both records exist.', 'The Memory place lists every record.');
    return { text: '', data: { link } };
  },
};

export const MEMORY_REMOVE: MemoryDefinition = {
  capability: daemon('memory.remove', 'safe'),
  actionId: 'forget', label: 'Forget a record', word: 'remove', inputs: [RECORD],
  sentence: 'Memory record {record} and its links will be deleted and cannot be recovered.',
  done: 'Forgot {record}.',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone', example: { record: 'mem-1' }, ownersActWhen: sharedRecordNamed,
  async run(values, services) {
    if (!services.memory.delete(values.record!)) throw missing(values.record!, 'nothing was deleted');
    return { text: '', data: { deleted: values.record } };
  },
};

export const MEMORY_QUEUE: MemoryDefinition = {
  capability: daemon('memory.queue', 'safe'),
  actionId: 'see-queue', label: 'See memories waiting for review', word: 'queue',
  inputs: [
    { id: 'limit', label: 'At most', help: 'How many to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '10', defaultMeans: 'ten' }, typed: { position: 1 } },
    SCOPE_FILTER,
  ],
  sentence: 'Lists the records whose review is due, least sure first.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { limit: '20', scope: 'team' },
  async run(values, services, caller) {
    if (!/^[1-9]\d*$/.test(values.limit || '10')) throw new CapabilityRefusal(`"At most" takes a positive whole number, not "${values.limit}".`);
    const project = callerProject(caller);
    const queue = (await services.memory.reviewQueue(Number(values.limit || '10'), values.scope ? values.scope as MemoryScope : undefined))
      // Naming no project: only the records of no project.
      .filter((record) => (project !== undefined ? isMemoryForProject(record, project) : caller.everyProject === true || record.project === undefined));
    if (queue.length === 0) return { text: 'Nothing is waiting for review.', data: { records: [] } };
    return {
      text: [`Waiting for review (${queue.length}):`, ...queue.map((record) => `${memoryRecordLine(record)}  ${MEMORY_STATE_LABELS[record.reviewState] ?? record.reviewState}, ${record.confidence}%${record.staleReason ? `: ${record.staleReason}` : ''}`)].join('\n'),
      data: { records: queue },
    };
  },
};

/** "See what memory a task would be given", worked out from the one memory store every program reads. */
export const MEMORY_EXPLAIN: MemoryDefinition = {
  capability: daemon('memory.explain', 'safe'),
  actionId: 'explain', label: 'See what memory a task would be given', word: 'explain',
  inputs: [
    { id: 'task', label: 'Task', help: 'The task, the way you would ask for it', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { id: 'paths', label: 'Files it would change', help: 'Paths the task would write, separated by commas', kind: 'path', freeTextReason: 'a path in this project', required: { default: '', defaultMeans: 'any' }, typed: { flag: '--scope', repeats: true } },
  ],
  sentence: 'Shows the reviewed memory that would be given to "{task}", and why.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { task: 'add a login page' },
  async run(values, services, caller) {
    const paths = (values.paths ?? '').split('\n').flatMap((entry) => entry.split(',')).map((path) => path.trim()).filter(Boolean);
    // What a task in the asking project would be given: its records and the person's own.
    const explanation = await services.memory.explain(values.task!, paths, undefined, callerProject(caller));
    const ids = explanation.injections.map((injection) => injection.id);
    if (explanation.injections.length === 0) return { text: 'No reviewed project memory would be given to that task.', data: { records: [] } };
    return { text: explanation.prompt ?? 'No reviewed project memory would be given to that task.', data: { records: ids } };
  },
};

// ---------------------------------------------------------------------------
// Moving memory, its copies and its search index
// ---------------------------------------------------------------------------

export const MEMORY_EXPORT: MemoryDefinition = {
  capability: daemon('memory.export', 'safe'),
  actionId: 'save', label: 'Save memory to a file', word: 'export',
  inputs: [{ ...FILE, file: 'written' }, SCOPE_FILTER, CLASS_FILTER],
  sentence: 'Memory records and their links ({scope}) will be written to the JSON file {path}, to back up or move memory; a file already there is replaced.',
  done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { path: 'team-memory.json', scope: 'team' },
  async run(values, services, caller) {
    const target = filePath(values.path!, caller);
    const bundle = services.memory.exportBundle(filterOf(values, caller));
    atomicWriteFileSync(target, JSON.stringify(bundle, null, 2) + '\n', { mkdirp: true });
    return { text: `Saved ${plural(bundle.recordCount, 'record')} and ${plural(bundle.linkCount, 'link')} to ${target}.`, data: { path: target, records: bundle.recordCount, links: bundle.linkCount } };
  },
};

export const MEMORY_IMPORT: MemoryDefinition = {
  capability: daemon('memory.import', 'safe'),
  actionId: 'load', label: 'Load memories from a file', word: 'import', inputs: [FILE],
  sentence: 'The records and links in the memory file {path} (one you saved, or one a colleague sent you) will be added to memory; a record already there is left as it is.',
  done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', steersModel: true, example: { path: 'team-memory.json' },
  async run(values, services, caller) {
    // The file is the caller's: its path is read in the caller's project (the folder comes from who asked).
    const target = filePath(values.path!, caller);
    // A loaded "this project" record is for the project that loads it; loaded with no project, the person's own.
    // Who wrote each loaded record is who loaded it, never the author the file claims.
    const result = await services.memory.importBundle(readBundle(target, caller), callerProject(caller), caller.author ?? UNNAMED_AUTHOR);
    return {
      text: `Loaded ${target}: ${plural(result.importedRecords, 'record')} added, ${result.skippedRecords} already there, ${plural(result.importedLinks, 'link')} added.`,
      data: { ...result },
    };
  },
};

export const MEMORY_INSPECT: MemoryDefinition = {
  capability: daemon('memory.inspect', 'safe'),
  actionId: 'inspect', label: 'Read a memory file before loading it', word: 'inspect', inputs: [FILE],
  sentence: 'Shows what the memory file {path} holds; nothing is loaded.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { path: 'team-memory.json' },
  async run(values, _services, caller) {
    const bundle = readBundle(filePath(values.path!, caller), caller);
    return {
      text: [`Memory file ${values.path}`, `  applies to: ${bundle.scope}`, `  records: ${bundle.recordCount}`, `  links: ${bundle.linkCount}`, `  saved: ${new Date(bundle.exportedAt).toISOString()}`].join('\n'),
      data: { scope: bundle.scope, records: bundle.recordCount, links: bundle.linkCount, exportedAt: bundle.exportedAt },
    };
  },
};

export const MEMORY_SNAPSHOTS: MemoryDefinition = {
  capability: daemon('memory.snapshots', 'safe'),
  actionId: 'see-copies', label: 'See copies of memory', word: 'snapshots', inputs: [],
  sentence: 'Lists the copies of memory taken each day, before a migration and before a restore, newest first.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const copies = services.memoryCopies.listSnapshots();
    return { text: formatMemorySnapshots(copies), data: { snapshots: copies } };
  },
};

export const MEMORY_RESTORE: MemoryDefinition = {
  capability: daemon('memory.restore', 'unsafe'),
  actionId: 'restore', label: 'Replace all memory with a copy', word: 'restore',
  inputs: [{ id: 'copy', label: 'Copy', help: 'The copies of memory, newest first', kind: 'choice', choices: { list: 'memory.copies' as ListName, allowOther: { reason: 'latest (the newest copy not taken by a restore), or a date such as 2026-11-19' } }, required: true, typed: { position: 1 } }],
  sentence: 'Every memory record, link and waiting proposal will be replaced by those in {copy}, until you change it; the records you have now are copied first, so restoring that copy puts them back.',
  done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'restore',
  ownerOnly: { reason: 'it replaces every memory record', instead: 'Ask the owner to choose "Replace all memory with a copy" in the Memory place.' },
  example: { copy: 'latest' },
  async run(values, services) {
    const result = await services.memoryCopies.restoreSnapshot(values.copy!);
    return { text: formatMemoryRestore(result), data: { ...result } };
  },
};

export const MEMORY_INDEX: MemoryDefinition = {
  capability: daemon('memory.index', 'safe'),
  actionId: 'see-index', label: 'See the search index', word: 'index', inputs: [],
  sentence: 'Shows the semantic search index: whether it works, how many records it holds and how many wait to be embedded again.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const stats = services.memory.vectorStats();
    return { text: formatVectorStats(stats, 'Search index'), data: { vector: stats } };
  },
};

export const MEMORY_REBUILD_INDEX: MemoryDefinition = {
  capability: daemon('memory.rebuild-index', 'safe'),
  actionId: 'rebuild-index', label: 'Rebuild the search index', word: 'rebuild-index', inputs: [],
  sentence: 'Every record is embedded again with the current provider, so semantic search covers all of memory; nothing is lost.', done: '',
  touches: 'this-machine', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const stats = await services.memory.rebuildVectorsAsync();
    return { text: formatVectorStats(stats, 'Search index rebuilt'), data: { vector: stats } };
  },
};

/** What answering a tidying proposal does, by the answer given (the store's own action names). */
const PROPOSAL_ANSWERS: readonly FixedChoice[] = [
  { value: 'keep-first', label: 'Keep the first, mark the second out of date', help: 'As proposed, for two records that disagree or repeat each other' },
  { value: 'keep-second', label: 'Keep the second, mark the first out of date' },
  { value: 'both-stand', label: 'Both are right', help: 'For two records that disagree: both are marked reviewed and the proposal is not raised again' },
  { value: 'keep-both', label: 'Keep both', help: 'For the same record twice: both are marked reviewed and the proposal is not raised again' },
  { value: 'delete', label: 'Delete the record', help: 'For a record out of date: it is removed', risk: 'cannot-be-undone' },
  { value: 'keep', label: 'Keep the record', help: 'For a record out of date: it stays, and the proposal is not raised again' },
];

export const MEMORY_DECIDE_PROPOSAL: MemoryDefinition = {
  capability: daemon('memory.decide-proposal', 'safe'),
  actionId: 'decide-proposal', label: 'Answer a tidying proposal', word: 'decide-proposal',
  inputs: [
    { id: 'proposal', label: 'Proposal', help: 'What tidying memory proposed, as the Proposals tab lists it', kind: 'text', freeTextReason: 'a proposal id from the Proposals tab', required: true, typed: { position: 1 } },
    { id: 'answer', label: 'Answer', help: 'What to do with it', kind: 'choice', choices: PROPOSAL_ANSWERS, required: true, typed: { position: 2 } },
  ],
  sentence: 'Tidying proposal {proposal} is answered: {answer}.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none', example: { proposal: 'contradiction:mem_a,mem_b', answer: 'keep-first' },
  async run(values, services) {
    const decision = services.memoryCopies.decideConsolidationProposal(values.proposal!, values.answer as Parameters<MemoryRegistry['decideConsolidationProposal']>[1]);
    if (!decision.decided) throw new CapabilityRefusal(`${decision.refusal.reason.replace(/\.$/, '')}. Nothing was changed.`, decision.refusal.next[0]);
    const changed = decision.changed.length > 0 ? ` Changed: ${decision.changed.join(', ')}.` : '';
    const removed = decision.removed.length > 0 ? ` Removed: ${decision.removed.join(', ')}.` : '';
    const said = PROPOSAL_ANSWERS.find((choice) => choice.value === values.answer)?.label ?? values.answer;
    return { text: `Answered the proposal: ${said}.${changed}${removed}`, data: { decision } };
  },
};

/** Every memory capability that runs in the daemon, in the order a person meets them. */
export const MEMORY_DAEMON_CAPABILITIES: readonly MemoryDefinition[] = [
  MEMORY_LIST, MEMORY_ADD, MEMORY_SEARCH, MEMORY_SHOW, MEMORY_EDIT, MEMORY_REVIEW, MEMORY_PROMOTE, MEMORY_LINK, MEMORY_REMOVE,
  MEMORY_QUEUE, MEMORY_EXPLAIN, MEMORY_EXPORT, MEMORY_INSPECT, MEMORY_IMPORT, MEMORY_SNAPSHOTS, MEMORY_RESTORE, MEMORY_INDEX, MEMORY_REBUILD_INDEX,
  MEMORY_DECIDE_PROPOSAL,
];
