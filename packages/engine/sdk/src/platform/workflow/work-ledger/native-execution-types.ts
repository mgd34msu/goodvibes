import type { NativeCiContinuationStorage } from './native-ci-continuation-types.js';
import type { NativeWorkSettlementReceipt, NativeWorkSettlementPublication } from './native-settlement-types.js';
/** Host-only native execution records. Ledger reports are never execution authority. */
import { types as nodeTypes } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { captureJevDecisionContext, validateJevDecision, type JevDecision, type JevDecisionContext } from '@goodvibes-jev/judgment/decisions';
import { freezeDurableRequest, parseDurableAdmission, durableKeyHash, durableKeyIdentity, type DurableContractReceipt, type DurableContractRequest } from '../../contract/durable-admission.js';
import type { WorkLedgerState } from './types.js';

export interface NativeWorkExecutionTarget {
  readonly workId: string;
  readonly workRevision: number;
  readonly criteriaRevision: number;
  readonly attemptId: string;
  readonly attemptRevision: number;
}
export interface NativeWorkExecutionRecord {
  readonly version: 1 | 2;
  readonly owner?: NativeExecutionOwnerFacts;
  readonly projectId: string;
  readonly target: NativeWorkExecutionTarget;
  readonly authorityScopes: readonly string[];
  readonly request: DurableContractRequest;
  readonly decision: JevDecision;
  readonly decisionContext: JevDecisionContext;
  readonly receipt: DurableContractReceipt | null;
  readonly state: 'prepared' | 'launch-claimed' | 'cancelled';
}
/** A host request reservation, never a Jev decision or permission to execute. */
export interface NativeWorkExecutionIntent {
  readonly version: 1 | 2;
  readonly owner?: NativeExecutionOwnerFacts;
  readonly projectId: string;
  readonly target: NativeWorkExecutionTarget;
  readonly authorityScopes: readonly string[];
  readonly request: DurableContractRequest;
  readonly generation: number;
  readonly state: 'admitting' | 'associated' | 'cancelled' | 'refused';
}
export class NativeWorkExecutionError extends Error {
  constructor(readonly code: 'unavailable' | 'unsupported-authority' | 'stale' | 'conflict' | 'recovery-required' | 'closed' | 'invalid' | 'refused' | 'not-found' | 'pending-intent' | 'prevented-before-admission', readonly decision?: JevDecision) {
    super(`Native work execution: ${code}`); this.name = 'NativeWorkExecutionError';
  }
}
/** Private original facts, never copied into public protocol labels. Paired
 * principal/authority id and token/incarnation equality are checked by the host. */
