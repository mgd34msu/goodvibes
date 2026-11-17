import { requireDecisionFeature } from '../../runtime/decision-policy.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import { REPAIRS_GAP_RELATION } from './types.js';
import type { ArtifactDescriptor } from '../../artifacts/types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import { isGeneratedPageSource, readHomeAssistantMetadataString, uniqueStrings } from './helpers.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { readHomeGraphSearchState } from './search.js';
import { readHomeGraphState } from './state.js';
import { homeGraphExtractionNeedsRepair } from './search.js';
import { knowledgeExtractionIsReadable } from '../extraction-policy.js';
import {
  HOME_GRAPH_PAGE_POLICY_VERSION,
  refreshHomeGraphDevicePassport,
  type HomeGraphPageContext,
} from './generated-pages.js';
import type {
  HomeGraphAutoLinkResult,
} from './auto-link.js';
import type {
  HomeGraphGeneratedPagesSummary,
  HomeGraphReindexInput,
  HomeGraphReindexResult,
  HomeGraphStageOutcome,
} from './types.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/native-error-summary.js';

export interface HomeGraphReindexContext {
  readonly signal?: AbortSignal | undefined;
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly semanticService?: KnowledgeSemanticService | undefined;
  readonly extract: (
    source: KnowledgeSourceRecord,
    artifact: ArtifactDescriptor,
    spaceId: string,
    installationId: string,
  ) => Promise<KnowledgeExtractionRecord | undefined>;
  readonly autoLinkExistingSources: (
    spaceId: string,
    installationId: string,
    sourceIds?: readonly string[],
  ) => Promise<readonly HomeGraphAutoLinkResult[]>;
  readonly refreshQualityIssues: (spaceId: string, installationId: string) => Promise<readonly KnowledgeIssueRecord[]>;
}

export async function runHomeGraphReindex(
  context: HomeGraphReindexContext,
  input: HomeGraphReindexInput = {},
): Promise<HomeGraphReindexResult> {
  requireDecisionFeature('semantic Home Graph reindexing');
  context.signal?.throwIfAborted();
  await context.store.init();
  context.signal?.throwIfAborted();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(context.store, input);
  const state = readHomeGraphSearchState(context.store, spaceId);
  const allSourceCount = readHomeGraphState(context.store, spaceId).sources.length;
  // One budget for the whole call: every stage starts only while it lasts and
  // reports what it left for the next run.
  const maxRunMs = clampPositive(input.maxRunMs, 90_000, 15_000, 180_000);
  const deadlineAt = Date.now() + maxRunMs;
  const remaining = () => deadlineAt - Date.now();
  const sources = state.sources.filter((source) => !isGeneratedPageSource(source));
  const skippedGeneratedPageArtifactCount = Math.max(0, allSourceCount - sources.length);
  const reindex = await reindexHomeGraphSources({
    spaceId,
    sources,
    extractionBySourceId: state.extractionBySourceId,
    artifactStore: context.artifactStore,
    deadlineAt,
    limit: input.limit,
    extract: (source, artifact) => context.extract(source, artifact, spaceId, installationId),
    signal: context.signal,
  });
  await yieldToEventLoop();
  context.signal?.throwIfAborted();
  const relinkedSourceIds = reindex.sources.map((source) => source.id);
  const wantsLink = relinkedSourceIds.length > 0 || input.force === true;
  const link = await runStage(context.signal, remaining, wantsLink, () => context.autoLinkExistingSources(spaceId, installationId, input.force === true ? undefined : relinkedSourceIds));
  const linked = link.value ?? [];
  await yieldToEventLoop();
  context.signal?.throwIfAborted();
  const changedSourceIds = uniqueStrings([
    ...reindex.sources.map((source) => source.id),
    ...linked.map((item) => item.edge.fromKind === 'source' ? item.edge.fromId : undefined),
  ]);
  const forcedSourceIds = input.force === true && changedSourceIds.length === 0
    ? sources.slice(0, clampPositive(input.semanticLimit, 8, 1, 24)).map((source) => source.id)
    : [];
  const semanticSourceIds = changedSourceIds.length > 0 ? changedSourceIds : forcedSourceIds;
  const semanticService = context.semanticService;
  const semanticStage = await runStage(context.signal, remaining, semanticSourceIds.length > 0 && semanticService !== undefined, () => semanticService!.reindex({
    knowledgeSpaceId: spaceId,
    sourceIds: semanticSourceIds,
    limit: semanticSourceIds.length,
    maxRunMs: Math.max(1_000, Math.min(remaining(), clampPositive(input.semanticMaxRunMs, 20_000, 5_000, 45_000))),
    force: input.force === true,
    signal: context.signal,
  }));
  await yieldToEventLoop();
  context.signal?.throwIfAborted();
  const quality = await runStage(context.signal, remaining, true, () => context.refreshQualityIssues(spaceId, installationId));
  await yieldToEventLoop();
  context.signal?.throwIfAborted();
  const pages = await runStage(context.signal, remaining, input.refreshPages !== false, () => refreshHomeGraphPagesForSources({
    store: context.store,
    artifactStore: context.artifactStore,
    spaceId,
    installationId,
    signal: context.signal,
  }, readHomeGraphState(context.store, spaceId).sources, changedSourceIds, clampPositive(input.generatedPageLimit, 256, 1, 512), deadlineAt));
  context.signal?.throwIfAborted();
  const generated = pages.value ?? emptyGeneratedPagesSummary();
  const pagesOutcome = pages.outcome.status === 'done' && (generated.deferredDevicePassports ?? 0) > 0
    ? { status: 'deferred' as const, reason: `${generated.deferredDevicePassports} device page(s) did not fit in the run budget` }
    : pages.outcome;
  const refreshedGeneratedPageCount = generated.devicePassports + generated.roomPages;
  const budgetExhausted = reindex.budgetExhausted === true || [link, semanticStage, quality, pages].some((stage) => stage.outcome.status === 'deferred')
    || pagesOutcome.status === 'deferred';
  return {
    ...reindex,
    truncated: reindex.truncated === true || budgetExhausted,
    budgetExhausted,
    changedSourceCount: changedSourceIds.length,
    forcedSourceCount: forcedSourceIds.length,
    skippedGeneratedPageArtifactCount,
    refreshedGeneratedPageCount,
    generatedPagePolicyVersion: HOME_GRAPH_PAGE_POLICY_VERSION,
    ...(linked.length > 0 ? { linked } : {}),
    ...(semanticStage.value ? { semantic: semanticStage.value } : {}),
    ...(quality.value ? { qualityIssues: quality.value } : {}),
    generated,
    stages: { link: link.outcome, semantic: semanticStage.outcome, quality: quality.outcome, pages: pagesOutcome },
  };
}

