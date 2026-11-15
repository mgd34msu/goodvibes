import { snapshotNodeInput } from '../activation/projection.js';
import { prepareKnowledgeScopeSelection, KnowledgeScopeSelectionHeldError } from '../scope-selection.js';
import { captureHomeGraphRows } from './rows-current.js';
import type { KnowledgeStore } from '../store.js';
import { renderHomeGraphMap } from './rendering.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { renderHomeGraphState } from './state.js';
import type { HomeGraphMapInput, HomeGraphMapResult } from './types.js';

export async function mapHomeGraph(input: HomeGraphMapInput & {
  readonly store: KnowledgeStore;
  readonly assertCurrent?: (() => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<HomeGraphMapResult> {
  const { store, assertCurrent: callerCurrent, signal, ...request } = input;
  const options = snapshotNodeInput(request);
  const requestCurrent = () => {
    if (signal?.aborted) throw new KnowledgeScopeSelectionHeldError('aborted');
    callerCurrent?.();
  };
  requestCurrent();
  await store.init();
  requestCurrent();
  const { spaceId } = resolveReadableHomeGraphSpace(store, options);
  const state = renderHomeGraphState(store, spaceId, 'Home Graph Map');
  // The map is a read: one generation compare of the rows it shows (and the
  // links at them) tells whether what it renders is still what is stored.
  const rowsCurrent = captureHomeGraphRows(store, { sources: state.sources.map(source => source.id), nodes: state.nodes.map(node => node.id),
    edgeEndpoints: [...state.sources.map(source => `source:${source.id}`), ...state.nodes.map(node => `node:${node.id}`)] },
  () => new KnowledgeScopeSelectionHeldError('stale'));
  const assertCurrent = () => { requestCurrent(); rowsCurrent(); };
  const selection = await prepareKnowledgeScopeSelection(store, { knowledgeSpaceId: spaceId }, {
    sourceIds: state.sources.map(source => source.id), nodeIds: state.nodes.map(node => node.id), issueIds: state.issues.map(issue => issue.id), assertCurrent, signal,
  });
  const selectedEdgeIds = new Set(selection.edges.map(edge => edge.id));
  const edgesCurrent = selection.retainEdges(state.edges.filter(edge => selectedEdgeIds.has(edge.id)), {
    sourceIds: state.sources.map(source => source.id), nodeIds: state.nodes.map(node => node.id),
  });
  const result = renderHomeGraphMap(state, selection, {
    ...options,
    ha: {
      objectKinds: preferNonEmpty(options.ha?.objectKinds, options.objectKinds),
      entityIds: preferNonEmpty(options.ha?.entityIds, options.entityIds),
      deviceIds: preferNonEmpty(options.ha?.deviceIds, options.deviceIds),
      areaIds: preferNonEmpty(options.ha?.areaIds, options.areaIds),
      integrationIds: preferNonEmpty(options.ha?.integrationIds, options.integrationIds),
      integrationDomains: preferNonEmpty(options.ha?.integrationDomains, options.integrationDomains),
      domains: preferNonEmpty(options.ha?.domains, options.domains),
      deviceClasses: preferNonEmpty(options.ha?.deviceClasses, options.deviceClasses),
      labels: preferNonEmpty(options.ha?.labels, options.labels),
    },
    knowledgeSpaceId: spaceId,
  });
  assertCurrent(); selection.assertCurrent(); edgesCurrent();
  return result;
}

function preferNonEmpty<T>(primary: readonly T[] | undefined, fallback: readonly T[] | undefined): readonly T[] | undefined {
  return primary && primary.length > 0 ? primary : fallback;
}
