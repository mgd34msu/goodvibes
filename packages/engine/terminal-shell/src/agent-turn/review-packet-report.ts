/**
 * The review packet of your drafts, computed from the stores themselves (the project's document drafts and the
 * saved artifacts): its timeline, its defaults, its steps and what still stands in the way of review. The daemon
 * reports it (capabilities/builtin/documents.ts: documents.readiness, packet-steps, timeline); the Agent workspace
 * shows the same packet from the same functions.
 */
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { AgentDocumentRecord } from './document-registry-types.js';
import { readString } from './tool-args.js';
import {
  buildReviewPacketPresetLineage, compactTimelineText, isDocumentExportArtifact, isModelCompareArtifact, isModelCompareExportArtifact,
  isModelCompareJudgmentArtifact, isModelCompareRouteDecisionArtifact, isoToEpoch, isReviewerHandoffArchiveArtifact, isReviewerHandoffArtifact,
  isReviewPacketPresetArtifact, readArtifactMetadataNumber, readArtifactMetadataString, readArtifactMetadataStringList, reviewPacketPresetFreshness,
  uniqueStrings,
  type AgentWorkspaceReviewPacketDefaults, type AgentWorkspaceReviewPacketTimeline, type AgentWorkspaceReviewPacketTimelineEvent,
  type AgentWorkspaceReviewPacketWizard, type AgentWorkspaceReviewPacketWizardStep, type AgentWorkspaceReviewPacketWizardStepStatus,
} from './review-packet-utils.js';

/** What the artifact list could not show: a truncated window, and a way to look single ids up outside it. */
export interface ReviewPacketArtifactListInfo {
  readonly truncated?: boolean | undefined;
  readonly resolveArtifact?: ((artifactId: string) => ArtifactDescriptor | null) | undefined;
  /** How the screen showing the drafts is named in a step's route ("Documents & Files" in the Agent workspace). */
  readonly documentsPage?: string | undefined;
}

