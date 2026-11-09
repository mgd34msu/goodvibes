/** Durable runner admission only. The native owner still owns semantic decisions and its action ledger. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import type { JevDecisionBinding } from '@goodvibes-jev/judgment/decisions';
import { createAtomicTempPath, writeFileAtomic } from '../utils/atomic-json-store.js';
import { readFileObservation } from '../utils/file-observation.js';
import { readOwnedContractCheckpoint, ownedContractCheckpointText, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';
import { acquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';
import { CONTRACT_ORIGINS, isContractId, isOpaqueContractId, type ContractView, type StartContractInput } from './types.js';
import { captureNativeContractSource } from './native-source.js';
import { delegationForbidden } from './batteries/request-shape.js';
const nativeAdmissionApply = Reflect.apply, nativeRequestGet = WeakMap.prototype.get, nativeRequestSet = WeakMap.prototype.set, freezeNativeAdmission = Object.freeze;
interface NativeDurableKey { readonly identity: string; filename?: string }
const nativeKeys = new WeakMap<DurableContractKey, NativeDurableKey>();
const nativeKey = (value: DurableContractKey) => nativeAdmissionApply(nativeRequestGet, nativeKeys, [value]) as NativeDurableKey | undefined;
const nativeRequests = new WeakMap<DurableContractRequest, { revision?: string }>();
const nativeRequest = (value: DurableContractRequest) => nativeAdmissionApply(nativeRequestGet, nativeRequests, [value]) as { revision?: string } | undefined;

export interface DurableContractKey {
  readonly workId: string;
  readonly criteriaId: string;
  readonly criteriaRevision: string;
  readonly attemptId: string;
}

export interface DurableContractRequest {
  readonly key: DurableContractKey;
  readonly binding: JevDecisionBinding;
  readonly input: StartContractInput;
}

/** Stable runner-owned receipt. Never a persisted permission grant. */
export interface DurableContractAdmission extends DurableContractRequest {
  readonly schemaVersion: 1 | 2;
  /** Version-2 admissions pin resolved placement before borrowed owner/launch hooks. */
  readonly execution?: DurableContractExecution | undefined;
  readonly contractId: string;
  readonly ownerAgentId: string;
  readonly payloadRevision: string;
}

export interface DurableContractExecution {
  readonly isolation: 'worktree' | 'shared';
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly baseBranch?: string | undefined;
}

export type DurableContractReceipt = Omit<DurableContractAdmission, 'input'>;

export interface DurableStartedContract {
  readonly admission: DurableContractReceipt;
  readonly contract: ContractView;
  /** A launch claim is persisted before invocation; a crash can make whether invocation happened unknowable. */
  readonly state: 'prepared' | 'launch-claimed' | 'terminal';
}

/** Trusted composition dependency, deliberately absent from serialized/model-supplied input. */
export interface DurableContractBoundary {
  /** Acquire the native ledger lock, then call launch with a synchronous live validator while holding it. */
  withCurrent(admission: DurableContractAdmission, launch: (assertCurrent: () => void) => void): void | Promise<void>;
}

export class DurableContractAdmissionError extends Error {
  constructor(readonly code: 'invalid' | 'conflict' | 'missing' | 'checkpoint' | 'boundary') {
    super(`Durable contract admission: ${code}`);
    this.name = 'DurableContractAdmissionError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function missing(error: unknown): boolean {
  return record(error) && error['code'] === 'ENOENT';
}

/** Only an absent pathname means absent authority. Failed reads, unsafe links,
 * replacement during the read and invalid UTF8 never become a missing receipt.
 */
function readAdmissionJson(path: string): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileObservation(path).bytes));
}

/** An immutable metadata pointer can retain its publication candidate hard link
 * after a crash. It contains no input/checkpoint and grants no authority; its
 * actual forward receipt is independently read and validated. Never follow a
 * symlink or read a special file in place of that pointer.
 */
function readAdmissionIndexJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    // Four printable-ASCII references of at most256 chars plus fixed keys.
    if (!stat.isFile() || stat.size > 4096) throw new DurableContractAdmissionError('invalid');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)));
  } finally { closeSync(fd); }
}

function admissionPathExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if (missing(error)) return false; throw new DurableContractAdmissionError('invalid'); }
}

function references(value: unknown, keys: readonly string[]): boolean {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => typeof value[key] === 'string' && /^[\x21-\x7e][\x20-\x7e]{0,255}$/.test(value[key]));
}

/** JSON canonicalization rejects values persistence cannot preserve. Undefined optional object fields are absent. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new DurableContractAdmissionError('invalid');
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member);
    freezeNativeAdmission(value);
  }
  return value;
}

const KEY_FIELDS = ['workId', 'criteriaId', 'criteriaRevision', 'attemptId'];
const BINDING_FIELDS = ['sourceId', 'inputRevision', 'actionId', 'actionRevision', 'authorityId', 'authorityRevision', 'scopeId', 'scopeRevision'];

/** Historical criteria reference recipe, verified only for an actual saved
 * criteria:<64hex> source/admission in native-decisions. Fresh requests issue an
 * opaque criteria-v2 label once. Kept public for earlier API consumers.
 * @deprecated Historical saved-reference compatibility; do not issue fresh IDs.
 */
export function criteriaSetIdForWork(workId: string): string {
  if (!references({ workId }, ['workId'])) throw new DurableContractAdmissionError('invalid');
  return `criteria:${createHash('sha256').update(workId).digest('hex')}`;
}

/** Capture exactly four original printable references. Neither Object.freeze,
 * a copied JSON field nor a foreign prototype can claim this private cache. */
export function freezeDurableKey(value: DurableContractKey): DurableContractKey {
  if (nativeKey(value)) return value;
  let captured: unknown;
  try { captured = captureOwnedJson(value, nodeTypes.isProxy); }
  catch { throw new DurableContractAdmissionError('invalid'); }
  if (!references(captured, KEY_FIELDS)) throw new DurableContractAdmissionError('invalid');
  const fields = captured as Record<string, string>;
  const key = freezeNativeAdmission({ workId: fields['workId']!, criteriaId: fields['criteriaId']!,
    criteriaRevision: fields['criteriaRevision']!, attemptId: fields['attemptId']! });
  nativeAdmissionApply(nativeRequestSet, nativeKeys, [key, { identity: JSON.stringify([key.workId, key.criteriaId, key.criteriaRevision, key.attemptId]) }]);
  return key;
}

/** Existing on-disk receipt, key-lock and execution-lease namespace. Four
 * arbitrary256-byte printable references cannot form one portable filename.
 * This one bounded digest preserves that exact tuple without a new registry,
 * extra lookup I/O or long reversible directory paths. It is NOT authority,
 * privacy, a content commitment or a currentness check. Reuse only the actual
 * constructor's immutable key; mutable/foreign copies independently validate.
 * Actual saved v1 SQLite key/settlement readers also reproduce this old recipe.
 */
export function durableKeyHash(key: DurableContractKey): string {
  const captured = freezeDurableKey(key), held = nativeKey(captured)!;
  if (held.filename !== undefined) return held.filename;
  const digest = createHash('sha256').update(canonical(captured)).digest('hex');
  held.filename = digest; return digest;
}

/** Exact bounded private map/SQL identity, with no serialized input or hash. */
export function durableKeyIdentity(key: DurableContractKey): string {
  const captured = freezeDurableKey(key); return nativeKey(captured)!.identity;
}

/** Compare owned requests after freezeDurableRequest admission. Migrating the
 * persisted digest format is separate; comparing two complete current native
 * values requires neither serialization nor cryptographic hashing.
 */
export function sameDurableRequest(first: DurableContractRequest, second: DurableContractRequest): boolean {
  return isDeepStrictEqual(first.key, second.key) && isDeepStrictEqual(first.binding, second.binding)
    && isDeepStrictEqual(first.input, second.input);
}

