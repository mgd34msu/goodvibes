import { KnowledgeActivationReadset } from './store-node-activation-readset.js';
import { isDeepStrictEqual } from 'node:util';
import { knowledgeDecisionStamp, knowledgeRawRepresentation } from './store-record-representation.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { SqlDatabase, SQLiteStore } from '../state/sqlite-store.js';
import { readKnowledgeActivationDependencies, writeKnowledgeActivationCache } from './store-node-activation-cache.js';
import { sameKnowledgeRecord } from './store-record-representation.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { captureKnowledgeSourceReferences, retainKnowledgeNodeActivationReferences } from './source-structural-references.js';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { nodeServingWithoutReview } from './activation/battery.js';
import { snapshotNodeInput, activationMeaning, activationSubjectIds, type ActivationSubject, activationContent, activationSourceIds, projectNodeActivation, type ActivationEvidence } from './activation/projection.js';
import { classicNodeActivation, readNodeActivations } from './activation/reader.js';
import { KnowledgeNodeActivationHeldError as Held, NODE_ACTIVATION_LIMITS as LIMITS, type KnowledgeNodeActivationOptions, type NodeActivationReading } from './activation/types.js';
import { getKnowledgeNodeObservation, prepareKnowledgeNodeObservation, type ObservedEvidence, type resolveKnowledgeNodeObservation } from './store-node-observation.js';
import { retainKnowledgeNodeRecord } from './store-node-authority.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeNodeRecord, KnowledgeNodeUpsertInput } from './types.js';

export interface KnowledgePreparedNodeWrites { readonly count: number; }
/** Internal read overlay: proposed evidence is detached; live read sets remain guarded. */
export interface KnowledgeNodeActivationStage {
  readonly evidenceFor: (record: KnowledgeNodeRecord) => readonly ActivationEvidence[];
  readonly assertCurrent: () => void;
  /** Hidden observation dependencies cannot be proven unchanged by an import. */
  readonly invalidatesRetainedObservations?: boolean | undefined;
}
export interface NodeMutationDraft {
  readonly input: KnowledgeNodeUpsertInput;
  readonly existing: KnowledgeNodeRecord | undefined;
  readonly record: KnowledgeNodeRecord;
  readonly now: number;
  readonly authority: boolean;
  readonly restoration?: (() => void) | undefined;
  readonly observation?: ReturnType<typeof resolveKnowledgeNodeObservation>;
}
interface PreparedNode extends NodeMutationDraft { readonly preserveObservation: boolean; readonly nativeActivationState: ReturnType<KnowledgeStore['getNodeActivationState']>; readonly references: readonly (object | undefined)[]; readonly observationEvidence?: ObservedEvidence | undefined; readonly evidence: readonly ActivationEvidence[]; readonly activationCache?: { readonly reference: string; readonly observation: string | null } | undefined; readonly subjects: readonly ActivationSubject[]; readonly observed: ReturnType<typeof getKnowledgeNodeObservation>; }
interface PreparedPass { readonly store: KnowledgeStore; readonly scope: object; readonly nodes: readonly PreparedNode[]; readonly written: Set<number>; readonly committed: Map<string, KnowledgeNodeRecord>; readonly port: JudgmentPort | undefined; readonly model: string | undefined; readonly assertCurrent?: (() => void) | undefined; readonly signal?: AbortSignal | undefined; readonly expires: number; readonly readset: KnowledgeActivationReadset; readonly stage?: KnowledgeNodeActivationStage | undefined; }
const retainedWrites = new WeakMap<KnowledgeNodeRecord, { readonly store: KnowledgeStore; readonly scope: object; readonly check: () => void }>();
/** Only an exact locally committed object can authorize compensation, never a serialized receipt. */
export function knowledgeNodeRestorationGuard(store: KnowledgeStore, record: KnowledgeNodeRecord, scope: object): (() => void) | undefined {
  const saved = retainedWrites.get(record);
  return saved?.scope === scope ? saved.check : undefined;
}
const observationReferences = new WeakMap<ObservedEvidence, string>();
function observationReference(observation: ObservedEvidence | undefined): string | null {
  if (!observation) return null;
  let reference = observationReferences.get(observation);
  if (!reference) { reference = opaqueUuid(); observationReferences.set(observation, reference); }
  return reference;
}
const prepared = new WeakMap<KnowledgePreparedNodeWrites, PreparedPass>();
function currentPort(): JudgmentPort | undefined { try { return judgmentPort(nodeServingWithoutReview.name); } catch { return undefined; } }
function evidenceFor(store: KnowledgeStore, record: KnowledgeNodeRecord): ActivationEvidence[] {
  return activationSourceIds(record).map((id) => ({ id, source: store.getSource(id), extraction: store.getExtractionBySourceId(id) }));
}
/** Live guards compare detached complete values. Durable cache reuse separately
 * requires actual SQL writer revisions, not a producer-supplied receipt ID. */
