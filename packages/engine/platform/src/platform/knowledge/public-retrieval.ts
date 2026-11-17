import { createHash } from 'node:crypto';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { rankClassicCatalog } from '../runtime/classic-catalog.js';
import { assertJudgmentInput, JudgmentInputError } from '../gate/judgment-input.js';
import { knowledgeTerms, selectKnowledgePassages, splitKnowledgePassages } from './passages.js';
import { prepareKnowledgeScopeSelection, KnowledgeScopeSelectionHeldError, type KnowledgeScopeSelectionOptions } from './scope-selection.js';
import { isActiveKnowledgeEdge } from './projection-utils.js';
import { getKnowledgeSpaceId, type KnowledgeSpaceScopeInput } from './spaces.js';
import { knowledgeSourceJudgmentUris } from './source-structural-references.js';
import { KnowledgeSourceQualityHeldError } from './source-quality.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from './types.js';
import { projectAnswerFactClaim } from './semantic/answer-claim-projection.js';
import { shortlistAnswerEntries } from './semantic/answer-evidence.js';
import { localKnowledgeSourceSpans, readAnswerSourceExcerpts, type LocalAnswerExcerptSpan } from './semantic/answer-excerpts/prepare.js';
import { KnowledgeAnswerExcerptHeldError } from './semantic/answer-excerpts/types.js';
import { withAnswerVerificationBudget } from './semantic/answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError } from './semantic/answer-verification/types.js';
import { prepareAnswerEvidenceRelevanceBatches } from './semantic/evidence-ranking/batch.js';
import { KnowledgeEvidenceRelevanceHeldError as Held, type AnswerEvidenceCandidate } from './semantic/evidence-ranking/types.js';
import { readRecord, readString, readStringArray, sourceSemanticText, uniqueStrings } from './semantic/utils.js';

/** At most this many records are read for relevance in one search or packet; the rest are counted, not read. */
export const PUBLIC_KNOWLEDGE_SHORTLIST = 24;
/** Document text sent with one candidate: the passages that mention the question, within this many bytes. */
const CANDIDATE_TEXT_BYTES = 12 * 1024;

export interface PublicKnowledgeSelectionInput {
  readonly query: string;
  readonly writeScope?: readonly string[] | undefined;
  readonly scope: KnowledgeSpaceScopeInput;
  readonly mode: 'search' | 'packet';
  readonly signal?: AbortSignal | undefined;
  /** Packet mode: quote passages for at most this many accepted sources (the ones a packet can hold). */
  readonly limit?: number | undefined;
}
export interface PublicKnowledgeSelectedRow {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
  readonly probability?: number;
  /** Literal token overlap, never semantic probability. */
  readonly localScore?: number;
  readonly provenance?: 'classic';
  /** Complete semantic node content supplied to relevance, without store keys. */
  readonly nodeText?: string | undefined;
  /** Quoted passages of a selected source, with exact local offsets; empty is settled. */
  readonly spans?: readonly LocalAnswerExcerptSpan[] | undefined;
}
export interface PublicKnowledgeSelection {
  readonly provenance?: 'classic';
  readonly accepted: readonly PublicKnowledgeSelectedRow[];
  /** Records in scope, how many were read for relevance, and how many readings did not settle (left out). */
  readonly candidates: { readonly total: number; readonly considered: number; readonly unsettled: number };
  readonly assertCurrent: () => void;
  readonly relatedLabels: (kind: 'source' | 'node', id: string) => readonly string[];
}

// Serving content, memory/catalog descriptors and object identity. Review,
// confidence, timestamps, provenance IDs and arbitrary metadata stay local.
const NODE_CONTENT_FIELDS = ['semanticKind', 'factKind', 'entityKind', 'value', 'evidence', 'labels', 'subject',
  'markdown', 'text', 'searchText', 'content', 'description', 'tags', 'tag', 'scope', 'cls',
  'manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'batteryPowered', 'batteryType',
  'manualRequired', 'serial', 'firmware', 'installDate', 'purchaseDate', 'warrantyExpiration',
  'documentation', 'documentationUrl', 'documentation_url', 'sourceUrl', 'source_url',
  'deviceClass', 'device_class', 'entryType', 'entry_type', 'attributes', 'homeAssistant',
  'gapKind', 'query', 'reason', 'resolution', 'path', 'filePath', 'folderPath', 'url',
  'project', 'projects', 'capability', 'capabilities', 'feature', 'features', 'repo', 'repository', 'repositories',
  'provider', 'providers', 'service', 'services', 'env', 'environment', 'environments', 'owner', 'owners'];

