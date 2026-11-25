/**
 * What a review packet is read from: the shapes of its timeline, its steps and its defaults, an artifact's
 * metadata read as plain values, and which artifact plays which part (by the purpose the producing tool recorded,
 * never its file name). Shared by the daemon, which reports the packet (documents.readiness, packet-steps,
 * timeline), and the Agent workspace, which shows the same packet.
 */
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import { hasPurpose, PURPOSE_MODEL_COMPARE_ROUTE_DECISION } from './review-packet-presets-core.js';

export interface AgentWorkspaceRecentReviewerHandoffArtifact {
  readonly id: string;
  readonly filename: string;
  readonly createdAt: number;
  readonly handoffId: string;
  readonly comparisonId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: string;
  readonly relatedArtifactCount: number;
}

export type AgentWorkspaceReviewPacketTimelineEventKind =
  | 'document'
  | 'comment'
  | 'suggestion'
  | 'attachment'
  | 'document-export'
  | 'compare'
  | 'compare-export'
  | 'judgment'
  | 'route-decision'
  | 'packet-preset'
  | 'handoff'
  | 'handoff-archive';

export interface AgentWorkspaceReviewPacketTimelineEvent {
  readonly id: string;
  readonly kind: AgentWorkspaceReviewPacketTimelineEventKind;
  readonly at: number;
  readonly label: string;
  readonly detail: string;
  readonly status: 'ready' | 'attention' | 'complete' | 'info';
  readonly route: string;
  readonly sourceId: string;
}

export interface AgentWorkspaceReviewPacketTimeline {
  readonly available: boolean;
  readonly count: number;
  readonly next: string;
  readonly items: readonly AgentWorkspaceReviewPacketTimelineEvent[];
}

export interface AgentWorkspaceReviewPacketPresetLineage {
  readonly artifactId: string;
  readonly presetId: string | null;
  readonly name: string | null;
  readonly refreshed: boolean;
  readonly refreshedFromArtifactId: string | null;
  readonly refreshedFromPresetId: string | null;
  readonly freshnessMissingCount: number | null;
  readonly freshnessSupersededCount: number | null;
  readonly freshnessUnresolvedCount: number | null;
  readonly summary: string;
  readonly inspectRoute: string;
}

export interface AgentWorkspaceReviewPacketDefaults {
  readonly documentId: string | null;
  readonly documentTitle: string | null;
  readonly documentExportArtifactId: string | null;
  readonly comparisonArtifactId: string | null;
  readonly judgmentArtifactId: string | null;
  readonly revealedJudgmentArtifactId: string | null;
  readonly routeDecisionArtifactId: string | null;
  readonly routeDecision: string | null;
  readonly handoffArtifactId: string | null;
  readonly handoffArchiveArtifactId: string | null;
  readonly reviewPacketPresetArtifactId: string | null;
  readonly reviewPacketPresetName: string | null;
  readonly reviewPacketPresetLineage: AgentWorkspaceReviewPacketPresetLineage | null;
  readonly relatedArtifactIds: readonly string[];
  readonly summary: string;
}

export type AgentWorkspaceReviewPacketWizardStepStatus = 'done' | 'current' | 'pending' | 'blocked';

export interface AgentWorkspaceReviewPacketWizardStep {
  readonly id: string;
  readonly label: string;
  readonly status: AgentWorkspaceReviewPacketWizardStepStatus;
  readonly detail: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  /** The Agent workspace row that runs this step; null when its control is in a place (`ownerLine` names it). */
  readonly actionId: string | null;
  readonly backtrackRoute: string | null;
  /** The line a person types for this step, with a blank in angle brackets where they choose. */
  readonly ownerLine: string;
}

export interface AgentWorkspaceReviewPacketWizard {
  readonly available: boolean;
  readonly status: 'complete' | 'active' | 'blocked' | 'empty';
  readonly completedSteps: number;
  readonly totalSteps: number;
  readonly currentStepId: string | null;
  readonly currentStepLabel: string | null;
  readonly next: string;
  readonly finalReview: string;
  readonly presetLineage: AgentWorkspaceReviewPacketPresetLineage | null;
  readonly steps: readonly AgentWorkspaceReviewPacketWizardStep[];
}

