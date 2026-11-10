/**
 * store.ts, persistence for the trigger family, with recovery housekeeping.
 *
 * Anything persisted across restarts and crashes has to do real housekeeping at
 * recovery, not just load. This store does all five:
 *
 *   1. Reap on recovery, triggers whose owning session is gone are removed,
 *      and a one-shot on-exit trigger that already fired retires itself.
 *   2. Bound everything, count cap AND age TTL on run history, observations
 *      and the shared event log. An unbounded append-only store is a leak with
 *      a nicer name.
 *   3. Validate the complete envelope and records, never existence alone.
 *      Fresh v2 snapshots publish atomically without a redundant document hash;
 *      actual saved v1 inputs retain their original read-only checksum check.
 *   4. Reap periodically, the supervisor runs the same sweep on a timer,
 *      because a long-lived daemon that only sweeps at boot never sweeps.
 *   5. Disclose what was reaped, every sweep returns a report and the startup
 *      sweep writes `triggers-reaped.json`. Silent deletion is indistinguishable
 *      from data loss.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * leaves the previous good snapshot rather than a half-written one.
 */

import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { resolveSharedDirectory } from '../runtime/surface-root.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { TriggerFileOwner, TriggerStoreError } from './store-owner.js';
import { isTriggerEvent, isTriggerGrant, isTriggerRecord, isTriggerReport, snapshotJson } from './snapshot-validation.js';
import type { TriggerActionGrant, TriggerEventLogEntry, TriggerRecord, TriggerRecoveryReport } from './types.js';
export { TriggerStoreError, TriggerStoreOwnershipError } from './store-owner.js';

