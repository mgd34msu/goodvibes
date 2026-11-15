/**
 * Two things live here.
 *
 * The owner-lock helpers: a lock directory beside a file that records the
 * process holding it, reclaimed once that process is proven dead. The pairing
 * store and the shared-file lock use them.
 *
 * The durable configuration revision ({@link DurablePolicyEpochOwner}): the
 * one fact "has this configuration changed since a grant was issued under
 * it, including a change that was later undone, across restarts". It is a
 * counter with a fresh nonce per change and a hash of the settings files'
 * bytes, kept in one small document beside the surface's settings file.
 * Comparing it is one string compare; moving it is one document write.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeDocument } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { processStartTime } from './process-start-time.js';

/**
 * Owner-lock directories (the pairing store's owner lock and the shared-file
 * lock) record the process that holds them, so a lock left by a crash
 * can be reclaimed once its owner is PROVEN dead: the pid no longer exists,
 * or it now belongs to a process with a different start time. Age never
 * proves anything (a suspended owner is still an owner), and a lock with no
 * readable owner record (written by an older build, or by a crash between
 * creating the directory and recording its owner) is never reclaimed here.
 */
const LOCK_OWNER_FILE = 'owner';
interface LockOwner { readonly pid: number; readonly start: string | null }

const LOCK_WAIT_ATTEMPTS = 10;
const LOCK_WAIT_SLICE_MS = 50;
let ownerLockWait: (ms: number) => void = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/** @internal Replace the bounded blocking wait used while another live process holds a lock; returns a restore function. */
export function setOwnerLockWaitForTest(wait: (ms: number) => void): () => void {
  const previous = ownerLockWait; ownerLockWait = wait;
  return () => { ownerLockWait = previous; };
}

function readLockOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(readFileSync(join(lockPath, LOCK_OWNER_FILE), 'utf8')) as { pid?: unknown; start?: unknown };
    const pid = parsed.pid;
    const start = parsed.start === null ? null : typeof parsed.start === 'string' && /^(\d+|ps:[A-Za-z0-9: ]{1,64})$/.test(parsed.start) ? parsed.start : undefined;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || start === undefined) return null;
    return { pid, start };
  } catch { return null; }
}

/**
 * A lock directory exists the instant `mkdirSync` returns, and its holder record
 * is written a moment later. In that window another process sees a directory
 * with no holder, which is a lock being taken, not one left by a crash. Only a
 * holderless directory older than a few wait slices is treated as a fault.
 */
function lockIsBeingTaken(lockPath: string): boolean {
  try {
    const entry = lstatSync(lockPath);
    if (!entry.isDirectory() || readLockOwner(lockPath) !== null) return false;
    return Date.now() - Math.max(entry.birthtimeMs, entry.ctimeMs) < 4 * LOCK_WAIT_SLICE_MS;
  } catch { return false; }
}

/**
 * @internal For a caller whose own mkdir found the lock present: when the holder
 * is only now taking it (directory created, holder record not yet written),
 * wait one slice and return true so the caller retries; false once the wait
 * budget is spent or the lock is not in that state.
 */
export function waitWhileLockIsBeingTaken(lockPath: string, attempt: number): boolean {
  if (attempt >= LOCK_WAIT_ATTEMPTS || !lockIsBeingTaken(lockPath)) return false;
  ownerLockWait(LOCK_WAIT_SLICE_MS);
  return true;
}

function ownerProvenDead(owner: LockOwner): boolean {
  try { process.kill(owner.pid, 0); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  // The pid is in use: dead only when it now names a different process.
  if (owner.start === null) return false;
  const now = processStartTime(owner.pid);
  // Tokens from the Linux kernel (digits) and from ps (`ps:`) are not comparable; a record written under the other scheme proves nothing.
  return now !== null && now.startsWith('ps:') === owner.start.startsWith('ps:') && now !== owner.start;
}

/** @internal Record this process as the holder of a lock directory it just created. */
export function recordOwnerLockHolder(lockPath: string): void {
  writeFileSync(join(lockPath, LOCK_OWNER_FILE), JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) }), { flag: 'wx', mode: 0o600 });
}

/** @internal Remove an owner-lock directory and its holder record. */
export function removeOwnerLockDirectory(lockPath: string): void {
  try { unlinkSync(join(lockPath, LOCK_OWNER_FILE)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  rmdirSync(lockPath);
}

/** @internal Who holds a lock directory, for a refusal a person can act on. */
export function describeOwnerLock(lockPath: string): string {
  const owner = readLockOwner(lockPath);
  const ticket = `${lockPath}.reclaim`;
  const ticketNote = existsSync(ticket) ? ` (a reclaim ticket ${ticket} also exists beside it)` : '';
  return owner
    ? `${lockPath} is held by process ${owner.pid}${ticketNote}`
    : `${lockPath} exists without a recorded holder (left by an older build or a crash)${ticketNote}; if no GoodVibes process is running, remove ${ticketNote ? 'both' : 'it'}`;
}

/**
 * @internal Remove an owner-lock directory whose recorded holder is proven dead.
 * One reclaimer at a time (an exclusive ticket), and only the exact directory
 * that was judged, so a fresh lock taken meanwhile is never removed.
 */
export function reclaimDeadOwnerLock(lockPath: string): boolean {
  let judged: Stats;
  try { judged = lstatSync(lockPath); } catch { return false; }
  if (!judged.isDirectory() || judged.isSymbolicLink()) return false;
  const owner = readLockOwner(lockPath);
  if (!owner || !ownerProvenDead(owner)) return false;
  const ticket = `${lockPath}.reclaim`;
  if (!takeReclaimTicket(ticket)) return false;
  try {
    const current = lstatSync(lockPath);
    const again = readLockOwner(lockPath);
    if (!current.isDirectory() || current.dev !== judged.dev || current.ino !== judged.ino || current.birthtimeMs !== judged.birthtimeMs
      || !again || again.pid !== owner.pid || again.start !== owner.start || !ownerProvenDead(again)) return false;
    removeOwnerLockDirectory(lockPath);
    logger.warn('Reclaimed an owner lock left by a process that no longer exists', { lockPath, pid: owner.pid });
    return true;
  } catch (error) {
    logger.warn('Could not reclaim an owner lock left by a dead process', { lockPath, error: summarizeError(error) });
    return false;
  } finally {
    try { removeOwnerLockDirectory(ticket); } catch { /* the ticket records our pid; a later reclaim removes it once we are gone */ }
  }
}

/**
 * Take the exclusive reclaim ticket. The ticket records its holder, so one left
 * by a reclaimer that died is removed when that holder is proven dead (or the
 * record never got written and the directory is no longer fresh); otherwise a
 * crash while reclaiming would refuse every later reclaim of this lock.
 */
function takeReclaimTicket(ticket: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(ticket, { mode: 0o700 });
      try { recordOwnerLockHolder(ticket); } catch (error) { rmdirSync(ticket); throw error; }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) return false;
      const holder = readLockOwner(ticket);
      const abandoned = holder ? ownerProvenDead(holder) : !lockIsBeingTaken(ticket);
      if (!abandoned) return false;
      try { removeOwnerLockDirectory(ticket); } catch { return false; }
    }
  }
  return false;
}

