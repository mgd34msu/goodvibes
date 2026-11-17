import { KnowledgeAnswerExcerptHeldError } from './answer-excerpts/reader.js';
import { projectAnswerFactClaim } from './answer-claim-projection.js';
import type {
  KnowledgeNodeRecord,
} from '../types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeScopeSelection } from '../scope-selection.js';
import { normalizeKnowledgeSpaceId, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace } from '../spaces.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import type {
  KnowledgeSemanticAnswerInput,
  KnowledgeSemanticAnswerResult,
} from './types.js';
import {
  readRecord,
  readString,
  readStringArray,
  uniqueStrings,
} from './utils.js';
import { concreteAnswerGapSpaceId } from './answer-space.js';
import { answerNeedsEvidenceGap, answerConfidence } from './answer-quality.js';
import { prepareAnswerEvidence } from './answer-verification/evidence.js';
import { verifyKnowledgeAnswer, KnowledgeAnswerQualityHeldError, type AnswerCandidate, type KnowledgeAnswerQuality } from './answer-verification/reader.js';
import type { KnowledgeAnswerExcerpt } from './answer-verification/types.js';
import { withAnswerVerificationBudget } from './answer-verification/budget.js';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { KnowledgeEvidenceRelevanceHeldError } from './evidence-ranking/reader.js';
import { prepareAnswerLinkedObjects } from './answer-object-alignment/prepare.js';
import { KnowledgeAnswerObjectAlignmentHeldError } from './answer-object-alignment/reader.js';
import { renderFallbackAnswer } from './answer-fallback.js';
import { rankAnswerSources, KnowledgeSourceRankingHeldError, type AnswerUnsettledTally } from './answer-source-ranking.js';
import {
  type AnswerFactRecord,
  type KnowledgeAnswerContext,
} from './answer-common.js';
import { KnowledgeFactSelectionHeldError } from './answer-fact-selection.js';
import {
  edgesAt,
  readAnswerEvidence,
  readOfficialLinkedEvidence,
  toSearchResult,
  uniqueNodes,
  withAnswerSourceAliases,
  type ExcerptedEvidenceItem,
} from './answer-evidence.js';
import {
  prepareAnswerGapUniverse, type PreparedAnswerGapUniverse,
  isActionableAnswerGap, KnowledgeAnswerGapHeldError,
} from './answer-gaps.js';
import { synthesizeAnswer } from './answer-llm.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

export async function answerKnowledgeQuery(
  context: KnowledgeAnswerContext,
  input: KnowledgeSemanticAnswerInput,
): Promise<KnowledgeSemanticAnswerResult> {
  assertJudgmentInput({ query: input.query });
  if (typeof input.query !== 'string' || !input.query.trim()) throw new KnowledgeAnswerQualityHeldError('malformed');
  try {
    return await withAnswerVerificationBudget((signal, deadlineAt) => answerWithinBudget(context, input, signal, deadlineAt), input.timeoutMs, input.signal);
  } catch (error) {
    if (error instanceof KnowledgeAnswerQualityHeldError || error instanceof JudgmentInputError) throw error;
    if (error instanceof KnowledgeAnswerGapHeldError) throw new KnowledgeAnswerQualityHeldError(error.reason, { cause: error });
    if (error instanceof KnowledgeSourceRankingHeldError || error instanceof KnowledgeFactSelectionHeldError) throw new KnowledgeAnswerQualityHeldError('uncertain', { cause: error });
    if (error instanceof KnowledgeSourceQualityHeldError) throw new KnowledgeAnswerQualityHeldError(error.reason === 'aborted' ? 'aborted' : 'stale', { cause: error });
    if (error instanceof KnowledgeAnswerObjectAlignmentHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'unconfigured' ? 'unavailable' : error.reason, { cause: error });
    if (error instanceof KnowledgeEvidenceRelevanceHeldError || error instanceof KnowledgeAnswerExcerptHeldError) throw new KnowledgeAnswerQualityHeldError(
      error.reason === 'unsettled' ? 'uncertain' : error.reason === 'unconfigured' ? 'unavailable' : error.reason, { cause: error });
    throw new KnowledgeAnswerQualityHeldError('unavailable', { cause: error });
  }
}

