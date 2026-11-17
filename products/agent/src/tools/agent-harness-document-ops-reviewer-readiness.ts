import { readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { AgentDocumentRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/document-registry';
import { type AgentDocumentRecord } from '@goodvibes-jev/engine/terminal-shell/agent-turn/document-registry-types';
import { hasPurpose, PURPOSE_MODEL_COMPARE_ROUTE_DECISION } from '@goodvibes-jev/engine/terminal-shell/agent-turn/review-packet-presets-core';
import type { ReviewerReadinessCheck, ReviewerReadinessChecklist, ReviewerReadinessStatus } from './agent-harness-document-ops-types.ts';


function readMetadataStringList(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value.split(/[,\n]/).map((entry) => entry.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean);
}

function artifactPurpose(artifact: ArtifactDescriptor): string {
  return readString(artifact.metadata.purpose);
}

function isModelCompareArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-cmp_');
}

function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare-judgment') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-judgment-');
}

function isModelCompareRouteDecisionArtifact(artifact: ArtifactDescriptor): boolean {
  return hasPurpose(artifact, PURPOSE_MODEL_COMPARE_ROUTE_DECISION);
}

function isModelCompareHandoffArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare-handoff') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-handoff-');
}

/** How many artifacts one readiness pass inspects; a store holding more is reported as only partly checked. */
const ARTIFACT_SCAN_LIMIT = 1000;

export interface StoreRead<T> {
  readonly items: readonly T[];
  /** Why the store could not be read in full, when it could not. */
  readonly problem?: string;
}

/** The two stores the document lanes read, each read once per call and shared by every lane. */
export interface DocumentOpsSources {
  readonly documents: StoreRead<AgentDocumentRecord>;
  readonly artifacts: StoreRead<ArtifactDescriptor>;
  /** The artifact store can list at all. */
  readonly artifactsListable: boolean;
}

export function readDocumentOpsSources(context: CommandContext): DocumentOpsSources {
  return { documents: readDocuments(context), artifacts: readArtifacts(context), artifactsListable: Boolean(context.platform.artifactStore?.list) };
}

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDocuments(context: CommandContext): StoreRead<AgentDocumentRecord> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) return { items: [], problem: 'no workspace is active, so no documents were looked up' };
  try {
    return { items: AgentDocumentRegistry.fromShellPaths(shellPaths).list() };
  } catch (error) {
    return { items: [], problem: `the document registry could not be read (${problemText(error)})` };
  }
}

function readArtifacts(context: CommandContext): StoreRead<ArtifactDescriptor> {
  const store = context.platform.artifactStore;
  if (!store?.list) return { items: [] };
  try {
    const listed = store.list(ARTIFACT_SCAN_LIMIT + 1);
    return listed.length > ARTIFACT_SCAN_LIMIT
      ? { items: listed.slice(0, ARTIFACT_SCAN_LIMIT), problem: `only the newest ${ARTIFACT_SCAN_LIMIT} artifacts were checked` }
      : { items: listed };
  } catch (error) {
    return { items: [], problem: `the artifact store could not be read (${problemText(error)})` };
  }
}

/**
 * A check whose evidence was not fully read is never a pass: an unread store
 * says nothing about whether review work is waiting in it.
 */
function withReadProblem<T extends { status: ReviewerReadinessCheck['status']; detail: string }>(check: T, problem: string | undefined): T {
  if (!problem) return check;
  return check.status === 'pass'
    ? { ...check, status: 'attention', detail: `Not verified: ${problem}, so this cannot be reported as clear.` }
    : { ...check, detail: `${check.detail} (Counts may be incomplete: ${problem}.)` };
}

function reviewerReadinessStatus(checks: readonly ReviewerReadinessCheck[]): ReviewerReadinessStatus {
  if (checks.some((check) => check.status === 'needs-setup')) return 'needs-setup';
  if (checks.some((check) => check.status === 'attention')) return 'attention';
  return 'ready';
}

/**
 * The repair for a judgment that hides its winner: reveal the comparison it
 * judged (stored, or still held this session), which names the winner from
 * data the program has. With neither, the route decision is what is left.
 */
