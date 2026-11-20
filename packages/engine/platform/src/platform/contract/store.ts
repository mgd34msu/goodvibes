import { absent, failedRead, present, refusal, type Observed, type Refusal } from '@goodvibes-jev/engine/errors';
import { retainOwnedJson } from '../gate/judgment-input.js';
import { contractCreationPathAbsent, publishInitialContractCheckpoint } from './creation-claim.js';
/**
 * ContractStore: the contract tree in memory and on disk
 * (docs/design/contract-runner.md section 7.1).
 *
 * A checkpoint is a directory, `.goodvibes/contracts/checkpoints-v7/<id>/`: a
 * base written once, a progress log with one line per save holding only what
 * that save changed, and captured inputs set after the base in their own files
 * (checkpoint-progress.ts). A save costs the size of what changed, whatever
 * the contract holds. Version-6 single files in `checkpoints-v6/` are read as
 * before and moved into a directory, unchanged, by one rename on their first
 * save; the original flat directory remains a read fallback for schema1–5 and
 * is never modified. One writer per contract: a save takes a kernel-released
 * lock on the contract, and a process whose copy is older than the disk writes
 * nothing. A native work contract's saves are synced before they return,
 * because its launch claim and semantic decisions must survive a crash. Its
 * admission is not part of the checkpoint: it was written once in its receipt
 * file (durable-admission.ts) and the checkpoint names it by payload revision.
 * The record is validated when it is loaded, not on every save. Unsupported
 * future versions remain where they are and refuse replacement; malformed
 * known versions are quarantined. A last progress line without its newline is
 * a save that never finished: it is ignored, never a reason to quarantine.
 *
 * Ended contracts: when a checkpoint is written with a terminal status, a small
 * summary (id, status, session, dates) is written to `ended/<id>.json`. Start-up
 * and listing read those summaries, not the checkpoints; an ended contract is
 * not held in memory and its full record is loaded on first read and cached up
 * to the retention cap. Ended contracts are kept for TERMINAL_CONTRACT_MAX_AGE_MS
 * and at most MAX_TERMINAL_CONTRACT_FILES, and `remove` deletes one on request.
 * Native work contracts (with a durable admission) belong to their native
 * execution and are neither reaped nor removed here. Quarantine and abandoned
 * temporary files have bounded housekeeping.
 *
 * Modeled on orchestration/persistence.ts.
 */
