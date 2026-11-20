import { existsSync, readFileSync } from 'node:fs';
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import type { ShellPathService } from '@/runtime/index.ts';
import { writeStoreJson } from '@goodvibes/engine/terminal-shell/agent-turn/store-file';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';

type SetupSmokeEvidenceShellPaths = Pick<ShellPathService, 'resolveUserPath'>;
type SetupSmokeEvidenceStore = { readonly get?: (id: string) => ArtifactDescriptor | null };

export type SetupSmokeEvidenceList =
  | { readonly status: 'available'; readonly artifacts: readonly ArtifactDescriptor[] }
  | { readonly status: 'unavailable'; readonly reason: string };

const LEDGER_VERSION = 1;
/** Enough runs for the trend and the blocked-check frequency; older runs drop off. */
const MAX_RECORDED_RUNS = 50;

export function setupSmokeEvidencePath(shellPaths: SetupSmokeEvidenceShellPaths): string {
  return shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'setup', 'smoke-evidence.json');
}

/** The artifact ids the setup smoke run saved, oldest first. */
function readRecordedIds(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== LEDGER_VERSION) return [];
    const ids = (parsed as { artifactIds?: unknown }).artifactIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * Records an artifact the setup smoke run itself saved. Only ids written here
 * count as smoke evidence: artifact metadata can arrive from fetched pages,
 * uploads and media providers, so a `purpose` field proves nothing.
 */
export function recordSetupSmokeEvidence(shellPaths: SetupSmokeEvidenceShellPaths, artifactId: string): void {
  const path = setupSmokeEvidencePath(shellPaths);
  const ids = readRecordedIds(path).filter((id) => id !== artifactId);
  ids.push(artifactId);
  writeStoreJson(path, { version: LEDGER_VERSION, artifactIds: ids.slice(-MAX_RECORDED_RUNS) });
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
  const artifacts: ArtifactDescriptor[] = [];
  for (const id of readRecordedIds(setupSmokeEvidencePath(shellPaths))) {
    const artifact = store.get.call(store, id);
    if (artifact) artifacts.push(artifact);
  }
  artifacts.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0) || right.id.localeCompare(left.id));
  return { status: 'available', artifacts };
}
