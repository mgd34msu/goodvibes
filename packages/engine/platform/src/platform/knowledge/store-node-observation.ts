import { knowledgeRawRepresentation } from './store-record-representation.js';
import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput } from './types.js';
import type { KnowledgeStore } from './store.js';
import { snapshotNodeInput } from './activation/projection.js';
import { getKnowledgeSpaceId } from './spaces.js';
import { isDeepStrictEqual } from 'node:util';
import { prepareObservedEvidenceCheck } from './store-observed-evidence.js';
import { KnowledgeNodeActivationHeldError } from './activation/types.js';

export type KnowledgeObservationOrigin = 'catalog-structure' | 'source-declaration' | 'link-declaration' | 'memory-mirror' | 'home-assistant-snapshot' | 'browser-profile' | 'generated-page-index' | 'research-task';
interface Observation { readonly existing: KnowledgeNodeRecord | null; readonly origin: KnowledgeObservationOrigin; readonly check: () => void; readonly checkEvidence: () => void; }
export interface ObservedEvidence { readonly record: KnowledgeNodeRecord; readonly origin: KnowledgeObservationOrigin; readonly assertCurrent: () => void; }
const observedRecords = new WeakMap<KnowledgeNodeRecord, ObservedEvidence>();
const originalObservedGet = observedRecords.get.bind(observedRecords), originalObservedSet = observedRecords.set.bind(observedRecords);
export function getKnowledgeNodeObservation(existing: KnowledgeNodeRecord | undefined, candidate: KnowledgeNodeRecord): ObservedEvidence | undefined {
  if (!existing || existing.id !== candidate.id || existing.kind !== candidate.kind || existing.slug !== candidate.slug
    || existing.sourceId !== candidate.sourceId || getKnowledgeSpaceId(existing) !== getKnowledgeSpaceId(candidate)) return undefined;
  const observation = originalObservedGet(existing);
  return observation && !['research-task', 'generated-page-index'].includes(observation.origin) ? observation : undefined;
}
/** Prepare all fallible snapshot work before the store's synchronous commit. */
export function prepareKnowledgeNodeObservation(candidate: KnowledgeNodeRecord,
  mapped: { readonly origin: KnowledgeObservationOrigin; readonly input: KnowledgeNodeUpsertInput; readonly checkEvidence: () => void }): ObservedEvidence {
  const record = snapshotNodeInput({ ...candidate, metadata: mapped.input.metadata ?? {}, aliases: mapped.input.aliases ?? [],
    summary: mapped.input.summary, sourceId: mapped.input.sourceId });
  return Object.freeze({ record, origin: mapped.origin, assertCurrent: mapped.checkEvidence });
}
export function retainKnowledgeNodeObservation(existing: KnowledgeNodeRecord | undefined, candidate: KnowledgeNodeRecord,
  mapped?: ObservedEvidence): void {
  const observation = mapped ?? getKnowledgeNodeObservation(existing, candidate);
  if (observation) originalObservedSet(candidate, observation);
}
const observations = new WeakMap<KnowledgeNodeUpsertInput, Observation>();
/** Internal producer seam: only code/source projections call it. Never exported through a tool or the public knowledge index. */
export function prepareObservedKnowledgeNodeInput(store: KnowledgeStore, input: KnowledgeNodeUpsertInput, origin: KnowledgeObservationOrigin,
  evidence: unknown, readEvidence: () => unknown): KnowledgeNodeUpsertInput {
  const kinds: Readonly<Record<KnowledgeObservationOrigin, readonly KnowledgeNodeRecord['kind'][]>> = {
    'catalog-structure': ['domain', 'bookmark_folder', 'topic'],
    'link-declaration': ['ha_home', 'ha_entity', 'ha_device', 'ha_area', 'ha_automation', 'ha_script', 'ha_scene', 'ha_label', 'ha_integration', 'ha_room', 'ha_device_passport', 'ha_maintenance_item', 'ha_troubleshooting_case', 'ha_purchase', 'ha_network_node'],
    'source-declaration': ['project', 'capability', 'repo', 'provider', 'service', 'environment', 'user'], 'memory-mirror': ['memory'],
    'home-assistant-snapshot': ['ha_home', 'ha_entity', 'ha_device', 'ha_area', 'ha_automation', 'ha_script', 'ha_scene', 'ha_label', 'ha_integration'],
    'browser-profile': ['source_group'], 'generated-page-index': ['ha_device_passport'], 'research-task': ['knowledge_gap'],
  };
  if (!kinds[origin]?.includes(input.kind)) throw new KnowledgeNodeActivationHeldError('malformed');
  const frozen = snapshotNodeInput(input);
  const checkEvidence = prepareObservedEvidenceCheck(store, evidence, readEvidence);
  const existing = input.id ? store.getNode(input.id) : store.getNodeByKindAndSlug(input.kind, input.slug);
  const observation = Object.freeze({ existing: existing ?? null, origin,
    check: checkEvidence, checkEvidence });
  observations.set(frozen, observation);
  return frozen;
}
export async function upsertObservedKnowledgeNode(store: KnowledgeStore, input: KnowledgeNodeUpsertInput, origin: KnowledgeObservationOrigin,
  evidence: unknown, readEvidence: () => unknown): Promise<KnowledgeNodeRecord> {
  return store.upsertNode(prepareObservedKnowledgeNodeInput(store, input, origin, evidence, readEvidence));
}
export function resolveKnowledgeNodeObservation(input: KnowledgeNodeUpsertInput, existing: KnowledgeNodeRecord | undefined): { readonly origin: KnowledgeObservationOrigin; readonly input: KnowledgeNodeUpsertInput; readonly assertCurrent: () => void; readonly checkEvidence: () => void } | undefined {
  const observation = observations.get(input);
  if (!observation) return undefined;
  const assertCurrent = () => {
    // The WeakMap key is the actual deeply frozen producer input; a copy never
    // inherits it. Native stored nodes are immutable, so retain their exact
    // previous value rather than hashing it at each assertion.
    if (!isDeepStrictEqual(snapshotNodeInput(existing ?? null), observation.existing)) throw new KnowledgeNodeActivationHeldError('stale');
    observation.check();
  };
  assertCurrent(); return { origin: observation.origin, input, assertCurrent, checkEvidence: observation.checkEvidence };
}

