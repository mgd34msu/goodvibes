import { withProcessLockSync } from '../../utils/process-lock.js';
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GitService } from '../../git/service.js';
import { isMarkedProductWorktree, isWorktreeLockedByGit, kindOfProductWorktree, productWorktreeSegments } from '../../git/product-worktree-marker.js';
import { logger } from '../../utils/logger.js';
import { writeJsonFileAtomic } from '../../utils/atomic-json-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolveScopedDirectory } from '../surface-root.js';
import { noteListChanged } from '../list-changes.js';
import { projectIdentityOf } from '../../workspace/project-identity.js';
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
  needsOwnerDecision,
  runGit,
  worktreeNextSteps,
  worktreeSizeBytes,
  type WorktreeEvaluation,
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

const WORKTREE_STATES: ReadonlySet<string> = new Set<ManagedWorktreeState>(['active', 'paused', 'kept']);

/**
 * States earlier builds could persist and nothing assigns any more. A record
 * still carrying one reads as `kept`: never swept, and the owner keeps it,
 * resumes it or discards it explicitly.
 */
const RETIRED_WORKTREE_STATES: ReadonlySet<string> = new Set(['discard', 'pending-cleanup']);

const WORKTREE_KINDS: ReadonlySet<string> = new Set<ManagedWorktreeKind>(['agent', 'orchestrator', 'manual']);

/**
 * Worktree state is operator metadata, not a workflow: any of the three may be
 * set from any other (`/worktree pause|resume|keep`). Discarding a worktree
 * removes its record (`discard()`), so there is no discard state.
 */
export type ManagedWorktreeState = 'active' | 'paused' | 'kept';
export type ManagedWorktreeKind = 'agent' | 'orchestrator' | 'manual';

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
  /**
   * The retention sweep's claim on this worktree while it removes it: taken
   * under the register lock right before the removal, in the same section that
   * checked nothing protects the tree. While it is live (`expiresAt` ahead), a
   * keep, pause, resume or attach is refused instead of being written and then
   * ignored by a removal already under way; an expired claim (the sweeping
   * process died) is cleared by the next write of the record.
   */
  readonly removal?: WorktreeRemovalClaim | undefined;
  /**
   * When a terminal app's start-up told the owner this worktree was kept for
   * their decision, with where its work is and the commands to take or discard
   * it. It is told once; /worktree review lists it for as long as it stays.
   */
  readonly toldAt?: number | undefined;
}

/** Who is removing a worktree, until when (see {@link ManagedWorktreeMeta.removal}). */
export interface WorktreeRemovalClaim {
  /** `${pid}:${startedAt}` of the sweeping process. */
  readonly owner: string;
  readonly expiresAt: number;
}

/** How long a removal claim holds: a `git worktree remove` takes well under this; a dead sweeper's claim lapses after it. */
const REMOVAL_CLAIM_TTL_MS = 2 * 60_000;

/** The live removal claim on a record, or undefined. */
function liveRemoval(meta: ManagedWorktreeMeta | undefined, now: number): WorktreeRemovalClaim | undefined {
  return meta?.removal && meta.removal.expiresAt > now ? meta.removal : undefined;
}

/** A keep, pause, resume or attach of a tree being removed is refused, saying so. */
function refuseWhileRemoving(meta: ManagedWorktreeMeta | undefined, normalized: string, action: string): void {
  if (!liveRemoval(meta, Date.now())) return;
  throw new Error(`${normalized} is being removed by the worktree retention sweep right now, so it was not ${action}. `
    + 'Nothing protected it when the removal started (not kept, paused or attached); its branch is kept unless it was merged. The Worktrees list in Code and changes shows what remains.');
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
  if (typeof state !== 'string' || (!WORKTREE_STATES.has(state) && !RETIRED_WORKTREE_STATES.has(state))) return null;
  if (!isFiniteNumber(updatedAt)) return null;
  const ownerId = candidate['ownerId'];
  const sessionId = candidate['sessionId'];
  const taskId = candidate['taskId'];
  const setup = candidate['setup'];
  const removal = candidate['removal'] as Record<string, unknown> | null | undefined;
  return {
    path,
    // Both narrowed above against their closed literal sets, so these are
    // validated narrowings rather than blind assertions.
    kind: kind as ManagedWorktreeKind,
    state: RETIRED_WORKTREE_STATES.has(state) ? 'kept' : state as ManagedWorktreeState,
    ...(typeof ownerId === 'string' ? { ownerId } : {}),
    ...(typeof sessionId === 'string' ? { sessionId } : {}),
    ...(typeof taskId === 'string' ? { taskId } : {}),
    // The setup receipt is an opaque payload owned by setup.ts; it is carried
    // through when it is an object and dropped when it is not, so a malformed
    // receipt cannot make an otherwise-good record unreadable.
    ...(setup !== null && typeof setup === 'object' ? { setup: setup as WorktreeSetupResult } : {}),
    ...(removal !== null && typeof removal === 'object' && typeof removal['owner'] === 'string' && isFiniteNumber(removal['expiresAt'])
      ? { removal: { owner: removal['owner'], expiresAt: removal['expiresAt'] } } : {}),
    ...(isFiniteNumber(candidate['toldAt']) ? { toldAt: candidate['toldAt'] } : {}),
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
    records: [...summary.records, record],
  }), {
    targetKind,
    targetId,
    total: 0,
    active: 0,
    paused: 0,
    kept: 0,
    records: [],
  });
}