export function readArtifactMetadataString(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readArtifactMetadataStringList(metadata: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

export function readArtifactMetadataNumber(metadata: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isoToEpoch(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function compactTimelineText(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function uniqueStrings(values: readonly (string | null | undefined)[], limit: number): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
    if (result.length >= limit) break;
  }
  return result;
}

// An artifact's kind is the purpose the producing tool recorded on it, never
// its filename: a filename can come from an upload.
export function isReviewerHandoffArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-handoff';
}

export function isModelCompareArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare';
}

export function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-judgment';
}

export function isDocumentExportArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-document-export';
}

export function isModelCompareExportArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-export';
}

export function isReviewerHandoffArchiveArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-model-compare-handoff-archive';
}

export function isModelCompareRouteDecisionArtifact(artifact: ArtifactDescriptor): boolean {
  return hasPurpose(artifact, PURPOSE_MODEL_COMPARE_ROUTE_DECISION);
}

export function isReviewPacketPresetArtifact(artifact: ArtifactDescriptor): boolean {
  return readArtifactMetadataString(artifact.metadata, 'purpose') === 'agent-review-packet-preset';
}

export function artifactById(artifacts: readonly ArtifactDescriptor[], artifactId: string): ArtifactDescriptor | null {
  return artifacts.find((artifact) => artifact.id === artifactId) ?? null;
}

export function firstArtifactMetadataString(
  artifacts: readonly ArtifactDescriptor[],
  artifactIds: readonly string[],
  keys: readonly string[],
): string {
  for (const artifactId of artifactIds) {
    const artifact = artifactById(artifacts, artifactId);
    if (!artifact) continue;
    for (const key of keys) {
      const value = readArtifactMetadataString(artifact.metadata, key);
      if (value) return value;
    }
  }
  return '';
}

export function latestMatchingArtifact(
  artifacts: readonly ArtifactDescriptor[],
  currentArtifactId: string,
  predicate: (artifact: ArtifactDescriptor) => boolean,
): ArtifactDescriptor | null {
  const current = artifactById(artifacts, currentArtifactId);
  const currentCreatedAt = current?.createdAt ?? -1;
  return artifacts
    .filter((artifact) => artifact.id !== currentArtifactId && artifact.createdAt > currentCreatedAt && predicate(artifact))
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))[0] ?? null;
}

