import type { ArtifactStore } from '../../artifacts/index.js';
import { logger } from '../../utils/logger.js';
import { sleep, yieldEvery } from '../cooperative.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import type { KnowledgeStore } from '../store.js';
import { edgeIsActive, homeAssistantSpaceComponent, readHomeAssistantMetadataString } from './helpers.js';
import { refreshHomeGraphDevicePassport } from './generated-pages.js';
import { isHomeGraphPageFactCandidate } from './page-quality.js';
import { readHomeGraphState } from './state.js';

const SYNC_SELF_IMPROVEMENT_INGEST_LIMIT = 0;
const SYNC_SELF_IMPROVEMENT_FAST_SLEEP_MS = 5_000;
const SYNC_SELF_IMPROVEMENT_SLOW_SLEEP_MS = 15_000;

export const HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS = 5_000;

export interface HomeGraphSelfImprovementRuntime {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly semanticService: KnowledgeSemanticService;
  readonly reportBackgroundError: (event: string, error: unknown, metadata: Record<string, unknown>) => void;
}

export async function runHomeGraphSyncSelfImprovementPump(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
  installationId: string,
  signal: AbortSignal,
): Promise<void> {
  for (let round = 0; !signal.aborted; round += 1) {
    const next = await runHomeGraphSyncSelfImprovementRound(runtime, spaceId, installationId, round, signal);
    if (next === undefined) return;
    await sleep(next, { signal });
  }
}

/**
 * One round of post-sync gap repair for a space, then the device pages of the
 * sources it accepted. Returns the delay before the next round, or undefined
 * when there is nothing more to do (or the round stopped).
 */
export async function runHomeGraphSyncSelfImprovementRound(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
  installationId: string,
  round: number,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (signal.aborted) return undefined;
  // A memory-pressure pause stops the pump at the round boundary; the pass
  // below also stops at its next per-gap boundary (stopWhenPaused).
  if (runtime.semanticService.isBackgroundWorkPaused()) {
    logger.info('Home Graph sync self-improvement pump stopped: background knowledge work is paused for memory pressure', { spaceId, round });
    return undefined;
  }
  const result = await runtime.semanticService.selfImprove({
    knowledgeSpaceId: spaceId,
    reason: 'homegraph-sync',
    force: round > 0,
    signal,
  }, { stopWhenPaused: true });
  if (signal.aborted) return undefined;
  if ((result.acceptedSourceIds?.length ?? 0) > 0) {
    await refreshHomeGraphDevicePagesForSourceIds(runtime, spaceId, installationId, result.acceptedSourceIds ?? [], signal);
  }
  if (!shouldContinueHomeGraphSyncSelfImprovement(result)) return undefined;
  return round < 2 ? SYNC_SELF_IMPROVEMENT_FAST_SLEEP_MS : SYNC_SELF_IMPROVEMENT_SLOW_SLEEP_MS;
}

/**
 * Enriches the given sources that have never been enriched, stopping between
 * sources once `deadlineAt` passes. A source that fails is logged and left for
 * the background owners (ingest tail, sync pump, reindex); the caller renders
 * from what is stored.
 */