function publicNodeMeaning(node: KnowledgeNodeRecord, nodesById: ReadonlyMap<string, KnowledgeNodeRecord>) {
  const hints = Array.isArray(node.metadata.targetHints) ? node.metadata.targetHints : [];
  const subjectIds = uniqueStrings([readString(node.metadata.subjectId), ...readStringArray(node.metadata.subjectIds),
    ...readStringArray(node.metadata.linkedObjectIds), ...hints.map((hint) => readString(readRecord(hint).id))]);
  const subjects = subjectIds.flatMap((id) => { const subject = nodesById.get(id); return subject ? [subject] : []; });
  // A known local key stays local; a foreign one keeps its meaning.
  const targetHints = hints.map((hint) => {
    const record = readRecord(hint), id = readString(record.id);
    if (!id || !nodesById.has(id)) return hint;
    const { id: _localId, ...meaning } = record; return meaning;
  });
  const claim = projectAnswerFactClaim({ ...node, metadata: { ...node.metadata, targetHints },
    subjectIds: subjects.map((subject) => subject.id) }, subjects);
  const content = Object.fromEntries(NODE_CONTENT_FIELDS.filter((key) => node.metadata[key] !== undefined).map((key) => [key, node.metadata[key]]));
  return { title: node.title, summary: node.summary, aliases: node.aliases, content, claim };
}

interface SharedPublicReading {
  readonly accepted: readonly PublicKnowledgeSelectedRow[];
  readonly spans: ReadonlyMap<string, readonly LocalAnswerExcerptSpan[]>;
  readonly considered: number;
  readonly unsettled: number;
  readonly classic: boolean;
}
/** Readings per store by request, each valid for the record state it was read from. */
const sharedReadings = new WeakMap<KnowledgeStore, Map<string, { readonly fingerprint: string; readonly value: Promise<SharedPublicReading> }>>();
const SHARED_READINGS_PER_STORE = 32;
function sharedReadingsFor(store: KnowledgeStore) {
  let shared = sharedReadings.get(store);
  if (!shared) { shared = new Map(); sharedReadings.set(store, shared); }
  return shared;
}

/** The record state a reading depends on: every record in scope and its update time, plus each source's extraction. */
function scopeFingerprint(store: KnowledgeStore, sources: readonly KnowledgeSourceRecord[], nodes: readonly KnowledgeNodeRecord[]): string {
  const hash = createHash('sha256');
  for (const source of sources) {
    const extraction = store.getExtractionBySourceId(source.id);
    hash.update(`s\0${source.id}\0${source.updatedAt}\0${extraction?.id ?? ''}\0${extraction?.updatedAt ?? ''}\n`);
  }
  for (const node of nodes) hash.update(`n\0${node.id}\0${node.updatedAt}\n`);
  return hash.digest('base64url');
}

function candidateText(text: string, terms: readonly string[]): string {
  if (new TextEncoder().encode(text).byteLength <= CANDIDATE_TEXT_BYTES) return text;
  const selection = selectKnowledgePassages(splitKnowledgePassages([[text]], 1_200), terms, CANDIDATE_TEXT_BYTES);
  const kept = selection.passages.map((passage) => passage.text).join('\n\n');
  return selection.omitted.passages > 0 ? `${kept}\n\n[${selection.omitted.passages} passage(s) not shown]` : kept;
}

/** Shared readers own relevance and quoted passages. Generic callers retain their
 * scope/status policies; no HomeGraph object policy or producer score is used.
 */
