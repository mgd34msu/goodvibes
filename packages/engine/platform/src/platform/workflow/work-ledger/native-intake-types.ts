/** Host-owned conversation input and durable intake progress, never execution authority. */
import { createHash } from 'node:crypto';
import { canonicalJson, type EntryType } from '@goodvibes-jev/judgment';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { array, enum as enumSchema, literal, number, strictObject, string } from 'zod/v4';
import { captureJevDecisionContext, validateJevDecision, opaqueUuid, type JevDecision, type JevDecisionContext, type JevDecisionBinding } from '@goodvibes-jev/judgment/decisions';
import { captureNativeConversationContinuation, canonicalNativeConversationContinuation, nativeConversationContinuationSchema, type NativeConversationContinuation } from './native-continuation-context.js';
import type { WorkLedgerStorage, WorkLedgerSubmission } from './types.js';
import { nativeClassicConversationAdmissionSchema, type NativeClassicConversationAdmission } from './native-intake-policy.js';

export const NATIVE_CONVERSATION_MAX_PROPOSALS = 3;
export const NATIVE_CONVERSATION_MAX_DECISIONS = 32;
export const NATIVE_CONVERSATION_MAX_RECORD_BYTES = 1_048_576;
export interface NativeConversationKey { readonly principalId: string; readonly inputId: string; }
export interface NativeConversationUnsupportedSource { readonly kind: 'image' | 'file' | 'context'; readonly label: string; }
export interface NativeConversationSpan { readonly partId: 'input'; readonly start: number; readonly end: number; }
export interface NativeConversationProposal { readonly sourceRevision: string; readonly spans: readonly NativeConversationSpan[]; }
export interface NativeConversationOwner {
  readonly authorityId: string; readonly authorityRevision: string; readonly authorityScopes: readonly string[];
  readonly scopeId: string; readonly scopeRevision: string; readonly projectRoot: string;
}
export interface NativeConversationDecision { readonly decision: JevDecision; readonly context: JevDecisionContext; }
export interface NativeConversationAssociation { readonly workId: string; readonly attemptId: string; readonly ledgerRevision: number; }
export interface NativeConversationCapture extends NativeConversationKey {
  readonly classic?: NativeClassicConversationAdmission;
  readonly version: 1 | 2; readonly bindingRefs?: NativeConversationBindingRefs; readonly projectId: string; readonly requestId: string;
  readonly text: string; readonly continuation?: NativeConversationContinuation | undefined; readonly unsupportedSources: readonly NativeConversationUnsupportedSource[];
  readonly sourceId: string; readonly sourceRevision: string; readonly sessionId: string; readonly owner: NativeConversationOwner;
  readonly generation: number; readonly state: 'captured' | 'processing' | 'turn' | 'blocked' | 'refused' | 'associated' | 'cancelled';
  readonly stage: 'routing' | 'extracting' | 'checking' | 'deciding' | 'waiting' | null;
  readonly route: 'converse' | 'answer' | 'contract' | null;
  readonly reason: 'unsupported-source' | 'missing-context' | 'semantic' | 'exhausted' | null;
  readonly proposalsSpent: number; readonly proposal: NativeConversationProposal | null;
  readonly decisions: readonly NativeConversationDecision[]; readonly association: NativeConversationAssociation | null;
}
export interface NativeConversationBindingRefs { readonly authorityId: string; readonly authorityRevision: string; readonly scopeId: string; readonly scopeRevision: string }
interface ValidatedCapture { readonly bindings: Map<string, JevDecisionBinding>; readonly sourceBase?: Omit<JevDecisionBinding, 'actionRevision'> }
// Private validation/cache provenance uses the original intrinsics. A later
// prototype override cannot manufacture a parsed source or its cached binding.
const nativeApply = Reflect.apply, freeze = Object.freeze, NativeMap = Map;
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set;
const nativeWeakHas = WeakSet.prototype.has, nativeWeakAdd = WeakSet.prototype.add;
const nativeMapGet = Map.prototype.get, nativeMapSet = Map.prototype.set;
function privateGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined { return nativeApply(nativeWeakGet, map, [key]); }
function privateSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void { nativeApply(nativeWeakSet, map, [key, value]); }
function privateHas(set: WeakSet<object>, key: object): boolean { return nativeApply(nativeWeakHas, set, [key]); }
function privateAdd(set: WeakSet<object>, key: object): void { nativeApply(nativeWeakAdd, set, [key]); }
const validatedCaptures = new WeakMap<NativeConversationCapture, ValidatedCapture>();
const proposalRevisions = new WeakMap<NativeConversationProposal, string>();
const validatedProposals = new WeakSet<NativeConversationProposal>();
const issuedSources = new WeakSet<object>();
export interface NativeConversationMutation<T> { readonly next: NativeConversationCapture | null; readonly value: T; }
export interface NativeConversationPublicationStorage extends WorkLedgerStorage { close(): Promise<void>; }
export interface NativeConversationStorage {
  current(key: NativeConversationKey): NativeConversationCapture | null;
  transaction<T>(key: NativeConversationKey, decide: (current: NativeConversationCapture | null) => NativeConversationMutation<T>): Promise<T>;
  /** The ordinary ledger reducer and source association share one SQLite publication. */
  publicationStorage(key: NativeConversationKey, assertCurrent: (capture: NativeConversationCapture) => void,
    finish: (capture: NativeConversationCapture, event: WorkLedgerSubmission) => NativeConversationCapture): NativeConversationPublicationStorage;
  close(): Promise<void>;
}
export class NativeConversationStorageError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'cancelled' | 'not-found' | 'closed' | 'unavailable' | 'future-version') {
    super(`Native conversation storage: ${code}`); this.name = 'NativeConversationStorageError';
  }
}
/** Compatibility only: existing version-one records and recorded sites keep
 * their original identifiers. Fresh version-two labels never use this hash. */
const historicalHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function nativeConversationSourceId(projectId: string, principalId: string, inputId: string): string { return historicalHash({ projectId, principalId, inputId }); }
function immutableSource(value: Omit<NativeConversationCapture, 'decisions'>) {
  return { version: value.version, projectId: value.projectId, principalId: value.principalId, inputId: value.inputId, requestId: value.requestId,
    text: value.text, ...(value.continuation ? { continuation: value.continuation } : {}), unsupportedSources: value.unsupportedSources,
    sourceId: value.sourceId, sourceRevision: value.sourceRevision, sessionId: value.sessionId, owner: value.owner, ...(value.bindingRefs ? { bindingRefs: value.bindingRefs } : {}) };
}
/** Durable client-held content commitment: actual saved capture adoption and
 * request replay compare this exact source, including its original owner/scope.
 * This is integrity binding, not authentication or anonymization. */
export function nativeConversationSourceRevision(value: Pick<NativeConversationCapture, 'inputId' | 'text' | 'unsupportedSources' | 'continuation'> & Partial<NativeConversationCapture>): string {
  if (value.version === 2) {
    const { sourceRevision: _revision, ...source } = immutableSource(value as NativeConversationCapture);
    return createHash('sha256').update(canonicalJson(source as unknown as EntryType)).digest('hex');
  }
  return historicalHash({ version: 1, inputId: value.inputId, text: value.text, ...(value.continuation ? { continuation: value.continuation } : {}), unsupportedSources: value.unsupportedSources.map(source => ({ kind: source.kind, label: source.label })) });
}
/** Persisted exact-range commitment: the final decision action revision and
 * ledger replay compare this value to the original ordered UTF-16 ranges. */