import { DurableContractAdmissions, isStoredAdmissionReference, parseDurableAdmission, storedAdmissionReference, syncContractDirectory } from './durable-admission.js';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { holdProcessLock, type HeldProcessLock } from '../utils/process-lock.js';
import { openRecordLog, type RecordLog } from '../state/record-log.js';
import {
  assembleCheckpoint, CheckpointFormatError, CHECKPOINT_BASE_FILE, CHECKPOINT_LOG_FILE, ContractProgressTracker, isCheckpointSideFileName,
  readCheckpointLog, storedContractBody, writeCheckpointSideFile, type AssembledCheckpoint, type LogIdentity,
} from './checkpoint-progress.js';
import { createHash } from 'node:crypto';
import type { ContractEvent } from '../../events/contract.js';
import { CONTRACT_STATUSES } from '../../events/contract.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { captureQuarantineSource, QuarantineEncodingError, quarantineCorruptFile, reapOwnedQuarantineDirectories, reapOwnedAtomicTempFile, writeFileAtomic, type QuarantineSource } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import { contractWithStoredReviewObservations, hydrateStoredReviewObservations } from './review-file-observations.js';
import { ownedContractCheckpointText, readOwnedAssembledCheckpoint, readOwnedContractCheckpoint, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';
import { storedCurrentFileLabels, restoreCurrentFileLabels } from './current-file-observations.js';
import { storedTreeBaselineOrigins, hydrateTreeBaselines } from './tree-baseline.js';
import { isContractInputSnapshot } from './input-snapshot.js';
import { validateNativeDecisionState } from './native-decisions.js';
import { bindNativeContractSource } from './native-source.js';
import { CURRENT_CONTRACT_SCHEMA_VERSION, isContractId, isOpaqueContractId, isTerminalContractStatus, type Contract } from './types.js';
import { recoverPendingFixIdentities, recoverRepeatedStructuralCriteria } from './fix-identity.js';
import { removeWorkstreamSnapshots } from '../orchestration/persistence.js';

const DEBOUNCE_MS = 250;
/** Ended contracts kept per project; the oldest beyond this are removed. */
export const MAX_TERMINAL_CONTRACT_FILES = 100;
/** Age past which an ended contract is removed, from its completion (or last write): thirty days. */
export const TERMINAL_CONTRACT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Quarantine files are forensic, so they outlive terminal contracts: a month. */
export const CONTRACT_QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A crash loop can mint one quarantine file per start, so the age bound alone is not a bound. Newest are kept. */
export const MAX_CONTRACT_QUARANTINE_FILES = 20;
/** A temp file older than this is litter from a dead writer, not a write in flight. */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Periodic housekeeping while a writer is attached: reaping must not be startup-only for a long-lived daemon. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const QUARANTINE_SUFFIX = '.unrecognized';
const JSON_SUFFIX = '.json';
const TEMP_MARKER = '.json.tmp-';

/** The on-disk envelope. */
export interface ContractSnapshot {
  readonly schemaVersion: number;
  readonly writtenAt: number;
  readonly contract: Contract;
}

/** A newer checkpoint remains at its original path and must never look absent. */
export class ContractStoreVersionError extends Error {
  override readonly name = 'ContractStoreVersionError';
  constructor(readonly contractId: string) {
    super(`Contract ${contractId} uses a newer checkpoint format. Run a compatible GoodVibes build before loading or replacing it.`);
  }
}

/**
 * A contract's saved checkpoint as one version-6 envelope text (in the
 * directory format, the base with its progress applied), or null when none is
 * saved. For export and inspection: it carries no native provenance.
 */
export function storedCheckpointText(projectRoot: string, contractId: string): string | null {
  const dir = contractCheckpointDir(projectRoot, contractId), base = join(dir, CHECKPOINT_BASE_FILE);
  for (const path of [base, contractPath(projectRoot, contractId), historicalContractPath(projectRoot, contractId)]) {
    let text: string;
    try { text = readFileSync(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    return path === base ? assembleCheckpoint(dir, text, readCheckpointLog(dir)?.bytes ?? null).text : text;
  }
  return null;
}

/** Original contract authority root. Durable admission keys and leases never move. */
export function contractsDir(projectRoot: string): string {
  return join(projectRoot, '.goodvibes', 'contracts');
}

/** Where the summary of each ended contract lives: one small file per contract. */
export function contractEndedDir(projectRoot: string): string {
  return join(contractsDir(projectRoot), 'ended');
}

/** Where the run claim for one contract lives (contract/lease.ts). Outside the checkpoint files, so no contract listing sees it. */
export function contractLeasePath(projectRoot: string, contractId: string): string {
  return join(contractsDir(projectRoot), '.leases', `${contractId}.writer.sqlite`);
}

/** What listing and start-up need of an ended contract, without its checkpoint. */
export interface EndedContractSummary {
  readonly version: 1;
  readonly id: string;
  readonly status: Contract['status'];
  readonly sessionId: string;
  /** The contract's owning principal, so the operator surface filters a listing without reading the checkpoint. */
  readonly ownerPrincipalId?: string | undefined;
  readonly createdAt: number;
  readonly completedAt?: number | undefined;
  readonly failureKind?: Contract['failureKind'] | undefined;
  /** A native work contract: kept for its native execution, never reaped or removed here. */
  readonly durable: boolean;
}

/** Why `remove` did not remove a contract. */
export type ContractRemoval = 'removed' | 'not-found' | 'not-ended' | 'native';

function isEndedSummary(value: unknown, id: string): value is EndedContractSummary {
  if (!isRecord(value)) return false;
  return value['version'] === 1 && value['id'] === id && typeof value['status'] === 'string' && isTerminalContractStatus(value['status'] as Contract['status'])
    && typeof value['sessionId'] === 'string' && typeof value['createdAt'] === 'number' && typeof value['durable'] === 'boolean'
    && (value['completedAt'] === undefined || typeof value['completedAt'] === 'number')
    && (value['ownerPrincipalId'] === undefined || typeof value['ownerPrincipalId'] === 'string');
}

/** Where contracts.start records a caller's retry key, one small file per (principal, key). */
export function contractIdempotencyDir(projectRoot: string): string {
  return join(contractsDir(projectRoot), 'idempotency');
}

/** What a retry key started: the contract, and the canonical request it was sent with. */
export interface IdempotentStartRecord {
  readonly contractId: string;
  /** Canonical form of the start request (sorted keys), so a retry with its fields in another order matches. */
  readonly fingerprint: string;
}

/** The file name for a retry scope: a digest, so a caller's key never becomes a path. */
export function idempotencyFileId(scope: string): string {
  return `idem-${createHash('sha256').update(scope).digest('hex')}`;
}

/**
 * The kernel-released lock a start holds on its retry key, from reading the key's record until the started
 * contract's first checkpoint is published: a second process with the same key waits and then finds that contract.
 * Keys share 256 lock files by the first byte of their digest, so the lock files stay bounded (a lock file is never
 * removed); two different keys wait on each other only when they share that byte.
 */
export function contractIdempotencyLockPath(projectRoot: string, scope: string): string {
  return join(contractsDir(projectRoot), '.leases', `${idempotencyFileId(scope).slice(0, 'idem-'.length + 2)}.start.sqlite`);
}

/** The current writer namespace, isolated from schema1–5 readers' flat scans. */
export function contractCheckpointsDir(projectRoot: string): string {
  return join(contractsDir(projectRoot), 'checkpoints-v6');
}

/** Where this build keeps checkpoints: one directory per contract. Builds that read only single files never look here. */
export function contractProgressDir(projectRoot: string): string {
  return join(contractsDir(projectRoot), 'checkpoints-v7');
}

/** A contract's checkpoint directory (base, progress log, captured inputs). Accepts only a contract id. */
export function contractCheckpointDir(projectRoot: string, contractId: string): string {
  if (!isContractId(contractId)) throw new Error(`Not a contract id: ${JSON.stringify(contractId)}`);
  return join(contractProgressDir(projectRoot), contractId);
}

/** The kernel-released lock a store holds while it writes a contract's checkpoint, so two writers never append to one log. */
export function contractProgressLockPath(projectRoot: string, contractId: string): string {
  return join(contractsDir(projectRoot), '.leases', `${contractId}.progress.sqlite`);
}

/** Another writer holds this contract's checkpoint. */
export class ContractWriterBusyError extends Error {
  override readonly name = 'ContractWriterBusyError';
  constructor(readonly contractId: string) {
    super(`Contract ${contractId} is being saved by another GoodVibes process (or another contract store in this one); this one wrote nothing, so that writer's checkpoint stands. Let that process finish the contract, or stop it and resume the contract here.`);
  }
}

/** The checkpoint changed on disk after this process read it, in parts this process also changed (or it is gone). */
export class ContractCheckpointStaleError extends Error {
  override readonly name = 'ContractCheckpointStaleError';
  constructor(readonly contractId: string) {
    super(`Contract ${contractId} was saved by another process after this one read it, changing what this one changed too; this one wrote nothing and writes nothing more, so that save stands. Restart this process to read the contract again before continuing it here.`);
  }
}

/** The version-6 single-file checkpoint path: read, and moved into the contract's directory on its first save. Accepts only an actual current or historical contract ID, so no id can name a path outside the directory. */
export function contractPath(projectRoot: string, contractId: string): string {
  if (!isContractId(contractId)) throw new Error(`Not a contract id: ${JSON.stringify(contractId)}`);
  return join(contractCheckpointsDir(projectRoot), `${contractId}${JSON_SUFFIX}`);
}

/** Compatibility lookup only. New writers never modify these checkpoints. */
function historicalContractPath(projectRoot: string, contractId: string): string {
  if (!isContractId(contractId)) throw new Error(`Not a contract id: ${JSON.stringify(contractId)}`);
  return join(contractsDir(projectRoot), `${contractId}${JSON_SUFFIX}`);
}

/**
 * The envelope as JSON; null when the contract cannot be serialized. A native
 * contract's admission is stored as a reference to its receipt file.
 */
export function serializeContract(contract: Contract, writtenAt: number): string | null {
  try {
    const labels = storedCurrentFileLabels(contract);
    const stored = contractWithStoredReviewObservations(contract);
    const body = stored.durableAdmission === undefined ? stored : { ...stored, durableAdmission: storedAdmissionReference(stored.durableAdmission) };
    const snapshot = { schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION, writtenAt, contract: body,
      ...(labels === undefined ? {} : { nativeFileLabels: labels }), treeBaselineOrigins: storedTreeBaselineOrigins(contract) };
    return JSON.stringify(snapshot);
  } catch (error) {
    logger.error('contract store: JSON serialization failed', { contractId: contract.id, error: summarizeError(error) });
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The fields a resume or a view reads without checking; anything else is optional or checked where used. */
function isContractShape(value: unknown): value is Contract {
  if (!isRecord(value)) return false;
  if (value['durableAdmission'] !== undefined) {
    try {
      const stored = value['durableAdmission'];
      // A reference is resolved from the receipt file of this contract id, which must carry the same payload.
      const admission = isStoredAdmissionReference(stored)
        ? new DurableContractAdmissions(String(value['projectRoot'])).findByContractId(String(value['id']))
        : parseDurableAdmission(stored);
      if (admission === null || (isStoredAdmissionReference(stored) && admission.payloadRevision !== stored.payloadRevision)) return false;
      if (admission.contractId !== value['id'] || admission.ownerAgentId !== value['ownerAgentId']
        || (value['durableLaunchState'] !== 'prepared' && value['durableLaunchState'] !== 'launch-claimed')) return false;
      value['durableAdmission'] = admission;
    } catch { return false; }
  }
  return isContractId(value['id'])
    && (value['isolation'] === 'worktree' || value['isolation'] === 'shared')
    && typeof value['status'] === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(value['status'])
    && typeof value['sessionId'] === 'string'
    && (value['ownerPrincipalId'] === undefined || typeof value['ownerPrincipalId'] === 'string')
    && typeof value['ownerAgentId'] === 'string'
    && typeof value['ask'] === 'string'
    && typeof value['projectRoot'] === 'string'
    && (value['inputSnapshot'] === undefined || isContractInputSnapshot(value['inputSnapshot']))
    && typeof value['createdAt'] === 'number'
    && Array.isArray(value['criteria'])
    && Array.isArray(value['groups'])
    && Array.isArray(value['units'])
    && Array.isArray(value['checks'])
    && Array.isArray(value['escalations'])
    && Array.isArray(value['decisions']);
}

/** Why a snapshot was not accepted; null when it was. */
/** A contract whose admission record could not be read: not evidence that its checkpoint is safe to use. */
function unreadableAdmission(contractId: string, error: unknown): Refusal {
  return refusal({
    code: 'CONTRACT_CHECKPOINT_REFUSED',
    state: `the admission record of contract ${contractId} could not be read`,
    reason: `Contract ${contractId}'s admission record could not be read (${summarizeError(error)}), so its checkpoint is not used.`,
    next: ['Inspect the contract admissions under .goodvibes, then resume again.', `Or cancel the contract: goodvibes-contract cancel ${contractId}.`],
    retryable: false,
  });
}

export type ContractSnapshotRejection = 'unparseable' | 'not-an-envelope' | 'future-version' | 'invalid-contract';

/**
 * Parses an envelope. A snapshot written by a newer schema is refused, never
 * partially trusted; so is one whose contract fails the shape check.
 */
function parseContractSnapshot(json: string, receipt?: OwnedContractCheckpointRead, maximumVersion = CURRENT_CONTRACT_SCHEMA_VERSION): { readonly snapshot: ContractSnapshot } | { readonly rejected: ContractSnapshotRejection } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { rejected: 'unparseable' };
  }
  if (!isRecord(raw) || typeof raw['schemaVersion'] !== 'number' || !Number.isFinite(raw['schemaVersion'])) {
    return { rejected: 'not-an-envelope' };
  }
  if (raw['schemaVersion'] > maximumVersion) return { rejected: 'future-version' };
  if (!isContractShape(raw['contract'])) return { rejected: 'invalid-contract' };
  if (raw['contract'].nativeDecisions !== undefined && raw['schemaVersion'] < 4) return { rejected: 'invalid-contract' };
  if (raw['contract'].nativeSource !== undefined && raw['schemaVersion'] < 3) return { rejected: 'invalid-contract' };
  try { bindNativeContractSource(raw['contract']); validateNativeDecisionState(raw['contract']); recoverRepeatedStructuralCriteria(raw['contract']); recoverPendingFixIdentities(raw['contract']); } catch { return { rejected: 'invalid-contract' }; }
  if (raw['contract'].durableAdmission !== undefined && raw['schemaVersion'] < 2) return { rejected: 'invalid-contract' };
  try {
    hydrateStoredReviewObservations(raw['contract'], raw['schemaVersion'], json, receipt);
    hydrateTreeBaselines(raw['contract'], json, receipt);
    if (receipt !== undefined && raw['schemaVersion'] >= 6) restoreCurrentFileLabels(raw['contract'], receipt);
  }
  catch { return { rejected: 'invalid-contract' }; }
  const writtenAt = typeof raw['writtenAt'] === 'number' && Number.isFinite(raw['writtenAt']) ? raw['writtenAt'] : 0;
  return { snapshot: { schemaVersion: raw['schemaVersion'], writtenAt, contract: raw['contract'] } };
}

/** Public parsing retains metadata without creating native review provenance. */
export function readContractSnapshot(json: string): { readonly snapshot: ContractSnapshot } | { readonly rejected: ContractSnapshotRejection } {
  return parseContractSnapshot(json);
}

/** Internal restore seam: the receipt can only come from actual native file I/O. */
export function deserializeOwnedContractCheckpoint(receipt: OwnedContractCheckpointRead): Contract | null {
  const read = parseContractSnapshot(ownedContractCheckpointText(receipt), receipt);
  return 'snapshot' in read ? read.snapshot.contract : null;
}

/** The contract in an envelope, or null when the envelope is refused. */
export function deserializeContract(json: string): Contract | null {
  const read = readContractSnapshot(json);
  if ('rejected' in read) {
    logger.warn('contract store: snapshot refused', { reason: read.rejected });
    return null;
  }
  return read.snapshot.contract;
}

/** What one housekeeping pass reclaimed. Counts and bytes only; contract contents are never logged. */
export interface ContractReapSummary {
  readonly terminalExpired: number;
  readonly terminalOverCap: number;
  readonly quarantineExpired: number;
  readonly quarantineOverCap: number;
  readonly staleTempRemoved: number;
  /** Retry-key records (contracts.start Idempotency-Key) whose contract no longer exists. */
  readonly retryKeysRemoved: number;
  readonly bytesReclaimed: number;
  readonly total: number;
  /** Ids of the terminal contracts whose files were removed. */
  readonly reapedIds: readonly string[];
}

export interface ContractStoreOptions {
  readonly projectRoot: string;
  /** Actual installed native owner; declare its reader floor before writes. */
  readonly beforeWrite?: ((contract?: Contract) => void) | undefined;
  /** Original native constructor declares new ID readers before creation effects. */
  readonly beforeCreate?: ((contractId: string) => void) | undefined;
  /** Clock seam for tests. */
  readonly now?: (() => number) | undefined;
  /** Debounce for event-triggered writes; defaults to 250 ms. */
  readonly debounceMs?: number | undefined;
  /** Housekeeping interval while attached; 0 turns the timer off. Defaults to an hour. */
  readonly sweepIntervalMs?: number | undefined;
  /**
   * Called when a checkpoint write fails, with the contract and a plain
   * statement of why. The write has no caller to throw to when it runs from the
   * debounce timer or a flush, so this is where a failure becomes visible.
   */
  readonly onWriteFailure?: ((contractId: string, failure: ContractWriteFailure) => void) | undefined;
}

/** The last checkpoint write that failed for a contract, until a write succeeds. */
export interface ContractWriteFailure {
  readonly at: number;
  readonly message: string;
  /** The file was written by a newer build; writes stop until that file changes. */
  readonly newerFormat: boolean;
}

export interface ContractCreationReservation {
  readonly id: string;
  assertCurrent(): void;
  owns(contract: Contract): boolean;
  release(): void;
}
interface CreationState {
  readonly reservation: ContractCreationReservation;
  contract?: Contract;
  candidate?: Contract;
}

interface DatedFile {
  readonly path: string;
  readonly at: number;
  readonly id?: string | undefined;
}

/** Removes a file, treating a file already gone as success. Returns the bytes freed. */
function removeFile(path: string): number {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return 0;
  }
  try {
    unlinkSync(path);
    return size;
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      logger.warn('contract store: failed to remove a file during housekeeping', { path, error: summarizeError(error) });
    }
    return 0;
  }
}

/** A checkpoint directory holding anything (a base, a log, a quarantined base) names a contract; an empty one left by a failed first save does not. */
function checkpointDirectoryOccupied(dir: string): boolean {
  try { return readdirSync(dir).length > 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Removes a directory and everything in it. Returns the bytes freed. */
function removeDirectory(path: string): number {
  let size = 0;
  try { for (const name of readdirSync(path)) { try { size += statSync(join(path, name)).size; } catch { /* already gone */ } } }
  catch { return 0; }
  try { rmSync(path, { recursive: true, force: true }); return size; }
  catch (error) {
    logger.warn('contract store: failed to remove a directory during housekeeping', { path, error: summarizeError(error) });
    return 0;
  }
}

function logIdentityOf(path: string): LogIdentity | null {
  try { const stat = statSync(path); return { ino: stat.ino, size: stat.size }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

function sameLogIdentity(left: LogIdentity | null, right: LogIdentity | null): boolean {
  return left === null || right === null ? left === right : left.ino === right.ino && left.size === right.size;
}

/** This store's hold on one contract's checkpoint: the lock, and the log once a save appended to it. */
interface ProgressWriter {
  readonly dir: string;
  /** Null only where the filesystem has no file locks. */
  readonly lock: HeldProcessLock | null;
  log: RecordLog<string> | null;
  /** Dead writers' temp files and unused captured inputs were removed under this lock. */
  cleared: boolean;
}

type ProgressPath = readonly (string | number)[];

/** The paths a save from `base` to `contract` would write, or null when they cannot be read. Writes nothing. */
function changedPaths(base: ContractProgressTracker, contract: Contract): ProgressPath[] | null {
  const change = base.diff(contract, 0, () => 'unwritten');
  if (change.line === null) return [];
  try {
    const ops = (JSON.parse(change.line) as { readonly ops?: readonly { readonly p?: unknown }[] }).ops ?? [];
    const paths: ProgressPath[] = [];
    for (const op of ops) {
      if (!Array.isArray(op.p) || !op.p.every(key => typeof key === 'string' || typeof key === 'number')) return null;
      paths.push(op.p as ProgressPath);
    }
    return paths;
  } catch { return null; }
}

function valueAt(root: unknown, path: ProgressPath): unknown {
  let node = root;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string | number, unknown>)[key];
  }
  return node;
}

/** One path is the other or contains it. */
function overlaps(left: ProgressPath, right: ProgressPath): boolean {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return false;
  return true;
}

/** Keeps the newest `cap` files; returns the rest, oldest first. */
function overCap(files: readonly DatedFile[], cap: number): DatedFile[] {
  if (files.length <= cap) return [];
  return [...files].sort((a, b) => a.at - b.at).slice(0, files.length - cap);
}

export class ContractStore {
  readonly projectRoot: string;
  private readonly contracts = new Map<string, Contract>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** One parsed version per actual physical path image, never checkpoint text. */
  private readonly supportedStoredVersions = new Map<string, string>();
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly beforeWrite: ((contract?: Contract) => void) | undefined;
  private readonly beforeCreate: ((contractId: string) => void) | undefined;
  private readonly creations = new Map<string, CreationState>();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Summaries of ended contracts read so far, by id; checked against the directory on each listing. */
  private readonly endedSummaries = new Map<string, EndedContractSummary>();
  /** Checkpoints without a summary that housekeeping read as not ended, by path, with the file identity it read. */
  private readonly notEnded = new Map<string, string>();
  /** Full records of ended contracts read on demand, newest use last; at most MAX_TERMINAL_CONTRACT_FILES. */
  private readonly endedRecords = new Map<string, Contract>();
  private readonly writeFailures = new Map<string, ContractWriteFailure>();
  private readonly onWriteFailure: ContractStoreOptions['onWriteFailure'];
  /** What this store last wrote of each contract it saves: a save writes the difference. */
  private readonly trackers = new Map<string, ContractProgressTracker>();
  /** What each loaded record was on disk when it was read, until that record is saved. */
  private readonly loadedTrackers = new WeakMap<Contract, ContractProgressTracker>();
  /** Live copies this store has read or written: one of these is never compared with a disk image it was not derived from. */
  private readonly trackedCopies = new WeakSet<Contract>();
  /** Copies refused because another writer changed the same parts of their checkpoint; they are never written. */
  private readonly staleCopies = new WeakSet<Contract>();
  private readonly writers = new Map<string, ProgressWriter>();
  /** After disposal a save releases its contract's lock at once, so a rebuilt store can take it. */
  private disposed = false;
  private warnedUnlocked = false;

  constructor(options: ContractStoreOptions) {
    this.onWriteFailure = options.onWriteFailure;
    this.projectRoot = options.projectRoot;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.beforeWrite = options.beforeWrite?.bind(options);
    this.beforeCreate = options.beforeCreate?.bind(options);
  }

  /** The live contract, which the runner mutates in place; for an ended contract, its record (read from disk on first use). */
  get(contractId: string): Contract | null {
    const live = this.contracts.get(contractId);
    if (live !== undefined) return live;
    if (!this.endedRecords.has(contractId) && !this.endedSummaries.has(contractId)) return null;
    return this.ended(contractId);
  }

  /** The failure of this contract's most recent checkpoint write, or null when it last succeeded (or never failed). */
  writeFailure(contractId: string): ContractWriteFailure | null {
    return this.writeFailures.get(contractId) ?? null;
  }

  list(): Contract[] {
    return [...this.contracts.values()];
  }

  /** Also used by the runner's first atomic durable-admission checkpoint. */
  prepareCheckpointWrite(contract?: Contract): void {
    const creation = contract ? this.creations.get(contract.id) : undefined;
    if (creation && creation.candidate !== contract) throw new Error('Contract creation belongs to another original');
    assertSynchronousJudgmentGuard(() => this.beforeWrite?.(contract), () => new Error('Contract checkpoint publication requires a synchronous native owner'));
  }

  /**
   * Holds an unused identity in this store before placement awaits or owner
   * spawn hooks. A new id is a fresh 128-bit random number, so no other
   * process can be creating it: the hold is in memory, and whether the name
   * is free on disk is read once here (the checkpoint, an older-layout copy, a
   * quarantine leaf, the admission index). The exclusive link at publication
   * is what keeps an existing checkpoint from ever being replaced.
   */
  reserveCreation(id: string): ContractCreationReservation {
    if (!isContractId(id) || this.creations.has(id) || this.contracts.has(id)) throw new Error('Contract identity is already held');
    assertSynchronousJudgmentGuard(() => this.beforeCreate?.(id), () => new Error('Contract creation requires a synchronous native owner'));
    // Only actual earlier8hex producers could leave unindexed receipts; a caller-named older id is looked up.
    if (!isOpaqueContractId(id) && new DurableContractAdmissions(this.projectRoot).findByContractId(id) !== null) throw new Error('Contract identity is already admitted');
    const occupied = [contractPath(this.projectRoot, id), historicalContractPath(this.projectRoot, id)].some(path => !contractCreationPathAbsent(path) || !contractCreationPathAbsent(path + QUARANTINE_SUFFIX))
      || checkpointDirectoryOccupied(contractCheckpointDir(this.projectRoot, id))
      || !contractCreationPathAbsent(join(contractsDir(this.projectRoot), 'admissions', '.by-contract', `${id}.json`));
    if (occupied) throw new Error('Contract identity became occupied');
    const reservation: ContractCreationReservation = Object.freeze({ id,
      // In memory only: this store still holds the reservation and, once published, the same contract.
      assertCurrent: () => {
        const state = this.creations.get(id);
        if (!state || state.reservation !== reservation) throw new Error('Contract creation reservation has retired');
        if (state.contract && this.contracts.get(id) !== state.contract) throw new Error('Original contract creation owner changed');
      },
      owns: (contract: Contract) => state.contract === contract,
      release: () => {
        if (this.creations.get(id) === state) this.creations.delete(id);
      },
    });
    const state: CreationState = { reservation };
    this.creations.set(id, state);
    return reservation;
  }

  /** First complete checkpoint is exclusive and durable before run registration.
   * Replays/updates keep their separate existing immutable admission boundary. */
  publishCreation(reservation: ContractCreationReservation, contract: Contract): void {
    const state = this.creations.get(contract.id);
    if (!state || state.reservation !== reservation || reservation.id !== contract.id || state.contract) throw new Error('Original contract creation reservation is unavailable');
    reservation.assertCurrent(); state.candidate = contract;
    const original = retainOwnedJson(contract);
    const text = serializeContract(contract, this.now()); if (text === null) throw new Error('Initial contract checkpoint could not be serialized');
    original.assertCurrent(); this.prepareCheckpointWrite(contract); original.assertCurrent(); reservation.assertCurrent();
    // A caller-named admission key keeps its own exclusive index link.
    if (contract.durableAdmission) new DurableContractAdmissions(this.projectRoot).write(contract.durableAdmission, text);
    const dir = contractCheckpointDir(this.projectRoot, contract.id);
    publishInitialContractCheckpoint(dir, basename(CHECKPOINT_BASE_FILE, JSON_SUFFIX), text, reservation.assertCurrent);
    original.assertCurrent();
    this.trackers.set(contract.id, ContractProgressTracker.of(contract, 'progress'));
    this.trackedCopies.add(contract);
    this.noteSupportedVersion(join(dir, CHECKPOINT_BASE_FILE));
    state.contract = contract; this.contracts.set(contract.id, contract);
  }

  /** The base just written or moved by this store is the current schema: its version is not read back. */
  private noteSupportedVersion(path: string): void {
    try { this.supportedStoredVersions.set(path, fileObservationIdentity(path)); } catch { /* the next version check reads it */ }
  }

  /** The contract a retry key already started, or undefined. One file read; it survives a restart. */
  readIdempotentStart(scope: string): IdempotentStartRecord | undefined {
    const path = join(contractIdempotencyDir(this.projectRoot), `${idempotencyFileId(scope)}.json`);
    let text: string;
    try { text = readFileSync(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const parsed = JSON.parse(text) as Partial<IdempotentStartRecord>;
    if (typeof parsed.contractId !== 'string' || typeof parsed.fingerprint !== 'string') throw new Error(`The retry-key record ${path} is not readable; remove it to start a new contract with that key.`);
    return { contractId: parsed.contractId, fingerprint: parsed.fingerprint };
  }

  /** Records what a retry key started; the name is published exclusively, so the first record stands. */
  recordIdempotentStart(scope: string, record: IdempotentStartRecord): void {
    publishInitialContractCheckpoint(contractIdempotencyDir(this.projectRoot), idempotencyFileId(scope), JSON.stringify(record), () => {});
  }

  /**
   * Removes retry-key records whose contract is gone (ended and reaped, or
   * removed), so the directory is bounded like the contracts it points to. A
   * record younger than an hour is kept: it is written before its contract's
   * first checkpoint is published. One listing and one small read per record.
   */
  private reapRetryKeys(now: number): { readonly removed: number; readonly bytes: number } {
    const dir = contractIdempotencyDir(this.projectRoot);
    let names: string[];
    try { names = readdirSync(dir); } catch { return { removed: 0, bytes: 0 }; }
    let removed = 0, bytes = 0;
    for (const name of names) {
      if (!name.startsWith('idem-') || !name.endsWith(JSON_SUFFIX)) continue;
      const path = join(dir, name);
      let contractId: unknown;
      // An unreadable record is left: readIdempotentStart names it to the caller that uses its key.
      try { contractId = (JSON.parse(readFileSync(path, 'utf8')) as { readonly contractId?: unknown }).contractId; } catch { continue; }
      if (typeof contractId !== 'string' || !isContractId(contractId)) continue;
      if (this.contracts.has(contractId) || this.endedSummary(contractId) !== undefined || existsSync(contractCheckpointDir(this.projectRoot, contractId))
        || existsSync(contractPath(this.projectRoot, contractId)) || existsSync(historicalContractPath(this.projectRoot, contractId))) continue;
      try { if (now - statSync(path).mtimeMs < STALE_TEMP_MAX_AGE_MS) continue; } catch { continue; }
      bytes += removeFile(path);
      removed += 1;
    }
    return { removed, bytes };
  }

  /** Drops a retry-key record whose contract no longer exists, so the key can start a new one. */
  forgetIdempotentStart(scope: string): void {
    try { unlinkSync(join(contractIdempotencyDir(this.projectRoot), `${idempotencyFileId(scope)}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  /** Holds a contract in memory and schedules its write. */
  put(contract: Contract): void {
    this.assertStoredVersion(contract.id);
    this.endedRecords.delete(contract.id);
    // The newer-format file is gone or replaced: writing may resume.
    if (this.writeFailures.get(contract.id)?.newerFormat) this.writeFailures.delete(contract.id);
    this.contracts.set(contract.id, contract);
    this.scheduleWrite(contract.id);
  }

  /** Holds a contract read from its own file in memory, without writing it back (resume, design 7.2). */
  hold(contract: Contract): void {
    this.assertStoredVersion(contract.id);
    this.endedRecords.delete(contract.id);
    this.contracts.set(contract.id, contract);
  }

  /** The envelope for a held contract, for export; null when it is not held. */
  serialize(contractId: string): string | null {
    const contract = this.contracts.get(contractId);
    return contract ? serializeContract(contract, this.now()) : null;
  }

  /**
   * Saves a held contract now: appends what changed since the last save (one
   * write, synced before returning for a native contract). Returns false when
   * it is not held or the save failed; a failed save leaves the checkpoint as
   * it was, and the next save writes the whole difference again.
   */
  write(contractId: string): boolean {
    this.cancelPendingWrite(contractId);
    const contract = this.contracts.get(contractId);
    if (!contract) return false;
    const path = contractCheckpointDir(this.projectRoot, contract.id);
    try {
      // While this store holds the contract's lock and its directory, nothing else can replace what is there.
      if (!this.writers.has(contract.id) || this.trackers.get(contract.id)?.layout !== 'progress') this.assertStoredVersion(contract.id);
      this.prepareCheckpointWrite(contract);
      this.save(contract);
      this.writeFailures.delete(contract.id);
      this.recordEnded(contract);
      return true;
    } catch (error) {
      if (error instanceof ContractWriterBusyError || error instanceof ContractCheckpointStaleError) this.releaseWriter(contract.id);
      logger.error('contract store: write failed', { path, error: summarizeError(error) });
      const failure: ContractWriteFailure = {
        at: this.now(),
        message: error instanceof ContractStoreVersionError ? error.message : `The checkpoint could not be written: ${summarizeError(error)}`,
        newerFormat: error instanceof ContractStoreVersionError,
      };
      this.writeFailures.set(contract.id, failure);
      try { this.onWriteFailure?.(contract.id, failure); }
      catch (callbackError) { logger.warn('contract store: write-failure listener threw', { error: summarizeError(callbackError) }); }
      return false;
    } finally {
      if (this.disposed) this.releaseWriter(contractId);
    }
  }

  /** One save: a new base when there is none in the directory format, the move of a version-6 file, then the difference. */
  private save(contract: Contract): void {
    const id = contract.id;
    const writer = this.acquireWriter(id);
    let tracker = this.currentTracker(contract);
    if (tracker.layout === 'none' || tracker.layout === 'historical'
      || (tracker.layout === 'single-file' && tracker.sourceSchemaVersion !== CURRENT_CONTRACT_SCHEMA_VERSION)) {
      this.publishBase(writer, contract, tracker.layout === 'single-file');
      return;
    }
    if (tracker.layout === 'single-file') tracker = this.moveSingleFile(id, writer.dir, tracker);
    // Once per hold, before this save can write a temp file of its own: a dead writer's temp files go.
    // Side files are not touched here: older log lines may still name them (see compact).
    if (!writer.cleared) { this.clearDirectory(writer.dir, tracker, false); writer.cleared = true; }
    const durable = contract.durableAdmission !== undefined;
    const at = this.now();
    const change = tracker.diff(contract, at, (field, text) => writeCheckpointSideFile(writer.dir, field, text));
    const bytes = change.line === null ? 0 : Buffer.byteLength(change.line) + 1;
    if (tracker.shouldCompact(bytes)) {
      this.compact(writer, contract, tracker, change, at, durable);
      return;
    }
    // Nothing changed: nothing is written. The state is still kept, so a copy with the same content is compared by reference next time.
    if (change.line !== null) this.openLog(writer, durable).append(change.line);
    tracker.commitAppend(change, bytes);
  }

  /** This store's lock on the contract's checkpoint, taken on its first save. */
  private acquireWriter(id: string): ProgressWriter {
    const held = this.writers.get(id);
    if (held !== undefined) return held;
    let lock: HeldProcessLock | null = null;
    try {
      lock = holdProcessLock(contractProgressLockPath(this.projectRoot, id));
      if (lock === null) throw new ContractWriterBusyError(id);
    } catch (error) {
      if (error instanceof ContractWriterBusyError) throw error;
      // As with the run claim: a lock that cannot be taken at all (no file locks
      // on this filesystem) must not stop saving; it only cannot exclude a second writer.
      if (!this.warnedUnlocked) logger.warn('contract store: the checkpoint lock could not be taken; saving without it', { error: summarizeError(error) });
      this.warnedUnlocked = true;
    }
    const writer: ProgressWriter = { dir: contractCheckpointDir(this.projectRoot, id), lock, log: null, cleared: false };
    this.writers.set(id, writer);
    return writer;
  }

  /** Gives up the contract's lock and closes its log (syncing what it appended). */
  private releaseWriter(id: string): void {
    const writer = this.writers.get(id);
    if (writer === undefined) return;
    this.writers.delete(id);
    try {
      if (writer.log !== null) {
        writer.log.close();
        const tracker = this.trackers.get(id);
        if (tracker !== undefined) tracker.log = logIdentityOf(join(writer.dir, CHECKPOINT_LOG_FILE));
      }
    } catch (error) {
      logger.warn('contract store: closing a contract progress log failed', { contractId: id, error: summarizeError(error) });
      // The log's identity is unknown now: the next save reads the disk again and takes in what differs (rebaseOnDisk).
      const tracker = this.trackers.get(id);
      if (tracker !== undefined) tracker.log = null;
    } finally {
      writer.lock?.release();
    }
  }

  /**
   * What this store last wrote or read of the contract, checked against the
   * disk under the lock. A copy older than the disk is never written over it.
   */
  private currentTracker(contract: Contract): ContractProgressTracker {
    const id = contract.id;
    // A copy refused once stays refused: it is never diffed against a disk image it was not read from.
    if (this.staleCopies.has(contract)) throw new ContractCheckpointStaleError(id);
    const known = this.trackers.get(id), loaded = this.loadedTrackers.get(contract);
    for (const tracker of [known, loaded]) {
      if (tracker !== undefined && this.matchesDisk(id, tracker)) {
        this.trackers.set(id, tracker);
        return tracker;
      }
    }
    const base = known ?? loaded;
    if (base !== undefined || this.trackedCopies.has(contract)) {
      this.trackers.delete(id);
      // Another writer saved after this store's last read or write. Its changes are taken into this copy once,
      // when they touch nothing this copy changed; otherwise this copy is refused for good. A newer build's save
      // is reported as such (and not retried on every event).
      const rebased = base === undefined ? null : this.rebaseOnDisk(contract, base);
      if (rebased !== null) {
        this.trackers.set(id, rebased);
        return rebased;
      }
      this.staleCopies.add(contract);
      throw new ContractCheckpointStaleError(id);
    }
    // Not read or written by this store yet: what is on disk now, read under the lock.
    // A refused checkpoint was quarantined by the read, so nothing is at the path: the first save writes it new.
    const stored = this.loadAvailable(id);
    const tracker = stored.kind !== 'present' ? ContractProgressTracker.of(contract, 'none') : this.loadedTrackers.get(stored.value);
    if (tracker === undefined) throw new Error('The stored checkpoint could not be read back for comparison');
    this.trackers.set(id, tracker);
    this.trackedCopies.add(contract);
    return tracker;
  }

  /**
   * The checkpoint on disk moved past `base` (what this store last read or wrote). Reads it again and takes the
   * other writer's changes into `contract` in place, so the next save appends only this copy's own changes on top
   * of the newer image. Returns the newer image's tracker, or null when the two writers changed the same thing,
   * the other writer replaced something this copy holds as an object, moved a status the runner drives, or the
   * contract is gone: then this copy must not be written at all. Runs only on that conflict path; one read.
   */
  private rebaseOnDisk(contract: Contract, base: ContractProgressTracker): ContractProgressTracker | null {
    let fresh: Contract;
    try {
      const read = this.loadAvailable(contract.id);
      if (read.kind !== 'present') return null;
      fresh = read.value;
    } catch (error) { if (error instanceof ContractStoreVersionError) throw error; return null; }
    const freshTracker = this.loadedTrackers.get(fresh);
    if (freshTracker === undefined || freshTracker.layout !== 'progress') return null;
    const ours = changedPaths(base, contract), theirs = changedPaths(base, fresh);
    if (ours === null || theirs === null) return null;
    const live = contract as unknown as Record<string, unknown>, disk = fresh as unknown as Record<string, unknown>;
    const absorb: { readonly parent: Record<string | number, unknown>; readonly key: string | number; readonly value: unknown }[] = [];
    for (const path of theirs) {
      // Side tables (file labels, baseline origins) live beside the contract object: not merged.
      if (path[0] !== 'contract' || path.length < 2) return null;
      const inner = path.slice(1);
      const mine = valueAt(live, inner), theirsValue = valueAt(disk, inner);
      if (JSON.stringify(mine) === JSON.stringify(theirsValue)) continue;
      if (ours.some(own => overlaps(own.slice(1), inner))) return null;
      if (inner[inner.length - 1] === 'status') return null;
      if (mine !== null && typeof mine === 'object') return null;
      const parent = valueAt(live, inner.slice(0, -1));
      if (parent === null || typeof parent !== 'object') return null;
      absorb.push({ parent: parent as Record<string | number, unknown>, key: inner[inner.length - 1]!, value: theirsValue });
    }
    for (const { parent, key, value } of absorb) {
      if (value === undefined && !Array.isArray(parent)) delete parent[key];
      else parent[key] = value;
    }
    logger.info('contract store: the checkpoint was saved by another process; its changes were taken in before this save', { contractId: contract.id, taken: absorb.length });
    this.loadedTrackers.set(contract, freshTracker);
    return freshTracker;
  }

  private matchesDisk(id: string, tracker: ContractProgressTracker): boolean {
    // The log this store holds open is written by nobody else.
    if (this.writers.get(id)?.log != null && this.trackers.get(id) === tracker) return true;
    const dir = contractCheckpointDir(this.projectRoot, id);
    const hasBase = existsSync(join(dir, CHECKPOINT_BASE_FILE));
    switch (tracker.layout) {
      case 'progress': return hasBase && sameLogIdentity(tracker.log, logIdentityOf(join(dir, CHECKPOINT_LOG_FILE)));
      case 'single-file': {
        if (hasBase) return false;
        try { return fileObservationIdentity(contractPath(this.projectRoot, id)) === tracker.sourceIdentity; } catch { return false; }
      }
      case 'historical': return !hasBase && !existsSync(contractPath(this.projectRoot, id));
      case 'none': return !hasBase && !existsSync(contractPath(this.projectRoot, id)) && !existsSync(historicalContractPath(this.projectRoot, id));
    }
  }

  /** A whole new base, for a contract with none in the directory format. A log left beside a quarantined base is kept aside. */
  private publishBase(writer: ProgressWriter, contract: Contract, replacesSingleFile: boolean): void {
    const text = serializeContract(contract, this.now());
    if (text === null) throw new Error('the contract could not be serialized');
    this.setAsideLog(writer, 'orphaned');
    publishInitialContractCheckpoint(writer.dir, basename(CHECKPOINT_BASE_FILE, JSON_SUFFIX), text, () => {});
    // The old single file holds an older schema; the new base holds all of it.
    if (replacesSingleFile) removeFile(contractPath(this.projectRoot, contract.id));
    this.trackers.set(contract.id, ContractProgressTracker.of(contract, 'progress'));
    this.trackedCopies.add(contract);
    this.noteSupportedVersion(join(writer.dir, CHECKPOINT_BASE_FILE));
  }

  /**
   * Converts a version-6 single file in one step: the file is renamed, byte for
   * byte, to the base of the contract's directory. A crash before the rename
   * leaves the single file; after it, the base. Nothing is left behind.
   */
  private moveSingleFile(id: string, dir: string, tracker: ContractProgressTracker): ContractProgressTracker {
    const single = contractPath(this.projectRoot, id), base = join(dir, CHECKPOINT_BASE_FILE);
    const root = contractProgressDir(this.projectRoot), rootExisted = existsSync(root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const writer = this.writers.get(id);
    if (writer !== undefined) this.setAsideLog(writer, 'orphaned');
    let identity: string | null = null;
    try { identity = fileObservationIdentity(single); } catch { /* gone: another writer moved it */ }
    if (identity === null || identity !== tracker.sourceIdentity) throw new ContractCheckpointStaleError(id);
    renameSync(single, base);
    // The base must be found after a crash before any line is appended beside it.
    for (const path of [dir, root, dirname(single), ...(rootExisted ? [] : [contractsDir(this.projectRoot)])]) syncContractDirectory(path);
    this.supportedStoredVersions.delete(single);
    this.noteSupportedVersion(base);
    const moved = tracker.moved();
    this.trackers.set(id, moved);
    return moved;
  }

  /** A log that does not belong to the base now in the directory is kept beside it under another name, never appended to. */
  private setAsideLog(writer: ProgressWriter, why: 'orphaned' | 'damaged'): void {
    writer.log?.close();
    writer.log = null;
    const path = join(writer.dir, CHECKPOINT_LOG_FILE);
    if (existsSync(path)) renameSync(path, `${path}.${why}-${this.now()}`);
  }

  /** The log, opened on the first append after the lock was taken. */
  private openLog(writer: ProgressWriter, durable: boolean): RecordLog<string> {
    if (writer.log !== null) return writer.log;
    const path = join(writer.dir, CHECKPOINT_LOG_FILE);
    const created = !existsSync(path);
    writer.log = openRecordLog<string>(path, { fsync: durable ? 'each' : 'batch', encode: line => line, decode: line => line });
    if (created && durable) syncContractDirectory(writer.dir);
    return writer.log;
  }

  /**
   * Under the lock no other writer is live: any temp file here is a dead
   * writer's. With `sideFiles`, a side file the state does not name is unused
   * and goes too; that is only true right after a compaction rewrote the log,
   * because until then earlier lines of the log still name the files they
   * replaced, and a replay reads every line.
   */
  private clearDirectory(dir: string, tracker: ContractProgressTracker, sideFiles: boolean): void {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    const referenced = tracker.referencedFiles(), unused: string[] = [];
    for (const name of names) {
      if (name.includes('.tmp-')) removeFile(join(dir, name));
      else if (sideFiles && isCheckpointSideFileName(name) && !referenced.has(name)) unused.push(name);
    }
    if (unused.length === 0) return;
    // The lines that stopped naming these files must be on disk before the files go.
    const log = join(dir, CHECKPOINT_LOG_FILE);
    if (existsSync(log)) { const fd = openSync(log, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
    syncContractDirectory(dir);
    for (const name of unused) removeFile(join(dir, name));
  }

  /** Rewrites the log as one snapshot of what changes (captured inputs are named, not copied): one temp file and one rename. */
  private compact(writer: ProgressWriter, contract: Contract, tracker: ContractProgressTracker, change: ReturnType<ContractProgressTracker['diff']>, at: number, durable: boolean): void {
    const line = tracker.snapshot(contract, change, at, value => storedContractBody(value, contractWithStoredReviewObservations));
    const path = join(writer.dir, CHECKPOINT_LOG_FILE);
    if (tracker.damaged) this.setAsideLog(writer, 'damaged');
    else { writer.log?.close(); writer.log = null; }
    writeFileAtomic(path, `${line}\n`, { durable });
    tracker.commitSnapshot(change, Buffer.byteLength(line) + 1);
    tracker.log = logIdentityOf(path);
    // The log is now one snapshot naming only the files the state holds: what no line names can go.
    this.clearDirectory(writer.dir, tracker, true);
  }

  /** Keeps the ended summary in step with a contract just written: written when it ended, removed when it is running again. */
  private recordEnded(contract: Contract): void {
    const path = join(contractEndedDir(this.projectRoot), `${contract.id}${JSON_SUFFIX}`);
    try {
      if (!isTerminalContractStatus(contract.status)) {
        if (this.endedSummaries.delete(contract.id) || existsSync(path)) removeFile(path);
        return;
      }
      const summary: EndedContractSummary = { version: 1, id: contract.id, status: contract.status, sessionId: contract.sessionId,
        ...(contract.ownerPrincipalId === undefined ? {} : { ownerPrincipalId: contract.ownerPrincipalId }),
        createdAt: contract.createdAt, ...(contract.completedAt === undefined ? {} : { completedAt: contract.completedAt }),
        ...(contract.failureKind === undefined ? {} : { failureKind: contract.failureKind }), durable: contract.durableAdmission !== undefined };
      writeFileAtomic(path, JSON.stringify(summary));
      this.endedSummaries.set(contract.id, summary);
      // A record read earlier is replaced by this write (an import over an ended contract).
      if (this.endedRecords.get(contract.id) !== contract) this.endedRecords.delete(contract.id);
    } catch (error) {
      // The checkpoint itself is written; without its summary the contract is read from the checkpoint instead.
      logger.warn('contract store: the ended-contract summary was not written', { contractId: contract.id, error: summarizeError(error) });
    }
  }

  /** The summary of an ended contract, or undefined when the store has none (running, unknown, or written before summaries). */
  endedSummary(contractId: string): EndedContractSummary | undefined {
    const known = this.endedSummaries.get(contractId);
    if (known !== undefined) return known;
    if (!isContractId(contractId)) return undefined;
    let value: unknown;
    try { value = JSON.parse(readFileSync(join(contractEndedDir(this.projectRoot), `${contractId}${JSON_SUFFIX}`), 'utf8')); }
    catch { return undefined; }
    if (!isEndedSummary(value, contractId)) return undefined;
    this.endedSummaries.set(contractId, value);
    return value;
  }

  /** Every ended contract's summary, from the summary directory (one listing; a file is read once per process). */
  listEnded(): EndedContractSummary[] {
    const dir = contractEndedDir(this.projectRoot);
    let names: string[];
    try { names = readdirSync(dir); } catch { return []; }
    const present = new Set<string>();
    const summaries: EndedContractSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(JSON_SUFFIX)) continue;
      const id = name.slice(0, -JSON_SUFFIX.length);
      present.add(id);
      const summary = this.endedSummary(id);
      if (summary !== undefined) summaries.push(summary);
    }
    // Another process removed some: forget them here too.
    for (const id of [...this.endedSummaries.keys()]) if (!present.has(id)) { this.endedSummaries.delete(id); this.evictEndedRecord(id); }
    return summaries;
  }

  /** Records that a held contract ended and is written: it leaves memory, and is read back from disk when asked for. */
  noteEnded(contract: Contract): void {
    if (!isTerminalContractStatus(contract.status)) return;
    if (this.endedSummary(contract.id) === undefined) this.recordEnded(contract);
    if (this.contracts.get(contract.id) !== contract || this.timers.has(contract.id)) return;
    this.contracts.delete(contract.id);
    // Its lock goes; what was written stays known while the record is kept, so a late event saves only its difference.
    this.releaseWriter(contract.id);
    // Kept among the recently read ended records, so a read right after the end needs no disk read.
    if (this.endedRecords.size >= MAX_TERMINAL_CONTRACT_FILES) this.evictEndedRecord(this.endedRecords.keys().next().value!);
    this.endedRecords.set(contract.id, contract);
  }

  /** Drops an ended record from memory with what was known of its last save (a later save reads the disk back). */
  private evictEndedRecord(contractId: string): void {
    this.endedRecords.delete(contractId);
    if (!this.contracts.has(contractId)) this.trackers.delete(contractId);
  }

  /** An ended contract's full record, read from its checkpoint on first use; not held with the live contracts. */
  ended(contractId: string): Contract | null {
    const cached = this.endedRecords.get(contractId);
    if (cached !== undefined) { this.endedRecords.delete(contractId); this.endedRecords.set(contractId, cached); return cached; }
    let contract: Contract | null;
    try {
      const read = this.load(contractId);
      contract = read.kind === 'present' ? read.value : null;
    } catch { return null; }
    if (contract === null || !isTerminalContractStatus(contract.status)) return null;
    if (this.endedRecords.size >= MAX_TERMINAL_CONTRACT_FILES) this.evictEndedRecord(this.endedRecords.keys().next().value!);
    this.endedRecords.set(contractId, contract);
    return contract;
  }

  /**
   * Deletes an ended contract: its checkpoint (current and older layout), its
   * summary and its run claim. A running contract is refused (`not-ended`), and
   * so is native work (`native`), which its native execution owns.
   */
  remove(contractId: string): ContractRemoval {
    if (!isContractId(contractId)) return 'not-found';
    const held = this.contracts.get(contractId);
    if (held !== undefined && !isTerminalContractStatus(held.status)) return 'not-ended';
    const contract = held ?? this.ended(contractId);
    if (contract === null) {
      if (this.endedSummary(contractId) === undefined) {
        // `ended` answers null for a checkpoint that has not ended too (one another
        // process runs, or one waiting for the owner): that is refused by name, not
        // reported as missing.
        let read: ReturnType<ContractStore['load']> | undefined;
        try { read = this.load(contractId); } catch { /* unreadable: left for load() to report */ }
        return read?.kind === 'present' ? 'not-ended' : 'not-found';
      }
    } else {
      if (!isTerminalContractStatus(contract.status)) return 'not-ended';
      if (contract.durableAdmission !== undefined) return 'native';
    }
    this.forgetEnded(contractId);
    return 'removed';
  }

  /** Removes every file and memory of one ended contract. Returns the bytes freed. */
  private forgetEnded(contractId: string): number {
    this.cancelPendingWrite(contractId);
    this.releaseWriter(contractId);
    this.trackers.delete(contractId);
    let freed = removeDirectory(contractCheckpointDir(this.projectRoot, contractId))
      + removeFile(contractPath(this.projectRoot, contractId)) + removeFile(historicalContractPath(this.projectRoot, contractId))
      + removeFile(join(contractEndedDir(this.projectRoot), `${contractId}${JSON_SUFFIX}`));
    for (const lease of [contractLeasePath(this.projectRoot, contractId), contractProgressLockPath(this.projectRoot, contractId)]) {
      for (const path of [lease, `${lease}-journal`, `${lease}-wal`, `${lease}-shm`]) freed += removeFile(path);
    }
    // The contract's workstream snapshots (one per group) go with it.
    freed += removeWorkstreamSnapshots({ root: this.projectRoot, namespace: contractId });
    this.contracts.delete(contractId); this.endedRecords.delete(contractId); this.endedSummaries.delete(contractId);
    this.writeFailures.delete(contractId);
    this.supportedStoredVersions.delete(contractPath(this.projectRoot, contractId));
    this.supportedStoredVersions.delete(historicalContractPath(this.projectRoot, contractId));
    this.supportedStoredVersions.delete(join(contractCheckpointDir(this.projectRoot, contractId), CHECKPOINT_BASE_FILE));
    return freed;
  }

  /** Writes the contract after the debounce; a later call for the same contract restarts the wait. */
  scheduleWrite(contractId: string): void {
    this.cancelPendingWrite(contractId);
    // A newer build's file is never overwritten; retrying on every event only repeats the refusal.
    if (this.writeFailures.get(contractId)?.newerFormat) return;
    // Likewise a copy refused as stale: its failure is recorded once and it is never written.
    const live = this.contracts.get(contractId);
    if (live !== undefined && this.staleCopies.has(live)) return;
    const timer = setTimeout(() => {
      this.timers.delete(contractId);
      this.write(contractId);
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(contractId, timer);
  }

  /** Writes every contract with a pending write now. */
  flush(): void {
    for (const contractId of [...this.timers.keys()]) this.write(contractId);
  }

  /**
   * Reads a contract's file, as an observed read: `present` with the contract,
   * `absent` when no file is there, `failed` when the file was refused
   * (unparseable, not an envelope, malformed, another id, or unbound authority
   * metadata), naming the quarantine path. A refused file is never "no
   * contract": a resume must not start it again from its admission. A newer
   * schema throws and stays at its original path. Does not hold the contract.
   */
  load(contractId: string): Observed<Contract> {
    // A checkpoint name appears only once its bytes are complete (staged file, exclusive link).
    return this.loadAvailable(contractId);
  }

  private loadAvailable(contractId: string): Observed<Contract> {
    const dir = contractCheckpointDir(this.projectRoot, contractId), basePath = join(dir, CHECKPOINT_BASE_FILE);
    if (existsSync(basePath)) return this.loadProgress(contractId, dir, basePath);
    const currentPath = contractPath(this.projectRoot, contractId);
    const path = existsSync(currentPath) ? currentPath : historicalContractPath(this.projectRoot, contractId);
    if (!existsSync(path)) return absent;
    const source = captureQuarantineSource(path);
    if (!source) return absent;
    try {
      let receipt: OwnedContractCheckpointRead;
      try { receipt = readOwnedContractCheckpoint(path, 'contract', source); }
      catch (error) {
        if (error instanceof QuarantineEncodingError) { return this.refuseCheckpoint(contractId, path, 'unparseable', source); }
        throw error;
      }
      const read = parseContractSnapshot(ownedContractCheckpointText(receipt), receipt, path === currentPath ? CURRENT_CONTRACT_SCHEMA_VERSION : 5);
      source.assertCurrent();
      if ('rejected' in read) {
        if (read.rejected === 'future-version') throw new ContractStoreVersionError(contractId);
        return this.refuseCheckpoint(contractId, path, read.rejected, source);
      }
      if (read.snapshot.contract.id !== contractId) {
        return this.refuseCheckpoint(contractId, path, 'invalid-contract', source);
      }
      let hasAdmission: boolean;
      try { hasAdmission = read.snapshot.contract.durableAdmission === undefined && new DurableContractAdmissions(this.projectRoot).findByContractId(contractId) !== null; }
      catch (error) { return failedRead(unreadableAdmission(contractId, error)); } // Corrupt authority metadata is not evidence that an unbound alias is safe.
      source.assertCurrent();
      if (read.snapshot.contract.durableAdmission === undefined && hasAdmission) {
        return this.refuseCheckpoint(contractId, path, 'invalid-contract', source);
      }
      const contract = read.snapshot.contract;
      const tracker = ContractProgressTracker.of(contract, path === currentPath ? 'single-file' : 'historical');
      try { tracker.sourceIdentity = fileObservationIdentity(path); } catch { /* gone since: its first save finds it changed */ }
      tracker.sourceSchemaVersion = read.snapshot.schemaVersion;
      this.loadedTrackers.set(contract, tracker);
      return present(contract);
    } finally { source.close(); }
  }

  /** Reads a checkpoint directory: the base with the progress log applied, through the same parse and quarantine as a single file. */
  private loadProgress(contractId: string, dir: string, basePath: string): Observed<Contract> {
    const source = captureQuarantineSource(basePath);
    if (!source) return absent;
    try {
      const read: { assembled?: AssembledCheckpoint; log?: LogIdentity | null } = {};
      let receipt: OwnedContractCheckpointRead;
      try {
        receipt = readOwnedAssembledCheckpoint(basePath, source, base => {
          const log = readCheckpointLog(dir);
          read.log = log?.identity ?? null;
          read.assembled = assembleCheckpoint(dir, base, log?.bytes ?? null);
          return read.assembled.text;
        });
      } catch (error) {
        if (error instanceof QuarantineEncodingError) { return this.refuseCheckpoint(contractId, basePath, 'unparseable', source); }
        if (error instanceof CheckpointFormatError) throw new ContractStoreVersionError(contractId);
        throw error;
      }
      const parsed = parseContractSnapshot(ownedContractCheckpointText(receipt), receipt);
      source.assertCurrent();
      // A torn last line was ignored above; only a base or a record set that does not make a contract is quarantined.
      if ('rejected' in parsed) {
        if (parsed.rejected === 'future-version') throw new ContractStoreVersionError(contractId);
        return this.refuseCheckpoint(contractId, basePath, parsed.rejected, source);
      }
      const contract = parsed.snapshot.contract;
      if (contract.id !== contractId) {
        return this.refuseCheckpoint(contractId, basePath, 'invalid-contract', source);
      }
      let hasAdmission: boolean;
      try { hasAdmission = contract.durableAdmission === undefined && new DurableContractAdmissions(this.projectRoot).findByContractId(contractId) !== null; }
      catch (error) { return failedRead(unreadableAdmission(contractId, error)); }
      source.assertCurrent();
      if (hasAdmission) {
        return this.refuseCheckpoint(contractId, basePath, 'invalid-contract', source);
      }
      const assembled = read.assembled!;
      this.loadedTrackers.set(contract, ContractProgressTracker.of(contract, 'progress', {
        sources: assembled.sources, log: read.log ?? null, snapshotBytes: assembled.snapshotBytes, appendedBytes: assembled.appendedBytes, damaged: assembled.damaged,
      }));
      this.noteSupportedVersion(basePath);
      return present(contract);
    } finally { source.close(); }
  }

  /** Ids with a contract file on disk, after a housekeeping pass, so a reaped id is never handed back. */
  listStoredIds(): string[] {
    this.reap();
    const ids = new Set<string>();
    for (const dir of [contractProgressDir(this.projectRoot), contractCheckpointsDir(this.projectRoot), contractsDir(this.projectRoot)]) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir)) {
          // A checkpoint directory is named by its id; a single file by its id and `.json`.
          const id = entry.endsWith(JSON_SUFFIX) ? entry.slice(0, -JSON_SUFFIX.length) : entry;
          if (isContractId(id)) ids.add(id);
        }
      } catch (error) {
        logger.warn('contract store: failed to list the contract directory', { dir, error: summarizeError(error) });
      }
    }
    return [...ids];
  }

  /**
   * Imports a serialized contract. Refuses (returns false) when the snapshot
   * is refused, or when the contract it would replace, held or on disk, is not
   * terminal, unless `force`. Otherwise the contract is held and written at
   * once, before anything else (a zombie check, a reap) can look for it, so a
   * consumer resolving it from an event finds it.
   */
  importContract(snapshotJson: string, force = false): boolean {
    const read = readContractSnapshot(snapshotJson);
    if ('rejected' in read) {
      logger.warn('contract store: import refused, snapshot not accepted', { reason: read.rejected });
      return false;
    }
    const contract = read.snapshot.contract;
    try { this.assertStoredVersion(contract.id); } catch { return false; }
    try { if (new DurableContractAdmissions(this.projectRoot).findByContractId(contract.id) !== null) return false; }
    catch { return false; }
    const held = this.contracts.get(contract.id);
    const stored = held === undefined ? this.load(contract.id) : undefined;
    // A refused checkpoint was already quarantined, preserved for inspection: the import replaces nothing.
    const existing = held ?? (stored?.kind === 'present' ? stored.value : null);
    // An imported snapshot must never create/replace a native admission or strip its restart guard.
    if (contract.durableAdmission !== undefined || existing?.durableAdmission !== undefined) return false;
    if (existing && !isTerminalContractStatus(existing.status) && !force) {
      logger.warn('contract store: import refused, the existing contract is not terminal; pass force to overwrite', {
        contractId: contract.id,
        existingStatus: existing.status,
      });
      return false;
    }
    this.contracts.set(contract.id, contract);
    if (!this.write(contract.id)) {
      if (existing) {
        this.contracts.set(contract.id, existing);
        this.scheduleWrite(contract.id);
      } else this.contracts.delete(contract.id);
      return false;
    }
    logger.info('contract store: contract imported', {
      contractId: contract.id,
      status: contract.status,
      overwroteExisting: existing !== null,
    });
    return true;
  }

  private assertStoredVersion(contractId: string): void {
    this.assertCheckpointVersion(contractId, join(contractCheckpointDir(this.projectRoot, contractId), CHECKPOINT_BASE_FILE), CURRENT_CONTRACT_SCHEMA_VERSION);
    // Once a contract is saved in its directory, the single files are no longer its checkpoint.
    if (this.trackers.get(contractId)?.layout === 'progress') return;
    this.assertCheckpointVersion(contractId, contractPath(this.projectRoot, contractId), CURRENT_CONTRACT_SCHEMA_VERSION);
    this.assertCheckpointVersion(contractId, historicalContractPath(this.projectRoot, contractId), 5);
  }

  private assertCheckpointVersion(contractId: string, path: string, maximumVersion: number): void {
    let observed: string;
    try { observed = fileObservationIdentity(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.supportedStoredVersions.delete(path); return; } throw error; }
    if (this.supportedStoredVersions.get(path) === observed) return;
    const file = readFileObservation(path);
    if (file.physical !== observed) throw new Error('Contract checkpoint changed during its version check');
    let value: unknown;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch { this.supportedStoredVersions.set(path, observed); return; }
    if (isRecord(value) && typeof value['schemaVersion'] === 'number' && value['schemaVersion'] > maximumVersion) {
      throw new ContractStoreVersionError(contractId);
    }
    this.supportedStoredVersions.set(path, observed);
  }

  /**
   * Housekeeping: ended contracts past TERMINAL_CONTRACT_MAX_AGE_MS or beyond
   * the newest MAX_TERMINAL_CONTRACT_FILES are removed (native work is kept);
   * native quarantine pairs have a global 30-day / 20-file bound, plus temp
   * files left by a dead writer. A contract that is not terminal (on disk, or
   * held in memory) is never reaped. A reaped contract is also released from memory.
   * Safe to run from two processes at once: a file already gone is success.
   */
  reap(): ContractReapSummary {
    const empty: ContractReapSummary = {
      terminalExpired: 0, terminalOverCap: 0, quarantineExpired: 0, quarantineOverCap: 0,
      staleTempRemoved: 0, retryKeysRemoved: 0, bytesReclaimed: 0, total: 0, reapedIds: [],
    };
    const entries: { dir: string; entry: string }[] = [];
    for (const dir of [contractCheckpointsDir(this.projectRoot), contractsDir(this.projectRoot)]) {
      if (!existsSync(dir)) continue;
      try { for (const entry of readdirSync(dir)) entries.push({ dir, entry }); }
      catch (error) { logger.warn('contract store: failed to list the contract directory for housekeeping', { dir, error: summarizeError(error) }); }
    }
    const progressRoot = contractProgressDir(this.projectRoot);
    let progressNames: string[] = [];
    try { progressNames = readdirSync(progressRoot).filter(isContractId); } catch { /* no directory checkpoints yet */ }
    const now = this.now();
    if (entries.length === 0 && progressNames.length === 0) {
      const keys = this.reapRetryKeys(now);
      return { ...empty, retryKeysRemoved: keys.removed, bytesReclaimed: keys.bytes, total: keys.removed };
    }
    const terminal: DatedFile[] = [];
    let staleTempRemoved = 0;
    let bytesReclaimed = 0;
    let progressQuarantineExpired = 0;

    /** Ended-ness and dates come from the small summary; a checkpoint without one is read once and its summary written then. */
    const consider = (id: string, path: string, observe: () => string, readText: () => string): void => {
      const held = this.contracts.get(id);
      if (held && !isTerminalContractStatus(held.status)) return;
      let summary = this.endedSummary(id);
      if (summary === undefined) {
        // A checkpoint already read as not ended is read again only once it changed.
        let observed: string;
        try { observed = observe(); } catch { return; }
        if (this.notEnded.get(path) === observed) return;
        let text: string;
        try { text = readText(); } catch { return; }
        const read = readContractSnapshot(text);
        // A checkpoint that is refused is left for load() to quarantine with its disclosure, not deleted here.
        if ('rejected' in read || !isTerminalContractStatus(read.snapshot.contract.status)) { this.notEnded.set(path, observed); return; }
        this.notEnded.delete(path);
        this.recordEnded(read.snapshot.contract);
        summary = this.endedSummary(id);
        if (summary === undefined) return;
      }
      if (summary.durable) return;
      terminal.push({ path, at: summary.completedAt ?? summary.createdAt, id });
    };

    const inDirectory = new Set<string>();
    for (const id of progressNames) {
      const dir = join(progressRoot, id), base = join(dir, CHECKPOINT_BASE_FILE);
      if (!existsSync(base)) {
        // No base: a quarantined one (its archive and log kept for inspection) or a first save that never finished.
        let names: string[], age: number;
        try { names = readdirSync(dir); age = now - statSync(dir).mtimeMs; } catch { continue; }
        const quarantined = names.some(name => name.includes('.corrupt-'));
        if (age <= (quarantined ? CONTRACT_QUARANTINE_MAX_AGE_MS : STALE_TEMP_MAX_AGE_MS)) continue;
        bytesReclaimed += removeDirectory(dir);
        if (quarantined) progressQuarantineExpired += 1; else staleTempRemoved += 1;
        continue;
      }
      inDirectory.add(id);
      const log = join(dir, CHECKPOINT_LOG_FILE);
      consider(id, dir,
        () => `${fileObservationIdentity(base)}|${JSON.stringify(logIdentityOf(log))}`,
        () => storedCheckpointText(this.projectRoot, id) ?? '');
    }

    for (const { dir, entry } of entries) {
      const path = join(dir, entry);
      if (entry.includes(TEMP_MARKER)) {
        const marker = entry.indexOf(TEMP_MARKER);
        const id = marker < 0 ? '' : entry.slice(0, marker);
        if (!isContractId(id)) continue;
        const target = `${id}${JSON_SUFFIX}`;
        try {
          const removed = reapOwnedAtomicTempFile(join(dir, target), entry, { now, minimumAgeMs: STALE_TEMP_MAX_AGE_MS });
          if (removed !== undefined) { bytesReclaimed += removed; staleTempRemoved += 1; }
        } catch { /* No proven original directory/writer ownership: preserve it. */ }
        continue;
      }
      // Historical .unrecognized paths have no original-file receipt. Preserve
      // them; a matching suffix and mtime cannot authorize deletion.
      if (entry.endsWith(QUARANTINE_SUFFIX)) continue;
      if (!entry.endsWith(JSON_SUFFIX)) continue;
      const id = entry.slice(0, -JSON_SUFFIX.length);
      // A contract already in its directory is considered once, there.
      if (!isContractId(id) || inDirectory.has(id)) continue;
      consider(id, path, () => fileObservationIdentity(path), () => readFileSync(path, 'utf-8'));
    }

    const reapedIds: string[] = [];
    const reapFile = (file: DatedFile): void => {
      if (file.id === undefined) { bytesReclaimed += removeFile(file.path); return; }
      bytesReclaimed += this.forgetEnded(file.id);
      reapedIds.push(file.id);
    };

    const terminalWithinAge = terminal.filter((file) => now - file.at <= TERMINAL_CONTRACT_MAX_AGE_MS);
    const terminalExpired = terminal.length - terminalWithinAge.length;
    terminal.filter((file) => now - file.at > TERMINAL_CONTRACT_MAX_AGE_MS).forEach(reapFile);
    const terminalExcess = overCap(terminalWithinAge, MAX_TERMINAL_CONTRACT_FILES);
    terminalExcess.forEach(reapFile);

    const quarantine = this.reapQuarantines(now);
    const quarantineExpired = quarantine.expired + progressQuarantineExpired;
    bytesReclaimed += quarantine.bytesReclaimed;
    // After the terminal pass, so the keys of contracts removed just now go in this pass too.
    const keys = this.reapRetryKeys(now);
    bytesReclaimed += keys.bytes;
    const total = terminalExpired + terminalExcess.length + quarantine.reaped + progressQuarantineExpired + staleTempRemoved + keys.removed;
    const summary: ContractReapSummary = {
      terminalExpired,
      terminalOverCap: terminalExcess.length,
      quarantineExpired,
      quarantineOverCap: quarantine.overCap,
      staleTempRemoved,
      retryKeysRemoved: keys.removed,
      bytesReclaimed,
      total,
      reapedIds,
    };
    if (total > 0) {
      const { reapedIds: _ids, ...counts } = summary;
      logger.info('contract store: reclaimed contract files', { directory: contractsDir(this.projectRoot), ...counts });
    }
    return summary;
  }

  /**
   * Writes a contract 250 ms after each of its events (debounced per
   * contract) and runs housekeeping on an unref'd interval. Returns a detach
   * function that stops both and writes anything still pending.
   */
  attach(subscribe: (listener: (event: ContractEvent) => void) => () => void): () => void {
    this.disposed = false;
    const unsubscribe = subscribe((event) => {
      if (event.contractId === undefined) return;
      // A late event of an ended contract (its result published as it ended) is written like any other.
      const ended = this.endedRecords.get(event.contractId);
      if (ended !== undefined && !this.contracts.has(event.contractId)) { this.endedRecords.delete(event.contractId); this.contracts.set(event.contractId, ended); }
      if (this.contracts.has(event.contractId)) this.scheduleWrite(event.contractId);
    });
    if (this.sweepIntervalMs > 0 && this.sweepTimer === null) {
      this.sweepTimer = setInterval(() => this.reap(), this.sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
    return () => {
      unsubscribe();
      this.dispose();
    };
  }

  /** Writes anything pending, closes the progress logs, gives up the contracts' locks and stops the housekeeping timer. */
  dispose(): void {
    this.flush();
    for (const id of [...this.writers.keys()]) this.releaseWriter(id);
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private cancelPendingWrite(contractId: string): void {
    const timer = this.timers.get(contractId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(contractId);
  }

  /** Quarantines a refused checkpoint and answers the failed read naming where it went. */
  private refuseCheckpoint(contractId: string, path: string, reason: ContractSnapshotRejection, source: QuarantineSource): Observed<never> {
    const quarantinePath = this.quarantine(path, reason, source);
    return failedRead(refusal({
      code: 'CONTRACT_CHECKPOINT_REFUSED',
      state: `the checkpoint of contract ${contractId} was refused (${reason}) and moved to ${quarantinePath}`,
      reason: `Contract ${contractId}'s checkpoint could not be read (${reason}), so it is not resumed and not started again from its admission.`,
      next: [`Inspect the quarantined file at ${quarantinePath}.`, `Or cancel the contract: goodvibes-contract cancel ${contractId}.`],
      retryable: false,
    }));
  }

  private quarantine(path: string, reason: ContractSnapshotRejection, source: QuarantineSource): string {
    // Static rejection vocabulary only: parser excerpts can contain private asks.
    // The shared helper checks the exact original read before exclusive archive
    // publication; a replacement source and earlier forensic files stay intact.
    const outcome = quarantineCorruptFile(path, {
      source, label: 'contract store', reason,
      recovery: 'Inspect the preserved checkpoint before recreating this contract.',
      now: this.now(), maxFiles: MAX_CONTRACT_QUARANTINE_FILES,
      maximumAgeMs: CONTRACT_QUARANTINE_MAX_AGE_MS,
    });
    logger.warn('contract store: quarantined an unrecognized contract file', { path, quarantinePath: outcome.quarantinePath, reason });
    // Different IDs share the same forensic budget, including historical and
    // current checkpoint namespaces. Keep the just-published original visible.
    this.reapQuarantines(this.now(), basename(outcome.quarantinePath));
    return outcome.quarantinePath;
  }

  private reapQuarantines(now: number, currentName?: string) {
    return reapOwnedQuarantineDirectories(
      [contractCheckpointsDir(this.projectRoot), contractsDir(this.projectRoot)],
      name => name.endsWith(JSON_SUFFIX) && isContractId(name.slice(0, -JSON_SUFFIX.length)),
      { maxFiles: MAX_CONTRACT_QUARANTINE_FILES, maximumAgeMs: CONTRACT_QUARANTINE_MAX_AGE_MS, now, currentName },
    );
  }
}
