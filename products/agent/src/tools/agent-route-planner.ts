import {
  channelTargetNamedIds,
  modelProviderNamedIds,
  planTaskRoute,
  type TaskRouteArgs,
  type TaskRouteCandidate,
  type TaskRoutePlan,
} from '@goodvibes/engine/platform/platform/routing';
import type { JudgmentReadingOptions } from '@goodvibes/engine/errors';
import type { CommandContext } from '../input/command-registry.ts';
import { listHarnessModes } from './agent-harness-mode-catalog.ts';
import { prepareHarnessCatalog, rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes/engine/terminal-shell/agent-turn/catalog-ranking';
import { captureModelReadingInput, withModelReadingSource } from './agent-harness-model-reading-source.ts';
import { externalMemoryProviders } from './agent-harness-memory-external-providers.ts';

export type AgentRoutePlannerArgs = TaskRouteArgs;
export type AgentRouteCandidate = TaskRouteCandidate;

export interface AgentTaskRouteSources {
  readonly channelRegistry?: Parameters<typeof channelTargetNamedIds>[0];
}

type RouteRecord = Record<string, unknown>;

/** A catalog row is ranked by what it is called and what it does: id, label, category and summary. */
const describeRouteRecord = (record: RouteRecord) => ({
  id: String(record.id),
  description: [record.id, record.label, record.category, record.family, record.summary]
    .filter((part): part is string => typeof part === 'string' && part.length > 0).join(' - '),
});

/**
 * The catalog is built from the product's own declarations, so a row's
 * description is the same whenever its id is: the prepared rows are kept
 * and reused while the id list is unchanged (one join of ids per call).
 */
const preparedRouteCatalogs = new Map<'modes', { readonly ids: string; readonly rows: readonly RouteRecord[] }>();
function preparedRouteCatalog(kind: 'modes', records: readonly RouteRecord[]): readonly RouteRecord[] {
  const ids = records.map(record => String(record.id)).join('\n');
  const found = preparedRouteCatalogs.get(kind);
  if (found?.ids === ids) return found.rows;
  const rows = prepareHarnessCatalog(records, describeRouteRecord);
  preparedRouteCatalogs.set(kind, { ids, rows });
  return rows;
}

/**
 * Ranks one catalog in code (the Classic ranker over id, label and summary,
 * no request). Only when the caller asked for parameters is the top of that
 * list read once more by the decision model. Matches are the current records.
 */
async function catalogMatches(request: string, kind: 'modes', records: readonly RouteRecord[],
  semantic: boolean, options: CatalogRankingOptions): Promise<readonly RouteRecord[]> {
  const byId = new Map(records.map(record => [String(record.id), record]));
  const result = await rankHarnessCatalog(preparedRouteCatalog(kind, records), request, describeRouteRecord,
    'agent.task-route.catalog', { ...options, semantic });
  return result.matches.flatMap(match => {
    const record = byId.get(match.id ?? String(match.entry.id));
    return record ? [record] : [];
  });
}

/** The installed runtime judgment port owns the route selection and slot readings; the catalogs are ranked in code. */
export async function planAgentTaskRoute(
  context: CommandContext,
  args: AgentRoutePlannerArgs,
  sources: AgentTaskRouteSources = {},
  options: CatalogRankingOptions = {},
): Promise<TaskRoutePlan> {
  const captured = captureModelReadingInput(args);
  const request = (typeof captured.query === 'string' ? captured.query.trim() : '') || (typeof captured.target === 'string' ? captured.target.trim() : '');
  if (!request) return planTaskRoute(captured);
  const semantic = captured.includeParameters === true;
  const providers = context.provider?.providerRegistry;
  const channels = sources.channelRegistry;
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  return withModelReadingSource(captured, options, async (protectedArgs, readingOptions) => {
    const [memory, envelope] = await Promise.all([
      externalMemoryProviders(context, readingOptions),
      listHarnessModes({ limit: 1000 }, readingOptions),
    ]);
    const modes = Array.isArray(envelope.modes) ? envelope.modes.filter((mode): mode is RouteRecord => !!mode && typeof mode === 'object' && !Array.isArray(mode)) : [];
    const rankOptions = (current: JudgmentReadingOptions = {}): CatalogRankingOptions => ({ ...readingOptions,
      ...(current.signal ? { signal: current.signal } : {}),
      assertCurrent: current.assertCurrent ?? readingOptions.assertCurrent });
    return planTaskRoute(protectedArgs, {
      namedIds: {
        ...(providers ? { modelProvider: () => modelProviderNamedIds(providers) } : {}),
        ...(channels ? { channelTarget: () => channelTargetNamedIds(channels) } : {}),
        memoryProvider: () => memory.map(({ id, label }) => ({ id, names: [label, id] })),
      },
      modeMatches: (currentRequest, _limit, current) => catalogMatches(currentRequest, 'modes', modes, semantic, rankOptions(current)),
    }, readingOptions);
  });
}
