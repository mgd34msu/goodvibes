import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';

/**
 * Where the research tools of one tool registry keep their records. The run
 * ledger, the source ledger and the artifact store are separate stores; the
 * report save and the run/source bookkeeping need all three, so each tool's
 * registration records what it was given here and the others read it.
 * Trusted composition only: nothing here creates or discovers a store.
 */
type ResearchLedgerPaths = Pick<ShellPathService, 'resolveProjectPath'>;
interface ResearchArtifactLookup { get(id: string): ArtifactDescriptor | null | undefined }

const ledgers = new WeakMap<ToolRegistry, ResearchLedgerPaths>();
const artifacts = new WeakMap<ToolRegistry, ResearchArtifactLookup>();

export function bindResearchLedgers(registry: ToolRegistry, shellPaths: ResearchLedgerPaths | undefined): void {
  if (shellPaths) ledgers.set(registry, shellPaths);
}

export function researchLedgers(registry: ToolRegistry | undefined): ResearchLedgerPaths | undefined {
  return registry && ledgers.get(registry);
}

export function bindResearchArtifacts(registry: ToolRegistry, store: Partial<ResearchArtifactLookup> | undefined): void {
  const get = store?.get;
  if (get) artifacts.set(registry, { get: id => get.call(store, id) });
}

/**
 * A report artifact id named by a run or a source, checked against the artifact
 * store: `undefined` when this composition has no store to ask (nothing is
 * refused then), otherwise whether it exists. One map lookup in the store.
 */
export function researchArtifactExists(registry: ToolRegistry | undefined, id: string): boolean | undefined {
  const store = registry && artifacts.get(registry);
  if (!store) return undefined;
  return Boolean(store.get(id));
}

/** The refusal for an artifact id the store does not hold. */
export function unknownReportArtifact(id: string): Error {
  return new Error(`There is no artifact ${id}, so nothing was changed. List saved reports with research action:"reports".`);
}
