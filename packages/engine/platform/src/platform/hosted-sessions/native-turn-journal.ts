/** Host-private dispatch fences. Identity and observation only, never a turn permit. */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { acquireCrossProcessLock, confirmFileDurable, writeJsonFileAtomic } from '../state/durable-file-io.js';

export const NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS = 4096;
export const NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES = 4 * 1024 * 1024;
export type NativeHostedTurnOriginSurface = 'webui' | 'agent';

export interface NativeHostedTurnIdentity {
  readonly projectId: string;
  readonly principalId: string;
  readonly requestId: string;
  readonly inputId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly sourceSessionId: string;
  /** Host-validated continuation target; absent on a session's original dispatch. */
  readonly continuationSessionId?: string;
}

export interface NativeHostedTurnDispatch {
  readonly identity: NativeHostedTurnIdentity;
  /** Selected by the host entry point, never the source body. Absent means historical WebUI. */
  readonly originSurface?: NativeHostedTurnOriginSurface;
  readonly state: 'preparing' | 'queued' | 'dispatching' | 'completed' | 'cancelled' | 'recovery-required';
  readonly sessionId: string | null;
  readonly brokerInputId: string | null;
  readonly correlationId: string | null;
}

/**
 * The process that created a claim. Kept beside the journal, not in it, so
 * the journal's record shape is unchanged. Evidence only: it can prove that
 * a claim's owner has exited, never that it is still running.
 */
export interface NativeHostedTurnClaimOwner {
  readonly pid: number;
  /** Random per process; distinguishes a restarted process that reused the pid. */
  readonly instance: string;
  /** Which machine and pid namespace the pid belongs to; a pid says nothing about a process elsewhere. */
  readonly host?: string;
}

export interface NativeHostedTurnJournalIO {
  readonly acquireCrossProcessLock: typeof acquireCrossProcessLock;
  readonly writeJsonFileAtomic: typeof writeJsonFileAtomic;
  readonly confirmFileDurable: typeof confirmFileDurable;
}

/** Compaction is tried once the journal holds this share of either cap. */
const COMPACT_AT = 0.9;

type JournalErrorCode = 'invalid-identity' | 'invalid-dispatch' | 'invalid-journal' | 'journal-limit' | 'conflict' | 'surface-conflict';
const NEXT_STEP: Partial<Record<JournalErrorCode, string>> = {
  'journal-limit': 'The journal is full of turns that cannot be dropped yet (still running or awaiting recovery, or not yet marked finished on intake). Cancel the stale native turns, then start again.',
};
export class NativeHostedTurnJournalError extends Error {
  constructor(readonly code: JournalErrorCode) {
    super(`Native hosted turn journal: ${code}${NEXT_STEP[code] ? `. ${NEXT_STEP[code]}` : ''}`);
    this.name = 'NativeHostedTurnJournalError';
  }
}

type DispatchState = NativeHostedTurnDispatch['state'];
type DispatchChange = Omit<NativeHostedTurnDispatch, 'identity' | 'originSurface'>;
interface JournalFile { readonly version: 1; readonly records: NativeHostedTurnDispatch[]; }
const identityKeys = ['projectId', 'principalId', 'requestId', 'inputId', 'sourceId', 'sourceRevision', 'sourceSessionId'] as const;
const bindingKeys = ['sessionId', 'brokerInputId', 'correlationId'] as const;
const changeKeys = ['state', ...bindingKeys] as const;
const states: readonly DispatchState[] = ['preparing', 'queued', 'dispatching', 'completed', 'cancelled', 'recovery-required'];
const transitions: Record<DispatchState, readonly DispatchState[]> = {
  preparing: ['queued', 'dispatching', 'cancelled', 'recovery-required'],
  queued: ['dispatching', 'cancelled', 'recovery-required'],
  dispatching: ['completed', 'cancelled', 'recovery-required'],
  completed: [],
  cancelled: [],
  'recovery-required': ['cancelled'],
};
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200 && /\S/u.test(value);

/** Reject accessors, symbols and exotic objects before inspecting any field. */
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