export interface NativeExecutionOwnerFacts { readonly principalId: string; readonly authorityRevision: string; readonly scopeId: string; readonly scopeRevision: string }
export type NativeExecutionOriginal = NativeWorkExecutionRecord | NativeWorkExecutionIntent;
interface NativeRecordOrigin { storedKey?: string; observedOwner?: NativeExecutionOwnerFacts }
interface NativeRequestOwner { readonly projectId: string; readonly projectRoot: string; readonly owner: NativeExecutionOwnerFacts; readonly authorityScopes: readonly string[]; readonly commitment: string }
const nativeApply = Reflect.apply, nativeGet = WeakMap.prototype.get, nativeSet = WeakMap.prototype.set, freeze = Object.freeze;
const nativeWeakHas = WeakSet.prototype.has, nativeWeakAdd = WeakSet.prototype.add, nativeJsonParse = JSON.parse, clone = structuredClone, isProxy = nodeTypes.isProxy;
const originals = new WeakMap<NativeExecutionOriginal, NativeRecordOrigin>();
const requestOwners = new WeakMap<DurableContractRequest, NativeRequestOwner>();
const decodedJson = new WeakSet<object>();
const origin = (value: NativeExecutionOriginal) => nativeApply(nativeGet, originals, [value]) as NativeRecordOrigin | undefined;
function immutable(value: NativeExecutionOriginal) { return { version: value.version, projectId: value.projectId, target: value.target, authorityScopes: value.authorityScopes, request: value.request, ...(value.owner ? { owner: value.owner } : {}) }; }
function source(value: unknown, previous?: NativeExecutionOriginal): Record<string, unknown> {
  // Native JSON decoding already creates fresh data-only ordinary objects.
  // Other callers first cross a descriptor-safe detached snapshot; cloning
  // that snapshot normalizes its null prototypes without touching getters.
  const captured = value && typeof value === 'object' && nativeApply(nativeWeakHas, decodedJson, [value])
    ? value : clone(captureOwnedJson(value, isProxy));
  if (captured === null || typeof captured !== 'object' || Array.isArray(captured)) throw new Error();
  if (previous && origin(previous) && !isDeepStrictEqual(immutable(captured as unknown as NativeExecutionOriginal), immutable(previous))) throw new Error();
  const request = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'request') : undefined;
  if (request && 'value' in request && request.value && typeof request.value === 'object'
    && nativeApply(nativeGet, requestOwners, [request.value]) && isDeepStrictEqual((captured as Record<string, unknown>)['request'], request.value)) {
    Object.defineProperty(captured, 'request', { value: request.value, enumerable: true });
  }
  return captured as Record<string, unknown>;
}
function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor);
}
function common(value: Record<string, unknown>, previous?: NativeExecutionOriginal) {
  if ((value['version'] !== 1 && value['version'] !== 2) || typeof value['projectId'] !== 'string' || !value['projectId']) throw new Error();
  const target = value['target'], scopes = value['authorityScopes'];
  if (!fields(target, ['workId', 'attemptId', 'workRevision', 'criteriaRevision', 'attemptRevision'])
    || !['workId', 'attemptId'].every(key => typeof target[key] === 'string' && target[key])
    || !['workRevision', 'criteriaRevision', 'attemptRevision'].every(key => Number.isSafeInteger(target[key]) && Number(target[key]) >= 0)
    || !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string' || !scope) || new Set(scopes).size !== scopes.length) throw new Error();
  const owner = value['owner'];
  if (value['version'] === 2 && (!fields(owner, ['principalId', 'authorityRevision', 'scopeId', 'scopeRevision'])
    || Object.values(owner).some(item => typeof item !== 'string' || !item))) throw new Error();
  const request = previous && origin(previous) && isDeepStrictEqual(previous.request, value['request']) ? previous.request : freezeDurableRequest(value['request'] as DurableContractRequest);
  if (request.key.workId !== target['workId'] || request.key.attemptId !== target['attemptId'] || request.key.criteriaRevision !== String(target['criteriaRevision']) || !request.input.nativeSource) throw new Error();
  if (value['version'] === 2) {
    const expected = { projectId: value['projectId'], projectRoot: request.input.projectRoot, owner: owner as unknown as NativeExecutionOwnerFacts, authorityScopes: [...scopes].sort() as string[] };
    const held = nativeApply(nativeGet, requestOwners, [request]) as NativeRequestOwner | undefined;
    if (!held || !isDeepStrictEqual({ projectId: held.projectId, projectRoot: held.projectRoot, owner: held.owner, authorityScopes: held.authorityScopes }, expected)) {
      const commitment = ownerCommitment(expected);
      if (request.binding.authorityRevision !== commitment) throw new Error();
      nativeApply(nativeSet, requestOwners, [request, freeze({ ...expected, commitment })]);
    } else if (request.binding.authorityRevision !== held.commitment) throw new Error();
  }
  return { version: value['version'] as 1 | 2, projectId: value['projectId'], authorityScopes: freeze([...scopes]) as readonly string[],
    target: freeze({ workId: String(target['workId']), workRevision: Number(target['workRevision']), criteriaRevision: Number(target['criteriaRevision']), attemptId: String(target['attemptId']), attemptRevision: Number(target['attemptRevision']) }),
    request, ...(value['version'] === 2 ? { owner: freeze({ ...owner as unknown as NativeExecutionOwnerFacts }) } : {}) };
}
/** One saved owner/scope commitment is necessary: opaque aliases alone do not
 * bind a receipt to the private original principal/incarnation/scope facts.
 * This integrity check is not authentication against rewriting both records. */
function ownerCommitment(value: Omit<NativeRequestOwner, 'commitment'>): string {
  return createHash('sha256').update(JSON.stringify({ version: 2, projectId: value.projectId, projectRoot: value.projectRoot,
    principalId: value.owner.principalId, authorityRevision: value.owner.authorityRevision, scopeId: value.owner.scopeId, scopeRevision: value.owner.scopeRevision,
    authorityScopes: [...value.authorityScopes].sort() })).digest('hex');
}
/** Actual native construction computes the owner commitment once and keeps
 * only weak request provenance. Saved/copied JSON must independently verify. */
export function bindNativeExecutionRequest(request: DurableContractRequest, projectId: string, owner: NativeExecutionOwnerFacts, authorityScopes: readonly string[]): DurableContractRequest {
  if (typeof projectId !== 'string' || !projectId) throw new NativeWorkExecutionError('invalid');
  const input = clone(captureOwnedJson(request, isProxy)) as DurableContractRequest;
  const facts = clone(captureOwnedJson({ owner, authorityScopes }, isProxy)) as { owner: NativeExecutionOwnerFacts; authorityScopes: string[] };
  if (!fields(facts.owner, ['principalId', 'authorityRevision', 'scopeId', 'scopeRevision']) || Object.values(facts.owner).some(value => typeof value !== 'string' || !value)
    || !Array.isArray(facts.authorityScopes) || facts.authorityScopes.some(scope => typeof scope !== 'string' || !scope) || new Set(facts.authorityScopes).size !== facts.authorityScopes.length) throw new NativeWorkExecutionError('invalid');
  const data = { projectId, projectRoot: input.input.projectRoot, owner: freeze(facts.owner), authorityScopes: freeze([...facts.authorityScopes].sort()) };
  const commitment = ownerCommitment(data), result = freezeDurableRequest({ ...input, binding: { ...input.binding, authorityRevision: commitment } });
  nativeApply(nativeSet, requestOwners, [result, freeze({ ...data, commitment })]); return result;
}
function retain<T extends NativeExecutionOriginal>(value: T, previous?: NativeExecutionOriginal): T {
  const held = previous && origin(previous), pending: unknown[] = [value], seen = new Set<object>();
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== 'object' || seen.has(node) || (held && node === previous.request)) continue;
    seen.add(node); for (const child of Object.values(node)) pending.push(child); freeze(node);
  }
  nativeApply(nativeSet, originals, [value, held || {}]); return value;
}
/** Data validation only. Native paired/scope owners still independently own
 * authority. Public copies cannot inherit original saved-receipt verification. */