export function freezeDurableRequest(value: DurableContractRequest): DurableContractRequest {
  if (nativeRequest(value)) return value;
  // Clone before the first await: caller mutation cannot change the operation being admitted.
  let detached: unknown, capturedKey: DurableContractKey;
  try {
    if (!record(value) || nodeTypes.isProxy(value)) throw new Error();
    const keySlot = Object.getOwnPropertyDescriptor(value, 'key');
    if (!keySlot || !('value' in keySlot)) throw new Error();
    capturedKey = freezeDurableKey(keySlot.value as DurableContractKey);
    detached = JSON.parse(canonical(value));
  } catch { throw new DurableContractAdmissionError('invalid'); }
  if (!record(detached) || Object.keys(detached).length !== 3
    || !references(detached['key'], KEY_FIELDS) || !references(detached['binding'], BINDING_FIELDS)
    || !record(detached['input']) || !isDeepStrictEqual(detached['key'], capturedKey)) throw new DurableContractAdmissionError('invalid');
  const input = detached['input'];
  if (typeof input['ask'] !== 'string' || input['ask'].length === 0
    || typeof input['sessionId'] !== 'string' || input['sessionId'].length === 0
    || typeof input['projectRoot'] !== 'string' || input['projectRoot'].length === 0
    || typeof input['origin'] !== 'string' || !(CONTRACT_ORIGINS as readonly string[]).includes(input['origin'])) {
    throw new DurableContractAdmissionError('invalid');
  }
  if (input['taskEvidence'] !== undefined && typeof input['taskEvidence'] !== 'string') throw new DurableContractAdmissionError('invalid');
  if (input['isolation'] !== undefined && (typeof input['isolation'] !== 'string' || !['auto', 'worktree', 'shared'].includes(input['isolation']))) throw new DurableContractAdmissionError('invalid');
  if (input['nativeSource'] !== undefined) {
    let source;
    try { source = captureNativeContractSource(input['nativeSource']); } catch { throw new DurableContractAdmissionError('invalid'); }
    const key = detached['key'] as Record<string, unknown>;
    const binding = detached['binding'] as Record<string, unknown>;
    if (source.sourceId !== binding['sourceId'] || source.inputRevision !== binding['inputRevision']
      || source.criteriaId !== key['criteriaId'] || source.criteriaRevision !== key['criteriaRevision']) throw new DurableContractAdmissionError('invalid');
    input['nativeSource'] = source;
  }
  // Preserve only a genuine immutable key after independently comparing the
  // complete captured key. Request/body copies cannot supply a cache flag.
  detached['key'] = capturedKey;
  const request = freeze(detached as unknown as DurableContractRequest);
  nativeAdmissionApply(nativeRequestSet, nativeRequests, [request, {}]); return request;
}

/** Actual saved admission/checkpoint payload commitment. Only this native
 * immutable constructor result may reuse it; public JSON and flags cannot. */
export function durablePayloadRevision(request: DurableContractRequest): string {
  const held = nativeRequest(request); if (held?.revision) return held.revision;
  const revision = createHash('sha256').update(canonical(request)).digest('hex');
  if (held) held.revision = revision; return revision;
}