export function reviewPacketPresetFreshness(
  preset: ArtifactDescriptor,
  listedArtifacts: readonly ArtifactDescriptor[],
  /** Looks one artifact up outside the listed window, so a reference older than the list is not reported missing. */
  resolveArtifact?: (artifactId: string) => ArtifactDescriptor | null,
): { readonly missingCount: number; readonly newerCount: number; readonly summary: string; readonly status: 'info' | 'attention' } {
  const metadata = preset.metadata;
  const primaryIds = [
    readArtifactMetadataString(metadata, 'documentExportArtifactId'),
    readArtifactMetadataString(metadata, 'comparisonArtifactId'),
    readArtifactMetadataString(metadata, 'judgmentArtifactId'),
    readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId'),
    readArtifactMetadataString(metadata, 'routeDecisionArtifactId'),
    readArtifactMetadataString(metadata, 'handoffArtifactId'),
    readArtifactMetadataString(metadata, 'handoffArchiveArtifactId'),
  ].filter(Boolean);
  const relatedIds = readArtifactMetadataStringList(metadata, 'relatedArtifactIds');
  const referencedIds = uniqueStrings([...primaryIds, ...relatedIds], 40);
  const listedIds = new Set(listedArtifacts.map((artifact) => artifact.id));
  const resolvedOutsideList = resolveArtifact
    ? referencedIds.filter((artifactId) => !listedIds.has(artifactId)).flatMap((artifactId) => resolveArtifact(artifactId) ?? [])
    : [];
  const artifacts = resolvedOutsideList.length > 0 ? [...listedArtifacts, ...resolvedOutsideList] : listedArtifacts;
  const missingCount = referencedIds.filter((artifactId) => !artifactById(artifacts, artifactId)).length;
  const documentId = readArtifactMetadataString(metadata, 'documentId')
    || firstArtifactMetadataString(artifacts, primaryIds, ['documentId', 'sourceDocumentId']);
  const comparisonId = firstArtifactMetadataString(artifacts, primaryIds, ['comparisonId']);
  const sourceArtifactId = firstArtifactMetadataString(artifacts, primaryIds, ['sourceArtifactId'])
    || readArtifactMetadataString(metadata, 'documentExportArtifactId');
  const handoffSourceArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId')
    || readArtifactMetadataString(metadata, 'judgmentArtifactId')
    || readArtifactMetadataString(metadata, 'comparisonArtifactId')
    || readArtifactMetadataString(metadata, 'documentExportArtifactId');
  const judgmentArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId')
    || readArtifactMetadataString(metadata, 'judgmentArtifactId')
    || firstArtifactMetadataString(artifacts, [readArtifactMetadataString(metadata, 'routeDecisionArtifactId')], ['judgmentArtifactId']);
  const handoffArtifactId = readArtifactMetadataString(metadata, 'handoffArtifactId')
    || firstArtifactMetadataString(artifacts, [readArtifactMetadataString(metadata, 'handoffArchiveArtifactId')], ['handoffArtifactId']);
  const documentExportArtifactId = readArtifactMetadataString(metadata, 'documentExportArtifactId');
  const comparisonArtifactId = readArtifactMetadataString(metadata, 'comparisonArtifactId');
  const judgmentPresetArtifactId = readArtifactMetadataString(metadata, 'judgmentArtifactId');
  const revealedJudgmentArtifactId = readArtifactMetadataString(metadata, 'revealedJudgmentArtifactId');
  const routeDecisionArtifactId = readArtifactMetadataString(metadata, 'routeDecisionArtifactId');
  const handoffPresetArtifactId = readArtifactMetadataString(metadata, 'handoffArtifactId');
  const handoffArchiveArtifactId = readArtifactMetadataString(metadata, 'handoffArchiveArtifactId');
  const freshnessChecks: Array<ArtifactDescriptor | null> = [
    documentId && documentExportArtifactId
      ? latestMatchingArtifact(artifacts, documentExportArtifactId, (artifact) => (
        isDocumentExportArtifact(artifact) && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId
      ))
      : null,
    comparisonArtifactId && (documentId || sourceArtifactId)
      ? latestMatchingArtifact(artifacts, comparisonArtifactId, (artifact) => (
        isModelCompareArtifact(artifact)
        && (
          Boolean(documentId && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId)
          || Boolean(sourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === sourceArtifactId)
        )
      ))
      : null,
    judgmentPresetArtifactId && (comparisonId || sourceArtifactId || documentId)
      ? latestMatchingArtifact(artifacts, judgmentPresetArtifactId, (artifact) => (
        isModelCompareJudgmentArtifact(artifact)
        && (
          Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
          || Boolean(documentId && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId)
          || Boolean(sourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === sourceArtifactId)
        )
      ))
      : null,
    revealedJudgmentArtifactId && (comparisonId || sourceArtifactId || documentId)
      ? latestMatchingArtifact(artifacts, revealedJudgmentArtifactId, (artifact) => (
        isModelCompareJudgmentArtifact(artifact)
        && artifact.metadata.revealIncludedInJudgment === true
        && readArtifactMetadataString(artifact.metadata, 'winnerModel').length > 0
        && (
          Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
          || Boolean(documentId && readArtifactMetadataString(artifact.metadata, 'documentId') === documentId)
          || Boolean(sourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === sourceArtifactId)
        )
      ))
      : null,
    routeDecisionArtifactId && (comparisonId || judgmentArtifactId)
      ? latestMatchingArtifact(artifacts, routeDecisionArtifactId, (artifact) => (
        isModelCompareRouteDecisionArtifact(artifact)
        && (
          Boolean(judgmentArtifactId && readArtifactMetadataString(artifact.metadata, 'judgmentArtifactId') === judgmentArtifactId)
          || Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
        )
      ))
      : null,
    handoffPresetArtifactId && (comparisonId || handoffSourceArtifactId)
      ? latestMatchingArtifact(artifacts, handoffPresetArtifactId, (artifact) => (
        isReviewerHandoffArtifact(artifact)
        && (
          Boolean(handoffSourceArtifactId && readArtifactMetadataString(artifact.metadata, 'sourceArtifactId') === handoffSourceArtifactId)
          || Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
        )
      ))
      : null,
    handoffArchiveArtifactId && (comparisonId || handoffArtifactId)
      ? latestMatchingArtifact(artifacts, handoffArchiveArtifactId, (artifact) => (
        isReviewerHandoffArchiveArtifact(artifact)
        && (
          Boolean(handoffArtifactId && readArtifactMetadataString(artifact.metadata, 'handoffArtifactId') === handoffArtifactId)
          || Boolean(comparisonId && readArtifactMetadataString(artifact.metadata, 'comparisonId') === comparisonId)
        )
      ))
      : null,
  ];
  const newerCount = new Set(freshnessChecks.filter((artifact): artifact is ArtifactDescriptor => artifact !== null).map((artifact) => artifact.id)).size;
  const needsReview = missingCount > 0 || newerCount > 0;
  return {
    missingCount,
    newerCount,
    summary: needsReview ? `freshness needs review: ${missingCount} missing, ${newerCount} newer` : 'freshness current',
    status: needsReview ? 'attention' : 'info',
  };
}

