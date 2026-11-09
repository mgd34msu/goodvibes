/** platform-owned platform module. This implementation is maintained in goodvibes-platform. */

/**
 * Persistence (see CHANGELOG 0.38.0): serializes a workstream into a
 * schema-versioned snapshot, rejects a snapshot written by a newer schema, and
 * imports one back. Writes to `.goodvibes/orchestration/<workstreamId>.json`.
 * Writes are debounced (250ms). Unrecognized corrupt snapshots retain their
 * original bytes under a unique `.unrecognized` name; newer formats stay put.
 */
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import { writeFileAtomic, reapOwnedAtomicTempFile, captureExistingDirectory } from '../utils/atomic-json-store.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import {
  CURRENT_WORKSTREAM_SCHEMA_VERSION,
  type OrchestrationEvent,
  type PhaseResult,
  type SerializedWorkItem,
  type SerializedWorkstream,
  type WorkItem,
  type Workstream,
  type WorkstreamSnapshot,
} from './types.js';

const DEBOUNCE_MS = 250;

/** Completed workstream snapshots remain available until explicitly removed. */
const MAX_TERMINAL_SNAPSHOTS = Infinity;
const TERMINAL_SNAPSHOT_MAX_AGE_MS = Infinity;

/**
 * Age TTL for `.unrecognized` quarantine files.
 *
 * 30 days, deliberately longer than the terminal-snapshot TTL, because these
 * files are FORENSIC: they exist precisely because something went wrong
 * (torn write, foreign/newer writer, bad shape), and the person who has to
 * explain it may not look for weeks. A month is long enough for a bug report
 * to reach someone and short enough that a repeatedly-crashing host does not
 * keep litter forever.
 */
const QUARANTINE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Count cap on quarantine files, a crash loop can mint one per resume, so the age TTL alone is not a bound. Newest are kept. */
const MAX_QUARANTINE_FILES = 20;

/**
 * Minimum age for recognized native temporary files. Age alone never proves
 * abandonment: cleanup also requires a proven-dead writer and original file.
 */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Periodic housekeeping interval for {@link attachDebouncedWriter}, reaping must not be resume-only for a long-lived engine. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const QUARANTINE_SUFFIX = '.unrecognized';
const TEMP_SUFFIX = '.tmp';

function serializeWorkItem(item: WorkItem): SerializedWorkItem {
  return { ...item, visits: Object.fromEntries(item.visits) };
}

function deserializeWorkItem(raw: SerializedWorkItem): WorkItem {
  // `dependsOn` defaults to [] for snapshots written before the
  // field existed, so an older snapshot deserializes as an un-gated item rather
  // than crashing the dependency pre-pass on an undefined array.
  return { ...raw, dependsOn: raw.dependsOn ?? [], visits: new Map(Object.entries(raw.visits)) };
}

export function serializeWorkstream(workstream: Workstream): SerializedWorkstream {
  return { ...workstream, items: workstream.items.map(serializeWorkItem) };
}

export function deserializeWorkstream(serialized: SerializedWorkstream): Workstream {
  return { ...serialized, items: serialized.items.map(deserializeWorkItem) };
}

/** JSON.stringify a schema-versioned envelope. Returns null on serialization failure rather than throwing. */
export function serializeWorkstreamSnapshot(workstream: Workstream, completedResults: readonly PhaseResult[]): string | null {
  const snapshot: WorkstreamSnapshot = {
    schemaVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    writtenAt: Date.now(),
    workstream: serializeWorkstream(workstream),
    completedResults,
  };
  try {
    return JSON.stringify(snapshot);
  } catch (error) {
    logger.error('orchestration persistence: JSON serialization failed', { workstreamId: workstream.id, error: summarizeError(error) });
    return null;
  }
}

/**
 * Parses a snapshot. A snapshot written by a newer runtime (a higher
 * schemaVersion) is rejected (fail closed)
 * rather than partially trusted.
 */