export function parseDurableAdmission(value: unknown, original?: DurableContractRequest): DurableContractAdmission {
  if (!record(value) || (value['schemaVersion'] !== 1 && value['schemaVersion'] !== 2)
    || Object.keys(value).length !== (value['schemaVersion'] === 2 ? 8 : 7)
    || !isContractId(value['contractId']) || typeof value['ownerAgentId'] !== 'string' || value['ownerAgentId'].length === 0
    || typeof value['payloadRevision'] !== 'string') throw new DurableContractAdmissionError('invalid');
  const parsed = freezeDurableRequest({ key: value['key'], binding: value['binding'], input: value['input'] } as DurableContractRequest);
  const request = original && nativeRequest(original) && sameDurableRequest(original, parsed) ? original : parsed;
  if (durablePayloadRevision(request) !== value['payloadRevision']) throw new DurableContractAdmissionError('invalid');
  let execution: DurableContractExecution | undefined;
  if (value['schemaVersion'] === 2) {
    const item = value['execution'];
    if (!record(item) || (item['isolation'] !== 'worktree' && item['isolation'] !== 'shared')
      || Object.keys(item).length !== (item['isolation'] === 'worktree' ? 4 : 1)) throw new DurableContractAdmissionError('invalid');
    if (item['isolation'] === 'worktree' && (item['branch'] !== `contract/${value['contractId'].slice(4)}`
      || item['worktreePath'] !== join(request.input.projectRoot, '.goodvibes', '.worktrees', 'contract', value['contractId'].slice(4))
      || typeof item['baseBranch'] !== 'string' || item['baseBranch'].length === 0)) throw new DurableContractAdmissionError('invalid');
    if (request.input.isolation !== undefined && request.input.isolation !== 'auto' && item['isolation'] !== request.input.isolation)
      throw new DurableContractAdmissionError('invalid');
    execution = item as unknown as DurableContractExecution;
  }
  return freeze({ ...request, schemaVersion: value['schemaVersion'] as 1 | 2, contractId: value['contractId'], ownerAgentId: value['ownerAgentId'], payloadRevision: value['payloadRevision'],
    ...(execution === undefined ? {} : { execution }) });
}

/** Checkpoint content must still name the original operation, not just copy its receipt hash. */
export function assertDurableCheckpoint(contract: ContractView, admission: DurableContractAdmission): void {
  if (contract.durableAdmission === undefined || canonical(contract.durableAdmission) !== canonical(admission)
    || contract.id !== admission.contractId || contract.ownerAgentId !== admission.ownerAgentId) {
    throw new DurableContractAdmissionError('checkpoint');
  }
  for (const field of ['ask', 'sessionId', 'origin', 'projectRoot', 'parentAgentId', 'selectedModel', 'budget', 'proposedUnits', 'nativeSource', 'taskEvidence'] as const) {
    if (canonical({ value: contract[field] }) !== canonical({ value: admission.input[field] })) {
      throw new DurableContractAdmissionError('checkpoint');
    }
  }
  if (contract.isolation !== 'worktree' && contract.isolation !== 'shared') throw new DurableContractAdmissionError('checkpoint');
  // The existing no-delegation rule intentionally uses the session's shared tree.
  // No other transition may discard the resolved placement or its captured-input path.
  const session = contract.sessionMode === true;
  if (session && (contract.shape === undefined || !delegationForbidden(contract.shape))) throw new DurableContractAdmissionError('checkpoint');
  if (contract.shape !== undefined && contract.status !== 'shaping' && session !== delegationForbidden(contract.shape)) throw new DurableContractAdmissionError('checkpoint');
  const execution: DurableContractExecution | undefined = session ? { isolation: 'shared' } : admission.execution;
  if (execution !== undefined) {
    for (const field of ['isolation', 'branch', 'worktreePath', 'baseBranch'] as const) {
      if (contract[field] !== execution[field]) throw new DurableContractAdmissionError('checkpoint');
    }
  } else if (admission.input.isolation !== undefined && admission.input.isolation !== 'auto' && contract.isolation !== admission.input.isolation) {
    throw new DurableContractAdmissionError('checkpoint');
  }
}

/** Flush the renamed entry as well as the file; admission cannot acknowledge a merely buffered directory entry. */
export function syncContractDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Immutable key-to-runner receipts. No semantic journal, outbox, retry loop, or automatic garbage collection. */
export class DurableContractAdmissions {
  private readonly directory: string;
  constructor(projectRoot: string) {
    this.directory = join(resolve(projectRoot), '.goodvibes', 'contracts', 'admissions');
  }

  private path(key: DurableContractKey): string { return join(this.directory, `${durableKeyHash(key)}.json`); }

