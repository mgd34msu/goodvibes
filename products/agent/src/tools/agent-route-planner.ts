import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import {
  channelTargetNamedIds,
  modelProviderNamedIds,
  planTaskRoute,
  type TaskRouteArgs,
  type TaskRouteCandidate,
  type TaskRouteCatalogRanking,
  type TaskRouteDraft,
  type TaskRoutePlan,
} from '@goodvibes-jev/engine/platform/platform/routing';
import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import type { CommandContext } from '../input/command-registry.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../input/agent-workspace-categories.ts';
import { HARNESS_MODE_DESCRIPTORS, listHarnessModes } from './agent-harness-mode-catalog.ts';
import { captureCatalogMethods, prepareHarnessCatalog, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureModelReadingInput, captureModelReadingSnapshotGuard, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { listWorkspaceActions } from './agent-harness-workspace-actions.ts';
import { externalMemoryLiveProviderRecords, externalMemoryProviderCatalog, externalMemoryReceiptEvidence } from './agent-harness-memory-external-providers.ts';

/** Native declaration trees have no mutable production consumers. The workspace
 * categories freeze themselves where they are declared. */
function freezeRouteDeclarations(value: unknown, visited = new Set<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (visited.has(value)) return;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new ToolInputProjectionError('held');
  }
  visited.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor) || typeof descriptor.value === 'function') throw new ToolInputProjectionError('held');
    freezeRouteDeclarations(descriptor.value, visited);
  }
  Object.freeze(value);
}
freezeRouteDeclarations(HARNESS_MODE_DESCRIPTORS);
const assertDeclarationMethods = captureCatalogMethods(Array.prototype, ['flatMap', 'map', 'filter', 'slice', 'find', 'sort']);

export type AgentRoutePlannerArgs = TaskRouteArgs;
export type AgentRouteCandidate = TaskRouteCandidate;

export interface AgentTaskRouteSources {
  readonly channelRegistry?: Parameters<typeof channelTargetNamedIds>[0];
}

type RouteRecord = Record<string, unknown>;
type RouteDescription = { readonly id: string; readonly description: string; readonly evidence: unknown };

/** Workspace evidence comes from the frozen native declarations, so it is built once. */
let workspaceEvidenceCatalog: ReadonlyMap<string, unknown> | undefined;
function workspaceEvidence(): ReadonlyMap<string, unknown> {
  if (workspaceEvidenceCatalog) return workspaceEvidenceCatalog;
  const evidence = new Map<string, unknown>();
  for (const category of AGENT_WORKSPACE_CATEGORIES) for (const action of category.actions) {
    evidence.set(action.id, { category: { id: category.id, group: category.group, label: category.label,
      summary: category.summary, detail: category.detail }, action });
  }
  return workspaceEvidenceCatalog = evidence;
}

/** One stable describer per catalog, so a prepared catalog is recognized by the ranking reader. */
const describeModeRecord = (record: RouteRecord): RouteDescription => {
  if (typeof record.id !== 'string') throw new ToolInputProjectionError('held');
  return { id: record.id, description: JSON.stringify(record), evidence: record };
};
const describeWorkspaceRecord = (record: RouteRecord): RouteDescription => {
  if (typeof record.id !== 'string') throw new ToolInputProjectionError('held');
  return { id: record.id, description: JSON.stringify(record), evidence: workspaceEvidence().get(record.id) ?? record };
};

/** A prepared catalog is the frozen capture of exactly these records; identical records reuse it. */
const preparedRouteCatalogs = new Map<string, readonly RouteRecord[]>();
function preparedRouteCatalog(kind: 'modes' | 'workspace', records: readonly RouteRecord[]): readonly RouteRecord[] {
  const key = `${kind}:${JSON.stringify(records)}`;
  const found = preparedRouteCatalogs.get(key);
  if (found) return found;
  const prepared = prepareHarnessCatalog(records, kind === 'modes' ? describeModeRecord : describeWorkspaceRecord);
  if (preparedRouteCatalogs.size >= 4) preparedRouteCatalogs.delete(preparedRouteCatalogs.keys().next().value!);
  preparedRouteCatalogs.set(key, prepared);
  return prepared;
}