export function summarizeWorktreeOwnership(records: readonly ManagedWorktreeMeta[]): WorktreeOwnershipSummary {
  return records.reduce<WorktreeOwnershipSummary>((summary, record) => ({
    total: summary.total + 1,
    active: summary.active + (record.state === 'active' ? 1 : 0),
    paused: summary.paused + (record.state === 'paused' ? 1 : 0),
    kept: summary.kept + (record.state === 'kept' ? 1 : 0),
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
  // A project's worktree register changed (made, set up, paused, kept, tied, removed): a list showing it reads again
  // (the daemon sends it as LIST_CHANGED `worktrees`, the register file as the id).
  // The register is its project's (`<project>/.goodvibes/worktrees.json`): only that project's screens read again.
  noteListChanged({ list: 'worktrees', change: 'changed', id: storePath, project: projectIdentityOf(dirname(dirname(storePath))) });
}

/** True when both registers hold the same records (key order does not matter). */
function sameRecords(a: Record<string, ManagedWorktreeMeta>, b: Record<string, ManagedWorktreeMeta>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] !== undefined && JSON.stringify(a[key]) === JSON.stringify(b[key]));
}

function classifyWorktreePath(path: string, workingDirectory: string): Pick<ManagedWorktreeMeta, 'kind' | 'ownerId'> {
  const normalized = normalizePath(path, workingDirectory);
  // Git lists worktrees by their real path; the root may be given through a link.
  const root = productWorktreeSegments(workingDirectory, normalized) !== null ? workingDirectory : comparablePath(workingDirectory);
  const segments = productWorktreeSegments(root, normalized);
  if (segments === null) return { kind: 'manual' };
  // A pre-3.3.0 agent's own tree, `agent-<id>` directly under the root, names its agent.
  if (segments.length === 1 && kindOfProductWorktree(root, normalized) === 'agent') {
    return { kind: 'agent', ownerId: segments[0]!.slice('agent-'.length) };
  }
  return { kind: 'orchestrator' };
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
        ...(meta?.removal ? { removal: meta.removal } : {}),
        ...(meta?.toldAt !== undefined ? { toldAt: meta.toldAt } : {}),
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
    return withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
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
          ...(record.removal ? { removal: record.removal } : {}),
          ...(record.toldAt !== undefined ? { toldAt: record.toldAt } : {}),
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

      // Written only when reconciliation changed something; a pass over an
      // unchanged register is a read.
      if (!sameRecords(store.records, nextRecords)) {
        writeStore({ version: 1, records: nextRecords }, getStorePath(this.workingDirectory));
      }

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
   * uncommitted or untracked changes, a running owner or unreadable git state
   * is left alone. Ignored files of its own (not installed dependencies, not
   * unchanged copies of the main checkout) keep a worktree for the retention
   * period after its owner ended, then it is removed with them. A worktree in
   * one of the product's own shapes that carries no created-by marker was made
   * before the marker existed; it goes only when it holds nothing found nowhere
   * else. A detached HEAD that no branch holds is saved to a new branch before
   * its directory goes. Nothing marked kept, paused, attached to a session or
   * task, locked with `git worktree lock`, or holding another worktree inside it
   * is swept, and a directory that merely sits under `.goodvibes` is never
   * touched. Removal is never forced. Each removal is decided first (git and
   * owner reads, outside any lock), then checked against the register under its
   * lock, synchronously: a row whose state, session, task or update time moved
   * since the decision is kept for the next sweep. The lock is never held across
   * an await, so the register's other writers, which take it synchronously, are
   * never refused because a sweep is running in the same process.
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
    // Worktrees still on disk; one removed in this pass leaves it, so the tree it lived in is decided in the same pass.
    const allPaths = rows.map((row) => row.path);
    const gone = (path: string): void => { const at = allPaths.indexOf(path); if (at >= 0) allPaths.splice(at, 1); };
    // A worktree nested in another (a contract's work-item trees inside the contract's tree) is decided first.
    const ordered = [...rows].sort((a, b) => b.path.split(sep).length - a.path.split(sep).length);
    for (const row of ordered) {
      if (row.kind === 'manual' || !isProductWorktreePath(row.path, this.workingDirectory)) continue;
      if (onlyPaths && !onlyPaths.has(row.path)) continue;
      const keepReason = (reason: WorktreeKeepReason) => report.kept.push({ path: row.path, branch: row.branch, head: row.head, reason });
      const guarded = sweepProtection(row) ?? gitHeldProtection(row.path, allPaths);
      if (guarded) { keepReason(guarded); continue; }
      const rowOwner = owner(row.path);
      const evaluation = await this.evaluateRow(row, rowOwner, now, retentionMs);
      if (evaluation.action === 'keep') { keepReason(evaluation.reason); continue; }
      // The register as it is now, read under its lock with no await in between: another process or another
      // contract here may have attached, paused, kept or set up this worktree since the listing the decision used.
      // The removal itself runs after the lock is released, so a slow removal stalls no register writer. Git's own
      // refusal to remove a tree with changes is the last check.
      let changed: WorktreeKeepReason | null;
      try {
        changed = withRegistryWriteLock<WorktreeKeepReason | null>(storePath, () => {
          const current = readStore(storePath).records[row.path];
          if (!current) return null;
          const guardedNow = sweepProtection({ ...row, state: current.state, sessionId: current.sessionId, taskId: current.taskId });
          if (guardedNow) return guardedNow;
          return current.state !== row.state || current.sessionId !== row.sessionId || current.taskId !== row.taskId || current.updatedAt !== row.updatedAt
            ? { why: 'protected', detail: 'its register entry changed while it was being assessed; the next sweep decides again' }
            : null;
        });
      } catch (error) {
        const message = summarizeError(error);
        report.failed.push({ path: row.path, error: message });
        logger.warn('worktree retention: a worktree was kept because its removal did not complete', { path: row.path, error: message });
        continue;
      }
      if (changed) { keepReason(changed); continue; }
      const kept = await this.prepareRemoval(row.path, evaluation);
      if (kept) { keepReason(kept); continue; }
      // The claim, right before the removal: checked and written in one register section, so a keep,
      // pause or attach made while prepareRemoval ran keeps the tree, and one made from now on is refused.
      let claimed: WorktreeKeepReason | null;
      try {
        claimed = this.claimRemoval(storePath, row);
      } catch (error) {
        const message = summarizeError(error);
        report.failed.push({ path: row.path, error: message });
        logger.warn('worktree retention: a worktree was kept because its removal did not complete', { path: row.path, error: message });
        continue;
      }
      if (claimed) { keepReason(claimed); continue; }
      try {
        // Never forced: git refuses a tree with modified or untracked files, whatever was read before.
        await this.git.worktreeRemove(row.path);
        const branch = evaluation.assessment.kind === 'nothing-unique' || evaluation.assessment.kind === 'unmerged' ? evaluation.assessment.branch : null;
        let branchDeleted = false;
        if (evaluation.action === 'remove-all' && branch && (rowOwner.baseCommits?.length ?? 0) > 0) {
          // Every commit on it is in its base or in what its owner keeps elsewhere (the captured input, the
          // contract's branch), which the assessment just counted, so the branch holds nothing of its own.
          branchDeleted = (await runGit(this.workingDirectory, ['branch', '-D', branch])).ok;
        } else if ((evaluation.action === 'remove-unmarked' || evaluation.action === 'remove-all') && branch) {
          // `-d` refuses a branch that is not merged, so a commit the base lacks can never be dropped here.
          branchDeleted = (await runGit(this.workingDirectory, ['branch', '-d', branch])).ok;
        } else if (branch?.startsWith('contract-input/')) {
          // A captured-input view of a dirty checkout sits on a synthetic commit that is no deliverable; the person's files stay in their own checkout, so the branch is dropped with the directory.
          branchDeleted = (await runGit(this.workingDirectory, ['branch', '-D', branch])).ok;
        }
        this.forgetRemoved(storePath, row.path);
        gone(row.path);
        const saved = evaluation.saveAs ? `; its detached HEAD was saved to new branch ${evaluation.saveAs}` : '';
        const note = evaluation.action === 'remove-unmarked'
          ? `${evaluation.reason.detail}${branchDeleted ? '; its branch was merged and is deleted' : ''}`
          : evaluation.action === 'prune-directory' && !branchDeleted
            ? `directory pruned after retention; branch ${branch ?? evaluation.saveAs ?? (evaluation.assessment.kind === 'unmerged' ? evaluation.assessment.heldBy : undefined) ?? '(none)'} kept so its commits stay reachable${saved}`
            : branchDeleted ? 'removed with its branch' : `removed; branch ${branch ?? '(none)'} kept`;
        report.removed.push({ path: row.path, branch, branchDeleted, pruned: evaluation.action === 'prune-directory', note, ...(evaluation.saveAs ? { savedBranch: evaluation.saveAs } : {}) });
        logger.info('worktree retention: removed a worktree', { path: row.path, branch, note });
      } catch (error) {
        // Another process sweeping at the same moment may have removed it first; that is not a failure here.
        if (!existsSync(row.path)) { gone(row.path); continue; }
        // The tree stays: the claim goes, so it can be kept, paused or attached again at once.
        this.releaseRemoval(storePath, row.path);
        const message = summarizeError(error);
        report.failed.push({ path: row.path, error: message });
        logger.warn('worktree retention: a worktree was kept because its removal did not complete', { path: row.path, error: message });
      }
    }
    return report;
  }

  /**
   * The last checks before a decided removal, after the register check: HEAD
   * has not moved since it was read, and a detached HEAD no branch holds is
   * saved to its new branch. Returns why the worktree stays, or null to remove.
   */
  private async prepareRemoval(path: string, evaluation: WorktreeEvaluation): Promise<WorktreeKeepReason | null> {
    const assessment = evaluation.assessment;
    if (assessment.kind !== 'nothing-unique' && assessment.kind !== 'unmerged') return null;
    const head = await runGit(path, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (!head.ok || head.out !== assessment.head) {
      return { why: 'protected', detail: 'a commit was made in it while it was being assessed; the next sweep decides again' };
    }
    if (!evaluation.saveAs) return null;
    if ((await runGit(this.workingDirectory, ['branch', evaluation.saveAs, assessment.head])).ok) return null;
    // An earlier sweep may have made the branch already; it is good only if it names this very commit.
    const existing = await runGit(this.workingDirectory, ['rev-parse', '--verify', '-q', `refs/heads/${evaluation.saveAs}^{commit}`]);
    if (existing.ok && existing.out === assessment.head) return null;
    return { why: 'detached', detail: `${assessment.kind === 'unmerged' ? assessment.commits : 0} commit(s) on its detached HEAD are on no branch, and branch ${evaluation.saveAs} to hold them could not be made` };
  }

  /**
   * Take the removal claim on `row` if nothing protects it now: the register
   * read under its lock, compared with the listing the decision used, and the
   * claim written in the same section. Returns why the tree stays, or null
   * when the claim was taken. One register write per removed tree.
   */
  private claimRemoval(storePath: string, row: WorktreeStatusRecord): WorktreeKeepReason | null {
    return withRegistryWriteLock<WorktreeKeepReason | null>(storePath, () => {
      const store = readStore(storePath, true, true);
      const current = store.records[row.path];
      const now = Date.now();
      if (current) {
        const guardedNow = sweepProtection({ ...row, state: current.state, sessionId: current.sessionId, taskId: current.taskId });
        if (guardedNow) return guardedNow;
        if (current.state !== row.state || current.sessionId !== row.sessionId || current.taskId !== row.taskId || current.updatedAt !== row.updatedAt) {
          return { why: 'protected', detail: 'its register entry changed while it was being assessed; the next sweep decides again' };
        }
        const held = liveRemoval(current, now);
        if (held) return { why: 'protected', detail: `another process (${held.owner}) is removing it` };
      }
      const base: ManagedWorktreeMeta = current ?? { path: row.path, kind: row.kind, state: row.state, updatedAt: row.updatedAt };
      store.records[row.path] = { ...base, removal: { owner: `${process.pid}:${now}`, expiresAt: now + REMOVAL_CLAIM_TTL_MS } };
      writeStore(store, storePath);
      return null;
    });
  }

  /** Drop this process's removal claim after a removal that did not happen. Best effort: an unreleased claim lapses by itself. */
  private releaseRemoval(storePath: string, path: string): void {
    try {
      withRegistryWriteLock(storePath, () => {
        const store = readStore(storePath, true, true);
        const current = store.records[path];
        if (!current?.removal || !current.removal.owner.startsWith(`${process.pid}:`)) return;
        const { removal: _released, ...rest } = current;
        store.records[path] = rest;
        writeStore(store, storePath);
      });
    } catch (error) {
      logger.warn('worktree retention: a removal claim could not be released; it lapses by itself', { path, error: summarizeError(error) });
    }
  }

  /** The retention decision for one product worktree: the marker says which rule applies. */
  private evaluateRow(row: WorktreeStatusRecord, owner: WorktreeOwnerInfo, now: number, retentionMs: number): Promise<WorktreeEvaluation> {
    const input = { path: row.path, rootDir: this.workingDirectory, registeredAt: row.updatedAt, owner, now, retentionMs };
    return isMarkedProductWorktree(row.path) ? evaluateWorktree(input) : evaluateUnmarkedWorktree(input);
  }

  /** Drop the register entry of a worktree whose directory is gone. Best effort: the next list() reaps it otherwise. */
  private forgetRemoved(storePath: string, path: string): void {
    try {
      withRegistryWriteLock(storePath, () => {
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
   * (passed, failed, cancelled, or ended by a crash and found at the next
   * start), with every worktree nested inside them (a contract's work-item
   * trees): ones with nothing unique go at once, the rest stay for the
   * retention period. `baseBranch` is the branch each was made from;
   * `baseCommits` what its owner keeps elsewhere (see
   * {@link WorktreeOwnerInfo.baseCommits}); a nested tree also counts the
   * branch of the tree it lives in (`nestedBase`) as kept.
   */
  public async releaseEnded(
    targets: ReadonlyArray<{ readonly path: string; readonly baseBranch?: string | undefined; readonly baseCommits?: readonly string[] | undefined; readonly nestedBase?: string | undefined }>,
    options: Pick<WorktreeRetentionOptions, 'now' | 'retentionMs'> = {},
  ): Promise<WorktreeSweepReport> {
    const now = (options.now ?? Date.now)();
    const owners = new Map<string, WorktreeOwnerInfo>();
    for (const target of targets) {
      const path = normalizePath(target.path, this.workingDirectory);
      owners.set(path, { state: 'ended', endedAt: now, baseBranch: target.baseBranch, ...(target.baseCommits?.length ? { baseCommits: target.baseCommits } : {}) });
    }
    let listed: WorktreeStatusRecord[] = [];
    try { listed = await this.list(); } catch { /* the sweep below reads the register again and reports it */ }
    for (const target of targets) {
      const parent = normalizePath(target.path, this.workingDirectory);
      const nestedBases = [...(target.baseCommits ?? []), ...(target.nestedBase ? [`refs/heads/${target.nestedBase}`] : [])];
      for (const row of listed) {
        if (!row.path.startsWith(`${parent}${sep}`) || owners.has(row.path)) continue;
        owners.set(row.path, { state: 'ended', endedAt: now, baseBranch: target.baseBranch, ...(nestedBases.length > 0 ? { baseCommits: nestedBases } : {}) });
      }
    }
    return this.sweepRetention({
      ...options,
      now: () => now,
      only: [...owners.keys()],
      owner: (path) => owners.get(path) ?? { state: 'unknown' },
    });
  }

  /**
   * The owner lookup for every worktree shape (see owners.ts), made fresh for
   * each pass: it reads contracts and saved workstreams once per pass, so a
   * later pass sees owners that have ended or started since.
   */
  private async defaultOwnerResolver(): Promise<(path: string) => WorktreeOwnerInfo> {
    const [{ ContractStore }, { createContractOwnerResolver }] = await Promise.all([
      import('../../contract/store.js'),
      import('./owners.js'),
    ]);
    return createContractOwnerResolver(this.workingDirectory, new ContractStore({ projectRoot: this.workingDirectory }));
  }

  /**
   * The product's worktrees with why each is still on disk: age, size, and
   * the reason (running, uncommitted changes, unmerged commits with the days
   * left before pruning), with the next steps for one that needs its owner's
   * decision. Read-only. Pass the `rows` a caller already listed to skip a
   * second listing, and `only` to describe one path; worktrees are evaluated
   * and measured side by side, a few at a time.
   */
  public async describeKept(options: Pick<WorktreeRetentionOptions, 'now' | 'retentionMs' | 'owner'> & {
    readonly rows?: readonly WorktreeStatusRecord[] | undefined;
    readonly only?: string | undefined;
  } = {}): Promise<KeptWorktreeInfo[]> {
    const now = (options.now ?? Date.now)();
    const retentionMs = options.retentionMs ?? DEFAULT_WORKTREE_RETENTION_MS;
    const owner = options.owner ?? await this.defaultOwnerResolver();
    const only = options.only !== undefined ? normalizePath(options.only, this.workingDirectory) : undefined;
    const listed = options.rows ?? await this.list();
    const allPaths = listed.map((row) => row.path);
    const rows = listed.filter((row) =>
      row.kind !== 'manual' && isProductWorktreePath(row.path, this.workingDirectory) && (only === undefined || row.path === only));
    const describe = async (row: WorktreeStatusRecord): Promise<KeptWorktreeInfo> => {
      const [evaluation, sizeBytes] = await Promise.all([
        this.evaluateRow(row, owner(row.path), now, retentionMs),
        worktreeSizeBytes(row.path),
      ]);
      const guarded = sweepProtection(row) ?? gitHeldProtection(row.path, allPaths);
      const reason = guarded ?? evaluation.reason;
      return {
        path: row.path,
        branch: row.branch,
        ageMs: Math.max(0, now - evaluation.sinceMs),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        reason,
        willBeRemoved: guarded === null && evaluation.action !== 'keep',
        summary: `age ${formatAge(Math.max(0, now - evaluation.sinceMs))}, ${sizeBytes !== undefined ? formatBytes(sizeBytes) : 'size unknown (it could not be measured)'}: ${reason.detail}`,
        ...(needsOwnerDecision(reason) ? { nextSteps: worktreeNextSteps({ path: row.path, why: reason.why, branch: listedBranch(row.branch), head: row.head || undefined }) } : {}),
      };
    };
    const infos: KeptWorktreeInfo[] = [];
    for (let start = 0; start < rows.length; start += DESCRIBE_CONCURRENCY) {
      infos.push(...await Promise.all(rows.slice(start, start + DESCRIBE_CONCURRENCY).map(describe)));
    }
    return infos;
  }

  /** What the start-up pass of this process found, or null until it has finished. */
  private startupReport: WorktreeStartupReport | null = null;

  /** The report of this process's start-up pass (removed, kept for a decision, failed), or null while it runs or when it did not complete. */
  public lastStartupReport(): WorktreeStartupReport | null {
    return this.startupReport;
  }

  /**
   * The start-up pass every program runs (the daemon and both terminal apps):
   * apply retention to leftovers from earlier runs and report all of it: what
   * was removed, each worktree kept because it needs its owner's decision with
   * the next steps, each removal that did not complete, and a disk-use line
   * when kept worktrees hold a lot. Null only when the pass could not run.
   * Never throws: start-up must not fail on it.
   */
  public async startupSweep(options: { readonly thresholdBytes?: number | undefined; readonly tellOnce?: boolean | undefined } = {}): Promise<WorktreeStartupReport | null> {
    try {
      const sweep = await this.sweepRetention();
      const needing = sweep.kept.filter((entry) => needsOwnerDecision(entry.reason));
      // A terminal app tells the owner about each kept worktree once; /worktree review lists it while it stays.
      const told = options.tellOnce ? this.markTold(needing.map((entry) => entry.path)) : new Set<string>();
      const attention = needing.filter((entry) => !told.has(entry.path)).map((entry) => ({
        path: entry.path,
        branch: entry.branch,
        reason: entry.reason,
        nextSteps: worktreeNextSteps({ path: entry.path, why: entry.reason.why, branch: listedBranch(entry.branch), head: entry.head || undefined }),
      }));
      const report: WorktreeStartupReport = {
        finishedAt: Date.now(),
        removed: sweep.removed,
        attention,
        failed: sweep.failed,
        diskNotice: await this.diskNotice(sweep.kept, options.thresholdBytes ?? DEFAULT_KEPT_WORKTREE_NOTICE_BYTES),
      };
      this.startupReport = report;
      return report;
    } catch (error) {
      logger.warn('worktree retention: the start-up pass did not complete', { error: summarizeError(error) });
      return null;
    }
  }

  /**
   * Records that the owner is being told about these worktrees now, in one
   * register write, and returns the ones they were already told about. A
   * register that cannot be written tells them all again next time.
   */
  private markTold(paths: readonly string[]): Set<string> {
    const already = new Set<string>();
    if (paths.length === 0) return already;
    try {
      const storePath = getStorePath(this.workingDirectory);
      withRegistryWriteLock(storePath, () => {
        const store = readStore(storePath, true, true);
        const now = Date.now();
        let changed = false;
        for (const path of paths) {
          const current = store.records[path];
          if (!current) continue;
          if (current.toldAt !== undefined) { already.add(path); continue; }
          store.records[path] = { ...current, toldAt: now };
          changed = true;
        }
        if (changed) writeStore(store, storePath);
      });
    } catch (error) {
      logger.warn('worktree retention: could not record that kept worktrees were reported; they are reported again at the next start', { error: summarizeError(error) });
    }
    return already;
  }

  /**
   * One line when the worktrees the sweep kept hold more than `thresholdBytes`
   * in total, else null. It names the largest few with their size and why each
   * is kept. Measured from the sweep's own decisions, so nothing is assessed twice.
   */
  private async diskNotice(kept: readonly KeptWorktree[], thresholdBytes: number): Promise<string | null> {
    if (kept.length === 0) return null;
    const sizes: Array<{ readonly entry: KeptWorktree; readonly sizeBytes: number | undefined }> = [];
    for (let start = 0; start < kept.length; start += DESCRIBE_CONCURRENCY) {
      sizes.push(...await Promise.all(kept.slice(start, start + DESCRIBE_CONCURRENCY).map(async (entry) => ({ entry, sizeBytes: await worktreeSizeBytes(entry.path) }))));
    }
    const total = sizes.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
    if (total <= thresholdBytes) return null;
    const largest = [...sizes].sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0)).slice(0, 3)
      .map((item) => `${relative(this.workingDirectory, item.entry.path)} ${item.sizeBytes !== undefined ? formatBytes(item.sizeBytes) : 'size unknown'} (${item.entry.reason.detail})`);
    return `${kept.length} kept worktree(s) under .goodvibes use ${formatBytes(total)}; largest: ${largest.join('; ')}. See them in goodvibes under Code and changes, Worktrees; remove one you no longer need there with "Remove a worktree" (its changes are committed to its branch first).`;
  }

  public attach(path: string, target: { sessionId?: string; taskId?: string }): void {
    const normalized = normalizePath(path, this.workingDirectory);
    // Git is asked only for a path the register does not hold, and before the
    // register lock is taken, so a slow `git` never holds other writers up.
    let gitKnows = false;
    if (!readStore(getStorePath(this.workingDirectory), false).records[normalized]) gitKnows = this.gitListsWorktreeSync(normalized);
    withRegistryWriteLock(getStorePath(this.workingDirectory), () => {
      const store = readStore(getStorePath(this.workingDirectory), true, true);
      const existing = store.records[normalized];
      // A typo must not mint an active record that sessions, sweeps and review would then have to carry.
      if (!existing && !gitKnows) {
        throw new Error(`No worktree exists at ${normalized}, so nothing was attached. List worktrees to see the paths git knows about, then retry with one of those.`);
      }
      refuseWhileRemoving(existing, normalized, 'attached');
      const classified = classifyWorktreePath(normalized, this.workingDirectory);
      store.records[normalized] = {
        path: normalized,
        kind: existing?.kind ?? classified.kind,
        state: existing?.state ?? 'active',
        ...(existing?.ownerId ?? classified.ownerId ? { ownerId: existing?.ownerId ?? classified.ownerId } : {}),
        // Attaching one kind of link keeps the other: a session and a task can both hold the worktree.
        ...(target.sessionId || existing?.sessionId ? { sessionId: target.sessionId || existing?.sessionId } : {}),
        ...(target.taskId || existing?.taskId ? { taskId: target.taskId || existing?.taskId } : {}),
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
        throw new Error(`No worktree exists at ${normalized}; nothing was changed. The Worktrees list in Code and changes shows the worktrees git knows about; choose one of those.`);
      }
      refuseWhileRemoving(existing, normalized, `marked ${state}`);
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
        ...(liveRemoval(existing, Date.now()) ? { removal: existing!.removal } : {}),
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
      case 'unmerged': return `At stake: ${assessment.commits} commit(s) not in ${assessment.base}; they stay on branch ${assessment.branch ?? assessment.heldBy ?? '(detached HEAD, no branch holds them)'}.`;
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
  if (row.state === 'kept') return { why: 'protected', detail: 'marked kept; only "Remove a worktree" removes it' };
  if (row.state === 'paused') return { why: 'protected', detail: 'paused; resume or discard it explicitly' };
  if (row.sessionId || row.taskId) return { why: 'protected', detail: `attached to ${row.sessionId ? `session ${row.sessionId}` : `task ${row.taskId}`}; detach or discard it explicitly` };
  return null;
}

/**
 * Why git's own state keeps a worktree from the sweep, or null: git holds it
 * locked (`git worktree lock`, or an add in progress; git refuses to remove it
 * too), or another worktree lives inside its directory (removing it would
 * delete that one's files), which is decided first.
 */
function gitHeldProtection(path: string, allPaths: readonly string[]): WorktreeKeepReason | null {
  if (isWorktreeLockedByGit(path)) return { why: 'protected', detail: `locked with git worktree lock (or still being created); git worktree unlock ${path} lets the sweep decide again` };
  const inside = allPaths.find((other) => other !== path && other.startsWith(`${path}${sep}`));
  return inside ? { why: 'protected', detail: `another worktree lives inside it (${inside}); that one is decided first` } : null;
}

/** The branch `git worktree list` names, or null for a detached HEAD. */
function listedBranch(branch: string): string | null {
  return branch === '(detached)' || branch.length === 0 ? null : branch;
}

/**
 * The start-up report as text, one item per line, or null when there is
 * nothing to say: what was removed, each worktree kept for its owner's
 * decision with why and the exact next steps, each removal that did not
 * complete, and the disk-use line. Paths are shown relative to `workingDirectory`
 * in the headings and absolute in the commands.
 */
export function formatWorktreeStartupReport(report: WorktreeStartupReport, workingDirectory: string): string | null {
  const show = (path: string): string => {
    const rel = relative(workingDirectory, path);
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path;
  };
  const lines: string[] = [];
  if (report.removed.length > 0) {
    lines.push(`Removed ${report.removed.length} worktree(s) whose work is all on a branch or in the base:`);
    for (const entry of report.removed) lines.push(`  - ${show(entry.path)}: ${entry.note}`);
  }
  if (report.attention.length > 0) {
    lines.push(`Kept ${report.attention.length} worktree(s) that need your decision; nothing in them is removed automatically:`);
    for (const entry of report.attention) {
      const branch = listedBranch(entry.branch);
      lines.push(`  - ${show(entry.path)} (${branch ? `branch ${branch}` : 'detached HEAD'}): ${entry.reason.detail}`);
      for (const step of entry.nextSteps) lines.push(`      ${step}`);
    }
  }
  if (report.failed.length > 0) {
    lines.push(`Could not remove ${report.failed.length} worktree(s); each is still on disk as it was:`);
    for (const entry of report.failed) lines.push(`  - ${show(entry.path)}: ${entry.error}`);
  }
  if (report.diskNotice) lines.push(report.diskNotice);
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * The worktree lines /status shows: the same report the start notice gave,
 * stamped with when the pass finished, or why there is none yet.
 */
export function worktreeStatusLines(report: WorktreeStartupReport | null, workingDirectory: string): string[] {
  if (!report) return ['no start-up report yet: the start-up pass is still running, or it did not complete (see the log)'];
  const text = formatWorktreeStartupReport(report, workingDirectory);
  const at = new Date(report.finishedAt).toLocaleTimeString();
  return text ? [`at start (${at}):`, ...text.split('\n')] : [`at start (${at}): nothing removed, and none needs your decision`];
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
  /** The branch made to hold the commits of a detached HEAD no branch held, when one was made. */
  readonly savedBranch?: string | undefined;
  readonly note: string;
}

export interface KeptWorktree {
  readonly path: string;
  /** As `git worktree list` names it; `(detached)` for a detached HEAD. */
  readonly branch: string;
  /** HEAD as `git worktree list` read it. */
  readonly head?: string | undefined;
  readonly reason: WorktreeKeepReason;
}

/** A worktree the sweep kept because it needs its owner's decision. */
export interface WorktreeAttention {
  readonly path: string;
  readonly branch: string;
  readonly reason: WorktreeKeepReason;
  /** Save it, keep it as it is, or discard it: exact commands. */
  readonly nextSteps: readonly string[];
}

/** Everything the start-up pass did and found; never discarded. */
export interface WorktreeStartupReport {
  readonly finishedAt: number;
  readonly removed: readonly SweptWorktree[];
  readonly attention: readonly WorktreeAttention[];
  readonly failed: ReadonlyArray<{ readonly path: string; readonly error: string }>;
  /** The disk-use line when kept worktrees hold more than the threshold, else null. */
  readonly diskNotice: string | null;
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
  /** For a worktree kept for its owner's decision: save it, keep it as it is, or discard it. */
  readonly nextSteps?: readonly string[] | undefined;
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