export function parseNativeWorkExecutionRecord(value: unknown, previous?: NativeExecutionOriginal): NativeWorkExecutionRecord {
  try {
    if (value && typeof value === 'object' && origin(value as NativeExecutionOriginal)) {
      if (previous && origin(previous) && !isDeepStrictEqual(immutable(value as NativeExecutionOriginal), immutable(previous))) throw new Error();
      if (Object.hasOwn(value, 'generation')) throw new Error(); return value as NativeWorkExecutionRecord;
    }
    const row = source(value, previous), version = row['version'];
    if (!fields(row, ['version', 'projectId', 'target', 'authorityScopes', 'request', 'decision', 'decisionContext', 'receipt', 'state', ...(version === 2 ? ['owner'] : [])])) throw new Error();
    const data = common(row, previous), decisionContext = captureJevDecisionContext(row['decisionContext'] as JevDecisionContext), decision = validateJevDecision(row['decision'], decisionContext);
    if (decision.outcome !== 'act' || !isDeepStrictEqual(decision.binding, data.request.binding)) throw new Error();
    let receipt: DurableContractReceipt | null = null;
    if (row['receipt'] !== null) {
      if (previous && origin(previous) && 'receipt' in previous && previous.receipt && isDeepStrictEqual(row['receipt'], previous.receipt)) receipt = previous.receipt;
      else {
        if (!row['receipt'] || typeof row['receipt'] !== 'object' || Array.isArray(row['receipt'])) throw new Error();
        const admission = parseDurableAdmission({ ...row['receipt'], input: data.request.input }, data.request);
        if (!isDeepStrictEqual(admission.binding, data.request.binding) || !isDeepStrictEqual(admission.key, data.request.key)) throw new Error();
        const { input: _input, ...parsed } = admission; receipt = freeze(parsed);
      }
    }
    if (!['prepared', 'launch-claimed', 'cancelled'].includes(String(row['state'])) || (row['state'] === 'launch-claimed' && !receipt)) throw new Error();
    return retain({ ...data, receipt, decision, decisionContext, state: row['state'] as NativeWorkExecutionRecord['state'] }, previous);
  } catch { throw new NativeWorkExecutionError('invalid'); }
}
export function parseNativeWorkExecutionIntent(value: unknown, previous?: NativeExecutionOriginal): NativeWorkExecutionIntent {
  try {
    if (value && typeof value === 'object' && origin(value as NativeExecutionOriginal)) {
      if (previous && origin(previous) && !isDeepStrictEqual(immutable(value as NativeExecutionOriginal), immutable(previous))) throw new Error();
      if (!Object.hasOwn(value, 'generation')) throw new Error(); return value as NativeWorkExecutionIntent;
    }
    const row = source(value, previous), version = row['version'];
    if (!fields(row, ['version', 'projectId', 'target', 'authorityScopes', 'request', 'generation', 'state', ...(version === 2 ? ['owner'] : [])])) throw new Error();
    const data = common(row, previous);
    if (!Number.isSafeInteger(row['generation']) || Number(row['generation']) < 1 || !['admitting', 'associated', 'cancelled', 'refused'].includes(String(row['state']))) throw new Error();
    return retain({ ...data, generation: Number(row['generation']), state: row['state'] as NativeWorkExecutionIntent['state'] }, previous);
  } catch { throw new NativeWorkExecutionError('invalid'); }
}
function decode(json: string): unknown {
  if (typeof json !== 'string') throw new NativeWorkExecutionError('invalid');
  try {
    const value: unknown = nativeJsonParse(json);
    if (value && typeof value === 'object') nativeApply(nativeWeakAdd, decodedJson, [value]); return value;
  } catch { throw new NativeWorkExecutionError('invalid'); }
}
/** These perform actual native JSON decoding, not a public provenance flag.
 * Neither decoding nor parsing confers paired or execution authority. */