export const TRIGGER_STORE_VERSION = 2;
export interface PreviousTriggerSnapshot { readonly version: 1; readonly checksum: string; readonly daemonBootId: string; readonly savedAt: number }
interface SnapshotBody {
  readonly version: 1 | 2;
  readonly daemonBootId: string;
  readonly savedAt: number;
  readonly triggers: readonly TriggerRecord[];
  readonly grants: readonly TriggerActionGrant[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly previousSource?: PreviousTriggerSnapshot;
}
export type TriggerStoreSnapshot = SnapshotBody & ({ readonly version: 1; readonly checksum: string } | { readonly version: 2; readonly checksum?: never });
interface TriggerCutover { readonly version: 1; readonly phase: 'prepared' | 'committed'; readonly previousSource: PreviousTriggerSnapshot | null; readonly migration: 'terminal-history' | 'operator-confirmed' }
function samePrevious(left: PreviousTriggerSnapshot | null | undefined, right: PreviousTriggerSnapshot | null | undefined): boolean {
  return left == null || right == null ? left == null && right == null : left.checksum === right.checksum && left.daemonBootId === right.daemonBootId && left.savedAt === right.savedAt;
}
export class TriggerStoreVersionError extends Error {
  override readonly name = 'TriggerStoreVersionError';
  constructor(readonly version: number) { super('Trigger snapshot requires a newer reader'); }
}

export class TriggerMigrationRequiredError extends Error {
  override readonly name = 'TriggerMigrationRequiredError';
  constructor() { super('Older trigger state needs explicit migration after closing older GoodVibes instances; inspection remains available.'); }
}
function runnablePrevious(snapshot: TriggerStoreSnapshot | null): boolean {
  return snapshot?.triggers.some(record => record.state !== 'fired' && record.state !== 'cancelled') ?? false;
}

export interface TriggerRetentionPolicy {
  readonly observationRingSize: number;
  readonly runHistoryLimit: number;
  readonly runHistoryTtlMs: number;
  readonly eventLogLimit: number;
  readonly eventLogTtlMs: number;
}

export const DEFAULT_RETENTION: TriggerRetentionPolicy = {
  observationRingSize: 200,
  runHistoryLimit: 50,
  runHistoryTtlMs: 168 * 60 * 60 * 1000,
  eventLogLimit: 500,
  eventLogTtlMs: 24 * 60 * 60 * 1000,
};

export function getTriggerStorePath(rootPath: string): string {
  return resolveSharedDirectory(rootPath, 'triggers-v2.json');
}

/** Actual v1 file remains read-only for installed earlier readers. */
export function getPreviousTriggerStorePath(rootPath: string): string { return resolveSharedDirectory(rootPath, 'triggers.json'); }

export function getTriggerReapReportPath(storePath: string): string {
  return join(dirname(storePath), `${basename(storePath).replace(/\.json$/, '')}-reaped.json`);
}

/** The deployed v1 checksum is read compatibility, not an authenticator.
 * Only actual saved version1 data/fixtures may use this representation. Fresh
 * version2 publication uses complete validation and owned atomic persistence.
 */
export function checksumOf(body: SnapshotBody): string {
  if (body.version !== 1) throw new TriggerStoreError('invalid');
  return createHash('sha256').update(JSON.stringify({ version: body.version, daemonBootId: body.daemonBootId,
    savedAt: body.savedAt, triggers: body.triggers, grants: body.grants, eventLog: body.eventLog })).digest('hex');
}

export function validateSnapshot(parsed: unknown): TriggerStoreSnapshot | { readonly invalid: string } {
  return validateSnapshotRepresentation(parsed, false);
}

/** Only actual saved snapshots may use the deployed old probe spelling. Check
 * the original v1 checksum before normalization; retain its original source
 * receipt and bytes. Public definitions and all new publications are canonical.
 */
function validatePersistedSnapshot(parsed: unknown): TriggerStoreSnapshot | { readonly invalid: string } {
  return validateSnapshotRepresentation(parsed, true);
}
function validateSnapshotRepresentation(parsed: unknown, persisted: boolean): TriggerStoreSnapshot | { readonly invalid: string } {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { invalid: 'snapshot is not an object' };
  const snapshot = parsed as Record<string, unknown>, version = snapshot['version'];
  if (typeof version === 'number' && Number.isFinite(version) && version !== 1 && version !== 2) throw new TriggerStoreVersionError(version);
  if (version !== 1 && version !== 2) return { invalid: 'snapshot version is not supported' };
  if (version === 1 && (typeof snapshot['checksum'] !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot['checksum']))) {
    return { invalid: 'snapshot has no checksum, the write did not complete' };
  }
  const previous = snapshot['previousSource'];
  if (previous !== undefined && (version !== 2 || !previous || typeof previous !== 'object' || Array.isArray(previous)
    || Object.keys(previous).length !== 4 || !('version' in previous) || previous.version !== 1
    || !('checksum' in previous) || typeof previous.checksum !== 'string' || !/^[0-9a-f]{64}$/.test(previous.checksum)
    || !('daemonBootId' in previous) || typeof previous.daemonBootId !== 'string' || !previous.daemonBootId
    || !('savedAt' in previous) || typeof previous.savedAt !== 'number' || !Number.isFinite(previous.savedAt))) return { invalid: 'previous snapshot source is invalid' };
  const keys = version === 1 ? ['version', 'daemonBootId', 'savedAt', 'triggers', 'grants', 'eventLog', 'checksum']
    : ['version', 'daemonBootId', 'savedAt', 'triggers', 'grants', 'eventLog', ...(previous === undefined ? [] : ['previousSource'])];
  if (Object.keys(snapshot).length !== keys.length || Object.keys(snapshot).some(key => !keys.includes(key))) return { invalid: 'snapshot envelope fields are invalid' };
  if (typeof snapshot['daemonBootId'] !== 'string' || !snapshot['daemonBootId'] || typeof snapshot['savedAt'] !== 'number' || !Number.isFinite(snapshot['savedAt'])
    || !Array.isArray(snapshot['triggers']) || !Array.isArray(snapshot['grants']) || !Array.isArray(snapshot['eventLog'])) return { invalid: 'snapshot header or collections are invalid' };
  // First verify the precise original representation on an actual v1 input.
  // v2 never calls this hash, including on malformed records.
  if (version === 1 && checksumOf(snapshot as unknown as SnapshotBody) !== snapshot['checksum']) return { invalid: 'snapshot checksum mismatch' };
  const storedTriggers: unknown[] = snapshot['triggers'];
  let normalizedTriggers: unknown[] | undefined;
  if (persisted) for (let index = 0; index < storedTriggers.length; index++) {
    const record = storedTriggers[index];
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const row = record as Record<string, unknown>, definitionValue = row['definition'];
    if (!definitionValue || typeof definitionValue !== 'object' || Array.isArray(definitionValue)) continue;
    const definition = definitionValue as Record<string, unknown>, specValue = definition['spec'];
    if (!specValue || typeof specValue !== 'object' || Array.isArray(specValue)) continue;
    const spec = specValue as Record<string, unknown>;
    if (spec['kind'] !== 'condition') continue;
    const probeValue = spec['probe'];
    if (!probeValue || typeof probeValue !== 'object' || Array.isArray(probeValue)) continue;
    const probe = probeValue as Record<string, unknown>;
    if (probe['kind'] !== 'sdk-tool') continue;
    normalizedTriggers ??= storedTriggers.slice();
    normalizedTriggers[index] = { ...row, definition: { ...definition, spec: { ...spec, probe: { ...probe, kind: 'platform-tool' } } } };
  }
  const triggers = normalizedTriggers ?? storedTriggers;
  if (!triggers.every(isTriggerRecord) || !snapshot['grants'].every(isTriggerGrant) || !snapshot['eventLog'].every(isTriggerEvent)) return { invalid: 'snapshot records failed shape validation' };
  if (new Set(triggers.map(entry => entry.definition.id)).size !== triggers.length
    || new Set(snapshot['grants'].map(entry => entry.id)).size !== snapshot['grants'].length) return { invalid: 'snapshot identities are duplicated' };
  return (normalizedTriggers ? { ...snapshot, triggers } : snapshot) as unknown as TriggerStoreSnapshot;
}