function parseSnapshotJson(json: string): unknown {
  try { return JSON.parse(json) as unknown; }
  catch { logger.error('orchestration persistence: invalid snapshot JSON'); return undefined; }
}

function isFutureSnapshot(raw: unknown): boolean {
  return raw !== null && typeof raw === 'object' && 'schemaVersion' in raw
    && typeof raw.schemaVersion === 'number' && raw.schemaVersion > CURRENT_WORKSTREAM_SCHEMA_VERSION;
}

export function deserializeWorkstreamSnapshot(json: string): WorkstreamSnapshot | null {
  return snapshotValue(parseSnapshotJson(json));
}

function snapshotValue(raw: unknown): WorkstreamSnapshot | null {
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== 'object') {
    logger.warn('orchestration persistence: invalid snapshot JSON, not an object');
    return null;
  }
  const candidate = raw as Partial<WorkstreamSnapshot>;
  if (typeof candidate.schemaVersion !== 'number') {
    logger.warn('orchestration persistence: invalid snapshot JSON, missing schemaVersion');
    return null;
  }
  if (candidate.schemaVersion > CURRENT_WORKSTREAM_SCHEMA_VERSION) {
    logger.error('orchestration persistence: future schemaVersion rejected, upgrade runtime to read this snapshot', {
      schemaVersion: candidate.schemaVersion,
      supportedVersion: CURRENT_WORKSTREAM_SCHEMA_VERSION,
    });
    return null;
  }
  if (!candidate.workstream || typeof candidate.workstream !== 'object' || !Array.isArray(candidate.completedResults)) {
    logger.warn('orchestration persistence: invalid snapshot JSON, missing workstream/completedResults');
    return null;
  }
  return candidate as WorkstreamSnapshot;
}

/**
 * Where an engine's snapshots live: a state root (its snapshots go under
 * `<root>/.goodvibes/orchestration/`), or a state root plus a namespace
 * (`<root>/.goodvibes/orchestration/<namespace>/`). The contract runner runs
 * one engine per contract and names its workstreams after the contract's
 * groups (`g1`, `g2`, ...), so each contract's engine takes its contract id as
 * the namespace and two contracts' `g1` never share a file.
 */
export type SnapshotRoot = string | { readonly root: string; readonly namespace: string };

const SAFE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The snapshot directory for a state root. A namespace must be one plain path segment. */
export function orchestrationDir(location: SnapshotRoot): string {
  if (typeof location === 'string') return join(location, '.goodvibes', 'orchestration');
  if (!SAFE_NAMESPACE.test(location.namespace) || location.namespace.includes('..')) {
    throw new RangeError('orchestration snapshot namespace must be one plain path segment');
  }
  return join(location.root, '.goodvibes', 'orchestration', location.namespace);
}

function snapshotPath(projectRoot: SnapshotRoot, workstreamId: string): string {
  if (typeof workstreamId !== 'string' || /[/\\\0]/.test(workstreamId)) throw new RangeError('workstream snapshot id must be one path segment');
  return join(orchestrationDir(projectRoot), `${workstreamId}.json`);
}

/** Read + quarantine-on-corrupt (never throws, never crashes the caller on a bad file). */
export function loadWorkstreamSnapshot(projectRoot: SnapshotRoot, workstreamId: string): WorkstreamSnapshot | null {
  let path: string;
  try { path = snapshotPath(projectRoot, workstreamId); }
  catch { logger.warn('orchestration persistence: invalid snapshot location refused'); return null; }
  if (!existsSync(path)) return null;
  let source: ReturnType<typeof readFileObservation>, parent: ReturnType<typeof captureExistingDirectory>;
  try { parent = captureExistingDirectory(dirname(path)); source = readFileObservation(path); parent.assertCurrent(); }
  catch (error) {
    logger.warn('orchestration persistence: snapshot read failed', { path, error: summarizeError(error) });
    return null;
  }
  const raw = parseSnapshotJson(source.bytes.toString('utf8'));
  const snapshot = snapshotValue(raw);
  // A newer reader owns this valid future envelope. Never quarantine it as
  // corrupt, or let a later old writer replace it with an empty older state.
  if (snapshot === null && isFutureSnapshot(raw)) return null;
  if (snapshot === null) {
    const quarantinePath = `${path}.${opaqueUuid()}${QUARANTINE_SUFFIX}`;
    try {
      parent.assertCurrent();
      if (fileObservationIdentity(path) !== source.physical) return null;
      renameSync(path, quarantinePath);
      logger.warn('orchestration persistence: quarantined unrecognized snapshot', { path, quarantinePath });
    } catch (error) {
      logger.error('orchestration persistence: failed to quarantine unrecognized snapshot', { path, error: summarizeError(error) });
    }
    return null;
  }
  return snapshot;
}