/** Staged catalog evidence is guarded before commit and read from the live store thereafter. */
export function prepareStagedObservedKnowledgeNodeInput(store: KnowledgeStore, input: KnowledgeNodeUpsertInput,
  evidence: unknown, readEvidence: () => unknown, assertCurrent: () => void, origin: KnowledgeObservationOrigin = 'catalog-structure'): KnowledgeNodeUpsertInput {
  const frozen = prepareObservedKnowledgeNodeInput(store, input, origin, evidence, readEvidence);
  const observation = observations.get(frozen)!;
  observations.set(frozen, Object.freeze({ ...observation, check: assertCurrent }));
  return frozen;
}

/** Validate/build once before the native membership write. Only its actual
 * acknowledged publication calls publish(), which performs the prepared native
 * map assignment without validation, source callbacks or body cloning. This
 * preserves original HA evidence rather than observing omitted attributes anew. */
export function prepareHomeGraphSnapshotGroupAcknowledgment(existing: KnowledgeNodeRecord, candidate: KnowledgeNodeRecord): { assertCurrent(): void; publish(): void } {
  if (existing.kind !== 'ha_entity' || candidate.kind !== existing.kind) throw new KnowledgeNodeActivationHeldError('stale');
  const previous = knowledgeRawRepresentation(existing), next = knowledgeRawRepresentation(candidate);
  const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const previousMetadata = object(previous.metadata), nextMetadata = object(next.metadata);
  const oldHome = object(previousMetadata.homeAssistant), newHome = object(nextMetadata.homeAssistant), groups = newHome.snapshotGroups;
  if (!Array.isArray(groups) || !groups.length || groups.length > 2 || groups.some(group => group !== 'entities' && group !== 'helpers') || new Set(groups).size !== groups.length) throw new KnowledgeNodeActivationHeldError('stale');
  const sameExcept = (left: Record<string, unknown>, right: Record<string, unknown>, except: string) => {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) if (key !== except && (Object.hasOwn(left, key) !== Object.hasOwn(right, key) || !isDeepStrictEqual(left[key], right[key]))) return false;
    return true;
  };
  if (!sameExcept(previous as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>, 'metadata')
    || !sameExcept(previousMetadata, nextMetadata, 'homeAssistant') || !sameExcept(oldHome, newHome, 'snapshotGroups')) throw new KnowledgeNodeActivationHeldError('stale');
  const original = originalObservedGet(existing);
  // Loaded/unattributed flags and observations of another producer never mint
  // a Home Assistant evidence receipt. Their ordinary row/status stays intact.
  if (!original || original.origin !== 'home-assistant-snapshot') return Object.freeze({ assertCurrent() {}, publish() {} });
  const metadata = original.record.metadata, home = object(metadata.homeAssistant);
  const record = Object.freeze({ ...original.record, metadata: Object.freeze({ ...metadata,
    homeAssistant: Object.freeze({ ...home, snapshotGroups: Object.freeze([...groups]) }),
  }) });
  const prepared = Object.freeze({ ...original, record });
  return Object.freeze({ assertCurrent: () => original.assertCurrent(), publish: () => { originalObservedSet(candidate, prepared); } });
}
