import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { ShellPathService } from '@/runtime/index.ts';
import { readJsonStore, updateJsonStore, type JsonStoreContents, type JsonStoreSpec } from '@goodvibes/engine/terminal-shell/agent-turn/store-file';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

type SetupSmokeEvidenceShellPaths = Pick<ShellPathService, 'resolveUserPath'>;
type SetupSmokeEvidenceStore = { readonly get?: (id: string) => ArtifactDescriptor | null };

export type SetupSmokeEvidenceList =
  | { readonly status: 'available'; readonly artifacts: readonly ArtifactDescriptor[] }
  | { readonly status: 'unavailable'; readonly reason: string };

/** Enough runs for the trend and the blocked-check frequency; older runs drop off. */
const MAX_RECORDED_RUNS = 50;

/**
 * The ledger `{ version: 1, artifactIds: [...] }`, oldest first. A file a newer
 * build wrote is refused, and one that is not JSON is copied aside before it is
 * replaced, so a recorded run is never lost to a damaged or newer file.
 */
const LEDGER_STORE: JsonStoreSpec<string> = {
  label: 'setup smoke evidence ledger',
  entriesKey: 'artifactIds',
  version: 1,
  parseEntry: (value) => (typeof value === 'string' && value.length > 0 ? value : null),
};

export function setupSmokeEvidencePath(shellPaths: SetupSmokeEvidenceShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'setup', 'smoke-evidence.json');
}

/**
 * Records an artifact the setup smoke run itself saved. Only ids written here
 * count as smoke evidence: artifact metadata can arrive from fetched pages,
 * uploads and media providers, so a `purpose` field proves nothing. Throws when
 * the ledger cannot be written (a newer build wrote it, or the disk refused).
 */
export function recordSetupSmokeEvidence(shellPaths: SetupSmokeEvidenceShellPaths, artifactId: string): void {
  updateJsonStore(setupSmokeEvidencePath(shellPaths), LEDGER_STORE, (read) => {
    const ids = read.entries.filter((id) => id !== artifactId);
    ids.push(artifactId);
    return { value: undefined, entries: ids.slice(-MAX_RECORDED_RUNS) };
  });
}

/** The saved smoke evidence, newest first: one small file read and one store lookup per recorded run. */
export function listSetupSmokeEvidence(
  shellPaths: SetupSmokeEvidenceShellPaths | undefined,
  store: SetupSmokeEvidenceStore | null | undefined,
): SetupSmokeEvidenceList {
  if (!store || typeof store.get !== 'function') {
    return { status: 'unavailable', reason: 'Artifact support is unavailable in this runtime.' };
  }
  if (!shellPaths || typeof shellPaths.resolveUserPath !== 'function') {
    return { status: 'unavailable', reason: 'Agent shell paths are unavailable; saved setup smoke runs cannot be read.' };
  }
  const path = setupSmokeEvidencePath(shellPaths);
  let read: JsonStoreContents<string>;
  try {
    read = readJsonStore(path, LEDGER_STORE);
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  if (read.unreadable !== undefined) {
    return { status: 'unavailable', reason: `The setup smoke evidence ledger at ${path} is ${read.unreadable}; the next recorded run copies it aside and starts a new one.` };
  }
  if (read.newerVersion !== undefined) {
    return { status: 'unavailable', reason: `The setup smoke evidence ledger at ${path} was written by a newer GoodVibes (file version ${read.newerVersion}). Update GoodVibes to read it.` };
  }
  const artifacts: ArtifactDescriptor[] = [];
  for (const id of read.entries) {
    const artifact = store.get.call(store, id);
    if (artifact) artifacts.push(artifact);
  }
  artifacts.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || right.id.localeCompare(left.id));
  return { status: 'available', artifacts };
}
