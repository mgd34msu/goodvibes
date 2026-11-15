import { retainOwnedJson } from '../gate/judgment-input.js';
import { contractCreationPathAbsent, publishInitialContractCheckpoint } from './creation-claim.js';
/**
 * ContractStore: the contract tree in memory and on disk
 * (docs/design/contract-runner.md section 7.1).
 *
 * Schema6 checkpoints live in `.goodvibes/contracts/checkpoints-v6/`; the
 * original flat directory remains a read fallback for schema1–5. Old running
 * readers must not discover and quarantine a new checkpoint. Original durable
 * admission keys and execution leases stay in their existing directory.
 * Writes use an atomic temp-file/fsync/rename. Unsupported future versions
 * remain at their original path and refuse replacement; malformed known
 * versions are quarantined.
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
import { DurableContractAdmissions, parseDurableAdmission, syncContractDirectory } from './durable-admission.js';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { ContractEvent } from '../../events/contract.js';
import { CONTRACT_STATUSES } from '../../events/contract.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { captureQuarantineSource, QuarantineEncodingError, quarantineCorruptFile, reapOwnedQuarantineDirectories, reapOwnedAtomicTempFile, writeFileAtomic, type QuarantineSource } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { contractWithStoredReviewObservations, hydrateStoredReviewObservations } from './review-file-observations.js';
import { ownedContractCheckpointText, readOwnedContractCheckpoint, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';
import { storedCurrentFileLabels, restoreCurrentFileLabels } from './current-file-observations.js';
import { storedTreeBaselineOrigins, hydrateTreeBaselines, releaseTreeBaselineBytes } from './tree-baseline.js';
import { isContractInputSnapshot } from './input-snapshot.js';
import { validateNativeDecisionState } from './native-decisions.js';
import { assertNativeContractSource, bindNativeContractSource } from './native-source.js';
import { CURRENT_CONTRACT_SCHEMA_VERSION, isContractId, isOpaqueContractId, isTerminalContractStatus, type Contract } from './types.js';
import { recoverPendingFixIdentities, recoverRepeatedStructuralCriteria } from './fix-identity.js';

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
    && (value['completedAt'] === undefined || typeof value['completedAt'] === 'number');
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

/** The current writer namespace, isolated from schema1–5 readers' flat scans. */
export function contractCheckpointsDir(projectRoot: string): string {
  return join(contractsDir(projectRoot), 'checkpoints-v6');
}

/** A contract's current checkpoint file path. Accepts only an actual current or historical contract ID, so no id can name a path outside the directory. */
export function contractPath(projectRoot: string, contractId: string): string {
  if (!isContractId(contractId)) throw new Error(`Not a contract id: ${JSON.stringify(contractId)}`);
  return join(contractCheckpointsDir(projectRoot), `${contractId}${JSON_SUFFIX}`);
}

/** Compatibility lookup only. New writers never modify these checkpoints. */
function historicalContractPath(projectRoot: string, contractId: string): string {
  if (!isContractId(contractId)) throw new Error(`Not a contract id: ${JSON.stringify(contractId)}`);
  return join(contractsDir(projectRoot), `${contractId}${JSON_SUFFIX}`);
}