/** Rank complete locally screened catalogs through the canonical public reader. */
async function rankCatalog(
  request: string,
  kind: 'modes' | 'workspace',
  records: readonly RouteRecord[],
  options: CatalogRankingOptions,
): Promise<TaskRouteCatalogRanking> {
  const result = await rankHarnessCatalog(preparedRouteCatalog(kind, records), request,
    kind === 'modes' ? describeModeRecord : describeWorkspaceRecord, 'agent.task-route.catalog', { ...options, requirePreservedSource: true });
  return { records, ranked: result.judgments };
}

/** The installed runtime judgment port owns every reading; never install a fallback here. */
export async function planAgentTaskRoute(
  context: CommandContext,
  args: AgentRoutePlannerArgs,
  sources: AgentTaskRouteSources = {},
  options: CatalogRankingOptions = {},
): Promise<TaskRoutePlan> {
  const captured = captureModelReadingInput(args);
  const request = (typeof captured.query === 'string' ? captured.query.trim() : '') || (typeof captured.target === 'string' ? captured.target.trim() : '');
  if (!request) return planTaskRoute(captured);
  const modes = captureModelReadingInput(HARNESS_MODE_DESCRIPTORS);
  const workspace = captureModelReadingInput(await listWorkspaceActions(context, { limit: 1000 }, options));
  freezeRouteDeclarations(workspace);
  const assertArgs = captureModelReadingSnapshotGuard(captured);
  const assertModes = captureModelReadingSnapshotGuard(modes);
  const assertCategories = captureModelReadingSnapshotGuard(captureModelReadingInput(AGENT_WORKSPACE_CATEGORIES));
  const assertContext = captureCatalogMethods(context, ['provider']);
  const provider = context.provider;
  const assertProvider = provider ? captureCatalogMethods(provider, ['providerRegistry']) : undefined;
  const providers = context.provider?.providerRegistry;
  const assertSources = captureCatalogMethods(sources, ['channelRegistry']);
  const channels = sources.channelRegistry;
  const assertSourcesCurrent = () => {
    assertDeclarationMethods(); assertContext(); assertProvider?.(); assertSources();
    assertArgs(args); assertModes(HARNESS_MODE_DESCRIPTORS);
    assertCategories(AGENT_WORKSPACE_CATEGORIES);
    if (context.provider !== provider || provider?.providerRegistry !== providers || sources.channelRegistry !== channels) throw new ToolInputProjectionError('held');
  };
  options.retainCurrent?.(assertSourcesCurrent, 'agent.task-route.sources');
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); assertSourcesCurrent(); };
  assertCurrent();
  return withModelReadingSource(captured, { ...options, assertCurrent }, async (protectedArgs, readingOptions) => {
    assertCurrent();
    const memory = externalMemoryProviderCatalog(await externalMemoryLiveProviderRecords(context, readingOptions), await externalMemoryReceiptEvidence(context, readingOptions));
    readingOptions.assertCurrent?.();
    const envelope = await listHarnessModes({ limit: 1000 }, readingOptions);
    readingOptions.assertCurrent?.();
    const modes: Record<string, unknown>[] = [];
    if (!Array.isArray(envelope.modes)) throw new ToolInputProjectionError('held');
    for (const mode of envelope.modes) {
      if (!mode || typeof mode !== 'object' || Array.isArray(mode)) throw new ToolInputProjectionError('held');
      modes.push(Object.fromEntries(Object.entries(mode)));
    }
    freezeRouteDeclarations(modes);
    // The canonical planner's authority already fences readingOptions before
    // and after its own source projection. Preserve that complete authority.
    const rankOptions = (current: JudgmentReadingOptions = {}): CatalogRankingOptions => ({ ...readingOptions,
      ...(current.signal ? { signal: current.signal } : {}),
      assertCurrent: current.assertCurrent ?? readingOptions.assertCurrent });
    const plan = await planTaskRoute(protectedArgs, {
      namedIds: {
        ...(providers ? { modelProvider: () => modelProviderNamedIds(providers) } : {}),
        ...(channels ? { channelTarget: () => channelTargetNamedIds(channels) } : {}),
        memoryProvider: () => memory.map(({ id, label }) => ({ id, names: [label, id] })),
      },
      workspaceMatches: (currentRequest, _limit, current) => rankCatalog(currentRequest, 'workspace', workspace, rankOptions(current)),
      modeMatches: (currentRequest, _limit, current) => rankCatalog(currentRequest, 'modes', modes, rankOptions(current)),
    }, readingOptions);
    readingOptions.assertCurrent?.();
    return plan;
  });
}