/**
 * Runs one optional stage of a reindex. A stage that is not wanted is skipped,
 * one that would start after the budget is deferred, and one that is held or
 * fails reports why; only a cancelled call throws.
 */
async function runStage<T>(signal: AbortSignal | undefined, remaining: () => number, wanted: boolean,
  run: () => Promise<T>): Promise<{ readonly value?: T; readonly outcome: HomeGraphStageOutcome }> {
  if (!wanted) return { outcome: { status: 'skipped' } };
  if (remaining() <= 0) return { outcome: { status: 'deferred', reason: 'the run budget was spent; run reindex again to finish' } };
  try { return { value: await run(), outcome: { status: 'done' } }; }
  catch (error) {
    signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn('Home Graph reindex stage did not finish', { error: summarizeError(error) });
    return { outcome: { status: 'held', reason } };
  }
}

/**
 * Re-extracts the documents whose stored extraction needs it. Which documents
 * those are is read from the stored extractor version and artifact of every
 * document in one pass, so an outdated extraction anywhere in the space is
 * found; only the re-extraction itself spends the run budget. A current
 * extraction that found no readable text is final and counted in
 * `notExtractable`.
 */
export async function reindexHomeGraphSources(input: {
  readonly signal?: AbortSignal | undefined;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly extractionBySourceId: ReadonlyMap<string, KnowledgeExtractionRecord>;
  readonly artifactStore: ArtifactStore;
  readonly extract: (source: KnowledgeSourceRecord, artifact: ArtifactDescriptor) => Promise<KnowledgeExtractionRecord | undefined>;
  readonly limit?: number | undefined;
  readonly deadlineAt?: number | undefined;
}): Promise<HomeGraphReindexResult> {
  const sources: KnowledgeSourceRecord[] = [];
  const failures: Array<{ readonly sourceId: string; readonly error: string }> = [];
  const withArtifact = input.sources.filter((source) => typeof source.artifactId === 'string' && source.artifactId.length > 0);
  const needing = withArtifact.filter((source) => homeGraphExtractionNeedsRepair(input.extractionBySourceId.get(source.id), source.artifactId));
  const needingIds = new Set(needing.map((source) => source.id));
  // Current extractions that found no readable text are final; they are counted, not re-read.
  let notExtractable = withArtifact.filter((source) => !needingIds.has(source.id)
    && !knowledgeExtractionIsReadable(input.extractionBySourceId.get(source.id))).length;
  const scanned = withArtifact.length;
  let skipped = scanned - needing.length;
  const repairs = needing.slice(0, clampPositive(input.limit, needing.length, 1, 10_000));
  let reparsed = 0;
  let failed = 0;
  let attempted = 0;
  let budgetExhausted = false;
  for (const [index, source] of repairs.entries()) {
    await yieldEvery(index);
    input.signal?.throwIfAborted();
    if (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt) {
      budgetExhausted = true;
      break;
    }
    attempted += 1;
    const artifactId = source.artifactId!;
    const artifact = input.artifactStore.get(artifactId);
    if (!artifact) {
      if (isGeneratedPageSource(source)) {
        skipped += 1;
        continue;
      }
      failed += 1;
      failures.push({ sourceId: source.id, error: `Unknown artifact: ${artifactId}` });
      continue;
    }
    const extraction = await input.extract(source, artifact);
    input.signal?.throwIfAborted();
    if (!extraction) {
      failed += 1;
      failures.push({ sourceId: source.id, error: 'Artifact extraction failed.' });
      continue;
    }
    reparsed += 1;
    if (!knowledgeExtractionIsReadable(extraction)) notExtractable += 1;
    sources.push(source);
    await yieldToEventLoop();
  }
  const deferred = needing.length - attempted;
  return { ok: true, spaceId: input.spaceId, scanned, reparsed, skipped, failed, notExtractable, sources, failures,
    truncated: deferred > 0, budgetExhausted, deferred };
}

