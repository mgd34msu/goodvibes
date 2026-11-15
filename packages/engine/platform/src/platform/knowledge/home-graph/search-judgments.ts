import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { knowledgeExtractionIsReadable } from '../extraction-policy.js';
import { knowledgeTerms, selectKnowledgePassages, splitKnowledgePassages } from '../passages.js';
import type { KnowledgeScopeSelection } from '../scope-selection.js';
import { knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { factHasUsableSource, factSourceIds, initialEvidenceCandidate, initialNodeReferenceContext, listAnswerNodes,
  type AnswerRecordReader } from '../semantic/answer-evidence.js';
import { renderNodeEvidence } from '../semantic/answer-fact-selection.js';
import { prepareAnswerSourceExcerptBatches } from '../semantic/answer-excerpts/prepare.js';
import { KnowledgeAnswerExcerptHeldError } from '../semantic/answer-excerpts/types.js';
import { prepareAnswerLinkedObjects } from '../semantic/answer-object-alignment/prepare.js';
import { KnowledgeAnswerObjectAlignmentHeldError } from '../semantic/answer-object-alignment/types.js';
import { withAnswerVerificationBudget } from '../semantic/answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError as Held } from '../semantic/answer-verification/types.js';
import { prepareAnswerEvidenceRelevance } from '../semantic/evidence-ranking/reader.js';
import { KnowledgeEvidenceRelevanceHeldError, type AnswerEvidenceCandidate } from '../semantic/evidence-ranking/types.js';
import { createSemanticWriteGuard } from '../semantic/primary-source-plan.js';
import { readStringArray, sourceSemanticText } from '../semantic/utils.js';
import { subjectIdentity } from './answer-scope.js';
import { buildSourceLinkIndex } from './source-links.js';
import { sourceLinkedObjectIds } from './state.js';
import { edgeIsActive } from './helpers.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from './extension.js';
import type { HomeGraphSearchState } from './search.js';
import type { HomeGraphAskInput, HomeGraphSearchResult } from './types.js';

/** At most this many records of a home are read for one question. */
export const HOME_GRAPH_ASK_SHORTLIST = 24;
/** Document text sent with one candidate: the passages that mention the question, within this many bytes. */
const CANDIDATE_TEXT_BYTES = 12 * 1024;

export interface HomeGraphSearchSelection {
  readonly results: readonly HomeGraphSearchResult[];
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly acceptedFactIds: readonly string[];
  readonly candidateSourceIds: readonly string[];
  readonly candidates: { readonly total: number; readonly considered: number; readonly unread: number };
  /** Store revision the selection was read at; the answer carries it. */
  readonly readAtRevision: number;
}

interface ShortlistEntry {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly source?: KnowledgeSourceRecord | undefined;
  readonly node?: KnowledgeNodeRecord | undefined;
}

/**
 * Chooses the evidence for one Home Graph question. Candidates come from the
 * objects the question names (their facts and linked documents), or, when it
 * names none, from a local text match; at most {@link HOME_GRAPH_ASK_SHORTLIST}
 * are read by the decision model. The named objects themselves are returned as
 * linked objects, looked up rather than read. A candidate whose reading does
 * not settle is left out and counted.
 * The selection reads the snapshot it was given and writes nothing, so a
 * change elsewhere in the home while it runs does not fail it.
 */
export async function readHomeGraphSearchSelection(input: {
  readonly signal?: AbortSignal | undefined;
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  /** The objects the question names, when already settled (a renewal after repair keeps the original ones). */
  readonly linkedObjects?: readonly KnowledgeNodeRecord[] | undefined;
}): Promise<HomeGraphSearchSelection> {
  if (input.state.spaceId !== input.spaceId) throw new Held('malformed');
  const query = input.query.query;
  assertJudgmentInput({ query });
  const readAtRevision = input.store.revisionSource.revision();
  try {
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      const { state } = input;
      const sourcesById = new Map(state.sources.map((source) => [source.id, source]));
      const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
      const reader: AnswerRecordReader = {
        source: (id) => sourcesById.get(id) ?? null,
        node: (id) => nodesById.get(id) ?? null,
        watch: (_key, read) => read(),
      };
      // The space is the scope: every record of the snapshot belongs to it.
      const scope: KnowledgeScopeSelection = {
        sources: state.sources, nodes: state.nodes, issues: [], edges: state.edges,
        source: () => true, node: () => true, issue: () => true, retainEdges: () => () => {}, assertCurrent: () => {},
      };
      const usableSourceIds = new Set(state.sources.filter((source) => source.status === 'indexed').map((source) => source.id));
      // Home Assistant rows (entities, devices, areas...) are looked up as the
      // objects the question names, never read one by one as evidence.
      const answerNodes = listAnswerNodes(scope).filter((node) => !node.kind.startsWith('ha_')
        && (node.metadata.semanticKind !== 'fact' || factHasUsableSource(node, usableSourceIds)));
      const linkedObjects = input.linkedObjects ?? (await prepareAnswerLinkedObjects(input.store, input.spaceId, { query },
        HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles ?? [], signal).read([], [])).linkedObjects;
      signal.throwIfAborted();
      const shortlist = shortlistHomeGraphCandidates(state, query, linkedObjects, answerNodes, HOME_GRAPH_ASK_SHORTLIST);
      const subjects = linkedObjects.map((node) => ({ title: node.title, kind: node.kind, summary: node.summary,
        aliases: node.aliases, identity: subjectIdentity(node.metadata) }));
      const terms = knowledgeTerms([query, ...linkedObjects.map((node) => [node.title, ...node.aliases])]);
      const items: HomeGraphSearchResult[] = [];
      const candidates: AnswerEvidenceCandidate[] = [];
      for (const entry of shortlist) {
        if (entry.source) {
          const source = entry.source;
          const extraction = state.extractionBySourceId.get(source.id) ?? null;
          // A relevance yes is not permission to serve an unindexed documentation suggestion.
          if (!extraction && source.status !== 'indexed' && source.metadata.homeGraphSourceKind === 'documentation-candidate') continue;
          const text = candidateText(sourceSemanticText({ ...source, ...knowledgeSourceJudgmentUris(source) }, extraction), terms);
          const item = { kind: 'source' as const, id: source.id, title: source.title ?? source.sourceUri ?? source.id, score: 0, source };
          candidates.push(initialEvidenceCandidate({ ...item, facts: [] }, `candidate-${candidates.length + 1}`, text, input.store, reader, scope));
          items.push(item);
        } else if (entry.node) {
          const node = entry.node;
          const text = [renderNodeEvidence(node), JSON.stringify(subjectIdentity(node.metadata)),
            initialNodeReferenceContext(input.store, node, scope, reader, usableSourceIds)].join('\n');
          const item = { kind: 'node' as const, id: node.id, title: node.title, score: 0, node };
          candidates.push(initialEvidenceCandidate({ ...item, facts: node.metadata.semanticKind === 'fact' ? [node] : [] },
            `candidate-${candidates.length + 1}`, text, input.store, reader, scope));
          items.push(item);
        }
      }
      assertJudgmentInput({ query, candidates });
      const relevance = await prepareAnswerEvidenceRelevance({ query, candidates, subjects },
        { signal, timeoutMs: Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : 0 });
      const byReference = new Map(candidates.map((candidate, index) => [candidate.reference, items[index]!]));
      const selected = relevance.accepted.map((reading) => byReference.get(reading.reference)!)
        .slice(0, Math.max(1, input.query.limit ?? 8));
      // Result summary: the extraction's summary when it was stored as readable, else the source's own.
      const summaries = new Map<string, string>();
      for (const item of selected) if (item.source) {
        const extraction = state.extractionBySourceId.get(item.id);
        const value = [knowledgeExtractionIsReadable(extraction) ? extraction?.summary : undefined, item.source.summary]
          .find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
        if (value) summaries.set(item.id, value.trim());
      }
      const selectedSources = selected.flatMap((item) => item.source ? [item.source] : []);
      // The excerpt reader checks only the documents it reads.
      const excerptGuard = createSemanticWriteGuard(input.store, signal);
      const excerpts = prepareAnswerSourceExcerptBatches(input.store, query,
        selectedSources.map((source) => ({ source, context: JSON.stringify({ subjects }) })), excerptGuard, signal);
      excerpts.start();
      const spans = await excerpts.read(new Set(selectedSources.map((source) => source.id)));
      const selectedText = new Map([...spans].map(([id, selection]) => [id, selection.map((span) => span.text).join('\n\n')]));
      const results = selected.map((item) => ({ ...item, summary: item.source ? summaries.get(item.id) : item.node?.summary,
        // A settled empty excerpt is explicit; the renderer must not revive an unselected summary.
        excerpt: item.source ? selectedText.get(item.id) ?? '' : renderNodeEvidence(item.node!),
      }));
      const acceptedFactIds = relevance.accepted.flatMap((reading) => {
        const node = byReference.get(reading.reference)?.node;
        return node?.metadata.semanticKind === 'fact' ? [node.id] : [];
      });
      const neededSources = new Set(selected.flatMap((item) => item.node?.metadata.semanticKind === 'fact' ? factSourceIds(item.node) : []));
      const selectedNodes = new Set(selected.flatMap((item) => item.node ? [item.id] : []));
      const links = buildSourceLinkIndex(state.edges, state.nodes);
      for (const source of state.sources) if ([...(links.get(source.id) ?? []), ...sourceLinkedObjectIds(source)]
        .some((id) => selectedNodes.has(id))) neededSources.add(source.id);
      const candidateSourceIds = [...new Set([...selectedSources.map((source) => source.id),
        ...relevance.accepted.flatMap((reading) => {
          const source = byReference.get(reading.reference)?.source;
          return source && neededSources.has(source.id) ? [source.id] : [];
        })])];
      return {
        results, linkedObjects, acceptedFactIds, candidateSourceIds, readAtRevision,
        candidates: { total: state.sources.length + answerNodes.length, considered: candidates.length, unread: relevance.unsettled?.length ?? 0 },
      };
    }, input.query.timeoutMs, input.signal);
  } catch (error) {
    throw homeGraphSelectionFailure(error);
  }
}

