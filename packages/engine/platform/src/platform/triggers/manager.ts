/**
 * manager.ts, the trigger supervisor.
 *
 * Owns all three watcher kinds over one spine: the same backoff ladder, the
 * same strike breaker, the same bounded history, the same recovery
 * housekeeping. The kinds differ only in how an observation is produced,
 * a probe, a matched stream batch, or a child process ending.
 *
 * Everything with an effect is injected (probe I/O, process host, stream host,
 * action executor, clock), so the policy in this file is exercisable end to end
 * without a network, a subprocess or a real daemon.
 *
 * Nothing runs, and nothing is written, until the family is on and a trigger
 * exists: `start()` with no stored trigger takes no lock, creates no file and
 * starts no timer. Creating the first trigger brings the supervisor up.
 *
 * Saving is per trigger: a change writes that one trigger's row. A save that
 * fails fails only that save: the record stays in memory with
 * `lastError: "not saved: …"`, the save is retried on the next tick, and every
 * other trigger carries on.
 */

import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { structuredTransience, type FailureTransience } from '@goodvibes/engine/errors';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { summarizeError } from '../utils/error-display.js';
import { newIncarnation } from '../utils/target-ref.js';
import { logger } from '../utils/logger.js';
import { outsideEveryCall } from '../utils/outside-every-call.js';
import { noteListChanged } from '../runtime/list-changes.js';
import { projectIdentityOf } from '../workspace/project-identity.js';

/** The project a trigger's notice names (its folder's project), or nothing for a trigger kept with no project. */
function triggerProjectOf(folder: string | undefined): { readonly project?: string } {
  return folder ? { project: projectIdentityOf(folder) } : {};
}
import { TriggerManagerWork, stopTriggerResources } from './manager-work.js';
import { restartDueStreams } from './manager-stream-restarts.js';
import { runExtract, storedObservation, toObservation } from './extract.js';
import { captureRegisteredGrantAction, createActionGrant, verifyGrant, type RegisterGrantInput } from './grants.js';
import {
  buildCancelledTermination,
  buildDaemonRestartTermination,
  buildTermination,
  DEFAULT_ON_EXIT_MAX_DURATION_MS,
  launchOnExitProcess,
  renderOnExitPrompt,
  type TriggerProcessHost,
} from './process-triggers.js';
import { createDefaultProbeIo, probeHostRefusal, runProbe } from './probes.js';
import { evaluateRule } from './rules.js';
import {
  boundEventLog,
  boundRecord,
  sweepTriggers,
  TriggerStore,
  TriggerStoreError,
  TriggerStoreOwnershipError,
  type TriggerRetentionPolicy,
} from './store.js';
import { applyFailure, applySuccess, backoffDelayFor, checkReset, holdsAgainstCheckResult, isDue, resetBreaker, triggerLifecycle, resolveSupervisionPolicy, type SupervisionPolicy } from './supervision.js';
import { activateStreamTrigger, startStreamTrigger, type StreamOwner, type StreamRuntime } from './manager-streams.js';
import type {
  ConditionTriggerSpec, OnExitTriggerSpec, StreamTriggerSpec, TerminationMetadata, TriggerActionGrant, TriggerDefinition,
  TriggerEventLogEntry, TriggerFireAction, TriggerRecord, TriggerRecoveryReport, TriggerRunRecord,
} from './types.js';
import { validateDefinition } from './validation.js';
import type { TriggerSpec } from './types.js';

/**
 * The id a trigger is stored under: the name a person chose and a part made from his project (its identity) and that
 * name alone (`<name>-<8 hex>`). It is made the same way whatever any other project holds, so it never says whether
 * another project has a trigger of that name; the chosen name is kept beside it (`chosenId`) and is what people see.
 */
export function storedTriggerId(chosen: string, project: string): string {
  return `${chosen}-${createHash('sha256').update(`${project}\u0000${chosen}`).digest('hex').slice(0, 8)}`;
}

/**
 * A command the definition gives no folder of its own runs in the trigger's project, never the daemon's folder; a file
 * it watches by a relative path is the project's file (3.5.0 read it from the folder its daemon ran in, which was the
 * project; the daemon's own process folder is no project).
 */
function inProjectFolder(spec: TriggerSpec, folder: string | undefined): TriggerSpec {
  if (!folder) return spec;
  if ((spec.kind === 'stream' || spec.kind === 'on-exit') && spec.cwd === undefined) return { ...spec, cwd: folder };
  if (spec.kind === 'condition' && spec.probe.kind === 'command' && spec.probe.cwd === undefined) return { ...spec, probe: { ...spec.probe, cwd: folder } };
  if (spec.kind === 'condition' && spec.probe.kind === 'file' && !isAbsolute(spec.probe.path)) return { ...spec, probe: { ...spec.probe, path: resolve(folder, spec.probe.path) } };
  return spec;
}
import { retentionFrom, TriggerDisabledError, type TriggerManagerConfig, type TriggerManagerOptions } from './manager-types.js';
import { WORK_ADMISSION_RECHECK_MS } from '../daemon/work-admission.js';
import { stampExposure } from '../security/conversation-exposure.js';

export * from './manager-types.js';

/** The rule state a condition firing replaced, kept so a failed action can give it back. */
interface RuleRollback { readonly restore: TriggerRecord['ruleState']; readonly applied: TriggerRecord['ruleState'] }

/** Prefix of the `lastError` a failed save leaves on a record until the save is retried. */
const NOT_SAVED = 'not saved: ';

/** Undelivered stream batches kept per trigger after their stream ended; the oldest gives way beyond this. */
const MAX_OWED_STREAM_BATCHES = 8;

function emptyReport(now: number): TriggerRecoveryReport {
  return { at: now, reason: 'startup', triggersLoaded: 0, triggersReaped: 0, reapedIds: [], runsReaped: 0, observationsReaped: 0, eventsReaped: 0, orphanedProcesses: [] };
}

function unknownTrigger(id: string): RefusalError {
  return new RefusalError(refusal({ code: 'TRIGGER_NOT_FOUND', state: `no trigger has the id "${id}"`, reason: `There is no trigger "${id}"`, next: ['List the triggers to see their ids'], status: 404 }));
}

/** Failures with no structure to read are retried: the strike budget bounds them. No model is asked. */
function transienceOf(error: unknown): FailureTransience {
  return structuredTransience(error) ?? { failureClass: 'retryable', basis: 'no-wording', detail: 'the failure states no category; retried within the strike budget' };
}