async function refreshHomeGraphPagesForSources(
  context: HomeGraphPageContext,
  sources: readonly KnowledgeSourceRecord[],
  sourceIds: readonly string[],
  limit: number,
  deadlineAt: number,
): Promise<HomeGraphGeneratedPagesSummary> {
  const summary = emptyGeneratedPagesSummary();
  const state = readHomeGraphState(context.store, context.spaceId);
  const wanted = uniqueStrings([
    ...devicesLinkedToSources(state, sourceIds),
    ...devicesWithStaleGeneratedPages(state, sources),
  ]);
  const devices = wanted.slice(0, limit);
  summary.deferredDevicePassports = wanted.length - devices.length;
  if (devices.length === 0) return summary;
  for (const [index, deviceId] of devices.entries()) {
    await yieldEvery(index, 2);
    context.signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) {
      summary.deferredDevicePassports += devices.length - index;
      break;
    }
    try {
      const page = await refreshHomeGraphDevicePassport({
        ...context,
        input: {
          knowledgeSpaceId: context.spaceId,
          deviceId,
          metadata: { automation: 'reindex' },
        },
      });
      summary.devicePassports += 1;
      if (page.artifactCreated) summary.artifacts += 1;
      if (page.source) summary.sources += 1;
    } catch (error) {
      context.signal?.throwIfAborted();
      summary.errors.push({
        kind: 'device-passport',
        targetId: deviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await yieldToEventLoop();
  }
  return summary;
}

function devicesLinkedToSources(
  state: ReturnType<typeof readHomeGraphState>,
  sourceIds: readonly string[],
): string[] {
  const wantedSources = new Set(sourceIds);
  if (wantedSources.size === 0) return [];
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const factIds = new Set<string>();
  const deviceIds = new Set<string>();
  for (const edge of state.edges) {
    if (edge.fromKind !== 'source' || !wantedSources.has(edge.fromId) || edge.toKind !== 'node') continue;
    const node = nodesById.get(edge.toId);
    if ((edge.relation === 'source_for' || edge.relation === 'has_manual' || edge.relation === REPAIRS_GAP_RELATION) && node?.kind === 'ha_device') {
      const deviceId = readHomeAssistantMetadataString(node, 'objectId', 'deviceId') ?? node.id;
      deviceIds.add(deviceId);
    }
    if (edge.relation === 'supports_fact' && node?.kind === 'fact') factIds.add(node.id);
  }
  for (const edge of state.edges) {
    if (edge.fromKind !== 'node' || !factIds.has(edge.fromId) || edge.toKind !== 'node' || edge.relation !== 'describes') continue;
    const device = nodesById.get(edge.toId);
    if (device?.kind === 'ha_device') deviceIds.add(readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id);
  }
  return [...deviceIds];
}

function devicesWithStaleGeneratedPages(
  state: ReturnType<typeof readHomeGraphState>,
  sources: readonly KnowledgeSourceRecord[],
): string[] {
  const stalePageIds = new Set(sources
    .filter(isGeneratedPageSource)
    .filter((source) => source.metadata.projectionKind === 'device-passport')
    .filter((source) => source.metadata.pagePolicyVersion !== HOME_GRAPH_PAGE_POLICY_VERSION)
    .map((source) => source.id));
  if (stalePageIds.size === 0) return [];
  return state.edges
    .filter((edge) => edge.fromKind === 'source' && stalePageIds.has(edge.fromId) && edge.toKind === 'node')
    .filter((edge) => edge.relation === 'source_for')
    .map((edge) => state.nodes.find((node) => node.id === edge.toId && node.kind === 'ha_device_passport'))
    .filter((passport): passport is KnowledgeNodeRecord => Boolean(passport))
    .map((passport) => readHomeAssistantMetadataString(passport, 'objectId', 'deviceId'))
    .filter((deviceId): deviceId is string => Boolean(deviceId));
}

function emptyGeneratedPagesSummary(): {
  devicePassports: number;
  roomPages: number;
  artifacts: number;
  sources: number;
  deferredDevicePassports: number;
  errors: { kind: 'device-passport' | 'room-page'; targetId: string; error: string }[];
} {
  return { devicePassports: 0, roomPages: 0, artifacts: 0, sources: 0, deferredDevicePassports: 0, errors: [] };
}

function clampPositive(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  const effective = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, Math.trunc(effective)));
}