export interface TriggerSnapshotInput {
  readonly daemonBootId: string;
  readonly triggers: readonly TriggerRecord[];
  readonly grants: readonly TriggerActionGrant[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly now?: number | undefined;
}
export interface LoadedTriggerStore { readonly snapshot: TriggerStoreSnapshot | null; readonly quarantined?: string | undefined }

/** One manager owns one selected original snapshot/report tree. Only native
 * ownership metadata is retained here; there is no whole-body checksum cache.
 */
export class TriggerSnapshotStore {
  private readonly files: TriggerFileOwner;
  private readonly name: string;
  private readonly reportName: string;
  private knownVersion: number | null | undefined;
  private readonly previousFiles: TriggerFileOwner | undefined;
  private readonly previousName: string | undefined;
  private previousIdentity: PreviousTriggerSnapshot | null = null;
  private previousInspected = false;
  private readonly cutoverName: string;
  private cutover: TriggerCutover | null | undefined;
  private quarantinedHere = false;
  private migrationAccepted = false;
  private previousRunnable = false;
  constructor(readonly storePath: string, private readonly beforeWrite?: (() => void) | undefined, previousStorePath?: string, private readonly beforePlatformToolWrite?: (() => void) | undefined) {
    this.name = basename(storePath); this.reportName = basename(getTriggerReapReportPath(storePath));
    this.cutoverName = `${this.name}.cutover.json`;
    // Both generations normally share a directory. One retained owner must
    // acknowledge its own creation of that originally absent parent; a second
    // missing-parent observation would incorrectly classify it as foreign.
    const sharedParent = previousStorePath !== undefined && dirname(previousStorePath) === dirname(storePath);
    this.files = new TriggerFileOwner(storePath, this.reportName, [this.cutoverName,
      ...(sharedParent ? [basename(previousStorePath!), 'triggers-reaped.json'] : [])]);
    if (previousStorePath) {
      this.previousName = basename(previousStorePath);
      this.previousFiles = sharedParent ? this.files : new TriggerFileOwner(previousStorePath, 'triggers-reaped.json');
    }
  }
  /** Explicit operator acknowledgement; this is not a process-exclusion proof. */
  acceptPreviousMigration(): void { this.migrationAccepted = true; }
  private assertMigration(): void {
    if (this.previousRunnable && !this.migrationAccepted && this.cutover?.migration !== 'operator-confirmed') throw new TriggerMigrationRequiredError();
  }
  acquire(): void { this.previousFiles?.assertCurrent(); this.files.acquire(this.name); }
  release(): void { this.files.release(); }
  assertCurrent(): void { this.previousFiles?.assertCurrent(); this.files.assertCurrent(); }
  private readPrevious(): TriggerStoreSnapshot | null {
    const source = this.previousFiles && this.previousName ? this.previousFiles.read(this.previousName) : null;
    this.previousInspected = true;
    if (!source) { this.previousIdentity = null; return null; }
    try {
      let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as unknown; } catch { throw new TriggerStoreError('invalid'); }
      const validated = validatePersistedSnapshot(parsed); if ('invalid' in validated || validated.version !== 1) throw new TriggerStoreError('invalid');
      this.previousRunnable = runnablePrevious(validated);
      this.previousIdentity = { version: 1, checksum: validated.checksum, daemonBootId: validated.daemonBootId, savedAt: validated.savedAt };
      this.assertCurrent(); return validated;
    } finally { source.close(); }
  }
  private assertPrevious(snapshot: TriggerStoreSnapshot): void {
    if (!this.previousFiles) return;
    if (snapshot.version !== 2) throw new TriggerStoreError('invalid');
    const expected = snapshot.previousSource, actual = this.previousIdentity;
    if (expected === undefined ? actual !== null : actual === null || expected.checksum !== actual.checksum
      || expected.daemonBootId !== actual.daemonBootId || expected.savedAt !== actual.savedAt) throw new TriggerStoreError('unavailable');
  }
  private readCutover(): void {
    if (this.cutover !== undefined) return;
    const source = this.files.read(this.cutoverName);
    if (!source) { this.cutover = null; return; }
    try {
      let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as unknown; } catch { throw new TriggerStoreError('invalid'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TriggerStoreError('invalid');
      const record = value as Record<string, unknown>;
      if (typeof record['version'] === 'number' && record['version'] !== 1) throw new TriggerStoreVersionError(record['version']);
      if (Object.keys(record).length !== 4 || Object.keys(record).some(key => !['version', 'phase', 'migration', 'previousSource'].includes(key)) || (record['migration'] !== 'terminal-history' && record['migration'] !== 'operator-confirmed') || record['version'] !== 1 || (record['phase'] !== 'prepared' && record['phase'] !== 'committed')) throw new TriggerStoreError('invalid');
      const previous = record['previousSource'];
      if (previous !== null) {
        const envelope = validateSnapshot({ version: 2, daemonBootId: 'cutover', savedAt: 0, triggers: [], grants: [], eventLog: [], previousSource: previous });
        if ('invalid' in envelope) throw new TriggerStoreError('invalid');
      }
      const captured: TriggerCutover = { version: 1, phase: record['phase'], migration: record['migration'], previousSource: previous as PreviousTriggerSnapshot | null };
      if (this.previousFiles && !samePrevious(captured.previousSource, this.previousIdentity)) throw new TriggerStoreError('unavailable');
      this.cutover = captured;
    } finally { source.close(); }
  }
  private declare(platformTool: boolean): void {
    const invoke = (restriction: (() => void) | undefined): void => {
      this.previousFiles?.assertCurrent();
      const result: unknown = restriction?.();
      if (result !== undefined) { drainOwned(result); throw new TriggerStoreError('unavailable'); }
      this.previousFiles?.assertCurrent();
    };
    invoke(this.beforeWrite);
    if (platformTool) invoke(this.beforePlatformToolWrite);
  }
  load(readOnly = false): LoadedTriggerStore {
    this.assertCurrent(); const previous = this.readPrevious(); this.readCutover();
    if (!readOnly) this.assertMigration();
    const source = this.files.read(this.name);
    if (!source) {
      if (this.cutover?.phase === 'committed') throw new TriggerStoreError('unavailable');
      if (!readOnly) this.assertMigration();
      this.knownVersion = null; return { snapshot: previous };
    }
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as unknown; }
      catch { if (readOnly) throw new TriggerStoreError('invalid'); const target = this.files.quarantine(this.name, source); this.knownVersion = null; this.quarantinedHere = true; if (this.cutover?.phase === 'committed' && this.previousFiles) throw new TriggerStoreError('invalid'); return { snapshot: this.cutover?.phase === 'prepared' ? previous : null, quarantined: `unparseable snapshot (moved to ${target})` }; }
      const snapshot = validatePersistedSnapshot(parsed);
      if ('invalid' in snapshot) {
        if (readOnly) throw new TriggerStoreError('invalid');
        const target = this.files.quarantine(this.name, source); this.knownVersion = null; this.quarantinedHere = true;
        if (this.cutover?.phase === 'committed' && this.previousFiles) throw new TriggerStoreError('invalid');
        return { snapshot: this.cutover?.phase === 'prepared' ? previous : null, quarantined: `${snapshot.invalid} (moved to ${target})` };
      }
      this.assertPrevious(snapshot);
      if (!readOnly) this.assertMigration();
      if (this.cutover && !samePrevious(snapshot.previousSource, this.cutover.previousSource)) throw new TriggerStoreError('unavailable');
      this.files.assertCurrent(); this.knownVersion = snapshot.version; return { snapshot };
    } finally { source.close(); }
  }
  private withLease<T>(work: () => T): T {
    const owned = this.files.acquired; if (!owned) this.acquire();
    try { return work(); } finally { if (!owned) this.release(); }
  }
  save(input: TriggerSnapshotInput): void { this.withLease(() => this.saveOwned(input)); }
  private saveOwned(input: TriggerSnapshotInput): void {
    this.assertCurrent();
    if (!this.previousInspected) this.readPrevious();
    this.readCutover();
    this.assertMigration();
    if (this.cutover?.previousSource && !this.previousFiles) throw new TriggerStoreError('unavailable');
    if (this.cutover?.phase === 'committed' && this.knownVersion === null && (!this.quarantinedHere || this.previousFiles)) throw new TriggerStoreError('unavailable');
    // A stand-alone explicit writer must inspect an existing version before
    // replacement too; an unsupported future file is never quarantined/reset.
    if (this.knownVersion === undefined) {
      const source = this.files.read(this.name);
      if (source) {
        try {
          let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as unknown; } catch { throw new TriggerStoreError('invalid'); }
          const validated = validatePersistedSnapshot(parsed); if ('invalid' in validated) throw new TriggerStoreError('invalid');
          this.assertPrevious(validated); this.knownVersion = validated.version;
        } finally { source.close(); }
      } else {
        if (this.cutover?.phase === 'committed' && !(this.quarantinedHere && !this.previousFiles)) throw new TriggerStoreError('unavailable');
        this.knownVersion = null;
      }
    }
    const captured = snapshotJson({ version: TRIGGER_STORE_VERSION, ...(this.previousIdentity === null ? {} : { previousSource: this.previousIdentity }), daemonBootId: input.daemonBootId, savedAt: input.now ?? Date.now(),
      triggers: [...input.triggers].sort((a, b) => a.definition.id.localeCompare(b.definition.id)),
      grants: [...input.grants].sort((a, b) => a.id.localeCompare(b.id)),
      eventLog: [...input.eventLog].sort((a, b) => a.at - b.at || a.triggerId.localeCompare(b.triggerId)),
    });
    const snapshot = validateSnapshot(captured); if ('invalid' in snapshot) throw new TriggerStoreError('invalid');
    const platformTool = snapshot.triggers.some(record => record.definition.spec.kind === 'condition' && record.definition.spec.probe.kind === 'platform-tool');
    if (!this.cutover) {
      const prepared: TriggerCutover = { version: 1, phase: 'prepared', previousSource: this.previousIdentity, migration: this.migrationAccepted ? 'operator-confirmed' : 'terminal-history' };
      this.files.write(this.cutoverName, `${JSON.stringify(prepared)}\n`, () => this.declare(platformTool)); this.cutover = prepared;
    }
    this.files.write(this.name, `${JSON.stringify(snapshot, null, 2)}\n`, () => this.declare(platformTool));
    if (this.cutover.phase === 'prepared') {
      const committed: TriggerCutover = { ...this.cutover, phase: 'committed' };
      this.files.write(this.cutoverName, `${JSON.stringify(committed)}\n`, () => this.declare(platformTool)); this.cutover = committed;
    }
    this.knownVersion = TRIGGER_STORE_VERSION;
  }
  report(report: TriggerRecoveryReport): void { this.withLease(() => this.reportOwned(report)); }
  private reportOwned(report: TriggerRecoveryReport): void {
    this.assertCurrent();
    if (!isTriggerReport(report)) throw new TriggerStoreError('invalid');
    if (!report.triggersReaped && !report.runsReaped && !report.observationsReaped && !report.eventsReaped && !report.orphanedProcesses.length && !report.quarantined) return;
    const source = this.files.read(this.reportName) ?? this.previousFiles?.read('triggers-reaped.json') ?? null; let history: TriggerRecoveryReport[] = [];
    if (source) {
      try {
        let parsed: unknown; try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)) as unknown; } catch { throw new TriggerStoreError('invalid'); }
        if (!Array.isArray(parsed) || !parsed.every(isTriggerReport)) throw new TriggerStoreError('invalid'); history = parsed;
      } finally { source.close(); }
    }
    history.push(snapshotJson(report) as TriggerRecoveryReport);
    this.files.write(this.reportName, `${JSON.stringify(history.slice(-50), null, 2)}\n`);
  }
}

