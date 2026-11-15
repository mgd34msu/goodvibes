import type { ArtifactOriginalObservation } from '../../artifacts/types.js';
import { cleanupKnowledgeArtifacts } from '../artifact-reference-ensemble.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import { getExplicitKnowledgeSpaceId, getKnowledgeSpaceId, normalizeKnowledgeSpaceId } from '../spaces.js';
import type { KnowledgeStore } from '../store.js';
import { resolveHomeGraphResetSpace } from './space-selection.js';
import type { HomeGraphResetInput, HomeGraphResetResult } from './types.js';

export async function resetHomeGraphSpace(
  store: KnowledgeStore,
  artifactStore: ArtifactStore,
  input: HomeGraphResetInput,
): Promise<HomeGraphResetResult> {
  await store.init();
  const { spaceId, installationId } = resolveHomeGraphResetSpace(store, input);
  const dryRun = input.dryRun === true;
  const preserveArtifacts = input.preserveArtifacts === true;
  const artifactIds = collectKnowledgeSpaceArtifactIds(store, artifactStore, spaceId);
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
        if (artifactStore.get(id) === null) deletedArtifacts++;
        else artifactCleanup.held++;
      }
    }
    if (artifactCleanup.held || artifactCleanup.unavailable) logger.debug('Home Graph data reset completed with retained artifact cleanup candidates.');
  }
  const preservedArtifacts = Math.max(0, artifactIds.length - deletedArtifacts);
  return {
    ok: true,
    spaceId,
    installationId,
    dryRun,
    deleted,
    artifactDeleteCandidates: artifactIds.length,
    deletedArtifacts,
    preservedArtifacts,
    artifactCleanup,
    artifactsDeleted: deletedArtifacts > 0,
  };
}

function collectKnowledgeSpaceArtifactIds(store: KnowledgeStore, artifactStore: ArtifactStore, spaceId: string): string[] {
  const normalized = normalizeKnowledgeSpaceId(spaceId);
  const ids = new Set<string>();
  // Metadata classifies a candidate; it cannot prove absence of references.
  // Actual deletion below still requires fresh typed refs in every configured
  // family under their original publication locks.
  const ownedByOtherSpace = (artifactId: string): boolean => {
    const descriptor = artifactStore.get(artifactId);
    if (!descriptor) return false;
    const artifactSpace = getExplicitKnowledgeSpaceId({ metadata: descriptor.metadata });
    return artifactSpace !== null && artifactSpace !== normalized;
  };
  for (const source of store.listSources(Number.MAX_SAFE_INTEGER)) {
    if (getKnowledgeSpaceId(source) !== normalized) continue;
    const artifactId = typeof source.artifactId === 'string' ? source.artifactId.trim() : '';
    if (artifactId.length === 0) continue;
    if (ownedByOtherSpace(artifactId)) continue;
    ids.add(artifactId);
  }
  for (const artifact of artifactStore.list(Number.MAX_SAFE_INTEGER)) {
    if (getKnowledgeSpaceId({ metadata: artifact.metadata }) === normalized) ids.add(artifact.id);
  }
  return [...ids];
}
