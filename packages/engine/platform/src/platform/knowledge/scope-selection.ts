import { isGeneratedProjectionViewEdge } from './store-generated-projection-selector.js';
import { captureJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { mapLimit, toJson } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { knowledgeScopeSelection } from './batteries/scope-selection.js';
import { knowledgeSourceJudgmentUris } from './source-structural-references.js';
import { DEFAULT_KNOWLEDGE_SPACE_ID, getKnowledgeSpaceId, getExplicitKnowledgeSpaceId, resolveKnowledgeSpaceScope, type KnowledgeSpaceScopeInput } from './spaces.js';
import { knowledgeIssueMatchesScope, knowledgeNodeMatchesScope, knowledgeSourceMatchesScope } from './scope-records.js';
import { knowledgeRecordVersion } from './store-record-representation.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeScopeVerdict } from './store-scope-verdicts.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { prepareRepairJudgmentResult } from './semantic/web-gap-repair/admission.js';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

export class KnowledgeScopeSelectionHeldError extends Error {
  override readonly name = 'KnowledgeScopeSelectionHeldError';
  constructor(readonly reason: 'unavailable' | 'uncertain' | 'malformed' | 'stale' | 'aborted' | 'budget') {
    super(`Knowledge scope selection held: ${reason}.`);
  }
}

/** Readings one background pass takes before it stores them and yields. */
const SCOPE_READINGS_PER_PASS = 64;
/** Wait before a record whose reading failed is read again: doubles per failure, up to the cap. */
const FAILED_READING_RETRY_MS = 60_000;
const FAILED_READING_RETRY_CAP_MS = 60 * 60_000;

export interface KnowledgeScopeSelectionOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly assertPreparedInputCurrent?: (() => void) | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
  readonly kinds?: readonly ('source' | 'node' | 'issue')[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly nodeIds?: readonly string[] | undefined;
  readonly issueIds?: readonly string[] | undefined;
}

/**
 * The records a knowledge view shows. Built in one pass over the stored rows:
 * namespace membership comes from the records themselves, and whether a
 * default-space record belongs in the ordinary view is the reading stored with
 * it. A record with no settled reading is shown and counted in `unsettled`.
 * Building a selection never asks a model and never waits on one.
 */
export interface KnowledgeScopeSelection {
  /** Present when some shown record has no settled ordinary-view reading, or decision models are off. */
  readonly provenance?: 'classic';
  /** Shown default-space records whose ordinary-view reading has not settled (not read yet, failed, or read as uncertain). */
  readonly unsettled?: number;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly source: (record: KnowledgeSourceRecord) => boolean;
  readonly node: (record: KnowledgeNodeRecord) => boolean;
  readonly issue: (record: KnowledgeIssueRecord) => boolean;
  /** A listing tolerates a concurrent write, so this only follows the caller's signal and guard. */
  readonly retainEdges: (records: readonly KnowledgeEdgeRecord[], window?: KnowledgeScopeEdgeWindow) => () => void;
  readonly assertCurrent: () => void;
}

export interface KnowledgeScopeEdgeWindow {
  readonly sourceIds?: readonly string[];
  readonly nodeIds?: readonly string[];
  readonly incidentTo?: readonly { readonly kind: 'source' | 'node'; readonly id: string }[];
  readonly includeUnselectedEndpoints?: boolean;
}

type ScopeRecord =
  | { readonly kind: 'source'; readonly record: KnowledgeSourceRecord }
  | { readonly kind: 'node'; readonly record: KnowledgeNodeRecord }
  | { readonly kind: 'issue'; readonly record: KnowledgeIssueRecord };

// These are consumed content, not record IDs, clocks, confidence or authority receipts.
const CONTENT_FIELDS = ['semanticKind', 'factKind', 'entityKind', 'value', 'evidence', 'labels', 'subject',
  'markdown', 'text', 'searchText', 'content', 'description', 'tags', 'tag', 'scope', 'cls',
  'manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'batteryPowered', 'batteryType',
  'manualRequired', 'documentation', 'documentationUrl', 'documentation_url', 'sourceUrl', 'source_url',
  'deviceClass', 'device_class', 'entryType', 'entry_type', 'attributes', 'homeAssistant',
  'gapKind', 'query', 'reason', 'resolution', 'path', 'filePath', 'folderPath', 'url',
  'project', 'projects', 'capability', 'capabilities', 'feature', 'features', 'repo', 'repository', 'repositories',
  'provider', 'providers', 'service', 'services', 'env', 'environment', 'environments', 'owner', 'owners'];

function content(value: ScopeRecord) {
  const record = value.record;
  const meaning = Object.fromEntries(CONTENT_FIELDS.filter(key => record.metadata[key] !== undefined)
    .map(key => [key, record.metadata[key]]));
  switch (value.kind) {
    case 'source': return { kind: value.kind, content: { title: value.record.title, summary: value.record.summary,
      description: value.record.description, sourceType: value.record.sourceType, tags: value.record.tags,
      folderPath: value.record.folderPath, ...knowledgeSourceJudgmentUris(value.record), meaning } };
    case 'node': return { kind: value.kind, content: { title: value.record.title, summary: value.record.summary,
      kind: value.record.kind, aliases: value.record.aliases, meaning } };
    case 'issue': return { kind: value.kind, content: { code: value.record.code, message: value.record.message, meaning } };
  }
}

/** What the reading sees of a record: its content, and for a source its extraction. */
function project(store: KnowledgeStore, value: ScopeRecord) {
  const projected = content(value);
  if (value.kind !== 'source') return projected;
  const extraction = store.getExtractionBySourceId(value.record.id);
  if (!extraction) return projected;
  const fields = [...CONTENT_FIELDS, 'sections', 'summary', 'title', 'excerpt'];
  const structure = Object.fromEntries(fields.filter(key => extraction.structure[key] !== undefined).map(key => [key, extraction.structure[key]]));
  return { kind: projected.kind, content: { ...projected.content, extraction: { format: extraction.format, title: extraction.title,
    summary: extraction.summary, excerpt: extraction.excerpt, sections: extraction.sections, structure } } };
}

/**
 * The content version a stored reading is keyed to. Records and extractions are
 * replaced, never mutated, on write, so the version is computed once per record
 * object and a changed record (or a source's new extraction) gets a new one.
 */
const contentVersions = new WeakMap<object, { readonly extraction: KnowledgeExtractionRecord | null; readonly version: string }>();
function contentVersion(store: KnowledgeStore, value: ScopeRecord): string {
  const extraction = value.kind === 'source' ? store.getExtractionBySourceId(value.record.id) : null;
  const cached = contentVersions.get(value.record);
  if (cached && cached.extraction === extraction) return cached.version;
  const version = knowledgeRecordVersion(project(store, value));
  contentVersions.set(value.record, { extraction, version });
  return version;
}

function references(record: ScopeRecord): readonly { readonly kind: 'source' | 'node'; readonly id: string }[] {
  const metadata = record.record.metadata;
  const strings = (value: unknown): string[] => typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.flatMap(strings) : [];
  const sources = [...strings(record.kind === 'source' ? undefined : record.record.sourceId),
    ...strings(metadata.sourceId), ...strings(metadata.sourceIds)];
  const nodes = [...strings(record.kind === 'issue' ? record.record.nodeId : undefined),
    ...strings(metadata.nodeId), ...strings(metadata.subjectId), ...strings(metadata.subjectIds), ...strings(metadata.linkedObjectIds),
    ...(metadata.sourceDiscovery && typeof metadata.sourceDiscovery === 'object' && 'linkedObjectIds' in metadata.sourceDiscovery
      ? strings(metadata.sourceDiscovery.linkedObjectIds) : []),
    ...(Array.isArray(metadata.targetHints) ? metadata.targetHints.flatMap(hint => hint && typeof hint === 'object' && 'id' in hint ? strings(hint.id) : []) : [])];
  return [...[...new Set(sources)].map(id => ({ kind: 'source' as const, id })),
    ...[...new Set(nodes)].map(id => ({ kind: 'node' as const, id }))];
}

const keyFor = (value: ScopeRecord): string => `${value.kind}:${value.record.id}`;

function indexEdges(edges: readonly KnowledgeEdgeRecord[]): Map<string, KnowledgeEdgeRecord[]> {
  const index = new Map<string, KnowledgeEdgeRecord[]>();
  for (const edge of edges) for (const key of new Set([`${edge.fromKind}:${edge.fromId}`, `${edge.toKind}:${edge.toId}`])) {
    const related = index.get(key) ?? []; related.push(edge); index.set(key, related);
  }
  return index;
}

/** Structural membership: the record's own space and the spaces of what it is attached to. */
function membership(store: KnowledgeStore, edgeIndex: ReadonlyMap<string, readonly KnowledgeEdgeRecord[]>,
  value: ScopeRecord, scope: KnowledgeSpaceScopeInput): boolean {
  const relevant = [keyFor(value), ...(value.kind === 'issue' ? references(value).filter(ref => ref.kind === 'node').map(ref => `${ref.kind}:${ref.id}`) : [])];
  const edges = [...new Map(relevant.flatMap(key => edgeIndex.get(key) ?? []).map(edge => [edge.id, edge])).values()];
  const lookup = { getSource: (id: string) => store.getSource(id), getNode: (id: string) => store.getNode(id), edges };
  switch (value.kind) {
    case 'source': return knowledgeSourceMatchesScope(value.record, scope);
    case 'node': return knowledgeNodeMatchesScope(value.record, scope, lookup);
    case 'issue': return knowledgeIssueMatchesScope(value.record, scope, lookup);
  }
}

/** Only default-space records are read for the ordinary view; an explicit space is the owner's own boundary. */
function needsReading(store: KnowledgeStore, edgeIndex: ReadonlyMap<string, readonly KnowledgeEdgeRecord[]>, value: ScopeRecord): boolean {
  return getKnowledgeSpaceId(value.record) === DEFAULT_KNOWLEDGE_SPACE_ID
    && (value.kind !== 'node' || getExplicitKnowledgeSpaceId(value.record) !== null || membership(store, edgeIndex, value, {}));
}

/**
 * Reads the stored readings and the sources' extractions in a few statements,
 * not one per record; the per-record reads below then use them. Without
 * `records` every stored one is read (nothing while that read is current).
 */
function readAhead(store: KnowledgeStore, records?: readonly ScopeRecord[]): void {
  store.readAheadScopeVerdicts(records?.map(keyFor));
  store.readAheadExtractions(records?.flatMap((value) => value.kind === 'source' ? [value.record.id] : []));
}

/** A stored reading that still matches the record's content, or undefined. */
function currentVerdict(store: KnowledgeStore, value: ScopeRecord): KnowledgeScopeVerdict | undefined {
  const stored = store.getScopeVerdict(keyFor(value));
  return stored && stored.version === contentVersion(store, value) ? stored : undefined;
}

/**
 * Readings that threw (a provider timeout, a 5xx, a malformed reply), per store
 * and record, for the content version they were tried on. Nothing is stored for
 * them, so the record stays unread; it is tried again once its wait is over.
 */
interface FailedReading { readonly version: string; readonly failures: number; readonly retryAt: number }
const failedReadings = new WeakMap<KnowledgeStore, Map<string, FailedReading>>();
function failedFor(store: KnowledgeStore): Map<string, FailedReading> {
  let map = failedReadings.get(store);
  if (!map) failedReadings.set(store, map = new Map());
  return map;
}
/** Whether a record without a current reading may be read now (not waiting after a failed reading of this content). */
function readableNow(store: KnowledgeStore, value: ScopeRecord, now: number): boolean {
  const failed = failedReadings.get(store)?.get(keyFor(value));
  return !failed || failed.version !== contentVersion(store, value) || failed.retryAt <= now;
}

export async function prepareKnowledgeScopeSelection(
  store: KnowledgeStore,
  scope: KnowledgeSpaceScopeInput = {},
  options: KnowledgeScopeSelectionOptions = {},
): Promise<KnowledgeScopeSelection> {
  const assertCurrent = (): void => {
    if (options.signal?.aborted || options.shouldStop?.()) throw new KnowledgeScopeSelectionHeldError('aborted');
    options.assertCurrent?.();
  };
  assertCurrent();
  await store.init();
  assertCurrent();
  options.assertPreparedInputCurrent?.();
  const sources = store.listSources(Number.MAX_SAFE_INTEGER);
  const nodes = store.listNodes(Number.MAX_SAFE_INTEGER);
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER);
  const edges = store.listEdges();
  const edgeIndex = indexEdges(edges);
  const inBounds = (value: ScopeRecord): boolean => {
    if (options.kinds && !options.kinds.includes(value.kind)) return false;
    const ids = value.kind === 'source' ? options.sourceIds : value.kind === 'node' ? options.nodeIds : options.issueIds;
    return !ids || ids.includes(value.record.id);
  };
  const records: ScopeRecord[] = [...sources.map(record => ({ kind: 'source' as const, record })),
    ...nodes.map(record => ({ kind: 'node' as const, record })), ...issues.map(record => ({ kind: 'issue' as const, record }))];
  // A view of named records reads only theirs; any other view lists every record anyway.
  readAhead(store, options.sourceIds || options.nodeIds || options.issueIds ? records.filter(inBounds) : undefined);
  const view = resolveKnowledgeSpaceScope(scope);
  const accepted = new Set<string>();
  let unsettled = 0, readable = false;
  const now = Date.now();
  for (const value of records) {
    if (!inBounds(value) || !membership(store, edgeIndex, value, scope)) continue;
    if (needsReading(store, edgeIndex, value)) {
      const verdict = currentVerdict(store, value);
      // Explicit all-space browsing shows every record; other views leave out what was read as not belonging.
      if (view !== null && verdict?.included === false) continue;
      if (!verdict || verdict.included === null) unsettled += 1;
      if (!verdict && !readable) readable = readableNow(store, value, now);
    }
    accepted.add(keyFor(value));
  }
  if (readable) queueScopeReadings(store);
  const selectedEdges = edges.filter(edge => accepted.has(`${edge.fromKind}:${edge.fromId}`) && accepted.has(`${edge.toKind}:${edge.toId}`));
  return Object.freeze({
    ...(unsettled > 0 || isClassicOperation() ? { provenance: 'classic' as const } : {}),
    ...(unsettled > 0 ? { unsettled } : {}),
    sources: Object.freeze(sources.filter(record => accepted.has(`source:${record.id}`))),
    nodes: Object.freeze(nodes.filter(record => accepted.has(`node:${record.id}`))),
    issues: Object.freeze(issues.filter(record => accepted.has(`issue:${record.id}`))),
    edges: Object.freeze(selectedEdges),
    source: (record: KnowledgeSourceRecord) => accepted.has(`source:${record.id}`),
    node: (record: KnowledgeNodeRecord) => accepted.has(`node:${record.id}`),
    issue: (record: KnowledgeIssueRecord) => accepted.has(`issue:${record.id}`),
    retainEdges: () => { assertCurrent(); return assertCurrent; },
    assertCurrent,
  });
}

