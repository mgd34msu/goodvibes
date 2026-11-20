import { isClassicOperation, withConfiguredDecisionModelPolicy } from '@goodvibes/engine/platform/platform/runtime/decision-policy';
import { rankHarnessCatalog, type CatalogRankingOptions } from './catalog-ranking.js';
import { previewHarnessText } from './preview-text.js';
import { buildLearningCandidates, candidateSearchText } from './learning-curator-proposals.js';
import { localRegistryRoute, MIN_PROMPT_MEMORY_CONFIDENCE, missingRequirementCount, routeValue } from './learning-curator-common.js';
import type { LearningCandidateCollection, LearningCuratorNativeContext } from './learning-curator-source.js';
import type { AgentHarnessLearningCuratorArgs, LearningCandidate, LearningCandidateResolution, LearningConsolidationBatchPlan, LearningPromptPlan } from './learning-curator-types.js';
import { clampReadLimit } from './read-helpers.js';
import { readString } from './tool-args.js';
export type { LearningCandidate, LearningCandidateResolution, LearningConsolidationDiff, LearningConsolidationFields, LearningConsolidationPlan } from './learning-curator-types.js';

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 200);
}

function describeCandidate(candidate: LearningCandidate, includeParameters: boolean, lookup?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(candidate.operationProvenance ? { operationProvenance: candidate.operationProvenance, semanticAssessment: candidate.semanticAssessment } : {}),
    candidateId: candidate.id,
    label: candidate.label,
    domain: candidate.domain,
    recordId: candidate.recordId,
    status: candidate.status,
    priority: candidate.priority,
    reason: previewHarnessText(candidate.reason, includeParameters ? 180 : 96),
    next: previewHarnessText(candidate.next, includeParameters ? 180 : 96),
    scores: candidate.scores,
    ...(candidate.reviewState ? { reviewState: candidate.reviewState } : {}),
    ...(candidate.enabled === undefined ? {} : { enabled: candidate.enabled }),
    ...(candidate.active === undefined ? {} : { active: candidate.active }),
    ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
    ...(candidate.proposalTarget === undefined ? {} : { proposalTarget: candidate.proposalTarget }),
    ...(includeParameters && candidate.proposalFields ? { proposalFields: candidate.proposalFields } : {}),
    ...(candidate.missingRequirements ? { missingRequirements: candidate.missingRequirements } : {}),
    modelRoute: candidate.modelRoute,
    inspectRoute: candidate.inspectRoute,
    ...(candidate.reviewRoute ? { reviewRoute: candidate.reviewRoute } : {}),
    ...(candidate.staleRoute ? { staleRoute: candidate.staleRoute } : {}),
    ...(candidate.createRoute ? { createRoute: candidate.createRoute } : {}),
    ...(candidate.deleteRoute ? { deleteRoute: candidate.deleteRoute } : {}),
    ...(includeParameters && candidate.cleanupRoutes ? { cleanupRoutes: candidate.cleanupRoutes } : {}),
    ...(includeParameters && candidate.rollbackRoutes ? { rollbackRoutes: candidate.rollbackRoutes } : {}),
    ...(includeParameters && candidate.consolidation ? { consolidation: candidate.consolidation } : {}),
    ...(lookup ? { lookup } : {}),
    ...(includeParameters ? {
      routes: {
        inspect: candidate.inspectRoute,
        model: candidate.modelRoute,
        review: candidate.reviewRoute ?? null,
        stale: candidate.staleRoute ?? null,
        preview: candidate.consolidation ? `agent_learning_consolidation mode:"preview" candidateId:"${routeValue(candidate.id)}"` : null,
        stalePhase: candidate.consolidation ? `agent_learning_consolidation mode:"stale" candidateId:"${routeValue(candidate.id)}"` : null,
        deletePhase: candidate.consolidation ? `agent_learning_consolidation mode:"delete" candidateId:"${routeValue(candidate.id)}"` : null,
        create: candidate.createRoute ?? null,
        delete: candidate.deleteRoute ?? null,
      },
      policy: 'Learning curator rows are read-only. VIBE.md personality issues route to the /personas VIBE.md actions (vibe, vibe-create, vibe-import). Duplicate consolidation phases use agent_learning_consolidation under current recorded admission; create, review, promote, enable, schedule, and non-batch local effects require current recorded admission on their owning routes.',
    } : {}),
  };
}