  private indexPath(contractId: string): string {
    if (!isContractId(contractId)) throw new DurableContractAdmissionError('invalid');
    return join(this.directory, '.by-contract', `${contractId}.json`);
  }

  private indexedKey(contractId: string): DurableContractKey | null {
    const path = this.indexPath(contractId);
    if (!admissionPathExists(path)) return null;
    try {
      const value = readAdmissionIndexJson(path);
      if (!record(value) || Object.keys(value).length !== 3 || value['schemaVersion'] !== 1
        || value['contractId'] !== contractId || !references(value['key'], KEY_FIELDS)) throw new Error();
      return freezeDurableKey(value['key'] as unknown as DurableContractKey);
    } catch { throw new DurableContractAdmissionError('invalid'); }
  }

  /** Reserve the immutable reverse identity before committing a new key binding.
   * link(2) publishes only if absent: independent key writers cannot overwrite
   * another contract-ID owner. A crash after this reservation but before the
   * forward receipt leaves a held ID, never evidence for compatibility rebinding.
   * The index stores no checkpoint or input and cannot authorize execution.
   */
  private reserveIndex(admission: DurableContractAdmission, confirmExisting = false): void {
    const path = this.indexPath(admission.contractId);
    const same = (key: DurableContractKey) => durableKeyIdentity(key) === durableKeyIdentity(admission.key);
    const existing = this.indexedKey(admission.contractId);
    if (existing !== null) {
      if (!same(existing)) throw new DurableContractAdmissionError('conflict');
      if (confirmExisting) {
        syncContractDirectory(dirname(path));
        syncContractDirectory(this.directory);
      }
      return;
    }
    const candidate = createAtomicTempPath(path);
    let retiredCandidate = false;
    try {
      writeFileAtomic(candidate, canonical({ schemaVersion: 1, contractId: admission.contractId, key: admission.key }),
        { mode: 0o600, durable: true, cleanupStaleTemps: false });
      try { linkSync(candidate, path); }
      catch (error) {
        if (!record(error) || error['code'] !== 'EEXIST') throw error;
        const winner = this.indexedKey(admission.contractId);
        if (winner === null || !same(winner)) throw new DurableContractAdmissionError('conflict');
      }
      unlinkSync(candidate);
      retiredCandidate = true;
      syncContractDirectory(dirname(path));
      syncContractDirectory(this.directory);
    } catch (error) {
      if (error instanceof DurableContractAdmissionError) throw error;
      throw new DurableContractAdmissionError('invalid');
    } finally {
      try { if (!retiredCandidate) unlinkSync(candidate); }
      catch {
        // A leftover private candidate grants nothing. Preserve the admission
        // failure, or its already durable index, if cleanup is unavailable.
      }
    }
  }

  lock(key: DurableContractKey): Promise<() => void> {
    return acquireCrossProcessLock(`${this.path(key)}.lock`, { strictOwnership: true });
  }

  /** Held until real executor drainage, not just status change/disposal. A dead process's lease can be reclaimed. */
  lease(key: DurableContractKey): Promise<() => void> {
    return acquireCrossProcessLock(`${this.path(key)}.execution`, { strictOwnership: true, totalTimeoutMs: 100 });
  }

  private envelope(key: DurableContractKey): { admission: DurableContractAdmission; checkpoint: string; indexed: boolean } | null {
    key = freezeDurableKey(key);
    const path = this.path(key);
    if (!admissionPathExists(path)) return null;
    try {
      const value = readAdmissionJson(path);
      if (!record(value) || Object.keys(value).length !== 2 || typeof value['checkpoint'] !== 'string') throw new Error();
      const admission = parseDurableAdmission(value['admission']);
      if (durableKeyIdentity(admission.key) !== durableKeyIdentity(key)) throw new Error();
      const indexed = this.indexedKey(admission.contractId);
      if (indexed !== null && durableKeyIdentity(indexed) !== durableKeyIdentity(key)) throw new Error();
      return { admission, checkpoint: value['checkpoint'], indexed: indexed !== null };
    } catch { throw new DurableContractAdmissionError('invalid'); }
  }

