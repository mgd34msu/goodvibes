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
 * versions are quarantined. Completed checkpoints are retained until removed;
 * quarantine and abandoned temporary files have bounded housekeeping.
 *
 * Modeled on orchestration/persistence.ts.
 */
import { DurableContractAdmissions, parseDurableAdmission, syncContractDirectory } from './durable-admission.js';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractEvent } from '../../events/contract.js';
import { CONTRACT_STATUSES } from '../../events/contract.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { reapOwnedAtomicTempFile, writeFileAtomic } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { contractWithStoredReviewObservations, hydrateStoredReviewObservations } from './review-file-observations.js';
import { ownedContractCheckpointText, readOwnedContractCheckpoint, type OwnedContractCheckpointRead } from './owned-checkpoint-read.js';
import { storedCurrentFileLabels, restoreCurrentFileLabels } from './current-file-observations.js';
import { storedTreeBaselineOrigins, hydrateTreeBaselines, releaseTreeBaselineBytes } from './tree-baseline.js';
import { isContractInputSnapshot } from './input-snapshot.js';
import { validateNativeDecisionState } from './native-decisions.js';
import { assertNativeContractSource, bindNativeContractSource } from './native-source.js';
import { CURRENT_CONTRACT_SCHEMA_VERSION, isContractId, isTerminalContractStatus, type Contract } from './types.js';
import { recoverPendingFixIdentities, recoverRepeatedStructuralCriteria } from './fix-identity.js';

const DEBOUNCE_MS = 250;
/** @deprecated Completed contracts are retained until explicitly removed. */
export const MAX_TERMINAL_CONTRACT_FILES = Infinity;
/** Age past which a terminal contract file is reaped, from its completion (or last write). */
export const TERMINAL_CONTRACT_MAX_AGE_MS = Infinity;
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

/** The current writer namespace, isolated from schema1–5 readers' flat scans. */
export function contractCheckpointsDir(projectRoot: string): string {
  return join(contractsDir(projectRoot), 'checkpoints-v6');
}

