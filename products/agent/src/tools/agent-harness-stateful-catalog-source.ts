import { isDeepStrictEqual } from 'node:util';
import { readFileObservation } from '@goodvibes-jev/engine/platform/platform/utils';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { retainCliConfig } from '@goodvibes-jev/engine/terminal-shell';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { captureCatalogMethods, captureCatalogSnapshot, rankHarnessCatalog, type CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import { captureCatalogReadRequest } from './agent-harness-catalog-selection.ts';

/** Capture native receiver slots without reading getters or projecting callbacks as JSON. */
export function captureCatalogContextPaths(context: CommandContext, paths: readonly (readonly string[])[]): () => void {
  const guards: (() => void)[] = [];
  for (const path of paths) {
    let subject: unknown = context;
    for (const key of path) {
      if (!subject || typeof subject !== 'object') break;
      guards.push(captureCatalogMethods(subject, [key]));
      let holder: object | null = subject, descriptor: PropertyDescriptor | undefined;
      while (holder && !(descriptor = Object.getOwnPropertyDescriptor(holder, key))) holder = Object.getPrototypeOf(holder);
      subject = descriptor?.value;
    }
  }
  return () => { for (const guard of guards) guard(); };
}

export function captureStatefulCatalogRequest<T>(context: CommandContext, args: T, options: CatalogRankingOptions,
  paths: readonly (readonly string[])[] = [], captureSources: () => readonly (() => void)[] = () => []) {
  const request = captureCatalogReadRequest(args, options);
  const nativeCurrent = captureCatalogContextPaths(context, [
    ['platform', 'configManager'], ['workspace', 'shellPaths', 'workingDirectory'], ['workspace', 'shellPaths', 'homeDirectory'],
    ['workspace', 'shellPaths', 'resolveUserPath'], ['workspace', 'shellPaths', 'resolveProjectPath'], ...paths,
  ]);
  nativeCurrent();
  const config = context.platform.configManager;
  const retainedConfig = config ? retainCliConfig(config) : undefined;
  const sourceGuards = captureSources();
  const assertNative = () => { nativeCurrent(); retainedConfig?.assertCurrent(); for (const guard of sourceGuards) guard(); nativeCurrent(); };
  assertNative();
  request.retain(assertNative);
  return request;
}

/** Original inode, metadata and complete bytes remain restriction sources after screening cleanup. */
export function captureCatalogFile(path: string): () => void {
  const observe = () => {
    try {
      return readFileObservation(path);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        let parent = dirname(path);
        while (!lstatSync(parent, { throwIfNoEntry: false })) {
          const next = dirname(parent); if (next === parent) throw new ToolInputProjectionError('held'); parent = next;
        }
        const stat = lstatSync(parent, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolInputProjectionError('held');
        return { absent: true, parent: realpathSync(parent), dev: String(stat.dev), ino: String(stat.ino),
          mtime: String(stat.mtimeNs), ctime: String(stat.ctimeNs) };
      }
      throw new ToolInputProjectionError('held');
    }
  };
  const captured = observe();
  return () => { if (!isDeepStrictEqual(observe(), captured)) throw new ToolInputProjectionError('stale'); };
}

/** Rank the full original catalog; an unsettled match cannot become a selected row. */
export async function rankStatefulCatalog<T>(entries: readonly T[], query: string,
  describe: (entry: T) => { readonly id: string; readonly description: string; readonly evidence?: unknown },
  site: string, options: CatalogRankingOptions, contextEvidence?: unknown): Promise<readonly T[]> {
  const original = captureCatalogSnapshot(entries);
  const contextSource = contextEvidence === undefined ? undefined : captureCatalogSnapshot(contextEvidence);
  const assertSource = () => { original.assertCurrent(entries); };
  const assertContext = () => { contextSource?.assertCurrent(contextEvidence); };
  options.retainCurrent?.(assertSource, `${site}:original-rows`);
  assertContext();
  if (contextSource) { options.retainCurrent?.(assertContext, `${site}:context`); assertContext(); }
  const ranked = await rankHarnessCatalog(entries.map((entry, index) => ({ index, entry })), query,
    row => { const description = describe(row.entry); return { id: String(row.index), description: description.description,
      evidence: { record: row.entry, ...(description.evidence !== undefined ? { context: description.evidence } : {}) } }; }, site,
    { ...options, requirePreservedSource: true }, 'engine.tools.registry-rank', contextSource?.captured);
  assertSource(); assertContext(); options.assertCurrent?.(); assertSource(); assertContext();
  return ranked.matches.map(match => {
    if (ranked.provenance !== 'classic' && (match.judgment?.reading.outcome !== 'act' || match.judgment?.reading.verdict !== 'yes')) throw new ToolInputProjectionError('held');
    const row = entries[match.entry.index];
    if (row === undefined) throw new ToolInputProjectionError('held');
    return row;
  });
}
