import { mapLimit } from '@goodvibes-jev/judgment';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeEdgeRecord, KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { knowledgeTerms, selectKnowledgePassages, splitKnowledgePassages } from '../passages.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { belongsToSpace, edgeIsActive, isGeneratedPageSource } from './helpers.js';
import { assertKnowledgeExtractionInput, knowledgeExtractionNeedsRefresh } from '../extraction-policy.js';
import { KnowledgeAnswerQualityHeldError } from '../semantic/answer-verification/types.js';
import { repairProfileSourceText, repairProfileSubject } from '../semantic/repair-profile.js';
import { readKnowledgeBattery, repairSourceRelevance } from '../semantic/repair-decisions.js';
import { buildSourceLinkIndex } from './source-links.js';
export interface HomeGraphSearchState {
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
}

export function readHomeGraphSearchState(store: KnowledgeStore, spaceId: string): HomeGraphSearchState {
  const sources = store.listSourcesInSpace(spaceId)
    .filter((source) => source.status !== 'stale' && !isGeneratedPageSource(source));
  const nodes = store.listNodesInSpace(spaceId).filter((node) => node.status === 'active');
  const sourceIds = new Set(sources.map((source) => source.id));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = store.listEdges().filter((edge) => (
    edgeIsActive(edge)
    && belongsToSpace(edge, spaceId)
    && (edge.fromKind !== 'source' || sourceIds.has(edge.fromId))
    && (edge.toKind !== 'source' || sourceIds.has(edge.toId))
    && (edge.fromKind !== 'node' || nodeIds.has(edge.fromId))
    && (edge.toKind !== 'node' || nodeIds.has(edge.toId))
  ));
  const extractionBySourceId = new Map<string, KnowledgeExtractionRecord>();
  for (const extraction of store.listExtractionsForSources(sourceIds)) {
    const source = sourcesById.get(extraction.sourceId);
    if (!source || getKnowledgeSpaceId(extraction) !== getKnowledgeSpaceId(source)) {
      throw new KnowledgeAnswerQualityHeldError('malformed');
    }
    if (!extractionBySourceId.has(extraction.sourceId)) {
      extractionBySourceId.set(extraction.sourceId, extraction);
    }
  }
  return { spaceId, sources, nodes, edges, extractionBySourceId };
}

/** Documents read by the decision model for one question's repair pre-pass, at most. */
const REPAIR_CANDIDATE_READS = 4;
/** Passages of a candidate's stored text sent with its reading. */
const REPAIR_CANDIDATE_TEXT_BYTES = 12 * 1024;

/**
 * The documents worth re-extracting before one question is answered. Only a
 * document whose extraction needs repair can be one; it is shortlisted in code
 * by the words it shares with the question, through its own identity or the
 * objects it is linked to, and at most {@link REPAIR_CANDIDATE_READS} are read
 * by the decision model. A candidate whose reading does not settle, or whose
 * text may not be sent, is not repaired now; the question goes on with what is
 * stored and reindex repairs it later.
 */
export async function selectHomeGraphExtractionRepairCandidates(
  query: string, sources: readonly KnowledgeSourceRecord[], nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[], extractionBySourceId: (sourceId: string) => KnowledgeExtractionRecord | null | undefined,
  limit: number, signal?: AbortSignal,
): Promise<KnowledgeSourceRecord[]> {
  signal?.throwIfAborted();
  const terms = knowledgeTerms([query]);
  if (terms.length === 0) return [];
  // Only documents whose stored extraction needs repair are considered; the rest cost nothing.
  const eligible = sources.filter((source) => source.artifactId
    && homeGraphExtractionNeedsRepair(extractionBySourceId(source.id), source.artifactId));
  if (eligible.length === 0) return [];
  const links = buildSourceLinkIndex(edges, nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const shortlist = eligible.map((source, order) => {
    const subjects = [...(links.get(source.id) ?? [])].flatMap((id) => { const node = nodesById.get(id); return node ? [node] : []; });
    const extraction = extractionBySourceId(source.id) ?? null;
    const words = new Set(knowledgeTerms([source.title, source.summary, source.description, source.tags, source.sourceUri,
      extraction?.title, extraction?.summary, subjects.map((node) => [node.title, node.aliases])]));
    let score = 0;
    for (const term of terms) if (words.has(term)) score += term.length >= 5 || /\d/.test(term) ? 2 : 1;
    return { source, subjects, extraction, order, score };
  }).filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, Math.max(REPAIR_CANDIDATE_READS, limit));
  const readings = await mapLimit(shortlist, 4, async ({ source, subjects, extraction }) => {
    signal?.throwIfAborted();
    try {
      assertJudgmentInput({ summary: source.summary, description: source.description });
      assertKnowledgeExtractionInput(extraction);
      const state = { request: query, source: { title: source.title, summary: source.summary, description: source.description,
        sourceType: source.sourceType, tags: source.tags, uri: source.sourceUri,
        extraction: extraction ? { title: extraction.title, summary: extraction.summary, excerpt: extraction.excerpt,
          text: repairCandidateText(repairProfileSourceText(extraction), terms) } : null,
        subjects: subjects.map(repairProfileSubject) } };
      const run = await readKnowledgeBattery(repairSourceRelevance, state, signal);
      return run.readings.relevant.verdict === 'yes'
        ? { source, score: run.readings.relevant.probability, assertCurrent: run.assertDecisionCurrent } : undefined;
    } catch (error) {
      signal?.throwIfAborted();
      logger.info('Home Graph question left a document unrepaired: its relevance was not settled', { sourceId: source.id, error: summarizeError(error) });
      return undefined;
    }
  });
  signal?.throwIfAborted();
  return readings.filter((entry): entry is NonNullable<typeof entry> => {
    if (!entry) return false;
    try { entry.assertCurrent(); return true; } catch { return false; }
  }).sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id))
    .slice(0, Math.max(1, limit)).map((entry) => entry.source);
}

/** The passages of a candidate's stored text that mention the question, within the reading's budget. */
function repairCandidateText(text: string, terms: readonly string[]): string {
  if (new TextEncoder().encode(text).byteLength <= REPAIR_CANDIDATE_TEXT_BYTES) return text;
  const selection = selectKnowledgePassages(splitKnowledgePassages([[text]], 1_200), terms, REPAIR_CANDIDATE_TEXT_BYTES);
  const kept = selection.passages.map((passage) => passage.text).join('\n\n');
  return selection.omitted.passages > 0 ? `${kept}\n\n[${selection.omitted.passages} passage(s) not shown]` : kept;
}
/**
 * Decided from the extraction's stored version and the artifact it was made
 * from; a current extraction that found no readable text is final.
 */
export function homeGraphExtractionNeedsRepair(extraction: KnowledgeExtractionRecord | null | undefined, artifactId?: string | undefined): boolean {
  return knowledgeExtractionNeedsRefresh(extraction ?? null, undefined, artifactId);
}
