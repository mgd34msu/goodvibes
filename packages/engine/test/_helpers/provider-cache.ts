import { makeProjectTempDir } from './project-temp.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogModel, loadCatalogCache } from '../../platform/src/platform/providers/model-catalog.ts';
import type { BenchmarkEntry } from '../../platform/src/platform/providers/model-benchmarks.ts';

export interface ProviderCacheFixture {
  readonly cacheDir: string;
  readonly cleanup: () => void;
  readonly restoreEnv: () => void;
}

export interface ProviderCachePaths {
  readonly catalogPath: string;
  readonly benchmarksPath: string;
}

/** Fresh run-owned cache only. A caller path is deliberately not accepted. */
export function createProviderCacheFixture(prefix = 'provider-cache'): ProviderCacheFixture {
  const root = makeProjectTempDir(prefix);
  const cacheDir = join(root, 'cache');
  mkdirSync(cacheDir);
  return {
    cacheDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    restoreEnv: () => {},
  };
}

export function getProviderCachePaths(cacheDir: string): ProviderCachePaths {
  return {
    catalogPath: join(cacheDir, 'model-catalog.json'),
    benchmarksPath: join(cacheDir, 'benchmarks.json'),
  };
}

export function writeModelCatalogCache(models: CatalogModel[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { catalogPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  // The repository-backed cache retains identity and capability metadata.
  const payload = { version: 7, fetchedAt, ttlMs, models } satisfies NonNullable<ReturnType<typeof loadCatalogCache>>;
  writeFileSync(catalogPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function writeBenchmarksCache(entries: BenchmarkEntry[], cacheDir: string, fetchedAt = Date.now(), ttlMs = 86_400_000): void {
  const { benchmarksPath } = getProviderCachePaths(cacheDir);
  mkdirSync(cacheDir, { recursive: true });
  const payload = { version: 1 as const, fetchedAt, ttlMs, entries };
  writeFileSync(benchmarksPath, JSON.stringify(payload, null, 2), 'utf-8');
}
