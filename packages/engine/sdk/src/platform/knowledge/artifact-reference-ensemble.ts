import { logger } from '../utils/logger.js';
/** Automatic generated-artifact cleanup is scoped to an explicitly declared
 * configured reference ensemble, not one store's cached listSources(). The
 * three native family locks remain held through the original-file deletion.
 */
import { join, resolve } from 'node:path';
import type { ArtifactOriginalObservation } from '../artifacts/types.js';
import { artifactOriginalId, artifactOriginalOwner, removeOriginalArtifact, tryAcquireArtifactPublication, inspectGeneratedArtifactCleanupCandidates, type ArtifactStore, type ArtifactPublicationLease } from '../artifacts/store.js';
import { captureExistingDirectory } from '../utils/atomic-json-store.js';
import { KNOWLEDGE_FAMILY_DB_FILE } from './store-config.js';
import { captureKnowledgeArtifactReferenceOwner, type KnowledgeStore } from './store.js';
import { createInactiveArtifactReferenceOwner } from './inactive-artifact-reference-owner.js';
import type { KnowledgeArtifactReferenceOwner } from './artifact-reference-owner.js';

export type ArtifactCleanupResult = 'deleted' | 'referenced' | 'held' | 'unavailable';
interface ReferenceEnsemble {
  readonly artifactStore: ArtifactStore;
  readonly artifactRoot: string;
  readonly owners: readonly KnowledgeArtifactReferenceOwner[];
  readonly state: { retired: boolean; discover: boolean; requested: boolean; work: Promise<void> | undefined;
    readonly pending: Map<string, { readonly store: KnowledgeStore; readonly original: ArtifactOriginalObservation }>;
    readonly unsubscribe: Array<() => void>; readonly active: Set<Promise<ArtifactCleanupResult>> };
  assertCurrent(): void;
}
const apply = Reflect.apply, weakGet = WeakMap.prototype.get, weakSet = WeakMap.prototype.set;
const ensembles = new WeakMap<KnowledgeStore, ReferenceEnsemble>();
const artifactEnsembles = new WeakMap<ArtifactStore, ReferenceEnsemble>();
function getEnsemble(store: KnowledgeStore): ReferenceEnsemble | undefined { return apply(weakGet, ensembles, [store]) as ReferenceEnsemble | undefined; }

/** Explicit host declaration: these are all native knowledge files allowed to
 * refer to this configured ArtifactStore. Missing/inactive families are read
 * under their normal lock without initialization. Custom roots must provide
 * use a separate complete owner policy; this native policy preserves them.
 */
export function configureKnowledgeArtifactReferences(options: {
  readonly artifactStore: ArtifactStore;
  readonly controlPlaneDirectory: string;
  readonly stores: readonly KnowledgeStore[];
}): void {
  const artifactStore = options.artifactStore, controlPlaneDirectory = options.controlPlaneDirectory, stores = [...options.stores];
  const directory = captureExistingDirectory(controlPlaneDirectory);
  const active = stores.map(store => ({ store, owner: captureKnowledgeArtifactReferenceOwner(store) }));
  if (!active.length || apply(weakGet, artifactEnsembles, [artifactStore])) throw new Error('Knowledge artifact reference ensemble is already bound or unavailable.');
  const files = Object.values(KNOWLEDGE_FAMILY_DB_FILE).map(file => join(resolve(controlPlaneDirectory), file));
  const selected = new Set<KnowledgeStore>(), owners: KnowledgeArtifactReferenceOwner[] = [];
  for (const file of files) {
    const candidates = active.filter(entry => resolve(entry.owner.path) === file);
    if (candidates.length > 1) throw new Error('Knowledge artifact reference family has multiple local owners.');
    const inactive = createInactiveArtifactReferenceOwner(file);
    const candidate = candidates[0];
    if (candidate) {
      selected.add(candidate.store);
      owners.push(Object.freeze({ path: inactive.path,
        async withReads<T>(ids: readonly string[], operation: (referenced: readonly string[], assertCurrent: () => void) => Promise<T>) {
          inactive.assertSelected();
          const result = await candidate.owner.withReads(ids, async (referenced, current) => {
            const assertCurrent = () => { inactive.assertSelected(); current(); };
            assertCurrent(); const value = await operation(referenced, assertCurrent); assertCurrent(); return value;
          });
          inactive.assertSelected(); return result;
        },
      }));
    } else owners.push(inactive);
  }
  if (selected.size !== active.length || new Set(owners.map(owner => owner.path)).size !== owners.length) throw new Error('Knowledge artifact reference families overlap or are outside the configured ensemble.');
  const state: ReferenceEnsemble['state'] = { retired: false, discover: true, requested: false, work: undefined, pending: new Map(), unsubscribe: [], active: new Set() };
  const ensemble: ReferenceEnsemble = Object.freeze({ state, artifactStore, artifactRoot: resolve(controlPlaneDirectory, 'artifacts'),
    owners: Object.freeze(owners.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), assertCurrent: () => { directory.assertCurrent(); if (state.retired) throw new Error('Knowledge artifact cleanup owner was retired.'); } });
  directory.assertCurrent();
  for (const { store } of active) if (getEnsemble(store)) throw new Error('Knowledge store already has a reference ensemble.');
  try {
    for (const { owner } of active) if (owner.subscribeClean) state.unsubscribe.push(owner.subscribeClean(() => requestRetry(ensemble, active[0]!.store)));
  } catch (error) {
    state.retired = true;
    for (const unsubscribe of state.unsubscribe.splice(0)) { try { unsubscribe(); } catch { /* Preserve the primary composition failure. */ } }
    throw error;
  }
  for (const { store } of active) apply(weakSet, ensembles, [store, ensemble]);
  apply(weakSet, artifactEnsembles, [artifactStore, ensemble]);
  requestRetry(ensemble, active[0]!.store);
}