/** Compatibility entry points retain their own actual selected file owner. */
export function saveTriggerSnapshot(storePath: string, input: TriggerSnapshotInput): void { new TriggerSnapshotStore(storePath).save(input); }
export function loadTriggerSnapshot(storePath: string): LoadedTriggerStore { return new TriggerSnapshotStore(storePath).load(); }

// ─── Bounding ─────────────────────────────────────────────────────────────────

export interface BoundResult {
  readonly record: TriggerRecord;
  readonly runsReaped: number;
  readonly observationsReaped: number;
}

/** Applies the count cap AND the age TTL to one record's retained state. */
export function boundRecord(record: TriggerRecord, policy: TriggerRetentionPolicy, now: number): BoundResult {
  const runCutoff = now - policy.runHistoryTtlMs;
  const keptRuns = record.runs
    .filter((run) => run.at >= runCutoff)
    .slice(-policy.runHistoryLimit);
  const keptObservations = record.observations.slice(-policy.observationRingSize);
  const runsReaped = record.runs.length - keptRuns.length;
  const observationsReaped = record.observations.length - keptObservations.length;
  if (runsReaped === 0 && observationsReaped === 0) {
    return { record, runsReaped: 0, observationsReaped: 0 };
  }
  return {
    record: { ...record, runs: keptRuns, observations: keptObservations },
    runsReaped,
    observationsReaped,
  };
}