/**
 * List the workstream ids with a snapshot on disk (recognized or not, callers
 * decide via loadWorkstreamSnapshot).
 *
 * This is the resume-enumeration path, so it is also the recovery point: a
 * housekeeping pass runs FIRST, so ids reclaimed by the reap are never handed
 * back to a caller that would then fail to load them.
 */
export function listSnapshotWorkstreamIds(projectRoot: SnapshotRoot, options?: SnapshotReapOptions): string[] {
  reapOrchestrationSnapshots(projectRoot, options);
  const dir = orchestrationDir(projectRoot);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length));
  } catch (error) {
    logger.warn('orchestration persistence: failed to list snapshot directory', { dir, error: summarizeError(error) });
    return [];
  }
}

// Only the actual owner object reuses its successfully read/published version
// observation. Copies/imports have no frame; changed native files are reread.
const snapshotWriteFrames = new WeakMap<Workstream, { readonly path: string; readonly physical: string }>();
const currentSnapshotPhysical = (path: string): string | null => {
  try { return fileObservationIdentity(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
};

export function writeWorkstreamSnapshot(projectRoot: SnapshotRoot, workstream: Workstream, completedResults: readonly PhaseResult[]): void {
  let path: string;
  try { path = snapshotPath(projectRoot, workstream.id); }
  catch { logger.warn('orchestration persistence: invalid snapshot location refused'); return; }
  const json = serializeWorkstreamSnapshot(workstream, completedResults);
  if (json === null) return;
  try {
    let physical = currentSnapshotPhysical(path);
    const cached = snapshotWriteFrames.get(workstream);
    if (physical !== null && (cached?.path !== path || cached.physical !== physical)) {
      const source = readFileObservation(path), raw = parseSnapshotJson(source.bytes.toString('utf8'));
      if (isFutureSnapshot(raw)) throw new Error('A newer workstream snapshot requires a newer reader');
      if (snapshotValue(raw) === null) throw new Error('An unreadable workstream snapshot must be preserved');
      physical = source.physical;
    }
    const assertCurrent = () => { if (currentSnapshotPhysical(path) !== physical) throw new Error('Original workstream snapshot changed'); };
    assertCurrent();
    let publication: string | undefined;
    writeFileAtomic(path, json, { assertCurrent, cleanupStaleTemps: false, onEffect(published) {
      if (published) publication = fileObservationIdentity(path);
    } });
    // A callback observation becomes a reusable version frame only after the
    // original writer confirms its staged image through the complete return.
    if (publication === undefined || fileObservationIdentity(path) !== publication) throw new Error('Original snapshot publication changed');
    snapshotWriteFrames.set(workstream, { path, physical: publication });
  } catch (error) {
    logger.error('orchestration persistence: snapshot write failed; original preserved', { path, error: summarizeError(error) });
  }
}

// ── Housekeeping ──────────────────────────────────────────────────────────────

/** Seams for the snapshot housekeeping pass. */
export interface SnapshotReapOptions {
  /**
   * "Is this workstream still running?", INJECTED so the reap can protect a
   * live workstream's snapshot without depending on the engine. Returning
   * `true` exempts the snapshot from every bound. When omitted, liveness is
   * inferred from the snapshot's own item states (an item that is not `passed`
   * or `failed` means the workstream is not finished), which is the
   * conservative reading.
   */
  readonly isRunning?: ((workstreamId: string) => boolean) | undefined;
  /** Clock seam (tests). Defaults to `Date.now()`. */
  readonly now?: number | undefined;
}

/** What one housekeeping pass reclaimed. Counts and byte totals only, snapshot contents are never logged. */
export interface OrchestrationSnapshotReapSummary {
  /** Terminal snapshots removed for exceeding {@link TERMINAL_SNAPSHOT_MAX_AGE_MS}. */
  readonly terminalExpired: number;
  /** Terminal snapshots removed for exceeding {@link MAX_TERMINAL_SNAPSHOTS}. */
  readonly terminalOverCap: number;
  /** Quarantine files removed for exceeding {@link QUARANTINE_MAX_AGE_MS}. */
  readonly quarantineExpired: number;
  /** Quarantine files removed for exceeding {@link MAX_QUARANTINE_FILES}. */
  readonly quarantineOverCap: number;
  /** Temp files from interrupted writes removed for exceeding {@link STALE_TEMP_MAX_AGE_MS}. */
  readonly staleTempRemoved: number;
  /** Total bytes freed. */
  readonly bytesReclaimed: number;
  /** Sum of every file count above. Zero means the pass reclaimed nothing. */
  readonly total: number;
}

const EMPTY_REAP_SUMMARY: OrchestrationSnapshotReapSummary = {
  terminalExpired: 0,
  terminalOverCap: 0,
  quarantineExpired: 0,
  quarantineOverCap: 0,
  staleTempRemoved: 0,
  bytesReclaimed: 0,
  total: 0,
};

/** A workstream is finished when no item can still move. Mirrors engine.isTerminalWorkstream. */
function isTerminalItemSet(items: readonly unknown[]): boolean {
  // An item-less workstream can never run, so it counts as finished rather
  // than pinning a snapshot in the store forever.
  return items.every(item => item !== null && typeof item === 'object' && 'state' in item
    && (item.state === 'passed' || item.state === 'failed'));
}

interface DatedFile {
  readonly path: string;
  readonly at: number;
  readonly physical: string;
  readonly size: number;
}

/** Removal is successful only for this original selected leaf and parent.
 * Missing/replaced/unavailable files are not successful reclamations. */
function removeFile(selected: DatedFile, assertParent: () => void): number | undefined {
  try {
    assertParent();
    if (fileObservationIdentity(selected.path) !== selected.physical) return undefined;
    unlinkSync(selected.path); return selected.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('orchestration persistence: original file was not removed', { path: selected.path });
    return undefined;
  }
}

/**
 * Reap the orchestration snapshot directory: terminal snapshots past their TTL
 * or over the count cap, quarantine files past theirs, and temp files left by
 * an interrupted write.
 *
 * Idempotent, a second pass immediately after a first reclaims nothing, and
 * safe to run from two processes at once: every removal tolerates ENOENT, so
 * losing a race is a no-op rather than an error.
 */
export function reapOrchestrationSnapshots(projectRoot: SnapshotRoot, options?: SnapshotReapOptions): OrchestrationSnapshotReapSummary {
  const dir = orchestrationDir(projectRoot);
  if (!existsSync(dir)) return EMPTY_REAP_SUMMARY;
  const now = options?.now ?? Date.now();

  let entries: string[], directory: ReturnType<typeof captureExistingDirectory>;
  try {
    directory = captureExistingDirectory(dir);
    entries = readdirSync(dir); directory.assertCurrent();
  } catch (error) {
    logger.warn('orchestration persistence: failed to list snapshot directory for housekeeping', { dir, error: summarizeError(error) });
    return EMPTY_REAP_SUMMARY;
  }

  const terminal: DatedFile[] = [];
  const quarantined: DatedFile[] = [];
  let staleTempRemoved = 0;
  let bytesReclaimed = 0;

  for (const entry of entries) {
    try { directory.assertCurrent(); } catch { break; }
    const path = join(dir, entry);

    const temporaryBase = /^(.*\.json)\.tmp-/.exec(entry)?.[1]
      ?? /^(.*\.json)\.[0-9]+\.[0-9]+\.tmp$/.exec(entry)?.[1];
    if (temporaryBase !== undefined || entry.endsWith(TEMP_SUFFIX)) {
      if (temporaryBase !== undefined) {
        try {
          const freed = reapOwnedAtomicTempFile(join(dir, temporaryBase), entry, { now, minimumAgeMs: STALE_TEMP_MAX_AGE_MS, legacyPidTimestamp: true });
          if (freed !== undefined) { staleTempRemoved += 1; bytesReclaimed += freed; }
        } catch { /* Unknown physical ownership preserves the listed file. */ }
      }
      continue;
    }

    if (entry.endsWith(QUARANTINE_SUFFIX)) {
      try {
        const source = readFileObservation(path); directory.assertCurrent();
        let raw: unknown;
        try { raw = JSON.parse(source.bytes.toString('utf8')) as unknown; } catch { /* Ordinary corrupt forensic snapshot. */ }
        if (isFutureSnapshot(raw)) continue;
        const at = statSync(path).mtimeMs;
        if (fileObservationIdentity(path) !== source.physical) continue;
        quarantined.push({ path, at, physical: source.physical, size: source.bytes.byteLength });
      } catch { /* Unavailable or replaced original is left untouched. */ }
      continue;
    }

    if (!entry.endsWith('.json')) continue;

    const workstreamId = entry.slice(0, -'.json'.length);
    if (options?.isRunning?.(workstreamId) === true) continue;
    try { directory.assertCurrent(); } catch { break; }

    // Decide terminal-ness by CONTENT: a snapshot that does not parse or does
    // not validate is left alone here so loadWorkstreamSnapshot can quarantine
    // it with its existing disclosure, rather than being deleted outright.
    let source: ReturnType<typeof readFileObservation>;
    try { source = readFileObservation(path); directory.assertCurrent(); }
    catch { continue; }
    const snapshot = deserializeWorkstreamSnapshot(source.bytes.toString('utf8'));
    if (snapshot === null) continue;
    // deserializeWorkstreamSnapshot validates the envelope, not every field, so
    // the item list is re-checked here rather than assumed.
    const items: unknown = snapshot.workstream.items;
    if (!Array.isArray(items) || !isTerminalItemSet(items)) continue;
    const writtenAt = typeof snapshot.writtenAt === 'number' && Number.isFinite(snapshot.writtenAt) ? snapshot.writtenAt : 0;
    terminal.push({ path, at: writtenAt, physical: source.physical, size: source.bytes.byteLength });
  }

  let terminalExpired = 0;
  const withinTtl: DatedFile[] = [];
  for (const file of terminal) {
    if (now - file.at > TERMINAL_SNAPSHOT_MAX_AGE_MS) {
      const removed = removeFile(file, () => directory.assertCurrent());
      if (removed !== undefined) { bytesReclaimed += removed; terminalExpired += 1; }
      continue;
    }
    withinTtl.push(file);
  }

  let terminalOverCap = 0;
  if (withinTtl.length > MAX_TERMINAL_SNAPSHOTS) {
    const oldestFirst = [...withinTtl].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, withinTtl.length - MAX_TERMINAL_SNAPSHOTS)) {
      const removed = removeFile(file, () => directory.assertCurrent());
      if (removed !== undefined) { bytesReclaimed += removed; terminalOverCap += 1; }
    }
  }

  let quarantineExpired = 0;
  const quarantineWithinTtl: DatedFile[] = [];
  for (const file of quarantined) {
    if (now - file.at > QUARANTINE_MAX_AGE_MS) {
      const removed = removeFile(file, () => directory.assertCurrent());
      if (removed !== undefined) { bytesReclaimed += removed; quarantineExpired += 1; }
      continue;
    }
    quarantineWithinTtl.push(file);
  }

  let quarantineOverCap = 0;
  if (quarantineWithinTtl.length > MAX_QUARANTINE_FILES) {
    const oldestFirst = [...quarantineWithinTtl].sort((a, b) => a.at - b.at);
    for (const file of oldestFirst.slice(0, quarantineWithinTtl.length - MAX_QUARANTINE_FILES)) {
      const removed = removeFile(file, () => directory.assertCurrent());
      if (removed !== undefined) { bytesReclaimed += removed; quarantineOverCap += 1; }
    }
  }

  const total = terminalExpired + terminalOverCap + quarantineExpired + quarantineOverCap + staleTempRemoved;
  const summary: OrchestrationSnapshotReapSummary = {
    terminalExpired,
    terminalOverCap,
    quarantineExpired,
    quarantineOverCap,
    staleTempRemoved,
    bytesReclaimed,
    total,
  };

  if (total > 0) {
    logger.info('orchestration persistence: reclaimed snapshot files', {
      dir,
      terminalExpired,
      terminalOverCap,
      quarantineExpired,
      quarantineOverCap,
      staleTempRemoved,
      bytesReclaimed,
      total,
    });
  }
  return summary;
}

