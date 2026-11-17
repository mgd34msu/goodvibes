import { randomUUID } from 'node:crypto';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
export interface AgentReviewPacketPresetsToolArgs {
  readonly mode?: unknown;
  readonly artifactId?: unknown;
  readonly name?: unknown;
  readonly documentId?: unknown;
  readonly documentTitle?: unknown;
  readonly documentExportArtifactId?: unknown;
  readonly comparisonArtifactId?: unknown;
  readonly judgmentArtifactId?: unknown;
  readonly revealedJudgmentArtifactId?: unknown;
  readonly routeDecisionArtifactId?: unknown;
  readonly routeDecision?: unknown;
  readonly handoffArtifactId?: unknown;
  readonly handoffArchiveArtifactId?: unknown;
  readonly relatedArtifactIds?: unknown;
  readonly summary?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export type AgentReviewPacketPresetArtifactStore = Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'get' | 'list' | 'readContent' | 'delete'>>;

export type AgentReviewPacketPresetMode = 'list' | 'show' | 'save' | 'refresh' | 'delete';
export type ReviewPacketArtifactRole =
  | 'documentExport'
  | 'comparison'
  | 'judgment'
  | 'revealedJudgment'
  | 'routeDecision'
  | 'handoff'
  | 'handoffArchive'
  | 'related';

export interface ReviewPacketPresetPacket {
  readonly documentId?: string;
  readonly documentTitle?: string;
  readonly documentExportArtifactId?: string;
  readonly comparisonArtifactId?: string;
  readonly judgmentArtifactId?: string;
  readonly revealedJudgmentArtifactId?: string;
  readonly routeDecisionArtifactId?: string;
  readonly routeDecision?: string;
  readonly handoffArtifactId?: string;
  readonly handoffArchiveArtifactId?: string;
  readonly relatedArtifactIds: readonly string[];
  readonly summary: string;
}

export interface ReviewPacketPresetRecord {
  readonly schema: 'goodvibes-agent.review-packet-preset';
  readonly schemaVersion: 1;
  readonly presetId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly explicitUserRequest: string;
  readonly packet: ReviewPacketPresetPacket;
  readonly refresh?: {
    readonly sourceArtifactId: string;
    readonly sourcePresetId?: string;
    readonly missingCount: number;
    readonly supersededCount: number;
    readonly unresolvedCount: number;
  };
  readonly policy: {
    readonly effect: 'save-local-preset-artifact-only';
    readonly documentsChanged: false;
    readonly modelRouteChanged: false;
    readonly handoffArchiveCreated: false;
  };
}

export interface LoadedReviewPacketPreset {
  readonly descriptor: ArtifactDescriptor;
  readonly record?: ArtifactRecord;
  readonly body?: ReviewPacketPresetRecord;
}

export interface ReviewPacketArtifactReference {
  readonly role: ReviewPacketArtifactRole;
  readonly label: string;
  readonly id: string;
}

export interface ReviewPacketFreshnessMissing {
  readonly role: ReviewPacketArtifactRole;
  readonly label: string;
  readonly id: string;
  readonly replacementId?: string;
  readonly reason?: string;
}

export interface ReviewPacketFreshnessSuperseded {
  readonly role: ReviewPacketArtifactRole;
  readonly label: string;
  readonly id: string;
  readonly replacementId: string;
  readonly reason: string;
}

export interface ReviewPacketFreshnessDependent {
  readonly role: ReviewPacketArtifactRole;
  readonly label: string;
  readonly id: string;
  readonly reason: string;
}

export interface ReviewPacketFreshnessAudit {
  readonly available: boolean;
  readonly scannedArtifacts: number;
  readonly status: 'current' | 'needs-review' | 'unchecked';
  readonly missing: readonly ReviewPacketFreshnessMissing[];
  readonly superseded: readonly ReviewPacketFreshnessSuperseded[];
  /** References that were not replaced but describe an artifact that was (a judgment of the old comparison). */
  readonly dependentOnReplaced: readonly ReviewPacketFreshnessDependent[];
  readonly recommendedPacket: ReviewPacketPresetPacket;
}

export const REVIEW_PACKET_PRESET_PURPOSE = 'agent-review-packet-preset';
export const REVIEW_PACKET_PRESET_SCHEMA = 'goodvibes-agent.review-packet-preset';
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
export const MAX_FRESHNESS_ARTIFACT_SCAN = 500;
export const PURPOSE_DOCUMENT_EXPORT = 'agent-document-export';
export const PURPOSE_MODEL_COMPARE = 'agent-model-compare';
export const PURPOSE_MODEL_COMPARE_JUDGMENT = 'agent-model-compare-judgment';
export const PURPOSE_MODEL_COMPARE_ROUTE_DECISION = 'agent-model-compare-route-decision';
export const PURPOSE_MODEL_COMPARE_HANDOFF = 'agent-model-compare-handoff';
export const PURPOSE_MODEL_COMPARE_HANDOFF_ARCHIVE = 'agent-model-compare-handoff-archive';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function readBoolean(value: unknown): boolean {
  return value === true || value === 'true' || value === 'yes';
}

export function readNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
}

