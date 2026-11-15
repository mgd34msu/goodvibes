import type { KnowledgeStore } from '../store.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { readHomeGraphState } from './state.js';
import { isGeneratedPageSource } from './helpers.js';
import { HOME_GRAPH_CAPABILITIES, type HomeGraphSpaceInput, type HomeGraphStatus } from './types.js';
import { ACTIVE_REFINEMENT_STATES, STALE_ACTIVE_TASK_MS } from '../types.js';

export async function getHomeGraphStatus(
  store: KnowledgeStore,
  input: HomeGraphSpaceInput = {},
): Promise<HomeGraphStatus> {
  await store.init();
  const { spaceId, installationId } = resolveReadableHomeGraphSpace(store, input);
  const state = readHomeGraphState(store, spaceId);
  const snapshotSources = state.sources
    .filter((source) => source.metadata.homeGraphSourceKind === 'snapshot')
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const now = Date.now();
  const refinementTasks = store.listRefinementTasks(10_000, { spaceId });
  const openIssueCount = state.issues.filter((issue) => issue.status === 'open').length;
  const activeRefinementTaskCount = refinementTasks.filter((task) => ACTIVE_REFINEMENT_STATES.has(task.state) && now - task.updatedAt < STALE_ACTIVE_TASK_MS).length;
  const extracted = new Set(state.extractions.map((extraction) => extraction.sourceId));
  const pendingSourceCount = state.sources.filter((source) => source.metadata.homeGraphSourceKind !== 'snapshot'
    && !isGeneratedPageSource(source) && (source.status === 'pending' || (source.status === 'indexed' && !!source.artifactId && !extracted.has(source.id)))).length;
  // Readiness is what blocks an answer: no snapshot yet, or documents not yet read.
  const readinessState = state.sources.length === 0 && state.nodes.length === 0
    ? 'empty'
    : snapshotSources.length === 0 || pendingSourceCount > 0
      ? 'needs_sources'
      : 'ready';
  return {
    ok: true,
    spaceId,
    installationId,
    sourceCount: state.sources.length,
    nodeCount: state.nodes.length,
    edgeCount: state.edges.length,
    issueCount: state.issues.length,
    extractionCount: state.extractions.length,
    capabilities: HOME_GRAPH_CAPABILITIES,
    readiness: {
      state: readinessState,
      openIssueCount,
      activeRefinementTaskCount,
      pendingSourceCount,
    },
    ...(snapshotSources[0]?.lastCrawledAt ? { lastSnapshotAt: snapshotSources[0].lastCrawledAt } : {}),
  };
}