export function nativeConversationProposalRevision(proposal: NativeConversationProposal): string {
  const previous = privateGet(proposalRevisions, proposal); if (previous) return previous;
  const revision = createHash('sha256').update(JSON.stringify({ sourceRevision: proposal.sourceRevision, spans: proposal.spans.map(span => ({ partId: span.partId, start: span.start, end: span.end })) })).digest('hex');
  if (privateHas(validatedProposals, proposal)) privateSet(proposalRevisions, proposal, revision);
  return revision;
}
export function nativeConversationDecisionBinding(capture: NativeConversationCapture, operation: 'routing' | 'publish-work' | 'ordinary-turn'): JevDecisionBinding {
  const proof = privateGet(validatedCaptures, capture), cached = proof ? nativeApply(nativeMapGet, proof.bindings, [operation]) as JevDecisionBinding | undefined : undefined; if (cached) return cached;
  let binding: JevDecisionBinding;
  if (capture.version === 2) {
    if (!capture.bindingRefs) throw new NativeConversationStorageError('invalid');
    binding = { sourceId: capture.sourceId, inputRevision: capture.sourceRevision, actionId: capture.sourceId + ':admission',
      actionRevision: `${operation}:g${capture.generation.toString(36)}:p${capture.proposalsSpent.toString(36)}:${capture.proposal ? nativeConversationProposalRevision(capture.proposal) : 'none'}`, ...capture.bindingRefs };
  } else {
    const base = proof?.sourceBase ?? { sourceId: capture.sourceId, inputRevision: capture.sourceRevision, actionId: historicalHash({ sourceId: capture.sourceId, action: 'native-conversation-admission' }),
      authorityId: historicalHash({ pairedPrincipal: capture.owner.authorityId }), authorityRevision: historicalHash({ pairedIncarnation: capture.owner.authorityRevision }),
      scopeId: historicalHash({ workspaceScope: capture.owner.scopeId }), scopeRevision: historicalHash({ workspaceGeneration: capture.owner.scopeRevision }) };
    binding = { ...base, actionRevision: historicalHash({ operation, generation: capture.generation, proposalsSpent: capture.proposalsSpent, proposal: capture.proposal ? nativeConversationProposalRevision(capture.proposal) : null }) };
  }
  const result = freeze(binding); if (proof) nativeApply(nativeMapSet, proof.bindings, [operation, result]); return result;
}
/** Native issuance, not a caller-selected version flag or raw public IDs. */
export function createNativeConversationCapture(value: Omit<NativeConversationCapture, 'version' | 'sourceId' | 'sourceRevision' | 'bindingRefs'>): NativeConversationCapture {
  plain(value);
  const source = { ...value, version: 2 as const, sourceId: opaqueUuid(), bindingRefs: { authorityId: opaqueUuid(), authorityRevision: opaqueUuid(), scopeId: opaqueUuid(), scopeRevision: opaqueUuid() } };
  const issued = { ...source, sourceRevision: nativeConversationSourceRevision(source) }; privateAdd(issuedSources, issued);
  return parseNativeConversationCapture(issued);
}
/** Read-only validation provenance. A public copy/flag cannot skip commitment
 * verification; this marker grants no paired authority or execution permission. */
