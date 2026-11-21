import { isClassicOperation } from '../../runtime/decision-policy.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { guardKnowledgeEdgeInput } from '../store-edge-writes.js';
import { knowledgeTerms, selectKnowledgePassages, splitKnowledgePassages } from '../passages.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { buildHomeGraphMetadata, edgeIsActive, isGeneratedPageSource } from './helpers.js';
import type { HomeGraphState } from './state.js';
import { projectHomeGraphQualityInput } from './quality/projection.js';
import { captureHomeGraphRows } from './rows-current.js';
import { knowledgeRecordVersion } from '../store-record-representation.js';
import { createHomeGraphAutoLinkReader, HomeGraphAutoLinkHeldError as Held, MAX_AUTO_LINK_CANDIDATES,
  type AutoLinkReading, type AutoLinkReadingInput } from './auto-link/reader.js';

export interface HomeGraphAutoLinkResult {
  readonly edge: KnowledgeEdgeRecord;
  readonly node: KnowledgeNodeRecord;
  readonly relation: string;
  /** Compatibility field: no legacy point score or confidence is manufactured. */
  readonly score: number;
  readonly reasons: readonly string[];
}
/** What linking established for one document; returned to the caller, and remembered so an unchanged document is not read again. */
export type HomeGraphAutoLinkStatus = 'linked' | 'none' | 'ambiguous' | 'unread';
export interface HomeGraphAutoLinkOutcome {
  readonly sourceId: string;
  readonly status: HomeGraphAutoLinkStatus;
  readonly reason?: string | undefined;
  /** Candidates code shortlisted from the home (0 means nothing in the home matched the document). */
  readonly shortlisted: number;
}
export interface HomeGraphAutoLinkReport {
  readonly linked: readonly HomeGraphAutoLinkResult[];
  readonly outcomes: readonly HomeGraphAutoLinkOutcome[];
  /** Counts by status, for sync and ingest results. */
  readonly counts: Readonly<Record<HomeGraphAutoLinkStatus, number>>;
}
interface AutoLinkContext {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly installationId: string;
  readonly state: HomeGraphState;
  readonly signal?: AbortSignal | undefined;
  readonly shouldStop?: (() => boolean) | undefined;
}
interface AutoLinkSourceInput extends AutoLinkContext {
  readonly source: KnowledgeSourceRecord;
  readonly extraction?: KnowledgeExtractionRecord | undefined;
}
interface AutoLinkSourcesInput extends AutoLinkContext {
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
}

/** Document text sent with the one reading: the passages that mention the shortlisted candidates. */
const SOURCE_EVIDENCE_BYTES = 16 * 1024;
const PASSAGE_CHARS = 800;