function copyIdentity(value: unknown): NativeHostedTurnIdentity {
  const keys = value && typeof value === 'object' && !nodeTypes.isProxy(value) && Object.hasOwn(value, 'continuationSessionId') ? [...identityKeys, 'continuationSessionId'] : identityKeys;
  if (!exact(value, keys) || !keys.every(key => validId(value[key]))) throw new NativeHostedTurnJournalError('invalid-identity');
  return Object.fromEntries(keys.map(key => [key, value[key]])) as unknown as NativeHostedTurnIdentity;
}

function copyChange(value: unknown): DispatchChange {
  if (!exact(value, changeKeys) || !states.includes(value.state as DispatchState)) throw new NativeHostedTurnJournalError('invalid-dispatch');
  const allNull = bindingKeys.every(key => value[key] === null);
  const allBound = bindingKeys.every(key => validId(value[key]));
  if ((!allNull && !allBound) || (allNull && (value.state === 'queued' || value.state === 'dispatching' || value.state === 'completed'))
    || (allBound && value.state === 'preparing')) throw new NativeHostedTurnJournalError('invalid-dispatch');
  return { state: value.state as DispatchState, sessionId: value.sessionId as string | null,
    brokerInputId: value.brokerInputId as string | null, correlationId: value.correlationId as string | null };
}

function copyDispatch(value: unknown): NativeHostedTurnDispatch {
  const hasSurface = value && typeof value === 'object' && !nodeTypes.isProxy(value) && Object.hasOwn(value, 'originSurface');
  if (!exact(value, ['identity', ...changeKeys, ...(hasSurface ? ['originSurface'] : [])])
    || (hasSurface && value.originSurface !== 'webui' && value.originSurface !== 'agent')) throw new NativeHostedTurnJournalError('invalid-dispatch');
  const identity = copyIdentity(value.identity);
  const change = copyChange({ state: value.state, sessionId: value.sessionId, brokerInputId: value.brokerInputId, correlationId: value.correlationId });
  if (identity.continuationSessionId && change.sessionId !== null && identity.continuationSessionId !== change.sessionId) throw new NativeHostedTurnJournalError('invalid-dispatch');
  return { identity, ...change, ...(hasSurface ? { originSurface: value.originSurface as NativeHostedTurnOriginSurface } : {}) };
}

const keyOf = (identity: NativeHostedTurnIdentity): string => JSON.stringify([identity.projectId, identity.principalId, identity.inputId]);
const sameIdentity = (left: NativeHostedTurnIdentity, right: NativeHostedTurnIdentity): boolean => identityKeys.every(key => left[key] === right[key]) && left.continuationSessionId === right.continuationSessionId;
const sameBinding = (left: DispatchChange, right: DispatchChange): boolean => bindingKeys.every(key => left[key] === right[key]);

function parseFile(value: unknown): JournalFile {
  if (!exact(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records)) throw new NativeHostedTurnJournalError('invalid-journal');
  if (value.records.length > NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS) throw new NativeHostedTurnJournalError('journal-limit');
  const records: NativeHostedTurnDispatch[] = [];
  const keys = new Set<string>();
  for (const raw of value.records) {
    let record: NativeHostedTurnDispatch;
    try { record = copyDispatch(raw); } catch { throw new NativeHostedTurnJournalError('invalid-journal'); }
    const key = keyOf(record.identity);
    if (keys.has(key)) throw new NativeHostedTurnJournalError('invalid-journal');
    keys.add(key); records.push(record);
  }
  return { version: 1, records };
}

/** Existing ancestors cannot redirect the journal or its lock through symlinks. */
function assertDirectoryChain(path: string): void {
  for (let current = dirname(path); ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeHostedTurnJournalError('invalid-journal');
    } catch (error) { if (!missing(error)) throw error; }
    if (dirname(current) === current) return;
  }
}