/** A contract's current checkpoint file path. Throws for an id that is not `ctr-<8 hex>`, so no id can name a path outside the directory. */
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
function parseContractSnapshot(json: string, receipt?: OwnedContractCheckpointRead): { readonly snapshot: ContractSnapshot } | { readonly rejected: ContractSnapshotRejection } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { rejected: 'unparseable' };
  }
  if (!isRecord(raw) || typeof raw['schemaVersion'] !== 'number' || !Number.isFinite(raw['schemaVersion'])) {
    return { rejected: 'not-an-envelope' };
  }
  if (raw['schemaVersion'] > CURRENT_CONTRACT_SCHEMA_VERSION) return { rejected: 'future-version' };
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
  readonly beforeWrite?: (() => void) | undefined;
  /** Clock seam for tests. */
  readonly now?: (() => number) | undefined;
  /** Debounce for event-triggered writes; defaults to 250 ms. */
  readonly debounceMs?: number | undefined;
  /** Housekeeping interval while attached; 0 turns the timer off. Defaults to an hour. */
  readonly sweepIntervalMs?: number | undefined;
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
  private readonly beforeWrite: (() => void) | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ContractStoreOptions) {
    this.projectRoot = options.projectRoot;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? SWEEP_INTERVAL_MS;
    this.beforeWrite = options.beforeWrite?.bind(options);
  }

  /** The live contract, which the runner mutates in place. */
  get(contractId: string): Contract | null {
    return this.contracts.get(contractId) ?? null;
  }

  list(): Contract[] {
    return [...this.contracts.values()];
  }

  /** Also used by the runner's first atomic durable-admission checkpoint. */
  prepareCheckpointWrite(): void {
    const result: unknown = this.beforeWrite?.();
    if (result !== undefined) { drainOwned(result); throw new Error('Contract checkpoint publication requires a synchronous native owner'); }
  }

  /** Holds a contract in memory and schedules its write. */
  put(contract: Contract): void {
    this.assertStoredVersion(contract.id);
    this.contracts.set(contract.id, contract);
    this.scheduleWrite(contract.id);
  }

  /** Holds a contract read from its own file in memory, without writing it back (resume, design 7.2). */
  hold(contract: Contract): void {
    this.assertStoredVersion(contract.id);
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
      this.prepareCheckpointWrite();
      if (contract.durableAdmission !== undefined) new DurableContractAdmissions(this.projectRoot).update(contract.durableAdmission, json);
      writeFileAtomic(path, json);
      if (contract.durableAdmission !== undefined) {
        syncContractDirectory(contractCheckpointsDir(this.projectRoot));
        syncContractDirectory(contractsDir(this.projectRoot));
      }
      return true;
    } catch (error) {
      logger.error('contract store: write failed', { path, error: summarizeError(error) });
      return false;
    }
  }

  /** Writes the contract after the debounce; a later call for the same contract restarts the wait. */
  scheduleWrite(contractId: string): void {
    this.cancelPendingWrite(contractId);
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
    const currentPath = contractPath(this.projectRoot, contractId);
    const path = existsSync(currentPath) ? currentPath : historicalContractPath(this.projectRoot, contractId);
    if (!existsSync(path)) return null;
    let text: string;
    let receipt: OwnedContractCheckpointRead;
    try {
      receipt = readOwnedContractCheckpoint(path, 'contract');
      text = ownedContractCheckpointText(receipt);
    } catch (error) {
      logger.warn('contract store: read failed', { path, error: summarizeError(error) });
      return null;
    }
    const read = parseContractSnapshot(text, receipt);
    if ('snapshot' in read && path !== currentPath && read.snapshot.schemaVersion > 5) throw new ContractStoreVersionError(contractId);
    if ('rejected' in read) {
      if (read.rejected === 'future-version') throw new ContractStoreVersionError(contractId);
      this.quarantine(path, read.rejected);
      return null;
    }
    if (read.snapshot.contract.id !== contractId) {
      this.quarantine(path, 'invalid-contract');
      return null;
    }
    try {
      if (read.snapshot.contract.durableAdmission === undefined
        && new DurableContractAdmissions(this.projectRoot).findByContractId(contractId) !== null) {
        this.quarantine(path, 'invalid-contract');
        return null;
      }
    } catch { return null; } // Corrupt authority metadata is not evidence that an unbound alias is safe.
    return read.snapshot.contract;
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
   * Housekeeping: terminal contract files past 14 days or beyond 50, quarantine
   * files past 30 days or beyond 20, and temp files left by a dead writer. A
   * contract that is not terminal (on disk, or held in memory) is never
   * reaped. A reaped terminal contract is also released from memory.
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
    const quarantined: DatedFile[] = [];
    let staleTempRemoved = 0;
    let bytesReclaimed = 0;

    for (const { dir, entry } of entries) {
      const path = join(dir, entry);
      if (entry.includes(TEMP_MARKER)) {
        const target = /^(ctr-[0-9a-f]{8}\.json)\.tmp-/.exec(entry)?.[1];
        if (target === undefined) continue;
        try {
          const removed = reapOwnedAtomicTempFile(join(dir, target), entry, { now, minimumAgeMs: STALE_TEMP_MAX_AGE_MS });
          if (removed !== undefined) { bytesReclaimed += removed; staleTempRemoved += 1; }
        } catch { /* No proven original directory/writer ownership: preserve it. */ }
        continue;
      }
      if (entry.endsWith(QUARANTINE_SUFFIX)) {
        try {
          quarantined.push({ path, at: statSync(path).mtimeMs });
        } catch {
          // Gone between the listing and the stat: another process reaped it.
        }
        continue;
      }
      if (!entry.endsWith(JSON_SUFFIX)) continue;
      const id = entry.slice(0, -JSON_SUFFIX.length);
      if (!isContractId(id)) continue;
      const held = this.contracts.get(id);
      if (held && !isTerminalContractStatus(held.status)) continue;
      // Terminal-ness is decided by content. A file that is refused is left
      // for load() to quarantine with its disclosure, not deleted here.
      let text: string;
      try {
        text = readFileSync(path, 'utf-8');
      } catch {
        continue;
      }
      const read = readContractSnapshot(text);
      if ('rejected' in read || read.snapshot.contract.durableAdmission !== undefined || !isTerminalContractStatus(read.snapshot.contract.status)) continue;
      const completedAt = read.snapshot.contract.completedAt;
      const at = typeof completedAt === 'number' && Number.isFinite(completedAt) ? completedAt : read.snapshot.writtenAt;
      terminal.push({ path, at, id });
    }

    const reapedIds: string[] = [];
    const reapFile = (file: DatedFile): void => {
      bytesReclaimed += removeFile(file.path);
      if (file.id === undefined) return;
      reapedIds.push(file.id);
      const held = this.contracts.get(file.id);
      if (held && isTerminalContractStatus(held.status)) this.contracts.delete(file.id);
    };

    const terminalWithinAge = terminal.filter((file) => now - file.at <= TERMINAL_CONTRACT_MAX_AGE_MS);
    const terminalExpired = terminal.length - terminalWithinAge.length;
    terminal.filter((file) => now - file.at > TERMINAL_CONTRACT_MAX_AGE_MS).forEach(reapFile);
    const terminalExcess = overCap(terminalWithinAge, MAX_TERMINAL_CONTRACT_FILES);
    terminalExcess.forEach(reapFile);

    const quarantineWithinAge = quarantined.filter((file) => now - file.at <= CONTRACT_QUARANTINE_MAX_AGE_MS);
    const quarantineExpired = quarantined.length - quarantineWithinAge.length;
    quarantined.filter((file) => now - file.at > CONTRACT_QUARANTINE_MAX_AGE_MS).forEach(reapFile);
    const quarantineExcess = overCap(quarantineWithinAge, MAX_CONTRACT_QUARANTINE_FILES);
    quarantineExcess.forEach(reapFile);

    const total = terminalExpired + terminalExcess.length + quarantineExpired + quarantineExcess.length + staleTempRemoved;
    const summary: ContractReapSummary = {
      terminalExpired,
      terminalOverCap: terminalExcess.length,
      quarantineExpired,
      quarantineOverCap: quarantineExcess.length,
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
      if (event.contractId !== undefined && this.contracts.has(event.contractId)) this.scheduleWrite(event.contractId);
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

  private quarantine(path: string, reason: ContractSnapshotRejection): void {
    const quarantinePath = `${path}${QUARANTINE_SUFFIX}`;
    try {
      renameSync(path, quarantinePath);
      logger.warn('contract store: quarantined an unrecognized contract file', { path, quarantinePath, reason });
    } catch (error) {
      logger.error('contract store: failed to quarantine an unrecognized contract file', { path, error: summarizeError(error) });
    }
  }
}