function learningConsolidationBatchPlan(
  candidates: readonly LearningCandidate[],
  includeParameters: boolean,
): LearningConsolidationBatchPlan | undefined {
  const consolidationCandidates = candidates.filter((candidate) => candidate.consolidation !== undefined);
  if (consolidationCandidates.length === 0) return undefined;
  const domainCounts = new Map<string, { candidates: number; duplicateRecords: number }>();
  for (const candidate of consolidationCandidates) {
    const duplicateRecords = candidate.consolidation?.duplicateIds.length ?? 0;
    const current = domainCounts.get(candidate.domain) ?? { candidates: 0, duplicateRecords: 0 };
    current.candidates += 1;
    current.duplicateRecords += duplicateRecords;
    domainCounts.set(candidate.domain, current);
  }
  const domains = [...domainCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, counts]) => ({ domain, ...counts }));
  const topCandidates = consolidationCandidates.slice(0, 8).map((candidate) => {
    const consolidation = candidate.consolidation!;
    return {
      candidateId: candidate.id,
      label: candidate.label,
      domain: candidate.domain,
      survivorId: consolidation.survivorId,
      duplicateCount: consolidation.duplicateIds.length,
      ...(includeParameters ? { duplicateIds: consolidation.duplicateIds } : {}),
      diffFields: consolidation.diffs.map((diff) => diff.field),
      detailRoute: `memory action:"candidate" candidateId:"${routeValue(candidate.id)}"`,
      previewRoute: `agent_learning_consolidation mode:"preview" candidateId:"${routeValue(candidate.id)}"`,
      stalePhaseRoute: `agent_learning_consolidation mode:"stale" candidateId:"${routeValue(candidate.id)}"`,
      deletePhaseRoute: `agent_learning_consolidation mode:"delete" candidateId:"${routeValue(candidate.id)}"`,
      ...(candidate.staleRoute ? { staleRoute: candidate.staleRoute } : {}),
      ...(candidate.deleteRoute ? { deleteRoute: candidate.deleteRoute } : {}),
      ...(includeParameters ? {
        staleRoutes: consolidation.staleRoutes,
        deleteRoutes: consolidation.deleteRoutes,
        rollbackRoutes: consolidation.rollbackRoutes,
      } : {}),
    };
  });
  return {
    status: 'ready',
    candidates: consolidationCandidates.length,
    duplicateRecords: consolidationCandidates.reduce((total, candidate) => total + (candidate.consolidation?.duplicateIds.length ?? 0), 0),
    domains,
    routes: {
      reviewQueue: 'memory action:"curator" query:"consolidation" includeParameters:true',
      candidateDetail: 'memory action:"candidate" candidateId:"<candidateId>"',
      survivorRecord: 'agent_local_registry domain:"<domain>" action:"get" id:"<survivorId>"',
    },
    phases: [
      {
        id: 'inspect',
        label: 'Inspect every duplicate group',
        goal: 'Open the candidate detail and survivor/duplicate records before changing durable context.',
        route: 'memory action:"curator" query:"consolidation" includeParameters:true',
      },
      {
        id: 'stale-duplicates',
        label: 'Stage duplicates as stale',
        goal: 'Mark duplicates stale before deleting them so rollback remains one reviewed route away.',
        route: 'Use each topCandidates[].stalePhaseRoute under current recorded admission.',
      },
      {
        id: 'verify',
        label: 'Verify prompt impact and rollback',
        goal: 'Re-run the curator, check the survivor, and keep rollback routes visible while verifying the result.',
        route: 'memory action:"curator" query:"consolidation" includeParameters:true',
      },
      {
        id: 'delete-after-stale',
        label: 'Delete after verifying the stale phase',
        goal: 'Use delete routes under current recorded admission after verifying that the stale duplicates are no longer needed.',
        route: 'Use each topCandidates[].deletePhaseRoute only after the stale phase has already run.',
      },
    ],
    topCandidates,
    policy: 'This is an ordered review plan. Use agent_learning_consolidation to preview or apply one candidate phase under current recorded admission; low-level Agent-local routes remain visible for inspection and recovery.',
  };
}