function hiddenJudgmentRepairRoute(judgment: Pick<ArtifactDescriptor, 'id' | 'metadata'>): string {
  const sourceArtifactId = readString(judgment.metadata.sourceArtifactId);
  if (sourceArtifactId) return `agent_model_compare reveal artifactId:"${sourceArtifactId}"`;
  const comparisonId = readString(judgment.metadata.comparisonId);
  if (comparisonId) return `agent_model_compare reveal comparisonId:"${comparisonId}"`;
  return `agent_model_compare apply artifactId:"${judgment.id}" or agent_model_compare routeDecision artifactId:"${judgment.id}" decision:"left-unchanged"`;
}

export function buildReviewerReadinessChecklist(
  context: CommandContext,
  options: {
    readonly documentsReady: boolean;
    readonly modelCompareReady: boolean;
    readonly artifactBrowserReady: boolean;
  },
  sources: DocumentOpsSources = readDocumentOpsSources(context),
): ReviewerReadinessChecklist {
  const documentRead = sources.documents;
  const documents = documentRead.items;
  const reviewDocuments = documents.filter((document) => document.status !== 'archived');
  const openComments = reviewDocuments.reduce((total, document) => total + document.comments.filter((comment) => comment.status === 'open').length, 0);
  const proposedSuggestions = reviewDocuments.reduce((total, document) => total + document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length, 0);
  const documentsMissingSourceArtifacts = reviewDocuments.filter((document) => document.attachments.length === 0 && !document.lastArtifactId).length;
  const artifactRead = sources.artifacts;
  const artifacts = artifactRead.items;
  const comparisons = artifacts.filter(isModelCompareArtifact);
  const judgments = artifacts.filter(isModelCompareJudgmentArtifact);
  const routeDecisions = artifacts.filter(isModelCompareRouteDecisionArtifact);
  const handoffs = artifacts.filter(isModelCompareHandoffArtifact);
  const revealedJudgments = judgments.filter((artifact) => (
    artifact.metadata.revealIncludedInJudgment === true
    && readString(artifact.metadata.winnerModel).length > 0
  ));
  const hiddenJudgments = judgments.filter((artifact) => (
    artifact.metadata.revealIncludedInJudgment !== true
    || readString(artifact.metadata.winnerModel).length === 0
  ));
  const routeDecisionComparisonIds = new Set(routeDecisions.map((artifact) => readString(artifact.metadata.comparisonId)).filter(Boolean));
  const routeDecisionJudgmentArtifactIds = new Set(routeDecisions.map((artifact) => readString(artifact.metadata.judgmentArtifactId)).filter(Boolean));
  // apply reads the winner model from the judged comparison, so a blind judgment waits on the same decision.
  const judgmentsWaitingOnRouteDecision = judgments.filter((artifact) => {
    const comparisonId = readString(artifact.metadata.comparisonId);
    return !routeDecisionJudgmentArtifactIds.has(artifact.id) && (!comparisonId || !routeDecisionComparisonIds.has(comparisonId));
  });
  const revealedComparisonIds = new Set(revealedJudgments.map((artifact) => readString(artifact.metadata.comparisonId)).filter(Boolean));
  const unrevealedComparisons = comparisons.filter((artifact) => {
    const comparisonId = readString(artifact.metadata.comparisonId);
    return artifact.metadata.revealIncludedInTranscript !== true && (!comparisonId || !revealedComparisonIds.has(comparisonId));
  });
  const handoffsMissingRelatedArtifacts = handoffs.filter((artifact) => readMetadataStringList(artifact.metadata.relatedArtifactIds).length === 0).length;
  const comparisonSourceMissing = comparisons.filter((artifact) => (
    !readString(artifact.metadata.sourceArtifactId)
    && !readString(artifact.metadata.documentId)
  )).length;
  const missingSourceArtifacts = documentsMissingSourceArtifacts + comparisonSourceMissing;
  const firstOpenCommentDocument = reviewDocuments.find((document) => document.comments.some((comment) => comment.status === 'open'));
  const firstProposedSuggestionDocument = reviewDocuments.find((document) => document.suggestions.some((suggestion) => suggestion.status === 'proposed'));
  const firstUnrevealedComparison = unrevealedComparisons[0];
  const firstHiddenJudgment = hiddenJudgments[0];
  const firstJudgmentWaiting = judgmentsWaitingOnRouteDecision[0];
  const firstHandoffMissingRelated = handoffs.find((artifact) => readMetadataStringList(artifact.metadata.relatedArtifactIds).length === 0);

  const rawChecks: ReviewerReadinessCheck[] = [
    {
      id: 'review-tooling',
      label: 'Review tooling',
      status: options.documentsReady && options.modelCompareReady && options.artifactBrowserReady ? 'pass' : 'needs-setup',
      count: Number(options.documentsReady) + Number(options.modelCompareReady) + Number(options.artifactBrowserReady),
      detail: options.documentsReady && options.modelCompareReady && options.artifactBrowserReady
        ? 'Document, artifact, and blind comparison routes are available.'
        : 'Document, artifact, and blind comparison routes must be available before a reviewer-ready export can be trusted.',
      inspectRoute: 'agent_harness mode:"document_ops"',
      repairRoute: 'agent_harness mode:"workspace_actions" categoryId:"documents"',
    },
    {
      id: 'document-review-state',
      label: 'Document comments and suggestions',
      status: openComments + proposedSuggestions > 0 ? 'attention' : 'pass',
      count: openComments + proposedSuggestions,
      detail: openComments + proposedSuggestions > 0
        ? `${openComments} open comment(s) and ${proposedSuggestions} proposed suggestion(s) need a visible resolve, accept, or reject decision.`
        : 'No open document comments or proposed AI suggestions are waiting on reviewer action.',
      inspectRoute: firstOpenCommentDocument || firstProposedSuggestionDocument
        ? `agent_documents show documentId:"${firstOpenCommentDocument?.id ?? firstProposedSuggestionDocument?.id}" includeVersions:true`
        : 'agent_documents list',
      repairRoute: firstOpenCommentDocument
        ? `agent_documents resolveComment documentId:"${firstOpenCommentDocument.id}" commentId:"..."`
        : firstProposedSuggestionDocument
          ? `agent_documents acceptSuggestion documentId:"${firstProposedSuggestionDocument.id}" suggestionId:"..." or agent_documents rejectSuggestion documentId:"${firstProposedSuggestionDocument.id}" suggestionId:"..."`
          : undefined,
    },
    {
      id: 'source-artifacts',
      label: 'Source artifacts',
      status: missingSourceArtifacts > 0 ? 'attention' : 'pass',
      count: missingSourceArtifacts,
      detail: missingSourceArtifacts > 0
        ? `${documentsMissingSourceArtifacts} document draft(s) and ${comparisonSourceMissing} comparison artifact(s) have no attached source artifact or document source marker.`
        : 'Document drafts and saved comparisons have source artifacts or explicit document/source markers where the current stores can verify them.',
      inspectRoute: 'agent_harness mode:"document_ops_lane" laneId:"artifact_browser"',
      repairRoute: missingSourceArtifacts > 0
        ? 'agent_documents attachArtifact documentId:"..." artifactId:"..." or agent_model_compare handoff artifactId:"..." relatedArtifactIds:"..."'
        : undefined,
    },
    {
      id: 'comparison-reveal',
      label: 'Blind comparison reveal',
      status: unrevealedComparisons.length + hiddenJudgments.length > 0 ? 'attention' : 'pass',
      count: unrevealedComparisons.length + hiddenJudgments.length,
      detail: unrevealedComparisons.length + hiddenJudgments.length > 0
        ? `${unrevealedComparisons.length} saved comparison(s) and ${hiddenJudgments.length} judgment(s) still hide winner identity before reviewer handoff.`
        : 'Saved comparison judgments with route-change implications are revealed, or no hidden comparison artifacts are pending.',
      inspectRoute: firstUnrevealedComparison
        ? `agent_model_compare review artifactId:"${firstUnrevealedComparison.id}"`
        : firstHiddenJudgment
          ? `agent_model_compare review artifactId:"${firstHiddenJudgment.id}"`
          : 'agent_model_compare review',
      // A blind judgment's winner is already known from its stored comparison:
      // reveal that comparison, or decide the route; never judge it again.
      repairRoute: firstUnrevealedComparison
        ? `agent_model_compare reveal artifactId:"${firstUnrevealedComparison.id}"`
        : firstHiddenJudgment
          ? hiddenJudgmentRepairRoute(firstHiddenJudgment)
          : undefined,
    },
    {
      id: 'route-change-decision',
      label: 'Route-change decision',
      status: judgmentsWaitingOnRouteDecision.length > 0 ? 'attention' : 'pass',
      count: judgmentsWaitingOnRouteDecision.length,
      detail: judgmentsWaitingOnRouteDecision.length > 0
        ? `${judgmentsWaitingOnRouteDecision.length} judgment(s) can drive an admitted model route update (a blind one too: apply reads the winner from its comparison), or the user can explicitly leave routing unchanged before archiving.`
        : 'No model comparison judgment is waiting on an apply-or-leave-unchanged decision.',
      inspectRoute: firstJudgmentWaiting
        ? `agent_model_compare review artifactId:"${firstJudgmentWaiting.id}" reveal:true`
        : 'models action:"status"',
      repairRoute: firstJudgmentWaiting
        ? `agent_model_compare apply artifactId:"${firstJudgmentWaiting.id}" or agent_model_compare routeDecision artifactId:"${firstJudgmentWaiting.id}" decision:"left-unchanged"`
        : undefined,
    },
    {
      id: 'handoff-archive-evidence',
      label: 'Reviewer handoff evidence',
      status: handoffsMissingRelatedArtifacts > 0 ? 'attention' : 'pass',
      count: handoffsMissingRelatedArtifacts,
      detail: handoffsMissingRelatedArtifacts > 0
        ? `${handoffsMissingRelatedArtifacts} reviewer handoff artifact(s) have no related evidence artifact ids before archive.`
        : 'Reviewer handoff artifacts include related evidence ids, or no reviewer handoff archive is pending.',
      inspectRoute: firstHandoffMissingRelated
        ? `agent_model_compare review artifactId:"${firstHandoffMissingRelated.id}"`
        : 'agent_model_compare review',
      repairRoute: firstHandoffMissingRelated
        ? `agent_model_compare handoff artifactId:"${readString(firstHandoffMissingRelated.metadata.sourceArtifactId) || firstHandoffMissingRelated.id}" relatedArtifactIds:"..."`
        : undefined,
    },
  ];
  const sourceProblem = [documentRead.problem, artifactRead.problem].filter((entry): entry is string => entry !== undefined).join('; ') || undefined;
  const problemFor = (id: string): string | undefined => {
    if (id === 'document-review-state') return documentRead.problem;
    if (id === 'source-artifacts') return sourceProblem;
    if (id === 'comparison-reveal' || id === 'route-change-decision' || id === 'handoff-archive-evidence') return artifactRead.problem;
    return undefined;
  };
  const checks = rawChecks.map((check) => withReadProblem(check, problemFor(check.id)));
  const readProblems = [documentRead.problem, artifactRead.problem].filter((entry): entry is string => entry !== undefined);
  const status = reviewerReadinessStatus(checks);
  const firstAction = checks.find((check) => check.status === 'attention' || check.status === 'needs-setup');
  return {
    status,
    next: firstAction
      ? `${firstAction.label}: ${firstAction.detail}`
      : 'Export or archive reviewer packets through the returned document, artifact, or comparison routes after recorded effect admission.',
    summary: {
      documents: documents.length,
      openComments,
      proposedSuggestions,
      documentsMissingSourceArtifacts,
      savedComparisons: comparisons.length,
      unrevealedComparisons: unrevealedComparisons.length,
      hiddenJudgments: hiddenJudgments.length,
      revealedJudgments: revealedJudgments.length,
      judgmentsAwaitingRouteDecision: judgmentsWaitingOnRouteDecision.length,
      handoffsMissingRelatedArtifacts,
    },
    ...(readProblems.length > 0 ? { readProblems } : {}),
    checks,
    policy: 'Reviewer readiness is read-only. It flags unresolved review work and returns exact existing routes; document exports, comparison handoffs, archives, and model route updates require their own current recorded effect admission.',
  };
}
