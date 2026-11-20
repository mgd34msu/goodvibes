/**
 * `/memory`, described once (command-actions/): the durable project memory
 * both terminal apps share. Remember something, find, read, correct, link and
 * review records, explain what a task would be given, keep memory as files in
 * its own repository, save it to a file or load one, and list or restore the
 * copies taken of it. Every read and write goes through the memory spine, so
 * with a daemon attached it acts on the daemon's store; `explain` and the
 * search index stay on this app's own store, as before.
 */
import { existsSync, readFileSync } from 'node:fs';
import { atomicWriteFileSync, type ConfigKey, type ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemorySpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import {
  buildIncidentMemoryAddOptions,
  buildMcpSecurityMemoryAddOptions,
  buildPluginSecurityMemoryAddOptions,
  buildPolicyPreflightMemoryAddOptions,
  createMemoryProjectionGit,
  diffProjectionToProposals,
  findOrphanedProjectionFiles,
  projectMemoryToFiles,
  readProjectedMemoryFiles,
  type MemoryBundle,
  type MemoryClass,
  type MemoryProjectionProposal,
  type MemoryRecord,
  type MemoryRestoreResult,
  type MemoryReviewState,
  type MemoryScope,
  type MemorySearchFilter,
  type MemorySnapshotInfo,
  type ProvenanceLink,
} from '@goodvibes-jev/engine/platform/platform/state';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand, type DescribedCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, FixedChoice, InputDescription } from './command-actions/types.js';
import { VALID_CLASSES, VALID_REVIEW_STATES, VALID_SCOPES, resolveConfinedBundlePath, temporalStatusLabel } from './recall-shared.js';

type CaptureExtensions = {
  readonly forensicsRegistry?: {
    latest(): { readonly id: string } | null | undefined;
    getById(id: string): { readonly id: string } | null | undefined;
    buildBundle(id: string): Parameters<typeof buildIncidentMemoryAddOptions>[0] | null | undefined;
  } | null | undefined;
  readonly policyRuntimeState?: { getSnapshot(): { readonly lastPreflightReview?: Parameters<typeof buildPolicyPreflightMemoryAddOptions>[0] | null | undefined } } | null | undefined;
  readonly mcpRegistry: { listServerSecurity(): readonly Parameters<typeof buildMcpSecurityMemoryAddOptions>[0][] };
  readonly pluginManager?: {
    list(): readonly Parameters<typeof buildPluginSecurityMemoryAddOptions>[0][];
    getQuarantineRecord(name: string): { readonly reason: string } | null | undefined;
  } | null | undefined;
};

export interface MemoryCommandContext extends CommandActionContext {
  readonly clients?: {
    readonly memorySpine?: MemorySpineClient | null | undefined;
    readonly knowledgeApi?: { readonly memory?: MemoryApi | null | undefined } | null | undefined;
  } | null | undefined;
  readonly session: { readonly runtime: { readonly sessionId: string } };
  readonly extensions: CaptureExtensions;
  readonly workspace: { readonly shellPaths?: ShellPathService | null | undefined };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get'> };
}

/** What differs between the two apps. */
export interface MemoryCommandPolicy<Ctx> {
  /** Open the memory screen, or refuse with where it is. */
  readonly open: (ctx: Ctx) => void;
  /** The memory a turn (or an agent's turns) was given; undefined when this app does not record it. */
  readonly injections: ((ctx: Ctx, agentId: string) => string) | undefined;
}

/** The most records one read takes; a read that reaches it is not the whole store. */
const PROJECTION_LIST_LIMIT = 5000;
const LIST_LIMIT = 50;

function spineOf(ctx: MemoryCommandContext): MemorySpineClient {
  const spine = ctx.clients?.memorySpine;
  if (!spine) throw commandRefusal('Memory is not available in this session; nothing was read or changed.', 'Restart the app; memory loads with it.');
  return spine;
}
function localMemoryOf(ctx: MemoryCommandContext): MemoryApi {
  const memory = ctx.clients?.knowledgeApi?.memory;
  if (!memory) throw commandRefusal('This app\'s own memory store is not available in this session.', 'Restart the app; memory loads with it.');
  return memory;
}
function pathsOf(ctx: MemoryCommandContext): ShellPathService {
  const paths = ctx.workspace.shellPaths;
  if (!paths) throw commandRefusal('This session has no working directory, so no file path can be used.');
  return paths;
}
/** A path a model-run line may use only inside the workspace. */
function confinedPath(ctx: MemoryCommandContext, path: string): string {
  const resolved = resolveConfinedBundlePath(path, pathsOf(ctx), ctx.invokedByModel);
  if (resolved === undefined) throw commandRefusal(`${path} is outside the workspace. A command the model runs may only use paths inside the workspace; nothing was read or written.`, 'Ask the owner to run it for another place.');
  return resolved;
}

