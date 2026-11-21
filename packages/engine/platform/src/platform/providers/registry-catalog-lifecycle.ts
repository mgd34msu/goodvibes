import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import { fetchCatalogFeedIfChanged, getProviderAccessPath, transformModelsDevResponse, type CatalogFeed } from './model-catalog-cache.js';
import { summarizeError } from '../utils/error-display.js';
import { ProviderAccessReadings } from '../routing/catalog-access.js';
import {
  isCatalogCacheStale,
  loadCatalogCache,
  notifyCatalogChanges,
  saveCatalogCache,
  type CatalogModel,
} from './model-catalog.js';
import type { FavoritesStore } from './favorites.js';
import type { BenchmarkStore } from './model-benchmarks.js';

/**
 * Parameters for catalog lifecycle operations.
 * Passed as a callback bundle so functions remain stateless
 * with respect to the ProviderRegistry class.
 */
export interface CatalogLifecycleContext {
  /** Returns the current catalog cache paths. */
  getCatalogCachePaths(): { cachePath: string; tmpPath: string };
  /** Applies a freshly-fetched model list to the registry's catalog state. */
  updateCatalogState(models: readonly CatalogModel[], fetchedAt?: number): void;
  /** Returns a snapshot of the current catalog models (for diff/notify). */
  getCatalogModels(): readonly CatalogModel[];
  readonly favoritesStore: Pick<FavoritesStore, 'load'>;
  readonly benchmarkStore: Pick<BenchmarkStore, 'getTopBenchmarkModelIds'>;
  /** Triggers an async background catalog refresh (used by initCatalog). */
  refreshCatalog(): Promise<void>;
  /** Compatibility hook after applying the catalog; metadata indexes now resolve locally. */
  afterCatalogApplied(): void;
}

/**
 * Load the catalog from disk cache on startup. If the cache is absent or
 * stale, schedules a background refresh without blocking the caller.
 *
 * Extracted from ProviderRegistry.initCatalog() to isolate catalog
 * initialization logic from provider management concerns.
 */
export function initProviderCatalog(ctx: CatalogLifecycleContext): void {
  const cached = loadCatalogCache(ctx.getCatalogCachePaths().cachePath);
  if (cached) {
    ctx.updateCatalogState(cached.models, cached.fetchedAt);
    ctx.afterCatalogApplied();
  }
  if (!cached || isCatalogCacheStale(cached)) {
    void ctx.refreshCatalog().catch((err) => {
      logger.warn('[model-catalog] Background refresh failed', { error: summarizeError(err) });
    });
  }
}

/**
 * Fetch an updated catalog from the remote source, persist it to the local
 * cache, apply it to the registry state, and emit change notifications.
 *
 * Extracted from ProviderRegistry.refreshCatalog() to isolate catalog
 * refresh logic from provider management concerns.
 */
export function refreshProviderCatalog(ctx: CatalogLifecycleContext): Promise<void> {
  // One refresh per cache file at a time: two overlapping runs would write the
  // same temp file and diff against stale snapshots. A second caller joins the
  // refresh already running and gets its outcome.
  const key = ctx.getCatalogCachePaths().cachePath;
  const running = refreshesInFlight.get(key);
  if (running) return running;
  const refresh = applyCatalogRefresh(ctx).finally(() => { refreshesInFlight.delete(key); });
  refreshesInFlight.set(key, refresh);
  return refresh;
}

const refreshesInFlight = new Map<string, Promise<void>>();

/**
 * An unchanged catalog (a 304, or the pinned snapshot already cached) changes
 * nothing. A changed one is published at once with every provider access
 * already known (remembered readings and local addresses); providers not yet
 * read are read after, and the catalog is published again only when a reading
 * changed a provider's access. A failed reading, or one skipped because no
 * decision model answers (Classic), leaves the published catalog standing; the
 * cache is then kept without its ETag, so the next daily check reads the
 * archive in full and asks the reading again.
 */
async function applyCatalogRefresh(ctx: CatalogLifecycleContext): Promise<void> {
  const previous = [...ctx.getCatalogModels()];
  const { cachePath, tmpPath } = ctx.getCatalogCachePaths();
  const feed = await fetchCatalogFeedIfChanged(cachePath);
  if (!feed) {
    logger.debug('[model-catalog] Catalog unchanged since the last check');
    return;
  }
  const archive: CatalogArchive = { etag: feed.etag, source: feed.source };
  let saved = archive;
  const readings = new ProviderAccessReadings({ path: getProviderAccessPath(dirname(cachePath)) });
  const known = readings.known(feed.providers);
  publishCatalog(ctx, feed, known, cachePath, tmpPath, archive);
  try {
    if (!await readings.readMissing(feed.providers)) {
      // Classic (no decision model, or a fallback from a failing one): nothing was asked, which is a normal choice.
      logger.debug('[model-catalog] Provider access readings were not asked without a decision model; the next check reads the catalog in full and asks them');
      saved = { etag: undefined, source: feed.source };
    }
  } catch (error) {
    logger.warn('[model-catalog] Some provider access readings did not complete; their models keep the paid tier until the next refresh', { error: summarizeError(error) });
    saved = { etag: undefined, source: feed.source };
  }
  const read = readings.known(feed.providers);
  if ([...read].some(([id, access]) => known.get(id) !== access)) publishCatalog(ctx, feed, read, cachePath, tmpPath, saved);
  else if (saved !== archive) saveCatalogCache([...ctx.getCatalogModels()], cachePath, tmpPath, saved);
  const favorites = await ctx.favoritesStore.load();
  notifyCatalogChanges(
    previous,
    [...ctx.getCatalogModels()],
    favorites,
    ctx.benchmarkStore.getTopBenchmarkModelIds(10),
  );
}

/** The archive a cached catalog came from: its ETag (absent when the next check must read it in full) and snapshot id. */
interface CatalogArchive {
  readonly etag: string | undefined;
  readonly source: string | undefined;
}

function publishCatalog(ctx: CatalogLifecycleContext, feed: CatalogFeed, access: Parameters<typeof transformModelsDevResponse>[1], cachePath: string, tmpPath: string, archive: CatalogArchive): void {
  const models = transformModelsDevResponse(feed.json, access);
  if (models.length === 0) {
    // Not a success: the caller asked for a refresh and nothing was refreshed.
    throw new Error('The model catalog feed returned no models, so the existing catalog was kept unchanged.');
  }
  saveCatalogCache(models, cachePath, tmpPath, archive);
  ctx.updateCatalogState(models);
  ctx.afterCatalogApplied();
  logger.debug('[model-catalog] Catalog updated', { count: models.length });
}