/**
 * One answer is a read. The space is read once (the evidence pass's scope
 * selection, reused for linked objects and their sources); nothing is
 * re-listed or watched between steps, so a write elsewhere never fails it.
 * Every per-candidate reading that does not settle leaves its candidate out and
 * is counted in `quality.unsettled`; only the verification of the answer itself
 * can withhold it. Recording a missing answer is the one write, checked
 * against the rows it records and never failing the answer.
 */
async function answerWithinBudget(context: KnowledgeAnswerContext, input: KnowledgeSemanticAnswerInput,
  signal: AbortSignal, deadlineAt: number,
): Promise<KnowledgeSemanticAnswerResult> {
  const check = () => {
    if (signal.aborted) throw new KnowledgeAnswerQualityHeldError('aborted');
    if (Date.now() >= deadlineAt) throw new KnowledgeAnswerQualityHeldError('budget');
  };
  const remaining = () => Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : 0;
  const spaceId = normalizeKnowledgeSpaceId(input.knowledgeSpaceId);
  const mode = input.mode ?? 'standard';
  const limit = Math.max(1, input.limit ?? 8);
  const objectProfiles = context.objectProfiles ?? [];
  const tally: AnswerUnsettledTally = { unsettled: 0 };
  // A caller that may not write records no missing-answer gap (and asks no model about one).
  const gapUniverse = input.recordGaps === false ? undefined : prepareAnswerGapUniverse(context.store, spaceId, input.query, { signal });
  let pass = await readAnswerEvidence(context.store, input, spaceId, limit, objectProfiles, signal, tally);
  check();
  const { selection } = pass.space;
  const objects = input.includeLinkedObjects === false ? undefined
    : prepareAnswerLinkedObjects(context.store, spaceId, input, objectProfiles, signal,
      { nodes: selection.nodes, sources: selection.sources, edges: selection.edges });
  // The objects are read once per answer; a later call returns that reading.
  let objectsCounted = false;
  const readObjects = async (evidence: readonly ExcerptedEvidenceItem[], facts: readonly KnowledgeNodeRecord[]) => {
    const read = await objects?.read(evidence, facts);
    if (read && !objectsCounted) { tally.unsettled += read.unsettled; objectsCounted = true; }
    return read?.linkedObjects ?? [];
  };

  let linkedRead = false;
  if (pass.items.length === 0) {
    const linkedObjects = await readObjects([], []);
    check();
    pass = await readOfficialLinkedEvidence(context.store, pass, linkedObjects, signal, tally);
    linkedRead = true;
    check();
    if (pass.items.length === 0) {
      const gap = await recordGap(gapUniverse, { spaceId: concreteAnswerGapSpaceId(spaceId, [], [], linkedObjects), linkedObjects, noMatch: true },
        'No indexed evidence matched the question.', signal);
      return {
        ok: true, spaceId, query: input.query,
        answer: {
          text: input.noMatchMessage ?? `No knowledge matched "${input.query}".`,
          mode, confidence: 0,
          quality: withReport({ status: 'no-evidence', decisionIds: [] }, tally, []),
          sources: [], linkedObjects, facts: [],
          gaps: gap && isActionableAnswerGap(context.store, gap) ? [gap] : [],
          synthesized: false,
        },
        results: [],
      };
    }
  }

  // The first pass's facts were already read for this question.
  let evidence = pass.items;
  let rawFacts = uniqueNodes(evidence.flatMap((item) => item.facts));
  const linkedObjects = await readObjects(evidence, rawFacts);
  check();
  // The linked sources were already read when the first pass found nothing.
  if (!linkedRead) pass = await readOfficialLinkedEvidence(context.store, pass, linkedObjects, signal, tally);
  evidence = pass.items;
  rawFacts = uniqueNodes(evidence.flatMap((item) => item.facts));
  check();
  const rankedSources = await rankAnswerSources(evidence, rawFacts, input.query, signal, tally);
  check();
  const acceptedSourceIds = new Set(rankedSources.map((source) => source.id));
  evidence = evidence.filter((item) => !item.source || acceptedSourceIds.has(item.source.id));
  rawFacts = rawFacts.filter((fact) => {
    const sources = uniqueStrings([...readStringArray(fact.metadata.sourceIds), readString(fact.metadata.sourceId), fact.sourceId]);
    return sources.length === 0 || sources.some((id) => acceptedSourceIds.has(id));
  });
  const acceptedFactIds = new Set(rawFacts.map((fact) => fact.id));
  evidence = evidence.filter((item) => item.node?.metadata.semanticKind !== 'fact' || acceptedFactIds.has(item.node.id));
  if (evidence.length === 0) return {
    ok: true, spaceId, query: input.query,
    answer: { text: input.noMatchMessage ?? `No source-backed knowledge matched "${input.query}".`, mode, confidence: 0,
      quality: withReport({ status: 'no-evidence', decisionIds: [] }, tally, []), sources: [], linkedObjects: [], facts: [], gaps: [], synthesized: false },
    results: [],
  };
  const facts = withAnswerFactContract(context.store, selection, rawFacts, linkedObjects);
  const sources = rankedSources.slice(0, limit).map(withAnswerSourceAliases);
  const gapSpaceId = concreteAnswerGapSpaceId(spaceId, evidence, sources, linkedObjects);
  const claimSubjects = uniqueNodes([...linkedObjects, ...linkedObjectsFromFacts(context.store, rawFacts)])
    .filter((node) => getKnowledgeSpaceId(node) === spaceId || (spaceId === 'homeassistant' && isHomeAssistantKnowledgeSpace(getKnowledgeSpaceId(node))));
  const prepared = prepareAnswerEvidence({ store: context.store, spaceId, query: input.query, sources: rankedSources.slice(0, limit), facts: rawFacts, subjects: claimSubjects });
  for (const fact of facts) {
    // Returned associations must resolve locally; an unknown/foreign/stale
    // reference cannot disappear from the claim while remaining in metadata.
    const subjectIds = uniqueStrings([...(fact.subjectIds ?? []), ...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds)]);
    if (subjectIds.some((id) => !claimSubjects.some((subject) => subject.id === id))) throw new KnowledgeAnswerQualityHeldError('malformed');
  }
  const candidateClaims = facts.map((fact) => projectAnswerFactClaim(fact, claimSubjects));
  assertJudgmentInput({ query: input.query, facts: candidateClaims });
  const candidateFacts = candidateClaims.map((claim) => JSON.stringify(claim));
  check();
  const generated = prepared.evidence.length ? await synthesizeAnswer(context.llm ?? null, input.query, mode, prepared.evidence,
    { signal, timeoutMs: remaining() }) : null;
  check();
  const rendered = renderFallbackAnswer(input.query, mode, prepared.evidence.map((row) => ({ title: row.title ?? row.reference, excerpt: row.text })), facts);
  const candidates: AnswerCandidate[] = [
    ...(generated ? [{ id: 'generated' as const, text: generated, facts: candidateFacts }] : []),
    ...(rendered.synthesized ? [{ id: 'rendered' as const, text: rendered.text, facts: candidateFacts }] : []),
  ];
  const verification = await verifyKnowledgeAnswer({ query: input.query, evidence: prepared.evidence, candidates },
    { signal, timeoutMs: remaining() });
  check();
  const missingExtraction = verification.quality.status === 'no-evidence';
  const evidenceGap = answerNeedsEvidenceGap(verification.quality) || missingExtraction
    ? await recordGap(gapUniverse, { spaceId: gapSpaceId, sources: rankedSources.slice(0, limit), linkedObjects }, missingExtraction
      ? 'Matching sources have no extracted evidence available for verification.'
      : 'Verified evidence does not establish every requested detail consistently.', signal)
    : null;
  const text = verification.candidate?.text ?? (verification.quality.status === 'no-evidence'
    ? 'Matching sources have no extracted evidence available for a verified answer.'
    : 'I could not verify an answer from the available evidence.');
  const shownSourceIds = new Set(sources.map((source) => source.id));
  const excerpts = evidence.flatMap((item) => item.source && shownSourceIds.has(item.source.id) ? item.excerptSpans ?? [] : [])
    .map(({ sourceId, extractionId, field, start, end }) => ({ sourceId, ...(extractionId ? { extractionId } : {}), field, start, end }));

  return {
    ok: true,
    spaceId,
    query: input.query,
    answer: {
      text,
      mode,
      confidence: input.includeConfidence === false ? 0 : answerConfidence(verification.quality),
      quality: withReport({ ...verification.quality, evidenceReferences: prepared.references }, tally, excerpts),
      sources: input.includeSources === false ? [] : sources,
      linkedObjects,
      facts: verification.candidate ? facts : [],
      gaps: evidenceGap && isActionableAnswerGap(context.store, evidenceGap) ? [evidenceGap] : [],
      synthesized: Boolean(verification.candidate),
    },
    results: evidence.slice(0, limit).map(toSearchResult),
  };
}

