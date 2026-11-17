import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

/** No query is the whole list; a query goes to the one catalog selector (code first, at most one reading). */
export async function browserDeviceCatalogMatches<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence: unknown },
  options: CatalogRankingOptions, site: string): Promise<readonly T[]> {
  options.signal?.throwIfAborted();
  if (!query) return entries;
  const result = await rankHarnessCatalog(entries, query, describe, site, options);
  return result.matches.map(({ entry }) => entry);
}