export class TriggerManager {
  private readonly options: TriggerManagerOptions;
  private readonly records = new Map<string, TriggerRecord>();
  private readonly grants = new Map<string, TriggerActionGrant>();
  private readonly streams = new Map<string, StreamRuntime>();
  private eventLog: TriggerEventLogEntry[] = [];
  private policy: SupervisionPolicy;
  private retention: TriggerRetentionPolicy;
  private readonly daemonBootId: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private supervisionTimer: ReturnType<typeof setInterval> | null = null;
  /** The supervision pass in progress: a tick that finds one running returns (an action slower than a tick is not started twice). */
  private supervising: Promise<void> | null = null;
  /** The delivery claim on each trigger's owed head batch: only the claim that delivered it removes it. */
  private readonly owedDelivering = new Map<string, number>();
  private owedEpoch = 0;
  private inFlight = new Set<string>();
  /**
   * One incarnation per trigger record in this process, fresh on create: a
   * probe started for a trigger that was removed (and an id reused) while it
   * ran carries the old incarnation, and its result is dropped instead of
   * landing on the new trigger.
   */
  private readonly incarnations = new Map<string, string>();
  private incarnationOf(id: string): string {
    let incarnation = this.incarnations.get(id);
    if (incarnation === undefined) this.incarnations.set(id, incarnation = newIncarnation());
    return incarnation;
  }
  private readonly restartingStreams = new Set<string>();
  /** This process owns the store and its records are the live ones. */
  private loaded = false;
  /** The records held are a read-only copy; set when another process owns the store, or the family is off. */
  private observing: 'other-process' | 'off' | null = null;
  /** Ids in the store, so a change writes only the state and never the definition again. */
  private readonly stored = new Set<string>();
  /** Each saved trigger's project, so the notice of its removal names the project it was of (its record is gone). */
  private readonly storedProjects = new Map<string, string | undefined>();
  /** Ids whose last save failed (or whose removal did); retried on the next tick. */
  private readonly unsaved = new Set<string>();
  private lastRecovery: TriggerRecoveryReport | null = null;
  private readonly store: TriggerStore;
  private readonly work: TriggerManagerWork;
  private unwatchEnabled: (() => void) | null = null;

