import type { ArtifactOriginalObservation } from '../../artifacts/types.js';
import { cleanupKnowledgeArtifacts } from '../artifact-reference-ensemble.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import { getExplicitKnowledgeSpaceId, getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import type { HomeGraphResetResult } from './types.js';

/** The space a reset deletes, resolved once by the caller. */
export interface HomeGraphResetTarget {
  readonly spaceId: string;
  readonly installationId: string;
  readonly dryRun?: boolean | undefined;
  readonly preserveArtifacts?: boolean | undefined;
}

export async function resetHomeGraphSpace(
  store: KnowledgeStore,
  artifactStore: ArtifactStore,
  target: HomeGraphResetTarget,
): Promise<HomeGraphResetResult> {
  const { spaceId, installationId } = target;
  const dryRun = target.dryRun === true;
  const preserveArtifacts = target.preserveArtifacts === true;
  const { owned: artifactIds, borrowed } = collectKnowledgeSpaceArtifactIds(store, artifactStore, spaceId);
  // Capture the exact original pairs BEFORE the asynchronous database reset.
  // A file/record replacement during that await is never adopted for removal.
  const originals = new Map<string, ArtifactOriginalObservation>();
  if (!dryRun && !preserveArtifacts) for (const id of artifactIds) {
    try { originals.set(id, artifactStore.captureOriginal(id)); }
    catch (error) { logger.debug('Home Graph reset could not capture an artifact original; it stays a retained candidate.', { artifactId: id, error: summarizeError(error) }); }
  }
  const deleted = await store.deleteKnowledgeSpace(spaceId, { dryRun });
  const artifactCleanup = { referenced: 0, held: 0, unavailable: 0, skipped: 0 };
  let deletedArtifacts = 0;
  if (dryRun || preserveArtifacts) artifactCleanup.skipped = artifactIds.length;
  else {
    // A candidate whose original could not be captured (missing or changed) is
    // unavailable in both branches below.
    try {
      const outcomes = await cleanupKnowledgeArtifacts(store, [...originals.values()]);
      for (const id of artifactIds) {
        const original = originals.get(id), result = original ? outcomes.get(original) ?? 'held' : 'unavailable';
        if (result === 'deleted') deletedArtifacts++;
        else artifactCleanup[result]++;
      }
    } catch (error) {
      // The cleanup stopped part-way; count what is really gone instead of
      // reporting every candidate as retained.
      logger.warn('Home Graph artifact cleanup stopped before finishing; counting the artifacts that were removed.', { error: summarizeError(error) });
      for (const id of artifactIds) {
        if (!originals.has(id)) artifactCleanup.unavailable++;
        else if (artifactStore.get(id) === null) deletedArtifacts++;
        else artifactCleanup.held++;
      }
    }
  }
  const preservedArtifacts = Math.max(0, artifactIds.length - deletedArtifacts);
  const retained = artifactCleanup.held + artifactCleanup.unavailable;
  return {
    ok: true,
    spaceId,
    installationId,
    dryRun,
    deleted,
    artifactDeleteCandidates: artifactIds.length,
    deletedArtifacts,
    preservedArtifacts,
    borrowedArtifacts: borrowed,
    artifactCleanup,
    artifactsDeleted: deletedArtifacts > 0,
    ...(retained > 0 ? {
      nextStep: `${retained} Home Graph file(s) were kept because they were in use, locked or could not be read; run reset again to remove the ones no longer in use.`,
    } : {}),
  };
}

/**
 * Artifacts a reset may remove: ones Home Graph created for a source of this
 * space (recorded on the source at ingest), and ones whose own metadata names
 * this space. An artifact a caller handed to ingest by id is borrowed: it is
 * counted, never removed. Deletion below still requires zero references in
 * every configured knowledge family.
 */
function collectKnowledgeSpaceArtifactIds(store: KnowledgeStore, artifactStore: ArtifactStore, spaceId: string): { readonly owned: string[]; readonly borrowed: number } {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const owned = new Set<string>(), borrowed = new Set<string>();
  const namesThisSpace = (artifactId: string): boolean => {
    const descriptor = artifactStore.get(artifactId);
    return descriptor !== null && getExplicitKnowledgeSpaceId({ metadata: descriptor.metadata }) === normalized;
  };
  for (const source of store.listSourcesInSpace(spaceId)) {
    if (getKnowledgeSpaceId(source) !== normalized) continue;
    const artifactId = typeof source.artifactId === 'string' ? source.artifactId.trim() : '';
    if (artifactId.length === 0) continue;
    if (source.metadata.homeGraphArtifactOwned === true || namesThisSpace(artifactId)) owned.add(artifactId);
    else borrowed.add(artifactId);
  }
  for (const artifact of artifactStore.list(Number.MAX_SAFE_INTEGER)) {
    if (getKnowledgeSpaceId({ metadata: artifact.metadata }) === normalized) owned.add(artifact.id);
  }
  for (const id of owned) borrowed.delete(id);
  return { owned: [...owned], borrowed: borrowed.size };
}
