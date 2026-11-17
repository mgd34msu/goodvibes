import { acquireProcessLock, withProcessLock, withProcessLockSync, type HeldProcessLock } from '../../utils/process-lock.js';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { GitService } from '../../git/service.js';
import { isMarkedProductWorktree } from '../../git/product-worktree-marker.js';
import { logger } from '../../utils/logger.js';
import { writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolveScopedDirectory } from '../surface-root.js';
import type { WorktreeSetupResult } from './setup.js';
import {
  assessWorktree,
  describeLocalState,
  DEFAULT_WORKTREE_RETENTION_MS,
  DEFAULT_KEPT_WORKTREE_NOTICE_BYTES,
  evaluateUnmarkedWorktree,
  evaluateWorktree,
  formatAge,
  formatBytes,
  isProductWorktreePath,
  runGit,
  worktreeSizeBytes,
  type WorktreeKeepReason,
  type WorktreeOwnerInfo,
} from './retention.js';

/** Current schema version of the persisted worktree store. */
const STORE_VERSION = 1;

/**
 * Age TTL for a `kept` TOMBSTONE, a record for a worktree that is no longer
 * on disk but that the user deliberately asked to preserve.
 *
 * 90 days. A tombstone is not immortal: it is a note-to-self about work that
 * was set aside, and the register it lives in is read on every worktree
 * listing. A quarter is far longer than any "I'll come back to this" horizon
 * anyone actually honours, and the underlying git BRANCH is never touched by
 * this expiry, only the registry note about it goes away, so nothing the user
 * asked to keep is destroyed by the TTL.
 *
 * A `kept` record whose worktree is STILL PRESENT is a live worktree, never a
 * tombstone, and is never aged out at any age.
 */
const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Count cap on `kept` tombstones. Sized well above any plausible number of
 * deliberately-preserved worktrees (a person tracks a handful, not hundreds)
 * so it only trims a register that has been leaking. Least-recently-updated
 * tombstones are dropped first.
 */
const MAX_TOMBSTONES = 200;

/**
 * Age TTL for a registry file preserved aside because it could not be read.
 * 30 days: these are forensic, and the person who has to explain a corrupt
 * register may not look for weeks.
 */
const PRESERVED_STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Count cap on preserved-aside registry files, a repeating fault can mint one per read, so the age TTL alone is not a bound. Newest are kept. */
const MAX_PRESERVED_STORES = 10;

/** Suffix marking a registry file preserved aside for forensics. */
const PRESERVED_SUFFIX = '.unreadable';

const WORKTREE_STATES: ReadonlySet<string> = new Set<ManagedWorktreeState>([
  'active',
  'paused',
  'kept',
  'discard',
  'pending-cleanup',
]);

const WORKTREE_KINDS: ReadonlySet<string> = new Set<ManagedWorktreeKind>(['agent', 'orchestrator', 'manual']);

export type ManagedWorktreeState = 'active' | 'paused' | 'kept' | 'discard' | 'pending-cleanup';
export type ManagedWorktreeKind = 'agent' | 'orchestrator' | 'manual';

/**
 * Worktree state is operator metadata, not a workflow: any state may be set to
 * any state. The one external writer is `setState` (the TUI `/worktree
 * pause|resume|keep`), and `/worktree recover` advertises `keep`/`resume` for
 * every record it lists, including ones persisted as `discard` or
 * `pending-cleanup`, which this registry never assigns itself (the record is
 * removed by `discard()` instead) but accepts on load. Nothing is final, so no
 * move is refused; the table records that. `setState` asserts against it so
 * narrowing it takes effect there.
 */
export const worktreeStateLifecycle = defineLifecycle<ManagedWorktreeState>('worktree', {
  active: ['active', 'paused', 'kept', 'discard', 'pending-cleanup'],
  paused: ['active', 'paused', 'kept', 'discard', 'pending-cleanup'],
  kept: ['active', 'paused', 'kept', 'discard', 'pending-cleanup'],
  discard: ['active', 'paused', 'kept', 'discard', 'pending-cleanup'],
  'pending-cleanup': ['active', 'paused', 'kept', 'discard', 'pending-cleanup'],
});

export interface ManagedWorktreeMeta {
  readonly path: string;
  readonly kind: ManagedWorktreeKind;
  readonly state: ManagedWorktreeState;
  readonly ownerId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly taskId?: string | undefined;
  readonly updatedAt: number;
  /**
   * Cold-start setup outcome for this worktree, when setup ran (on creation or
   * a re-run). Persisted so a failed setup is a VISIBLE worktree/fleet-node
   * state, never silent, surfaces read it straight off the worktree record
   * (worktrees.snapshot). Absent when no setup has ever run for this worktree.
   */
  readonly setup?: WorktreeSetupResult | undefined;
}

interface WorktreeStore {
  readonly version: 1;
  readonly records: Record<string, ManagedWorktreeMeta>;
}

export interface WorktreeStatusRecord extends ManagedWorktreeMeta {
  readonly branch: string;
  readonly head: string;
}

export interface WorktreeOwnershipSummary {
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly sessionAttached: number;
  readonly taskAttached: number;
  readonly agentOwned: number;
  readonly orchestratorOwned: number;
  readonly manualOwned: number;
}

export interface WorktreeAttachmentReview {
  readonly targetKind: 'session' | 'task';
  readonly targetId: string;
  readonly total: number;
  readonly active: number;
  readonly paused: number;
  readonly kept: number;
  readonly discard: number;
  readonly pendingCleanup: number;
  readonly records: readonly ManagedWorktreeMeta[];
}

export interface WorktreeRegistryPaths {
  readonly workingDirectory: string;
}

/**
 * The one register file for a working directory. Every surface, the daemon,
 * the gateway and orchestration read and write this same file; a register
 * per surface let `/worktree keep` and `/worktree inspect` disagree about the
 * same worktree.
 */
function getStorePath(workingDirectory: string): string {
  return resolveScopedDirectory(workingDirectory, undefined, 'worktrees.json');
}

/** How long a register write waits for another writer before refusing. */
const WRITER_LOCK_WAIT_MS = 2_000;