const DOCUMENTS_PAGE = 'Documents & Files';
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
  readonly actionId: string | null;
  readonly backtrackRoute?: string | null | undefined;
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
  const page = listInfo.documentsPage ?? DOCUMENTS_PAGE;
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
      `Use ${page} -> Share review packet only after the user confirms the delivery target.`,
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
    userRoute: latestDocument ? `${page} -> Show document draft` : `${page} -> Create document draft`,
    modelRoute: latestDocument
      ? documentRoute
      : 'agent_harness mode:"workspace_action" actionId:"document-create-draft"',
    actionId: latestDocument ? 'document-show-draft' : 'document-create-draft',
    ownerLine: !latestDocument
      ? 'write a new draft (Memory and knowledge, Drafts)'
      : firstOpenComment
        ? `resolve comment ${firstOpenComment.id} on draft ${latestDocument.id} (Memory and knowledge, Drafts)`
        : firstProposedSuggestion
          ? `take or leave suggestion ${firstProposedSuggestion.id} on draft ${latestDocument.id} (Memory and knowledge, Drafts)`
          : `mark draft ${latestDocument.id} reviewed (Memory and knowledge, Drafts)`,
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
    userRoute: `${page} -> Export document artifact`,
    modelRoute: latestDocument
      ? `agent_documents export documentId:"${latestDocument.id}" confirm:true`
      : 'agent_harness mode:"workspace_action" actionId:"document-export-draft"',
    actionId: 'document-export-draft',
    ownerLine: latestDocument ? `save draft ${latestDocument.id} as an artifact (Memory and knowledge, Drafts)` : 'save a draft as an artifact (Memory and knowledge, Drafts)',
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
    userRoute: 'Models and providers -> Comparisons',
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare review artifactId:"${defaults.revealedJudgmentArtifactId}" reveal:true`
      : defaults.judgmentArtifactId
        ? `agent_model_compare review artifactId:"${defaults.judgmentArtifactId}"`
        : defaults.comparisonArtifactId
          ? `agent_model_compare review artifactId:"${defaults.comparisonArtifactId}"`
          : 'capability_run compare.run',
    // The comparison steps' controls are in Models and providers, Comparisons (no workspace row runs them).
    actionId: null,
    ownerLine: defaults.comparisonArtifactId
      ? `judge comparison ${defaults.comparisonArtifactId}, with the model names shown (Models and providers, Comparisons)`
      : `compare models on a prompt${defaults.documentExportArtifactId ? `, source artifact ${defaults.documentExportArtifactId}` : ''}${latestDocument ? `, for draft ${latestDocument.id}` : ''} (Models and providers, Comparisons)`,
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
    userRoute: 'Models and providers -> Comparisons',
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare handoff artifactId:"${defaults.revealedJudgmentArtifactId}" relatedArtifactIds:${JSON.stringify(defaults.relatedArtifactIds)} confirm:true`
      : 'capability_run compare.export',
    actionId: null,
    ownerLine: `save a reviewer handoff from ${defaults.revealedJudgmentArtifactId ? `judgment ${defaults.revealedJudgmentArtifactId}` : 'the judgment'}${defaults.relatedArtifactIds.length > 0 ? ` with ${defaults.relatedArtifactIds.join(', ')}` : ''} (Models and providers, Comparisons)`,
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
    userRoute: 'Models and providers -> Comparisons',
    modelRoute: defaults.revealedJudgmentArtifactId
      ? `agent_model_compare apply artifactId:"${defaults.revealedJudgmentArtifactId}" confirm:true or agent_model_compare routeDecision artifactId:"${defaults.revealedJudgmentArtifactId}" decision:"left-unchanged" confirm:true`
      : 'capability_run compare.apply or compare.record-decision',
    actionId: null,
    ownerLine: `switch to the winner of ${judgmentForDecision ? `judgment ${judgmentForDecision}` : 'the judgment'}, or keep the model and record why (Models and providers, Comparisons)`,
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
    userRoute: 'Models and providers -> Comparisons',
    modelRoute: defaults.handoffArtifactId
      ? `agent_model_compare handoffArchive artifactId:"${defaults.handoffArtifactId}" confirm:true`
      : 'capability_run compare.export',
    actionId: null,
    ownerLine: archiveReady
      ? `send artifact ${defaults.handoffArchiveArtifactId} as a review packet (Memory and knowledge, Artifacts)`
      : `save a ZIP of ${defaults.handoffArtifactId ? `handoff ${defaults.handoffArtifactId}` : 'the handoff'} (Models and providers, Comparisons)`,
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

// ---------------------------------------------------------------------------
// Reviewer readiness: what still stands in the way of review
// ---------------------------------------------------------------------------

export type ReviewerReadinessStatus = 'ready' | 'attention' | 'needs-setup';

export interface ReviewerReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'pass' | 'attention' | 'needs-setup';
  readonly count: number;
  readonly detail: string;
  readonly inspectRoute: string;
  readonly repairRoute?: string | undefined;
  /** What a person does to settle it, in a place's words; absent when nothing waits on them. */
  readonly ownerLine?: string | undefined;
}

export interface ReviewerReadinessChecklist {
  readonly status: ReviewerReadinessStatus;
  readonly next: string;
  readonly summary: {
    readonly documents: number;
    readonly openComments: number;
    readonly proposedSuggestions: number;
    readonly documentsMissingSourceArtifacts: number;
    readonly savedComparisons: number;
    readonly unrevealedComparisons: number;
    readonly hiddenJudgments: number;
    readonly revealedJudgments: number;
    readonly judgmentsAwaitingRouteDecision: number;
    readonly handoffsMissingRelatedArtifacts: number;
  };
  readonly readProblems?: readonly string[] | undefined;
  readonly checks: readonly ReviewerReadinessCheck[];
  readonly policy: string;
}

export interface StoreRead<T> {
  readonly items: readonly T[];
  /** Why the store could not be read in full, when it could not. */
  readonly problem?: string | undefined;
}

/** The two stores the review packet is read from, each read once per call and shared by every report. */
export interface DocumentOpsSources {
  readonly documents: StoreRead<AgentDocumentRecord>;
  readonly artifacts: StoreRead<ArtifactDescriptor>;
  /** The artifact store can list at all. */
  readonly artifactsListable: boolean;
}