export function boundEventLog(
  eventLog: readonly TriggerEventLogEntry[],
  policy: TriggerRetentionPolicy,
  now: number,
): { readonly eventLog: readonly TriggerEventLogEntry[]; readonly reaped: number } {
  const cutoff = now - policy.eventLogTtlMs;
  const kept = eventLog.filter((entry) => entry.at >= cutoff).slice(-policy.eventLogLimit);
  return { eventLog: kept, reaped: eventLog.length - kept.length };
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

export interface SweepInput {
  readonly triggers: readonly TriggerRecord[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly policy: TriggerRetentionPolicy;
  readonly now: number;
  readonly reason: 'startup' | 'sweep';
  /** Returns false when the session that created a trigger no longer exists. */
  readonly sessionIsLive?: ((sessionId: string) => boolean) | undefined;
  /** Returns false when a tracked child process is no longer running. */
  readonly processIsLive?: ((pid: number, startedAt: number) => boolean) | undefined;
  readonly quarantined?: string | undefined;
}

export interface SweepResult {
  readonly triggers: readonly TriggerRecord[];
  readonly eventLog: readonly TriggerEventLogEntry[];
  readonly report: TriggerRecoveryReport;
}

/**
 * The recovery sweep. Idempotent and safe to run concurrently from more than
 * one process: it only ever removes records that are already terminal or whose
 * owner is provably gone, and running it twice produces the same result.
 */
export function sweepTriggers(input: SweepInput): SweepResult {
  const { policy, now } = input;
  const kept: TriggerRecord[] = [];
  const reapedIds: string[] = [];
  const orphanedProcesses: string[] = [];
  let runsReaped = 0;
  let observationsReaped = 0;

  for (const record of input.triggers) {
    // A malformed record must not take the sweep down: recovery is exactly
    // when the store is most likely to hold something torn, and a crash here
    // would leave every OTHER record unreaped and unbounded too.
    if (!isTriggerRecord(record)) {
      const id = (record as Partial<TriggerRecord>)?.definition?.id;
      reapedIds.push(typeof id === 'string' && id.length > 0 ? id : '<malformed record>');
      continue;
    }
    const owner = record.definition.ownerSessionId;
    if (owner && input.sessionIsLive && !input.sessionIsLive(owner)) {
      reapedIds.push(record.definition.id);
      continue;
    }
    // A one-shot on-exit trigger retires once it has fired: keeping it would
    // mean a second fire on the next load.
    if (record.definition.spec.kind === 'on-exit' && (record.state === 'fired' || record.state === 'cancelled')) {
      reapedIds.push(record.definition.id);
      continue;
    }
    if (record.process && input.processIsLive && !input.processIsLive(record.process.pid, record.process.startedAt)) {
      orphanedProcesses.push(record.process.processId);
    }
    const bounded = boundRecord(record, policy, now);
    runsReaped += bounded.runsReaped;
    observationsReaped += bounded.observationsReaped;
    kept.push(bounded.record);
  }

  const boundedLog = boundEventLog(input.eventLog, policy, now);

  return {
    triggers: kept,
    eventLog: boundedLog.eventLog,
    report: {
      at: now,
      reason: input.reason,
      triggersLoaded: input.triggers.length,
      triggersReaped: reapedIds.length,
      reapedIds,
      runsReaped,
      observationsReaped,
      eventsReaped: boundedLog.reaped,
      orphanedProcesses,
      ...(input.quarantined ? { quarantined: input.quarantined } : {}),
    },
  };
}

/**
 * Discloses the sweep. Mirrors the checkpoint adoption path's
 * `checkpoints-moved.json`: whatever was removed is written down where a person
 * can find it, so a reap never looks like data loss.
 */
export function writeReapReport(storePath: string, report: TriggerRecoveryReport): void { new TriggerSnapshotStore(storePath).report(report); }