export async function readPublicKnowledgeSelection(store: KnowledgeStore, input: PublicKnowledgeSelectionInput,
  options: Pick<KnowledgeScopeSelectionOptions, 'signal' | 'assertCurrent' | 'shouldStop'> = {},
): Promise<PublicKnowledgeSelection> {
  return withConfiguredDecisionModelPolicy(() => readPublicKnowledgeUnderPolicy(store, input, options));
}

/**
 * Retrieve first, read second: the scope is listed once (stored readings, no
 * model), every record is ranked locally against the question, and only a
 * stated top {@link PUBLIC_KNOWLEDGE_SHORTLIST} is read for relevance, each
 * with the passages that mention the question. A reading that does not settle
 * leaves its record out and is counted. Cost does not grow with the store.
 */
async function readPublicKnowledgeUnderPolicy(store: KnowledgeStore, input: PublicKnowledgeSelectionInput,
  options: Pick<KnowledgeScopeSelectionOptions, 'signal' | 'assertCurrent' | 'shouldStop'>,
): Promise<PublicKnowledgeSelection> {
  try {
    const { query: requestQuery, writeScope, scope, mode } = input;
    if (typeof requestQuery !== 'string' || !['search', 'packet'].includes(mode)
      || !scope || typeof scope !== 'object' || Array.isArray(scope)
      || (writeScope !== undefined && (!Array.isArray(writeScope) || writeScope.some((value) => typeof value !== 'string')))) throw new Held('malformed');
    assertJudgmentInput({ query: requestQuery, writeScope });
    const externalSignal = input.signal && options.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal ?? options.signal;
    const shouldStop = options.shouldStop, callerCurrent = options.assertCurrent;
    // "Still wanted" is the caller's signal and its own check; nothing else is re-read.
    const assertCurrent = () => {
      if (externalSignal?.aborted || shouldStop?.()) throw new Held('aborted');
      try { callerCurrent?.(); }
      catch (error) { if (error instanceof JudgmentInputError || error instanceof Held) throw error; throw new Held('stale', { cause: error }); }
    };
    const empty = (): PublicKnowledgeSelection => ({ ...(isClassicOperation() ? { provenance: 'classic' as const } : {}), accepted: Object.freeze([]),
      candidates: { total: 0, considered: 0, unsettled: 0 }, assertCurrent, relatedLabels() { return Object.freeze([]); } });
    // An absent lookup question is an explicit input rule; it needs no corpus access.
    if (mode === 'search' && !requestQuery.trim()) { assertCurrent(); return empty(); }
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      const check = () => { if (signal.aborted) throw new Held('aborted'); assertCurrent(); };
      check();
      await store.init();
      check();
      const selection = await prepareKnowledgeScopeSelection(store, scope, { signal: externalSignal, shouldStop, kinds: ['source', 'node'] });
      check();
      const sources = selection.sources.filter((source) => mode === 'packet' || source.status !== 'stale');
      const nodes = selection.nodes.filter((node) => mode === 'packet' || node.status === 'active');
      const sourcesById = new Map(sources.map((source) => [source.id, source]));
      const nodesById = new Map(nodes.map((node) => [node.id, node]));
      const query = mode === 'packet' && writeScope?.length
        ? JSON.stringify({ task: requestQuery, writeScope, context: 'Paths describe the requested work, not evidence or a requirement for literal word overlap.' })
        : requestQuery;
      assertJudgmentInput({ query });
      const terms = knowledgeTerms([requestQuery, ...(writeScope ?? [])]);
      // Every extraction in one read, not one per source (free when the selection already read them).
      store.readAheadExtractions();
      type Entry = { readonly kind: 'source'; readonly source: KnowledgeSourceRecord; readonly text: string }
        | { readonly kind: 'node'; readonly node: KnowledgeNodeRecord; readonly text: string };
      const entries: Entry[] = [
        ...sources.map((source): Entry => {
          const extraction = store.getExtractionBySourceId(source.id);
          if (extraction && (extraction.sourceId !== source.id || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source))) throw new Held('malformed');
          const uris = knowledgeSourceJudgmentUris(source);
          return { kind: 'source', source, text: [sourceSemanticText({ ...source, ...uris }, extraction), source.folderPath].filter(Boolean).join('\n\n') };
        }),
        ...nodes.map((node): Entry => ({ kind: 'node', node, text: JSON.stringify(publicNodeMeaning(node, nodesById)) })),
      ];
      const describe = (entry: Entry) => `${entry.kind === 'source' ? entry.source.title ?? '' : entry.node.title}\n${entry.text}`;
      const rowOf = (entry: Entry): Omit<PublicKnowledgeSelectedRow, 'probability'> => entry.kind === 'source'
        ? { kind: 'source', id: entry.source.id, source: entry.source }
        : { kind: 'node', id: entry.node.id, node: entry.node, nodeText: entry.text };
      const quoteLimit = Math.max(1, input.limit ?? PUBLIC_KNOWLEDGE_SHORTLIST);
      const readSelection = async (): Promise<SharedPublicReading> => {
        let classicRetrieval = isClassicOperation();
        let unsettled = 0;
        let considered = 0;
        let relevanceRejected = false;
        const accepted = await decisionOrClassic<PublicKnowledgeSelectedRow[]>(async () => {
          const shortlisted = shortlistAnswerEntries(entries, [requestQuery, ...(writeScope ?? [])].join(' '), describe, () => false, PUBLIC_KNOWLEDGE_SHORTLIST);
          considered = shortlisted.length;
          const candidates: AnswerEvidenceCandidate[] = shortlisted.map((entry, index) => {
            const reference = `candidate-${index + 1}`;
            if (entry.kind === 'node') return { reference, kind: 'node', title: entry.node.title, nodeKind: entry.node.kind, text: entry.text };
            const discovery = readRecord(entry.source.metadata.sourceDiscovery);
            return { reference, kind: 'source', title: entry.source.title ?? 'Untitled source', sourceType: entry.source.sourceType,
              text: candidateText(entry.text, terms),
              claimedProvenance: JSON.stringify({ reason: readString(discovery.trustReason), domain: readString(discovery.sourceDomain) }) };
          });
          // Only what leaves is scanned: the shortlisted candidates.
          assertJudgmentInput({ query, candidates });
          const plan = await prepareAnswerEvidenceRelevanceBatches({ query, candidates }, {
            signal, timeoutMs: Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : 0, assertCurrent: check,
            observeVerdict(verdict) { if (verdict === 'no') relevanceRejected = true; },
          });
          check();
          unsettled = plan.unsettled?.length ?? 0;
          const byReference = new Map(candidates.map((candidate, index) => [candidate.reference, shortlisted[index]!]));
          return plan.accepted.map((reading) => ({ ...rowOf(byReference.get(reading.reference)!), probability: reading.probability }))
            .sort((left, right) => right.probability - left.probability || left.id.localeCompare(right.id));
        }, () => {
          check();
          classicRetrieval = true;
          considered = entries.length;
          return rankClassicCatalog(entries, requestQuery, (entry) => ({ id: entry.kind === 'source' ? entry.source.title ?? '' : entry.node.title, description: entry.text }))
            .map((match) => ({ ...rowOf(match.entry), localScore: match.score, provenance: 'classic' as const }));
        }, () => !relevanceRejected);
        let spans = new Map<string, readonly LocalAnswerExcerptSpan[]>();
        const quoted = accepted.filter((row) => row.source).slice(0, quoteLimit);
        if (mode === 'packet' && quoted.length) {
          store.readAheadExtractions(quoted.map((row) => row.id));
          if (classicRetrieval || isClassicOperation()) {
            spans = new Map(quoted.map((row) => [row.id, localKnowledgeSourceSpans(row.source!, store.getExtractionBySourceId(row.id))] as const));
          } else {
            const read = await readAnswerSourceExcerpts(query, quoted.map((row) => ({ source: row.source!,
              extraction: store.getExtractionBySourceId(row.id), hints: terms,
              context: 'Select exact evidence for the original task and its work scope.' })), signal);
            spans = new Map([...read].map(([id, excerpt]) => [id, excerpt.spans] as const));
          }
          check();
        }
        return { accepted, spans, considered, unsettled, classic: classicRetrieval };
      };
      // The same request over unchanged records (same ids and update times)
      // reuses the reading: agents started for one task share one packet.
      let reading: SharedPublicReading;
      if (isClassicOperation()) reading = await readSelection();
      else {
        const key = JSON.stringify([mode, requestQuery, writeScope ?? [], quoteLimit, scope.knowledgeSpaceId ?? null, scope.includeAllSpaces === true]);
        const fingerprint = scopeFingerprint(store, sources, nodes);
        const shared = sharedReadingsFor(store);
        const held = shared.get(key);
        if (held && held.fingerprint === fingerprint) {
          try { reading = await held.value; }
          catch {
            // Another caller's cancellation or failure is not this caller's.
            check();
            reading = await readSelection();
          }
        } else {
          const value = readSelection();
          const entry = { fingerprint, value };
          shared.delete(key); shared.set(key, entry);
          while (shared.size > SHARED_READINGS_PER_STORE) shared.delete(shared.keys().next().value!);
          const forget = () => { if (shared.get(key) === entry) shared.delete(key); };
          // A local fallback is not a model reading worth sharing; a failure is never kept.
          value.then((result) => { if (result.classic) forget(); }, forget);
          reading = await value;
        }
      }
      check();
      const { accepted, spans, considered, unsettled, classic: classicRetrieval } = reading;
      // Related labels come from one edge pass over the selection.
      const related = new Map<string, string[]>();
      for (const edge of selection.edges) {
        if (!isActiveKnowledgeEdge(edge)) continue;
        const label = (kind: string, id: string) => kind === 'node' ? nodesById.get(id)?.title
          : sourcesById.get(id)?.title ?? sourcesById.get(id)?.canonicalUri ?? (sourcesById.has(id) ? id : undefined);
        for (const [kind, id, otherKind, otherId] of [[edge.fromKind, edge.fromId, edge.toKind, edge.toId], [edge.toKind, edge.toId, edge.fromKind, edge.fromId]] as const) {
          const text = label(otherKind, otherId);
          if (!text) continue;
          const key = `${kind}:${id}`;
          const list = related.get(key);
          if (list) { if (list.length < 8 && !list.includes(text)) list.push(text); } else related.set(key, [text]);
        }
      }
      const result = Object.freeze(accepted.map((row) => Object.freeze({ ...row,
        ...(mode === 'packet' && row.source ? { spans: spans.get(row.id) ?? Object.freeze([]) } : {}) })));
      check();
      return { ...(classicRetrieval ? { provenance: 'classic' as const } : {}), accepted: result, assertCurrent,
        candidates: { total: entries.length, considered, unsettled },
        relatedLabels(kind: 'source' | 'node', id: string) {
          const labels = related.get(`${kind}:${id}`) ?? [];
          for (const label of labels) assertJudgmentInput(label);
          return Object.freeze([...labels]);
        } };
    // The caller owns cancellation; corpus size does not invent a deadline.
    }, 0, externalSignal);
  } catch (error) {
    if (error instanceof JudgmentInputError || error instanceof Held) throw error;
    if (error instanceof KnowledgeScopeSelectionHeldError) throw new Held(error.reason === 'uncertain' ? 'unsettled' : error.reason);
    if (error instanceof KnowledgeAnswerExcerptHeldError) throw new Held(error.reason);
    if (error instanceof KnowledgeSourceQualityHeldError) throw new Held(error.reason === 'aborted' ? 'aborted' : 'stale');
    if (error instanceof KnowledgeAnswerQualityHeldError) throw new Held(error.reason === 'uncertain' ? 'unsettled'
      : error.reason === 'budget' || error.reason === 'aborted' || error.reason === 'stale' || error.reason === 'malformed' ? error.reason : 'unavailable');
    throw new Held('unavailable', { cause: error });
  }
}