function sameActivationInput(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(snapshotNodeInput(left), snapshotNodeInput(right));
}
function unchanged(draft: NodeMutationDraft): boolean {
  return Boolean(draft.existing && sameActivationInput(activationContent(draft.record), activationContent(draft.existing)));
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

/** A new interpretation is not permission to rewrite an unsupported stored
 * native receipt or cache. Reject the whole pass before the first provider. */
function assertSupportedActivationFormat(draft: NodeMutationDraft): void {
  const receipt = draft.existing?.metadata.nodeActivation;
  if (isRecord(receipt)) {
    if (Object.hasOwn(receipt, 'dependencyVersion') || Object.hasOwn(receipt, 'dependencyReference')) {
      if (receipt.dependencyVersion !== 1 || typeof receipt.dependencyReference !== 'string'
        || !/^[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/.test(receipt.dependencyReference)
        || Object.hasOwn(receipt, 'evidenceHash')) throw new Held('malformed');
    } else if (Object.hasOwn(receipt, 'evidenceHash')
      && (typeof receipt.evidenceHash !== 'string' || !/^[a-p]{64}$/.test(receipt.evidenceHash))) throw new Held('malformed');
  }
}

export async function prepareNodeActivationPass(store: KnowledgeStore, drafts: readonly NodeMutationDraft[], options: KnowledgeNodeActivationOptions, ownerConfidenceFloor: number | undefined, scope: object, stage?: KnowledgeNodeActivationStage): Promise<KnowledgePreparedNodeWrites> {
  return withConfiguredDecisionModelPolicy(() => prepareOwnedNodeActivationPass(store, drafts, options, ownerConfidenceFloor, scope, stage));
}
async function prepareOwnedNodeActivationPass(store: KnowledgeStore, drafts: readonly NodeMutationDraft[], options: KnowledgeNodeActivationOptions, ownerConfidenceFloor: number | undefined, scope: object, stage?: KnowledgeNodeActivationStage): Promise<KnowledgePreparedNodeWrites> {
  const assertCallerCurrent = options.assertCurrent;
  const signal = options.signal;
  let retired = false;
  const readset = new KnowledgeActivationReadset(store);
  const assertNative = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (retired) throw new Held('stale');
    try {
      isClassicOperation(); // Policy changes retire the original operation; fallback does not change native scope.
      if (options.signal !== signal || options.assertCurrent !== assertCallerCurrent) throw new Held('stale');
      const result: unknown = assertCallerCurrent?.();
      if (result !== undefined) { drainOwned(result); throw new Held('stale'); }
      stage?.assertCurrent();
      readset.assertCurrent();
    } catch { retired = true; throw new Held('stale'); }
    if (signal?.aborted) throw new Held('aborted');
  };
  assertNative();
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > LIMITS.timeoutMs)) throw new Held('budget');
  if (drafts.length > LIMITS.nodes) throw new Held('budget');
  const identities = new Map<string, string>();
  for (const { record } of drafts) {
    const key = JSON.stringify([record.kind, record.slug]);
    const previous = identities.get(key);
    if (previous && previous !== record.id) throw new Held('stale');
    identities.set(key, record.id);
  }
  const proposed = new Map(drafts.map((draft) => [draft.record.id, draft.record]));
  let localBytes = 0;
  let nodes: PreparedNode[] = [], direct: (KnowledgeNodeRecord | undefined)[] = [];
  let completed: KnowledgePreparedNodeWrites | undefined;
  const cacheWrites = new Map<number, { readonly reference: string; readonly observation: string | null }>();
  const requests: ReturnType<typeof projectNodeActivation>[] = [];
  const requestIndices = new Map<number, number>();
  // One original synchronous native frame serves the complete pass. No file
  // image or private database clone is reopened per target or across model I/O.
  store.assertRecordSnapshotFrame(() => {
    nodes = drafts.map((draft) => {
      assertSupportedActivationFormat(draft);
      const actualEvidence = draft.authority || draft.observation || draft.restoration ? [] : stage?.evidenceFor(draft.record) ?? evidenceFor(store, draft.record);
      const references = actualEvidence.map(({ source, extraction }) => captureKnowledgeSourceReferences(store, source, extraction));
      const evidence = snapshotNodeInput(actualEvidence);
      const changedEvidence = stage !== undefined
        && (!sameActivationInput(stage.evidenceFor(draft.record), evidenceFor(store, draft.record))
          || (stage.invalidatesRetainedObservations === true && draft.existing?.metadata.nodeObservation !== undefined));
      // Retained observations describe their original evidence, never a staged replacement.
      const observed = draft.authority || draft.observation || draft.restoration || changedEvidence ? undefined : getKnowledgeNodeObservation(draft.existing, draft.record);
      observed?.assertCurrent();
      const subjects = draft.authority || draft.observation || draft.restoration ? [] : snapshotNodeInput(activationSubjectIds(draft.record).map((id) => ({ id, node: store.getNode(id) })));
      let nativeActivationState: ReturnType<KnowledgeStore['getNodeActivationState']>;
      try { nativeActivationState = readset.capture(draft.record.id, evidence.map(entry => entry.id), subjects.map(entry => entry.id), observationReference(observed)); }
      catch (error) { if (error instanceof Held) throw error; throw new Held('malformed'); }
      localBytes += new TextEncoder().encode(JSON.stringify({ input: draft.input, evidence, subjects })).byteLength;
      if (localBytes > LIMITS.bytes * 4) throw new Held('budget');
      return { ...draft, preserveObservation: !changedEvidence, nativeActivationState, references, evidence, subjects, observed };
    });
    direct = nodes.map((draft, index): KnowledgeNodeRecord | undefined => {
      const { input, existing, record, observation } = draft;
      if (draft.restoration) { draft.restoration(); return record; }
      if (draft.authority) return record;
      if (observation && existing && (input.status ?? 'active') === existing.status && unchanged(draft)) return existing;
      if (observation) return retainKnowledgeNodeRecord({ ...record, status: input.status ?? 'active', metadata: { ...knowledgeRawRepresentation(record.metadata), nodeActivation: undefined,
        nodeObservation: { version: 1, origin: observation.origin },
        reviewProvenance: knowledgeDecisionStamp(draft.now, { state: 'explicit', reason: `Observed ${observation.origin} projection; untrusted origin retained; no synthesized claim or operator review` }) } }, record);
      if (input.status === 'stale' || input.status === 'draft' || (existing?.status === 'stale' && input.status !== 'active')) {
        if (existing?.status === 'active' && !sameActivationInput(activationMeaning(existing), activationMeaning(record))) {
          throw new Held('replacement-requires-review');
        }
        if (existing?.status === record.status && unchanged(draft) && record.metadata.reviewProvenance !== undefined) return existing;
        return retainKnowledgeNodeRecord({ ...record, status: input.status ?? 'stale', metadata: { ...knowledgeRawRepresentation(record.metadata), nodeActivation: undefined,
          reviewProvenance: knowledgeDecisionStamp(draft.now, { state: input.status === 'draft' ? 'pending-review' : 'explicit', reason: `Explicit non-serving status '${input.status ?? 'stale'}'` }) } }, record);
      }
      const receipt = existing?.metadata.nodeActivation;
      if (existing?.status === 'active' && unchanged(draft) && draft.preserveObservation) {
        if (!isRecord(receipt)) return existing; // Explicit native/operator acceptance.
        const observation = observationReference(draft.observed);
        const current = draft.nativeActivationState;
        if (receipt.dependencyVersion === 1 && typeof receipt.dependencyReference === 'string') {
          const changedSubject = draft.subjects.some(({ id, node }) => proposed.has(id)
            && !sameActivationInput(activationContent(proposed.get(id)!), node ? activationContent(node) : null));
          if (!changedSubject && current.cache?.reference === receipt.dependencyReference && sameKnowledgeRecord(current.cache.receipt, receipt)
            && sameKnowledgeRecord(current.cache.dependencies, current.dependencies)) {
            // An import can republish unchanged evidence in the same transaction.
            // Its final native versions must replace the old vector without paying
            // for a second interpretation of the exact same guarded content.
            if (stage) cacheWrites.set(index, { reference: receipt.dependencyReference, observation });
            return existing;
          }
        }
        // Old evidenceHash receipts are reconstructible caches. Read them as
        // history and re-evaluate current evidence; do not hash to adopt them.
      }
      // Ordinary native storage needs no model-bound projection or outbound privacy admission.
      // Its synthesized content remains an untrusted draft; changed active content still holds below.
      if (isClassicOperation()) return undefined;
      // Both projection and complete protected-input preflight run for every selected
      // synthesized candidate before the reader can send the first request.
      const projection = projectNodeActivation(record, draft.evidence, draft.subjects.map((subject) => ({ ...subject,
        node: proposed.get(subject.id) ?? subject.node })), draft.observed, draft.references);
      requestIndices.set(index, requests.length); requests.push(projection);
      return undefined;
    });
    readset.seal();
    if (requests.length === 0) completed = finish([], undefined, undefined);
    return undefined;
  });
  if (completed) return completed;
  const port = requests.length && !isClassicOperation() ? currentPort() : undefined;
  let model: string | undefined;
  try { model = port?.model; } catch { throw new Held('malformed'); }
  const readings = requests.length ? await readNodeActivations(requests, { ...options, assertCurrent: assertNative }) : [];
  return finish(readings, port, model);

  function finish(readings: readonly NodeActivationReading[], port: JudgmentPort | undefined, model: string | undefined): KnowledgePreparedNodeWrites {
    assertNative();
    const semantic = readings.some(reading => reading.model !== undefined);
    if (semantic && (!port || port.model !== model || !isClassicOperation() && currentPort() !== port)) throw new Held('stale');
    const resolved = nodes.map((draft, index): PreparedNode => {
      if (direct[index]) {
        const record = direct[index]!;
        return { ...draft, record, activationCache: cacheWrites.get(index), observationEvidence: draft.observation ? prepareKnowledgeNodeObservation(record, draft.observation) : undefined };
      }
      const requestIndex = requestIndices.get(index);
      const measured = requestIndex === undefined ? classicNodeActivation() : readings[requestIndex]!;
      const reading = measured.outcome === 'accepted' && ownerConfidenceFloor !== undefined && draft.record.confidence < ownerConfidenceFloor
        ? { ...measured, outcome: 'pending-review' as const, reason: 'owner-confidence-floor' as const } : measured;
      if (reading.outcome !== 'accepted' && (draft.existing?.status === 'active' || options.requireAccepted)) throw new Held(reading.reason === 'missing-evidence' && draft.existing?.metadata.nodeObservation !== undefined ? 'observation-revalidation' : reading.reason ?? 'uncertain');
      const accepted = reading.outcome === 'accepted';
      const activationCache = accepted ? { reference: opaqueUuid(), observation: observationReference(draft.observed) } : undefined;
      const record = retainKnowledgeNodeRecord({ ...draft.record, status: accepted ? 'active' : 'draft', metadata: { ...knowledgeRawRepresentation(draft.record.metadata),
        ...(!draft.preserveObservation ? { nodeObservation: undefined } : {}),
        reviewProvenance: knowledgeDecisionStamp(draft.now, { state: accepted ? 'auto-accepted' : 'pending-review',
          reason: accepted ? 'Settled serving-without-review judgment; untrusted origin retained; not an operator review'
            : reading.operationProvenance === 'classic' ? 'Classic operation: semantic serving approval was not evaluated; retain the untrusted draft for owner review'
            : `Pending review: serving judgment ${reading.reason ?? 'uncertain'}` }),
        nodeActivation: { ...(reading.operationProvenance === 'classic' ? {} : { battery: nodeServingWithoutReview.name, version: nodeServingWithoutReview.version }), ...reading,
          ownerConfidenceFloor, ...(activationCache ? { dependencyVersion: 1, dependencyReference: activationCache.reference } : {}),
          evidence: draft.evidence.map(({ id, extraction }) => ({ sourceId: id, extractionId: extraction?.id })),
          subjects: draft.subjects.map(({ id }) => ({ nodeId: id })) },
      } }, draft.record);
      retainKnowledgeNodeActivationReferences(store, record, draft.evidence, draft.references);
      return { ...draft, record, activationCache };
    });
    const token = Object.freeze({ count: resolved.length });
    prepared.set(token, { store, scope, nodes: resolved, written: new Set(), committed: new Map(), port: semantic ? port : undefined, model: semantic ? model : undefined,
      signal, assertCurrent: assertNative, expires: Date.now() + 30_000, readset, stage });
    assertPreparedNodeWrites(store, token, scope);
    return token;
  }
}
/** Synchronous revalidation at the actual commit boundary; copied JSON has no authority. */
export function assertPreparedNodeWrites(store: KnowledgeStore, token: KnowledgePreparedNodeWrites, scope: object): void {
  const pass = prepared.get(token);
  if (!pass || pass.scope !== scope) throw new Held('malformed');
  if (pass.signal?.aborted) throw new Held('aborted');
  if (Date.now() > pass.expires) throw new Held('stale');
  if (pass.port && (pass.port.model !== pass.model || !isClassicOperation() && currentPort() !== pass.port)) throw new Held('stale');
  pass.assertCurrent?.();
  pass.stage?.assertCurrent();
  for (const [index, draft] of pass.nodes.entries()) {
    const sameSlug = store.getNodeByKindAndSlug(draft.record.kind, draft.record.slug);
    if (sameSlug && sameSlug.id !== draft.record.id) throw new Held('stale');
    const current = draft.input.id ? store.getNode(draft.input.id) : store.getNodeByKindAndSlug(draft.input.kind, draft.input.slug);
    if (!sameActivationInput(current ?? null, pass.committed.get(draft.record.id) ?? draft.existing ?? null)
      || (!draft.authority && !draft.observation && !draft.restoration && !sameActivationInput(pass.stage?.evidenceFor(draft.record) ?? evidenceFor(store, draft.record), draft.evidence))) throw new Held('stale');
    for (const subject of draft.subjects) {
      if (!sameActivationInput(store.getNode(subject.id), pass.committed.get(subject.id) ?? subject.node)) throw new Held('stale');
    }
    draft.restoration?.();
    draft.observed?.assertCurrent();
    if (!pass.written.has(index)) draft.observation?.assertCurrent();
  }
}
export function preparedNodeWrite(store: KnowledgeStore, token: KnowledgePreparedNodeWrites, index: number, scope: object): PreparedNode {
  assertPreparedNodeWrites(store, token, scope);
  const pass = prepared.get(token)!;
  if (!Number.isInteger(index) || !pass.nodes[index] || pass.written.has(index)) throw new Held('stale');
  const draft = pass.nodes[index]!;
  return { ...draft, existing: pass.committed.get(draft.record.id) ?? draft.existing };
}
/** Collect the exact private pass without repeating its complete guard for each slot. */
export function preparedNodeWrites(store: KnowledgeStore, token: KnowledgePreparedNodeWrites, scope: object): readonly PreparedNode[] {
  const pass = prepared.get(token);
  if (!pass || pass.store !== store || pass.scope !== scope) throw new Held('malformed');
  assertPreparedNodeWrites(store, token, scope);
  const nodes: PreparedNode[] = [];
  for (let index = 0; index < pass.nodes.length; index++) {
    const draft = pass.nodes[index];
    if (!Number.isInteger(index) || !draft || pass.written.has(index)) throw new Held('stale');
    nodes.push({ ...draft, existing: pass.committed.get(draft.record.id) ?? draft.existing });
  }
  assertPreparedNodeWrites(store, token, scope);
  for (let index = 0; index < pass.nodes.length; index++) {
    if (!Number.isInteger(index) || !pass.nodes[index] || pass.written.has(index)) throw new Held('stale');
  }
  return nodes;
}
/** Perform every fallible native read/cache write inside the writer's existing
 * SQL savepoint. The returned acknowledgment changes only private pass state. */