/**
 * The one place a selection failure becomes an answer hold. A hold keeps its
 * original error as the cause; unavailable is said only when the model could
 * not be reached or is not configured. Anything else is the error it is.
 */
function homeGraphSelectionFailure(error: unknown): unknown {
  if (error instanceof JudgmentInputError || error instanceof Held) return error;
  if (error instanceof KnowledgeAnswerExcerptHeldError || error instanceof KnowledgeEvidenceRelevanceHeldError
    || error instanceof KnowledgeAnswerObjectAlignmentHeldError) {
    return new Held(error.reason === 'unconfigured' ? 'unavailable' : error.reason === 'unsettled' ? 'uncertain' : error.reason, { cause: error });
  }
  if (error instanceof KnowledgeSourceQualityHeldError) return new Held(error.reason === 'aborted' ? 'aborted' : 'stale', { cause: error });
  return error;
}

/**
 * Picks the records one question is read against. With named objects: those
 * objects' facts (a `describes` edge or a subject id), the documents linked to
 * them, and the documents that support those facts. Otherwise, or when the
 * objects have nothing linked: every record, those sharing the most words with
 * the question first (so a paraphrase still reaches a small home's documents).
 * Either way at most `cap`; the rest are counted, not read.
 */
export function shortlistHomeGraphCandidates(state: HomeGraphSearchState, query: string, linkedObjects: readonly KnowledgeNodeRecord[],
  answerNodes: readonly KnowledgeNodeRecord[], cap: number): ShortlistEntry[] {
  const subjectIds = new Set(linkedObjects.map((node) => node.id));
  const answerNodeIds = new Set(answerNodes.map((node) => node.id));
  const sourcesById = new Map(state.sources.map((source) => [source.id, source]));
  const nodesById = new Map(answerNodes.map((node) => [node.id, node]));
  const terms = knowledgeTerms([query, ...linkedObjects.map((node) => [node.title, ...node.aliases])]);
  const score = (texts: readonly unknown[]): number => {
    const words = new Set(knowledgeTerms(texts));
    let total = 0;
    for (const term of terms) if (words.has(term)) total += term.length >= 5 || /\d/.test(term) ? 2 : 1;
    return total;
  };
  const sourceScore = (source: KnowledgeSourceRecord) => {
    const extraction = state.extractionBySourceId.get(source.id);
    return score([source.title, source.summary, source.description, source.tags, extraction?.title, extraction?.summary]);
  };
  const nodeScore = (node: KnowledgeNodeRecord) => score([node.title, node.summary, node.aliases, node.metadata.value, node.metadata.factKind]);
  const ranked = (entries: ShortlistEntry[]) => entries
    .map((entry, order) => ({ entry, order, score: entry.source ? sourceScore(entry.source) : nodeScore(entry.node!) }))
    .sort((left, right) => right.score - left.score || left.order - right.order);
  if (subjectIds.size > 0) {
    const factIds = new Set<string>(), sourceIds = new Set<string>();
    for (const edge of state.edges) {
      if (!edgeIsActive(edge)) continue;
      if (edge.fromKind === 'node' && edge.toKind === 'node' && edge.relation === 'describes' && subjectIds.has(edge.toId)) factIds.add(edge.fromId);
      if (edge.fromKind === 'source' && edge.toKind === 'node' && subjectIds.has(edge.toId)) sourceIds.add(edge.fromId);
      if (edge.fromKind === 'node' && edge.toKind === 'source' && subjectIds.has(edge.fromId)) sourceIds.add(edge.toId);
    }
    for (const node of answerNodes) {
      if (node.metadata.semanticKind !== 'fact' && node.kind !== 'fact') continue;
      if ([...readStringArray(node.metadata.subjectIds), ...readStringArray(node.metadata.linkedObjectIds),
        ...(typeof node.metadata.subjectId === 'string' ? [node.metadata.subjectId] : [])].some((id) => subjectIds.has(id))) factIds.add(node.id);
    }
    for (const source of state.sources) if (sourceLinkedObjectIds(source).some((id) => subjectIds.has(id))) sourceIds.add(source.id);
    for (const edge of state.edges) {
      if (edgeIsActive(edge) && edge.fromKind === 'source' && edge.toKind === 'node' && edge.relation === 'supports_fact' && factIds.has(edge.toId)) sourceIds.add(edge.fromId);
    }
    const structural: ShortlistEntry[] = [
      ...[...factIds].flatMap((id) => answerNodeIds.has(id) && !subjectIds.has(id) ? [{ kind: 'node' as const, id, node: nodesById.get(id)! }] : []),
      ...[...sourceIds].flatMap((id) => { const source = sourcesById.get(id); return source ? [{ kind: 'source' as const, id, source }] : []; }),
    ];
    if (structural.length > 0) return ranked(structural).slice(0, cap).map((row) => row.entry);
  }
  const everything: ShortlistEntry[] = [
    ...state.sources.map((source) => ({ kind: 'source' as const, id: source.id, source })),
    ...answerNodes.filter((node) => !subjectIds.has(node.id)).map((node) => ({ kind: 'node' as const, id: node.id, node })),
  ];
  return ranked(everything).slice(0, cap).map((row) => row.entry);
}

function candidateText(text: string, terms: readonly string[]): string {
  if (new TextEncoder().encode(text).byteLength <= CANDIDATE_TEXT_BYTES) return text;
  const selection = selectKnowledgePassages(splitKnowledgePassages([[text]], 1_200), terms, CANDIDATE_TEXT_BYTES);
  const kept = selection.passages.map((passage) => passage.text).join('\n\n');
  return selection.omitted.passages > 0 ? `${kept}\n\n[${selection.omitted.passages} passage(s) not shown]` : kept;
}