export async function enrichUnenrichedHomeGraphSources(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
  sourceIds: readonly string[],
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<{ readonly enriched: number; readonly left: number }> {
  const pending = sourceIds.filter((id) => runtime.store.getSemanticEnrichmentState(id) === null);
  let enriched = 0;
  for (const sourceId of pending) {
    if (signal?.aborted || Date.now() >= deadlineAt) break;
    try {
      await runtime.semanticService.enrichSource(sourceId, { knowledgeSpaceId: spaceId, ...(signal ? { signal } : {}) });
      enriched += 1;
    } catch (error) {
      signal?.throwIfAborted();
      runtime.reportBackgroundError('homegraph-passport-enrich', error, { spaceId, sourceId });
    }
  }
  return { enriched, left: pending.length - enriched };
}

export async function enrichAndImproveHomeGraphSource(
  runtime: HomeGraphSelfImprovementRuntime,
  sourceId: string,
  spaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return;
  // Governor backpressure on the 0ms ingest tail: while background knowledge
  // work is paused (or refused at the critical tier) the LLM-backed enrichment
  // defers honestly, the source persists and the next sync/reindex enriches it.
  if (runtime.semanticService.isBackgroundWorkPaused()) {
    logger.info('Home Graph ingest enrichment deferred: background knowledge work is paused for memory pressure', { spaceId, sourceId });
    return;
  }
  const admission = runtime.semanticService.admitBackgroundWork('home-graph ingest enrichment');
  if (!admission.allowed) {
    logger.warn('Home Graph ingest enrichment refused by the memory governor', { spaceId, sourceId, reason: admission.reason });
    return;
  }
  await runtime.semanticService.enrichSource(sourceId, { knowledgeSpaceId: spaceId, signal });
  if (signal?.aborted) return;
  if (!sourceHasSemanticFactCandidates(runtime.store, sourceId, spaceId)) return;
  // Structural candidates trigger refresh; the page reader decides usefulness.
  // Refresh this source's page
  // now; repair-accepted refreshes ride the governed run / next sync pump.
  const installationId = readHomeGraphInstallationIdFromSpace(spaceId);
  if (installationId) {
    await refreshHomeGraphDevicePagesForSourceIds(runtime, spaceId, installationId, [sourceId], signal);
  }
  if (signal?.aborted) return;
  // Self-improvement rides the governed background scheduler, a direct 0ms
  // per-ingest run would bypass the floor, coalescing, zero-gap backoff, and
  // the memory governor's pause (the incident's hot-loop shape).
  runtime.semanticService.queueBackgroundSelfImprove({
    knowledgeSpaceId: spaceId,
    sourceIds: [sourceId],
    reason: 'ingest',
    limit: SYNC_SELF_IMPROVEMENT_INGEST_LIMIT,
  });
}

function sourceHasSemanticFactCandidates(store: KnowledgeStore, sourceId: string, spaceId: string): boolean {
  const state = readHomeGraphState(store, spaceId);
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  return state.edges
    .filter((edge) => edge.fromKind === 'source' && edge.fromId === sourceId && edge.toKind === 'node')
    .map((edge) => nodesById.get(edge.toId))
    .some((node) => Boolean(node && node.kind === 'fact' && isHomeGraphPageFactCandidate(node)));
}

export async function refreshHomeGraphDevicePagesForSourceIds(
  runtime: HomeGraphSelfImprovementRuntime,
  spaceId: string,
  installationId: string,
  sourceIds: readonly string[],
  signal?: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return;
  const wanted = new Set(sourceIds.filter(Boolean));
  // Without named sources there is no way to tell which devices changed, and
  // refreshing every device with a candidate fact costs a judgment pass each.
  if (wanted.size === 0) return;
  const state = readHomeGraphState(runtime.store, spaceId);
  if (signal?.aborted) return;
  const nodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const factIds = new Set<string>();
  const deviceNodeIds = new Set<string>();
  for (const edge of state.edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && wanted.has(edge.fromId)) {
      const node = nodesById.get(edge.toId);
      if (node?.kind === 'ha_device') deviceNodeIds.add(node.id);
      if (node?.kind === 'fact') factIds.add(node.id);
    }
    if (edge.fromKind === 'node' && edge.toKind === 'source' && wanted.has(edge.toId)) {
      const node = nodesById.get(edge.fromId);
      if (node?.kind === 'ha_device') deviceNodeIds.add(node.id);
      if (node?.kind === 'fact') factIds.add(node.id);
    }
  }
  for (const edge of state.edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'node' && edge.toKind === 'node' && factIds.has(edge.fromId) && edge.relation === 'describes') {
      const device = nodesById.get(edge.toId);
      if (device?.kind === 'ha_device') deviceNodeIds.add(device.id);
    }
  }
  for (const [index, deviceNodeId] of [...deviceNodeIds].entries()) {
    if (signal?.aborted) return;
    const device = nodesById.get(deviceNodeId);
    if (!device) continue;
    const deviceId = readHomeAssistantMetadataString(device, 'objectId', 'deviceId') ?? device.id;
    try {
      if (signal?.aborted) return;
      await refreshHomeGraphDevicePassport({
        store: runtime.store,
        artifactStore: runtime.artifactStore,
        spaceId,
        installationId,
        input: {
          knowledgeSpaceId: spaceId,
          deviceId,
          metadata: { automation: 'semantic-repair-refresh' },
        },
        signal,
      });
      if (signal?.aborted) return;
    } catch (error) {
      if (signal?.aborted) return;
      runtime.reportBackgroundError('homegraph-refresh-device-page', error, {
        spaceId,
        installationId,
        deviceId,
      });
    }
    await yieldEvery(index, 2);
  }
}

export function shouldContinueHomeGraphSyncSelfImprovement(result: {
  readonly createdGaps?: number | undefined;
  readonly truncated?: boolean | undefined;
  readonly budgetExhausted?: boolean | undefined;
  readonly processedGaps?: number | undefined;
  readonly repairableGaps: number;
  readonly queuedTasks: number;
  readonly closedGaps: number;
  readonly acceptedSourceIds?: readonly string[] | undefined;
  readonly promotedFactCount?: number | undefined;
  readonly taskIds: readonly string[];
}): boolean {
  const madeProgress = result.closedGaps > 0
    || (result.createdGaps ?? 0) > 0
    || result.queuedTasks > 0
    || result.taskIds.length > 0
    || (result.acceptedSourceIds?.length ?? 0) > 0
    || (result.promotedFactCount ?? 0) > 0
    || (result.processedGaps ?? 0) > 0;
  if (!madeProgress) return false;
  return result.truncated === true || result.budgetExhausted === true || result.repairableGaps > 0 || result.queuedTasks > 0;
}

export function readHomeGraphInstallationIdFromSpace(spaceId: string): string | undefined {
  return homeAssistantSpaceComponent(spaceId);
}
