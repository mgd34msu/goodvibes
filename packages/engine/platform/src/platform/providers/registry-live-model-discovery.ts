/**
 * Provider-native live model discovery, extracted from ProviderRegistry to
 * keep registry.ts under its line-cap ceiling, mirroring the extraction
 * pattern already used by registry-catalog-lifecycle.ts and
 * registry-models.ts.
 *
 * Owns the `providerNativeModels` bucket: model definitions synthesized
 * directly from a provider's own `models` list (populated either
 * synchronously at registration from a dated-static baseline, or later via
 * `refreshModels()`), independent of the shared third-party model catalog.
 */

import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import type { LLMProvider } from './interface.js';
import type { ModelDefinition } from './registry-types.js';
import {
  buildProviderNativeModelDefinition,
  type LiveModelDiscoveryResult,
} from './live-model-discovery.js';

export type ProviderRefreshableModel = Pick<LLMProvider, 'name'> &
  Partial<{ refreshModels: (force?: boolean, options?: { skipUnavailableLocal?: boolean }) => Promise<LiveModelDiscoveryResult> }>;

/**
 * Seed `providerNativeModels` for one provider from its current `.models`
 * list. Called at registration time (before any async `refreshModels()` has
 * run) and again after each refresh. Only applies to providers that declare
 * a `modelSource` other than `catalog-backed`; providers relying entirely on
 * the shared catalog (or with no declaration, meaning their static list IS
 * the whole story) don't need a separate native-model bucket.
 *
 * Returns a new array with this provider's prior entries replaced.
 */
export function applyProviderNativeModelBaseline(
  providerNativeModels: readonly ModelDefinition[],
  provider: LLMProvider,
): ModelDefinition[] {
  if (!provider.modelSource || provider.modelSource.kind === 'catalog-backed') {
    return [...providerNativeModels];
  }
  const definitions = provider.models.map((id) => buildProviderNativeModelDefinition(provider.name, id));
  return [
    ...providerNativeModels.filter((model) => model.provider !== provider.name),
    ...definitions,
  ];
}

/** Remove a provider's entries from the bucket (used on runtime-provider unregister). */
export function removeProviderNativeModels(
  providerNativeModels: readonly ModelDefinition[],
  providerName: string,
): ModelDefinition[] {
  return providerNativeModels.filter((model) => model.provider !== providerName);
}

export interface LiveModelDiscoverySweepResult {
  readonly providerNativeModels: ModelDefinition[];
  readonly reports: Array<{ providerId: string } & LiveModelDiscoveryResult>;
}

/**
 * Re-check live model discovery for every provider in `providers` that
 * implements `refreshModels()` (or just `providerId` when given). This is
 * the registry-level hook a picker-open handler or an explicit user refresh
 * command calls: routine background refreshes respect each provider's
 * on-disk TTL cache, `force: true` bypasses it.
 *
 * Always resolves with one report per checked provider, a provider whose
 * live fetch fails or throws still gets an honest report (see
 * `LiveModelDiscoveryResult.error`), never a thrown exception that would
 * abort the whole sweep. Providers are checked in parallel, so one slow
 * endpoint does not hold back the rest.
 *
 * The sweep awaits the network, and providers can register or unregister while
 * it runs. `providerNativeModels` may therefore be a function: it is read once
 * all providers have answered, and only the entries of providers that are
 * still registered (`options.isRegistered`) are replaced, so the sweep never
 * writes a stale snapshot over a newer list.
 */
export async function sweepLiveModelDiscovery(
  providers: Iterable<ProviderRefreshableModel>,
  providerNativeModels: readonly ModelDefinition[] | (() => readonly ModelDefinition[]),
  providerId: string | undefined,
  options: { force?: boolean; isRegistered?: (providerName: string) => boolean },
): Promise<LiveModelDiscoverySweepResult> {
  const all = [...providers];
  const targets = (providerId ? all.filter((p) => p.name === providerId) : all)
    .filter((provider) => typeof provider.refreshModels === 'function');

  const checked = await Promise.all(targets.map(async (provider) => {
    try {
      const result = await provider.refreshModels!(options.force ?? false, { skipUnavailableLocal: providerId === undefined });
      return { report: { providerId: provider.name, ...result }, threw: false };
    } catch (error: unknown) {
      // No list came back, so the provider keeps the one it has.
      const report: { providerId: string } & LiveModelDiscoveryResult = {
        providerId: provider.name,
        models: [],
        source: 'dated-static',
        added: [],
        removed: [],
        error: summarizeError(error),
      };
      return { report, threw: true };
    }
  }));
  const reports = checked.map((entry) => entry.report);

  let nextProviderNativeModels = [...(typeof providerNativeModels === 'function' ? providerNativeModels() : providerNativeModels)];
  for (const { report, threw } of checked) {
    if (threw) continue;
    if (options.isRegistered && !options.isRegistered(report.providerId)) continue;
    nextProviderNativeModels = [
      ...nextProviderNativeModels.filter((model) => model.provider !== report.providerId),
      ...report.models.map((id) => buildProviderNativeModelDefinition(report.providerId, id)),
    ];
  }
  return { providerNativeModels: nextProviderNativeModels, reports };
}

/**
 * The startup live model discovery sweep, as routing needs it: when it has
 * settled (the sweep replaces providers' preliminary model lists with what
 * they serve, so a model picked before it settles can be gone when an agent is
 * spawned on it), and which providers' endpoints did not return their model
 * list when it asked (a live fetch was attempted and failed: nothing
 * listening, credentials refused, an unreadable answer). A provider the sweep
 * skipped or answered from its fresh cache is not listed.
 */
export class StartupModelDiscovery {
  #settled: Promise<void> = Promise.resolve();
  readonly #unreachable = new Map<string, string>();

  /** Starts the sweep; never rejects: a failed sweep is logged and leaves the lists it could not refresh. */
  start(sweep: () => Promise<ReadonlyArray<{ readonly providerId: string } & LiveModelDiscoveryResult>>): void {
    this.#settled = sweep().then(
      (reports) => {
        for (const report of reports) {
          if (report.error !== undefined) this.#unreachable.set(report.providerId, report.error);
          else this.#unreachable.delete(report.providerId);
        }
      },
      (error: unknown) => { logger.warn('[provider-models] Background live model discovery failed', { error: summarizeError(error) }); },
    );
  }

  /** Resolves when the sweep has finished; at once when none was started. */
  settled(): Promise<void> {
    return this.#settled;
  }

  /** Providers whose model listing failed in the sweep, with the failure. Read after `settled`. */
  unreachable(): ReadonlyMap<string, string> {
    return this.#unreachable;
  }
}