export function stagePreparedNodeWrites(token: KnowledgePreparedNodeWrites, indices: readonly number[], sqlite: SQLiteStore): {
  readonly cacheChanged: boolean; commit(): void;
} {
  const pass = prepared.get(token);
  if (!pass || new Set(indices).size !== indices.length) throw new Held('malformed');
  const acknowledgments = indices.map(index => {
    const draft = pass.nodes[index];
    if (!Number.isInteger(index) || !draft || pass.written.has(index)) throw new Held('stale');
    return pass.readset.prepareWritten(draft.record.id, draft.record, sqlite);
  });
  const cacheChanged = pass.written.size + indices.length === pass.nodes.length ? writePreparedNodeActivationCache(token, sqlite) : false;
  return { cacheChanged, commit() {
    for (const acknowledge of acknowledgments) acknowledge();
    for (const index of indices) markPreparedNodeWritten(token, index);
  } };
}

/** Pure pass acknowledgment; native dependency writes have already succeeded. */
export function markPreparedNodeWritten(token: KnowledgePreparedNodeWrites, index: number): void {
  const pass = prepared.get(token)!, draft = pass.nodes[index]!;
  pass.written.add(index); pass.committed.set(draft.record.id, draft.record);
  // Optional compensation evidence must never introduce a failure after SQL/cache commit.
  try {
    const sources = snapshotNodeInput(evidenceFor(pass.store, draft.record));
    const subjects = snapshotNodeInput(activationSubjectIds(draft.record).map((id) => ({ id, node: pass.store.getNode(id) })));
    retainedWrites.set(draft.record, { store: pass.store, scope: pass.scope, check: () => {
      if (!sameActivationInput(evidenceFor(pass.store, draft.record), sources)
        || subjects.some(({ id, node }) => !sameActivationInput(pass.store.getNode(id), node))) throw new Held('stale');
      draft.observation?.checkEvidence();
    } });
  } catch { /* This record cannot be used as a prepared compensation capability. */ }
}

/** After every actual native node row is present, freeze the FINAL dependency
 * revisions in the same publication. This table does not restamp subject rows. */
export function writePreparedNodeActivationCache(token: KnowledgePreparedNodeWrites, sqlite: Pick<SqlDatabase, 'exec' | 'run'>): boolean {
  const pass = prepared.get(token);
  if (!pass) throw new Held('malformed');
  let changed = false;
  for (const draft of pass.nodes) {
    const cache = draft.activationCache;
    if (!cache) continue;
    const dependencies = readKnowledgeActivationDependencies(sqlite, draft.record.id,
      draft.evidence.map(entry => entry.id), draft.subjects.map(entry => entry.id), cache.observation);
    if (dependencies.nodeGeneration === null) throw new Held('stale');
    writeKnowledgeActivationCache(sqlite, draft.record.id, cache.reference, draft.record.metadata.nodeActivation, dependencies);
    changed = true;
  }
  return changed;
}