/** The register's lock file, beside it. Every reader-writer of the register takes this one lock. */
function registerLockPath(storePath: string): string {
  return `${storePath}.writer.sqlite`;
}

/**
 * Run a register write under its lock, waiting briefly when another process
 * holds it. The register's writes are short, so a holder normally releases
 * within milliseconds; one that does not is refused with a message that says
 * so. A holder that died released the lock with its process.
 */
function withRegistryWriteLock<T>(storePath: string, write: () => T): T {
  return withProcessLockSync(registerLockPath(storePath), write, { waitMs: WRITER_LOCK_WAIT_MS });
}

function defaultStore(): WorktreeStore {
  return { version: 1, records: {} };
}

/** The resolved path with symlinks followed when it exists, so two spellings of one directory compare equal. */
function comparablePath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function normalizePath(path: string, workingDirectory: string): string {
  return resolve(workingDirectory, path);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate one persisted record by CONTENT. Returns null when the record cannot be trusted. */
function validateRecord(value: unknown): ManagedWorktreeMeta | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const path = candidate['path'];
  const kind = candidate['kind'];
  const state = candidate['state'];
  const updatedAt = candidate['updatedAt'];
  if (typeof path !== 'string' || path.length === 0) return null;
  if (typeof kind !== 'string' || !WORKTREE_KINDS.has(kind)) return null;
  if (typeof state !== 'string' || !WORKTREE_STATES.has(state)) return null;
  if (!isFiniteNumber(updatedAt)) return null;
  const ownerId = candidate['ownerId'];
  const sessionId = candidate['sessionId'];
  const taskId = candidate['taskId'];
  const setup = candidate['setup'];
  return {
    path,
    // Both narrowed above against their closed literal sets, so these are
    // validated narrowings rather than blind assertions.
    kind: kind as ManagedWorktreeKind,
    state: state as ManagedWorktreeState,
    ...(typeof ownerId === 'string' ? { ownerId } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof taskId === 'string' ? { taskId } : {}),
    // The setup receipt is an opaque payload owned by setup.ts; it is carried
    // through when it is an object and dropped when it is not, so a malformed
    // receipt cannot make an otherwise-good record unreadable.
    ...(setup !== null && typeof setup === 'object' ? { setup: setup as WorktreeSetupResult } : {}),
    updatedAt,
  };
}

/** The verdict of reading the persisted registry file. */
type StoreVerdict =
  | { readonly kind: 'ok'; readonly store: WorktreeStore; readonly droppedRecords: number }
  | { readonly kind: 'unreadable'; readonly detail: string; readonly bytes: number };

/**
 * Parse and content-validate the registry file.
 *
 * A zero-byte, truncated or otherwise torn file (a crash mid-write) is
 * REJECTED, never served as if it were an empty register.
 *
 * Version policy: a file at or below the current version is read, because
 * every field is validated record by record right here. A file written by a
 * NEWER runtime is not interpreted, its records may carry meanings this code
 * would get wrong, and is preserved aside rather than overwritten.
 */
function parseStore(text: string): StoreVerdict {
  if (text.trim().length === 0) {
    return { kind: 'unreadable', detail: 'empty or whitespace-only file', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      kind: 'unreadable',
      detail: 'unparseable JSON (truncated or torn write)',
      bytes: Buffer.byteLength(text, 'utf-8'),
    };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'unreadable', detail: 'top-level value is not an object', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  const candidate = raw as Record<string, unknown>;
  const version = candidate['version'];
  if (!isFiniteNumber(version)) {
    return { kind: 'unreadable', detail: 'missing or non-numeric version', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  if (version > STORE_VERSION) {
    return {
      kind: 'unreadable',
      detail: `written by a newer runtime (version ${version})`,
      bytes: Buffer.byteLength(text, 'utf-8'),
    };
  }
  const rawRecords = candidate['records'];
  if (rawRecords === null || typeof rawRecords !== 'object' || Array.isArray(rawRecords)) {
    return { kind: 'unreadable', detail: 'records is not an object', bytes: Buffer.byteLength(text, 'utf-8') };
  }
  const records: Record<string, ManagedWorktreeMeta> = {};
  let droppedRecords = 0;
  for (const [key, value] of Object.entries(rawRecords as Record<string, unknown>)) {
    const record = validateRecord(value);
    if (!record) {
      droppedRecords += 1;
      continue;
    }
    records[key] = record;
  }
  return { kind: 'ok', store: { version: 1, records }, droppedRecords };
}

/**
 * Preserve an unreadable registry file aside so it is recoverable, instead of
 * letting the next write overwrite it. Returns the path it was moved to, or
 * null when the move failed.
 */
function preserveUnreadableStore(storePath: string, detail: string, bytes: number): string | null {
  const preservedPath = `${storePath}${PRESERVED_SUFFIX}-${Date.now()}-${process.pid}`;
  try {
    renameSync(storePath, preservedPath);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return null; // Another process already moved it.
    logger.error('worktree registry: failed to preserve unreadable register aside', {
      storePath,
      error: summarizeError(error),
    });
    return null;
  }
  logger.warn('worktree registry: register failed content validation, preserved aside, not overwritten', {
    storePath,
    preservedPath,
    detail,
    bytes,
  });
  reapPreservedStores(storePath);
  return preservedPath;
}

/**
 * Bound the preserved-aside registry files: an age TTL plus a count cap.
 * ENOENT on removal is success, so two processes sweeping at once is safe.
 */
function reapPreservedStores(storePath: string, now: number = Date.now()): { expired: number; overCap: number } {
  const dir = dirname(storePath);
  const prefix = `${basename(storePath)}${PRESERVED_SUFFIX}-`;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { expired: 0, overCap: 0 };
  }
  const preserved: Array<{ path: string; at: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const path = join(dir, entry);
    try {
      preserved.push({ path, at: statSync(path).mtimeMs });
    } catch {
      // Vanished between readdir and stat: another process already reaped it.
    }
  }

  let expired = 0;
  const withinTtl: Array<{ path: string; at: number }> = [];
  for (const file of preserved) {
    if (now - file.at > PRESERVED_STORE_MAX_AGE_MS) {
      if (removeFile(file.path)) expired += 1;
      continue;
    }
    withinTtl.push(file);
  }

  let overCap = 0;
  if (withinTtl.length > MAX_PRESERVED_STORES) {
    const oldestFirst = [...withinTtl].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, withinTtl.length - MAX_PRESERVED_STORES)) {
      if (removeFile(file.path)) overCap += 1;
    }
  }

  if (expired + overCap > 0) {
    logger.info('worktree registry: removed expired preserved registers', { dir, expired, overCap });
  }
  return { expired, overCap };
}