/** The quality with every unsettled reading of the answer counted and the quoted passages of its sources. */
function withReport(quality: KnowledgeAnswerQuality, tally: AnswerUnsettledTally,
  excerpts: readonly KnowledgeAnswerExcerpt[]): KnowledgeAnswerQuality {
  const unsettled = tally.unsettled + (quality.unsettled ?? 0);
  return { ...quality, ...(unsettled ? { unsettled } : {}), ...(excerpts.length ? { excerpts } : {}) };
}

/**
 * Records the missing answer. It is bookkeeping about the answer, not part of
 * it: a record that cannot be written (a row it records against changed, the
 * reading failed) is logged and the answer is returned without it. A cancel
 * still cancels.
 */
async function recordGap(universe: PreparedAnswerGapUniverse | undefined, context: Parameters<PreparedAnswerGapUniverse['prepare']>[0],
  reason: string, signal: AbortSignal): Promise<KnowledgeNodeRecord | null> {
  if (!universe) return null;
  try {
    return await (await universe.prepare(context).read()).persist(reason);
  } catch (error) {
    if (signal.aborted) throw new KnowledgeAnswerQualityHeldError('aborted');
    logger.info('Knowledge answer returned without recording its missing-answer gap', { error: summarizeError(error) });
    return null;
  }
}

