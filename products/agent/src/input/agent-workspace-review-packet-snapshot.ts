import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { CommandContext } from './command-registry.ts';
import { AgentDocumentRegistry } from '@goodvibes/engine/terminal-shell/agent-turn/document-registry';
import { type AgentDocumentRecord } from '@goodvibes/engine/terminal-shell/agent-turn/document-registry-types';
import type { AgentWorkspaceReviewPacketDefaults, AgentWorkspaceReviewPacketTimeline, AgentWorkspaceReviewPacketTimelineEvent, AgentWorkspaceReviewPacketWizard, AgentWorkspaceReviewPacketWizardStep, AgentWorkspaceReviewPacketWizardStepStatus } from './agent-workspace-types.ts';
import { readArtifactMetadataNumber, readArtifactMetadataString, readArtifactMetadataStringList } from './agent-workspace-artifact-metadata.ts';
import { AGENT_WORKSPACE_CATEGORIES } from './agent-workspace-categories.ts';
import { buildReviewPacketPresetLineage, compactTimelineText, isDocumentExportArtifact, isModelCompareArtifact, isModelCompareExportArtifact, isModelCompareJudgmentArtifact, isModelCompareRouteDecisionArtifact, isReviewerHandoffArchiveArtifact, isReviewerHandoffArtifact, isReviewPacketPresetArtifact, isoToEpoch, reviewPacketPresetFreshness, uniqueStrings } from './agent-workspace-review-packet-utils.ts';

