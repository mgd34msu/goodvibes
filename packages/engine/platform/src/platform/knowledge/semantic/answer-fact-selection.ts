import { requireSemanticKnowledge } from '../decision-policy.js';
import { assertAnswerVerificationActive } from './answer-verification/budget.js';
import { judgmentPort } from '@goodvibes/engine/errors';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import type { AnswerUnsettledTally } from './answer-source-ranking.js';
import { answerFactRerank, answerQueryIntent } from './ranking/fact-rerank.js';
import { rankClassicCatalog } from '../../runtime/classic-catalog.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { readString } from './utils.js';

export class KnowledgeFactSelectionHeldError extends Error {
  override readonly name = 'KnowledgeFactSelectionHeldError';
  constructor() { super('Knowledge fact relevance did not settle; no fact was selected.'); }
}

/** At most this many facts are read for one question; the rest are ranked out locally by the words they share with it. */
export const ANSWER_FACT_SHORTLIST = 16;

/**
 * Facts a reading says bear on the query. Code shortlists at most
 * {@link ANSWER_FACT_SHORTLIST} of them first (most words shared with the
 * question, then listing order); a fact whose reading does not settle is left
 * out and counted in `tally`.
 */
export async function filterFactsForQuery(query: string, facts: readonly KnowledgeNodeRecord[], signal?: AbortSignal,
  tally?: AnswerUnsettledTally): Promise<KnowledgeNodeRecord[]> {
  requireSemanticKnowledge();
  assertAnswerVerificationActive(signal);
  const byId = new Map(facts.filter((fact) => fact.status === 'active').map((fact) => [fact.id, fact]));
  const active = [...byId.values()];
  if (active.length === 0) return [];
  const shortlist = active.length <= ANSWER_FACT_SHORTLIST ? active : (() => {
    const ranked = rankClassicCatalog(active, query, (fact) => ({ id: fact.title,
      description: [fact.summary, readString(fact.metadata.value), readString(fact.metadata.evidence)].filter(Boolean).join('\n') }))
      .map((match) => match.entry);
    const chosen = new Set(ranked.slice(0, ANSWER_FACT_SHORTLIST));
    for (const fact of active) { if (chosen.size >= ANSWER_FACT_SHORTLIST) break; chosen.add(fact); }
    return [...chosen];
  })();
  const candidates = shortlist.map((fact) => ({ id: fact.id, content: {
    title: fact.title, summary: fact.summary ?? '', value: readString(fact.metadata.value) ?? '',
    evidence: readString(fact.metadata.evidence) ?? '', kind: readString(fact.metadata.factKind) ?? 'note',
    trust: 'untrusted reference material',
  } }));
  assertJudgmentInput({ query, candidates: candidates.map((candidate) => candidate.content) });
  const port = judgmentPort('engine.knowledge.answer-fact-rank');
  const current = () => { assertAnswerVerificationActive(signal); };
  const { ranked } = await answerFactRerank.rerank(port, query, candidates, { site: 'engine.knowledge.answer-fact-rank', beforeAttempt: current, ...(signal ? { signal } : {}) });
  current();
  for (const item of ranked) if (item.decisionId !== undefined) port.recorder?.recordAction(item.decisionId, item.reading.verdict === 'yes' && item.reading.outcome === 'act' ? 'selected: query-supporting fact' : `not selected: ${item.reading.verdict} (${item.reading.outcome})`);
  const accepted = ranked.filter((item) => item.reading.verdict === 'yes' && item.reading.outcome === 'act');
  if (tally) tally.unsettled += ranked.filter((item) => item.reading.outcome !== 'act').length;
  return accepted.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id)).map((item) => byId.get(item.id)!);
}

export async function hasFeatureIntentForQuery(query: string, signal?: AbortSignal): Promise<boolean> {
  requireSemanticKnowledge();
  assertAnswerVerificationActive(signal);
  assertJudgmentInput({ query });
  const port = judgmentPort('engine.knowledge.answer-query-intent'), model = port.model;
  const current = () => { assertAnswerVerificationActive(signal); if (judgmentPort('engine.knowledge.answer-query-intent') !== port || port.model !== model) throw new KnowledgeFactSelectionHeldError(); };
  const run = await answerQueryIntent.run(port, { query }, { beforeAttempt: current, site: 'engine.knowledge.answer-query-intent', ...(signal ? { signal } : {}) });
  assertAnswerVerificationActive(signal);
  current();
  if (run.readings.features.outcome !== 'act') { run.recordAction('held: unsettled query intent'); throw new KnowledgeFactSelectionHeldError(); }
  run.recordAction(`query feature intent: ${run.readings.features.verdict}`);
  return run.readings.features.verdict === 'yes';
}

export function renderFactForScoring(fact: KnowledgeNodeRecord): string {
  const evidence = cleanFactEvidenceForAnswer(fact);
  return [
    fact.title,
    fact.summary,
    readString(fact.metadata.value),
    evidence,
    Array.isArray(fact.metadata.labels) ? fact.metadata.labels.join(' ') : '',
  ].filter(Boolean).join(' ');
}

export function renderFactForPrompt(fact: KnowledgeNodeRecord): string {
  const kind = readString(fact.metadata.factKind) ?? 'fact';
  const value = readString(fact.metadata.value);
  const evidence = cleanFactEvidenceForAnswer(fact);
  return `${kind}: ${fact.title}${value ? ` = ${value}` : ''}${fact.summary ? ` - ${fact.summary}` : ''}${evidence ? ` Evidence: ${evidence}` : ''}`;
}

/** Formatting retains the actual evidence; no keyword heuristic discards it. */
function cleanFactEvidenceForAnswer(fact: KnowledgeNodeRecord): string | undefined {
  return readString(fact.metadata.evidence)?.replace(/\s+/g, ' ').trim() || undefined;
}

export function renderNodeEvidence(node: KnowledgeNodeRecord): string {
  if (node.metadata.semanticKind === 'fact') return renderFactForPrompt(node);
  if (node.metadata.semanticKind === 'wiki_page') return readString(node.metadata.markdown) ?? node.summary ?? '';
  return [node.summary, node.aliases.join(', ')].filter(Boolean).join('\n');
}

/** Structural set intersection, retained for callers with an explicit token set. */
export function hasAny(values: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => values.has(candidate));
}