  /** Reverse identity fence for compatibility imports/resume, even if the contract-ID copy is absent. */
  findByContractId(contractId: string): DurableContractAdmission | null {
    const key = this.indexedKey(contractId);
    if (key !== null) {
      const envelope = this.envelope(key);
      if (envelope === null || envelope.admission.contractId !== contractId) throw new DurableContractAdmissionError('invalid');
      return envelope.admission;
    }
    // Full128 IDs were introduced only after reverse-first durable publication.
    // A missing reverse leaf is not a reason to scan every earlier8hex receipt.
    if (isOpaqueContractId(contractId)) return null;
    const admission = this.findUnindexedContract(contractId);
    if (admission !== null) this.reserveIndex(admission);
    return admission;
  }

  /** Old receipts contain no reverse name. Proving a previously unindexed ID
   * absent still requires reading them; damaged unknown authority cannot be
   * skipped to mint a new binding. Positive indexed recovery avoids this scan.
   */
  private findUnindexedContract(contractId: string): DurableContractAdmission | null {
    if (!admissionPathExists(this.directory)) return null;
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      let admission: DurableContractAdmission;
      try {
        const value = readAdmissionJson(join(this.directory, file));
        if (!record(value) || Object.keys(value).length !== 2 || typeof value['checkpoint'] !== 'string') throw new Error();
        admission = parseDurableAdmission(value['admission']);
        if (file !== `${durableKeyHash(admission.key)}.json`) throw new Error();
      } catch { throw new DurableContractAdmissionError('invalid'); }
      if (admission.contractId === contractId) return admission;
    }
    return null;
  }

  read(key: DurableContractKey): DurableContractAdmission | null { return this.envelope(key)?.admission ?? null; }

  /** The authoritative checkpoint lives in the same atomic envelope as its immutable key binding. */
  checkpoint(key: DurableContractKey): string {
    const envelope = this.envelope(key);
    if (envelope === null) throw new DurableContractAdmissionError('missing');
    return envelope.checkpoint;
  }

  /** Retain the original actual file read; public parsed JSON cannot mint it. */
  checkpointRead(key: DurableContractKey): OwnedContractCheckpointRead {
    key = freezeDurableKey(key);
    const expected = this.checkpoint(key);
    const receipt = readOwnedContractCheckpoint(this.path(key), 'durable-admission');
    if (ownedContractCheckpointText(receipt) !== expected) throw new DurableContractAdmissionError('checkpoint');
    return receipt;
  }

  private persist(admission: DurableContractAdmission, checkpoint: string): void {
    writeFileAtomic(this.path(admission.key), canonical({ admission, checkpoint }));
    syncContractDirectory(this.directory);
    syncContractDirectory(dirname(this.directory));
    syncContractDirectory(dirname(dirname(this.directory)));
  }

  /** Caller holds the key lock. Binding and initial checkpoint appear in one atomic durable write. */
  write(admission: DurableContractAdmission, checkpoint: string): void {
    if (this.read(admission.key) !== null) throw new DurableContractAdmissionError('conflict');
    // A fresh index cannot steal an older receipt's unindexed ID. This check
    // is intentionally conservative until that historical identity is known.
    if (!isOpaqueContractId(admission.contractId) && this.indexedKey(admission.contractId) === null && this.findUnindexedContract(admission.contractId) !== null)
      throw new DurableContractAdmissionError('conflict');
    this.reserveIndex(admission, true);
    this.persist(admission, checkpoint);
  }

  /** Only the execution-lease holder may update a checkpoint; the receipt itself cannot change. */
  update(admission: DurableContractAdmission, checkpoint: string): void {
    const existing = this.envelope(admission.key);
    if (existing === null || canonical(existing.admission) !== canonical(admission)) throw new DurableContractAdmissionError('checkpoint');
    if (!existing.indexed) this.reserveIndex(admission);
    this.persist(admission, checkpoint);
  }
}