function nextActions(candidates: readonly LearningCandidate[]): readonly string[] {
  return candidates
    .filter((candidate) => candidate.status !== 'ready')
    .slice(0, 5)
    .map((candidate) => `${candidate.label}: ${candidate.next}`);
}

function promptPlanCandidate(candidate: LearningCandidate, includeParameters: boolean): Record<string, unknown> {
  return {
    ...(candidate.operationProvenance ? { operationProvenance: candidate.operationProvenance, semanticAssessment: candidate.semanticAssessment } : {}),
    candidateId: candidate.id,
    label: candidate.label,
    domain: candidate.domain,
    status: candidate.status,
    priority: candidate.priority,
    scores: candidate.scores,
    reason: previewHarnessText(candidate.reason, includeParameters ? 160 : 96),
    next: previewHarnessText(candidate.next, includeParameters ? 160 : 96),
    inspectRoute: candidate.inspectRoute,
    ...(candidate.reviewRoute ? { reviewRoute: candidate.reviewRoute } : {}),
    ...(candidate.createRoute ? { createRoute: candidate.createRoute } : {}),
  };
}

function promptRecordEntry(record: LearningCandidateCollection['promptRecords'][number], includeParameters: boolean): Record<string, unknown> {
  const { domain, item, priority, scores } = record;
  return {
    ...(priority === null ? { operationProvenance: 'classic', semanticAssessment: 'not-evaluated' } : {}),
    id: `${domain}:${item.id}`,
    label: item.name,
    domain,
    recordId: item.id,
    priority,
    scores,
    reason: priority === null
      ? 'Native stored review, confidence and enabled/active fields determine existing prompt eligibility; no new semantic grade was produced.'
      : domain === 'memory'
      ? `Memory at confidence ${MIN_PROMPT_MEMORY_CONFIDENCE} or higher that is not stale, contradicted or outside its validity window is eligible for prompt recall.`
      : domain === 'persona'
        ? 'Active persona is eligible for prompt personality context.'
        : 'Enabled, setup-ready behavior is eligible for prompt context.',
    inspectRoute: localRegistryRoute(domain, 'get', item.id),
    ...(includeParameters ? {
      reviewState: item.reviewState,
      confidence: item.confidence ?? null,
      enabled: item.enabled ?? null,
      active: item.active ?? null,
      missingRequirementCount: missingRequirementCount(item),
      tags: item.tags,
    } : {}),
  };
}

function promptEligibleRecords(collection: LearningCandidateCollection, includeParameters: boolean): readonly Record<string, unknown>[] {
  collection.assertCurrent();
  return collection.promptRecords.map(record => promptRecordEntry(record, includeParameters));
}