export function readStringList(value: unknown): readonly string[] {
  const values = Array.isArray(value)
    ? value
    : readString(value)
      .split(/[,\n]/)
      .map((entry) => entry.trim());
  const seen = new Set<string>();
  const result: string[] = [];
  for (const valueEntry of values) {
    const entry = readString(valueEntry);
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function compactText(value: string, maxLength = 96): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function filenamePart(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || 'review-packet';
}

export function parseMode(value: unknown): AgentReviewPacketPresetMode {
  const mode = readString(value).toLowerCase();
  if (!mode || mode === 'list') return 'list';
  if (mode === 'show' || mode === 'get') return 'show';
  if (mode === 'save' || mode === 'create') return 'save';
  if (mode === 'refresh' || mode === 'update') return 'refresh';
  if (mode === 'delete' || mode === 'remove') return 'delete';
  throw new Error(`Unknown agent_review_packet_presets mode: ${mode}. Use mode:"list", mode:"show", mode:"save", mode:"refresh", or mode:"delete".`);
}

export function defaultPacketSummary(input: {
  readonly documentId?: string;
  readonly documentExportArtifactId?: string;
  readonly comparisonArtifactId?: string;
  readonly judgmentArtifactId?: string;
  readonly revealedJudgmentArtifactId?: string;
  readonly handoffArtifactId?: string;
  readonly handoffArchiveArtifactId?: string;
  readonly relatedArtifactIds?: readonly string[];
}): string {
  const sourceArtifactId = input.revealedJudgmentArtifactId
    || input.judgmentArtifactId
    || input.comparisonArtifactId
    || input.documentExportArtifactId;
  const relatedArtifactIds = input.relatedArtifactIds ?? [];
  return [
    input.documentId ? `document ${input.documentId}` : '',
    sourceArtifactId ? `source ${sourceArtifactId}` : '',
    input.handoffArtifactId ? `handoff ${input.handoffArtifactId}` : '',
    input.handoffArchiveArtifactId ? `archive ${input.handoffArchiveArtifactId}` : '',
    relatedArtifactIds.length > 0 ? `${relatedArtifactIds.length} related` : '',
  ].filter(Boolean).join('; ') || 'review packet preset';
}

export function readPresetPacket(args: AgentReviewPacketPresetsToolArgs): ReviewPacketPresetPacket {
  const documentId = readString(args.documentId);
  const documentTitle = readString(args.documentTitle);
  const documentExportArtifactId = readString(args.documentExportArtifactId);
  const comparisonArtifactId = readString(args.comparisonArtifactId);
  const judgmentArtifactId = readString(args.judgmentArtifactId);
  const revealedJudgmentArtifactId = readString(args.revealedJudgmentArtifactId);
  const routeDecisionArtifactId = readString(args.routeDecisionArtifactId);
  const routeDecision = readString(args.routeDecision);
  const handoffArtifactId = readString(args.handoffArtifactId);
  const handoffArchiveArtifactId = readString(args.handoffArchiveArtifactId);
  const relatedArtifactIds = readStringList(args.relatedArtifactIds);
  const explicitSummary = readString(args.summary);
  const summary = explicitSummary || defaultPacketSummary({
    documentId,
    documentExportArtifactId,
    comparisonArtifactId,
    judgmentArtifactId,
    revealedJudgmentArtifactId,
    handoffArtifactId,
    handoffArchiveArtifactId,
    relatedArtifactIds,
  });

  if (!documentId
    && !documentExportArtifactId
    && !comparisonArtifactId
    && !judgmentArtifactId
    && !revealedJudgmentArtifactId
    && !routeDecisionArtifactId
    && !handoffArtifactId
    && !handoffArchiveArtifactId
    && relatedArtifactIds.length === 0
  ) {
    throw new Error('save mode requires at least one document, comparison, judgment, handoff, archive, route-decision, or related artifact id.');
  }

  return {
    ...(documentId ? { documentId } : {}),
    ...(documentTitle ? { documentTitle } : {}),
    ...(documentExportArtifactId ? { documentExportArtifactId } : {}),
    ...(comparisonArtifactId ? { comparisonArtifactId } : {}),
    ...(judgmentArtifactId ? { judgmentArtifactId } : {}),
    ...(revealedJudgmentArtifactId ? { revealedJudgmentArtifactId } : {}),
    ...(routeDecisionArtifactId ? { routeDecisionArtifactId } : {}),
    ...(routeDecision ? { routeDecision } : {}),
    ...(handoffArtifactId ? { handoffArtifactId } : {}),
    ...(handoffArchiveArtifactId ? { handoffArchiveArtifactId } : {}),
    relatedArtifactIds,
    summary,
  };
}

export function presetName(args: AgentReviewPacketPresetsToolArgs, packet: ReviewPacketPresetPacket): string {
  const requested = readString(args.name);
  if (requested) return requested;
  if (packet.documentTitle) return `${packet.documentTitle} reviewer packet`;
  if (packet.documentId) return `${packet.documentId} reviewer packet`;
  if (packet.handoffArtifactId) return `${packet.handoffArtifactId} reviewer packet`;
  return 'Reviewer packet preset';
}

export function buildPresetRecord(args: AgentReviewPacketPresetsToolArgs): ReviewPacketPresetRecord {
  const explicitUserRequest = readString(args.explicitUserRequest);
  const packet = readPresetPacket(args);
  return {
    schema: REVIEW_PACKET_PRESET_SCHEMA,
    schemaVersion: 1,
    presetId: `packet_preset_${randomUUID()}`,
    name: presetName(args, packet),
    createdAt: new Date().toISOString(),
    explicitUserRequest,
    packet,
    policy: {
      effect: 'save-local-preset-artifact-only',
      documentsChanged: false,
      modelRouteChanged: false,
      handoffArchiveCreated: false,
    },
  };
}

export function metadataValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function presetMetadata(record: ReviewPacketPresetRecord): Record<string, unknown> {
  return {
    purpose: REVIEW_PACKET_PRESET_PURPOSE,
    schema: REVIEW_PACKET_PRESET_SCHEMA,
    schemaVersion: record.schemaVersion,
    presetId: record.presetId,
    name: record.name,
    summary: record.packet.summary,
    documentId: metadataValue(record.packet.documentId),
    documentTitle: metadataValue(record.packet.documentTitle),
    documentExportArtifactId: metadataValue(record.packet.documentExportArtifactId),
    comparisonArtifactId: metadataValue(record.packet.comparisonArtifactId),
    judgmentArtifactId: metadataValue(record.packet.judgmentArtifactId),
    revealedJudgmentArtifactId: metadataValue(record.packet.revealedJudgmentArtifactId),
    routeDecisionArtifactId: metadataValue(record.packet.routeDecisionArtifactId),
    routeDecision: metadataValue(record.packet.routeDecision),
    handoffArtifactId: metadataValue(record.packet.handoffArtifactId),
    handoffArchiveArtifactId: metadataValue(record.packet.handoffArchiveArtifactId),
    relatedArtifactIds: record.packet.relatedArtifactIds,
    refreshOfArtifactId: metadataValue(record.refresh?.sourceArtifactId),
    refreshOfPresetId: metadataValue(record.refresh?.sourcePresetId),
    freshnessMissingCount: record.refresh?.missingCount,
    freshnessSupersededCount: record.refresh?.supersededCount,
    freshnessUnresolvedCount: record.refresh?.unresolvedCount,
    source: 'agent-review-packet-presets',
    createdAt: record.createdAt,
    explicitUserRequest: record.explicitUserRequest,
  };
}

export function presetCreateInput(record: ReviewPacketPresetRecord): ArtifactCreateInput {
  return {
    kind: 'data',
    mimeType: 'application/json',
    filename: `review-packet-preset-${filenamePart(record.name)}.json`,
    text: `${JSON.stringify(record, null, 2)}\n`,
    metadata: presetMetadata(record),
  };
}

export function readMetadataString(metadata: Readonly<Record<string, unknown>>, key: string): string {
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function readMetadataStringList(metadata: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

export function isPresetArtifact(artifact: ArtifactDescriptor): boolean {
  return readMetadataString(artifact.metadata, 'purpose') === REVIEW_PACKET_PRESET_PURPOSE;
}

export function artifactPurpose(artifact: ArtifactDescriptor): string {
  return readMetadataString(artifact.metadata, 'purpose');
}

/** Blind-comparison artifacts saved before `purpose` was recorded are recognised by their filename prefix, as the compare tool does. */
const LEGACY_FILENAME_PREFIX: Readonly<Record<string, string>> = {
  [PURPOSE_MODEL_COMPARE]: 'blind-model-comparison-cmp_',
  [PURPOSE_MODEL_COMPARE_JUDGMENT]: 'blind-model-comparison-judgment-',
  [PURPOSE_MODEL_COMPARE_HANDOFF]: 'blind-model-comparison-handoff-',
  [PURPOSE_MODEL_COMPARE_ROUTE_DECISION]: 'blind-model-comparison-route-decision-',
};

export function hasPurpose(artifact: ArtifactDescriptor, purpose: string): boolean {
  const recorded = artifactPurpose(artifact);
  if (recorded) return recorded === purpose;
  const legacyPrefix = LEGACY_FILENAME_PREFIX[purpose];
  return legacyPrefix !== undefined && (artifact.filename ?? '').startsWith(legacyPrefix);
}

export function isRevealedJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  return hasPurpose(artifact, PURPOSE_MODEL_COMPARE_JUDGMENT)
    && artifact.metadata.revealIncludedInJudgment === true
    && readMetadataString(artifact.metadata, 'winnerModel').length > 0;
}

export function artifactIndex(artifacts: readonly ArtifactDescriptor[]): Map<string, ArtifactDescriptor> {
  return new Map(artifacts.map((artifact) => [artifact.id, artifact]));
}

export function artifactFromIndex(
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
  id: string | undefined,
): ArtifactDescriptor | null {
  if (!id) return null;
  const indexed = index.get(id);
  if (indexed) return indexed;
  try {
    return store?.get?.(id) ?? null;
  } catch {
    return null;
  }
}

export function latestArtifact(
  artifacts: readonly ArtifactDescriptor[],
  predicate: (artifact: ArtifactDescriptor) => boolean,
): ArtifactDescriptor | null {
  return artifacts
    .filter(predicate)
    .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))[0] ?? null;
}

export function firstMetadataString(
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
  ids: readonly (string | undefined)[],
  keys: readonly string[],
): string {
  for (const id of ids) {
    const artifact = artifactFromIndex(store, index, id);
    if (!artifact) continue;
    for (const key of keys) {
      const value = readMetadataString(artifact.metadata, key);
      if (value) return value;
    }
  }
  return '';
}

export function packetDocumentId(
  packet: ReviewPacketPresetPacket,
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
): string {
  return packet.documentId
    || firstMetadataString(store, index, [
      packet.documentExportArtifactId,
      packet.comparisonArtifactId,
      packet.judgmentArtifactId,
      packet.revealedJudgmentArtifactId,
      packet.routeDecisionArtifactId,
      packet.handoffArtifactId,
      packet.handoffArchiveArtifactId,
    ], ['documentId', 'sourceDocumentId']);
}

export function packetComparisonId(
  packet: ReviewPacketPresetPacket,
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
): string {
  return firstMetadataString(store, index, [
    packet.routeDecisionArtifactId,
    packet.handoffArchiveArtifactId,
    packet.handoffArtifactId,
    packet.revealedJudgmentArtifactId,
    packet.judgmentArtifactId,
    packet.comparisonArtifactId,
  ], ['comparisonId']);
}

export function packetRunSourceArtifactId(
  packet: ReviewPacketPresetPacket,
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
): string {
  return firstMetadataString(store, index, [
    packet.comparisonArtifactId,
    packet.judgmentArtifactId,
    packet.revealedJudgmentArtifactId,
    packet.handoffArtifactId,
    packet.handoffArchiveArtifactId,
  ], ['sourceArtifactId']) || packet.documentExportArtifactId || '';
}

export function packetJudgmentArtifactId(
  packet: ReviewPacketPresetPacket,
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
): string {
  return packet.revealedJudgmentArtifactId
    || packet.judgmentArtifactId
    || firstMetadataString(store, index, [packet.routeDecisionArtifactId], ['judgmentArtifactId']);
}

export function packetHandoffSourceArtifactId(packet: ReviewPacketPresetPacket): string {
  return sourceArtifactId(packet);
}

export function freshnessReferences(packet: ReviewPacketPresetPacket): readonly ReviewPacketArtifactReference[] {
  const references: ReviewPacketArtifactReference[] = [];
  const add = (role: ReviewPacketArtifactRole, label: string, id: string | undefined): void => {
    if (id) references.push({ role, label, id });
  };
  add('documentExport', 'document export', packet.documentExportArtifactId);
  add('comparison', 'comparison', packet.comparisonArtifactId);
  add('judgment', 'judgment', packet.judgmentArtifactId);
  add('revealedJudgment', 'revealed judgment', packet.revealedJudgmentArtifactId);
  add('routeDecision', 'route decision', packet.routeDecisionArtifactId);
  add('handoff', 'reviewer handoff', packet.handoffArtifactId);
  add('handoffArchive', 'handoff archive', packet.handoffArchiveArtifactId);
  for (const id of packet.relatedArtifactIds) add('related', 'related artifact', id);
  return references;
}

export function replacementForRole(input: {
  readonly role: ReviewPacketArtifactRole;
  readonly packet: ReviewPacketPresetPacket;
  readonly current: ArtifactDescriptor | null;
  readonly artifacts: readonly ArtifactDescriptor[];
  readonly store?: AgentReviewPacketPresetArtifactStore;
  readonly index: ReadonlyMap<string, ArtifactDescriptor>;
}): { readonly artifact: ArtifactDescriptor; readonly reason: string } | null {
  const documentId = packetDocumentId(input.packet, input.store, input.index);
  const comparisonId = packetComparisonId(input.packet, input.store, input.index);
  const runSourceArtifactId = packetRunSourceArtifactId(input.packet, input.store, input.index);
  const judgmentArtifactId = packetJudgmentArtifactId(input.packet, input.store, input.index);
  const handoffSourceArtifactId = packetHandoffSourceArtifactId(input.packet);
  const handoffArtifactId = input.packet.handoffArtifactId
    || firstMetadataString(input.store, input.index, [input.packet.handoffArchiveArtifactId], ['handoffArtifactId']);

  const currentCreatedAt = input.current?.createdAt ?? -1;
  const newest = (predicate: (artifact: ArtifactDescriptor) => boolean): ArtifactDescriptor | null => {
    const candidate = latestArtifact(input.artifacts, (artifact) => (
      artifact.id !== input.current?.id
      && artifact.createdAt > currentCreatedAt
      && predicate(artifact)
    ));
    return candidate;
  };

  if (input.role === 'documentExport') {
    if (!documentId) return null;
    const artifact = newest((candidate) => (
      hasPurpose(candidate, PURPOSE_DOCUMENT_EXPORT)
      && readMetadataString(candidate.metadata, 'documentId') === documentId
    ));
    return artifact ? { artifact, reason: `newer document export for ${documentId}` } : null;
  }

  if (input.role === 'comparison') {
    const artifact = newest((candidate) => {
      if (!hasPurpose(candidate, PURPOSE_MODEL_COMPARE)) return false;
      if (documentId && readMetadataString(candidate.metadata, 'documentId') === documentId) return true;
      return Boolean(runSourceArtifactId && readMetadataString(candidate.metadata, 'sourceArtifactId') === runSourceArtifactId);
    });
    return artifact ? { artifact, reason: documentId ? `newer comparison for ${documentId}` : `newer comparison for source ${runSourceArtifactId}` } : null;
  }

  if (input.role === 'judgment' || input.role === 'revealedJudgment') {
    const artifact = newest((candidate) => {
      if (!hasPurpose(candidate, PURPOSE_MODEL_COMPARE_JUDGMENT)) return false;
      if (input.role === 'revealedJudgment' && !isRevealedJudgmentArtifact(candidate)) return false;
      if (comparisonId && readMetadataString(candidate.metadata, 'comparisonId') === comparisonId) return true;
      if (documentId && readMetadataString(candidate.metadata, 'documentId') === documentId) return true;
      return Boolean(runSourceArtifactId && readMetadataString(candidate.metadata, 'sourceArtifactId') === runSourceArtifactId);
    });
    return artifact ? { artifact, reason: comparisonId ? `newer judgment for ${comparisonId}` : 'newer matching judgment' } : null;
  }

  if (input.role === 'routeDecision') {
    const artifact = newest((candidate) => (
      hasPurpose(candidate, PURPOSE_MODEL_COMPARE_ROUTE_DECISION)
      && (
        Boolean(judgmentArtifactId && readMetadataString(candidate.metadata, 'judgmentArtifactId') === judgmentArtifactId)
        || Boolean(comparisonId && readMetadataString(candidate.metadata, 'comparisonId') === comparisonId)
      )
    ));
    return artifact ? { artifact, reason: comparisonId ? `newer route decision for ${comparisonId}` : 'newer route decision for judgment' } : null;
  }

  if (input.role === 'handoff') {
    const artifact = newest((candidate) => (
      hasPurpose(candidate, PURPOSE_MODEL_COMPARE_HANDOFF)
      && (
        Boolean(handoffSourceArtifactId && readMetadataString(candidate.metadata, 'sourceArtifactId') === handoffSourceArtifactId)
        || Boolean(comparisonId && readMetadataString(candidate.metadata, 'comparisonId') === comparisonId)
      )
    ));
    return artifact ? { artifact, reason: comparisonId ? `newer reviewer handoff for ${comparisonId}` : `newer reviewer handoff for source ${handoffSourceArtifactId}` } : null;
  }

  if (input.role === 'handoffArchive') {
    const artifact = newest((candidate) => (
      hasPurpose(candidate, PURPOSE_MODEL_COMPARE_HANDOFF_ARCHIVE)
      && (
        Boolean(handoffArtifactId && readMetadataString(candidate.metadata, 'handoffArtifactId') === handoffArtifactId)
        || Boolean(comparisonId && readMetadataString(candidate.metadata, 'comparisonId') === comparisonId)
      )
    ));
    return artifact ? { artifact, reason: comparisonId ? `newer handoff archive for ${comparisonId}` : 'newer handoff archive for handoff' } : null;
  }

  return null;
}

export function applyFreshnessReplacements(
  packet: ReviewPacketPresetPacket,
  replacements: ReadonlyMap<string, string>,
  roleReplacements: ReadonlyMap<ReviewPacketArtifactRole, string>,
): ReviewPacketPresetPacket {
  const replace = (value: string | undefined, role: ReviewPacketArtifactRole): string | undefined => {
    if (!value) return undefined;
    return roleReplacements.get(role) ?? replacements.get(value) ?? value;
  };
  const relatedArtifactIds = readStringList(packet.relatedArtifactIds.map((id) => replacements.get(id) ?? id));
  return {
    ...packet,
    ...(replace(packet.documentExportArtifactId, 'documentExport') ? { documentExportArtifactId: replace(packet.documentExportArtifactId, 'documentExport') } : {}),
    ...(replace(packet.comparisonArtifactId, 'comparison') ? { comparisonArtifactId: replace(packet.comparisonArtifactId, 'comparison') } : {}),
    ...(replace(packet.judgmentArtifactId, 'judgment') ? { judgmentArtifactId: replace(packet.judgmentArtifactId, 'judgment') } : {}),
    ...(replace(packet.revealedJudgmentArtifactId, 'revealedJudgment') ? { revealedJudgmentArtifactId: replace(packet.revealedJudgmentArtifactId, 'revealedJudgment') } : {}),
    ...(replace(packet.routeDecisionArtifactId, 'routeDecision') ? { routeDecisionArtifactId: replace(packet.routeDecisionArtifactId, 'routeDecision') } : {}),
    ...(replace(packet.handoffArtifactId, 'handoff') ? { handoffArtifactId: replace(packet.handoffArtifactId, 'handoff') } : {}),
    ...(replace(packet.handoffArchiveArtifactId, 'handoffArchive') ? { handoffArchiveArtifactId: replace(packet.handoffArchiveArtifactId, 'handoffArchive') } : {}),
    relatedArtifactIds,
  };
}

/**
 * Each role is replaced on its own, so a newer comparison can be paired with the old judgment, handoff or
 * archive that are about the previous one. Those stay in the packet but are reported, never counted as repaired.
 */
function dependentsOfReplaced(
  packet: ReviewPacketPresetPacket,
  store: AgentReviewPacketPresetArtifactStore | undefined,
  index: ReadonlyMap<string, ArtifactDescriptor>,
  roleReplacements: ReadonlyMap<ReviewPacketArtifactRole, string>,
): readonly ReviewPacketFreshnessDependent[] {
  const found: ReviewPacketFreshnessDependent[] = [];
  const comparisonReplaced = roleReplacements.has('comparison');
  const judgmentReplaced = roleReplacements.has('judgment') || roleReplacements.has('revealedJudgment');
  const oldComparison = artifactFromIndex(store, index, packet.comparisonArtifactId);
  const ownComparisonId = oldComparison ? readMetadataString(oldComparison.metadata, 'comparisonId') : '';
  const oldComparisonId = ownComparisonId || packetComparisonId(packet, store, index);
  const oldJudgmentIds = new Set([packet.judgmentArtifactId, packet.revealedJudgmentArtifactId].filter((id): id is string => Boolean(id)));
  const check = (role: ReviewPacketArtifactRole, label: string, id: string | undefined): void => {
    if (!id || roleReplacements.has(role)) return;
    const artifact = artifactFromIndex(store, index, id);
    if (!artifact) return;
    const describes = readMetadataString(artifact.metadata, 'comparisonId');
    if (comparisonReplaced && oldComparisonId && describes === oldComparisonId) {
      found.push({ role, label, id, reason: `describes the replaced comparison ${oldComparisonId}` });
    } else if (!comparisonReplaced && ownComparisonId && describes && describes !== ownComparisonId) {
      // A packet already refreshed (or assembled by hand) can still pair a comparison with another one's judgment.
      found.push({ role, label, id, reason: `describes comparison ${describes}, not the packet's ${ownComparisonId}` });
    } else if (judgmentReplaced && role !== 'judgment' && role !== 'revealedJudgment'
      && oldJudgmentIds.has(readMetadataString(artifact.metadata, 'judgmentArtifactId'))) {
      found.push({ role, label, id, reason: 'describes the replaced judgment' });
    }
  };
  check('judgment', 'judgment', packet.judgmentArtifactId);
  check('revealedJudgment', 'revealed judgment', packet.revealedJudgmentArtifactId);
  check('routeDecision', 'route decision', packet.routeDecisionArtifactId);
  check('handoff', 'reviewer handoff', packet.handoffArtifactId);
  check('handoffArchive', 'handoff archive', packet.handoffArchiveArtifactId);
  return found;
}

export function auditPresetFreshness(input: {
  readonly packet: ReviewPacketPresetPacket;
  readonly descriptor: ArtifactDescriptor;
  readonly artifacts: readonly ArtifactDescriptor[] | null;
  readonly store?: AgentReviewPacketPresetArtifactStore;
}): ReviewPacketFreshnessAudit {
  if (!input.artifacts) {
    return {
      available: false,
      scannedArtifacts: 0,
      status: 'unchecked',
      missing: [],
      superseded: [],
      dependentOnReplaced: [],
      recommendedPacket: input.packet,
    };
  }
  const allArtifacts = input.artifacts.some((artifact) => artifact.id === input.descriptor.id)
    ? input.artifacts
    : [input.descriptor, ...input.artifacts];
  const index = artifactIndex(allArtifacts);
  const missing: ReviewPacketFreshnessMissing[] = [];
  const superseded: ReviewPacketFreshnessSuperseded[] = [];
  const replacements = new Map<string, string>();
  const roleReplacements = new Map<ReviewPacketArtifactRole, string>();
  const seenReferences = new Set<string>();

  for (const reference of freshnessReferences(input.packet)) {
    const key = `${reference.role}:${reference.id}`;
    if (seenReferences.has(key)) continue;
    seenReferences.add(key);
    const current = artifactFromIndex(input.store, index, reference.id);
    const replacement = reference.role === 'related'
      ? null
      : replacementForRole({
        role: reference.role,
        packet: input.packet,
        current,
        artifacts: allArtifacts,
        store: input.store,
        index,
      });
    if (!current) {
      missing.push({
        role: reference.role,
        label: reference.label,
        id: reference.id,
        ...(replacement ? { replacementId: replacement.artifact.id, reason: replacement.reason } : {}),
      });
      if (replacement) {
        replacements.set(reference.id, replacement.artifact.id);
        roleReplacements.set(reference.role, replacement.artifact.id);
      }
      continue;
    }
    if (replacement) {
      superseded.push({
        role: reference.role,
        label: reference.label,
        id: reference.id,
        replacementId: replacement.artifact.id,
        reason: replacement.reason,
      });
      replacements.set(reference.id, replacement.artifact.id);
      roleReplacements.set(reference.role, replacement.artifact.id);
    }
  }

  const dependentOnReplaced = dependentsOfReplaced(input.packet, input.store, index, roleReplacements);
  return {
    available: true,
    scannedArtifacts: allArtifacts.length,
    status: missing.length > 0 || superseded.length > 0 || dependentOnReplaced.length > 0 ? 'needs-review' : 'current',
    missing,
    superseded,
    dependentOnReplaced,
    recommendedPacket: applyFreshnessReplacements(input.packet, replacements, roleReplacements),
  };
}

export function packetFromMetadata(artifact: ArtifactDescriptor): ReviewPacketPresetPacket {
  return {
    ...(readMetadataString(artifact.metadata, 'documentId') ? { documentId: readMetadataString(artifact.metadata, 'documentId') } : {}),
    ...(readMetadataString(artifact.metadata, 'documentTitle') ? { documentTitle: readMetadataString(artifact.metadata, 'documentTitle') } : {}),
    ...(readMetadataString(artifact.metadata, 'documentExportArtifactId') ? { documentExportArtifactId: readMetadataString(artifact.metadata, 'documentExportArtifactId') } : {}),
    ...(readMetadataString(artifact.metadata, 'comparisonArtifactId') ? { comparisonArtifactId: readMetadataString(artifact.metadata, 'comparisonArtifactId') } : {}),
    ...(readMetadataString(artifact.metadata, 'judgmentArtifactId') ? { judgmentArtifactId: readMetadataString(artifact.metadata, 'judgmentArtifactId') } : {}),
    ...(readMetadataString(artifact.metadata, 'revealedJudgmentArtifactId') ? { revealedJudgmentArtifactId: readMetadataString(artifact.metadata, 'revealedJudgmentArtifactId') } : {}),
    ...(readMetadataString(artifact.metadata, 'routeDecisionArtifactId') ? { routeDecisionArtifactId: readMetadataString(artifact.metadata, 'routeDecisionArtifactId') } : {}),
    ...(readMetadataString(artifact.metadata, 'routeDecision') ? { routeDecision: readMetadataString(artifact.metadata, 'routeDecision') } : {}),
    ...(readMetadataString(artifact.metadata, 'handoffArtifactId') ? { handoffArtifactId: readMetadataString(artifact.metadata, 'handoffArtifactId') } : {}),
    ...(readMetadataString(artifact.metadata, 'handoffArchiveArtifactId') ? { handoffArchiveArtifactId: readMetadataString(artifact.metadata, 'handoffArchiveArtifactId') } : {}),
    relatedArtifactIds: readMetadataStringList(artifact.metadata, 'relatedArtifactIds'),
    summary: readMetadataString(artifact.metadata, 'summary') || 'review packet preset',
  };
}

export function parsePresetBody(buffer: Buffer): ReviewPacketPresetRecord | null {
  try {
    const parsed = JSON.parse(buffer.toString('utf-8')) as Partial<ReviewPacketPresetRecord>;
    if (parsed.schema !== REVIEW_PACKET_PRESET_SCHEMA || parsed.schemaVersion !== 1 || !parsed.packet) return null;
    const packet = parsed.packet as Partial<ReviewPacketPresetPacket>;
    const refresh = parsed.refresh && typeof parsed.refresh === 'object'
      ? parsed.refresh as Record<string, unknown>
      : null;
    return {
      schema: REVIEW_PACKET_PRESET_SCHEMA,
      schemaVersion: 1,
      presetId: readString(parsed.presetId),
      name: readString(parsed.name) || 'Reviewer packet preset',
      createdAt: readString(parsed.createdAt),
      explicitUserRequest: readString(parsed.explicitUserRequest),
      ...(refresh
        ? {
          refresh: {
            sourceArtifactId: readString(refresh.sourceArtifactId),
            ...(readString(refresh.sourcePresetId)
              ? { sourcePresetId: readString(refresh.sourcePresetId) }
              : {}),
            missingCount: readNumber(refresh.missingCount, 0),
            supersededCount: readNumber(refresh.supersededCount, 0),
            unresolvedCount: readNumber(refresh.unresolvedCount, 0),
          },
        }
        : {}),
      packet: {
        ...(readString(packet.documentId) ? { documentId: readString(packet.documentId) } : {}),
        ...(readString(packet.documentTitle) ? { documentTitle: readString(packet.documentTitle) } : {}),
        ...(readString(packet.documentExportArtifactId) ? { documentExportArtifactId: readString(packet.documentExportArtifactId) } : {}),
        ...(readString(packet.comparisonArtifactId) ? { comparisonArtifactId: readString(packet.comparisonArtifactId) } : {}),
        ...(readString(packet.judgmentArtifactId) ? { judgmentArtifactId: readString(packet.judgmentArtifactId) } : {}),
        ...(readString(packet.revealedJudgmentArtifactId) ? { revealedJudgmentArtifactId: readString(packet.revealedJudgmentArtifactId) } : {}),
        ...(readString(packet.routeDecisionArtifactId) ? { routeDecisionArtifactId: readString(packet.routeDecisionArtifactId) } : {}),
        ...(readString(packet.routeDecision) ? { routeDecision: readString(packet.routeDecision) } : {}),
        ...(readString(packet.handoffArtifactId) ? { handoffArtifactId: readString(packet.handoffArtifactId) } : {}),
        ...(readString(packet.handoffArchiveArtifactId) ? { handoffArchiveArtifactId: readString(packet.handoffArchiveArtifactId) } : {}),
        relatedArtifactIds: readStringList(packet.relatedArtifactIds),
        summary: readString(packet.summary) || 'review packet preset',
      },
      policy: {
        effect: 'save-local-preset-artifact-only',
        documentsChanged: false,
        modelRouteChanged: false,
        handoffArchiveCreated: false,
      },
    };
  } catch {
    return null;
  }
}

export function sourceArtifactId(packet: ReviewPacketPresetPacket): string {
  return packet.revealedJudgmentArtifactId
    || packet.judgmentArtifactId
    || packet.comparisonArtifactId
    || packet.documentExportArtifactId
    || '';
}