/** Acquire at most64 original artifact leases first, then open each family
 * image once for this bounded batch. No full SQLite image is parsed per item. */
async function cleanOriginalBatch(ensemble: ReferenceEnsemble, originals: readonly ArtifactOriginalObservation[]): Promise<ReadonlyMap<ArtifactOriginalObservation, ArtifactCleanupResult>> {
  const outcomes = new Map<ArtifactOriginalObservation, ArtifactCleanupResult>(originals.map(original => [original, 'held']));
  const candidates: Array<{ readonly original: ArtifactOriginalObservation; readonly id: string; readonly assertOriginal: () => void; readonly lease: ArtifactPublicationLease }> = [];
  if (originals.length === 0 || originals.length > 64) return outcomes;
  const selected: Array<{ readonly original: ArtifactOriginalObservation; readonly id: string; readonly assertOriginal: () => void }> = [];
  for (const original of originals) {
    try {
      const owner = artifactOriginalOwner(original), id = artifactOriginalId(original);
      if (owner.store !== ensemble.artifactStore || owner.root !== ensemble.artifactRoot) { outcomes.set(original, 'unavailable'); continue; }
      selected.push({ original, id, assertOriginal: owner.assertCurrent });
    } catch { /* A replaced/foreign original confers no deletion ownership. */ }
  }
  selected.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const candidate of selected) {
    try { const lease = tryAcquireArtifactPublication(candidate.original); if (lease) candidates.push({ ...candidate, lease }); }
    catch { /* A replaced original cannot obtain its original publication lease. */ }
  }
  const guards: Array<() => void> = [], referenced = new Set<string>();
  const assertCurrent = () => { ensemble.assertCurrent(); for (const guard of guards) guard(); };
  const ids = Object.freeze(candidates.map(candidate => candidate.id));
  const visit = async (index: number): Promise<void> => {
    assertCurrent(); const owner = ensemble.owners[index];
    if (!owner) {
      for (const candidate of candidates) {
        assertCurrent();
        if (referenced.has(candidate.id)) { outcomes.set(candidate.original, 'referenced'); continue; }
        try {
          candidate.lease.assertCurrent(); candidate.assertOriginal(); assertCurrent();
          if (removeOriginalArtifact(candidate.original)) outcomes.set(candidate.original, 'deleted');
        } catch { /* Preserve that original/replacement without adopting it. */ }
      }
      return;
    }
    const result = await owner.withReads(ids, async (found, current) => {
      guards.push(current);
      try { assertCurrent(); for (const id of found) referenced.add(id); await visit(index + 1); }
      finally { guards.pop(); }
    });
    if (result.kind !== 'completed') return;
  };
  try { if (candidates.length) await visit(0); }
  catch { /* Unknown schema, retired physical sources and pending writes hold cleanup. */ }
  finally {
    for (const candidate of candidates) {
      try { candidate.lease.release(); }
      catch { logger.warn('Generated artifact cleanup lock release could not be confirmed.'); }
    }
  }
  return outcomes;
}
async function cleanOriginal(ensemble: ReferenceEnsemble, observation: ArtifactOriginalObservation): Promise<ArtifactCleanupResult> {
  return (await cleanOriginalBatch(ensemble, [observation])).get(observation) ?? 'held';
}