/**
 * Debounced trailing writer (250ms), subscribing to engine lifecycle events. Returns an
 * unsubscribe function that also flushes any pending timers.
 *
 * Also owns the PERIODIC housekeeping pass: an engine can stay attached for
 * days, so reaping only at resume would let a long-lived process accumulate
 * finished snapshots for its whole lifetime. The interval timer is unref'd, so
 * it never keeps a process alive, and it is cleared by the returned detach
 * function.
 *
 * @param sweepIntervalMs - Housekeeping interval; `0` disables the timer (tests, short-lived hosts).
 */
export function attachDebouncedWriter(
  projectRoot: SnapshotRoot,
  getWorkstream: (workstreamId: string) => Workstream | null,
  getCompletedResults: (workstreamId: string) => readonly PhaseResult[],
  subscribe: (listener: (event: OrchestrationEvent) => void) => () => void,
  sweepIntervalMs: number = SWEEP_INTERVAL_MS,
): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  // A workstream the engine still holds AND that has not finished is exempt
  // from every bound, its snapshot is the resume point.
  const isRunning = (workstreamId: string): boolean => {
    const workstream = getWorkstream(workstreamId);
    return workstream !== null && !isTerminalItemSet(workstream.items);
  };

  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  if (sweepIntervalMs > 0) {
    sweepTimer = setInterval(() => {
      reapOrchestrationSnapshots(projectRoot, { isRunning });
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  function scheduleWrite(workstreamId: string): void {
    const existing = timers.get(workstreamId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(workstreamId);
      const workstream = getWorkstream(workstreamId);
      if (!workstream) return;
      writeWorkstreamSnapshot(projectRoot, workstream, getCompletedResults(workstreamId));
    }, DEBOUNCE_MS);
    timer.unref?.();
    timers.set(workstreamId, timer);
  }

  const unsubscribe = subscribe((event) => {
    // 'dirty-tree-at-launch' (see CHANGELOG 0.38.0) is engine-wide, not
    // workstream-scoped, it has no workstreamId to schedule a write for.
    if (event.type === 'dirty-tree-at-launch') return;
    scheduleWrite(event.workstreamId);
  });

  return () => {
    unsubscribe();
    // A write still waiting is the latest state: it is written now, since the
    // snapshot is what a restart resumes from.
    for (const [workstreamId, timer] of timers) {
      clearTimeout(timer);
      const workstream = getWorkstream(workstreamId);
      if (workstream) writeWorkstreamSnapshot(projectRoot, workstream, getCompletedResults(workstreamId));
    }
    timers.clear();
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };
}
