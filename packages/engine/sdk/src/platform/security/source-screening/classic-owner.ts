import { types as nodeTypes } from 'node:util';
import { judgmentInputProblem, JudgmentInputError } from '../../gate/judgment-input.js';
import { captureScreeningSource, type ScreeningSource } from './proposal.js';
import { captureResearchReference, WITHHELD_RESEARCH_REFERENCE, type CapturedResearchReference } from './reference.js';
import { assertScreeningOperation, captureScreeningOperation } from './operation.js';
import { SOURCE_SCREENING_LIMITS, type ProtectedSourceOwner, type ProtectedSource, type ProtectedResearchReference,
  type SourceScreeningReceipt, type ResearchReferenceScreeningReceipt, type ResearchReferenceOperation,
  type SourceScreeningResult, type LocalSourceScreeningAuthority, type HostedSourceScreeningAuthority } from './types.js';

/** Local declared-literal screening only. Query-role semantics are unavailable, so query-bearing references are omitted. */
export function classicScreeningParts(source: ScreeningSource, reference?: CapturedResearchReference): readonly string[] {
  const problem = judgmentInputProblem(source.parts);
  if (problem) throw new JudgmentInputError(problem);
  if (reference) return Object.freeze([reference.malformed || reference.parameters.length ? WITHHELD_RESEARCH_REFERENCE : reference.original]);
  return source.parts;
}

/** A genuine local screening receipt with Classic provenance, never a Jev reading or semantic privacy certificate. */
export function createClassicProtectedSourceOwner(authority: Pick<LocalSourceScreeningAuthority | HostedSourceScreeningAuthority,
  'ownerId' | 'revision' | 'signal' | 'assertCurrent'>): ProtectedSourceOwner {
  const invalid = (): never => { throw new Error('Classic source authority is unavailable'); };
  if (!authority || typeof authority !== 'object' || nodeTypes.isProxy(authority)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(authority);
  if (prototype !== Object.prototype && prototype !== null) return invalid();
  const fields = Object.getOwnPropertyDescriptors(authority), keys = Reflect.ownKeys(fields);
  if (keys.some(key => typeof key !== 'string' || !['ownerId', 'revision', 'signal', 'assertCurrent', 'kind', 'retention'].includes(key)
    || !Object.hasOwn(fields[key]!, 'value'))) return invalid();
  const signal = fields.signal?.value as AbortSignal, check = fields.assertCurrent?.value as (() => void);
  const ownerId: unknown = fields.ownerId?.value, revision: unknown = fields.revision?.value;
  if (typeof check !== 'function' || nodeTypes.isProxy(check) || typeof ownerId !== 'string' || typeof revision !== 'string'
    || !/^[\x21-\x7e]{1,128}$/.test(ownerId) || !/^[\x21-\x7e]{1,128}$/.test(revision)
    || nodeTypes.isProxy(signal) || !(signal instanceof AbortSignal)) return invalid();
  const assertAuthority = () => {
    if (Object.getPrototypeOf(authority) !== prototype || Reflect.ownKeys(authority).length !== keys.length) return invalid();
    for (const key of keys) {
      const now = Object.getOwnPropertyDescriptor(authority, key), before = fields[key as string];
      if (!before || !now || !Object.hasOwn(now, 'value') || now.value !== before.value
        || now.configurable !== before.configurable || now.enumerable !== before.enumerable || now.writable !== before.writable) return invalid();
    }
  };
  let closed = false;
  type Handle = ProtectedSource | ProtectedResearchReference;
  type Receipt = SourceScreeningReceipt | ResearchReferenceScreeningReceipt;
  interface Entry { readonly source: ScreeningSource; readonly reference?: CapturedResearchReference; released: boolean; }
  const sources = new Map<Handle, Entry>();
  const receipts = new Map<Receipt, { readonly entry: Entry; readonly parts: readonly string[] }>();
  const current = (entry?: Entry, operation?: ResearchReferenceOperation) => {
    assertAuthority();
    if (closed || entry?.released) throw new Error('Classic source authority changed');
    assertScreeningOperation({ signal, assertCurrent: check });
    assertScreeningOperation(operation); assertAuthority();
    if (closed || entry?.released) throw new Error('Classic source authority changed');
  };
  const capture = (parts: readonly string[], reference?: CapturedResearchReference): Handle => {
    current();
    if (sources.size >= SOURCE_SCREENING_LIMITS.sources) throw new Error('Classic source capacity reached');
    const source = captureScreeningSource(parts); current();
    const handle = Object.freeze({}) as Handle;
    sources.set(handle, { source, ...(reference ? { reference } : {}), released: false });
    return handle;
  };
  const screen = async (handle: Handle, reference: boolean, raw?: ResearchReferenceOperation): Promise<SourceScreeningResult> => {
    const entry = sources.get(handle);
    if (!entry || Boolean(entry.reference) !== reference) return { status: 'held', reason: 'stale' };
    let operation: ResearchReferenceOperation | undefined;
    try {
      operation = captureScreeningOperation(raw);
      current(entry, operation);
      const parts = classicScreeningParts(entry.source, entry.reference);
      current(entry, operation);
      const receipt = Object.freeze({ provenance: 'classic' }) as SourceScreeningReceipt;
      receipts.set(receipt, { entry, parts });
      return { status: 'settled', receipt };
    } catch (error) {
      return { status: 'held', reason: signal.aborted || operation?.signal?.aborted ? 'cancelled'
        : error instanceof JudgmentInputError ? 'protected-input' : 'stale' };
    }
  };
  const project = (receipt: Receipt, reference: boolean): readonly string[] => {
    const found = receipts.get(receipt);
    if (!found || Boolean(found.entry.reference) !== reference) throw new Error('Classic screening receipt is not current');
    current(found.entry); return found.parts;
  };
  current();
  return {
    capture: parts => capture(parts) as ProtectedSource,
    captureResearchReference: value => capture([value], captureResearchReference(value)) as ProtectedResearchReference,
    screen: (handle, operation) => screen(handle, false, operation),
    project: receipt => project(receipt, false),
    async screenResearchReference(handle, operation) {
      const result = await screen(handle, true, operation);
      return result.status === 'held' ? result : { status: 'settled', receipt: result.receipt as unknown as ResearchReferenceScreeningReceipt };
    },
    projectResearchReference(receipt) {
      const parts = project(receipt, true);
      return parts[0] === WITHHELD_RESEARCH_REFERENCE ? { status: 'omitted' } : { status: 'preserved', url: parts[0]! };
    },
    async release(handle) {
      const entry = sources.get(handle);
      if (!entry) return;
      entry.released = true; sources.delete(handle);
      for (const [receipt, found] of receipts) if (found.entry === entry) receipts.delete(receipt);
    },
    async close() { closed = true; for (const entry of sources.values()) entry.released = true; sources.clear(); receipts.clear(); },
  };
}