interface RevisionRecord { readonly revision: number; readonly nonce: string; readonly hash: string }

function isRevisionRecord(value: unknown): value is RevisionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.revision === 'number' && Number.isSafeInteger(record.revision) && record.revision > 0
    && typeof record.nonce === 'string' && record.nonce.length > 0 && record.nonce.length <= 64
    && typeof record.hash === 'string' && /^[0-9a-f]{64}$/.test(record.hash);
}

/**
 * The durable revision of one set of settings files.
 *
 * The value moves when this process changes a file ({@link advance}), when a
 * load finds bytes the record does not describe ({@link observe}: a hand edit
 * while nothing ran, a crash between a settings write and the record write, a
 * write by another product), and when a host policy outside the files changes.
 * It never returns to an earlier value, so a grant saved under it is refused
 * after a change even when the change was undone. Unchanged files read back the
 * same value after a restart.
 *
 * The record sits beside the first source, named after the whole source set, so
 * two managers that read different files never move each other's revision. No
 * lock: two processes moving it at once each write a fresh nonce, and the one
 * that loses the race reads the winner's record at its next load; a grant read
 * from the lost value is refused, never wrongly honoured.
 */
export class DurablePolicyEpochOwner {
  readonly #sources: readonly string[];
  readonly #recordPath: string;
  readonly #writable: boolean;
  #record: RevisionRecord | undefined;
  #recordWriteWarned = false;

  constructor(sources: readonly string[], writable: boolean) {
    const resolved = sources.map(source => resolve(source));
    const first = resolved[0];
    if (first === undefined) throw new Error('A durable configuration revision needs at least one settings file');
    this.#sources = Object.freeze([...new Set(resolved)].sort());
    const id = createHash('sha256').update(this.#sources.join('\0')).digest('hex').slice(0, 16);
    this.#recordPath = join(dirname(first), `.settings-revision-${id}.json`);
    this.#writable = writable;
  }

  /** The record file, for diagnostics and tests. */
  get recordPath(): string { return this.#recordPath; }

  /** `revision.nonce`; reads the files first when nothing has observed them yet. */
  current(): string {
    const record = this.#record ?? this.observe();
    return `${record.revision}.${record.nonce}`;
  }

  /**
   * Read the files and the stored record: adopt the record when it describes
   * these bytes (another process may have moved it since), otherwise move to a
   * new revision. Called at every load.
   */
  observe(): RevisionRecord {
    const hash = this.#hashSources();
    const stored = this.#readRecord();
    if (stored && stored.hash === hash) {
      this.#record = stored;
      return stored;
    }
    return this.#publish(hash, stored);
  }

  /** This process changed a file, or a policy outside the files: a new revision whatever the bytes hold. */
  advance(): void {
    this.#publish(this.#hashSources(), this.#readRecord());
  }

  /** Kept for writers that change a file before any manager loads it: the same as {@link observe}. */
  reconcile(): void { this.observe(); }

  #publish(hash: string, stored: RevisionRecord | undefined): RevisionRecord {
    const revision = Math.max(stored?.revision ?? 0, this.#record?.revision ?? 0) + 1;
    const record: RevisionRecord = Object.freeze({ revision, nonce: randomUUID(), hash });
    this.#record = record;
    if (this.#writable) {
      try { writeDocument(this.#recordPath, record, { indent: null }); }
      catch (error) {
        // An unwritten record only makes the next start pick a fresh value, so
        // a grant issued now is refused after a restart, never wrongly honoured.
        if (!this.#recordWriteWarned) logger.warn('Could not save the settings revision record', { path: this.#recordPath, error: summarizeError(error) });
        this.#recordWriteWarned = true;
      }
    }
    return record;
  }

  #readRecord(): RevisionRecord | undefined {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.#recordPath, 'utf8'));
      return isRevisionRecord(parsed) ? parsed : undefined;
    } catch { return undefined; }
  }

  #hashSources(): string {
    const hash = createHash('sha256');
    for (const source of this.#sources) {
      hash.update(source).update('\0');
      try { hash.update('present\0').update(readFileSync(source)); }
      catch (error) { hash.update(`${(error as NodeJS.ErrnoException).code ?? 'unreadable'}\0`); }
      hash.update('\0');
    }
    return hash.digest('hex');
  }
}