/** One background reading pass per store at a time; a request while one runs asks for one more pass. */
const scopeReadingPasses = new WeakMap<KnowledgeStore, { again: boolean }>();

/**
 * Reads the ordinary-view eligibility of default-space records that have no
 * current reading, a bounded batch per pass, and stores each verdict with the
 * content version it was read from. Runs after the view was answered; nothing
 * waits on it. With no decision model (or Classic - Off) nothing is read and the
 * records stay shown.
 */
function queueScopeReadings(store: KnowledgeStore): void {
  if (isClassicOperation()) return;
  const running = scopeReadingPasses.get(store);
  if (running) { running.again = true; return; }
  const pass = { again: false };
  scopeReadingPasses.set(store, pass);
  const timer = setTimeout(() => {
    void withConfiguredDecisionModelPolicy(() => runScopeReadingPass(store))
      .catch((error: unknown) => {
        logger.debug('Knowledge scope readings stopped; records stay shown until read', { error: summarizeError(error) });
        return false;
      })
      .then((more) => {
        scopeReadingPasses.delete(store);
        if ((more || pass.again) && store.isReady) queueScopeReadings(store);
      });
  }, 0);
  timer.unref?.();
}

/** Returns true when records are still waiting for a reading after this pass. */
async function runScopeReadingPass(store: KnowledgeStore): Promise<boolean> {
  if (!store.isReady || isClassicOperation()) return false;
  const edgeIndex = indexEdges(store.listEdges());
  const waiting: ScopeRecord[] = [];
  const all: ScopeRecord[] = [
    ...store.listSources(Number.MAX_SAFE_INTEGER).map(record => ({ kind: 'source' as const, record })),
    ...store.listNodes(Number.MAX_SAFE_INTEGER).map(record => ({ kind: 'node' as const, record })),
    ...store.listIssues(Number.MAX_SAFE_INTEGER).map(record => ({ kind: 'issue' as const, record })),
  ];
  readAhead(store);
  const now = Date.now();
  for (const value of all) {
    if (needsReading(store, edgeIndex, value) && !currentVerdict(store, value) && readableNow(store, value, now)) waiting.push(value);
  }
  if (waiting.length === 0) return false;
  const batch = waiting.slice(0, SCOPE_READINGS_PER_PASS);
  const verdicts: KnowledgeScopeVerdict[] = [];
  const failed = failedFor(store);
  let unavailable = false, failure = false;
  await mapLimit(batch, 4, async (value) => {
    // A failed reading stops the pass: the provider is likely to fail the rest too.
    if (unavailable || failure) return;
    const version = contentVersion(store, value);
    let included: boolean | null;
    try {
      const state = scopeReadingState(store, edgeIndex, value);
      const captured = captureJudgmentPort(knowledgeScopeSelection.name, { prepareResultCapture: prepareRepairJudgmentResult });
      const run = await knowledgeScopeSelection.run(captured.port, state, { signal: captured.signal, site: knowledgeScopeSelection.name });
      const reading = run.readings.included;
      // A reading that returned but did not settle is stored as unsettled (null) and counted as such in every view.
      included = reading.outcome === 'act' && reading.verdict !== 'uncertain' ? reading.verdict === 'yes' : null;
      run.recordAction(`ordinary-view reading ${reading.verdict}; stored with the record's content version`);
    } catch (error) {
      if (error instanceof JudgmentPortMissingError) { unavailable = true; return; }
      // Nothing is stored for a reading that threw: the record stays unread and is read again after a wait.
      failure = true;
      const previous = failed.get(keyFor(value));
      const failures = previous?.version === version ? previous.failures + 1 : 1;
      failed.set(keyFor(value), { version, failures,
        retryAt: Date.now() + Math.min(FAILED_READING_RETRY_CAP_MS, FAILED_READING_RETRY_MS * 2 ** (failures - 1)) });
      logger.debug('Knowledge scope reading failed; the record stays unread and is read again later', { record: keyFor(value), failures, error: summarizeError(error) });
      return;
    }
    failed.delete(keyFor(value));
    verdicts.push({ key: keyFor(value), version, included, decidedAt: Date.now() });
  });
  if (verdicts.length > 0 && store.isReady) await store.recordScopeVerdicts(verdicts);
  return !unavailable && !failure && waiting.length > batch.length;
}