/** Delete a file, treating ENOENT as success. Returns true when the file is gone afterwards. */
function removeFile(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return true;
    logger.warn('worktree registry: failed to remove file during housekeeping', { path, error: summarizeError(error) });
    return false;
  }
}

/**
 * Read the register, validating by content.
 *
 * A missing file is a normal empty register. A file that exists but cannot be
 * trusted is DISCLOSED and preserved aside (so the `kept` tombstones the user
 * asked for stay recoverable) before an empty register is returned, the old
 * behaviour discarded them silently.
 */
function readStore(storePath: string, preserveUnreadable = true, forWrite = false): WorktreeStore {
  let text: string;
  try {
    text = readFileSync(storePath, 'utf-8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    // A writer that fell back to an empty register would publish it over the
    // real file and drop every other record, `kept` tombstones included.
    if (code !== 'ENOENT' && forWrite) {
      throw new Error(`The worktree register (${storePath}) could not be read (${summarizeError(error)}), so it was not changed. Fix the file's permissions or the disk fault, then retry.`, { cause: error });
    }
    if (code !== 'ENOENT') {
      logger.warn('worktree registry: could not read register', { storePath, error: summarizeError(error) });
    }
    return defaultStore();
  }

  const verdict = parseStore(text);
  if (verdict.kind === 'unreadable') {
    if (preserveUnreadable) preserveUnreadableStore(storePath, verdict.detail, verdict.bytes);
    return defaultStore();
  }
  if (verdict.droppedRecords > 0) {
    logger.warn('worktree registry: dropped register records that failed content validation', {
      storePath,
      droppedRecords: verdict.droppedRecords,
    });
  }
  return verdict.store;
}

export function listPersistedWorktreeMeta(options: WorktreeRegistryPaths): ManagedWorktreeMeta[] {
  return Object.values(readStore(getStorePath(options.workingDirectory)).records)
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function getPersistedWorktreeMeta(path: string, options: WorktreeRegistryPaths): ManagedWorktreeMeta | null {
  const normalized = normalizePath(path, options.workingDirectory);
  return readStore(getStorePath(options.workingDirectory)).records[normalized] ?? null;
}

export function reviewWorktreeAttachments(
  targetKind: 'session' | 'task',
  targetId: string,
  options: WorktreeRegistryPaths,
): WorktreeAttachmentReview {
  const records = listPersistedWorktreeMeta(options).filter((record) => (
    targetKind === 'session' ? record.sessionId === targetId : record.taskId === targetId
  ));
  return records.reduce<WorktreeAttachmentReview>((summary, record) => ({
    ...summary,
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    records: [...summary.records, record],
  }), {
    targetKind,
    targetId,
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    records: [],
  });
}

export function summarizeWorktreeOwnership(records: readonly ManagedWorktreeMeta[]): WorktreeOwnershipSummary {
  return records.reduce<WorktreeOwnershipSummary>((summary, record) => ({
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
    discard: summary.discard + (record.state === 'discard' ? 1 : 0),
    pendingCleanup: summary.pendingCleanup + (record.state === 'pending-cleanup' ? 1 : 0),
    sessionAttached: summary.sessionAttached + (record.sessionId ? 1 : 0),
    taskAttached: summary.taskAttached + (record.taskId ? 1 : 0),
    agentOwned: summary.agentOwned + (record.kind === 'agent' ? 1 : 0),
    orchestratorOwned: summary.orchestratorOwned + (record.kind === 'orchestrator' ? 1 : 0),
    manualOwned: summary.manualOwned + (record.kind === 'manual' ? 1 : 0),
  }), {
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    discard: 0,
    pendingCleanup: 0,
    sessionAttached: 0,
    taskAttached: 0,
    agentOwned: 0,
    orchestratorOwned: 0,
    manualOwned: 0,
  });
}

/** Atomically publish the registry while its writer lock is held; taking that lock created the parent directory. */
function writeStore(store: WorktreeStore, storePath: string): void {
  writeJsonFileAtomic(storePath, store, { durable: false });
}

function classifyWorktreePath(path: string, workingDirectory: string): Pick<ManagedWorktreeMeta, 'kind' | 'ownerId'> {
  const normalized = normalizePath(path, workingDirectory);
  const agentMatch = normalized.match(/[/\\]\.goodvibes[/\\]\.worktrees[/\\]agent-([^/\\]+)$/);
  if (agentMatch) {
    return { kind: 'agent', ownerId: agentMatch[1] };
  }
  if (normalized.includes(`${join('.goodvibes', '.worktrees')}`)) {
    return { kind: 'orchestrator' };
  }
  return { kind: 'manual' };
}

export class WorktreeRegistry {
  private readonly git: GitService;
  private readonly workingDirectory: string;

  public constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
    this.git = new GitService(workingDirectory);
  }

  /**
   * List live worktrees: `git worktree list` joined with the register. A read:
   * it takes no lock and writes nothing, so two surfaces listing at once never
   * contend. A worktree git knows and the register does not is shown as
   * `active`; `reconcile` records it.
   */
  public async list(): Promise<WorktreeStatusRecord[]> {
    const listed = await this.git.worktreeList();
    const store = readStore(getStorePath(this.workingDirectory), false);
    return this.joinListing(listed, store).sort((a, b) => a.path.localeCompare(b.path));
  }

  private joinListing(listed: Awaited<ReturnType<GitService['worktreeList']>>, store: WorktreeStore): WorktreeStatusRecord[] {
    return listed.map((entry) => {
      const path = normalizePath(entry.path, this.workingDirectory);
      const meta = store.records[path];
      const classified = classifyWorktreePath(path, this.workingDirectory);
      return {
        path,
        branch: entry.branch,
        head: entry.head,
        kind: meta?.kind ?? classified.kind,
        state: meta?.state ?? 'active',
        ...(meta?.ownerId ?? classified.ownerId ? { ownerId: meta?.ownerId ?? classified.ownerId } : {}),
        ...(meta?.sessionId ? { sessionId: meta.sessionId } : {}),
        ...(meta?.taskId ? { taskId: meta.taskId } : {}),
        ...(meta?.setup ? { setup: meta.setup } : {}),
        updatedAt: meta?.updatedAt ?? Date.now(),
      };
    });
  }

  /**
   * Reconcile the register against `git worktree list` and return the listing.
   * The register's housekeeping point, run by the retention sweep (startup and
   * contract end): it records every worktree git knows, reclaims records
   * whose worktree is gone, ages out and count-caps `kept` tombstones, and
   * sweeps expired preserved-aside register files, disclosing every count.
   */
  public async reconcile(): Promise<WorktreeStatusRecord[]> {
    const beforeScan = readStore(getStorePath(this.workingDirectory), false);
    const listed = await this.git.worktreeList();
    return withProcessLock(registerLockPath(getStorePath(this.workingDirectory)), () => {
      const store = readStore(getStorePath(this.workingDirectory), true, true);
      const present = new Set(listed.map((entry) => normalizePath(entry.path, this.workingDirectory)));
      const records = this.joinListing(listed, store);
      const nextRecords: Record<string, ManagedWorktreeMeta> = {};
      for (const record of records) {
        nextRecords[record.path] = {
          path: record.path,
          kind: record.kind,
          state: record.state,
          ...(record.ownerId ? { ownerId: record.ownerId } : {}),
          ...(record.sessionId ? { sessionId: record.sessionId } : {}),
          ...(record.taskId ? { taskId: record.taskId } : {}),
          ...(record.setup ? { setup: record.setup } : {}),
          updatedAt: record.updatedAt,
        };
      }
      // REAP: a record whose worktree is no longer on disk has lost its owner.
      // `kept` records are exempt, they are deliberate tombstones, but they get
      // their own age TTL and count cap below so they are bounded rather than
      // immortal. Everything reclaimed here is disclosed.
      let vanished = 0;
      let tombstonesExpired = 0;
      const tombstones: ManagedWorktreeMeta[] = [];
      const now = Date.now();
      for (const [path, meta] of Object.entries(store.records)) {
        if (present.has(path)) continue;
        if (JSON.stringify(meta) !== JSON.stringify(beforeScan.records[path])) {
          nextRecords[path] = meta;
          continue;
        }
        if (meta.state !== 'kept') {
          vanished += 1;
          continue;
        }
        if (now - meta.updatedAt > TOMBSTONE_MAX_AGE_MS) {
          tombstonesExpired += 1;
          continue;
        }
        tombstones.push(meta);
      }

      let tombstonesOverCap = 0;
      let retainedTombstones = tombstones;
      if (tombstones.length > MAX_TOMBSTONES) {
        retainedTombstones = [...tombstones].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TOMBSTONES);
        tombstonesOverCap = tombstones.length - retainedTombstones.length;
      }
      for (const meta of retainedTombstones) nextRecords[meta.path] = meta;

      writeStore({ version: 1, records: nextRecords }, getStorePath(this.workingDirectory));

      const reclaimed = vanished + tombstonesExpired + tombstonesOverCap;
      if (reclaimed > 0) {
        logger.info('worktree registry: reclaimed stale register records', {
          workingDirectory: this.workingDirectory,
          vanished,
          tombstonesExpired,
          tombstonesOverCap,
          total: reclaimed,
        });
      }
      reapPreservedStores(getStorePath(this.workingDirectory), now);
      return records.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  /**
   * Apply the retention policy (see retention.ts) to the product's own
   * worktrees under `.goodvibes/.worktrees`: clean worktrees with nothing
   * unique go at once, clean ones with unmerged commits lose their directory
   * after the retention period with the branch kept, and anything with
   * uncommitted changes, a running owner or unreadable git state is left
   * alone. Ignored files of its own (not installed dependencies, not unchanged
   * copies of the main checkout) keep a worktree for the retention period after
   * its owner ended, then it is removed with them. A
   * worktree in one of the product's own shapes that carries no created-by
   * marker was made before the marker existed and is removed, whatever it
   * holds, once no running owner holds it. Nothing marked kept, paused or
   * attached to a session or task is swept, and a directory that merely sits
   * under `.goodvibes` is never touched. Each removal is re-decided under the register lock, which is
   * released before the removal itself so a slow removal does not stall other
   * register writers.
   *
   * `only` limits the pass to those paths (the contract end uses it).
   */
  public async sweepRetention(options: WorktreeRetentionOptions = {}): Promise<WorktreeSweepReport> {
    const now = (options.now ?? Date.now)();
    const retentionMs = options.retentionMs ?? DEFAULT_WORKTREE_RETENTION_MS;
    const owner = options.owner ?? await this.defaultOwnerResolver();
    const onlyPaths = options.only ? new Set([...options.only].map((path) => normalizePath(path, this.workingDirectory))) : undefined;
    const report: { removed: SweptWorktree[]; kept: KeptWorktree[]; failed: Array<{ path: string; error: string }> } = { removed: [], kept: [], failed: [] };
    let rows: WorktreeStatusRecord[];
    try {
      rows = await this.reconcile();
    } catch (error) {
      logger.warn('worktree retention: the register could not be read; nothing was removed', { error: summarizeError(error) });
      return report;
    }
    const storePath = getStorePath(this.workingDirectory);
    for (const row of rows) {
      if (row.kind === 'manual' || !isProductWorktreePath(row.path, this.workingDirectory)) continue;
      if (onlyPaths && !onlyPaths.has(row.path)) continue;
      const decide = () => this.evaluateRow(row, owner(row.path), now, retentionMs);
      const keepReason = (reason: WorktreeKeepReason) => report.kept.push({ path: row.path, branch: row.branch, reason });
      const guarded = sweepProtection(row);
      if (guarded) { keepReason(guarded); continue; }
      let evaluation = await decide();
      if (evaluation.action === 'keep') { keepReason(evaluation.reason); continue; }
      // The decision is made again with the lock held, against the register as it is now: another process may have
      // acted, the owner may have moved on, or the worktree may have been marked kept. The lock is released before the
      // removal itself, which can take long on a large tree and would otherwise make every other register writer
      // wait out its limit. Git's own refusal to remove a tree with changes is the last check.
      let lock: HeldProcessLock | undefined;
      try {
        lock = await acquireProcessLock(registerLockPath(storePath));
        const current = readStore(storePath).records[row.path];
        const guardedNow = current ? sweepProtection({ ...row, state: current.state, sessionId: current.sessionId, taskId: current.taskId }) : null;
        if (guardedNow) { keepReason(guardedNow); continue; }
        evaluation = await decide();
        if (evaluation.action === 'keep') { keepReason(evaluation.reason); continue; }
      } catch (error) {
        const message = summarizeError(error);
        report.failed.push({ path: row.path, error: message });
        logger.warn('worktree retention: a worktree was kept because its removal did not complete', { path: row.path, error: message });
        continue;
      } finally {
        lock?.release();
      }
      try {
        if (evaluation.action === 'remove-unmarked') {
          // The owner's rule for worktrees from before the marker: removed with what they hold, so git's dirty-tree refusal is overridden.
          if (!(await runGit(this.workingDirectory, ['worktree', 'remove', '--force', row.path])).ok) throw new Error('git worktree remove --force failed');
        } else {
          await this.git.worktreeRemove(row.path);
        }
        const branch = evaluation.assessment.kind === 'nothing-unique' || evaluation.assessment.kind === 'unmerged' ? evaluation.assessment.branch : null;
        let branchDeleted = false;
        if (evaluation.action === 'remove-unmarked') {
          // `-d` keeps a branch with commits its base lacks, so only the uncommitted state is lost, as the rule says.
          if (branch) branchDeleted = (await runGit(this.workingDirectory, ['branch', '-d', branch])).ok;
        } else if (evaluation.action === 'remove-all' && branch) {
          // `-d` refuses a branch that is not merged, so a commit the base lacks can never be dropped here.
          branchDeleted = (await runGit(this.workingDirectory, ['branch', '-d', branch])).ok;
        } else if (branch?.startsWith('contract-input/')) {
          // A captured-input view of a dirty checkout sits on a synthetic commit that is no deliverable; the person's files stay in their own checkout, so the branch is dropped with the directory.
          branchDeleted = (await runGit(this.workingDirectory, ['branch', '-D', branch])).ok;
        }
        await this.forgetRemoved(storePath, row.path);
        const note = evaluation.action === 'remove-unmarked'
          ? `${evaluation.reason.detail}${branchDeleted ? '; its branch was merged and is deleted' : ''}`
          : evaluation.action === 'prune-directory' && !branchDeleted
            ? `directory pruned after retention; branch ${branch ?? '(none)'} kept so its commits stay reachable`
            : branchDeleted ? 'removed with its branch' : `removed; branch ${branch ?? '(none)'} kept`;
        report.removed.push({ path: row.path, branch, branchDeleted, pruned: evaluation.action === 'prune-directory', note });
        logger.info('worktree retention: removed a worktree', { path: row.path, branch, note });
      } catch (error) {
        // Another process sweeping at the same moment may have removed it first; that is not a failure here.
        if (!existsSync(row.path)) continue;
        const message = summarizeError(error);
        report.failed.push({ path: row.path, error: message });
        logger.warn('worktree retention: a worktree was kept because its removal did not complete', { path: row.path, error: message });
      }
    }
    return report;
  }

  /** The retention decision for one product worktree: the marker says which rule applies. */
  private evaluateRow(row: WorktreeStatusRecord, owner: WorktreeOwnerInfo, now: number, retentionMs: number) {
    const input = { path: row.path, rootDir: this.workingDirectory, registeredAt: row.updatedAt, owner, now };
    return isMarkedProductWorktree(row.path) ? evaluateWorktree({ ...input, retentionMs }) : evaluateUnmarkedWorktree(input);
  }

  /** Drop the register entry of a worktree whose directory is gone. Best effort: the next list() reaps it otherwise. */
  private async forgetRemoved(storePath: string, path: string): Promise<void> {
    try {
      await withProcessLock(registerLockPath(storePath), () => {
        const store = readStore(storePath, true, true);
        delete store.records[path];
        writeStore(store, storePath);
      });
    } catch (error) {
      logger.warn('worktree retention: the register entry of a removed worktree could not be dropped yet', { path, error: summarizeError(error) });
    }
  }

  /**
   * Release the worktrees of an owner that just reached a terminal state
   * (passed, failed, cancelled): ones with nothing unique go at once, the rest
   * stay for the retention period. `baseBranch` is the branch each was made from.
   */
  public releaseEnded(
    targets: ReadonlyArray<{ readonly path: string; readonly baseBranch?: string | undefined }>,
    options: Pick<WorktreeRetentionOptions, 'now' | 'retentionMs'> = {},
  ): Promise<WorktreeSweepReport> {
    const now = (options.now ?? Date.now)();
    const bases = new Map(targets.map((target) => [normalizePath(target.path, this.workingDirectory), target.baseBranch]));
    return this.sweepRetention({
      ...options,
      now: () => now,
      only: targets.map((target) => target.path),
      owner: (path) => ({ state: 'ended', endedAt: now, baseBranch: bases.get(path) }),
    });
  }

  private defaultOwnerCache: ((path: string) => WorktreeOwnerInfo) | undefined;

  private async defaultOwnerResolver(): Promise<(path: string) => WorktreeOwnerInfo> {
    if (this.defaultOwnerCache) return this.defaultOwnerCache;
    const [{ ContractStore }, { createContractOwnerResolver }] = await Promise.all([
      import('../../contract/store.js'),
      import('./owners.js'),
    ]);
    this.defaultOwnerCache = createContractOwnerResolver(this.workingDirectory, new ContractStore({ projectRoot: this.workingDirectory }));
    return this.defaultOwnerCache;
  }

  /**
   * The product's worktrees with why each is still on disk: age, size, and
   * the reason (running, uncommitted changes, unmerged commits with the days
   * left before pruning). Read-only. Pass the `rows` a caller already listed
   * to skip a second listing, and `only` to describe one path; worktrees are
   * evaluated and measured side by side, a few at a time.
   */
  public async describeKept(options: Pick<WorktreeRetentionOptions, 'now' | 'retentionMs' | 'owner'> & {
    readonly rows?: readonly WorktreeStatusRecord[] | undefined;
    readonly only?: string | undefined;
  } = {}): Promise<KeptWorktreeInfo[]> {
    const now = (options.now ?? Date.now)();
    const retentionMs = options.retentionMs ?? DEFAULT_WORKTREE_RETENTION_MS;
    const owner = options.owner ?? await this.defaultOwnerResolver();
    const only = options.only !== undefined ? normalizePath(options.only, this.workingDirectory) : undefined;
    const rows = (options.rows ?? await this.list()).filter((row) =>
      row.kind !== 'manual' && isProductWorktreePath(row.path, this.workingDirectory) && (only === undefined || row.path === only));
    const describe = async (row: WorktreeStatusRecord): Promise<KeptWorktreeInfo> => {
      const [evaluation, sizeBytes] = await Promise.all([
        this.evaluateRow(row, owner(row.path), now, retentionMs),
        worktreeSizeBytes(row.path),
      ]);
      const guarded = sweepProtection(row);
      return {
        path: row.path,
        branch: row.branch,
        ageMs: Math.max(0, now - evaluation.sinceMs),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        reason: guarded ?? evaluation.reason,
        willBeRemoved: guarded === null && evaluation.action !== 'keep',
        summary: `age ${formatAge(Math.max(0, now - evaluation.sinceMs))}, ${sizeBytes !== undefined ? formatBytes(sizeBytes) : 'size unknown (it could not be measured)'}: ${(guarded ?? evaluation.reason).detail}`,
      };
    };
    const infos: KeptWorktreeInfo[] = [];
    for (let start = 0; start < rows.length; start += DESCRIBE_CONCURRENCY) {
      infos.push(...await Promise.all(rows.slice(start, start + DESCRIBE_CONCURRENCY).map(describe)));
    }
    return infos;
  }

  /**
   * One line for startup when kept worktrees hold more than `thresholdBytes` in
   * total, else null. It names the largest few with their size and why each is
   * kept (for one holding only ignored files, when it is removed).
   */
  public async keptWorktreeNotice(options: { readonly thresholdBytes?: number; readonly owner?: WorktreeRetentionOptions['owner'] } = {}): Promise<string | null> {
    const infos = await this.describeKept(options.owner ? { owner: options.owner } : {});
    const total = infos.reduce((sum, info) => sum + (info.sizeBytes ?? 0), 0);
    if (total <= (options.thresholdBytes ?? DEFAULT_KEPT_WORKTREE_NOTICE_BYTES) || infos.length === 0) return null;
    const largest = [...infos].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 3)
      .map((info) => `${relative(this.workingDirectory, info.path)} ${info.sizeBytes !== undefined ? formatBytes(info.sizeBytes) : 'size unknown'} (${info.reason.detail})`);
    return `${infos.length} kept worktree(s) under .goodvibes use ${formatBytes(total)}; largest: ${largest.join('; ')}. Review with /worktree review, discard one with /worktree discard <path>.`;
  }

  /**
   * The start-up pass every program runs (the daemon and both terminal apps):
   * apply retention to leftovers from earlier runs, then return the kept-worktree
   * notice, or null. Never throws: start-up must not fail on it.
   */
  public async startupSweep(): Promise<string | null> {
    try {
      await this.sweepRetention();
      return await this.keptWorktreeNotice();
    } catch (error) {
      logger.warn('worktree retention: the start-up pass did not complete', { error: summarizeError(error) });
      return null;
    }
  }

  public attach(path: string, target: { sessionId?: string; taskId?: string }): void {
    const normalized = normalizePath(path, this.workingDirectory);
    // Git is asked before the register lock is taken, so a slow `git` never holds other writers up.
    const gitKnows = this.gitListsWorktreeSync(normalized);
    withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
      const store = readStore(getStorePath(this.workingDirectory), true, true);
      const existing = store.records[normalized];
      // A typo must not mint an active record that sessions, sweeps and review would then have to carry.
      if (!existing && !gitKnows) {
        throw new Error(`No worktree exists at ${normalized}, so nothing was attached. List worktrees to see the paths git knows about, then retry with one of those.`);
      }
      const classified = classifyWorktreePath(normalized, this.workingDirectory);
      store.records[normalized] = {
        path: normalized,
        kind: existing?.kind ?? classified.kind,
        state: existing?.state ?? 'active',
        ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
        ...(target.sessionId ? { sessionId: target.sessionId } : {}),
        ...(target.taskId ? { taskId: target.taskId } : {}),
        ...(existing?.setup ? { setup: existing.setup } : {}),
        updatedAt: Date.now(),
      };
      writeStore(store, getStorePath(this.workingDirectory));
    });
  }

  /** True when `git worktree list` names this path (the main checkout counts); false when git cannot answer. */
  private gitListsWorktreeSync(normalized: string): boolean {
    const result = Bun.spawnSync(['git', 'worktree', 'list', '--porcelain'], { cwd: this.workingDirectory, stdout: 'pipe', stderr: 'ignore' });
    if (result.exitCode !== 0) return false;
    const wanted = comparablePath(normalized);
    return new TextDecoder().decode(result.stdout).split('\n')
      .some((line) => line.startsWith('worktree ') && comparablePath(line.slice('worktree '.length)) === wanted);
  }

  public setState(path: string, state: ManagedWorktreeState): void {
    const normalized = normalizePath(path, this.workingDirectory);
    // Listing records nothing, so a worktree git knows may not be registered yet; git is asked before the lock is taken.
    let gitKnows: boolean | undefined;
    if (!readStore(getStorePath(this.workingDirectory), false).records[normalized]) gitKnows = this.gitListsWorktreeSync(normalized);
    withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
      const store = readStore(getStorePath(this.workingDirectory), true, true);
      const classified = classifyWorktreePath(normalized, this.workingDirectory);
      // A typo must not create a record (a `kept` one would linger as a
      // tombstone for months): only a path git lists as a worktree is added.
      const existing: ManagedWorktreeMeta | undefined = store.records[normalized]
        ?? (gitKnows ? { path: normalized, kind: classified.kind, state: 'active', updatedAt: Date.now() } : undefined);
      if (!existing) {
        throw new Error(`No worktree exists at ${normalized}; nothing was changed. /worktree review lists the worktrees git knows about; retry with one of those paths.`);
      }
      worktreeStateLifecycle.assert(existing.state, state);
      store.records[normalized] = {
        path: normalized,
        kind: existing.kind,
        state,
        ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
        ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
        ...(existing?.taskId ? { taskId: existing.taskId } : {}),
        ...(existing?.setup ? { setup: existing.setup } : {}),
        updatedAt: Date.now(),
      };
      writeStore(store, getStorePath(this.workingDirectory));
    });
  }

  /**
   * Record a cold-start setup outcome onto a worktree's record (on creation or
   * a re-run), so a failed setup is a visible, queryable worktree/fleet-node
   * state rather than a lost log. Upserts the record if setup ran before the
   * worktree was otherwise registered.
   */
  public recordSetup(path: string, setup: WorktreeSetupResult): void {
    withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
      const store = readStore(getStorePath(this.workingDirectory), true, true);
      const normalized = normalizePath(path, this.workingDirectory);
      const existing = store.records[normalized];
      const classified = classifyWorktreePath(normalized, this.workingDirectory);
      store.records[normalized] = {
        path: normalized,
        kind: existing?.kind ?? classified.kind,
        state: existing?.state ?? 'active',
        ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
        ...(existing?.sessionId ? { sessionId: existing.sessionId } : {}),
        ...(existing?.taskId ? { taskId: existing.taskId } : {}),
        setup,
        updatedAt: Date.now(),
      };
      writeStore(store, getStorePath(this.workingDirectory));
    });
  }

  public async cleanup(path: string): Promise<void> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    await this.git.worktreeRemove(normalized);
    withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
      const store = readStore(getStorePath(this.workingDirectory), true, true);
      delete store.records[normalized];
      writeStore(store, getStorePath(this.workingDirectory));
    });
  }

  /**
   * DISCARD actually discards, per the eviction-preserving rules:
   *  1. Any uncommitted state is first COMMITTED onto the worktree's branch
   *     (data safety; a preservation failure refuses the removal rather than
   *     losing work).
   *  2. The worktree DIRECTORY is removed (`git worktree remove`).
   *  3. The BRANCH is kept, never deleted on this path.
   * Returns an honest receipt either way; the record is dropped only when the
   * directory really came off disk.
   */
  public async discard(path: string): Promise<WorktreeDiscardReceipt> {
    const normalized = isAbsolute(path) ? path : normalizePath(path, this.workingDirectory);
    const discardedAt = Date.now();
    // Discard commits whatever is dirty in the directory it is given, so it
    // must be a linked worktree of this repository before git is touched there.
    const unmanaged = await this.refuseUnlinkedWorktree(normalized);
    if (unmanaged) {
      return { path: normalized, ok: false, discardedAt, detail: `discard refused: ${unmanaged} Nothing was committed or removed.` };
    }
    const owner = await this.ownerOf(normalized);
    if (owner.state === 'running') {
      return {
        path: normalized,
        ok: false,
        discardedAt,
        detail: `discard refused: its contract or agent is still running, so removing the directory would take the files it is working in. ${await this.describeAtStake(normalized)} Cancel the contract or agent first, then discard.`,
      };
    }
    const worktreeGit = this.createWorktreeGit(normalized);
    let branch: string | undefined;
    let preservedCommit: string | undefined;
    try {
      branch = (await worktreeGit.branch()).current;
      const status = await worktreeGit.status();
      if (!status.isClean()) {
        await worktreeGit.addAll();
        const commit = await worktreeGit.commit('goodvibes: preserve working state before discard', {
          noVerify: true,
          fallbackIdentity: { name: 'goodvibes', email: 'goodvibes@localhost' },
        });
        preservedCommit = commit.hash;
      }
    } catch (error) {
      // Preservation failed, refuse the removal (losing work is worse than a
      // lingering directory) and say so honestly.
      return {
        path: normalized,
        ok: false,
        ...(branch ? { branch } : {}),
        discardedAt,
        detail: `discard refused: could not preserve uncommitted state (${String(error instanceof Error ? error.message : error)}). ${await this.describeAtStake(normalized)} Nothing was removed.`,
      };
    }
    // Removing the directory also deletes what git ignores, and no commit can hold it; say how much, plainly.
    const ignored = (await runGit(normalized, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored'])).out
      .split('\n').filter((line) => line.startsWith('!! ')).length;
    // A detached HEAD that no branch holds would leave its commits unreachable once the directory is gone.
    let detachedBranch: string | undefined;
    const head = await runGit(normalized, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.ok && head.out.length > 0 && !(await runGit(normalized, ['symbolic-ref', '-q', 'HEAD'])).ok) {
      const holders = await runGit(normalized, ['for-each-ref', '--contains', head.out, '--format=%(refname)', 'refs/heads']);
      if (holders.ok && holders.out.length === 0) {
        const name = `goodvibes/discarded-${head.out.slice(0, 12)}`;
        if (!(await runGit(normalized, ['branch', name, head.out])).ok) {
          return {
            path: normalized,
            ok: false,
            ...(preservedCommit ? { preservedCommit } : {}),
            discardedAt,
            detail: `discard refused: HEAD is detached and no branch holds its commits, and a branch to keep them could not be created. Create a branch in ${normalized} (git switch -c <name>), then discard. Nothing was removed.`,
          };
        }
        detachedBranch = name;
        branch = name;
      }
    }
    try {
      await this.git.worktreeRemove(normalized);
    } catch (error) {
      return {
        path: normalized,
        ok: false,
        ...(branch ? { branch } : {}),
        ...(preservedCommit ? { preservedCommit } : {}),
        discardedAt,
        detail: `discard failed: worktree removal did not complete (${String(error instanceof Error ? error.message : error)}). ${await this.describeAtStake(normalized)} Nothing was removed.`,
      };
    }
    // The directory is already gone; a register that cannot be updated now
    // must not turn this into a failure that hides the preserved commit. The
    // next list() reaps the record, since its worktree is no longer on disk.
    let registerNote = '';
    try {
      withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
        const store = readStore(getStorePath(this.workingDirectory), true, true);
        delete store.records[normalized];
        writeStore(store, getStorePath(this.workingDirectory));
      });
    } catch (error) {
      registerNote = `; the register entry could not be removed yet (${summarizeError(error)}) and is reclaimed by the next list`;
    }
    return {
      path: normalized,
      ok: true,
      ...(branch ? { branch } : {}),
      ...(preservedCommit ? { preservedCommit } : {}),
      discardedAt,
      detail: (preservedCommit
        ? `worktree removed; uncommitted state preserved as ${preservedCommit.slice(0, 12)} on kept branch ${branch ?? '(unknown)'}`
        : `worktree removed; branch ${branch ?? '(unknown)'} kept`)
        + (detachedBranch ? `; HEAD was detached, so its commits were kept on new branch ${detachedBranch}` : '')
        + (ignored > 0 ? `; ${ignored} ignored file(s) or folder(s) were deleted with the directory and are NOT preserved (git does not hold them)` : '')
        + registerNote,
    };
  }

  /** Why `normalized` may not be discarded (not a linked worktree of this project), or null when it may. */
  private async refuseUnlinkedWorktree(normalized: string): Promise<string | null> {
    let listed: Array<{ path: string }>;
    try {
      listed = await this.git.worktreeList();
    } catch (error) {
      return `git could not list this project's worktrees (${summarizeError(error)}), so ${normalized} cannot be confirmed as one.`;
    }
    const wanted = comparablePath(normalized);
    const index = listed.findIndex((entry) => comparablePath(entry.path) === wanted);
    if (index < 0) {
      return `${normalized} is not a worktree of this project. List the project's worktrees and pass one of their paths.`;
    }
    if (index === 0 || wanted === comparablePath(this.workingDirectory)) {
      return `${normalized} is the main checkout (or the directory this session works in), not a linked worktree.`;
    }
    return null;
  }

  private async ownerOf(path: string): Promise<WorktreeOwnerInfo> {
    try {
      return (await this.defaultOwnerResolver())(path);
    } catch {
      return { state: 'unknown' };
    }
  }

  /** What discarding this worktree would put at risk, in words, for a refusal. */
  private async describeAtStake(path: string): Promise<string> {
    const owner = await this.ownerOf(path);
    const assessment = await assessWorktree(path, this.workingDirectory, owner.baseBranch);
    switch (assessment.kind) {
      case 'uncommitted': return `At stake: ${describeLocalState(assessment.changes, assessment.ignored)}. Discard commits the uncommitted changes onto the branch first; ignored files cannot be preserved and are deleted with the directory.`;
      case 'unmerged': return `At stake: ${assessment.commits} commit(s) not in ${assessment.base}; they stay on branch ${assessment.branch ?? '(detached HEAD, no branch holds them)'}.`;
      case 'nothing-unique': return 'At stake: nothing unique (clean, all commits already in its base).';
      case 'unreadable': return `What is at stake could not be read (${assessment.reason}).`;
    }
  }

  /** Injectable seam for tests: a GitService rooted INSIDE the worktree being discarded. */
  protected createWorktreeGit(worktreePath: string): Pick<GitService, 'branch' | 'status' | 'addAll' | 'commit'> {
    return new GitService(worktreePath);
  }
}