function learningPromptPlan(collection: LearningCandidateCollection, candidates: readonly LearningCandidate[], includeParameters: boolean): LearningPromptPlan {
  const promptActiveRecords = promptEligibleRecords(collection, includeParameters);
  const reviewFirstCandidates = candidates.filter((candidate) => (
    candidate.status === 'needs-review'
    || candidate.status === 'low-confidence'
    || candidate.status === 'needs-setup'
    || candidate.status === 'needs-consolidation'
  ));
  const proposalCandidates = candidates.filter((candidate) => candidate.status === 'proposal-ready' || candidate.status === 'ready-to-promote');
  const consolidationCandidates = candidates.filter((candidate) => candidate.status === 'needs-consolidation');
  const suppressed = {
    needsReview: candidates.filter((candidate) => candidate.status === 'needs-review').length,
    needsSetup: candidates.filter((candidate) => candidate.status === 'needs-setup').length,
    lowConfidence: candidates.filter((candidate) => candidate.status === 'low-confidence').length,
    personalityIssues: candidates.filter((candidate) => candidate.domain === 'vibe').length,
    needsConsolidation: consolidationCandidates.length,
  };
  const suppressedCount = Object.values(suppressed).reduce((total, count) => total + count, 0);
  const status = promptActiveRecords.length === 0 && candidates.length === 0
    ? 'empty'
    : suppressedCount > 0 || proposalCandidates.length > 0
      ? 'attention'
      : 'ready';
  return {
    status,
    promptActiveCount: promptActiveRecords.length,
    suppressedCount,
    proposalCount: isClassicOperation() ? null : proposalCandidates.length,
    consolidationCount: consolidationCandidates.length,
    promptActiveRecords: promptActiveRecords.slice(0, includeParameters ? 12 : 5),
    reviewFirst: reviewFirstCandidates.slice(0, includeParameters ? 10 : 5).map((candidate) => promptPlanCandidate(candidate, includeParameters)),
    proposalQueue: proposalCandidates.slice(0, includeParameters ? 10 : 5).map((candidate) => promptPlanCandidate(candidate, includeParameters)),
    consolidationQueue: consolidationCandidates.slice(0, includeParameters ? 8 : 3).map((candidate) => promptPlanCandidate(candidate, includeParameters)),
    suppressed,
    orderingRules: [
      `Prompt context is limited to memory at confidence ${MIN_PROMPT_MEMORY_CONFIDENCE} or higher that is not stale, contradicted or outside its validity window, active personas, and enabled setup-ready behavior.`,
      isClassicOperation() ? 'No decision model is in use: this lists native eligibility and review facts with unassessed scores/priority, and duplicates only where records are identical; stable label ordering is not a quality ranking.'
        : 'Current admitted curator readings grade usefulness, freshness, source quality, risk, confidence and priority. Sorting uses the settled priority grade.',
      'Low-confidence, stale, setup-blocked, blocked VIBE.md, and duplicate records stay suppressed until their confidence or enabled/active state is repaired.',
      'Proposals from notes, completed work, completed research, and saved sessions require explicit create or promotion routes before they can guide the assistant.',
    ],
    routes: {
      memoryPosture: 'memory action:"status"',
      curator: 'memory action:"curator" includeParameters:true',
      candidate: 'memory action:"candidate" candidateId:"<candidateId>"',
      consolidation: 'agent_learning_consolidation mode:"preview" candidateId:"<candidateId>"',
    },
    policy: 'This prompt plan is read-only. It explains what can guide the assistant now, what remains suppressed, and which reviewed route should run before any durable memory, skill, routine, persona, or consolidation change.',
  };
}

const CURATE_ROUTE = 'memory action:"curate"';

/** What the stored verdicts cover, and the one route that reads what they do not. */
function curationState(collection: LearningCandidateCollection): Record<string, unknown> {
  if (isClassicOperation()) return {};
  return {
    curation: {
      lastPassAt: collection.lastCurationPassAt === null ? null : new Date(collection.lastCurationPassAt).toISOString(),
      unassessed: collection.unassessed,
      route: CURATE_ROUTE,
      note: collection.unassessed > 0
        ? `${collection.unassessed} record(s), pair(s) or source(s) have not been read by a curation pass in their current form, so their proposals, duplicates and priorities are not shown yet. ${CURATE_ROUTE} reads only those.`
        : 'Proposals, duplicate groups and priorities come from the last curation pass; nothing has changed since.',
    },
  };
}