/** The reading's input: the record, the records it is attached to in its space, and whether it reaches outside. */
function scopeReadingState(store: KnowledgeStore, edgeIndex: ReadonlyMap<string, readonly KnowledgeEdgeRecord[]>, value: ScopeRecord) {
  const related = new Map<string, ScopeRecord>();
  let outsideRequestedScope = false;
  const ordinary: KnowledgeSpaceScopeInput = {};
  const refs = [...references(value), ...(value.kind === 'source' ? [] : (edgeIndex.get(keyFor(value)) ?? []).filter(edge => !isGeneratedProjectionViewEdge(
    edge.fromKind === 'source' ? store.getSource(edge.fromId) : undefined, edge))).flatMap(edge => [
    ...(edge.fromKind === 'source' || edge.fromKind === 'node' ? [{ kind: edge.fromKind, id: edge.fromId }] : []),
    ...(edge.toKind === 'source' || edge.toKind === 'node' ? [{ kind: edge.toKind, id: edge.toId }] : []),
  ])];
  for (const ref of refs) {
    const key = `${ref.kind}:${ref.id}`;
    const source = ref.kind === 'source' ? store.getSource(ref.id) : null;
    const node = ref.kind === 'node' ? store.getNode(ref.id) : null;
    const other: ScopeRecord | undefined = source ? { kind: 'source', record: source } : node ? { kind: 'node', record: node } : undefined;
    if (!other || key === keyFor(value)) continue;
    // A new descendant claim is an output, rather than a subject's context.
    if (value.kind === 'node' && value.record.kind !== 'fact' && other.kind === 'node' && other.record.kind === 'fact'
      && !references(value).some(entry => entry.kind === other.kind && entry.id === other.record.id)) continue;
    if (membership(store, edgeIndex, other, ordinary)) related.set(key, other);
    else outsideRequestedScope = true;
  }
  const candidate = project(store, value);
  const relatedContent = [...related.values()].map(other => project(store, other));
  const state = { view: 'ordinary', candidate: toJson(candidate), related: relatedContent.map(other => toJson(other)),
    associations: { outsideRequestedScope } };
  assertJudgmentInput(state);
  return state;
}
