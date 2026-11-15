import { requireDecisionFeature } from '../../runtime/decision-policy.js';
import { withKnowledgeSourceAnswerAliases } from '../source-structural-references.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeSemanticAnswerInput } from '../semantic/types.js';
import { bindAnswerCandidateWindow } from '../semantic/answer-candidate-window.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeSourceRecord } from '../types.js';
import { collectLinkedObjects, renderAskAnswer } from './state.js';
import type { HomeGraphAskInput, HomeGraphAskResult, HomeGraphSearchResult } from './types.js';
import { readHomeGraphSearchState, type HomeGraphSearchState } from './search.js';
import { readHomeGraphSearchSelection, type HomeGraphSearchSelection } from './search-judgments.js';
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
  requireDecisionFeature('verified Home Graph answers');
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
        autoRepairGaps: true,
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

function withAnswerSourceAliases(source: KnowledgeSourceRecord): KnowledgeSourceRecord {
  return withKnowledgeSourceAnswerAliases(source);
}