  constructor(options: TriggerManagerOptions) {
    this.options = { ...options };
    this.store = new TriggerStore(options.storePath);
    // Released only after admitted work has drained, so an action that finishes during shutdown is still saved.
    this.work = new TriggerManagerWork(() => { this.loaded = false; this.store.release(); });
    const initial = typeof options.config === 'function' ? options.config() : options.config;
    this.policy = resolveSupervisionPolicy(initial);
    this.retention = retentionFrom(initial);
    this.daemonBootId = options.daemonBootId ?? randomUUID();
    this.unwatchEnabled = options.watchEnabled?.((enabled) => {
      if (!enabled || this.work.stopped) return;
      try { this.start(); } catch (error) { logger.warn('Trigger supervision could not start', { error: summarizeError(error) }); }
    }) ?? null;
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * A trigger kept with no project (3.5.0 kept none) works in the folder it worked in then (`unplacedFolder`), given
   * at every load: its definition is stored once and never written again, and a 3.5.0 binary after a rollback reads it
   * as it was.
   */
  private placed(record: TriggerRecord): TriggerRecord {
    const folder = this.options.unplacedFolder;
    const placed = !folder || record.definition.workingDirectory !== undefined ? record
      : { ...record, definition: { ...record.definition, workingDirectory: folder, spec: inProjectFolder(record.definition.spec, folder) } };
    return this.heldWithoutProject(placed);
  }

  /**
   * A trigger with no project (or the daemon's own folder) is held, never run: its breaker open with the reason, until
   * the owner gives it a project (or removes it). Nothing runs in the daemon's own folder.
   */
  private heldWithoutProject(record: TriggerRecord): TriggerRecord {
    const why = this.options.projectRefusal?.(record.definition.workingDirectory);
    if (!why || record.state === 'circuit-open' || record.state === 'cancelled' || record.state === 'fired' || record.state === 'failed') return record;
    const now = this.now();
    const held = `held: ${why}, so it does not run (never in the daemon's own folder). Give it a project (make it again from the project it is for), or remove it`;
    return { ...record, state: 'circuit-open', nextCheckAt: undefined, updatedAt: now, lastError: held,
      runs: [...record.runs, { at: now, outcome: 'skipped', detail: held }] };
  }

  private get config(): TriggerManagerConfig {
    const source = this.options.config;
    return typeof source === 'function' ? source() : source;
  }

  private requireEnabled(operation: string): void {
    if (!this.config.enabled) throw new TriggerDisabledError(operation);
  }

  /** The last recovery/sweep report, what was reaped, and why. */
  get recoveryReport(): TriggerRecoveryReport | null {
    return this.lastRecovery;
  }

  /** The kept recovery reports that removed or skipped something, oldest first. */
  recoveryHistory(): readonly TriggerRecoveryReport[] {
    return this.store.reports();
  }

  get executionOwnership(): 'local' | 'other-process' | 'unclaimed' {
    if (this.loaded && !this.work.stopped) return 'local';
    return this.observing === 'other-process' ? 'other-process' : 'unclaimed';
  }

  /** The database the triggers live in. */
  get storePath(): string { return this.store.path; }

  /** Inspection never takes ownership or sweeps. */
  inspectRecords(): readonly TriggerRecord[] {
    if (this.loaded) return [...this.records.values()];
    return this.store.hasData() ? this.store.read(this.retention.eventLogLimit).records : [];
  }

  get bootId(): string {
    return this.daemonBootId;
  }

  /**
   * Recover as the supervisor: take the lock, read every row, run the startup
   * sweep and save what it changed. When another process holds the lock this
   * throws, unless `readOnlyAllowed`, in which case the records are read as a
   * copy and the report says nothing was swept.
   */
  load(readOnlyAllowed = false): TriggerRecoveryReport {
    if (this.work.stopped) throw new TriggerStoreError(this.store.path, 'load', new Error('this trigger supervisor was shut down'));
    if (this.loaded && this.lastRecovery) return this.lastRecovery;
    if (!this.store.claim()) {
      if (!readOnlyAllowed) throw new TriggerStoreOwnershipError();
      return this.observe('other-process');
    }
    let contents: ReturnType<TriggerStore['read']>;
    try { contents = this.store.read(this.retention.eventLogLimit); }
    catch (error) { this.store.release(); throw error; }
    this.observing = null;
    const now = this.now();
    const swept = sweepTriggers({
      triggers: contents.records,
      eventLog: contents.eventLog,
      policy: this.retention,
      now,
      reason: 'startup',
      ...(this.options.sessionIsLive ? { sessionIsLive: this.options.sessionIsLive } : {}),
      ...(this.options.processHost
        ? { processIsLive: (pid: number, startedAt: number) => this.options.processHost!.isSameProcessAlive(pid, startedAt) }
        : {}),
      ...(contents.skipped.length > 0 ? { quarantined: `rows that did not read back were left in ${this.store.path}: ${contents.skipped.join(', ')}` } : {}),
    });

    this.records.clear();
    this.stored.clear();
    this.storedProjects.clear();
    const kept = new Set(swept.triggers);
    for (const record of contents.records) { this.stored.add(record.definition.id); this.storedProjects.set(record.definition.id, record.definition.workingDirectory); }
    for (const record of swept.triggers) this.records.set(record.definition.id, this.reviveAfterRestart(this.placed(record), now));
    this.grants.clear();
    for (const grant of contents.grants) this.grants.set(grant.id, grant);
    this.eventLog = [...swept.eventLog];
    this.loaded = true;
    for (const record of contents.records) if (!kept.has(record) || this.records.get(record.definition.id) !== record) this.persist(record.definition.id);
    this.keepReport(swept.report);
    this.lastRecovery = swept.report;
    this.reconcileOnExitAfterRestart(now);
    return swept.report;
  }

  /** A read-only copy of what is stored, for a process that is not the supervisor. */
  private observe(why: 'other-process' | 'off'): TriggerRecoveryReport {
    const now = this.now();
    const contents = this.store.hasData() ? this.store.read(this.retention.eventLogLimit) : { records: [], grants: [], eventLog: [], skipped: [] };
    this.observing = why;
    this.records.clear(); for (const record of contents.records) this.records.set(record.definition.id, record);
    this.grants.clear(); for (const grant of contents.grants) this.grants.set(grant.id, grant);
    this.eventLog = [...contents.eventLog];
    const report = { ...emptyReport(now), triggersLoaded: contents.records.length };
    this.lastRecovery = report;
    return report;
  }

  /**
   * What a restart leaves behind, made honest. A stream saved as running has no
   * child: it is made due so the next tick starts it. An on-exit action that was
   * being delivered when the process stopped is delivered again when it is an
   * agent turn; an approved command is not run twice unasked: it waits for a reset.
   */
  private reviveAfterRestart(record: TriggerRecord, now: number): TriggerRecord {
    if (record.definition.spec.kind === 'stream' && record.state === 'running' && !this.streams.has(record.definition.id)) {
      return { ...record, state: 'idle', nextCheckAt: now, updatedAt: now,
        runs: [...record.runs, { at: now, outcome: 'skipped', detail: 'daemon restarted while the stream was running; it will be started again' }] };
    }
    if (record.state === 'firing') {
      if (record.definition.action.kind === 'agent-turn') {
        return { ...record, state: 'backoff', nextCheckAt: now, updatedAt: now,
          runs: [...record.runs, { at: now, outcome: 'skipped', detail: 'the daemon restarted while delivering this action; delivering it again' }] };
      }
      return { ...record, state: 'circuit-open', nextCheckAt: undefined, updatedAt: now,
        lastError: 'the daemon restarted while the approved command was running; it may have run. Reset the trigger to run it again',
        runs: [...record.runs, { at: now, outcome: 'skipped', detail: 'the daemon restarted while the approved command was running; not run again without a reset' }] };
    }
    return record;
  }

  /**
   * An on-exit child from before a daemon restart cannot be observed, only
   * checked for liveness (one `kill(pid, 0)` per tick). While it is alive and
   * inside its duration cap the trigger keeps waiting; once it is gone (or the
   * cap passed) the action fires once, saying the exit status was not observed.
   */
  private reconcileOnExitAfterRestart(now: number): void {
    if (!this.config.enabled || !this.loaded) return;
    const host = this.options.processHost;
    for (const record of [...this.records.values()]) {
      const spec = record.definition.spec;
      if (spec.kind !== 'on-exit' || record.state !== 'running') continue;
      if (!record.process || record.process.daemonBootId === this.daemonBootId) continue;
      const cap = spec.maxDurationMs ?? this.config.onExitMaxDurationMs ?? DEFAULT_ON_EXIT_MAX_DURATION_MS;
      const alive = host?.isSameProcessAlive(record.process.pid, record.process.startedAt) === true;
      if (alive && now < record.process.startedAt + cap) continue;
      const termination = buildDaemonRestartTermination({
        process: record.process,
        now,
        note: alive
          ? `The daemon restarted while this ran. The same process (pid ${record.process.pid}, started at the same time) was still alive when its ${Math.round(cap / 60_000)}-minute limit passed; how it ended was not observed.`
          : 'The daemon restarted while this ran. It has since ended; its exit status was not observed.',
      });
      void this.fireOnExit(record.definition.id, termination, now).catch((error: unknown) => {
        logger.warn('Trigger daemon-restart fire failed', { triggerId: record.definition.id, error: summarizeError(error) });
      });
    }
  }

  /**
   * Recover and supervise, but only when the family is on and a trigger (or
   * grant) is stored. Otherwise this takes no lock, creates no file and starts
   * no timer; creating a trigger starts the supervisor then.
   */
  start(): TriggerRecoveryReport {
    if (!this.config.enabled || !this.store.hasData()) return this.lastRecovery ?? emptyReport(this.now());
    return this.bringUp(true);
  }

  private bringUp(readOnlyAllowed: boolean): TriggerRecoveryReport {
    this.work.start();
    const report = this.load(readOnlyAllowed);
    // An observer runs no sweeps or checks, but its tick keeps retrying the lock so it takes over when the owner exits.
    if (this.loaded) this.startSweep();
    if (!this.supervisionTimer) {
      const interval = Math.max(250, this.config.supervisionTickMs ?? 1_000);
      // Armed in the process's own context, never the request that made the first trigger (utils/outside-every-call.ts):
      // every later check and every turn it fires runs as no caller, each trigger taking its project from its record.
      this.supervisionTimer = outsideEveryCall(() => setInterval(() => {
        void this.supervisionTick();
      }, interval));
      this.supervisionTimer.unref?.();
    }
    return report;
  }

  /**
   * The supervisor for a change: brings it up when it is not, refuses when
   * another process owns it. Stopping a trigger (cancel, remove) works with the
   * family off; it takes ownership without starting any timer.
   */
  private ensureOwner(operation: string, needsOn = true): void {
    if (needsOn) this.requireEnabled(operation);
    if (this.loaded) return;
    this.observing = null;
    if (this.config.enabled) { this.bringUp(false); return; }
    this.work.start();
    this.load(false);
  }

  /** Makes the in-memory records current for a read: the live ones, or a fresh copy when this process is not the supervisor. */
  private readable(): boolean {
    if (this.loaded) return true;
    if (!this.store.hasData()) return false;
    if (this.config.enabled && this.observing !== 'other-process' && !this.work.stopped) { this.bringUp(true); return true; }
    this.observe(this.config.enabled && this.observing === 'other-process' ? 'other-process' : 'off');
    return true;
  }

  /** One supervision pass: retry failed saves, reap finished children, then run due checks. */
  async supervisionTick(): Promise<void> {
    if (!this.config.enabled) return;
    // Single-flight: one pass at a time.
    if (this.supervising !== null) return;
    const pass = this.supervisionPass();
    this.supervising = pass;
    try { await pass; } finally { if (this.supervising === pass) this.supervising = null; }
  }

  private async supervisionPass(): Promise<void> {
    try {
      if (!this.loaded) {
        // An observer only probes the lock (re-entrant once taken); the store is read when the owner has gone, not every tick.
        if (this.observing === 'other-process' && !this.store.claim()) return;
        this.load(true);
        if (!this.loaded) return;
        this.startSweep();
      }
      this.retryUnsaved();
      await this.pollProcesses();
      await this.deliverOwedStreamBatches();
      await this.tick();
    } catch (error) {
      logger.warn('Trigger supervision tick failed', { error: summarizeError(error) });
    }
  }

  /** Starts the recurring housekeeping sweep. A daemon that only sweeps at boot never sweeps. */
  startSweep(): void {
    if (this.sweepTimer) return;
    const interval = Math.max(10_000, this.config.sweepIntervalMs ?? 300_000);
    this.sweepTimer = outsideEveryCall(() => setInterval(() => { try { this.sweep(); } catch (error) { logger.warn('Trigger sweep failed', { error: summarizeError(error) }); } }, interval));
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Only the supervisor reaps and publishes a sweep. */
  sweep(): TriggerRecoveryReport {
    this.load();
    const now = this.now();
    const before = new Map(this.records);
    const swept = sweepTriggers({
      triggers: [...this.records.values()],
      eventLog: this.eventLog,
      policy: this.retention,
      now,
      reason: 'sweep',
      ...(this.options.sessionIsLive ? { sessionIsLive: this.options.sessionIsLive } : {}),
      ...(this.options.processHost
        ? { processIsLive: (pid: number, startedAt: number) => this.options.processHost!.isSameProcessAlive(pid, startedAt) }
        : {}),
    });
    this.records.clear();
    for (const record of swept.triggers) this.records.set(record.definition.id, record);
    this.eventLog = [...swept.eventLog];
    for (const [id, record] of before) if (this.records.get(id) !== record) this.persist(id);
    let eventsReaped = swept.report.eventsReaped;
    try { eventsReaped = Math.max(eventsReaped, this.store.trimEvents(now - this.retention.eventLogTtlMs, this.retention.eventLogLimit)); }
    catch (error) { logger.warn('Trigger correlation log could not be trimmed', { error: summarizeError(error) }); }
    const report = { ...swept.report, eventsReaped };
    this.keepReport(report);
    this.lastRecovery = report;
    return report;
  }

  private keepReport(report: TriggerRecoveryReport): void {
    try { this.store.appendReport(report); }
    catch (error) { logger.warn('Trigger recovery report could not be kept', { error: summarizeError(error) }); }
  }

  /** Stops timers and supervised streams. Saved state is left intact. */
  shutdown(): void {
    this.unwatchEnabled?.();
    this.unwatchEnabled = null;
    this.work.stop();
    this.stopSweep();
    if (this.supervisionTimer) clearInterval(this.supervisionTimer);
    this.supervisionTimer = null;
    this.work.finishStop(stopTriggerResources(this.streams, this.options.streamHost, this.options.processHost));
  }

  join(): Promise<void> { return this.work.join(); }

  /**
   * Saves one trigger's row, or removes it when the trigger is gone. A failed
   * save is reported on that record and retried on the next tick; a record
   * whose data cannot be encoded at all is stopped, alone.
   */
  private persist(id: string): boolean {
    if (!this.loaded) return false;
    let record = this.records.get(id);
    try {
      if (!record) {
        if (this.stored.has(id)) {
          this.store.remove(id); this.stored.delete(id);
          // The removal names the project the trigger was of: only that project's screens read again.
          const folder = this.storedProjects.get(id);
          this.storedProjects.delete(id);
          noteListChanged({ list: 'triggers', change: 'deleted', id, ...triggerProjectOf(folder) });
        }
        this.unsaved.delete(id);
        return true;
      }
      if (this.unsaved.has(id) && record.lastError?.startsWith(NOT_SAVED)) {
        record = { ...record, lastError: undefined };
        this.records.set(id, record);
      }
      const known = this.stored.has(id);
      if (known) this.store.update(record);
      else { this.store.insert(record); this.stored.add(id); }
      this.storedProjects.set(id, record.definition.workingDirectory);
      this.unsaved.delete(id);
      // Every saved change of a trigger (its state, a firing, a stop or a start again) is said once it is durable.
      noteListChanged({ list: 'triggers', change: known ? 'changed' : 'created', id, ...triggerProjectOf(record.definition.workingDirectory) });
      return true;
    } catch (error) {
      const failure = error instanceof TriggerStoreError ? error : new TriggerStoreError(this.store.path, `save trigger ${id}`, error);
      this.unsaved.add(id);
      logger.warn('Trigger could not be saved; retrying on the next tick', { triggerId: id, error: failure.message });
      const current = this.records.get(id);
      if (current) {
        const cause = summarizeError(failure.cause ?? failure);
        if (failure.dataError) {
          // Nothing about this record can be stored; stop it, and only it.
          this.stopRuntime(id, current);
          this.records.set(id, { ...current, state: 'failed', nextCheckAt: undefined, lastError: `${NOT_SAVED}${cause} (${this.store.path}); this trigger was stopped` });
        } else {
          this.records.set(id, { ...current, lastError: `${NOT_SAVED}${cause} (${this.store.path})` });
        }
      }
      return false;
    }
  }

  private retryUnsaved(): void {
    for (const id of [...this.unsaved]) this.persist(id);
  }

  private stopRuntime(id: string, record: TriggerRecord): void {
    const stream = this.streams.get(id);
    if (stream) {
      if (stream.timer) clearInterval(stream.timer);
      if (stream.streamId) { this.options.streamHost?.stop(stream.streamId); stream.streamId = null; }
      this.streams.delete(id);
    }
    if (record.process && record.process.daemonBootId === this.daemonBootId) this.options.processHost?.cancel(record.process.processId);
  }

  /** Registers an owner-confirmed action grant. Owner-only: no agent tool reaches this. */
  registerGrant(input: RegisterGrantInput): TriggerActionGrant {
    this.ensureOwner('register an action grant');
    const grant = createActionGrant({ ...input, now: input.now ?? this.now() }, this.grants.get(input.id));
    this.store.saveGrant(grant);
    this.grants.set(grant.id, grant);
    noteListChanged({ list: 'triggers', change: 'changed', id: grant.id });
    return grant;
  }

  listGrants(): TriggerActionGrant[] {
    if (!this.readable()) return [];
    return [...this.grants.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  create(input: unknown): Promise<TriggerRecord> {
    // Made by a conversation that read text from outside: its turns start with what that conversation read
    // (security/conversation-exposure.ts). Read in the caller's own context, where the conversation is.
    return this.work.own(() => this.createOwned(input)).then((record) => { stampExposure(`trigger:${record.definition.id}`); return record; });
  }

  /**
   * Offers a session's tool registry to platform-tool probes; returns the
   * detach. A probe prefers the registry of the session that made its trigger.
   * Nothing to attach to when the host composed no probe tool host.
   */
  attachProbeTools(registry: import('./probe-tools.js').ProbeToolRegistry, session?: () => string | undefined): () => void {
    return this.options.probeTools?.attach(registry, session) ?? (() => {});
  }
  private async createOwned(input: unknown): Promise<TriggerRecord> {
    this.ensureOwner('create a trigger');
    const validated = validateDefinition(input);
    // A trigger works in a project: none, or the daemon's own folder, is refused (whoever asks: a route, a tool).
    const homeless = this.options.projectRefusal?.(validated.workingDirectory);
    if (homeless) {
      throw new RefusalError(refusal({ code: 'NO_PROJECT', state: 'the trigger has no project to run in', reason: `No trigger was made: ${homeless}; nothing is ever run in the daemon's own folder`,
        next: ['Make it from the project it is for (its folder named as workingDirectory)'], status: 422 }));
    }
    if (validated.spec.kind === 'condition' && validated.spec.probe.kind === 'platform-tool') {
      const probe = validated.spec.probe;
      const refused = this.options.probeTools
        ? this.options.probeTools.refusal(probe.tool, probe.input ?? {}, validated.ownerSessionId)
        : 'Platform-tool probes run on the tools of a session, and this trigger host has none; use an http, file or command probe, or create the trigger in the daemon.';
      if (refused) throw new RefusalError(refusal({ code: 'TRIGGER_PROBE_TOOL', state: `the probe's ${probe.tool} call cannot run here`, reason: refused, next: ['Probe with a tool that only reads, or with an http, file or command probe'], status: 422 }));
    }
    if (validated.spec.kind === 'condition' && validated.spec.probe.kind === 'http') {
      // The fetch tool's host policy, as written; every check applies it again with the DNS answers.
      const refused = probeHostRefusal(validated.spec.probe.url, this.options.probeHostPolicy);
      if (refused) throw new RefusalError(refusal({ code: 'TRIGGER_PROBE_HOST', state: 'the probe\'s URL may not be fetched', reason: refused, next: ['Probe a URL the fetch tool may reach, or ask the owner to change the fetch setting the refusal names'], status: 422 }));
    }
    // A trigger's id is the name a person chose: one per project, not one for every project. Taken in this project: refused,
    // naming only this project's. Taken by another project's trigger: nothing about the other is said (the stored id below
    // is made the same way whatever another project holds).
    const project = validated.workingDirectory ? projectIdentityOf(validated.workingDirectory) : '';
    const taken = [...this.records.values()].find((record) => (record.definition.chosenId ?? record.definition.id) === validated.id
      && (record.definition.workingDirectory ? projectIdentityOf(record.definition.workingDirectory) : '') === project);
    if (taken) {
      throw new RefusalError(refusal({ code: 'TRIGGER_EXISTS', state: `this project has a trigger with the id "${validated.id}"`, reason: `This project already has a trigger with id "${validated.id}"`, next: ['Pick another id, or cancel this project\'s trigger first'], status: 409 }));
    }
    // Stored under an id made from the name and this project alone (`<name>-<8 hex>`), the same way whatever any other
    // project holds: the id never says whether another project has a trigger of that name. The name the person chose
    // is kept beside it (never taken from the caller): it is what his project shows and what he types (`resolveName`).
    let id = storedTriggerId(validated.id, project);
    if (this.records.has(id)) id = `${validated.id}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const { chosenId: _sent, ...chosen } = validated;
    void _sent;
    const definition = { ...chosen, id, chosenId: validated.id, spec: inProjectFolder(validated.spec, validated.workingDirectory), action: this.captureFireableAction(validated.action) };

    const now = this.now();
    let record: TriggerRecord = {
      definition,
      state: 'idle',
      observations: [],
      runs: validated.spec.kind === 'condition' ? [] : [{ at: now, outcome: 'checked', detail: 'process launch reserved; acknowledgement unobserved' }],
      ...(validated.spec.kind === 'condition' ? {} : { lastError: 'process launch reserved; acknowledgement unobserved' }),
      ruleState: {},
      strikes: 0,
      backoffRung: 0,
      nextCheckAt: now,
      firedCount: 0,
      droppedLines: 0,
      updatedAt: now,
    };

    // The definition is saved before any command starts; a create whose save fails fails.
    const admitted = record;
    this.incarnations.set(definition.id, newIncarnation());
    this.records.set(definition.id, admitted);
    try { this.store.insert(admitted); this.stored.add(definition.id); this.storedProjects.set(definition.id, definition.workingDirectory); }
    catch (error) { this.records.delete(definition.id); throw error; }
    noteListChanged({ list: 'triggers', change: 'created', id: definition.id, ...triggerProjectOf(definition.workingDirectory) });
    let ownedStream: StreamRuntime | undefined;
    try {
      // Its child process (an on-exit command, a stream) is started in the process's own context: what its output and
      // its exit fire later runs as no caller, never as the request that made the trigger (utils/outside-every-call.ts).
      if (definition.spec.kind === 'on-exit') { const spec = definition.spec; const started = record; record = await outsideEveryCall(() => this.startOnExit(started, spec, now)); }
      else if (definition.spec.kind === 'stream') {
        const spec = definition.spec; const started = record;
        const starting = outsideEveryCall(() => this.startStream(started, spec, now)); ownedStream = this.streams.get(definition.id); record = await starting;
      }
      if (this.work.stopped || this.records.get(definition.id) !== admitted) throw new Error('the trigger supervisor stopped while the trigger was starting');
      if (record !== admitted) { record = { ...record, lastError: undefined }; this.records.set(definition.id, record); this.persist(definition.id); }
      if (definition.spec.kind === 'stream') outsideEveryCall(() => activateStreamTrigger(this.streamOwner(), definition.id));
    } catch (error) {
      // Cancel only the actual resource returned by this admitted start. No PID
      // or command-name inference may target an unrelated process.
      if (record.process) this.options.processHost?.cancel(record.process.processId);
      if (ownedStream?.streamId) { this.options.streamHost?.stop(ownedStream.streamId); ownedStream.streamId = null; }
      if (ownedStream?.timer) clearInterval(ownedStream.timer);
      if (ownedStream && this.streams.get(definition.id) === ownedStream) this.streams.delete(definition.id);
      // The caller is told this create failed, so the reserved record must not
      // stay behind: a stream would be started by a later tick, an on-exit
      // trigger would sit idle forever, and the same id could not be retried.
      const stored = this.records.get(definition.id);
      if (stored === admitted || stored === record) {
        this.records.delete(definition.id);
        this.persist(definition.id);
      }
      throw error;
    }

    return record;
  }

  /** Capture the actual registered approval before accepting a trigger. */
  private captureFireableAction(action: TriggerFireAction): TriggerFireAction {
    if (action.kind !== 'action-grant') return action;
    return captureRegisteredGrantAction([...this.grants.values()], action);
  }

  list(): TriggerRecord[] {
    if (!this.readable()) return [];
    return [...this.records.values()].sort((a, b) => a.definition.label.localeCompare(b.definition.label));
  }

  get(id: string): TriggerRecord | null {
    if (!this.readable()) return null;
    return this.records.get(id) ?? null;
  }

  /**
   * The stored id a name typed in a project means: that project's trigger of that id, else its trigger the person named
   * so (stored as `<name>-<n>` because another project's held the name first); with no project, or none of its own so
   * named, the name as it was typed (a stored id).
   */
  resolveName(name: string, project?: string | undefined): string {
    const typed = name.trim();
    if (!project || !project.trim()) return typed;
    const here = projectIdentityOf(project.trim());
    const inProject = [...this.records.values()].filter((record) => record.definition.workingDirectory !== undefined
      && projectIdentityOf(record.definition.workingDirectory) === here);
    // The name its people see first (a stored `<name>-<n>` of another name is reached by that other name).
    return inProject.find((record) => (record.definition.chosenId ?? record.definition.id) === typed)?.definition.id
      ?? inProject.find((record) => record.definition.id === typed)?.definition.id
      ?? typed;
  }

  /** Run history for one trigger, newest last. */
  history(id: string): readonly TriggerRunRecord[] {
    return this.get(id)?.runs ?? [];
  }

  /** Cancels a trigger. An on-exit trigger's supervised child is terminated. */
  cancel(id: string): TriggerRecord | null {
    if (!this.readable()) return null;
    if (!this.records.has(id)) return null;
    this.ensureOwner('cancel a trigger', false);
    const record = this.records.get(id);
    if (!record) return null;
    const refused = triggerLifecycle.check(record.state, 'cancelled');
    // A finished trigger keeps the state it finished in; cancelling it again is a no-op.
    if (!refused.ok) return record;
    const now = this.now();

    const fromEarlierBoot = record.process !== undefined && record.state === 'running' && record.process.daemonBootId !== this.daemonBootId;
    // A child of an earlier boot is not ours to signal, so the cancel records
    // no termination for it; ours is `cancel-requested` until its exit is seen.
    const termination = record.process && record.state === 'running' && !fromEarlierBoot
      ? buildCancelledTermination({ process: record.process, now }) : undefined;
    const cancelled: TriggerRecord = {
      ...record,
      state: 'cancelled',
      pendingExit: undefined,
      owedStreamBatches: undefined,
      updatedAt: now,
      runs: [...record.runs, {
        at: now,
        outcome: 'skipped',
        detail: fromEarlierBoot
          ? `cancelled by an operator; pid ${record.process!.pid} was started before the daemon restarted and was not stopped`
          : 'cancelled by an operator',
        ...(termination ? { termination } : {}),
      }],
    };
    this.records.set(id, cancelled);
    this.persist(id);
    this.stopRuntime(id, record);
    return cancelled;
  }

  remove(id: string): boolean {
    if (!this.readable() || !this.records.has(id)) return false;
    this.ensureOwner('remove a trigger', false);
    this.cancel(id);
    const removed = this.records.delete(id);
    this.incarnations.delete(id);
    this.persist(id);
    return removed;
  }

  /** Why reset(id) would be refused, or null when it would apply (or the trigger is unknown). */
  resetRefusal(id: string): string | null {
    const record = this.get(id);
    if (!record) return null;
    const homeless = this.options.projectRefusal?.(record.definition.workingDirectory);
    if (homeless) return `It is held: ${homeless}; give it a project (make it again from the project it is for), or remove it`;
    const check = checkReset(record);
    return check.ok ? null : check.reason;
  }

  /** Explicit breaker reset. The breaker never closes on its own. */
  reset(id: string): TriggerRecord | null {
    this.requireEnabled('reset a trigger');
    if (!this.readable() || !this.records.has(id)) return null;
    this.ensureOwner('reset a trigger');
    const record = this.records.get(id);
    if (!record) return null;
    if (this.options.projectRefusal?.(record.definition.workingDirectory)) {
      logger.warn('Trigger reset refused: it has no project', { triggerId: id });
      return null;
    }
    const allowed = checkReset(record);
    if (!allowed.ok) {
      logger.warn('Trigger reset refused', { triggerId: id, reason: allowed.reason });
      return null;
    }
    const next = resetBreaker(record, this.now());
    this.records.set(id, next);
    this.persist(id);
    return next;
  }

  /** Runs every condition trigger that is due. Respects the concurrency cap. */
  async tick(): Promise<void> {
    if (!this.config.enabled) return;
    this.load();
    await restartDueStreams(this.streamOwner(), this.work, this.restartingStreams);
    const now = this.now();
    const due = [...this.records.values()].filter(
      (record) => record.definition.spec.kind === 'condition' && isDue(record, now) && !this.inFlight.has(record.definition.id),
    );
    const limit = Math.max(1, this.config.maxConcurrentChecks ?? 4);
    for (let index = 0; index < due.length; index += limit) {
      const slice = due.slice(index, index + limit);
      await Promise.all(slice.map((record) => this.runCheck(record.definition.id)));
    }
  }

  /** Runs one condition check now, ignoring its schedule. */
  runCheck(id: string): Promise<TriggerRecord | null> { return this.work.own(() => this.runCheckOwned(id)); }
  private async runCheckOwned(id: string): Promise<TriggerRecord | null> {
    this.ensureOwner('run a trigger check');
    const record = this.records.get(id);
    if (!record || record.definition.spec.kind !== 'condition') return null;
    // A cancelled or finished trigger does not run, and an open breaker closes only by an operator reset.
    if (this.inFlight.has(id) || holdsAgainstCheckResult(record)) return record;
    this.inFlight.add(id);
    const spec = record.definition.spec;
    const startedAt = this.now();
    const incarnation = this.incarnationOf(id);
    try {
      const io = this.options.probeIo ?? createDefaultProbeIo({ hostPolicy: this.options.probeHostPolicy });
      const raw = await runProbe(spec.probe, io, {
        timeoutMs: this.config.probeTimeoutMs ?? 15_000,
        ...(record.definition.ownerSessionId !== undefined ? { ownerSessionId: record.definition.ownerSessionId } : {}),
      });
      const value = runExtract(spec.extract, raw);
      // The trigger was removed, and maybe made again under its id, while the
      // probe ran: this result belongs to a record that no longer exists.
      if (this.incarnations.get(id) !== incarnation) return this.records.get(id) ?? null;
      return this.applyObservation(id, value, startedAt, spec);
    } catch (error) {
      if (this.incarnations.get(id) !== incarnation) return this.records.get(id) ?? null;
      // Whether a retry can clear this failure is read from its structure; a
      // failure read as permanent parks the trigger at once.
      return this.applyCheckFailure(id, summarizeError(error), startedAt, transienceOf(error));
    } finally {
      // The mark is this check's: no other check of the id starts while it is set.
      this.inFlight.delete(id);
    }
  }

  private applyObservation(
    id: string,
    value: ReturnType<typeof runExtract>,
    startedAt: number,
    spec: ConditionTriggerSpec,
  ): TriggerRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    // Cancelled, finished or parked while the probe was in flight: the late result changes nothing.
    if (holdsAgainstCheckResult(record)) return record;
    const now = this.now();
    // The rule sees the full value of this check; the ring keeps the bounded form.
    const current = toObservation(value, now);
    const stored = storedObservation(current);
    const decision = evaluateRule(spec.rule, {
      observations: [...record.observations, current],
      ruleState: record.ruleState,
      now,
      eventLog: this.eventLog,
      selfTriggerId: id,
    });

    const success = applySuccess(spec.intervalMs ?? this.config.defaultCheckIntervalMs ?? 60_000, now);
    const run: TriggerRunRecord = {
      at: now,
      outcome: 'checked',
      detail: decision.reason,
      durationMs: now - startedAt,
    };

    let next: TriggerRecord = {
      ...record,
      ...success,
      observations: [...record.observations, stored].slice(-this.retention.observationRingSize),
      ruleState: decision.ruleState,
      runs: [...record.runs, run],
      lastError: undefined,
      updatedAt: now,
    };
    next = boundRecord(next, this.retention, now).record;
    this.records.set(id, next);
    this.persist(id);

    if (decision.fire) {
      void this.fireAction(id, decision.reason, decision.fingerprint, 'condition', undefined, { restore: record.ruleState, applied: decision.ruleState }).catch((error: unknown) => {
        logger.warn('Trigger action failed', { triggerId: id, error: summarizeError(error) });
      });
    }
    return this.records.get(id) ?? next;
  }

  private applyCheckFailure(
    id: string,
    error: string,
    startedAt: number,
    transience: FailureTransience,
  ): TriggerRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
    if (holdsAgainstCheckResult(record)) return record;
    const now = this.now();
    const outcome = applyFailure(record, this.policy, now, transience);
    const run: TriggerRunRecord = {
      at: now,
      outcome: 'failed',
      detail: outcome.readAsPermanent
        ? `${error}, breaker opened: a retry cannot clear this failure (${transience.detail}); reset it to resume`
        : outcome.breakerOpened
          ? `${error}, breaker opened after ${outcome.strikes} consecutive failures; reset it to resume`
          : `${error}, retrying in ${outcome.delayMs}ms`,
      durationMs: now - startedAt,
    };
    let next: TriggerRecord = {
      ...record,
      state: outcome.state,
      strikes: outcome.strikes,
      backoffRung: outcome.backoffRung,
      nextCheckAt: Number.isFinite(outcome.nextCheckAt) ? outcome.nextCheckAt : undefined,
      lastError: error,
      runs: [...record.runs, run],
      updatedAt: now,
    };
    next = boundRecord(next, this.retention, now).record;
    this.records.set(id, next);
    this.persist(id);
    return next;
  }

  /** Records a fire in the shared correlation log (the only entries a rule reads). */
  private appendEvent(entry: TriggerEventLogEntry): void {
    this.eventLog.push(entry);
    this.eventLog = [...boundEventLog(this.eventLog, this.retention, entry.at).eventLog];
    try { this.store.appendEvent(entry); }
    catch (error) { logger.warn('Trigger fire could not be added to the saved correlation log', { triggerId: entry.triggerId, error: summarizeError(error) }); }
  }

  // ─── Firing ─────────────────────────────────────────────────────────────────

  private fireAction(id: string, reason: string, fingerprint: string, kind: 'condition' | 'stream', promptOverride?: string, rollback?: RuleRollback): Promise<boolean> {
    return this.work.own(() => this.fireActionOwned(id, reason, fingerprint, kind, promptOverride, rollback));
  }

  /** Delivers one action; `fired` is recorded once, when it returned. Resolves whether it was delivered. */
  private async fireActionOwned(
    id: string,
    reason: string,
    fingerprint: string,
    kind: 'condition' | 'stream',
    promptOverride?: string,
    rollback?: RuleRollback,
  ): Promise<boolean> {
    this.requireEnabled('fire a trigger');
    const record = this.records.get(id);
    if (!record) return false;
    // The daemon takes no new work (a self-update's restart): nothing fires. The edge or dedup mark this firing
    // took is given back (a condition still true fires after the restart) and a stream batch stays owed.
    if (this.options.workAdmitted?.() === false) {
      if (rollback && record.ruleState === rollback.applied) {
        this.records.set(id, { ...record, ruleState: rollback.restore, updatedAt: this.now() });
        this.persist(id);
      }
      return false;
    }
    const action = record.definition.action;
    const now = this.now();
    let result: string;
    try {
      result = await this.executeAction(record.definition, action, promptOverride ?? this.defaultPrompt(record, reason));
    } catch (error) {
      const failed = this.records.get(id);
      if (failed) {
        this.records.set(id, {
          ...failed,
          runs: [...failed.runs, { at: now, outcome: 'failed', detail: `action failed (${reason}): ${summarizeError(error)}` }],
          lastError: summarizeError(error),
          // The edge or dedup mark this firing consumed is given back, so the next check
          // that still sees the condition tries the action again instead of reporting
          // "already consumed" for ever. Skipped when a later check already moved the state on.
          ...(rollback && failed.ruleState === rollback.applied ? { ruleState: rollback.restore } : {}),
          updatedAt: now,
        });
        this.persist(id);
      }
      return false;
    }
    const current = this.records.get(id);
    if (!current) return true;
    this.records.set(id, {
      ...current,
      firedCount: current.firedCount + 1,
      lastFiredAt: now,
      runs: [...current.runs, { at: now, outcome: 'fired', detail: reason, actionResult: result }],
      updatedAt: now,
    });
    this.appendEvent({ at: now, triggerId: id, kind, event: 'fired', fingerprint });
    this.persist(id);
    return true;
  }

  private defaultPrompt(record: TriggerRecord, reason: string): string {
    return [
      `A GoodVibes trigger fired.`,
      '',
      `Trigger: ${record.definition.label}`,
      record.definition.description ? `Purpose: ${record.definition.description}` : '',
      `Why it fired: ${reason}`,
      '',
      'Act on what this actually indicates. Verify before assuming anything the trigger did not directly observe.',
    ].filter((line) => line !== '').join('\n');
  }

  private async executeAction(
    definition: TriggerDefinition,
    action: TriggerFireAction,
    prompt: string,
  ): Promise<string> {
    this.requireEnabled('execute a trigger action');
    if (action.kind === 'agent-turn') {
      const prefix = action.prompt ?? '';
      return this.options.actions.runAgentTurn({
        triggerId: definition.id,
        label: definition.label,
        prompt: prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt,
        ...(action.model !== undefined ? { model: action.model } : {}),
        ...(action.deliverTo !== undefined ? { deliverTo: action.deliverTo } : {}),
        // The turn works in the project its trigger was made for.
        ...(definition.workingDirectory !== undefined ? { workingDirectory: definition.workingDirectory } : {}),
      });
    }
    const verification = verifyGrant([...this.grants.values()], action.grantId, action.digest, action.approvedAction);
    if (!verification.ok) {
      // A grant that no longer matches will not match on a retry either.
      throw new RefusalError(refusal({ code: 'TRIGGER_GRANT_CHANGED', state: `action grant "${action.grantId}" does not match what this trigger was approved for`,
        reason: verification.reason, next: ['Ask the owner to register the grant again, then create the trigger again against it'], retryable: false }));
    }
    return this.options.actions.runGrant({ triggerId: definition.id, grant: verification.grant });
  }

  // ─── on-exit ────────────────────────────────────────────────────────────────
  private async startOnExit(record: TriggerRecord, spec: OnExitTriggerSpec, now: number): Promise<TriggerRecord> {
    const host = this.options.processHost;
    if (!host) {
      throw new Error('An on-exit trigger needs a process host; none is wired on this TriggerManager.');
    }
    const stdinDefault = this.config.onExitStdin === 'empty' ? 'empty' : 'none';
    const ref = await launchOnExitProcess({
      spec,
      host,
      daemonBootId: this.daemonBootId,
      defaults: {
        ...(this.config.onExitMaxDurationMs !== undefined ? { maxDurationMs: this.config.onExitMaxDurationMs } : {}),
        stdin: stdinDefault,
      },
    });
    return { ...record, state: 'running', process: ref, nextCheckAt: now, updatedAt: now };
  }

  /** Keeps a stream batch whose action failed after its stream ended; the supervision tick delivers it again. */
  private oweStreamBatch(id: string, batch: { readonly reason: string; readonly fingerprint: string; readonly prompt: string; readonly lineCount: number }): void {
    const record = this.records.get(id);
    if (!record || record.state === 'cancelled') return;
    const now = this.now();
    const owed = [...(record.owedStreamBatches ?? []), { ...batch, attempts: 1, nextAttemptAt: now + backoffDelayFor(this.policy, 0) }];
    // Bounded like the stream queue: the oldest owed batch gives way, and the record says how many lines that was.
    const over = Math.max(0, owed.length - MAX_OWED_STREAM_BATCHES);
    const given = owed.slice(0, over).reduce((lines, entry) => lines + entry.lineCount, 0);
    this.records.set(id, {
      ...record,
      owedStreamBatches: owed.slice(over),
      ...(over > 0 ? { runs: [...record.runs, { at: now, outcome: 'failed' as const, detail: `${given} owed matched line(s) were dropped: more than ${MAX_OWED_STREAM_BATCHES} undelivered batches` }] } : {}),
      updatedAt: now,
    });
    this.persist(id);
  }

  /** Delivers owed stream batches that are due, oldest first, one per trigger per tick. */
  async deliverOwedStreamBatches(): Promise<void> {
    if (!this.config.enabled) return;
    const now = this.now();
    for (const record of [...this.records.values()]) {
      const next = record.owedStreamBatches?.[0];
      if (!next || record.state === 'cancelled' || next.nextAttemptAt > now) continue;
      const id = record.definition.id;
      // Claimed before the action: a delivery of this head already under way is not started again.
      if (this.owedDelivering.has(id)) continue;
      const epoch = ++this.owedEpoch;
      this.owedDelivering.set(id, epoch);
      let delivered: boolean;
      try {
        delivered = await this.fireAction(id, `${next.reason} (delivered again after a failed attempt)`, next.fingerprint, 'stream', next.prompt)
          .catch((error: unknown) => { logger.warn('Owed stream batch could not be delivered', { triggerId: id, error: summarizeError(error) }); return false; });
      } finally {
        if (this.owedDelivering.get(id) === epoch) this.owedDelivering.delete(id);
      }
      const current = this.records.get(id);
      const head = current?.owedStreamBatches?.[0];
      if (!current || head?.fingerprint !== next.fingerprint || head.prompt !== next.prompt) continue;
      const rest = current.owedStreamBatches!.slice(1);
      const owed = delivered ? rest
        : [{ ...head, attempts: head.attempts + 1, nextAttemptAt: this.now() + backoffDelayFor(this.policy, head.attempts) }, ...rest];
      this.records.set(id, { ...current, owedStreamBatches: owed.length > 0 ? owed : undefined, updatedAt: this.now() });
      this.persist(id);
    }
  }

  /** Poll this supervisor's on-exit children, and retry on-exit actions that are still owed. */
  async pollProcesses(): Promise<void> {
    if (!this.config.enabled) return;
    this.load();
    const now = this.now();
    this.reconcileOnExitAfterRestart(now);
    for (const record of [...this.records.values()]) {
      if (record.definition.spec.kind === 'on-exit' && record.pendingExit && isDue(record, now)) {
        await this.fireOnExit(record.definition.id, record.pendingExit, now);
      }
    }
    const host = this.options.processHost;
    if (!host) return;
    for (const record of [...this.records.values()]) {
      if (record.definition.spec.kind !== 'on-exit') continue;
      if (record.state !== 'running' || !record.process || record.process.daemonBootId !== this.daemonBootId) continue;
      const observed = host.observe(record.process.processId);
      if (!observed || observed.running) continue;
      const termination = buildTermination({
        process: record.process,
        observed,
        now,
        ...(this.config.outputTailBytes !== undefined ? { outputTailBytes: this.config.outputTailBytes } : {}),
      });
      try { await this.fireOnExit(record.definition.id, termination, now); }
      finally { if (this.records.get(record.definition.id)?.state !== 'running') host.release?.(record.process.processId); }
    }
    this.observeCancelledExits(host, now);
  }

  /**
   * A cancelled child's exit, once seen: the cancel's `cancel-requested`
   * termination is replaced by what was observed (or `unknown` when the host
   * no longer knows the process), and the child is released.
   */
  private observeCancelledExits(host: TriggerProcessHost, now: number): void {
    for (const record of [...this.records.values()]) {
      if (record.state !== 'cancelled' || !record.process || record.process.daemonBootId !== this.daemonBootId) continue;
      const index = record.runs.findLastIndex((run) => run.termination?.state === 'cancel-requested');
      if (index < 0) continue;
      const observed = host.observe(record.process.processId);
      if (observed?.running) continue;
      const requested = record.runs[index]!.termination!;
      const termination: TerminationMetadata = observed
        ? { ...buildTermination({
          process: record.process, observed, now,
          ...(this.config.outputTailBytes !== undefined ? { outputTailBytes: this.config.outputTailBytes } : {}),
        }), reason: 'cancelled' }
        : { ...requested, state: 'unknown', stderrTail: 'The trigger was cancelled and the supervisor no longer knows the process, so its exit was not seen.' };
      const runs = [...record.runs];
      runs[index] = {
        ...runs[index]!,
        termination,
        detail: observed ? `cancelled by an operator; the process ${termination.state} after the stop` : 'cancelled by an operator; the process exit was not seen',
      };
      this.records.set(record.definition.id, { ...record, runs, updatedAt: now });
      this.persist(record.definition.id);
      host.release?.(record.process.processId);
    }
  }

  /**
   * Delivers an on-exit action. The record is `firing` (with how the child
   * ended) while the action runs; `fired` only once it was delivered. A failed
   * action walks the ladder and is delivered again when due, or after a reset
   * once the breaker opened; the trigger is never reaped while it is owed.
   */
  private fireOnExit(id: string, termination: TerminationMetadata, now: number): Promise<void> {
    return this.work.own(() => this.fireOnExitOwned(id, termination, now));
  }

  private async fireOnExitOwned(id: string, termination: TerminationMetadata, now: number): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.state === 'fired' || record.state === 'cancelled' || record.state === 'firing') return;
    this.requireEnabled('fire an on-exit trigger');
    // The daemon takes no new work (a self-update's restart): the exit is saved as owed, without a strike,
    // and delivered by the supervision pass once work is admitted again (after the restart).
    if (this.options.workAdmitted?.() === false) {
      this.records.set(id, { ...record, state: 'backoff', pendingExit: termination, nextCheckAt: now + WORK_ADMISSION_RECHECK_MS, updatedAt: now });
      this.persist(id);
      return;
    }
    const retry = record.pendingExit !== undefined;
    this.records.set(id, { ...record, state: 'firing', pendingExit: termination, lastError: undefined, updatedAt: now,
      runs: [...record.runs, { at: now, outcome: 'checked', detail: retry ? 'delivering the on-exit action again' : `process ${termination.state} (${termination.reason}); delivering its action`, termination }],
    });
    this.persist(id);

    const prompt = renderOnExitPrompt(termination, record.definition.label);
    let result: string;
    try {
      result = await this.executeAction(record.definition, record.definition.action, prompt);
    } catch (error) {
      const failed = this.records.get(id);
      if (!failed || failed.state !== 'firing') return;
      const message = summarizeError(error);
      const outcome = applyFailure(failed, this.policy, now, transienceOf(error));
      this.records.set(id, {
        ...failed,
        state: outcome.state,
        strikes: outcome.strikes,
        backoffRung: outcome.backoffRung,
        nextCheckAt: Number.isFinite(outcome.nextCheckAt) ? outcome.nextCheckAt : undefined,
        lastError: message,
        runs: [...failed.runs, { at: now, outcome: 'failed', termination,
          detail: outcome.breakerOpened ? `action failed: ${message}; reset the trigger to deliver it again` : `action failed: ${message}; delivering again in ${outcome.delayMs}ms` }],
        updatedAt: now,
      });
      this.persist(id);
      return;
    }
    const current = this.records.get(id);
    if (!current) return;
    this.records.set(id, {
      ...current,
      state: current.state === 'cancelled' ? 'cancelled' : 'fired',
      pendingExit: undefined,
      lastError: undefined,
      strikes: 0,
      backoffRung: 0,
      firedCount: current.firedCount + 1,
      lastFiredAt: now,
      runs: [...current.runs, {
        at: now,
        outcome: 'fired',
        detail: `process ${termination.state} (${termination.reason})`,
        termination,
        actionResult: result,
      }],
      updatedAt: now,
    });
    this.appendEvent({
      at: now,
      triggerId: id,
      kind: 'on-exit',
      event: 'fired',
      fingerprint: `on-exit:${termination.state}:${termination.reason}`,
    });
    this.persist(id);
  }

  // ─── stream ─────────────────────────────────────────────────────────────────
  // Lifecycle lives in manager-streams.ts; these keep the call sites readable.

  private async startStream(record: TriggerRecord, spec: StreamTriggerSpec, now: number): Promise<TriggerRecord> {
    return startStreamTrigger(this.streamOwner(), record, spec, now);
  }

  /** The narrow view manager-streams.ts operates through. */
  private streamOwner(): StreamOwner {
    return {
      streams: this.streams,
      records: this.records,
      streamHost: this.options.streamHost,
      policy: this.policy,
      config: () => this.config,
      now: () => this.now(),
      persist: (id) => { this.persist(id); },
      deferActivation: true,
      assertCurrent: (id, runtime) => {
        if (this.work.stopped || this.streams.get(id) !== runtime || this.records.get(id)?.state === 'cancelled') {
          throw new Error('the stream was stopped or cancelled while it was starting');
        }
      },
      fireAction: (id, reason, fingerprint, kind, promptOverride) =>
        this.fireAction(id, reason, fingerprint, kind, promptOverride),
      owe: (id, batch) => { this.oweStreamBatch(id, batch); },
    };
  }
}