/** Worktrees evaluated and measured at once by describeKept: each spawns git and `du` over a full checkout. */
const DESCRIBE_CONCURRENCY = 4;

/**
 * Why the automatic sweep must leave a worktree alone regardless of what it
 * holds, or null: the user kept or paused it, or attached it to a session or
 * task. Which retention rule applies otherwise is the created-by marker's
 * question (see `evaluateRow`).
 */
function sweepProtection(row: Pick<WorktreeStatusRecord, 'path' | 'state' | 'sessionId' | 'taskId'>): WorktreeKeepReason | null {
  if (row.state === 'kept') return { why: 'protected', detail: 'marked kept; only /worktree discard removes it' };
  if (row.state === 'paused') return { why: 'protected', detail: 'paused; resume or discard it explicitly' };
  if (row.sessionId || row.taskId) return { why: 'protected', detail: `attached to ${row.sessionId ? `session ${row.sessionId}` : `task ${row.taskId}`}; detach or discard it explicitly` };
  return null;
}

export interface WorktreeRetentionOptions {
  /** Injected clock; defaults to the wall clock. */
  readonly now?: (() => number) | undefined;
  /** How long after its owner ended a clean worktree with unmerged commits stays. Default 14 days. */
  readonly retentionMs?: number | undefined;
  /** Who owns a worktree. Defaults to the contract store's record of it. */
  readonly owner?: ((path: string) => WorktreeOwnerInfo) | undefined;
  /** Restrict the pass to these paths. */
  readonly only?: readonly string[] | undefined;
}