export function isValidatedNativeConversationCapture(value: unknown): value is NativeConversationCapture { return value !== null && typeof value === 'object' && privateGet(validatedCaptures, value as NativeConversationCapture) !== undefined; }
export function validatedNativeCaptureContinuation(capture: NativeConversationCapture, context: NativeConversationContinuation): boolean {
  return privateGet(validatedCaptures, capture) !== undefined && isDeepStrictEqual(capture.continuation, context);
}
const id = string().min(1).max(200);
const revision = number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeConversationSpanSchema = strictObject({ partId: literal('input'), start: revision, end: revision });
const proposalSchema = strictObject({ sourceRevision: id, spans: array(nativeConversationSpanSchema).min(1).max(100) });
/** Strict data capture rejects getters, symbols, proxies, sparse arrays and exotic prototypes. */
function plain(value: unknown, active = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
  if (typeof value !== 'object' || nodeTypes.isProxy(value) || active.has(value)) throw new NativeConversationStorageError('invalid');
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) throw new NativeConversationStorageError('invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') || (isArray && (keys.length !== value.length + 1 || Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))))) throw new NativeConversationStorageError('invalid');
  active.add(value);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new NativeConversationStorageError('invalid');
    plain(descriptor.value, active);
  }
  active.delete(value);
}
function splitsSurrogate(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}
/** Offsets address UTF-16 code units in the single immutable input part. */
export function validateNativeConversationProposal(value: unknown, text: string, sourceRevision: string): NativeConversationProposal {
  try {
    plain(value); const proposal = proposalSchema.parse(value);
    if (proposal.sourceRevision !== sourceRevision) throw new Error();
    let previousEnd = 0;
    for (const span of proposal.spans) {
      if (span.start < previousEnd || span.end <= span.start || span.end > text.length
        || splitsSurrogate(text, span.start) || splitsSurrogate(text, span.end) || !text.slice(span.start, span.end).trim()) throw new Error();
      previousEnd = span.end;
    }
    const result = freeze({ sourceRevision: proposal.sourceRevision, spans: freeze(proposal.spans.map(span => freeze({ ...span }))) });
    privateAdd(validatedProposals, result); return result;
  } catch { throw new NativeConversationStorageError('invalid'); }
}
const captureFields = {
  classic: nativeClassicConversationAdmissionSchema.optional(),
  projectId: id, principalId: id, inputId: id, requestId: id,
  text: string().min(1).max(20_000)
    .refine(value => value.length <= 20_000, 'Must contain at most 20000 UTF-16 code units')
    .refine(value => value.trim().length > 0),
  continuation: nativeConversationContinuationSchema.optional(),
  unsupportedSources: array(strictObject({ kind: enumSchema(['image', 'file', 'context']), label: string().min(1).max(200) })).max(100),
  sourceId: id, sourceRevision: id, sessionId: id,
  owner: strictObject({ authorityId: id, authorityRevision: id, authorityScopes: array(id).max(100), scopeId: id, scopeRevision: id, projectRoot: string().min(1).max(4096) }),
  generation: revision.min(1), state: enumSchema(['captured', 'processing', 'turn', 'blocked', 'refused', 'associated', 'cancelled']),
  stage: enumSchema(['routing', 'extracting', 'checking', 'deciding', 'waiting']).nullable(),
  route: enumSchema(['converse', 'answer', 'contract']).nullable(), reason: enumSchema(['unsupported-source', 'missing-context', 'semantic', 'exhausted']).nullable(),
  proposalsSpent: revision.max(NATIVE_CONVERSATION_MAX_PROPOSALS), proposal: proposalSchema.nullable(),
  association: strictObject({ workId: id, attemptId: id, ledgerRevision: revision.min(1) }).nullable(),
};
const opaque = string().regex(/^[a-p]{8}(?:-[a-p]{4}){3}-[a-p]{12}$/);
const captureSchemas = {
  1: strictObject({ ...captureFields, version: literal(1) }),
  2: strictObject({ ...captureFields, version: literal(2), sourceId: opaque, bindingRefs: strictObject({ authorityId: opaque, authorityRevision: opaque, scopeId: opaque, scopeRevision: opaque }) }),
};
export function parseNativeConversationCapture(value: unknown, original?: NativeConversationCapture): NativeConversationCapture {
  try {
    if (value !== null && typeof value === 'object' && privateGet(validatedCaptures, value as NativeConversationCapture) !== undefined) {
      const captured = value as NativeConversationCapture;
      if (original && privateGet(validatedCaptures, original) !== undefined && !isDeepStrictEqual(immutableSource(captured), immutableSource(original))) throw new Error();
      return captured;
    }
    plain(value);
    const { decisions, ...rest } = value as NativeConversationCapture;
    const schema = rest.version === 1 ? captureSchemas[1] : rest.version === 2 ? captureSchemas[2] : null;
    if (!schema) throw new Error();
    const { classic, ...fields } = schema.parse(rest);
    const parsed = { ...fields, ...(classic ? { classic } : {}) };
    const prior = original && privateGet(validatedCaptures, original);
    const sameSource = original !== undefined && prior !== undefined && isDeepStrictEqual(immutableSource(parsed), immutableSource(original));
    if (prior !== undefined && !sameSource) throw new Error();
    const refs = 'bindingRefs' in parsed ? parsed.bindingRefs : undefined;
    if (!Array.isArray(decisions) || decisions.length > NATIVE_CONVERSATION_MAX_DECISIONS
      || new Set(parsed.owner.authorityScopes).size !== parsed.owner.authorityScopes.length
      || (parsed.version === 1 && parsed.continuation?.version === 2)
      || (parsed.version === 2 && (!refs || new Set([parsed.sourceId, ...Object.values(refs)]).size !== 5))) throw new Error();
    if (!sameSource && !privateHas(issuedSources, value as object) && ((parsed.version === 1 && parsed.sourceId !== nativeConversationSourceId(parsed.projectId, parsed.principalId, parsed.inputId))
      || parsed.sourceRevision !== nativeConversationSourceRevision(parsed))) throw new Error();
    if (!sameSource && parsed.continuation && parsed.continuation.version !== 2 && parsed.continuation.revision !== createHash('sha256').update(canonicalNativeConversationContinuation(parsed.continuation.sessionId, parsed.continuation.messages, parsed.continuation.selectedDiff)).digest('hex')) throw new Error();
    const proposal = parsed.proposal === null ? null : sameSource && original?.proposal && isDeepStrictEqual(parsed.proposal, original.proposal) ? original.proposal : validateNativeConversationProposal(parsed.proposal, parsed.text, parsed.sourceRevision);
    const baseCapture = { ...parsed, proposal, decisions: [] } as NativeConversationCapture;
    const stateSame = sameSource && original !== undefined && original.generation === parsed.generation && original.proposalsSpent === parsed.proposalsSpent && isDeepStrictEqual(original.proposal, proposal);
    const bindings = new NativeMap<string, JevDecisionBinding>();
    if (stateSame && prior) for (const operation of ['routing', 'publish-work', 'ordinary-turn'] as const) {
      const cached = nativeApply(nativeMapGet, prior.bindings, [operation]) as JevDecisionBinding | undefined;
      if (cached) nativeApply(nativeMapSet, bindings, [operation, cached]);
    }
    let sourceBase = sameSource ? prior?.sourceBase : undefined;
    if (parsed.version === 1 && !sourceBase) { const first = nativeConversationDecisionBinding(baseCapture, 'routing'); const { actionRevision: _action, ...base } = first; sourceBase = base; nativeApply(nativeMapSet, bindings, ['routing', first]); }
    const metadata: ValidatedCapture = { bindings, ...(sourceBase ? { sourceBase } : {}) }; privateSet(validatedCaptures, baseCapture, metadata);
    const retained = decisions.map(entry => {
      if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'decision') || !Object.hasOwn(entry, 'context')) throw new Error();
      const context = captureJevDecisionContext(entry.context); const decision = validateJevDecision(entry.decision, context);
      const expected = nativeConversationDecisionBinding(baseCapture, 'routing');
      if (Object.keys(expected).some(key => key !== 'actionRevision' && decision.binding[key as keyof JevDecisionBinding] !== expected[key as keyof JevDecisionBinding])) throw new Error();
      return { decision, context };
    });
    if (new Set(retained.map(entry => entry.decision.decisionId)).size !== retained.length) throw new Error();
    if ((parsed.state === 'processing') !== (parsed.stage !== null)) throw new Error();
    if (proposal && parsed.proposalsSpent < 1) throw new Error();
    if ((parsed.state === 'associated') !== (parsed.association !== null)) throw new Error();
    const result = { ...parsed, proposal, ...(parsed.continuation ? { continuation: sameSource && original?.continuation ? original.continuation : captureNativeConversationContinuation(parsed.continuation) } : {}), decisions: retained };
    privateSet(validatedCaptures, result, metadata);
    if (parsed.state === 'turn') {
      const final = retained.at(-1)?.decision;
      if (!['converse', 'answer'].includes(parsed.route ?? '') || parsed.unsupportedSources.length) throw new Error();
      if (parsed.classic) {
        if (parsed.route !== 'converse' || retained.some(entry => entry.decision.outcome === 'reject') || parsed.association !== null) throw new Error();
      } else if (final?.outcome !== 'act' || !isDeepStrictEqual(final.binding, nativeConversationDecisionBinding(result, 'ordinary-turn'))) throw new Error();
    }
    if (parsed.classic && parsed.state !== 'turn' && parsed.state !== 'cancelled') throw new Error();
    if (!isDeepStrictEqual(result, value) || new TextEncoder().encode(JSON.stringify(result)).byteLength > NATIVE_CONVERSATION_MAX_RECORD_BYTES) throw new Error();
    return freezeCapture(result);
  } catch { throw new NativeConversationStorageError('invalid'); }
}

function freezeCapture<T>(value: T): T {
  const pending: unknown[] = [value], seen = new Set<object>();
  while (pending.length) {
    const node = pending.pop(); if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node); for (const child of Object.values(node)) pending.push(child); freeze(node);
  }
  return value;
}