function withAnswerFactContract(
  store: KnowledgeStore,
  selection: KnowledgeScopeSelection,
  facts: readonly KnowledgeNodeRecord[],
  linkedObjects: readonly KnowledgeNodeRecord[],
): readonly AnswerFactRecord[] {
  if (facts.length === 0) return [];
  const linkedObjectIds = new Set(linkedObjects.map((node) => node.id));
  const result: AnswerFactRecord[] = [];
  for (const fact of facts) {
    const source = fact.sourceId ? store.getSource(fact.sourceId) : null;
    const discovery = readRecord(source && getKnowledgeSpaceId(source) === getKnowledgeSpaceId(fact) ? source.metadata.sourceDiscovery : undefined);
    const metadataLinkedIds = uniqueStrings([
      ...readStringArray(fact.metadata.linkedObjectIds),
      ...readStringArray(fact.metadata.subjectIds),
      ...readStringArray(discovery.linkedObjectIds),
    ]);
    const subjectIds = uniqueStrings([
      ...metadataLinkedIds.filter((id) => linkedObjectIds.has(id)),
      ...factSubjectIdsFromGraph(store, selection, fact, linkedObjects),
    ]);
    const subjects = subjectIds
      .map((id) => linkedObjects.find((node) => node.id === id) ?? store.getNode(id))
      .filter((node): node is KnowledgeNodeRecord => Boolean(node && node.status === 'active' && getKnowledgeSpaceId(node) === getKnowledgeSpaceId(fact)));
    if (subjects.length === 0) {
      result.push(fact as AnswerFactRecord);
      continue;
    }
    const targetHints = answerTargetHints(subjects);
    const metadata = {
      ...fact.metadata,
      subject: readString(fact.metadata.subject) ?? subjects[0]?.title,
      subjectIds: subjects.map((node) => node.id),
      linkedObjectIds: subjects.map((node) => node.id),
      targetHints,
    };
    result.push({
      ...fact,
      metadata,
      subject: metadata.subject as string | undefined,
      subjectIds: metadata.subjectIds as readonly string[],
      linkedObjectIds: metadata.linkedObjectIds as readonly string[],
      targetHints,
    });
  }
  return result;
}