/** The envelope as JSON; null when the contract cannot be serialized. */
export function serializeContract(contract: Contract, writtenAt: number): string | null {
  try {
    assertNativeContractSource(contract);
    validateNativeDecisionState(contract);
    const labels = storedCurrentFileLabels(contract);
    const snapshot = { schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION, writtenAt, contract: contractWithStoredReviewObservations(contract),
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
      const admission = parseDurableAdmission(value['durableAdmission']);
      if (admission.contractId !== value['id'] || admission.ownerAgentId !== value['ownerAgentId']
        || (value['durableLaunchState'] !== 'prepared' && value['durableLaunchState'] !== 'launch-claimed')) return false;
      value['durableAdmission'] = admission;
    } catch { return false; }
  }
  return isContractId(value['id'])
    && (value['isolation'] === 'worktree' || value['isolation'] === 'shared')
    && typeof value['status'] === 'string' && (CONTRACT_STATUSES as readonly string[]).includes(value['status'])
    && typeof value['sessionId'] === 'string'
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
    if (isTerminalContractStatus(raw['contract'].status)) releaseTreeBaselineBytes(raw['contract']);
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
    const result: unknown = this.beforeWrite?.(contract);
    if (result !== undefined) { drainOwned(result); throw new Error('Contract checkpoint publication requires a synchronous native owner'); }
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
    const returned: unknown = this.beforeCreate?.(id);
    if (returned !== undefined) { drainOwned(returned); throw new Error('Contract creation requires a synchronous native owner'); }
    // Only actual earlier8hex producers could leave unindexed receipts; a caller-named older id is looked up.
    if (!isOpaqueContractId(id) && new DurableContractAdmissions(this.projectRoot).findByContractId(id) !== null) throw new Error('Contract identity is already admitted');
    const occupied = [contractPath(this.projectRoot, id), historicalContractPath(this.projectRoot, id)].some(path => !contractCreationPathAbsent(path) || !contractCreationPathAbsent(path + QUARANTINE_SUFFIX))
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
    publishInitialContractCheckpoint(contractCheckpointsDir(this.projectRoot), contract.id, text, reservation.assertCurrent);
    original.assertCurrent();
    state.contract = contract; this.contracts.set(contract.id, contract);
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

  /** Writes a held contract now, atomically. Returns false when it is not held or the write failed. */
  write(contractId: string): boolean {
    this.cancelPendingWrite(contractId);
    const contract = this.contracts.get(contractId);
    if (!contract) return false;
    const json = serializeContract(contract, this.now());
    if (json === null) return false;
    const path = contractPath(this.projectRoot, contract.id);
    try {
      this.assertStoredVersion(contract.id);
      this.prepareCheckpointWrite(contract);
      if (contract.durableAdmission !== undefined) new DurableContractAdmissions(this.projectRoot).update(contract.durableAdmission, json);
      let publishedIdentity: string | undefined;
      writeFileAtomic(path, json, { onEffect: published => {
        // The atomic writer fences this callback with the original staged
        // descriptor and published pathname, including nanosecond clocks.
        if (published) publishedIdentity = fileObservationIdentity(path);
      } });
      // Reuse only our successfully published schema, never a replacement
      // observed after the write. The next version check still stats the leaf.
      if (publishedIdentity !== undefined) this.supportedStoredVersions.set(path, publishedIdentity);
      if (contract.durableAdmission !== undefined) {
        syncContractDirectory(contractCheckpointsDir(this.projectRoot));
        syncContractDirectory(contractsDir(this.projectRoot));
      }
      this.writeFailures.delete(contract.id);
      this.recordEnded(contract);
      return true;
    } catch (error) {
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
    }
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
    for (const id of [...this.endedSummaries.keys()]) if (!present.has(id)) { this.endedSummaries.delete(id); this.endedRecords.delete(id); }
    return summaries;
  }

  /** Records that a held contract ended and is written: it leaves memory, and is read back from disk when asked for. */
  noteEnded(contract: Contract): void {
    if (!isTerminalContractStatus(contract.status)) return;
    if (this.endedSummary(contract.id) === undefined) this.recordEnded(contract);
    if (this.contracts.get(contract.id) !== contract || this.timers.has(contract.id)) return;
    this.contracts.delete(contract.id);
    // Kept among the recently read ended records, so a read right after the end needs no disk read.
    if (this.endedRecords.size >= MAX_TERMINAL_CONTRACT_FILES) this.endedRecords.delete(this.endedRecords.keys().next().value!);
    this.endedRecords.set(contract.id, contract);
  }

  /** An ended contract's full record, read from its checkpoint on first use; not held with the live contracts. */
  ended(contractId: string): Contract | null {
    const cached = this.endedRecords.get(contractId);
    if (cached !== undefined) { this.endedRecords.delete(contractId); this.endedRecords.set(contractId, cached); return cached; }
    let contract: Contract | null;
    try { contract = this.load(contractId); } catch { return null; }
    if (contract === null || !isTerminalContractStatus(contract.status)) return null;
    if (this.endedRecords.size >= MAX_TERMINAL_CONTRACT_FILES) this.endedRecords.delete(this.endedRecords.keys().next().value!);
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
      if (this.endedSummary(contractId) === undefined) return 'not-found';
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
    let freed = removeFile(contractPath(this.projectRoot, contractId)) + removeFile(historicalContractPath(this.projectRoot, contractId))
      + removeFile(join(contractEndedDir(this.projectRoot), `${contractId}${JSON_SUFFIX}`));
    const lease = contractLeasePath(this.projectRoot, contractId);
    for (const path of [lease, `${lease}-journal`, `${lease}-wal`, `${lease}-shm`]) freed += removeFile(path);
    this.contracts.delete(contractId); this.endedRecords.delete(contractId); this.endedSummaries.delete(contractId);
    this.writeFailures.delete(contractId);
    this.supportedStoredVersions.delete(contractPath(this.projectRoot, contractId));
    this.supportedStoredVersions.delete(historicalContractPath(this.projectRoot, contractId));
    return freed;
  }

  /** Writes the contract after the debounce; a later call for the same contract restarts the wait. */
  scheduleWrite(contractId: string): void {
    this.cancelPendingWrite(contractId);
    // A newer build's file is never overwritten; retrying on every event only repeats the refusal.
    if (this.writeFailures.get(contractId)?.newerFormat) return;
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
   * Reads a contract's file. A file that is refused (unparseable, not an
   * envelope or malformed contract) is quarantined. A newer schema throws and
   * stays at its original path, so no caller may mistake it for an absent file.
   * Does not hold the contract.
   */
  load(contractId: string): Contract | null {
    // A checkpoint name appears only once its bytes are complete (staged file, exclusive link).
    return this.loadAvailable(contractId);
  }

  private loadAvailable(contractId: string): Contract | null {
    const currentPath = contractPath(this.projectRoot, contractId);
    const path = existsSync(currentPath) ? currentPath : historicalContractPath(this.projectRoot, contractId);
    if (!existsSync(path)) return null;
    const source = captureQuarantineSource(path);
    if (!source) return null;
    try {
      let receipt: OwnedContractCheckpointRead;
      try { receipt = readOwnedContractCheckpoint(path, 'contract', source); }
      catch (error) {
        if (error instanceof QuarantineEncodingError) { this.quarantine(path, 'unparseable', source); return null; }
        throw error;
      }
      const read = parseContractSnapshot(ownedContractCheckpointText(receipt), receipt, path === currentPath ? CURRENT_CONTRACT_SCHEMA_VERSION : 5);
      source.assertCurrent();
      if ('rejected' in read) {
        if (read.rejected === 'future-version') throw new ContractStoreVersionError(contractId);
        this.quarantine(path, read.rejected, source);
        return null;
      }
      if (read.snapshot.contract.id !== contractId) {
        this.quarantine(path, 'invalid-contract', source);
        return null;
      }
      let hasAdmission: boolean;
      try { hasAdmission = read.snapshot.contract.durableAdmission === undefined && new DurableContractAdmissions(this.projectRoot).findByContractId(contractId) !== null; }
      catch { return null; } // Corrupt authority metadata is not evidence that an unbound alias is safe.
      source.assertCurrent();
      if (read.snapshot.contract.durableAdmission === undefined && hasAdmission) {
        this.quarantine(path, 'invalid-contract', source);
        return null;
      }
      return read.snapshot.contract;
    } finally { source.close(); }
  }

  /** Ids with a contract file on disk, after a housekeeping pass, so a reaped id is never handed back. */
  listStoredIds(): string[] {
    this.reap();
    const ids = new Set<string>();
    for (const dir of [contractCheckpointsDir(this.projectRoot), contractsDir(this.projectRoot)]) {
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith(JSON_SUFFIX)) continue;
          const id = entry.slice(0, -JSON_SUFFIX.length);
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
    const existing = this.contracts.get(contract.id) ?? this.load(contract.id);
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
      staleTempRemoved: 0, bytesReclaimed: 0, total: 0, reapedIds: [],
    };
    const entries: { dir: string; entry: string }[] = [];
    for (const dir of [contractCheckpointsDir(this.projectRoot), contractsDir(this.projectRoot)]) {
      if (!existsSync(dir)) continue;
      try { for (const entry of readdirSync(dir)) entries.push({ dir, entry }); }
      catch (error) { logger.warn('contract store: failed to list the contract directory for housekeeping', { dir, error: summarizeError(error) }); }
    }
    if (entries.length === 0) return empty;
    const now = this.now();
    const terminal: DatedFile[] = [];
    let staleTempRemoved = 0;
    let bytesReclaimed = 0;

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
      if (!isContractId(id)) continue;
      const held = this.contracts.get(id);
      if (held && !isTerminalContractStatus(held.status)) continue;
      // Ended-ness and dates come from the small summary. A checkpoint written
      // before summaries existed is read once and its summary written then.
      let summary = this.endedSummary(id);
      if (summary === undefined) {
        // A checkpoint already read as not ended is read again only once it changed.
        let observed: string;
        try { observed = fileObservationIdentity(path); } catch { continue; }
        if (this.notEnded.get(path) === observed) continue;
        let text: string;
        try { text = readFileSync(path, 'utf-8'); } catch { continue; }
        const read = readContractSnapshot(text);
        // A file that is refused is left for load() to quarantine with its disclosure, not deleted here.
        if ('rejected' in read || !isTerminalContractStatus(read.snapshot.contract.status)) { this.notEnded.set(path, observed); continue; }
        this.notEnded.delete(path);
        this.recordEnded(read.snapshot.contract);
        summary = this.endedSummary(id);
        if (summary === undefined) continue;
      }
      if (summary.durable) continue;
      terminal.push({ path, at: summary.completedAt ?? summary.createdAt, id });
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
    const quarantineExpired = quarantine.expired;
    bytesReclaimed += quarantine.bytesReclaimed;
    const total = terminalExpired + terminalExcess.length + quarantine.reaped + staleTempRemoved;
    const summary: ContractReapSummary = {
      terminalExpired,
      terminalOverCap: terminalExcess.length,
      quarantineExpired,
      quarantineOverCap: quarantine.overCap,
      staleTempRemoved,
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

  /** Writes anything pending and stops the housekeeping timer. */
  dispose(): void {
    this.flush();
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

  private quarantine(path: string, reason: ContractSnapshotRejection, source: QuarantineSource): void {
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
  }

  private reapQuarantines(now: number, currentName?: string) {
    return reapOwnedQuarantineDirectories(
      [contractCheckpointsDir(this.projectRoot), contractsDir(this.projectRoot)],
      name => name.endsWith(JSON_SUFFIX) && isContractId(name.slice(0, -JSON_SUFFIX.length)),
      { maxFiles: MAX_CONTRACT_QUARANTINE_FILES, maximumAgeMs: CONTRACT_QUARANTINE_MAX_AGE_MS, now, currentName },
    );
  }
}