function skipped(source: KnowledgeSourceRecord): boolean {
  return isGeneratedPageSource(source) || source.metadata.homeGraphSourceKind === 'snapshot'
    || source.metadata.homeGraphSourceKind === 'generated-page';
}
function hasActiveSourceLink(sourceId: string, edges: readonly KnowledgeEdgeRecord[]): boolean {
  return edges.some((edge) => edgeIsActive(edge) && (
    (edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    || (edge.fromKind === 'node' && edge.toKind === 'source' && edge.toId === sourceId)));
}
/**
 * What a document can be about: a device, an integration, a room or area, or an
 * entity that belongs to no device (a helper, a template sensor). An entity of
 * a device rides with that device instead.
 */
function candidate(node: KnowledgeNodeRecord, deviceEntities: ReadonlySet<string>): boolean {
  return node.kind === 'ha_device' || node.kind === 'ha_integration' || node.kind === 'ha_area' || node.kind === 'ha_room'
    || (node.kind === 'ha_entity' && !deviceEntities.has(node.id));
}
/**
 * Outcomes other than `linked`, per store and source, with what they were read
 * from. Held in memory, not written to the source row: rewriting the source
 * would change its generation and retire every reference minted for it. A
 * daemon restart reads each unlinked document once more.
 */
interface RecordedOutcome {
  readonly status: Exclude<HomeGraphAutoLinkStatus, 'linked'>;
  /** Version of the candidate pool it was read against: each candidate's id and updatedAt, and the device memberships of entities. */
  readonly poolVersion: string;
  readonly sourceUpdatedAt: number;
  readonly extractionId: string | null;
  readonly extractionUpdatedAt: number | null;
}
const recordedOutcomes = new WeakMap<KnowledgeStore, Map<string, RecordedOutcome>>();
function outcomesFor(store: KnowledgeStore): Map<string, RecordedOutcome> {
  let map = recordedOutcomes.get(store);
  if (!map) recordedOutcomes.set(store, map = new Map());
  return map;
}
function sourceText(source: KnowledgeSourceRecord, extraction: KnowledgeExtractionRecord | undefined): unknown[] {
  return [source.title, source.summary, source.description, ...source.tags, extraction?.title, extraction?.summary, extraction?.excerpt,
    ...(extraction?.sections ?? []), extraction?.structure.searchText];
}

interface Candidate { readonly node: KnowledgeNodeRecord; readonly entities: readonly KnowledgeNodeRecord[]; readonly terms: readonly string[] }

/** Identity words of a candidate and its entities: names, model, manufacturer, ids. */
function candidateTerms(node: KnowledgeNodeRecord, entities: readonly KnowledgeNodeRecord[]): string[] {
  const identity = (record: KnowledgeNodeRecord) => [record.title, ...record.aliases, record.metadata.model, record.metadata.modelId,
    record.metadata.model_id, record.metadata.manufacturer, record.metadata.vendor, record.metadata.brand];
  return knowledgeTerms([...identity(node), ...entities.flatMap((entity) => [entity.title, ...entity.aliases])]);
}

/**
 * The shortlist: candidates ranked by how many of their identity words the
 * document contains, model and long words counting double. A candidate whose
 * words appear nowhere in the document is not a candidate.
 */
function shortlist(candidates: readonly Candidate[], text: string): Candidate[] {
  const lower = text.toLowerCase();
  return candidates.map((entry, index) => ({ entry, index, score: entry.terms.reduce((sum, term) => sum
    + (lower.includes(term) ? (term.length >= 5 || /\d/.test(term) ? 2 : 1) : 0), 0) }))
    .filter((ranked) => ranked.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_AUTO_LINK_CANDIDATES).map((ranked) => ranked.entry);
}

function counts(outcomes: readonly HomeGraphAutoLinkOutcome[]): Record<HomeGraphAutoLinkStatus, number> {
  const result: Record<HomeGraphAutoLinkStatus, number> = { linked: 0, none: 0, ambiguous: 0, unread: 0 };
  for (const outcome of outcomes) result[outcome.status] += 1;
  return result;
}

/**
 * Links each unlinked document to the device, integration, room or entity it is about. Code
 * shortlists candidates from the home; one request per document reads the
 * document kind and the shortlist together. A document with no shortlist makes
 * no request. Anything but a single settled subject (`none`, `ambiguous`, or
 * `unread` with the reason) is returned, never thrown, and is not read again
 * until the document or the set of devices changes (`unread` is retried). The
 * edge write compares the generations of the rows that reading used.
 */
async function linkSources(input: AutoLinkSourcesInput): Promise<HomeGraphAutoLinkReport> {
  const stopped = () => input.signal?.aborted || input.shouldStop?.();
  if (stopped()) throw new Held('aborted');
  const nodeById = new Map(input.state.nodes.map((node) => [node.id, node]));
  const belongsTo = new Map<string, KnowledgeNodeRecord[]>();
  const deviceEntities = new Set<string>();
  const memberships: string[] = [];
  for (const edge of input.state.edges) {
    if (!edgeIsActive(edge) || edge.relation !== 'belongs_to_device' || edge.fromKind !== 'node' || edge.toKind !== 'node') continue;
    const entity = nodeById.get(edge.fromId);
    if (entity?.kind !== 'ha_entity') continue;
    deviceEntities.add(entity.id);
    belongsTo.set(edge.toId, [...(belongsTo.get(edge.toId) ?? []), entity]);
    memberships.push(`${entity.id}\u0000${edge.toId}`);
  }
  const pool = input.state.nodes.filter((node) => candidate(node, deviceEntities));
  // A rename, a one-for-one swap or an entity moved between devices changes
  // this even when the number of candidates stays the same.
  const poolVersion = knowledgeRecordVersion({
    candidates: pool.map((node) => `${node.id}\u0000${node.updatedAt}`).sort(),
    memberships: memberships.sort(),
  });
  const outcomes = outcomesFor(input.store);
  const plans = input.sources.filter((source) => !skipped(source) && source.status !== 'stale'
    && getKnowledgeSpaceId(source) === input.spaceId && !hasActiveSourceLink(source.id, input.state.edges))
    .map((source) => ({ source, extraction: input.extractionBySourceId.get(source.id) }))
    .filter(({ source, extraction }) => {
      const recorded = outcomes.get(source.id);
      return !recorded || recorded.status === 'unread' || recorded.poolVersion !== poolVersion || recorded.sourceUpdatedAt !== source.updatedAt
        || recorded.extractionId !== (extraction?.id ?? null) || recorded.extractionUpdatedAt !== (extraction?.updatedAt ?? null);
    });
  if (plans.length === 0) return { linked: [], outcomes: [], counts: counts([]) };
  const candidates: Candidate[] = pool.map((node) => {
    const entities = belongsTo.get(node.id) ?? [];
    return { node, entities, terms: candidateTerms(node, entities) };
  });
  const reader = isClassicOperation() ? undefined : createHomeGraphAutoLinkReader();
  const linked: HomeGraphAutoLinkResult[] = [];
  const reported: HomeGraphAutoLinkOutcome[] = [];
  for (const { source, extraction } of plans) {
    if (stopped()) throw new Held('aborted');
    const passages = splitKnowledgePassages([sourceText(source, extraction)], PASSAGE_CHARS);
    const listed = shortlist(candidates, passages.map((passage) => passage.text).join('\n'));
    let reading: AutoLinkReading;
    let rowsCurrent: (() => void) | undefined;
    if (!listed.length) reading = { status: 'none' };
    else if (!reader) reading = { status: 'unread', reason: 'off' };
    else {
      const evidence = selectKnowledgePassages(passages, knowledgeTerms(listed.flatMap((entry) => entry.terms)), SOURCE_EVIDENCE_BYTES);
      const projectedSource = { title: source.title, summary: source.summary, description: source.description, sourceType: source.sourceType,
        tags: source.tags, ...knowledgeSourceJudgmentUris(source),
        ...(extraction ? { extraction: { title: extraction.title, summary: extraction.summary } } : {}),
        passages: evidence.passages.map((passage) => passage.text),
        ...(evidence.omitted.passages ? { omitted: { passages: evidence.omitted.passages, characters: evidence.omitted.characters } } : {}) };
      const projected: AutoLinkReadingInput = { source: projectedSource, candidates: listed.map((entry, index) => {
        const quality = projectHomeGraphQualityInput(`candidate-${index + 1}`, entry.node, entry.entities, [], []);
        return { reference: `candidate-${index + 1}`, subject: { ...quality.subject, modelId: entry.node.metadata.modelId ?? null,
          vendor: entry.node.metadata.vendor ?? null }, entities: quality.entities };
      }) };
      assertJudgmentInput(projected);
      rowsCurrent = captureHomeGraphRows(input.store, { sources: [source.id], extractions: extraction ? [extraction.id] : [],
        nodes: listed.flatMap((entry) => [entry.node.id, ...entry.entities.map((entity) => entity.id)]) }, () => new Held('stale'));
      reading = await reader.read(projected, { signal: input.signal, assertCurrent: () => { if (stopped()) throw new Held('aborted'); } });
    }
    if (reading.status === 'linked') {
      const node = listed[Number(reading.reference.slice('candidate-'.length)) - 1]?.node;
      if (!node) throw new Held('malformed');
      const commit = rowsCurrent!;
      let edge: KnowledgeEdgeRecord;
      try {
        edge = await input.store.upsertEdge(guardKnowledgeEdgeInput({
          fromKind: 'source', fromId: source.id, toKind: 'node', toId: node.id,
          relation: reading.relation, weight: 1,
          metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, { linkStatus: 'active',
            linkMethod: 'homegraph-auto-link', ...reading.provenance, autoLinkedAt: Date.now(), autoLinkReasons: ['settled-document-subject'] }),
        }, commit));
      } catch (error) {
        if (!(error instanceof Held) || error.reason !== 'stale') throw error;
        // The home changed while the document was read: nothing is written and
        // no outcome is recorded, so the next pass reads it again.
        reported.push({ sourceId: source.id, status: 'unread', reason: 'stale', shortlisted: listed.length });
        continue;
      }
      linked.push({ edge, node, relation: reading.relation, score: 0, reasons: ['settled-document-subject'] });
      reported.push({ sourceId: source.id, status: 'linked', shortlisted: listed.length });
      outcomes.delete(source.id);
      continue;
    }
    const reason = reading.status === 'unread' ? reading.reason : undefined;
    reported.push({ sourceId: source.id, status: reading.status, ...(reason ? { reason } : {}), shortlisted: listed.length });
    // Not read again until the document, its extraction or the home's device list changes.
    outcomes.set(source.id, { status: reading.status, poolVersion, sourceUpdatedAt: source.updatedAt,
      extractionId: extraction?.id ?? null, extractionUpdatedAt: extraction?.updatedAt ?? null });
  }
  return { linked, outcomes: reported, counts: counts(reported) };
}

export async function autoLinkHomeGraphSourceWithOutcome(input: AutoLinkSourceInput): Promise<HomeGraphAutoLinkReport> {
  return linkSources({ ...input, sources: [input.source],
    extractionBySourceId: new Map(input.extraction ? [[input.source.id, input.extraction]] : []) });
}
export async function autoLinkHomeGraphSource(input: AutoLinkSourceInput): Promise<HomeGraphAutoLinkResult | undefined> {
  return (await autoLinkHomeGraphSourceWithOutcome(input)).linked[0];
}
export function autoLinkHomeGraphSourcesWithOutcomes(input: AutoLinkSourcesInput): Promise<HomeGraphAutoLinkReport> {
  return linkSources(input);
}
export async function autoLinkHomeGraphSources(input: AutoLinkSourcesInput): Promise<readonly HomeGraphAutoLinkResult[]> {
  return (await linkSources(input)).linked;
}