function linkedObjectsFromFacts(
  store: KnowledgeStore,
  facts: readonly KnowledgeNodeRecord[],
): KnowledgeNodeRecord[] {
  return uniqueNodes(facts.flatMap((fact) => {
    const spaceId = getKnowledgeSpaceId(fact);
    const ids = uniqueStrings([...(fact.subjectIds ?? []), ...(fact.linkedObjectIds ?? []),
      ...readStringArray(fact.metadata.linkedObjectIds), ...readStringArray(fact.metadata.subjectIds),
      ...store.edgesFor('node', fact.id).filter((edge) => isActiveKnowledgeEdge(edge) && getKnowledgeSpaceId(edge) === spaceId
        && edge.fromKind === 'node' && edge.fromId === fact.id && edge.toKind === 'node' && edge.relation === 'describes').map((edge) => edge.toId)]);
    return ids.map((id) => store.getNode(id)).filter((node): node is KnowledgeNodeRecord => Boolean(node
      && node.status === 'active' && getKnowledgeSpaceId(node) === spaceId));
  }));
}

/** The linked objects a fact describes, directly or through a source that supports it; read from the answer's edge index. */
function factSubjectIdsFromGraph(
  store: KnowledgeStore,
  selection: KnowledgeScopeSelection,
  fact: KnowledgeNodeRecord,
  linkedObjects: readonly KnowledgeNodeRecord[],
): string[] {
  if (linkedObjects.length === 0) return [];
  const spaceId = getKnowledgeSpaceId(fact);
  const linkedIds = new Set(linkedObjects.filter((node) => node.status === 'active' && getKnowledgeSpaceId(node) === spaceId).map((node) => node.id));
  const inSpace = (edge: { readonly metadata: Record<string, unknown> }) => getKnowledgeSpaceId(edge) === spaceId;
  const directSubjectIds = new Set<string>();
  const sourcesSupportingFact = new Set<string>();
  for (const edge of edgesAt(selection, 'node', fact.id)) {
    if (!inSpace(edge) || !isActiveKnowledgeEdge(edge)) continue;
    if (edge.fromKind === 'node' && edge.fromId === fact.id && edge.toKind === 'node' && linkedIds.has(edge.toId) && edge.relation === 'describes') directSubjectIds.add(edge.toId);
    if (edge.fromKind === 'source' && edge.toKind === 'node' && edge.toId === fact.id && edge.relation === 'supports_fact') sourcesSupportingFact.add(edge.fromId);
  }
  const factSourceId = readString(fact.metadata.sourceId) ?? fact.sourceId;
  const factSource = factSourceId ? store.getSource(factSourceId) : undefined;
  if (factSource && getKnowledgeSpaceId(factSource) === spaceId) sourcesSupportingFact.add(factSource.id);
  for (const sourceId of sourcesSupportingFact) {
    for (const edge of edgesAt(selection, 'source', sourceId)) {
      if (!inSpace(edge) || !isActiveKnowledgeEdge(edge)) continue;
      if (edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node' && linkedIds.has(edge.toId)) directSubjectIds.add(edge.toId);
      if (edge.toKind === 'source' && edge.toId === sourceId && edge.fromKind === 'node' && linkedIds.has(edge.fromId)) directSubjectIds.add(edge.fromId);
    }
  }
  return [...directSubjectIds];
}

function answerTargetHints(nodes: readonly KnowledgeNodeRecord[]): readonly Record<string, unknown>[] {
  return nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(node.summary ? { summary: node.summary } : {}),
  }));
}