function regularFile(path: string): Stats | null {
  let stat: Stats;
  try { stat = lstatSync(path); } catch (error) { if (missing(error)) return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeHostedTurnJournalError('invalid-journal');
  return stat;
}

function readFile(path: string): JournalFile {
  const stat = regularFile(path);
  if (!stat) return { version: 1, records: [] };
  if (stat.size > NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES) throw new NativeHostedTurnJournalError('journal-limit');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new NativeHostedTurnJournalError('invalid-journal');
    if (opened.size > NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES) throw new NativeHostedTurnJournalError('journal-limit');
    const bytes = new Uint8Array(NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES) throw new NativeHostedTurnJournalError('journal-limit');
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
    catch { throw new NativeHostedTurnJournalError('invalid-journal'); }
    return parseFile(value);
  } finally { closeSync(fd); }
}

const terminalState = (state: DispatchState): boolean => state === 'completed' || state === 'cancelled';

/** Owners of claims that are not yet terminal. Unreadable means "no evidence", never an error. */
function readOwners(path: string): Map<string, NativeHostedTurnClaimOwner> {
  const owners = new Map<string, NativeHostedTurnClaimOwner>();
  try {
    const stat = regularFile(path);
    if (!stat || stat.size > NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES) return owners;
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!exact(value, ['version', 'owners']) || value.version !== 1 || !exact(value.owners, Object.keys(value.owners as object))) return owners;
    for (const [key, owner] of Object.entries(value.owners as Record<string, unknown>)) {
      const hasHost = exact(owner, ['pid', 'instance', 'host']);
      if ((hasHost || exact(owner, ['pid', 'instance'])) && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && validId(owner.instance)
        && (!hasHost || (typeof owner.host === 'string' && owner.host.length > 0 && owner.host.length <= 512))) {
        owners.set(key, { pid: owner.pid as number, instance: owner.instance as string, ...(hasHost ? { host: owner.host as string } : {}) });
      }
    }
  } catch { owners.clear(); }
  return owners;
}

/**
 * No expiry and no replay. Records leave only through `compact`, which the caller may use
 * only for inputs whose intake capture can no longer be dispatched. A persisted preparing/dispatching claim after
 * restart is evidence of uncertainty, never fresh permission to execute.
 * Post-publication durability errors escape unchanged; bytes are never restored.
 */
export class NativeHostedTurnJournal {
  readonly path: string;
  private readonly io: NativeHostedTurnJournalIO;
  constructor(path: string, io: Partial<NativeHostedTurnJournalIO> = {}) {
    this.path = resolve(path);
    this.io = { acquireCrossProcessLock, writeJsonFileAtomic, confirmFileDurable, ...io };
  }