function shortTime(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}
function recordLine(record: MemoryRecord): string {
  const tags = record.tags.length ? ` [${record.tags.join(', ')}]` : '';
  return `  ${record.id}  ${record.scope}/${record.cls}${tags}  ${record.summary}${temporalStatusLabel(record)}`;
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

const MEMORY_RECORDS = defineList<MemoryCommandContext>({
  name: 'memory.records',
  async read(ctx) {
    return (await spineOf(ctx).list({ limit: 200 })).map((record): ListRow => ({
      value: record.id, label: record.summary, detail: record.id, state: `${record.scope} ${record.cls}`,
    }));
  },
  operator: { method: 'memory.records.list', input: {}, rows: { from: 'records', value: 'id', label: 'summary', detail: 'id', state: 'cls' } },
});

const MEMORY_COPIES = defineList<MemoryCommandContext>({
  name: 'memory.copies',
  async read(ctx) {
    return (await spineOf(ctx).listSnapshots()).map((copy): ListRow => ({
      value: copy.name, label: copy.name, detail: `${copy.reason}, ${shortTime(copy.createdAt)} UTC`,
      state: copy.recordCount === null ? 'records unreadable' : `${copy.recordCount} record${copy.recordCount === 1 ? '' : 's'}`,
    }));
  },
  operator: { method: 'memory.snapshots.list', input: {}, rows: { from: 'snapshots', value: 'name', label: 'name', detail: 'reason' } },
});

const MEMORY_PROPOSALS = defineList<MemoryCommandContext>({
  name: 'memory.file-proposals',
  async read(ctx, earlier) {
    const dir = projectionDirFor(ctx, earlier.dir ?? '');
    if (!existsSync(dir)) return [];
    const { proposals } = await computeProposals(ctx, dir);
    return [
      ...(proposals.length > 1 ? [{ value: 'all', label: 'Every proposal', state: `${proposals.length}` }] : []),
      ...proposals.map((proposal): ListRow => ({
        value: proposal.id, label: proposal.id, detail: proposal.reason,
        state: proposal.kind === 'delete' ? 'deletes the record' : `changes ${(proposal.changedFields ?? []).join(', ')}`,
      })),
    ];
  },
  operator: { terminalOnly: 'Memory files live in the terminal app\'s project.' },
});

/** The memory files folder setting (`memory.projection.dir`), relative to the project. */
const PROJECTION_DIR_KEY = 'memory.projection.dir' as ConfigKey;
const PROJECTION_DIR_DEFAULT = '.goodvibes/memory/projection';
function projectionDirFor(ctx: MemoryCommandContext, given: string): string {
  let configured: unknown;
  try { configured = ctx.platform.configManager.get(PROJECTION_DIR_KEY); } catch { configured = undefined; }
  const relative = given || (typeof configured === 'string' && configured ? configured : PROJECTION_DIR_DEFAULT);
  return confinedPath(ctx, relative);
}

async function readAllForProjection(ctx: MemoryCommandContext): Promise<{ readonly records: readonly MemoryRecord[]; readonly complete: boolean }> {
  const records = await spineOf(ctx).list({ limit: PROJECTION_LIST_LIMIT });
  return { records, complete: records.length < PROJECTION_LIST_LIMIT };
}

async function computeProposals(ctx: MemoryCommandContext, dir: string) {
  const { records, complete } = await readAllForProjection(ctx);
  const files = readProjectedMemoryFiles(dir);
  return {
    proposals: diffProjectionToProposals(records, files),
    orphans: findOrphanedProjectionFiles(records, files, { complete }),
    unreadable: [...(files.unreadableIds ?? [])],
    complete,
  };
}

// ---------------------------------------------------------------------------
// Blanks
// ---------------------------------------------------------------------------

const CLASS_LABELS: Readonly<Record<MemoryClass, string>> = {
  decision: 'A decision', constraint: 'A constraint', incident: 'An incident', pattern: 'A pattern', fact: 'A fact',
  risk: 'A risk', runbook: 'A runbook', architecture: 'Architecture', ownership: 'Who owns what',
};
const CLASSES: readonly FixedChoice[] = VALID_CLASSES.map((cls) => ({ value: cls, label: CLASS_LABELS[cls] }));
const SCOPE_LABELS: Readonly<Record<MemoryScope, { label: string; help: string }>> = {
  session: { label: 'This session', help: 'Given to this session\'s turns only.' },
  project: { label: 'This project', help: 'Given to work in this project.' },
  team: { label: 'Shared with the team', help: 'Part of what a team handoff carries.' },
};
const SCOPES: readonly FixedChoice[] = VALID_SCOPES.map((scope) => ({ value: scope, ...SCOPE_LABELS[scope] }));
const STATE_LABELS: Readonly<Record<MemoryReviewState, string>> = {
  fresh: 'Not reviewed yet', reviewed: 'Reviewed and right', stale: 'Out of date', contradicted: 'Contradicted by something newer',
};
const REVIEW_STATES: readonly FixedChoice[] = VALID_REVIEW_STATES.map((state) => ({ value: state, label: STATE_LABELS[state] }));

const RECORD: InputDescription = {
  id: 'record', label: 'Record', help: 'Your memory records', kind: 'choice',
  choices: { list: MEMORY_RECORDS, allowOther: { reason: 'a record id from /memory list' } }, required: true, typed: { position: 1 },
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
const PROJECTION_DIR: InputDescription = {
  id: 'dir', label: 'Folder', help: 'Where the memory files are kept', kind: 'path', freeTextReason: 'a folder in this project',
  required: { default: '', defaultMeans: 'the memory files folder in the settings' }, typed: { flag: '--dir' },
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

function readBundle(path: string): MemoryBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw commandRefusal(`Could not read ${path}: ${summarizeError(error)}. Nothing was loaded.`);
  }
  const bundle = parsed as Partial<MemoryBundle> | null;
  if (!bundle || bundle.schemaVersion !== 'v1' || typeof bundle.exportedAt !== 'number' || !Array.isArray(bundle.records) || !Array.isArray(bundle.links)) {
    throw commandRefusal(`${path} is not a memory file (expected schemaVersion "v1" with records and links). Nothing was loaded.`);
  }
  return parsed as MemoryBundle;
}

/** One line per copy, newest first. */
export function formatMemorySnapshots(copies: readonly MemorySnapshotInfo[]): string {
  if (copies.length === 0) return 'No copies of memory yet: the first daily copy is taken within an hour of start.';
  const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return ['Copies of memory (newest first):', ...copies.map((copy) => `  ${copy.name}  ${copy.reason}  ${shortTime(copy.createdAt)} UTC  ${size(copy.sizeBytes)}  ${copy.recordCount === null ? 'records unreadable' : `${copy.recordCount} record${copy.recordCount === 1 ? '' : 's'}`}`)].join('\n');
}

/** What a restore did, in one paragraph. */
export function formatMemoryRestore(result: MemoryRestoreResult): string {
  return [
    `Restored memory from ${result.restored} (${result.restoredReason}, taken ${shortTime(result.restoredCreatedAt)} UTC): ${result.recordsBefore} record${result.recordsBefore === 1 ? '' : 's'} before, ${result.recordsAfter} now, ${result.linksAfter} link${result.linksAfter === 1 ? '' : 's'}.`,
    `The records it replaced were copied to ${result.undoSnapshot}; /memory restore ${result.undoSnapshot} puts them back.`,
    result.vectorIndex === 'updating'
      ? 'Semantic search catches up in the background: records whose text changed are embedded again.'
      : 'This store keeps no semantic index.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

function describeMemory<Ctx extends MemoryCommandContext>(policy: MemoryCommandPolicy<Ctx>): CommandDescription<Ctx> {
  return {
    name: 'memory',
    title: 'Memory',
    summary: 'What the project remembers: decisions, constraints, incidents and patterns, with where each came from',
    group: 'Knowledge',
    report: 'see-memory',
    firstScreenRows: [
      'see-memory',
      'remember',
      'search',
      'see-record',
      { label: 'Correct or review a record', actions: ['edit', 'review', 'move', 'link', 'forget', 'see-queue'] },
      { label: 'See what a task is given', actions: ['explain', 'see-injections'] },
      { label: 'Keep memory as files, or move it', actions: ['sync-files', 'review-files', 'apply-files', 'save', 'inspect', 'load'] },
      { label: 'Copies of memory and the search index', actions: ['see-copies', 'restore', 'see-index', 'rebuild-index'] },
      'capture',
      'open-screen',
    ],
    actions: [
      {
        id: 'see-memory', label: 'See your memory', word: 'list', inputs: [CLASS_FILTER, SCOPE_FILTER],
        async rowValue(ctx) {
          const records = await spineOf(ctx).list({ limit: LIST_LIMIT });
          return records.length === 0 ? 'nothing yet' : records.length >= LIST_LIMIT ? `${LIST_LIMIT} or more records` : `${records.length} record${records.length === 1 ? '' : 's'}`;
        },
        sentence: 'Lists memory records by kind, newest first, with where each applies.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.records.list', fields: { cls: 'class', scope: 'scope' } }, example: { class: 'decision' },
        async run(values, ctx) {
          const filter: MemorySearchFilter = { limit: LIST_LIMIT, ...(values.class ? { cls: values.class as MemoryClass } : {}), ...(values.scope ? { scope: values.scope as MemoryScope } : {}) };
          const records = await spineOf(ctx).list(filter);
          if (records.length === 0) return 'No memory records yet. Remember something with /memory, "Remember something".';
          const grouped = new Map<string, MemoryRecord[]>();
          for (const record of records) grouped.set(record.cls, [...(grouped.get(record.cls) ?? []), record]);
          return [
            ...(records.length >= LIST_LIMIT ? [`Showing ${records.length} records; there may be more. Choose a kind or where it applies, or search.`] : []),
            ...[...grouped].flatMap(([cls, group]) => [`${CLASS_LABELS[cls as MemoryClass] ?? cls} (${group.length})`, ...group.map(recordLine)]),
          ].join('\n');
        },
      },
      {
        id: 'remember', label: 'Remember something', word: 'add',
        inputs: [
          { id: 'class', label: 'Kind', help: 'What sort of thing it is', kind: 'choice', choices: CLASSES, required: true, typed: { position: 1 } },
          { id: 'summary', label: 'Summary', help: 'One line that says it', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
          DETAIL,
          TAGS,
          { ...SCOPE_FILTER, help: 'Where it applies', required: { default: 'project', defaultMeans: 'this project' } },
          { id: 'session', label: 'From session', help: 'The session it came from', kind: 'text', freeTextReason: 'a session id', required: { default: '', defaultMeans: 'this session' }, typed: { flag: '--session' } },
          { id: 'task', label: 'From task', help: 'The task it came from', kind: 'text', freeTextReason: 'a task id', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--task' } },
          { id: 'file', label: 'From file', help: 'The file it is about', kind: 'path', freeTextReason: 'a file path', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--file' } },
        ],
        sentence: '"{summary}" will be remembered as {class} for {scope} until you change it.',
        done: 'Remembered "{summary}".',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'forget',
        operator: { method: 'memory.records.add', fields: { cls: 'class', summary: 'summary', detail: 'detail', scope: 'scope' } },
        example: { class: 'decision', summary: 'Use SQLite for local state' },
        async run(values, ctx) {
          const provenance: ProvenanceLink[] = [];
          if (values.session) provenance.push({ kind: 'session', ref: values.session });
          if (values.task) provenance.push({ kind: 'task', ref: values.task });
          if (values.file) provenance.push({ kind: 'file', ref: values.file });
          if (!values.session && ctx.session.runtime.sessionId) provenance.push({ kind: 'session', ref: ctx.session.runtime.sessionId });
          const summary = values.summary!.trim();
          if (!summary) throw commandRefusal('Nothing was remembered: the summary is empty.');
          const record = await spineOf(ctx).add({
            scope: (values.scope || 'project') as MemoryScope, cls: values.class as MemoryClass, summary,
            ...(values.detail ? { detail: values.detail } : {}), tags: splitTags(values.tags), provenance,
          });
          return `Its id is ${record.id}.`;
        },
      },
      {
        id: 'search', label: 'Search memory', word: 'search',
        inputs: [
          { id: 'query', label: 'Words', help: 'What to look for', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'every record' }, typed: { tail: true } },
          CLASS_FILTER,
          SCOPE_FILTER,
          { id: 'limit', label: 'At most', help: 'How many records to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '', defaultMeans: 'the usual number' }, typed: { flag: '--limit' } },
          { id: 'meaning', label: 'Match by', help: 'The words, or what they mean', kind: 'choice', choices: [{ value: 'words', label: 'The words' }, { value: 'meaning', label: 'What they mean', help: 'Uses the semantic search index.' }], required: { default: 'words', defaultMeans: 'the words' }, typed: { flag: '--semantic', switchOn: 'meaning' } },
        ],
        sentence: 'Finds memory records that match {query}.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.records.search', fields: { query: 'query' } }, example: { query: 'sqlite' },
        async run(values, ctx) {
          const filter: MemorySearchFilter = {
            ...(values.query ? { query: values.query } : {}),
            ...(values.class ? { cls: values.class as MemoryClass } : {}),
            ...(values.scope ? { scope: values.scope as MemoryScope } : {}),
          };
          if (values.limit) {
            if (!/^[1-9]\d*$/.test(values.limit)) throw commandRefusal(`"At most" takes a positive whole number, not "${values.limit}".`);
            filter.limit = Number(values.limit);
          }
          const semantic = values.meaning === 'meaning';
          const spine = spineOf(ctx);
          const scored = semantic ? await spine.searchSemantic({ ...filter, semantic: true }) : [];
          const records = semantic ? scored.map((entry) => entry.record) : await spine.list(filter);
          if (records.length === 0) return 'No records match.';
          return [`${records.length} record${records.length === 1 ? '' : 's'}${semantic ? ', closest meaning first' : ''}:`, ...records.flatMap((record) => {
            const score = scored.find((entry) => entry.record.id === record.id);
            return [`${recordLine(record)}${score ? `  ${Math.round(score.similarity * 100)}% alike` : ''}`];
          })].join('\n');
        },
      },
      {
        id: 'see-record', label: 'See one record', word: 'show', inputs: [RECORD],
        sentence: 'Shows {record} in full: where it applies, its detail, tags, where it came from and what it is linked to.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.records.get', fields: { id: 'record' } }, example: { record: 'mem-1' },
        async run(values, ctx) {
          const spine = spineOf(ctx);
          const record = await spine.get(values.record!);
          if (!record) throw commandRefusal(`No memory record is ${values.record}.`, '/memory list shows the records.');
          const links = await spine.linksFor(record.id);
          const when = (value: number | undefined) => value === undefined ? '(none)' : new Date(value).toISOString().slice(0, 19).replace('T', ' ');
          return [
            `${record.id}  ${record.summary}`,
            `  kind: ${CLASS_LABELS[record.cls] ?? record.cls}; applies to: ${record.scope}; review: ${STATE_LABELS[record.reviewState] ?? record.reviewState}, ${record.confidence}%`,
            ...(record.detail ? [`  detail: ${record.detail}`] : []),
            ...(record.tags.length ? [`  tags: ${record.tags.join(', ')}`] : []),
            `  remembered: ${when(record.createdAt)}`,
            ...(record.validFrom !== undefined || record.validUntil !== undefined ? [`  valid: ${when(record.validFrom)} to ${when(record.validUntil)}${temporalStatusLabel(record)}`] : []),
            ...(record.provenance.length ? ['  came from:', ...record.provenance.map((ref) => `    ${ref.kind}: ${ref.ref}${ref.label ? ` (${ref.label})` : ''}`)] : []),
            ...(links.length ? ['  linked:', ...links.map((link) => `    ${link.fromId === record.id ? '->' : '<-'} ${link.fromId === record.id ? link.toId : link.fromId}  ${link.relation}`)] : []),
          ].join('\n');
        },
      },
      {
        id: 'edit', label: 'Correct a record', word: 'edit',
        inputs: [
          RECORD,
          { id: 'summary', label: 'Summary', help: 'The new one-line summary', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--summary' } },
          { ...DETAIL, required: { default: '', defaultMeans: 'unchanged' } },
          { ...TAGS, required: { default: '', defaultMeans: 'unchanged' } },
          { ...SCOPE_FILTER, help: 'Where it applies', required: { default: '', defaultMeans: 'unchanged' } },
        ],
        sentence: '{record} will be corrected in place (its id, kind, origin and links stay) until you change it.',
        done: 'Corrected {record}.',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'memory.records.update', fields: { id: 'record', summary: 'summary', detail: 'detail', scope: 'scope' } },
        example: { record: 'mem-1', summary: 'Use SQLite for all local state' },
        async run(values, ctx) {
          const patch = {
            ...(values.summary ? { summary: values.summary.trim() } : {}),
            ...(values.detail ? { detail: values.detail.trim() } : {}),
            ...(values.tags ? { tags: splitTags(values.tags) } : {}),
            ...(values.scope ? { scope: values.scope as MemoryScope } : {}),
          };
          if (Object.keys(patch).length === 0) throw commandRefusal('Nothing was changed: give a new summary, detail, tags or where it applies.', `/memory show ${values.record} shows the record first.`);
          const record = await spineOf(ctx).update(values.record!, patch);
          if (!record) throw commandRefusal(`No memory record is ${values.record}; nothing was changed.`);
          return `Changed: ${Object.keys(patch).join(', ')}.`;
        },
      },
      {
        id: 'review', label: 'Say whether a record is still right', word: 'review',
        inputs: [
          RECORD,
          { id: 'state', label: 'It is', help: 'Whether it still holds', kind: 'choice', choices: REVIEW_STATES, required: true, typed: { position: 2 } },
          { id: 'confidence', label: 'Confidence', help: 'How sure, from 0 to 100', kind: 'number', freeTextReason: 'a number from 0 to 100', required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--confidence' } },
          { id: 'reason', label: 'Why', help: 'A note for whoever reads it next', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { flag: '--reason' } },
          { id: 'by', label: 'Reviewed by', help: 'Who reviewed it', kind: 'text', freeTextReason: 'a name', required: { default: '', defaultMeans: 'you (operator)' }, typed: { flag: '--by' } },
        ],
        sentence: '{record} will be marked "{state}" until you change it.',
        done: 'Marked {record} as {state}.',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'memory.records.update-review', fields: { id: 'record', state: 'state' } },
        example: { record: 'mem-1', state: 'stale' },
        async run(values, ctx) {
          if (values.confidence && !/^(100|[1-9]?\d)$/.test(values.confidence)) throw commandRefusal(`Confidence takes a whole number from 0 to 100, not "${values.confidence}". Nothing was changed.`);
          const record = await spineOf(ctx).updateReview(values.record!, {
            state: values.state as MemoryReviewState,
            ...(values.confidence ? { confidence: Number(values.confidence) } : {}),
            reviewedBy: values.by || 'operator',
            ...(values.reason ? { staleReason: values.reason } : {}),
          });
          if (!record) throw commandRefusal(`No memory record is ${values.record}; nothing was changed.`);
          return `Confidence ${record.confidence}%.`;
        },
      },
      {
        id: 'move', label: 'Change where a record applies', word: 'promote',
        inputs: [RECORD, { ...SCOPE_FILTER, label: 'Applies to', help: 'This session, this project or the team', required: true, typed: { position: 2 } }],
        sentence: '{record} will apply to {scope} until you change it.',
        done: '{record} now applies to {scope}.',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'memory.records.update', fields: { id: 'record', scope: 'scope' } },
        example: { record: 'mem-1', scope: 'team' },
        async run(values, ctx) {
          const record = await spineOf(ctx).update(values.record!, { scope: values.scope as MemoryScope });
          if (!record) throw commandRefusal(`No memory record is ${values.record}; nothing was changed.`);
        },
      },
      {
        id: 'link', label: 'Link two records', word: 'link',
        inputs: [
          { ...RECORD, id: 'from', label: 'From', help: 'The record the link starts at' },
          { ...RECORD, id: 'to', label: 'To', help: 'The record it points to', typed: { position: 2 } },
          { id: 'relation', label: 'How they relate', help: 'A word such as supersedes, explains or depends-on', kind: 'text', freeTextReason: 'your own word for it', required: true, typed: { tail: true } },
        ],
        sentence: '{from} will be linked to {to} as "{relation}" until you change it.',
        done: 'Linked {from} to {to} ({relation}).',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'memory.records.links.add', fields: { fromId: 'from', toId: 'to', relation: 'relation' } },
        example: { from: 'mem-1', to: 'mem-2', relation: 'supersedes' },
        async run(values, ctx) {
          const link = await spineOf(ctx).link(values.from!, values.to!, values.relation!);
          if (!link) throw commandRefusal('Not linked: check that both records exist.', '/memory list shows the records.');
        },
      },
      {
        id: 'forget', label: 'Forget a record', word: 'remove', inputs: [RECORD],
        sentence: 'Memory record {record} and its links will be deleted and cannot be recovered.',
        done: 'Forgot {record}.',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        operator: { method: 'memory.records.delete', fields: { id: 'record' } }, example: { record: 'mem-1' },
        async run(values, ctx) {
          if (!(await spineOf(ctx).delete(values.record!))) throw commandRefusal(`No memory record is ${values.record}; nothing was deleted.`);
        },
      },
      {
        id: 'see-queue', label: 'See records waiting for review', word: 'queue',
        inputs: [
          { id: 'limit', label: 'At most', help: 'How many to show', kind: 'number', freeTextReason: 'a whole number', required: { default: '10', defaultMeans: 'ten' }, typed: { position: 1 } },
          SCOPE_FILTER,
        ],
        sentence: 'Lists the records whose review is due, least sure first.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.review-queue', fields: {} }, example: { limit: '20', scope: 'team' },
        async run(values, ctx) {
          if (!/^[1-9]\d*$/.test(values.limit || '10')) throw commandRefusal(`"At most" takes a positive whole number, not "${values.limit}".`);
          const queue = await spineOf(ctx).reviewQueue(Number(values.limit || '10'), values.scope ? values.scope as MemoryScope : undefined);
          if (queue.length === 0) return 'Nothing is waiting for review.';
          return [`Waiting for review (${queue.length}):`, ...queue.map((record) => `${recordLine(record)}  ${STATE_LABELS[record.reviewState] ?? record.reviewState}, ${record.confidence}%${record.staleReason ? `: ${record.staleReason}` : ''}`)].join('\n');
        },
      },
      {
        id: 'explain', label: 'See what memory a task would be given', word: 'explain',
        inputs: [
          { id: 'task', label: 'Task', help: 'The task, the way you would ask for it', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
          { id: 'paths', label: 'Files it would change', help: 'Paths the task would write, separated by commas', kind: 'path', freeTextReason: 'a path in this project', required: { default: '', defaultMeans: 'any' }, typed: { flag: '--scope', repeats: true } },
        ],
        sentence: 'Shows the reviewed memory that would be given to "{task}", and why.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'It is worked out from this app\'s own memory store.' }, example: { task: 'add a login page' },
        async run(values, ctx) {
          const explanation = await localMemoryOf(ctx).explain(values.task!, (values.paths ?? '').split('\n').flatMap((entry) => entry.split(',')).map((path) => path.trim()).filter(Boolean));
          if (explanation.injections.length === 0) return 'No reviewed project memory would be given to that task.';
          return explanation.prompt ?? 'No reviewed project memory would be given to that task.';
        },
      },
      {
        id: 'see-injections', label: 'See what memory a turn was given', word: 'injections',
        inputs: [{ id: 'agent', label: 'Agent', help: 'An agent this session started', kind: 'text', freeTextReason: 'an agent id from /agents', required: { default: '', defaultMeans: 'this session\'s own turns' }, typed: { position: 1 } }],
        sentence: 'Shows the memory each recent turn of {agent} was given.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'It is recorded in the terminal app\'s session.' }, example: { agent: 'agent-1' },
        async run(values, ctx) {
          if (!policy.injections) throw commandRefusal('This app does not record the memory each turn was given.', '/memory explain <task> shows what a task would be given.');
          return policy.injections(ctx, values.agent ?? '');
        },
      },
      {
        id: 'sync-files', label: 'Write memory as files', word: 'sync-files', inputs: [PROJECTION_DIR],
        sentence: 'Each project and team record is written as a file in {dir} and committed in that folder\'s own repository, until you change it; a file you edited is kept as it is.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: 'Memory files live in the terminal app\'s project.' }, example: { dir: 'notes/memory' },
        async run(values, ctx) {
          const dir = projectionDirFor(ctx, values.dir ?? '');
          const { records, complete } = await readAllForProjection(ctx);
          let report;
          try {
            report = projectMemoryToFiles(records, dir, { git: createMemoryProjectionGit(), complete });
          } catch (error) {
            throw commandRefusal(`Memory files were not written: ${summarizeError(error)}`);
          }
          return [
            `Wrote ${report.written.length} file${report.written.length === 1 ? '' : 's'} in ${report.dir}.`,
            ...(complete ? [] : [`The store holds more than ${PROJECTION_LIST_LIMIT} records, the most one read takes; files of records past that were left as they are${report.unchecked ? ` (${report.unchecked})` : ''}.`]),
            ...(report.kept?.length ? [`Kept ${report.kept.length} file${report.kept.length === 1 ? '' : 's'} you edited or deleted: ${report.kept.join(', ')}. "See what edited memory files would change" lists them; a changed kind, confidence or review line has no proposal, so change it back by hand.`] : []),
            ...(report.removed?.length ? [`Removed ${report.removed.length} file${report.removed.length === 1 ? '' : 's'} whose record was deleted: ${report.removed.join(', ')}.`] : []),
            ...(report.orphaned?.length ? [`Kept ${report.orphaned.length} edited file${report.orphaned.length === 1 ? '' : 's'} whose record was deleted: ${report.orphaned.join(', ')}. Their edits cannot reach memory; delete the files, or remember it again.`] : []),
            report.committed ? `Committed in ${report.dir}'s own repository.` : 'Nothing was committed (nothing changed, or git did not run).',
          ].join('\n');
        },
      },
      {
        id: 'review-files', label: 'See what edited memory files would change', word: 'review-files', inputs: [PROJECTION_DIR],
        sentence: 'Compares the memory files in {dir} with memory and lists what your edits would change; nothing is changed.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'Memory files live in the terminal app\'s project.' }, example: { dir: 'notes/memory' },
        async run(values, ctx) {
          const dir = projectionDirFor(ctx, values.dir ?? '');
          if (!existsSync(dir)) throw commandRefusal(`There are no memory files in ${dir} yet.`, 'Write them first: /memory sync-files');
          const { proposals, orphans, unreadable, complete } = await computeProposals(ctx, dir);
          const lines = [
            ...(complete ? [] : [`The store holds more than ${PROJECTION_LIST_LIMIT} records; files of records past that were not compared.`]),
            ...(unreadable.length ? [`${unreadable.length} file${unreadable.length === 1 ? '' : 's'} cannot be read as memory (the lines at the top were changed): ${unreadable.join(', ')}. Fix them by hand; they are not taken as deletions.`] : []),
            ...(orphans.length ? [`${orphans.length} file${orphans.length === 1 ? '' : 's'} whose record no longer exists: ${orphans.map((orphan) => orphan.id).join(', ')}. An edit to one cannot reach memory.`] : []),
            ...(proposals.length ? [`${proposals.length} change${proposals.length === 1 ? '' : 's'} from your edits:`, ...proposals.map((proposal) => `  ${proposal.id}  ${proposal.kind === 'delete' ? 'deletes the record (its file was deleted)' : `changes ${(proposal.changedFields ?? []).join(', ')}`}`), 'Nothing has been applied: /memory apply-files <id> or all.'] : []),
          ];
          return lines.length ? lines.join('\n') : `The files in ${dir} match memory.`;
        },
      },
      {
        id: 'apply-files', label: 'Take edited memory files into memory', word: 'apply-files',
        inputs: [
          PROJECTION_DIR,
          { id: 'proposal', label: 'Change', help: 'Changes your file edits would make', kind: 'choice', choices: { list: MEMORY_PROPOSALS, dependsOn: 'dir', allowOther: { reason: 'a record id from "See what edited memory files would change", or all' } }, required: true, typed: { position: 1 } },
        ],
        sentence: 'The change {proposal} from your memory files will be made in memory until you change it; a deleted file deletes its record.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        // A file a model could write would otherwise become memory without the owner reading it.
        ownerOnly: { reason: 'it turns file edits into memory', instead: 'Ask the owner to review the files and apply them; /memory review-files lists the changes.' },
        operator: { terminalOnly: 'Memory files live in the terminal app\'s project.' }, example: { proposal: 'all' },
        async run(values, ctx) {
          const dir = projectionDirFor(ctx, values.dir ?? '');
          if (!existsSync(dir)) throw commandRefusal(`There are no memory files in ${dir} yet.`, 'Write them first: /memory sync-files');
          const spine = spineOf(ctx);
          const { proposals } = await computeProposals(ctx, dir);
          const targeted = values.proposal === 'all' ? proposals : proposals.filter((proposal) => proposal.id === values.proposal);
          if (targeted.length === 0) throw commandRefusal(`No change ${values.proposal} is waiting; nothing was applied.`, '/memory review-files lists the changes.');
          const applied: MemoryProjectionProposal[] = [];
          const failed: string[] = [];
          for (const proposal of targeted) {
            try {
              if (proposal.kind === 'delete') {
                if (await spine.delete(proposal.id)) applied.push(proposal);
                else failed.push(`${proposal.id}: the record was already gone`);
                continue;
              }
              const desired = proposal.desired ?? {};
              const result = await spine.update(proposal.id, {
                ...(desired.scope !== undefined ? { scope: desired.scope } : {}),
                ...(desired.summary !== undefined ? { summary: desired.summary } : {}),
                ...(desired.detail !== undefined ? { detail: desired.detail } : {}),
                ...(desired.tags !== undefined ? { tags: [...desired.tags] } : {}),
                ...(desired.validFrom !== undefined ? { validFrom: desired.validFrom } : {}),
                ...(desired.validUntil !== undefined ? { validUntil: desired.validUntil } : {}),
              });
              if (result) applied.push(proposal);
              else failed.push(`${proposal.id}: the record was not found`);
            } catch (error) {
              failed.push(`${proposal.id}: ${summarizeError(error)}`);
            }
          }
          const lines = [`Applied ${applied.length} of ${targeted.length}.`, ...applied.map((proposal) => `  ${proposal.id}  ${proposal.kind === 'delete' ? 'deleted' : 'changed'}`), ...failed.map((line) => `  not applied: ${line}`)];
          if (failed.length > 0 && applied.length === 0) throw commandRefusal(lines.join('\n'));
          return lines.join('\n');
        },
      },
      {
        id: 'save', label: 'Save memory to a file', word: 'export',
        inputs: [FILE, SCOPE_FILTER, CLASS_FILTER],
        sentence: 'Memory records and their links ({scope}) will be written to {path}, which is replaced if it is there, until you change it.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'memory.records.export', fields: { scope: 'scope', cls: 'class' } }, example: { path: 'team-memory.json', scope: 'team' },
        async run(values, ctx) {
          const target = confinedPath(ctx, values.path!);
          const bundle = await spineOf(ctx).exportBundle({ ...(values.scope ? { scope: values.scope as MemoryScope } : {}), ...(values.class ? { cls: values.class as MemoryClass } : {}) });
          atomicWriteFileSync(target, JSON.stringify(bundle, null, 2) + '\n', { mkdirp: true });
          return `Saved ${bundle.recordCount} record${bundle.recordCount === 1 ? '' : 's'} and ${bundle.linkCount} link${bundle.linkCount === 1 ? '' : 's'} to ${target}.`;
        },
      },
      {
        id: 'inspect', label: 'Read a memory file before loading it', word: 'inspect', inputs: [FILE],
        sentence: 'Shows what the memory file {path} holds; nothing is loaded.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'The file is read on the terminal app\'s machine.' }, example: { path: 'team-memory.json' },
        async run(values, ctx) {
          const bundle = readBundle(confinedPath(ctx, values.path!));
          return [`Memory file ${values.path}`, `  applies to: ${bundle.scope}`, `  records: ${bundle.recordCount}`, `  links: ${bundle.linkCount}`, `  saved: ${new Date(bundle.exportedAt).toISOString()}`].join('\n');
        },
      },
      {
        id: 'load', label: 'Load memory from a file', word: 'import', inputs: [FILE],
        sentence: 'The records and links in {path} will be added to memory (a record already there is left as it is) until you change it.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'memory.records.import', fields: {} }, example: { path: 'team-memory.json' },
        async run(values, ctx) {
          const target = confinedPath(ctx, values.path!);
          const result = await spineOf(ctx).importBundle(readBundle(target));
          return `Loaded ${target}: ${result.importedRecords} record${result.importedRecords === 1 ? '' : 's'} added, ${result.skippedRecords} already there, ${result.importedLinks} link${result.importedLinks === 1 ? '' : 's'} added.`;
        },
      },
      {
        id: 'see-copies', label: 'See copies of memory', word: 'snapshots', inputs: [],
        sentence: 'Lists the copies of memory taken each day, before a migration and before a restore, newest first.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.snapshots.list', fields: {} }, example: {},
        async run(_values, ctx) {
          return formatMemorySnapshots(await spineOf(ctx).listSnapshots());
        },
      },
      {
        id: 'restore', label: 'Replace all memory with a copy', word: 'restore',
        inputs: [{ id: 'copy', label: 'Copy', help: 'The copies of memory, newest first', kind: 'choice', choices: { list: MEMORY_COPIES, allowOther: { reason: 'latest, or a date such as 2026-11-19' } }, required: true, typed: { position: 1 } }],
        sentence: 'Every memory record, link and waiting proposal will be replaced by those in {copy}, until you change it; the records you have now are copied first, so restoring that copy puts them back.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'restore',
        ownerOnly: { reason: 'it replaces every memory record', instead: 'Ask the owner to choose "Replace all memory with a copy" in /memory.' },
        operator: { method: 'memory.snapshots.restore', fields: { snapshot: 'copy' } }, example: { copy: 'latest' },
        async run(values, ctx) {
          return formatMemoryRestore(await spineOf(ctx).restoreSnapshot(values.copy!));
        },
      },
      {
        id: 'see-index', label: 'See the search index', word: 'index', inputs: [],
        sentence: 'Shows the semantic search index: whether it works, how many records it holds and how many wait to be embedded again.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.vector.stats', fields: {} }, example: {},
        async run(_values, ctx) {
          return formatVectorStats(localMemoryOf(ctx).vectorStats(), 'Search index');
        },
      },
      {
        id: 'rebuild-index', label: 'Rebuild the search index', word: 'rebuild-index', inputs: [],
        sentence: 'Every record is embedded again with the current provider, so semantic search covers all of memory; nothing is lost.', done: '',
        touches: 'this-machine', lasts: 'not-a-change', risk: 'none',
        operator: { method: 'memory.vector.rebuild', fields: {} }, example: {},
        async run(_values, ctx) {
          return formatVectorStats(localMemoryOf(ctx).rebuildVectors(), 'Search index rebuilt');
        },
      },
      {
        id: 'capture', label: 'Remember an incident or a setting\'s state', word: 'capture',
        inputs: [
          { id: 'what', label: 'What', help: 'What to remember', kind: 'choice', choices: [
            { value: 'incident', label: 'An incident report', help: 'The latest one, or one by id' },
            { value: 'policy', label: 'The last policy check', help: 'What the last policy preflight found' },
            { value: 'mcp', label: 'An MCP server\'s trust', help: 'Its trust level and held-back tools' },
            { value: 'plugin', label: 'A plugin\'s trust', help: 'Whether it is held back, and why' },
          ], required: true, typed: { position: 1 } },
          { id: 'which', label: 'Which', help: 'The incident id (or latest), the server or the plugin', kind: 'text', freeTextReason: 'its name or id', required: { default: '', defaultMeans: 'the latest incident' }, typed: { position: 2 } },
        ],
        sentence: '{what} {which} will be remembered as a record until you change it.',
        done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'forget',
        operator: { terminalOnly: 'It reads what the terminal app holds.' }, example: { what: 'incident', which: 'latest' },
        async run(values, ctx) {
          const spine = spineOf(ctx);
          const which = values.which ?? '';
          if (values.what === 'incident') {
            const registry = ctx.extensions.forensicsRegistry;
            if (!registry) throw commandRefusal('Incident reports are not available in this app.');
            const report = !which || which === 'latest' ? registry.latest() : registry.getById(which);
            if (!report) throw commandRefusal(`No incident report ${which || 'yet'}.`, '/health failure shows the latest.');
            const bundle = registry.buildBundle(report.id);
            if (!bundle) throw commandRefusal(`Incident ${report.id} could not be read.`);
            return `Remembered incident ${report.id} as ${(await spine.add(buildIncidentMemoryAddOptions(bundle))).id}.`;
          }
          if (values.what === 'policy') {
            const review = ctx.extensions.policyRuntimeState?.getSnapshot().lastPreflightReview;
            if (!review) throw commandRefusal('No policy check has run yet, so there is nothing to remember.');
            return `Remembered the last policy check as ${(await spine.add(buildPolicyPreflightMemoryAddOptions(review))).id}.`;
          }
          if (values.what === 'mcp') {
            const server = ctx.extensions.mcpRegistry.listServerSecurity().find((entry) => entry.name === which);
            if (!server) throw commandRefusal(`No MCP server is named ${which || '(none given)'}.`, '/mcp servers lists them.');
            return `Remembered MCP server ${server.name} as ${(await spine.add(buildMcpSecurityMemoryAddOptions(server))).id}.`;
          }
          const plugins = ctx.extensions.pluginManager;
          if (!plugins) throw commandRefusal('Plugins are not available in this app.');
          const plugin = plugins.list().find((entry) => entry.name === which);
          if (!plugin) throw commandRefusal(`No plugin is named ${which || '(none given)'}.`);
          return `Remembered plugin ${plugin.name} as ${(await spine.add(buildPluginSecurityMemoryAddOptions(plugin, plugins.getQuarantineRecord(plugin.name)?.reason))).id}.`;
        },
      },
      {
        id: 'open-screen', label: 'Open the memory screen', word: 'open', inputs: [],
        sentence: 'Opens the full-screen view of memory records.', done: '',
        touches: 'reads', lasts: 'not-a-change', risk: 'none',
        operator: { terminalOnly: 'It is a terminal screen.' }, example: {},
        async run(_values, ctx) {
          policy.open(ctx);
        },
      },
    ],
  };
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

/** `/memory` for one app: the one description, with the app's screen and turn records. */
export function createMemoryCommand<Ctx extends MemoryCommandContext>(policy: MemoryCommandPolicy<Ctx>): DescribedCommand<Ctx> {
  return defineCommand(describeMemory<Ctx>(policy));
}

