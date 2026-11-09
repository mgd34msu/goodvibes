/** Browser-safe immutable conversation evidence. A snapshot is never execution authority. */
import { captureNativeSelectedDiffContext, nativeSelectedDiffContextSchema, nativeSelectedDiffSelectorSchema, type NativeSelectedDiffContext } from './native-diff-context.js';
import { array, enum as enumSchema, literal, strictObject, string, type z } from 'zod/v4';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';

export const NATIVE_CONVERSATION_CONTINUATION_MAX_MESSAGES = Infinity;
export const NATIVE_CONVERSATION_CONTINUATION_MAX_BYTES = Infinity;
const id = string().min(1).max(200);
// Spell out the fixed-width segments so generated structural contracts remain
// compatible with the synchronous client's conservative nested-repeat veto.
export const NATIVE_CONTINUATION_OPAQUE_PATTERN = /^[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/;
const nativeApply = Reflect.apply, freeze = Object.freeze;
const nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set;
const nativeWeakHas = WeakSet.prototype.has, nativeWeakAdd = WeakSet.prototype.add;
const snapshotOwners = new WeakMap<object, object>();
const capturedContexts = new WeakSet<object>();
const continuationRef = strictObject({ version: literal(2).optional(), sessionId: id, revision: string().max(200).regex(/^(?:[a-f0-9]{64}|[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12})$/), selectedDiff: nativeSelectedDiffSelectorSchema.optional() });
const validRevision = (value: { readonly version?: 2 | undefined; readonly revision: string }) => value.version === 2 ? NATIVE_CONTINUATION_OPAQUE_PATTERN.test(value.revision) : /^[a-f0-9]{64}$/.test(value.revision);
export const nativeConversationContinuationRefSchema = continuationRef.refine(validRevision, 'Invalid continuation revision');
export const nativeConversationContinuationMessageSchema = strictObject({ role: enumSchema(['user', 'assistant', 'system', 'tool']), content: string() });
export const nativeConversationContinuationSchema = continuationRef.extend({
  selectedDiff: nativeSelectedDiffContextSchema.optional(),
  messages: array(nativeConversationContinuationMessageSchema).readonly(),
}).refine(validRevision, 'Invalid continuation revision').refine(value => value.selectedDiff?.kind !== 'session' || value.selectedDiff.provenance.sessionId === value.sessionId, 'Selected diff session mismatch');
export type NativeConversationContinuation = Readonly<Omit<z.infer<typeof nativeConversationContinuationSchema>, 'messages'> & {
  readonly messages: readonly Readonly<z.infer<typeof nativeConversationContinuationMessageSchema>>[];
}>;

/** Inspect descriptors before any schema access; never evaluate supplied accessors. */
function data(value: unknown, seen = new Set<object>()): void {
  if (typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Invalid native continuation context');
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)) throw new Error('Invalid native continuation context');
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string') || (isArray && (keys.length !== value.length + 1 || Array.from({ length: value.length }, (_, i) => i).some(i => !Object.hasOwn(value, i))))) throw new Error('Invalid native continuation context');
  seen.add(value);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new Error('Invalid native continuation context');
    if (!(isArray && key === 'length')) data(descriptor.value, seen);
  }
  seen.delete(value);
}

/** Strictly captures all available messages without truncating conversation evidence. */
export function captureNativeConversationContinuation(value: unknown): NativeConversationContinuation {
  if (value !== null && typeof value === 'object' && nativeApply(nativeWeakHas, capturedContexts, [value])) return value as NativeConversationContinuation;
  data(value);
  const parsed = nativeConversationContinuationSchema.parse(value);
  if (parsed.version === 2 ? !NATIVE_CONTINUATION_OPAQUE_PATTERN.test(parsed.revision) : !/^[a-f0-9]{64}$/.test(parsed.revision)) throw new Error('Invalid native continuation revision');
  const result = freeze({ ...(parsed.version === 2 ? { version: 2 as const } : {}), sessionId: parsed.sessionId, revision: parsed.revision,
    ...(parsed.selectedDiff ? { selectedDiff: captureNativeSelectedDiffContext(parsed.selectedDiff) } : {}),
    messages: freeze(parsed.messages.map(message => freeze({ ...message }))) });
  nativeApply(nativeWeakAdd, capturedContexts, [result]);
  const owner = nativeApply(nativeWeakGet, snapshotOwners, [value as object]) as object | undefined; if (owner) nativeApply(nativeWeakSet, snapshotOwners, [result, owner]);
  return result;
}

/** Historical standalone transcript commitment recipe. Fresh v2 snapshots use
 * an opaque label, bound by the complete persisted intake source instead. */
export function canonicalNativeConversationContinuation(sessionId: string, messages: NativeConversationContinuation['messages'], selectedDiff?: NativeSelectedDiffContext): string {
  return JSON.stringify({ sessionId, messages: messages.map(message => ({ role: message.role, content: message.content })), ...(selectedDiff ? { selectedDiff } : {}) });
}

/** An issuer belongs to one real live session. Another issuer, JSON, a spread
 * or an unchecked version flag cannot mint that session's original snapshot. */
export function createNativeContinuationSnapshotOwner() {
  const owner = freeze({});
  const owns = (value: NativeConversationContinuation) => nativeApply(nativeWeakGet, snapshotOwners, [value]) === owner;
  const capture = (sessionId: string, messages: NativeConversationContinuation['messages'], selectedDiff?: NativeSelectedDiffContext): NativeConversationContinuation => {
    const result = captureNativeConversationContinuation({ version: 2, sessionId, revision: opaqueUuid(), messages, ...(selectedDiff ? { selectedDiff } : {}) });
    nativeApply(nativeWeakSet, snapshotOwners, [result, owner]); return result;
  };
  return freeze({ capture, owns, withSelectedDiff(value: NativeConversationContinuation, selectedDiff: NativeSelectedDiffContext): NativeConversationContinuation {
    if (!owns(value)) throw new Error('Original native continuation snapshot is unavailable');
    return capture(value.sessionId, value.messages, selectedDiff);
  } });
}
