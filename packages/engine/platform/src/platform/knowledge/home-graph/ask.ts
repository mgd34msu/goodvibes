import { isClassicOperation } from '../../runtime/decision-policy.js';
import { KNOWLEDGE_WITHOUT_DECISION_MODEL, knowledgeKeywordExcerpt } from '../decision-policy.js';
import { knowledgeTerms } from '../passages.js';
import { factHasUsableSource } from '../semantic/answer-evidence.js';
import { renderNodeEvidence } from '../semantic/answer-fact-selection.js';
import { sourceSemanticText } from '../semantic/utils.js';
import { withKnowledgeSourceAnswerAliases } from '../source-structural-references.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeSemanticAnswerInput } from '../semantic/types.js';
import { bindAnswerCandidateWindow } from '../semantic/answer-candidate-window.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { collectLinkedObjects, renderAskAnswer } from './state.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSearchResult } from './types.js';
import { readHomeGraphSearchState, type HomeGraphSearchState } from './search.js';
import { HOME_GRAPH_ASK_SHORTLIST, readHomeGraphSearchSelection, shortlistHomeGraphCandidates, type HomeGraphSearchSelection } from './search-judgments.js';
import { prepareHomeGraphAnswerScope } from './answer-scope.js';

/**
 * Answers from a selection the caller made with `readHomeGraphSearchSelection`
 * (passed in, never looked up), or, without one, from `results` through the
 * bounded result-scope reader.
 */
export async function answerHomeGraphQuery(input: {
  readonly signal?: AbortSignal | undefined;
  readonly store: KnowledgeStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
  readonly results: readonly HomeGraphSearchResult[];
  readonly selection?: HomeGraphSearchSelection | undefined;
}): Promise<HomeGraphAskResult> {
  if (isClassicOperation()) return answerHomeGraphQueryByKeywords(input);
  const selection = input.selection;
  // A completed retrieval pass already settled literal scope. Direct callers
  // still use the bounded result-scope reader; configured semantic answers keep
  // their own final evidence/fidelity pass with the selected candidate window.
  const scoped = selection ?? (input.semanticService ? undefined : await prepareHomeGraphAnswerScope(input));
  const results = scoped?.results ?? input.results;
  const sources = results.flatMap((result) => result.source ? [result.source] : []).map(withAnswerSourceAliases);
  const linkedObjects = scoped?.linkedObjects ?? collectLinkedObjects(results, input.state);
  const stamp = selection ? { candidates: selection.candidates, readAtRevision: selection.readAtRevision } : {};
  if (input.semanticService) {
    const stillWanted = () => input.signal?.throwIfAborted();
    const semanticInputFor = (current: HomeGraphSearchSelection | undefined): KnowledgeSemanticAnswerInput => {
      const currentResults = current?.results ?? results;
      const semanticInput: KnowledgeSemanticAnswerInput = {
        signal: input.signal,
        query: input.query.query,
        knowledgeSpaceId: input.spaceId,
        mode: input.query.mode ?? 'standard',
        limit: input.query.limit ?? 8,
        includeSources: input.query.includeSources,
        includeConfidence: input.query.includeConfidence,
        includeLinkedObjects: input.query.includeLinkedObjects,
        candidateSourceIds: current?.candidateSourceIds ?? sources.map((source) => source.id),
        candidateNodeIds: currentResults.flatMap((result) => result.node ? [result.node.id] : []),
        strictCandidates: true,
        linkedObjects: current?.linkedObjects ?? linkedObjects,
        noMatchMessage: `No Home Graph knowledge matched "${input.query.query}".`,
        // A read-only ask writes nothing: no gap record, gap repair, web search or fact promotion.
        autoRepairGaps: input.query.readOnly !== true,
        recordGaps: input.query.readOnly !== true,
        timeoutMs: input.query.timeoutMs,
      };
      const chosen = current;
      if (chosen) bindAnswerCandidateWindow(semanticInput, input.store, input.spaceId,
        chosen.candidateSourceIds, currentResults.flatMap((result) => result.node ? [result.id] : []),
        chosen.acceptedFactIds, stillWanted, async () => {
          // A repair added evidence on purpose: read the new corpus for the same
          // question about the same objects (they are not resolved again).
          const next = await readHomeGraphSearchSelection({ store: input.store, spaceId: input.spaceId, query: input.query,
            state: readHomeGraphSearchState(input.store, input.spaceId), linkedObjects: chosen.linkedObjects, signal: input.signal });
          return semanticInputFor(next);
        });
      return semanticInput;
    };
    const answer = await input.semanticService.answer(semanticInputFor(selection));
    return {
      ok: true,
      spaceId: input.spaceId,
      query: input.query.query,
      answer: {
        text: answer.answer.text,
        mode: answer.answer.mode,
        confidence: answer.answer.confidence,
        sources: answer.answer.sources,
        linkedObjects: answer.answer.linkedObjects,
        facts: answer.answer.facts,
        gaps: answer.answer.gaps,
        refinementTaskIds: answer.answer.refinementTaskIds,
        refinement: answer.answer.refinement,
        synthesized: answer.answer.synthesized,
      },
      results: answer.results.map((result) => ({ ...result,
        title: result.source?.title ?? result.node?.title ?? result.id,
        summary: result.source?.summary ?? result.node?.summary,
      })),
      ...stamp,
    };
  }
  // Retrieval points and relevance probabilities do not establish fidelity.
  const confidence = 0;
  return {
    ok: true,
    spaceId: input.spaceId,
    query: input.query.query,
    answer: {
      text: renderAskAnswer(input.query.query, results, input.query.mode ?? 'standard'),
      mode: input.query.mode ?? 'standard',
      confidence,
      sources: input.query.includeSources === false ? [] : sources,
      linkedObjects: input.query.includeLinkedObjects === false ? [] : linkedObjects,
    },
    results,
    ...stamp,
  };
}