export function readDocumentDrafts(context: CommandContext, failures?: Map<string, string>): readonly AgentDocumentRecord[] {
  try {
    const shellPaths = context.workspace?.shellPaths;
    if (!shellPaths) return [];
    return AgentDocumentRegistry.fromShellPaths(shellPaths).list();
  } catch (error) {
    failures?.set('documents', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/** What the artifact list could not show: a truncated window, and a way to look single ids up outside it. */
export interface ReviewPacketArtifactListInfo {
  readonly truncated?: boolean;
  readonly resolveArtifact?: (artifactId: string) => ArtifactDescriptor | null;
}

/** The documents page as the workspace labels it, read from the category table. */
function documentsPage(): string {
  return AGENT_WORKSPACE_CATEGORIES.find((category) => category.id === 'documents')?.label ?? 'Documents';
}

const TRUNCATED_NOTE = 'Unverified: the artifact list shows only the newest artifacts, so older reviewer evidence was not checked.';

export function buildReviewPacketTimeline(
  documents: readonly AgentDocumentRecord[],
  artifacts: readonly ArtifactDescriptor[],
  artifactListAvailable: boolean,
  listInfo: ReviewPacketArtifactListInfo = {},
): AgentWorkspaceReviewPacketTimeline {
  const events: AgentWorkspaceReviewPacketTimelineEvent[] = [];
  for (const document of documents) {
    const openComments = document.comments.filter((comment) => comment.status === 'open').length;
    const proposedSuggestions = document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length;
    events.push({
      id: `document:${document.id}`,
      kind: 'document',
      at: isoToEpoch(document.updatedAt),
      label: `Document ${document.status}: ${document.title}`,
      detail: `${document.versionCount} version(s), ${openComments} open comment(s), ${proposedSuggestions} proposed suggestion(s), ${document.attachments.length} attachment(s), last artifact ${document.lastArtifactId ?? 'none'}`,
      status: openComments + proposedSuggestions > 0 ? 'attention' : document.status === 'reviewed' ? 'ready' : 'info',
      route: `agent_documents show documentId:"${document.id}" includeVersions:true`,
      sourceId: document.id,
    });
    for (const comment of document.comments) {
      events.push({
        id: `comment:${document.id}:${comment.id}`,
        kind: 'comment',
        at: isoToEpoch(comment.resolvedAt ?? comment.updatedAt ?? comment.createdAt),
        label: `${comment.status === 'open' ? 'Open' : 'Resolved'} comment: ${document.title}`,
        detail: compactTimelineText(comment.body),
        status: comment.status === 'open' ? 'attention' : 'complete',
        route: comment.status === 'open'
          ? `agent_documents resolveComment documentId:"${document.id}" commentId:"${comment.id}" confirm:true`
          : `agent_documents show documentId:"${document.id}" includeVersions:true`,
        sourceId: comment.id,
      });
    }
    for (const suggestion of document.suggestions) {
      events.push({
        id: `suggestion:${document.id}:${suggestion.id}`,
        kind: 'suggestion',
        at: isoToEpoch(suggestion.resolvedAt ?? suggestion.updatedAt ?? suggestion.createdAt),
        label: `${suggestion.status === 'proposed' ? 'Proposed' : suggestion.status === 'accepted' ? 'Accepted' : 'Rejected'} suggestion: ${suggestion.title}`,
        detail: compactTimelineText(`${document.title}: ${suggestion.summary}`),
        status: suggestion.status === 'proposed' ? 'attention' : 'complete',
        route: suggestion.status === 'proposed'
          ? `agent_documents acceptSuggestion documentId:"${document.id}" suggestionId:"${suggestion.id}" confirm:true or agent_documents rejectSuggestion documentId:"${document.id}" suggestionId:"${suggestion.id}" confirm:true`
          : `agent_documents show documentId:"${document.id}" includeVersions:true`,
        sourceId: suggestion.id,
      });
    }
    for (const attachment of document.attachments) {
      events.push({
        id: `attachment:${document.id}:${attachment.id}`,
        kind: 'attachment',
        at: isoToEpoch(attachment.updatedAt ?? attachment.createdAt),
        label: `Attached artifact: ${attachment.label}`,
        detail: `${document.title}: ${attachment.artifactId}${attachment.note ? ` - ${compactTimelineText(attachment.note, 64)}` : ''}`,
        status: 'complete',
        route: `agent_artifacts mode:"show" artifactId:"${attachment.artifactId}"`,
        sourceId: attachment.artifactId,
      });
    }
  }

  const decidedJudgmentIds = new Set(artifacts.filter(isModelCompareRouteDecisionArtifact)
    .map((artifact) => readArtifactMetadataString(artifact.metadata, 'judgmentArtifactId')).filter(Boolean));
  for (const artifact of artifacts) {
    const metadata = artifact.metadata;
    if (isDocumentExportArtifact(artifact)) {
      const documentId = readArtifactMetadataString(metadata, 'documentId') || 'unknown-document';
      const versionId = readArtifactMetadataString(metadata, 'versionId') || 'unknown-version';
      events.push({
        id: `document-export:${artifact.id}`,
        kind: 'document-export',
        at: artifact.createdAt,
        label: `Document export: ${documentId}`,
        detail: `version ${versionId}; artifact ${artifact.id}`,
        status: 'complete',
        route: `agent_artifacts mode:"show" artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || artifact.id;
      const completed = readArtifactMetadataNumber(metadata, 'completedCandidates');
      const candidates = readArtifactMetadataNumber(metadata, 'candidateCount');
      const source = readArtifactMetadataString(metadata, 'sourceArtifactId') || readArtifactMetadataString(metadata, 'documentId') || 'none';
      const revealed = metadata.revealIncludedInTranscript === true;
      events.push({
        id: `compare:${artifact.id}`,
        kind: 'compare',
        at: artifact.createdAt,
        label: `Blind compare ${revealed ? 'revealed' : 'hidden'}: ${comparisonId}`,
        detail: `${completed ?? '?'}/${candidates ?? '?'} candidate(s) complete; source ${source}`,
        status: revealed ? 'ready' : 'attention',
        route: revealed ? `agent_model_compare review artifactId:"${artifact.id}" reveal:true` : `agent_model_compare reveal artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareJudgmentArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const winnerBlindId = readArtifactMetadataString(metadata, 'winnerBlindId') || 'unknown-winner';
      const winnerModel = readArtifactMetadataString(metadata, 'winnerModel');
      const revealed = metadata.revealIncludedInJudgment === true && winnerModel.length > 0;
      const decided = decidedJudgmentIds.has(artifact.id);
      events.push({
        id: `judgment:${artifact.id}`,
        kind: 'judgment',
        at: artifact.createdAt,
        label: `Comparison judgment ${revealed ? 'revealed' : 'hidden'}: ${comparisonId}`,
        detail: decided
          ? `winner ${winnerModel}; route decision recorded`
          : revealed ? `winner ${winnerModel}; blind slot ${winnerBlindId}` : `winner blind slot ${winnerBlindId}; reveal needed before route decisions`,
        status: decided ? 'complete' : 'attention',
        route: revealed
          ? `agent_model_compare apply artifactId:"${artifact.id}" confirm:true`
          : `agent_model_compare review artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareRouteDecisionArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const decisionId = readArtifactMetadataString(metadata, 'decisionId') || artifact.id;
      const decision = readArtifactMetadataString(metadata, 'decision') || 'unknown-decision';
      const judgmentArtifactId = readArtifactMetadataString(metadata, 'judgmentArtifactId') || 'unknown-judgment';
      const selectedModel = readArtifactMetadataString(metadata, 'selectedModel') || readArtifactMetadataString(metadata, 'currentModel') || 'unknown-model';
      events.push({
        id: `route-decision:${artifact.id}`,
        kind: 'route-decision',
        at: artifact.createdAt,
        label: `Route decision: ${decisionId}`,
        detail: `${comparisonId}; ${decision}; judgment ${judgmentArtifactId}; selected ${selectedModel}`,
        status: 'complete',
        route: `agent_artifacts mode:"show" artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isReviewPacketPresetArtifact(artifact)) {
      const name = readArtifactMetadataString(metadata, 'name') || artifact.filename || artifact.id;
      const summary = readArtifactMetadataString(metadata, 'summary') || 'review packet preset';
      const freshness = reviewPacketPresetFreshness(artifact, artifacts, listInfo.resolveArtifact);
      const sourceArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId')
        || readArtifactMetadataString(metadata, 'judgmentArtifactId')
        || readArtifactMetadataString(metadata, 'comparisonArtifactId')
        || readArtifactMetadataString(metadata, 'documentExportArtifactId')
        || 'none';
      const handoffArtifactId = readArtifactMetadataString(metadata, 'handoffArtifactId') || 'none';
      const relatedCount = readArtifactMetadataStringList(metadata, 'relatedArtifactIds').length;
      events.push({
        id: `packet-preset:${artifact.id}`,
        kind: 'packet-preset',
        at: artifact.createdAt,
        label: `Packet preset: ${name}`,
        detail: `${compactTimelineText(summary, 72)}; source ${sourceArtifactId}; handoff ${handoffArtifactId}; ${relatedCount} related artifact(s); ${freshness.summary}`,
        status: freshness.status,
        route: `agent_review_packet_presets show artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isModelCompareExportArtifact(artifact)) {
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const sourceKind = readArtifactMetadataString(metadata, 'sourceKind') || 'unknown';
      events.push({
        id: `compare-export:${artifact.id}`,
        kind: 'compare-export',
        at: artifact.createdAt,
        label: `Compare report: ${comparisonId}`,
        detail: `${sourceKind} report artifact ${artifact.id}`,
        status: 'complete',
        route: `agent_artifacts mode:"show" artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isReviewerHandoffArtifact(artifact)) {
      const handoffId = readArtifactMetadataString(metadata, 'handoffId') || artifact.id;
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const sourceKind = readArtifactMetadataString(metadata, 'sourceKind') || 'unknown';
      const relatedCount = readArtifactMetadataStringList(metadata, 'relatedArtifactIds').length;
      events.push({
        id: `handoff:${artifact.id}`,
        kind: 'handoff',
        at: artifact.createdAt,
        label: `Reviewer handoff: ${handoffId}`,
        detail: `${comparisonId}; source ${sourceKind}; ${relatedCount} related artifact(s)`,
        status: relatedCount > 0 ? 'ready' : 'attention',
        route: relatedCount > 0
          ? `agent_model_compare handoffDiff leftArtifactId:"${artifact.id}"`
          : `agent_model_compare handoff artifactId:"${readArtifactMetadataString(metadata, 'sourceArtifactId') || artifact.id}" confirm:true`,
        sourceId: artifact.id,
      });
      continue;
    }
    if (isReviewerHandoffArchiveArtifact(artifact)) {
      const archiveId = readArtifactMetadataString(metadata, 'archiveId') || artifact.id;
      const comparisonId = readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison';
      const artifactCount = readArtifactMetadataNumber(metadata, 'artifactCount');
      events.push({
        id: `handoff-archive:${artifact.id}`,
        kind: 'handoff-archive',
        at: artifact.createdAt,
        label: `Handoff archive: ${archiveId}`,
        detail: `${comparisonId}; ${artifactCount ?? '?'} artifact(s) packaged`,
        status: 'complete',
        route: `agent_artifacts mode:"show" artifactId:"${artifact.id}"`,
        sourceId: artifact.id,
      });
    }
  }

  const ordered = events
    .filter((event) => Number.isFinite(event.at))
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
  const attention = ordered.find((event) => event.status === 'attention');
  return {
    available: artifactListAvailable,
    count: ordered.length,
    next: !artifactListAvailable
      ? 'Artifact listing is unavailable; timeline shows document-local events only.'
      : attention
        ? `${attention.label}: ${attention.detail}`
        : listInfo.truncated
          ? `Review packet timeline shows the newest artifacts only. ${TRUNCATED_NOTE}`
          : ordered.length > 0
            ? 'Review packet timeline is clear; export, handoff, archive, or route decisions can use the visible readiness checks.'
            : 'Create or attach a document, source artifact, comparison, judgment, handoff, or archive to start a review packet timeline.',
    items: ordered.slice(0, 8),
  };
}

/**
 * The packet's document: the one the saved packet preset names when it still
 * exists, otherwise the most recently updated unarchived draft.
 */
function packetDocument(documents: readonly AgentDocumentRecord[], preset: ArtifactDescriptor | null): AgentDocumentRecord | null {
  const live = documents.filter((document) => document.status !== 'archived');
  const presetDocumentId = preset ? readArtifactMetadataString(preset.metadata, 'documentId') : '';
  const named = presetDocumentId ? live.find((document) => document.id === presetDocumentId) : undefined;
  if (named) return named;
  return [...live].sort((left, right) => isoToEpoch(right.updatedAt) - isoToEpoch(left.updatedAt) || left.id.localeCompare(right.id))[0] ?? null;
}

export function buildReviewPacketDefaults(
  documents: readonly AgentDocumentRecord[],
  artifacts: readonly ArtifactDescriptor[],
): AgentWorkspaceReviewPacketDefaults {
  const latestPresetArtifact = artifacts.filter(isReviewPacketPresetArtifact).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  const latestDocument = packetDocument(documents, latestPresetArtifact);
  // The packet's export and comparison are the ones recorded against its
  // document; an export or comparison of another document is not this packet's.
  const documentArtifactIds = new Set<string>(latestDocument
    ? [latestDocument.lastArtifactId ?? '', ...latestDocument.attachments.map((attachment) => attachment.artifactId)].filter(Boolean)
    : []);
  const latestDocumentExport = latestDocument
    ? artifacts.filter((artifact) => isDocumentExportArtifact(artifact) && readArtifactMetadataString(artifact.metadata, 'documentId') === latestDocument.id)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
    : null;
  if (latestDocumentExport) documentArtifactIds.add(latestDocumentExport.id);
  const latestComparison = artifacts.filter((artifact) => isModelCompareArtifact(artifact) && (
    !latestDocument
    || readArtifactMetadataString(artifact.metadata, 'documentId') === latestDocument.id
    || documentArtifactIds.has(readArtifactMetadataString(artifact.metadata, 'sourceArtifactId'))
  )).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  // Every later step of the packet is taken from the newest comparison's own chain.
  // Picking the newest of each kind separately mixes artifacts of unrelated comparisons.
  const comparisonId = readArtifactMetadataString(latestComparison?.metadata ?? {}, 'comparisonId');
  // No comparison means no chain: an empty id selects nothing, never every artifact.
  const inComparison = (artifact: ArtifactDescriptor): boolean => (
    comparisonId.length > 0 && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId
  );
  const newest = (matches: (artifact: ArtifactDescriptor) => boolean): ArtifactDescriptor | null => (
    artifacts.filter((artifact) => matches(artifact) && inComparison(artifact)).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
  const latestJudgment = newest(isModelCompareJudgmentArtifact);
  const latestRevealedJudgment = newest((artifact) => (
    isModelCompareJudgmentArtifact(artifact)
    && artifact.metadata.revealIncludedInJudgment === true
    && readArtifactMetadataString(artifact.metadata, 'winnerModel').length > 0
  ));
  const latestHandoff = newest(isReviewerHandoffArtifact);
  const latestHandoffArchive = newest(isReviewerHandoffArchiveArtifact);
  const latestPreset = latestPresetArtifact;
  const presetMetadata = latestPreset?.metadata ?? {};
  // A route decision only means something against the revealed judgment it names.
  const revealedComparisonId = readArtifactMetadataString(latestRevealedJudgment?.metadata ?? {}, 'comparisonId');
  const latestRouteDecision = latestRevealedJudgment
    ? artifacts
      .filter((artifact) => isModelCompareRouteDecisionArtifact(artifact) && (
        readArtifactMetadataString(artifact.metadata, 'judgmentArtifactId') === latestRevealedJudgment.id
        || (revealedComparisonId.length > 0 && readArtifactMetadataString(artifact.metadata, 'comparisonId') === revealedComparisonId)
      ))
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
    : null;
  // The saved preset fills gaps only when it belongs to the same comparison; otherwise its
  // judgment, handoff and route would be attached to a comparison they never covered.
  const presetComparisonArtifactId = readArtifactMetadataString(presetMetadata, 'comparisonArtifactId');
  // With no comparison recorded, the preset's chain is used only when the preset names its own comparison:
  // an absent comparison selects nothing.
  const presetFitsComparison = latestComparison ? presetComparisonArtifactId === latestComparison.id : presetComparisonArtifactId.length > 0;
  const chainPreset = (key: string): string => (presetFitsComparison ? readArtifactMetadataString(presetMetadata, key) : '');
  const liveRelatedArtifactIds = uniqueStrings([
    latestDocumentExport?.id,
    latestDocument?.lastArtifactId,
    ...(latestDocument?.attachments.map((attachment) => attachment.artifactId) ?? []),
    readArtifactMetadataString(latestComparison?.metadata ?? {}, 'sourceArtifactId'),
    ...readArtifactMetadataStringList(latestHandoff?.metadata ?? {}, 'relatedArtifactIds'),
  ], 8);
  const presetRelatedArtifactIds = readArtifactMetadataStringList(presetMetadata, 'relatedArtifactIds').slice(0, 8);
  const relatedArtifactIds = liveRelatedArtifactIds.length > 0 ? liveRelatedArtifactIds : presetRelatedArtifactIds;
  const documentId = (latestDocument?.id ?? readArtifactMetadataString(presetMetadata, 'documentId')) || null;
  const documentTitle = (latestDocument?.title ?? readArtifactMetadataString(presetMetadata, 'documentTitle')) || null;
  const documentExportArtifactId = (latestDocumentExport?.id ?? readArtifactMetadataString(presetMetadata, 'documentExportArtifactId')) || null;
  const comparisonArtifactId = (latestComparison?.id ?? readArtifactMetadataString(presetMetadata, 'comparisonArtifactId')) || null;
  const judgmentArtifactId = (latestJudgment?.id ?? chainPreset('judgmentArtifactId')) || null;
  const revealedJudgmentArtifactId = (latestRevealedJudgment?.id ?? chainPreset('revealedJudgmentArtifactId')) || null;
  const routeDecisionArtifactId = (latestRouteDecision?.id ?? chainPreset('routeDecisionArtifactId')) || null;
  const routeDecision = latestRouteDecision
    ? readArtifactMetadataString(latestRouteDecision.metadata, 'decision') || null
    : chainPreset('routeDecision') || null;
  const handoffArtifactId = (latestHandoff?.id ?? chainPreset('handoffArtifactId')) || null;
  const handoffArchiveArtifactId = (latestHandoffArchive?.id ?? chainPreset('handoffArchiveArtifactId')) || null;
  const sourceArtifactId = revealedJudgmentArtifactId ?? judgmentArtifactId ?? comparisonArtifactId ?? null;
  const reviewPacketPresetName = readArtifactMetadataString(presetMetadata, 'name') || null;
  const reviewPacketPresetLineage = buildReviewPacketPresetLineage(latestPreset);
  const summary = [
    documentId ? `document ${documentId}` : '',
    sourceArtifactId ? `source ${sourceArtifactId}` : '',
    documentId && !comparisonArtifactId ? 'no comparison yet' : '',
    handoffArtifactId ? `handoff ${handoffArtifactId}` : '',
    relatedArtifactIds.length > 0 ? `${relatedArtifactIds.length} related` : '',
    latestPreset ? `preset ${latestPreset.id}` : '',
  ].filter(Boolean).join('; ') || 'no packet defaults yet';
  return {
    documentId,
    documentTitle,
    documentExportArtifactId,
    comparisonArtifactId,
    judgmentArtifactId,
    revealedJudgmentArtifactId,
    routeDecisionArtifactId,
    routeDecision,
    handoffArtifactId,
    handoffArchiveArtifactId,
    reviewPacketPresetArtifactId: latestPreset?.id ?? null,
    reviewPacketPresetName,
    reviewPacketPresetLineage,
    relatedArtifactIds,
    summary,
  };
}

function packetStepStatus(done: boolean, priorDone: boolean): AgentWorkspaceReviewPacketWizardStepStatus {
  if (done) return 'done';
  return priorDone ? 'current' : 'blocked';
}

function buildReviewPacketWizardStep(input: {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceReviewPacketWizardStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly actionId: string;
  readonly backtrackRoute?: string | null;
  readonly ownerLine: string;
}): AgentWorkspaceReviewPacketWizardStep {
  return {
    id: input.id,
    label: input.label,
    status: input.status,
    detail: input.detail,
    userRoute: input.userRoute,
    modelRoute: input.modelRoute,
    actionId: input.actionId,
    backtrackRoute: input.backtrackRoute ?? (input.status === 'done' ? input.modelRoute : null),
    ownerLine: input.ownerLine,
  };
}

export function buildReviewPacketWizard(
  documents: readonly AgentDocumentRecord[],
  artifactListAvailable: boolean,
  defaults: AgentWorkspaceReviewPacketDefaults,
  listInfo: ReviewPacketArtifactListInfo = {},
): AgentWorkspaceReviewPacketWizard {
  // The wizard works on the packet's document (the one the defaults chose), so
  // its steps describe one document and the artifacts recorded against it.
  const latestDocument = documents.find((document) => document.id === defaults.documentId) ?? null;
  const openComments = latestDocument?.comments.filter((comment) => comment.status === 'open').length ?? 0;
  const proposedSuggestions = latestDocument?.suggestions.filter((suggestion) => suggestion.status === 'proposed').length ?? 0;
  // Reviewed means the owner marked this revision reviewed (an edit puts it back to draft)
  // and nothing is still open on it; a draft with no comments is not reviewed.
  const documentReviewed = Boolean(latestDocument && latestDocument.status === 'reviewed' && openComments === 0 && proposedSuggestions === 0);
  const documentExported = Boolean(defaults.documentExportArtifactId || latestDocument?.lastArtifactId);
  const judgmentReady = Boolean(defaults.revealedJudgmentArtifactId);
  const handoffReady = Boolean(defaults.handoffArtifactId && defaults.relatedArtifactIds.length > 0);
  const archiveReady = Boolean(defaults.handoffArchiveArtifactId);
  // Only a recorded route decision is one; an archive existing does not decide the route.
  const routeDecisionDone = Boolean(defaults.routeDecisionArtifactId);
  const presetLineage = defaults.reviewPacketPresetLineage;
  const finalArchiveReview = archiveReady
    ? [
      `Inspect final archive ${defaults.handoffArchiveArtifactId}.`,
      presetLineage?.refreshed
        ? `Verify refreshed preset lineage: ${presetLineage.summary}.`
        : presetLineage
          ? `Preset lineage: ${presetLineage.summary}.`
          : 'No saved packet preset lineage is attached.',
      `Use ${documentsPage()} -> Share review packet only after the user confirms the delivery target.`,
    ].join(' ')
    : 'Final evidence review stays pending until a reviewer handoff ZIP archive exists.';
  const documentRoute = latestDocument
    ? `agent_documents show documentId:"${latestDocument.id}" includeVersions:true`
    : 'agent_documents list';
  const firstOpenComment = latestDocument?.comments.find((comment) => comment.status === 'open');
  const firstProposedSuggestion = latestDocument?.suggestions.find((suggestion) => suggestion.status === 'proposed');
  const judgmentForDecision = defaults.revealedJudgmentArtifactId ?? defaults.judgmentArtifactId;
  const steps: AgentWorkspaceReviewPacketWizardStep[] = [];
  steps.push(buildReviewPacketWizardStep({
    id: 'draft-review',
    label: 'Draft review',
    status: documentReviewed ? 'done' : 'current',
    detail: latestDocument
      ? documentReviewed
        ? `${latestDocument.title} is marked reviewed at its current revision, with no open comments or proposed suggestions.`
        : openComments > 0 || proposedSuggestions > 0
          ? `${latestDocument.title} has ${openComments} open comment(s) and ${proposedSuggestions} proposed suggestion(s) to resolve before export.`
          : `${latestDocument.title} is not marked reviewed at its current revision; mark it reviewed before export.`
      : 'Create or select a document draft before building a reviewer packet.',
    userRoute: latestDocument ? `${documentsPage()} -> Show document draft` : `${documentsPage()} -> Create document draft`,
    modelRoute: latestDocument
      ? documentRoute
      : 'agent_harness mode:"workspace_action" actionId:"document-create-draft"',
    actionId: latestDocument ? 'document-show-draft' : 'document-create-draft',
    ownerLine: !latestDocument
      ? '/documents create --title <title> <text>'
      : firstOpenComment
        ? `/documents resolve-comment ${latestDocument.id} ${firstOpenComment.id}`
        : firstProposedSuggestion
          ? `/documents accept-suggestion ${latestDocument.id} ${firstProposedSuggestion.id} (or reject-suggestion)`
          : `/documents mark-reviewed ${latestDocument.id}`,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'document-export',
    label: 'Document export',
    status: packetStepStatus(documentExported, documentReviewed),
    detail: documentExported
      ? `Document evidence is exported as ${defaults.documentExportArtifactId ?? latestDocument?.lastArtifactId}.`
      : documentReviewed
        ? 'Export the reviewed draft as a saved artifact for comparison and handoff evidence.'
        : 'Resolve draft review items before exporting reviewer evidence.',
    userRoute: `${documentsPage()} -> Export document artifact`,
    modelRoute: latestDocument
      ? `agent_documents export documentId:"${latestDocument.id}" confirm:true`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-draft"',
    actionId: 'document-export-draft',
    ownerLine: latestDocument ? `/documents export ${latestDocument.id}` : '/documents export <draft>',
    backtrackRoute: defaults.documentExportArtifactId
      ? `agent_artifacts mode:"show" artifactId:"${defaults.documentExportArtifactId}"`
      : null,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'compare-judgment',
    label: 'Compare judgment',
    status: packetStepStatus(judgmentReady, documentExported),
    detail: judgmentReady
      ? `Revealed judgment ${defaults.revealedJudgmentArtifactId} is ready for route review.`
      : defaults.judgmentArtifactId
        ? `Judgment ${defaults.judgmentArtifactId} exists, but winner identity is not revealed for route decisions.`
        : defaults.comparisonArtifactId
          ? `Comparison ${defaults.comparisonArtifactId} is available; save or reveal a judgment before handoff.`
          : documentExported
            ? 'Run a blind comparison from the exported document evidence, then save a revealed judgment.'
            : 'Export document evidence before comparing models.',
    userRoute: defaults.comparisonArtifactId ? `${documentsPage()} -> Review saved compare` : `${documentsPage()} -> Run blind compare`,
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare review artifactId:"${defaults.revealedJudgmentArtifactId}" reveal:true`
      : defaults.judgmentArtifactId
        ? `agent_model_compare review artifactId:"${defaults.judgmentArtifactId}"`
        : defaults.comparisonArtifactId
          ? `agent_model_compare review artifactId:"${defaults.comparisonArtifactId}"`
          : 'agent_harness mode:"workspace_action" actionId:"document-run-compare"',
    actionId: defaults.comparisonArtifactId ? 'document-review-compare' : 'document-run-compare',
    ownerLine: defaults.comparisonArtifactId
      ? `/compare judge ${defaults.comparisonArtifactId} <winner> <why> --reveal`
      : `/compare run${defaults.documentExportArtifactId ? ` --source ${defaults.documentExportArtifactId}` : ''}${latestDocument ? ` --document ${latestDocument.id}` : ''} <prompt>`,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'reviewer-handoff',
    label: 'Reviewer handoff',
    status: packetStepStatus(handoffReady, judgmentReady),
    detail: handoffReady
      ? `Reviewer handoff ${defaults.handoffArtifactId} includes ${defaults.relatedArtifactIds.length} related evidence artifact(s).`
      : judgmentReady
        ? 'Create a reviewer handoff from the revealed judgment and related document/export evidence.'
        : 'Save a revealed comparison judgment before creating reviewer handoff evidence.',
    userRoute: `${documentsPage()} -> Export compare report`,
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare handoff artifactId:"${defaults.revealedJudgmentArtifactId}" relatedArtifactIds:${JSON.stringify(defaults.relatedArtifactIds)} confirm:true`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-compare"',
    actionId: 'document-export-compare',
    ownerLine: `/compare export ${defaults.revealedJudgmentArtifactId ?? '<judgment>'} --as handoff --related ${defaults.relatedArtifactIds.length > 0 ? defaults.relatedArtifactIds.join(',') : '<artifacts>'}`,
    backtrackRoute: defaults.handoffArtifactId
      ? `agent_artifacts mode:"show" artifactId:"${defaults.handoffArtifactId}"`
      : null,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'route-decision',
    label: 'Route decision',
    status: routeDecisionDone ? 'done' : handoffReady ? 'current' : judgmentReady ? 'pending' : 'blocked',
    detail: routeDecisionDone
      ? defaults.routeDecisionArtifactId
        ? `Route decision ${defaults.routeDecisionArtifactId} records ${defaults.routeDecision ?? 'a saved decision'}.`
        : 'Final packet evidence exists; route-decision review has been carried to archive/final review.'
      : handoffReady
        ? 'Apply the revealed winner or explicitly leave the current model unchanged before final archive review.'
        : judgmentReady
          ? 'Create reviewer handoff evidence before applying or leaving the revealed winning route.'
          : 'A revealed judgment is required before deciding whether to update the selected model route.',
    userRoute: `${documentsPage()} -> Apply compare winner or Record route decision`,
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare apply artifactId:"${defaults.revealedJudgmentArtifactId}" confirm:true or agent_model_compare routeDecision artifactId:"${defaults.revealedJudgmentArtifactId}" decision:"left-unchanged" confirm:true`
      : 'agent_harness mode:"workspace_action" actionId:"document-apply-compare"',
    actionId: 'document-apply-compare',
    ownerLine: `/compare apply ${judgmentForDecision ?? '<judgment>'} (or record-decision to keep the model)`,
    backtrackRoute: defaults.routeDecisionArtifactId
      ? `agent_artifacts mode:"show" artifactId:"${defaults.routeDecisionArtifactId}"`
      : null,
  }));
  steps.push(buildReviewPacketWizardStep({
    id: 'final-archive-review',
    label: 'Final archive review',
    status: archiveReady ? 'done' : routeDecisionDone && handoffReady ? 'current' : handoffReady ? 'pending' : 'blocked',
    detail: archiveReady
      ? `Reviewer packet archive ${defaults.handoffArchiveArtifactId} is ready for final evidence review.`
      : handoffReady
        ? 'Archive the reviewer handoff as one ZIP artifact after route-decision review.'
        : 'Create a reviewer handoff with related evidence before archiving the packet.',
    userRoute: `${documentsPage()} -> Export compare report`,
    modelRoute: defaults.handoffArtifactId
      ? `agent_model_compare handoffArchive artifactId:"${defaults.handoffArtifactId}" confirm:true`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-compare"',
    actionId: 'document-export-compare',
    ownerLine: archiveReady
      ? `/documents share-packet ${defaults.handoffArchiveArtifactId} channel|route|webhook --to <where>`
      : `/compare export ${defaults.handoffArtifactId ?? '<handoff>'} --as archive`,
    backtrackRoute: defaults.handoffArchiveArtifactId
      ? `agent_artifacts mode:"show" artifactId:"${defaults.handoffArchiveArtifactId}"`
      : null,
  }));
  const completedSteps = steps.filter((step) => step.status === 'done').length;
  const current = steps.find((step) => step.status === 'current') ?? steps.find((step) => step.status === 'pending') ?? null;
  const status = !artifactListAvailable && steps.length > 0
    ? 'blocked'
    : completedSteps === steps.length
      ? 'complete'
      : latestDocument
        ? 'active'
        : 'empty';
  return {
    available: artifactListAvailable,
    status,
    completedSteps,
    totalSteps: steps.length,
    currentStepId: current?.id ?? null,
    currentStepLabel: current?.label ?? null,
    next: `${listInfo.truncated ? `${TRUNCATED_NOTE} ` : ''}${current
      ? `${current.label}: ${current.detail}`
      : 'Review packet wizard is complete; inspect the final archive and saved packet evidence.'}`,
    finalReview: finalArchiveReview,
    presetLineage,
    steps,
  };
}