async function matchingLearningCandidates(collection: LearningCandidateCollection, candidates: readonly LearningCandidate[], query: string) {
  collection.assertCurrent();
  if (!query) return { matches: candidates.map((entry) => ({ entry, judgment: undefined })), judgments: [] };
  const result = await rankHarnessCatalog(candidates, query, (candidate) => ({ id: candidate.id, description: candidateSearchText(candidate), evidence: candidate }),
    'agent.harness.learning-curator', collection.options);
  collection.assertCurrent(); return result;
}

export async function learningCuratorSummary(context: LearningCuratorNativeContext, args: AgentHarnessLearningCuratorArgs, options: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return withConfiguredDecisionModelPolicy(() => ownedLearningCuratorSummary(context, args, options));
}

async function ownedLearningCuratorSummary(context: LearningCuratorNativeContext, args: AgentHarnessLearningCuratorArgs, options: CatalogRankingOptions): Promise<Record<string, unknown>> {
  const includeParameters = args.includeParameters === true;
  const query = readString(args.query);
  const limit = readLimit(args.limit, 100);
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const all = collection.candidates;
  const selected = await matchingLearningCandidates(collection, all, query);
  collection.assertCurrent();
  const filtered = selected.matches;
  options.signal?.throwIfAborted();
  const consolidationBatch = learningConsolidationBatchPlan(all, includeParameters);
  return {
    ...(isClassicOperation() ? { operationProvenance: 'classic', semanticAssessment: 'not-evaluated',
      interpretationNotice: 'No decision model is in use: this shows stored records, mechanical review flags and duplicate groups of records with identical content (compared by code). Proposals, priorities and duplicates in different words are not assessed.' } : {}),
    summary: {
      candidates: all.length,
      needsReview: all.filter((candidate) => candidate.status === 'needs-review').length,
      needsSetup: all.filter((candidate) => candidate.status === 'needs-setup').length,
      needsConsolidation: all.filter((candidate) => candidate.status === 'needs-consolidation').length,
      lowConfidence: all.filter((candidate) => candidate.status === 'low-confidence').length,
      proposedBehavior: isClassicOperation() ? null : all.filter((candidate) => candidate.status === 'proposal-ready').length,
      personalityIssues: all.filter((candidate) => candidate.domain === 'vibe').length,
      readyToPromote: all.filter((candidate) => candidate.status === 'ready-to-promote').length,
      ready: all.filter((candidate) => candidate.status === 'ready').length,
    },
    promptPlan: learningPromptPlan(collection, all, includeParameters),
    candidates: filtered.slice(0, limit).map(({ entry, judgment }) => ({ ...describeCandidate(entry, includeParameters), ...(judgment ? { judgment } : {}) })),
    judgments: selected.judgments,
    ...(consolidationBatch ? { consolidationBatch } : {}),
    returned: Math.min(filtered.length, limit),
    total: all.length,
    nextActions: nextActions(all),
    ...curationState(collection),
    policy: 'Learning curator is read-only. Proposed memory and behavior changes use notes, completed work-plan items, completed research runs, saved sessions, VIBE.md personality health cards, duplicate consolidation, and existing owning capture routes; durable context requires provenance, rollback via stale/delete routes, and current recorded admission for writes or promotion.',
  };
}

export type LearningConsolidationCandidateResolution =
  | { readonly status: 'found'; readonly candidate: LearningCandidate }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Pick<LearningCandidate, 'id' | 'label' | 'status' | 'priority'>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export async function resolveLearningConsolidationCandidate(context: LearningCuratorNativeContext, input: string, options: CatalogRankingOptions = {}): Promise<LearningConsolidationCandidateResolution> {
  return withConfiguredDecisionModelPolicy(() => ownedResolveLearningConsolidationCandidate(context, input, options));
}