export interface SweptWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly branchDeleted: boolean;
  /** True when the directory was removed after the retention period with its branch kept. */
  readonly pruned: boolean;
  readonly note: string;
}

export interface KeptWorktree {
  readonly path: string;
  readonly branch: string;
  readonly reason: WorktreeKeepReason;
}

export interface WorktreeSweepReport {
  readonly removed: readonly SweptWorktree[];
  readonly kept: readonly KeptWorktree[];
  readonly failed: ReadonlyArray<{ readonly path: string; readonly error: string }>;
}

export interface KeptWorktreeInfo {
  readonly path: string;
  readonly branch: string;
  readonly ageMs: number;
  readonly sizeBytes?: number;
  readonly reason: WorktreeKeepReason;
  /** True when the next sweep would remove it. */
  readonly willBeRemoved: boolean;
  /** Age, size and the reason it is kept, as one human-readable string. */
  readonly summary: string;
}

/** The honest record of one discard: what came off disk, what was kept, what was preserved. */
export interface WorktreeDiscardReceipt {
  readonly path: string;
  /** True only when the directory really came off disk. */
  readonly ok: boolean;
  /** The branch that was KEPT (never deleted by discard). */
  readonly branch?: string | undefined;
  /** The preservation commit recorded for uncommitted state, when the tree was dirty. */
  readonly preservedCommit?: string | undefined;
  readonly discardedAt: number;
  readonly detail: string;
}