/** How many artifacts one readiness pass inspects; a store holding more is reported as only partly checked. */
export const ARTIFACT_SCAN_LIMIT = 1000;

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The drafts of a project, read once; no project means none were looked up, and why. */
export function readPacketDocuments(list: (() => readonly AgentDocumentRecord[]) | undefined): StoreRead<AgentDocumentRecord> {
  if (!list) return { items: [], problem: 'no workspace is active, so no documents were looked up' };
  try {
    return { items: list() };
  } catch (error) {
    return { items: [], problem: `the document registry could not be read (${problemText(error)})` };
  }
}

/** The newest saved artifacts, up to the scan limit, read once. */
export function readPacketArtifacts(store: { list?: ((limit?: number) => ArtifactDescriptor[]) | undefined } | undefined): StoreRead<ArtifactDescriptor> {
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

/** Readiness reads an artifact's part by its purpose, or for an older artifact with none, by its file name. */
function isCompare(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-cmp_');
}

function isJudgment(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare-judgment') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-judgment-');
}

function isHandoff(artifact: ArtifactDescriptor): boolean {
  const purpose = artifactPurpose(artifact);
  if (purpose === 'agent-model-compare-handoff') return true;
  if (purpose) return false;
  return readString(artifact.filename).startsWith('blind-model-comparison-handoff-');
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
  options: {
    readonly documentsReady: boolean;
    readonly modelCompareReady: boolean;
    readonly artifactBrowserReady: boolean;
  },
  sources: DocumentOpsSources,
): ReviewerReadinessChecklist {
  const documentRead = sources.documents;
  const documents = documentRead.items;
  const reviewDocuments = documents.filter((document) => document.status !== 'archived');
  const openComments = reviewDocuments.reduce((total, document) => total + document.comments.filter((comment) => comment.status === 'open').length, 0);
  const proposedSuggestions = reviewDocuments.reduce((total, document) => total + document.suggestions.filter((suggestion) => suggestion.status === 'proposed').length, 0);
  const documentsMissingSourceArtifacts = reviewDocuments.filter((document) => document.attachments.length === 0 && !document.lastArtifactId).length;
  const artifactRead = sources.artifacts;
  const artifacts = artifactRead.items;
  const comparisons = artifacts.filter(isCompare);
  const judgments = artifacts.filter(isJudgment);
  const routeDecisions = artifacts.filter(isModelCompareRouteDecisionArtifact);
  const handoffs = artifacts.filter(isHandoff);
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
  const firstOpenComment = firstOpenCommentDocument?.comments.find((comment) => comment.status === 'open');
  const firstProposedSuggestion = firstProposedSuggestionDocument?.suggestions.find((suggestion) => suggestion.status === 'proposed');
  const firstDocumentMissingSource = reviewDocuments.find((document) => document.attachments.length === 0 && !document.lastArtifactId);
  const firstComparisonMissingSource = comparisons.find((artifact) => !readString(artifact.metadata.sourceArtifactId) && !readString(artifact.metadata.documentId));
  // The comparison a hidden judgment judged: judging it again with the names shown reveals the winner.
  const hiddenJudgmentComparison = firstHiddenJudgment ? readString(firstHiddenJudgment.metadata.sourceArtifactId) : '';
  const allReady = options.documentsReady && options.modelCompareReady && options.artifactBrowserReady;

  const rawChecks: ReviewerReadinessCheck[] = [
    {
      id: 'review-tooling',
      label: 'Review tooling',
      status: allReady ? 'pass' : 'needs-setup',
      count: Number(options.documentsReady) + Number(options.modelCompareReady) + Number(options.artifactBrowserReady),
      detail: allReady
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
      ...(firstOpenCommentDocument
        ? { repairRoute: `agent_documents resolveComment documentId:"${firstOpenCommentDocument.id}" commentId:"..."` }
        : firstProposedSuggestionDocument
          ? { repairRoute: `agent_documents acceptSuggestion documentId:"${firstProposedSuggestionDocument.id}" suggestionId:"..." or agent_documents rejectSuggestion documentId:"${firstProposedSuggestionDocument.id}" suggestionId:"..."` }
          : {}),
      ...(firstOpenCommentDocument && firstOpenComment
        ? { ownerLine: `resolve comment ${firstOpenComment.id} on draft ${firstOpenCommentDocument.id} (Memory and knowledge, Drafts)` }
        : firstProposedSuggestionDocument && firstProposedSuggestion
          ? { ownerLine: `take or leave suggestion ${firstProposedSuggestion.id} on draft ${firstProposedSuggestionDocument.id} (Memory and knowledge, Drafts)` }
          : {}),
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
      ...(missingSourceArtifacts > 0
        ? { repairRoute: 'agent_documents attachArtifact documentId:"..." artifactId:"..." or agent_model_compare handoff artifactId:"..." relatedArtifactIds:"..."' }
        : {}),
      ...(firstDocumentMissingSource
        ? { ownerLine: `attach an artifact to draft ${firstDocumentMissingSource.id} (Memory and knowledge, Drafts)` }
        : firstComparisonMissingSource
          ? { ownerLine: `save a reviewer handoff from comparison ${firstComparisonMissingSource.id} with its related artifacts (Models and providers, Comparisons)` }
          : {}),
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
      ...(firstUnrevealedComparison
        ? { repairRoute: `agent_model_compare reveal artifactId:"${firstUnrevealedComparison.id}"` }
        : firstHiddenJudgment
          ? { repairRoute: hiddenJudgmentRepairRoute(firstHiddenJudgment) }
          : {}),
      ...(firstUnrevealedComparison
        ? { ownerLine: `judge comparison ${firstUnrevealedComparison.id}, with the model names shown (Models and providers, Comparisons)` }
        : hiddenJudgmentComparison
          ? { ownerLine: `judge comparison ${hiddenJudgmentComparison}, with the model names shown (Models and providers, Comparisons)` }
          : firstHiddenJudgment
            ? { ownerLine: `switch to the winner of judgment ${firstHiddenJudgment.id}, or keep the model and record why (Models and providers, Comparisons)` }
            : {}),
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
      ...(firstJudgmentWaiting
        ? {
          repairRoute: `agent_model_compare apply artifactId:"${firstJudgmentWaiting.id}" or agent_model_compare routeDecision artifactId:"${firstJudgmentWaiting.id}" decision:"left-unchanged"`,
          ownerLine: `switch to the winner of judgment ${firstJudgmentWaiting.id}, or keep the model and record why (Models and providers, Comparisons)`,
        }
        : {}),
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
      ...(firstHandoffMissingRelated
        ? {
          repairRoute: `agent_model_compare handoff artifactId:"${readString(firstHandoffMissingRelated.metadata.sourceArtifactId) || firstHandoffMissingRelated.id}" relatedArtifactIds:"..."`,
          ownerLine: `save a reviewer handoff from ${readString(firstHandoffMissingRelated.metadata.sourceArtifactId) || firstHandoffMissingRelated.id} with its related artifacts (Models and providers, Comparisons)`,
        }
        : {}),
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

// ---------------------------------------------------------------------------
// The packet in plain words (documents.readiness, packet-steps, timeline)
// ---------------------------------------------------------------------------

/** The whole packet of a project, from its drafts and the saved artifacts, each read once. */
export function reviewPacketOf(sources: DocumentOpsSources, listInfo: ReviewPacketArtifactListInfo = {}): {
  readonly readiness: ReviewerReadinessChecklist;
  readonly wizard: AgentWorkspaceReviewPacketWizard;
  readonly timeline: AgentWorkspaceReviewPacketTimeline;
} {
  const documents = sources.documents.items;
  const artifacts = sources.artifacts.items;
  const truncated = sources.artifacts.problem?.startsWith('only the newest') === true;
  const available = sources.artifactsListable && (sources.artifacts.problem === undefined || truncated);
  const info: ReviewPacketArtifactListInfo = { ...listInfo, truncated: listInfo.truncated ?? truncated };
  const defaults = buildReviewPacketDefaults(documents, artifacts);
  return {
    readiness: buildReviewerReadinessChecklist({
      documentsReady: sources.documents.problem === undefined,
      modelCompareReady: sources.artifactsListable,
      artifactBrowserReady: available,
    }, sources),
    wizard: buildReviewPacketWizard(documents, available, defaults, info),
    timeline: buildReviewPacketTimeline(documents, artifacts, available, info),
  };
}

const CHECK_WORD: Readonly<Record<ReviewerReadinessCheck['status'], string>> = {
  pass: 'clear',
  attention: 'to settle',
  'needs-setup': 'needs setting up',
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What still stands in the way of review, each with the line that settles it. */
export function formatReviewReadiness(readiness: ReviewerReadinessChecklist | undefined): string {
  if (!readiness) return 'Review readiness could not be read.';
  const open = readiness.checks.filter((check) => check.status !== 'pass');
  const clear = readiness.checks.filter((check) => check.status === 'pass');
  const lines = [open.length === 0
    ? 'Ready for review: nothing stands in the way.'
    : `Not ready for review: ${plural(open.length, 'thing')} to settle first.`];
  for (const check of open) {
    lines.push(`  ${check.label} (${CHECK_WORD[check.status]}): ${check.detail}`);
    if (check.ownerLine) lines.push(`    Fix: ${check.ownerLine}`);
  }
  if (clear.length > 0) lines.push(`  Clear: ${clear.map((check) => check.label).join(', ')}.`);
  for (const problem of readiness.readProblems ?? []) lines.push(`  Not fully read: ${problem}.`);
  return lines.join('\n');
}

function stepLine(step: AgentWorkspaceReviewPacketWizardStep, index: number, current: string | null): string[] {
  const head = `  ${index + 1}. ${step.label}`;
  if (step.status === 'done') return [`${head}: done. ${step.detail}`];
  if (step.status === 'blocked') return [`${head}: waits for the step before it.`];
  if (step.status === 'pending') return [`${head}: after ${current ?? 'the current step'}. ${step.detail}`];
  return [`${head}: now. ${step.detail}`, `     ${step.ownerLine}`];
}

/** The packet's steps in order, which are done, and the line for the next one. */
export function formatReviewPacketSteps(wizard: AgentWorkspaceReviewPacketWizard | undefined): string {
  if (!wizard) return 'The review packet steps could not be read.';
  const lines = [wizard.status === 'complete'
    ? `Review packet: all ${wizard.totalSteps} steps done.`
    : `Review packet: ${wizard.completedSteps} of ${wizard.totalSteps} steps done${wizard.currentStepLabel ? `; next is ${wizard.currentStepLabel}` : ''}.`];
  if (!wizard.available) lines.push('  Your saved artifacts could not be read, so steps that depend on them are shown as waiting.');
  wizard.steps.forEach((step, index) => lines.push(...stepLine(step, index, wizard.currentStepLabel)));
  const last = wizard.steps.at(-1);
  if (wizard.status === 'complete' && last) lines.push(`  To send it: ${last.ownerLine}`);
  return lines.join('\n');
}

function when(at: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'unknown time    ';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** What happened to the packet, oldest first and dated. */
export function formatReviewPacketTimeline(timeline: AgentWorkspaceReviewPacketTimeline | undefined): string {
  if (!timeline) return 'The review packet timeline could not be read.';
  if (!timeline.available && timeline.items.length === 0) return `No timeline: your saved artifacts could not be read. ${timeline.next}`;
  if (timeline.items.length === 0) return 'Nothing has happened to a review packet yet: no draft, comment, export, comparison or handoff.';
  const items = [...timeline.items].sort((left, right) => left.at - right.at);
  const lines = [`Review packet timeline, oldest first (${plural(timeline.count, 'event')}${timeline.count > items.length ? `, the latest ${items.length} shown` : ''}):`];
  for (const item of items) {
    const detail = item.detail && item.detail !== item.label ? `: ${item.detail}` : '';
    lines.push(`  ${when(item.at)}  ${item.label}${detail}${item.status === 'attention' ? ' (needs you)' : ''}`);
  }
  if (!timeline.available) lines.push('  Your saved artifacts could not be read, so events from them are missing.');
  return lines.join('\n');
}