/** Home Assistant objects the question names, matched on their titles and aliases, at most this many. */
const KEYWORD_ANSWER_OBJECTS = 8;

/**
 * The answer without a decision model: the records of the home that share
 * words with the question (the objects it names, their facts and documents
 * first), each with the passages of its stored text that mention them. Nothing
 * is read by a model and nothing is written; the text says the matches were not
 * checked.
 */
export function answerHomeGraphQueryByKeywords(input: {
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly query: HomeGraphAskInput;
  readonly state: HomeGraphSearchState;
}): HomeGraphAskResult {
  const { state, query } = input;
  const queryTerms = knowledgeTerms([query.query]);
  const termSet = new Set(queryTerms);
  const mentions = (values: readonly unknown[]) => knowledgeTerms(values).some((term) => termSet.has(term));
  const linkedObjects = state.nodes.filter((node) => node.kind.startsWith('ha_') && mentions([node.title, node.aliases]))
    .slice(0, KEYWORD_ANSWER_OBJECTS);
  const usableSourceIds = new Set(state.sources.filter((source) => source.status === 'indexed').map((source) => source.id));
  const answerNodes = state.nodes.filter((node) => !node.kind.startsWith('ha_') && node.kind !== 'knowledge_gap'
    && node.metadata.semanticKind !== 'gap' && (node.metadata.semanticKind !== 'fact' || factHasUsableSource(node, usableSourceIds)));
  const terms = knowledgeTerms([query.query, ...linkedObjects.map((node) => [node.title, ...node.aliases])]);
  const allTerms = new Set(terms);
  const matches = (values: readonly unknown[]) => knowledgeTerms(values).some((term) => allTerms.has(term));
  const shortlist = shortlistHomeGraphCandidates(state, query.query, linkedObjects, answerNodes, HOME_GRAPH_ASK_SHORTLIST);
  const results: HomeGraphSearchResult[] = [];
  for (const entry of shortlist) {
    if (entry.source) {
      const source = entry.source;
      const extraction = state.extractionBySourceId.get(source.id) ?? null;
      const text = sourceSemanticText(source, extraction);
      if (!matches([source.title, source.tags, text])) continue;
      results.push({ kind: 'source', id: source.id, score: 0, title: source.title ?? source.sourceUri ?? source.id, source,
        summary: extraction?.summary ?? source.summary, excerpt: knowledgeKeywordExcerpt(text, terms) || undefined });
    } else if (entry.node) {
      const node: KnowledgeNodeRecord = entry.node;
      if (!matches([node.title, node.summary, node.aliases, node.metadata.value, node.metadata.factKind])) continue;
      results.push({ kind: 'node', id: node.id, score: 0, title: node.title, node, summary: node.summary, excerpt: renderNodeEvidence(node) });
    }
  }
  const selected = results.slice(0, Math.max(1, query.limit ?? 8));
  const sources = selected.flatMap((result) => result.source ? [withAnswerSourceAliases(result.source)] : []);
  const mode = query.mode ?? 'standard';
  const rendered = renderAskAnswer(query.query, selected, mode);
  return {
    ok: true,
    spaceId: input.spaceId,
    query: query.query,
    answer: {
      text: selected.length === 0 ? `${rendered} (Keyword search; ${KNOWLEDGE_WITHOUT_DECISION_MODEL}.)`
        : `Keyword matches (${KNOWLEDGE_WITHOUT_DECISION_MODEL}):\n${rendered}`,
      mode,
      confidence: 0,
      sources: query.includeSources === false ? [] : sources,
      linkedObjects: query.includeLinkedObjects === false ? [] : linkedObjects,
      facts: selected.flatMap((result) => result.node && (result.node.kind === 'fact' || result.node.metadata.semanticKind === 'fact') ? [result.node] : []),
      synthesized: false,
    },
    results: selected,
    candidates: { total: state.sources.length + answerNodes.length, considered: shortlist.length, unread: 0 },
    readAtRevision: input.store.revisionSource.revision(),
  };
}

function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return withKnowledgeSourceAnswerAliases(source);
}