async function ownedResolveLearningConsolidationCandidate(context: LearningCuratorNativeContext, input: string, options: CatalogRankingOptions): Promise<LearningConsolidationCandidateResolution> {
  options.signal?.throwIfAborted();
  const lookup = input.trim();
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'candidateId or query is required. Use memory action:"curator" query:"consolidation" to inspect candidate ids.',
    };
  }
  // Without a decision model the consolidation candidates are the identical-content groups code found.
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const candidates = collection.candidates.filter((candidate) => candidate.consolidation !== undefined);
  const normalized = lookup.toLowerCase();
  const exact = candidates.find((candidate) => candidate.id === lookup)
    ?? candidates.find((candidate) => candidate.id.toLowerCase() === normalized);
  if (exact) {
    collection.assertCurrent();
    return { status: 'found', candidate: exact };
  }
  const selected = await matchingLearningCandidates(collection, candidates, lookup);
  const matches = selected.matches;
  collection.assertCurrent();
  options.signal?.throwIfAborted();
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') return { status: 'found', candidate: matches[0]!.entry };
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup,
      candidates: matches.slice(0, 8).map(({ entry: candidate, judgment }) => ({
        judgment,
        id: candidate.id,
        label: candidate.label,
        status: candidate.status,
        priority: candidate.priority,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown duplicate-consolidation candidate ${lookup}. Use memory action:"curator" query:"consolidation" to inspect candidate ids.`
      + (isClassicOperation() ? ' No decision model is in use, so only records with identical content are offered for consolidation.' : ''),
  };
}

export async function describeLearningCandidate(context: LearningCuratorNativeContext, args: AgentHarnessLearningCuratorArgs, options: CatalogRankingOptions = {}): Promise<LearningCandidateResolution> {
  return withConfiguredDecisionModelPolicy(() => ownedDescribeLearningCandidate(context, args, options));
}

async function ownedDescribeLearningCandidate(context: LearningCuratorNativeContext, args: AgentHarnessLearningCuratorArgs, options: CatalogRankingOptions): Promise<LearningCandidateResolution> {
  options.signal?.throwIfAborted();
  const candidateId = readString(args.candidateId);
  const target = readString(args.target);
  const query = readString(args.query);
  const input = candidateId || target || query;
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'memory action:"candidate" requires candidateId, target, or query. Use memory action:"curator" to inspect candidate ids.',
    };
  }
  const normalized = input.toLowerCase();
  const collection = await buildLearningCandidates(context, options); collection.assertCurrent();
  const candidates = collection.candidates;
  const exact = candidates.find((candidate) => candidate.id === input);
  if (exact) return { status: 'found', candidate: describeCandidate(exact, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'id' }) };
  const insensitive = candidates.find((candidate) => candidate.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', candidate: describeCandidate(insensitive, true, { source: candidateId ? 'candidateId' : target ? 'target' : 'query', input, resolvedBy: 'case-insensitive-id' }) };
  const selected = candidateId ? { matches: [], judgments: [] } : await matchingLearningCandidates(collection, candidates, input);
  const matches = selected.matches;
  collection.assertCurrent();
  options.signal?.throwIfAborted();
  if (matches.length === 1 && matches[0]!.judgment?.reading.verdict === 'yes' && matches[0]!.judgment?.reading.outcome === 'act') return { status: 'found', candidate: { ...describeCandidate(matches[0]!.entry, true, { source: target ? 'target' : 'query', input, resolvedBy: 'search' }), judgment: matches[0]!.judgment } };
  if (matches.length > 0) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.slice(0, 8).map(({ entry: candidate, judgment }) => ({
        judgment,
        candidateId: candidate.id,
        label: candidate.label,
        status: candidate.status,
        priority: candidate.priority,
        modelRoute: candidate.modelRoute,
      })),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown learning candidate ${input}. Use memory action:"curator" to inspect candidate ids.`,
  };
}