const MAX_PENDING_CLEANUPS = 1_024;
function retainPending(ensemble: ReferenceEnsemble, store: KnowledgeStore, original: ArtifactOriginalObservation): void {
  if (ensemble.state.retired) return;
  const id = artifactOriginalId(original);
  if (ensemble.state.pending.has(id) || ensemble.state.pending.size < MAX_PENDING_CLEANUPS) ensemble.state.pending.set(id, { store, original });
  else logger.warn('Generated artifact cleanup capacity is full; the original artifact was preserved for later inspection.');
}
export function cleanupKnowledgeArtifact(store: KnowledgeStore, original: ArtifactOriginalObservation): Promise<ArtifactCleanupResult> {
  const ensemble = getEnsemble(store); if (!ensemble) return Promise.resolve('unavailable');
  if (ensemble.state.retired) return Promise.resolve('held');
  const work = Promise.resolve().then(async () => {
  const result = await cleanOriginal(ensemble, original);
  if (result === 'held') {
    try { artifactOriginalOwner(original).assertCurrent(); retainPending(ensemble, store, original); requestRetry(ensemble, store); } catch { /* A replaced original is not a retry candidate. */ }
  } else if (result === 'deleted' || result === 'referenced') ensemble.state.pending.delete(artifactOriginalId(original));
  return result;
  });
  ensemble.state.active.add(work);
  void work.then(() => { ensemble.state.active.delete(work); }, () => { ensemble.state.active.delete(work); });
  return work;
}
/** One owned task outside any held SQL writer queue. Clean publications only
 * coalesce a request; there are no free-running timers or persistent journals. */
function requestRetry(ensemble: ReferenceEnsemble, store: KnowledgeStore): void {
  const state = ensemble.state; if (state.retired) return;
  state.requested = true; if (state.work) return;
  const work = Promise.resolve().then(async () => {
    state.requested = false;
    if (state.retired) return;
    if (state.discover) {
      const inventory = inspectGeneratedArtifactCleanupCandidates(ensemble.artifactStore);
      state.discover = inventory.more;
      for (const original of inventory.candidates) retainPending(ensemble, store, original);
      if (inventory.preserved) logger.warn('Older or unattributed generated artifacts were preserved. Inspect their metadata and content before intentional deletion after older publishers have stopped.');
      if (inventory.more) state.requested = true;
    }
    const pending = [...state.pending];
    for (let offset = 0; offset < pending.length; offset += 64) {
      if (state.retired) return;
      const batch = pending.slice(offset, offset + 64).filter(([id, candidate]) => {
        try { artifactOriginalOwner(candidate.original).assertCurrent(); return true; }
        catch { state.pending.delete(id); return false; }
      });
      const results = await cleanOriginalBatch(ensemble, batch.map(([, candidate]) => candidate.original));
      for (const [id, candidate] of batch) {
        const result = results.get(candidate.original);
        if (result === 'deleted' || result === 'referenced' || result === 'unavailable') state.pending.delete(id);
      }
    }
  }).catch(() => { logger.warn('Generated artifact cleanup could not be confirmed; retained artifacts were preserved.'); });
  state.work = work;
  void work.then(() => { if (state.work === work) state.work = undefined; if (state.requested && !state.retired) requestRetry(ensemble, store); });
}
/** Called synchronously when an actual participating store starts closing.
 * Unsubscribe before draining so no listener can admit new work after teardown. */
export function retireKnowledgeArtifactCleanup(store: KnowledgeStore): Promise<void> {
  const ensemble = getEnsemble(store); if (!ensemble) return Promise.resolve();
  const state = ensemble.state; state.retired = true; state.requested = false;
  for (const unsubscribe of state.unsubscribe.splice(0)) unsubscribe();
  return Promise.allSettled([state.work ?? Promise.resolve(), ...state.active]).then(() => { state.pending.clear(); });
}
