import { requireSemanticKnowledge } from '../decision-policy.js';
import { knowledgeSourceJudgmentUris } from '../source-structural-references.js';
import { assertAnswerVerificationActive } from './answer-verification/budget.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { answerSourceRerank } from './ranking/source-rerank.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isGeneratedKnowledgeSource } from '../generated-projections.js';
import { readRecord, readString, readStringArray, uniqueStrings } from './utils.js';

export interface AnswerSourceRankingEvidence {
  readonly score: number;
  readonly excerpt?: string | undefined;
  readonly source?: KnowledgeSourceRecord | undefined;
  /** Set when an excerpt reading chose this item's quoted passages (possibly none). */
  readonly excerptSpans?: readonly unknown[] | undefined;
}

/** Readings that did not settle in one answer; each left its candidate out. */
export interface AnswerUnsettledTally { unsettled: number }

/** Kept for callers that still name it; an unsettled source reading now leaves that source out instead. */
export class KnowledgeSourceRankingHeldError extends Error {
  override readonly name = 'KnowledgeSourceRankingHeldError';
  constructor() { super('Knowledge source relevance did not settle; no source was selected.'); }
}

/** The caller supplies only sources inside its existing access/space filter. */
export async function readAnswerSourceRanking(
  evidence: readonly AnswerSourceRankingEvidence[],
  facts: readonly KnowledgeNodeRecord[],
  query: string,
  signal?: AbortSignal,
  tally?: AnswerUnsettledTally,
): Promise<Array<{ source: KnowledgeSourceRecord; probability: number }>> {
  requireSemanticKnowledge();
  assertAnswerVerificationActive(signal);
  const sources = uniqueSources(evidence.flatMap((item) => item.source ? [item.source] : []))
    .filter((source) => source.status !== 'failed' && source.status !== 'stale');
  const realSources = sources.filter((source) => !isGeneratedKnowledgeSource(source));
  const shortlist = (realSources.length > 0 ? realSources : sources);
  if (shortlist.length === 0) return [];
  const candidates = shortlist.map((source) => ({
    id: source.id,
    content: {
      ...sourceRankingProjection(source, evidence.some((item) => item.source?.id === source.id && item.excerptSpans !== undefined)),
      excerpts: evidence.filter((item) => item.source?.id === source.id && item.excerpt).map((item) => item.excerpt!),
      facts: facts.filter((fact) => fact.status === 'active' && uniqueStrings([
        ...readStringArray(fact.metadata.sourceIds), readString(fact.metadata.sourceId), fact.sourceId,
      ]).includes(source.id)).map((fact) => ({
        title: fact.title, summary: fact.summary ?? '',
        value: readString(fact.metadata.value) ?? '', evidence: readString(fact.metadata.evidence) ?? '',
      })),
    },
  }));
  // Preflight the complete selected batch before any concurrent request starts.
  assertJudgmentInput({ query, candidates: candidates.map((candidate) => candidate.content) });
  const port = judgmentPort('engine.knowledge.answer-source-rank');
  const current = () => { assertAnswerVerificationActive(signal); };
  const result = await answerSourceRerank.rerank(port, query, candidates, { site: 'engine.knowledge.answer-source-rank', beforeAttempt: current, ...(signal ? { signal } : {}) });
  current();
  for (const item of result.ranked) if (item.decisionId !== undefined) port.recorder?.recordAction(item.decisionId, item.reading.verdict === 'yes' && item.reading.outcome === 'act' ? 'selected: query-supporting source' : `not selected: ${item.reading.verdict} (${item.reading.outcome})`);
  const accepted = result.ranked.filter((item) => item.reading.verdict === 'yes' && item.reading.outcome === 'act');
  // An unsettled reading leaves its source out and is counted; the rest still answer.
  if (tally) tally.unsettled += result.ranked.filter((item) => item.reading.outcome !== 'act').length;
  const byId = new Map(shortlist.map((source) => [source.id, source]));
  return accepted.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).map((item) => ({ source: byId.get(item.id)!, probability: item.probability }));
}

export async function rankAnswerSources(evidence: readonly AnswerSourceRankingEvidence[], facts: readonly KnowledgeNodeRecord[], query: string,
  signal?: AbortSignal, tally?: AnswerUnsettledTally): Promise<KnowledgeSourceRecord[]> {
  requireSemanticKnowledge();
  return (await readAnswerSourceRanking(evidence, facts, query, signal, tally)).map((item) => item.source);
}

/** Prepared answer excerpts have already selected their body evidence. Keep
 * identity/provenance context, but never revive an unselected body field through
 * a second projection. Legacy callers retain their existing complete content.
 */
function sourceRankingProjection(source: KnowledgeSourceRecord, selectedExcerpts: boolean) {
  const content = sourceRankingContent(source);
  if (!selectedExcerpts) return content;
  const { summary: _summary, description: _description, ...context } = content;
  return { ...context, evidenceScope: 'selected-excerpts' };
}

/** Minimal content/provenance evidence; no arbitrary metadata or numeric database dates. */
export function sourceRankingContent(source: KnowledgeSourceRecord) {
  const discovery = readRecord(source.metadata.sourceDiscovery);
  const uris = knowledgeSourceJudgmentUris(source);
  return {
    title: source.title ?? '', summary: source.summary ?? '', description: source.description ?? '',
    uri: uris.url ?? uris.sourceUri ?? uris.canonicalUri ?? '',
    sourceType: source.sourceType, status: source.status, trust: 'untrusted reference material',
    claimedProvenance: { reason: readString(discovery.trustReason) ?? '', domain: readString(discovery.sourceDomain) ?? '' },
  };
}

function uniqueSources(values: readonly KnowledgeSourceRecord[]): KnowledgeSourceRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeSourceRecord[] = [];
  for (const source of values) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    result.push(source);
  }
  return result;
}