export function buildReviewPacketPresetLineage(preset: ArtifactDescriptor | null): AgentWorkspaceReviewPacketPresetLineage | null {
  if (!preset) return null;
  const metadata = preset.metadata;
  const refreshedFromArtifactId = readArtifactMetadataString(metadata, 'refreshOfArtifactId') || null;
  const refreshedFromPresetId = readArtifactMetadataString(metadata, 'refreshOfPresetId') || null;
  const freshnessMissingCount = readArtifactMetadataNumber(metadata, 'freshnessMissingCount');
  const freshnessSupersededCount = readArtifactMetadataNumber(metadata, 'freshnessSupersededCount');
  const freshnessUnresolvedCount = readArtifactMetadataNumber(metadata, 'freshnessUnresolvedCount');
  const repairedCount = (freshnessMissingCount ?? 0) + (freshnessSupersededCount ?? 0);
  const name = readArtifactMetadataString(metadata, 'name') || null;
  const presetId = readArtifactMetadataString(metadata, 'presetId') || null;
  const displayName = name ?? preset.filename ?? preset.id;
  const summary = refreshedFromArtifactId
    ? [
      `${displayName} refreshed from ${refreshedFromArtifactId}`,
      refreshedFromPresetId ? `source preset ${refreshedFromPresetId}` : '',
      `repaired ${repairedCount}`,
      `unresolved ${freshnessUnresolvedCount ?? 0}`,
    ].filter(Boolean).join('; ')
    : [
      `${displayName} has no refresh lineage`,
      presetId ? `preset ${presetId}` : '',
    ].filter(Boolean).join('; ');
  return {
    artifactId: preset.id,
    presetId,
    name,
    refreshed: Boolean(refreshedFromArtifactId),
    refreshedFromArtifactId,
    refreshedFromPresetId,
    freshnessMissingCount,
    freshnessSupersededCount,
    freshnessUnresolvedCount,
    summary,
    inspectRoute: `agent_review_packet_presets show artifactId:"${preset.id}"`,
  };
}

export function summarizeReviewerHandoffArtifact(artifact: ArtifactDescriptor): AgentWorkspaceRecentReviewerHandoffArtifact {
  const metadata = artifact.metadata;
  return {
    id: artifact.id,
    filename: artifact.filename ?? '(unnamed handoff artifact)',
    createdAt: artifact.createdAt,
    handoffId: readArtifactMetadataString(metadata, 'handoffId') || 'unknown-handoff',
    comparisonId: readArtifactMetadataString(metadata, 'comparisonId') || 'unknown-comparison',
    sourceArtifactId: readArtifactMetadataString(metadata, 'sourceArtifactId') || '(missing source)',
    sourceKind: readArtifactMetadataString(metadata, 'sourceKind') || 'unknown',
    relatedArtifactCount: readArtifactMetadataStringList(metadata, 'relatedArtifactIds').length,
  };
}