  private async locked<T>(operation: () => T): Promise<T> {
    assertDirectoryChain(this.path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    assertDirectoryChain(this.path);
    regularFile(`${this.path}.lock`);
    const release = await this.io.acquireCrossProcessLock(`${this.path}.lock`, { strictOwnership: true });
    try { assertDirectoryChain(this.path); return operation(); } finally { release(); }
  }

  private find(file: JournalFile, identity: NativeHostedTurnIdentity): NativeHostedTurnDispatch | null {
    const current = file.records.find(record => keyOf(record.identity) === keyOf(identity)) ?? null;
    if (current && !sameIdentity(current.identity, identity)) throw new NativeHostedTurnJournalError('conflict');
    return current;
  }

  private write(file: JournalFile): void {
    if (file.records.length > NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS
      || Buffer.byteLength(JSON.stringify(file), 'utf8') > NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES) throw new NativeHostedTurnJournalError('journal-limit');
    this.io.writeJsonFileAtomic(this.path, file, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
  }

  async read(identity: NativeHostedTurnIdentity): Promise<NativeHostedTurnDispatch | null> {
    const expected = copyIdentity(identity);
    return this.locked(() => {
      const record = this.find(readFile(this.path), expected);
      // Visible terminal bytes after a published-indeterminate write are not
      // enough to claim durable completion/cancellation. Confirm under the lock.
      if (record && ['completed', 'cancelled'].includes(record.state)) this.io.confirmFileDurable(this.path);
      return record;
    });
  }

  /** Durable provenance only. The live host still owns principal/workspace checks. */
  async sessionRecords(sessionId: string): Promise<readonly NativeHostedTurnDispatch[]> {
    if (!validId(sessionId)) throw new NativeHostedTurnJournalError('invalid-identity');
    return this.locked(() => {
      const records = readFile(this.path).records.filter(record => record.sessionId === sessionId || record.identity.continuationSessionId === sessionId);
      if (records.length) this.io.confirmFileDurable(this.path);
      return records;
    });
  }

  /** Only the call that durably creates the claim may proceed toward dispatch. */
  async claim(identity: NativeHostedTurnIdentity, locallyOwnedInputs: readonly string[] = [], originSurface?: NativeHostedTurnOriginSurface, owner?: NativeHostedTurnClaimOwner): Promise<boolean> {
    const expected = copyIdentity(identity);
    if (originSurface !== undefined && originSurface !== 'webui' && originSurface !== 'agent') throw new NativeHostedTurnJournalError('invalid-dispatch');
    if (owner !== undefined && (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !validId(owner.instance)
      || (owner.host !== undefined && (owner.host.length === 0 || owner.host.length > 512)))) throw new NativeHostedTurnJournalError('invalid-dispatch');
    const surface = originSurface ?? 'webui';
    return this.locked(() => {
      const file = readFile(this.path);
      const existing = this.find(file, expected);
      if (existing) {
        if (existing.state === 'cancelled' && existing.sessionId === null && existing.originSurface === undefined) return false;
        if ((existing.originSurface ?? 'webui') !== surface) throw new NativeHostedTurnJournalError('surface-conflict');
        return false;
      }
      // Bind continuation ownership under the same lock as the input claim.
      // An unclaimed cancellation tombstone has no session settings ownership.
      if (expected.continuationSessionId && file.records.some(record =>
        (record.sessionId === expected.continuationSessionId || record.identity.continuationSessionId === expected.continuationSessionId)
        && !(record.state === 'cancelled' && record.sessionId === null)
        && (record.originSurface ?? 'webui') !== surface)) throw new NativeHostedTurnJournalError('surface-conflict');
      if (expected.continuationSessionId && file.records.some(record =>
        (record.sessionId === expected.continuationSessionId || record.identity.continuationSessionId === expected.continuationSessionId)
        && !['completed', 'cancelled'].includes(record.state) && !locallyOwnedInputs.includes(record.identity.inputId))) {
        throw new NativeHostedTurnJournalError('conflict');
      }
      file.records.push({ identity: expected, ...(originSurface ? { originSurface } : {}), state: 'preparing', sessionId: null, brokerInputId: null, correlationId: null });
      this.write(file);
      if (owner) this.recordOwner(file, keyOf(expected), owner);
      return true;
    });
  }

  /** Best effort after the claim is durable: a missing owner only withholds later proof. */
  private recordOwner(file: JournalFile, key: string, owner: NativeHostedTurnClaimOwner): void {
    const path = `${this.path}.owners`;
    try {
      const open = new Set(file.records.filter(record => !terminalState(record.state)).map(record => keyOf(record.identity)));
      const owners = readOwners(path);
      for (const existing of [...owners.keys()]) if (!open.has(existing)) owners.delete(existing);
      owners.set(key, { pid: owner.pid, instance: owner.instance, ...(owner.host === undefined ? {} : { host: owner.host }) });
      // Deliberately not `this.io`: that seam governs the journal's own bytes.
      writeJsonFileAtomic(path, { version: 1, owners: Object.fromEntries(owners) }, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
    } catch { /* The claim stands; without an owner it can only be resolved as recovery-required. */ }
  }

  /** The process that created this claim, when it was recorded. */
  async owner(identity: NativeHostedTurnIdentity): Promise<NativeHostedTurnClaimOwner | null> {
    const expected = copyIdentity(identity);
    return this.locked(() => {
      this.find(readFile(this.path), expected);
      return readOwners(`${this.path}.owners`).get(keyOf(expected)) ?? null;
    });
  }

  /** Terminal records, and whether the journal is close enough to a cap that they are worth compacting. */
  async census(): Promise<{ readonly nearCap: boolean; readonly terminal: readonly NativeHostedTurnDispatch[] }> {
    return this.locked(() => {
      const file = readFile(this.path);
      const nearCap = file.records.length >= NATIVE_HOSTED_TURN_JOURNAL_MAX_RECORDS * COMPACT_AT
        || Buffer.byteLength(JSON.stringify(file), 'utf8') >= NATIVE_HOSTED_TURN_JOURNAL_MAX_BYTES * COMPACT_AT;
      return { nearCap, terminal: nearCap ? file.records.filter(record => terminalState(record.state)) : [] };
    });
  }

  /**
   * Drop records the caller has proven finished on intake, and only those that are
   * still terminal here and that no live owner holds. `held` is consulted under the
   * lock with the recorded claim owner. Terminal states never change, so the proof
   * cannot go stale between the caller's check and this write.
   */
  async compact(proven: readonly NativeHostedTurnIdentity[], held: (record: NativeHostedTurnDispatch, owner: NativeHostedTurnClaimOwner | null) => boolean): Promise<number> {
    const wanted = new Map(proven.map(identity => { const copy = copyIdentity(identity); return [keyOf(copy), copy] as const; }));
    if (!wanted.size) return 0;
    return this.locked(() => {
      const file = readFile(this.path);
      const owners = readOwners(`${this.path}.owners`);
      const droppedKeys: string[] = [];
      const kept = file.records.filter(record => {
        const key = keyOf(record.identity), proof = wanted.get(key);
        const drop = !!proof && terminalState(record.state) && sameIdentity(record.identity, proof) && !held(record, owners.get(key) ?? null);
        if (drop) droppedKeys.push(key);
        return !drop;
      });
      const dropped = droppedKeys.length;
      if (!dropped) return 0;
      // The terminal bytes being relied on must be durable before anything that proves them is removed.
      this.io.confirmFileDurable(this.path);
      this.write({ version: 1, records: kept });
      this.pruneOwners(droppedKeys);
      return dropped;
    });
  }

  /** Only the dropped claims lose their owner entry; a kept terminal record may still be held. */
  private pruneOwners(dropped: readonly string[]): void {
    const path = `${this.path}.owners`;
    try {
      const owners = readOwners(path);
      for (const key of dropped) owners.delete(key);
      writeJsonFileAtomic(path, { version: 1, owners: Object.fromEntries(owners) }, { durable: true, mode: 0o600, indent: null, trailingNewline: false });
    } catch { /* Stale owner entries are only evidence; the next claim prunes them. */ }
  }

  /** Prevent an unclaimed input without borrowing ownership of any other turn. */
  async prevent(identity: NativeHostedTurnIdentity): Promise<NativeHostedTurnDispatch> {
    const expected = copyIdentity(identity);
    return this.locked(() => {
      const file = readFile(this.path);
      const existing = this.find(file, expected);
      if (existing) return existing;
      const record: NativeHostedTurnDispatch = { identity: expected, state: 'cancelled', sessionId: null, brokerInputId: null, correlationId: null };
      file.records.push(record);
      this.write(file);
      return record;
    });
  }

  async transition(identity: NativeHostedTurnIdentity, expectedState: DispatchState, next: DispatchChange): Promise<NativeHostedTurnDispatch> {
    const expected = copyIdentity(identity);
    const change = copyChange(next);
    if (expected.continuationSessionId && change.sessionId !== null && expected.continuationSessionId !== change.sessionId) throw new NativeHostedTurnJournalError('invalid-dispatch');
    if (!states.includes(expectedState)) throw new NativeHostedTurnJournalError('invalid-dispatch');
    return this.locked(() => {
      const file = readFile(this.path);
      const current = this.find(file, expected);
      if (!current || current.state !== expectedState) throw new NativeHostedTurnJournalError('conflict');
      if (current.state === change.state && sameBinding(current, change)) {
        this.io.confirmFileDurable(this.path);
        return current;
      }
      if (!transitions[current.state].includes(change.state)
        || (current.state !== 'preparing' && !sameBinding(current, change))) throw new NativeHostedTurnJournalError('conflict');
      const updated: NativeHostedTurnDispatch = { ...current, identity: expected, ...change };
      file.records[file.records.indexOf(current)] = updated;
      this.write(file);
      return updated;
    });
  }
}