export function parseNativeWorkExecutionRecordJson(json: string, previous?: NativeExecutionOriginal): NativeWorkExecutionRecord { return parseNativeWorkExecutionRecord(decode(json), previous); }
export function parseNativeWorkExecutionIntentJson(json: string, previous?: NativeExecutionOriginal): NativeWorkExecutionIntent { return parseNativeWorkExecutionIntent(decode(json), previous); }
/** Native SQLite v2 stores the exact bounded public key. Historical digest
 * indices are verified once per actual retained immutable original, not per poll. */
export function nativeExecutionStorageKey(value: NativeExecutionOriginal): string {
  const held = origin(value); if (held?.storedKey) return held.storedKey;
  const key = value.version === 2 ? 'v2:' + durableKeyIdentity(value.request.key) : durableKeyHash(value.request.key);
  if (held) held.storedKey = key; return key;
}
/** Compatibility cache only: v1 rows retain their original hash protocol. The
 * cache is private to an actually parsed immutable record; JSON copies recheck. */
export function nativeExecutionOwnerMatches(value: NativeExecutionOriginal, observed: NativeExecutionOwnerFacts): boolean {
  if (value.version === 2) return isDeepStrictEqual(value.owner, observed);
  const held = origin(value); if (held?.observedOwner) return isDeepStrictEqual(held.observedOwner, observed);
  const legacy = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const binding = value.request.binding;
  const matches = binding.authorityId === legacy({ pairedPrincipal: observed.principalId }) && binding.authorityRevision === legacy({ pairedIncarnation: observed.authorityRevision })
    && binding.scopeId === legacy({ workspaceScope: observed.scopeId }) && binding.scopeRevision === legacy({ workspaceGeneration: observed.scopeRevision });
  if (matches && held) held.observedOwner = freeze({ ...observed }); return matches;
}
export interface NativeWorkExecutionTransaction {
  readonly ledger: WorkLedgerState;
  readonly record: NativeWorkExecutionRecord | null;
  readonly intent: NativeWorkExecutionIntent | null;
  readonly settlement?: NativeWorkSettlementReceipt | null;
}
export interface NativeWorkExecutionMutation<T> {
  readonly next: NativeWorkExecutionRecord | null;
  /** Omission or null preserves the current intent, including cancellation tombstones. */
  readonly nextIntent?: NativeWorkExecutionIntent | null;
  readonly value: T;
}
export interface NativeWorkExecutionStorage {
  readonly continuations?: NativeCiContinuationStorage;
  /** Authoritative synchronous reads, required before every semantic/tool operation. */
  current(key: DurableContractRequest['key'], original?: NativeExecutionOriginal): NativeWorkExecutionTransaction;
  /** Unique persisted association; ledger edits cannot strand inspection or cancellation. */
  currentByAttempt(attemptId: string, original?: NativeExecutionOriginal): NativeWorkExecutionTransaction;
  transaction<T>(key: DurableContractRequest['key'], decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void, original?: NativeExecutionOriginal): Promise<T>;
  transactionByAttempt<T>(attemptId: string, decide: (current: NativeWorkExecutionTransaction) => NativeWorkExecutionMutation<T>, afterDurable?: (value: T, current: () => NativeWorkExecutionTransaction) => void, original?: NativeExecutionOriginal): Promise<T>;
  /** Atomic report, evidence and native settlement publication in the existing ledger transaction. */
  settle?(key: DurableContractRequest['key'], decide: (current: NativeWorkExecutionTransaction) => NativeWorkSettlementPublication | null,
    assertCurrent: () => void): Promise<NativeWorkSettlementReceipt>;
  close(): Promise<void>;
}
