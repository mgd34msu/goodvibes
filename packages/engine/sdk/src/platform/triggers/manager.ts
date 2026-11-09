/**
 * manager.ts, the trigger supervisor.
 *
 * Owns all three watcher kinds over one spine: the same backoff ladder, the
 * same strike breaker, the same persisted ring buffer, the same recovery
 * housekeeping. The kinds differ only in how an observation is produced,
 * a probe, a matched stream batch, or a child process ending.
 *
 * Everything with an effect is injected (probe I/O, process host, stream host,
 * action executor, clock), so the policy in this file is exercisable end to end
 * without a network, a subprocess or a real daemon.
 */

import { observeTriggers } from './manager-observer.js';
import { restartDueStreams } from './manager-stream-restarts.js';
import { TriggerStoreOwnershipError } from './store-owner.js';
import { TriggerManagerWork } from './manager-work.js';
import { randomUUID } from 'node:crypto';
import { readFailureTransience, type FailureTransience } from '../integrations/delivery.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { runExtract, toObservation } from './extract.js';
import { captureRegisteredGrantAction, createActionGrant, verifyGrant, type RegisterGrantInput } from './grants.js';
import {
  buildCancelledTermination,
  buildDaemonRestartTermination,
  buildTermination,
  decideOnExitRecovery,
  launchOnExitProcess,
  renderOnExitPrompt,
} from './process-triggers.js';
import { createDefaultProbeIo, runProbe } from './probes.js';
import { evaluateRule } from './rules.js';
import {
  boundEventLog,
  boundRecord,
  TriggerSnapshotStore,
  TriggerStoreError,
  TriggerMigrationRequiredError,
  sweepTriggers,
  type TriggerRetentionPolicy,
} from './store.js';
import { applyFailure, applySuccess, isDue, resetBreaker, resolveSupervisionPolicy, type SupervisionPolicy } from './supervision.js';
import { activateStreamTrigger, drainStreamTrigger, startStreamTrigger, type StreamOwner, type StreamRuntime } from './manager-streams.js';
import type {
  ConditionTriggerSpec, OnExitTriggerSpec, StreamTriggerSpec, TriggerActionGrant, TriggerDefinition,
  TriggerEventLogEntry, TriggerFireAction, TriggerRecord, TriggerRecoveryReport, TriggerRunRecord,
} from './types.js';
import { validateDefinition } from './validation.js';
import { retentionFrom, TriggerDisabledError, type TriggerManagerConfig, type TriggerManagerOptions } from './manager-types.js';

export * from './manager-types.js';

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
  private inFlight = new Set<string>();
  private readonly restartingStreams = new Set<string>();
  private loaded = false;
  private prepared = false;
  private observing = false;
  private migrationRequired = false;
  private lastRecovery: TriggerRecoveryReport | null = null;
  private store: TriggerSnapshotStore;
  private persistenceFailure: unknown = null;
  private readonly work: TriggerManagerWork;

  constructor(options: TriggerManagerOptions) {
    this.options = options;
    const writer = options.nativeDataWriter;
    this.store = new TriggerSnapshotStore(options.storePath, () => writer?.declare('trigger-snapshots-v2'), options.previousStorePath);
    this.work = new TriggerManagerWork(() => this.store.release());
    const initial = typeof options.config === 'function' ? options.config() : options.config;
    this.policy = resolveSupervisionPolicy(initial);
    this.retention = retentionFrom(initial);
    this.daemonBootId = options.daemonBootId ?? randomUUID();
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
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

  get executionOwnership(): 'local' | 'other-process' | 'migration-required' | 'unclaimed' { return this.migrationRequired ? 'migration-required' : this.observing ? 'other-process' : this.loaded && !this.work.stopped ? 'local' : 'unclaimed'; }
  /** Inspection never acquires execution ownership, migrates, sweeps or writes. */
  inspectRecords(): readonly TriggerRecord[] { return observeTriggers(this.options, this.now()).records; }

  get bootId(): string {
    return this.daemonBootId;
  }

  /** Recover as execution owner, or inspect without effects when explicitly allowed. */
  load(readOnlyAllowed = false): TriggerRecoveryReport {
    this.assertAvailable();
    try {
      if (this.migrationRequired) throw new TriggerMigrationRequiredError();
      if (this.observing) throw new TriggerStoreOwnershipError();
      if (!this.prepared) { this.store = new TriggerSnapshotStore(this.options.storePath, () => this.options.nativeDataWriter?.declare('trigger-snapshots-v2'), this.options.previousStorePath); this.prepared = true; }
      this.store.acquire();
    }
    catch (error) { return this.observeOrThrow(error, readOnlyAllowed); }
    if (this.loaded && this.lastRecovery) return this.lastRecovery;
    let loadedStore: ReturnType<TriggerSnapshotStore['load']>;
    try { loadedStore = this.store.load(); } catch (error) { this.store.release(); return this.observeOrThrow(error, readOnlyAllowed); }
    const now = this.now();
    const snapshot = loadedStore.snapshot;

    const swept = sweepTriggers({
      triggers: snapshot?.triggers ?? [],
      eventLog: snapshot?.eventLog ?? [],
      policy: this.retention,
      now,
      reason: 'startup',
      ...(this.options.sessionIsLive ? { sessionIsLive: this.options.sessionIsLive } : {}),
      ...(this.options.processHost
        ? { processIsLive: (pid: number, startedAt: number) => this.options.processHost!.isSameProcessAlive(pid, startedAt) }
        : {}),
      ...(loadedStore.quarantined ? { quarantined: loadedStore.quarantined } : {}),
    });

    this.records.clear();
    for (const record of swept.triggers) this.records.set(record.definition.id, record);
    this.grants.clear();
    for (const grant of snapshot?.grants ?? []) this.grants.set(grant.id, grant);
    this.eventLog = [...swept.eventLog];
    this.persist();
    try { this.store.report(swept.report); } catch (error) { this.failPersistence(error); }
    this.loaded = true;
    this.lastRecovery = swept.report;
    this.reconcileOnExitAfterRestart(now);
    return swept.report;
  }

  private observeOrThrow(error: unknown, allowed: boolean): TriggerRecoveryReport {
    if (!allowed || (!(error instanceof TriggerStoreOwnershipError) && !(error instanceof TriggerMigrationRequiredError))) throw error;
    this.migrationRequired = error instanceof TriggerMigrationRequiredError; this.observing = true;
    const view = observeTriggers(this.options, this.now());
    this.records.clear(); for (const record of view.records) this.records.set(record.definition.id, record);
    this.grants.clear(); for (const grant of view.grants) this.grants.set(grant.id, grant);
    this.eventLog = [...view.eventLog]; this.lastRecovery = view.report; return view.report;
  }
  /** The caller must present this acknowledgement through an explicit operator
   * control, after asking older instances to stop. It is not OS liveness proof.
   */
  migratePrevious(input: { readonly olderInstancesClosed: true }): TriggerRecoveryReport {
    if (input.olderInstancesClosed !== true || !this.migrationRequired) throw new TriggerMigrationRequiredError();
    this.store.acceptPreviousMigration(); this.migrationRequired = false; this.observing = false;
    return this.start();
  }

  /** Recovery admits at most one action after a durable claim, with an honest
   * unknown outcome. No remembered PID is adopted as current execution.
   */
  private reconcileOnExitAfterRestart(now: number): void {
    if (!this.config.enabled) return;
    for (const record of [...this.records.values()]) {
      if (record.definition.spec.kind !== 'on-exit') continue;
      if (!record.process || record.process.daemonBootId === this.daemonBootId) continue;
      if (record.state === 'fired' || record.state === 'cancelled') continue;
      const decision = decideOnExitRecovery({
        process: record.process,
        currentBootId: this.daemonBootId,
        ...(this.options.processHost ? { host: this.options.processHost } : {}),
      });
      if (decision.action === 'resume') continue;
      const termination = buildDaemonRestartTermination({
        process: record.process,
        now,
        note: decision.reason,
      });
      void this.fireOnExit(record.definition.id, termination, now).catch((error: unknown) => {
        logger.warn('Trigger daemon-restart fire failed', {
          triggerId: record.definition.id,
          error: summarizeError(error),
        });
      });
    }
  }

  /** Recover and supervise only when this process owns the trigger surface. */
  start(): TriggerRecoveryReport {
    this.work.start();
    const report = this.load(true);
    if (this.observing) return report;
    this.startSweep();
    if (!this.supervisionTimer) {
      const interval = Math.max(250, this.config.supervisionTickMs ?? 1_000);
      this.supervisionTimer = setInterval(() => {
        void this.supervisionTick();
      }, interval);
      this.supervisionTimer.unref?.();
    }
    return report;
  }

  /** One supervision pass: reap finished children, then run due checks. */
  async supervisionTick(): Promise<void> {
    if (!this.config.enabled) return;
    try {
      await this.pollProcesses();
      await this.tick();
    } catch (error) {
      logger.warn('Trigger supervision tick failed', { error: summarizeError(error) });
    }
  }

  /** Starts the recurring housekeeping sweep. A daemon that only sweeps at boot never sweeps. */
  startSweep(): void {
    if (this.sweepTimer) return;
    const interval = Math.max(10_000, this.config.sweepIntervalMs ?? 300_000);
    this.sweepTimer = setInterval(() => { try { this.sweep(); } catch (error) { logger.warn('Trigger sweep failed', { error: summarizeError(error) }); } }, interval);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Only the actual execution owner reaps and publishes a sweep. */
  sweep(): TriggerRecoveryReport {
    this.load();
    const now = this.now();
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
    this.lastRecovery = swept.report;
    this.persist();
    try { this.store.report(swept.report); } catch (error) { this.failPersistence(error); }
    return swept.report;
  }

  /** Stops timers and supervised streams. Persisted state is left intact. */
  shutdown(): void {
    this.work.stop();
    this.stopSweep();
    if (this.supervisionTimer) clearInterval(this.supervisionTimer);
    this.supervisionTimer = null;
    for (const [triggerId, runtime] of this.streams) {
      if (runtime.timer) clearInterval(runtime.timer);
      this.streams.delete(triggerId);
      const streamId = runtime.streamId; runtime.streamId = null; if (streamId) this.options.streamHost?.stop(streamId);
    }
    this.work.finishStop();
  }

  join(): Promise<void> { return this.work.join(); }

  private assertAvailable(): void {
    if (this.persistenceFailure !== null) throw this.persistenceFailure;
    if (this.work.stopped) throw new TriggerStoreError('unavailable');
    if (this.loaded && !this.observing) this.store.assertCurrent();
  }

  private failPersistence(error: unknown): never {
    this.persistenceFailure = error instanceof Error ? error : new TriggerStoreError('publication-failed');
    try { this.shutdown(); } catch { logger.warn('Trigger stream cleanup could not fully complete after storage failed'); }
    throw this.persistenceFailure;
  }

  private persist(): void {
    this.assertAvailable();
    try { this.store.save({ daemonBootId: this.daemonBootId, triggers: [...this.records.values()],
      grants: [...this.grants.values()], eventLog: this.eventLog, now: this.now() }); }
    catch (error) { this.failPersistence(error); }
  }

  registerGrant(input: RegisterGrantInput): TriggerActionGrant {
    this.requireEnabled('register an action grant');
    this.load();
    const grant = createActionGrant({ ...input, now: input.now ?? this.now() }, this.grants.get(input.id));
    this.grants.set(grant.id, grant);
    this.persist();
    return grant;
  }

  listGrants(): TriggerActionGrant[] {
    this.load(true);
    return [...this.grants.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  create(input: unknown): Promise<TriggerRecord> { return this.work.own(() => this.createOwned(input)); }
  private async createOwned(input: unknown): Promise<TriggerRecord> {
    this.requireEnabled('create a trigger');
    this.load();
    const validated = validateDefinition(input);
    if (this.records.has(validated.id)) {
      throw new Error(`A trigger with id "${validated.id}" already exists.`);
    }
    const definition = { ...validated, action: this.captureFireableAction(validated.action) };

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

    // Persist the definition and reader floor before any external command.
    const admitted = record;
    this.records.set(definition.id, admitted);
    this.persist();
    let ownedStream: StreamRuntime | undefined;
    try {
      if (definition.spec.kind === 'on-exit') record = await this.startOnExit(record, definition.spec, now);
      else if (definition.spec.kind === 'stream') {
        const starting = this.startStream(record, definition.spec, now); ownedStream = this.streams.get(definition.id); record = await starting;
      }
      this.assertAvailable();
      if (this.records.get(definition.id) !== admitted) throw new TriggerStoreError('unavailable');
      if (record !== admitted) { record = { ...record, lastError: undefined }; this.records.set(definition.id, record); this.persist(); }
      if (definition.spec.kind === 'stream') activateStreamTrigger(this.streamOwner(), definition.id);
    } catch (error) {
      // Cancel only the actual resource returned by this admitted start. No PID
      // or command-name inference may target an unrelated process.
      if (record.process) this.options.processHost?.cancel(record.process.processId);
      if (ownedStream?.streamId) { this.options.streamHost?.stop(ownedStream.streamId); ownedStream.streamId = null; }
      if (ownedStream?.timer) clearInterval(ownedStream.timer);
      if (ownedStream && this.streams.get(definition.id) === ownedStream) this.streams.delete(definition.id);
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
    this.load(true);
    return [...this.records.values()].sort((a, b) => a.definition.label.localeCompare(b.definition.label));
  }

  get(id: string): TriggerRecord | null {
    this.load(true);
    return this.records.get(id) ?? null;
  }

  /** Run history for one trigger, newest last. */
  history(id: string): readonly TriggerRunRecord[] {
    return this.get(id)?.runs ?? [];
  }

  /** Cancels a trigger. An on-exit trigger's supervised child is terminated. */
  cancel(id: string): TriggerRecord | null {
    this.load();
    const record = this.records.get(id);
    if (!record) return null;
    const now = this.now();

    const termination = record.process ? buildCancelledTermination({ process: record.process, now }) : undefined;
    const cancelled: TriggerRecord = {
      ...record,
      state: 'cancelled',
      updatedAt: now,
      runs: [...record.runs, {
        at: now,
        outcome: 'skipped',
        detail: 'cancelled by an operator',
        ...(termination ? { termination } : {}),
      }],
    };
    this.records.set(id, cancelled);
    this.persist();
    const stream = this.streams.get(id);
    if (stream) {
      if (stream.timer) clearInterval(stream.timer);
      if (stream.streamId) { this.options.streamHost?.stop(stream.streamId); stream.streamId = null; }
      this.streams.delete(id);
    }
    if (record.process && this.options.processHost) {
      this.options.processHost.cancel(record.process.processId);
    }

    return cancelled;
  }

  remove(id: string): boolean {
    this.load();
    if (!this.records.has(id)) return false;
    this.cancel(id);
    const removed = this.records.delete(id);
    this.persist();
    return removed;
  }

  /** Explicit breaker reset. The breaker never closes on its own. */
  reset(id: string): TriggerRecord | null {
    this.requireEnabled('reset a trigger');
    this.load();
    const record = this.records.get(id);
    if (!record) return null;
    const next = resetBreaker(record, this.now());
    this.records.set(id, next);
    this.persist();
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
    this.requireEnabled('run a trigger check');
    this.load();
    const record = this.records.get(id);
    if (!record || record.definition.spec.kind !== 'condition') return null;
    if (this.inFlight.has(id)) return record;
    this.inFlight.add(id);
    const spec = record.definition.spec;
    const startedAt = this.now();
    try {
      const io = this.options.probeIo ?? createDefaultProbeIo();
      const raw = await runProbe(spec.probe, io, { timeoutMs: this.config.probeTimeoutMs ?? 15_000 });
      const value = runExtract(spec.extract, raw);
      return this.applyObservation(id, value, startedAt, spec);
    } catch (error) {
      if (this.persistenceFailure !== null || error instanceof TriggerStoreError) throw error;
      // Whether a retry can clear this failure is read from the error itself;
      // a failure read as permanent parks the trigger at once.
      const transience = await readFailureTransience(error, 'triggers.condition-check');
      return this.applyCheckFailure(id, summarizeError(error), startedAt, spec, transience);
    } finally {
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
    const now = this.now();
    const observation = toObservation(value, now);
    const observations = [...record.observations, observation].slice(-this.retention.observationRingSize);

    const decision = evaluateRule(spec.rule, {
      observations,
      ruleState: record.ruleState,
      now,
      eventLog: this.eventLog,
      selfTriggerId: id,
    });

    const success = applySuccess(spec.intervalMs ?? this.config.defaultCheckIntervalMs ?? 60_000, now);
    const run: TriggerRunRecord = {
      at: now,
      outcome: decision.fire ? 'fired' : 'checked',
      detail: decision.reason,
      observation,
      durationMs: now - startedAt,
    };

    let next: TriggerRecord = {
      ...record,
      ...success,
      observations,
      ruleState: decision.ruleState,
      runs: [...record.runs, run],
      lastError: undefined,
      updatedAt: now,
    };
    next = boundRecord(next, this.retention, now).record;
    this.records.set(id, next);
    this.appendEvent({ at: now, triggerId: id, kind: 'condition', event: 'observed', fingerprint: decision.fingerprint });

    if (decision.fire) {
      void this.fireAction(id, decision.reason, decision.fingerprint, 'condition').catch((error: unknown) => {
        logger.warn('Trigger action failed', { triggerId: id, error: summarizeError(error) });
      });
      this.assertAvailable();
    } else this.persist();
    return this.records.get(id) ?? next;
  }

  private applyCheckFailure(
    id: string,
    error: string,
    startedAt: number,
    spec: ConditionTriggerSpec,
    transience: FailureTransience,
  ): TriggerRecord | null {
    const record = this.records.get(id);
    if (!record) return null;
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
    this.appendEvent({ at: now, triggerId: id, kind: 'condition', event: 'failed', fingerprint: `failed:${error.slice(0, 64)}` });
    this.persist();
    void spec;
    return next;
  }

  private appendEvent(entry: TriggerEventLogEntry): void {
    this.eventLog.push(entry);
    this.eventLog = [...boundEventLog(this.eventLog, this.retention, entry.at).eventLog];
  }

  // ─── Firing ─────────────────────────────────────────────────────────────────

  private fireAction(id: string, reason: string, fingerprint: string, kind: 'condition' | 'stream', promptOverride?: string): Promise<void> {
    return this.work.own(() => this.fireActionOwned(id, reason, fingerprint, kind, promptOverride));
  }

  private async fireActionOwned(
    id: string,
    reason: string,
    fingerprint: string,
    kind: 'condition' | 'stream',
    promptOverride?: string,
  ): Promise<void> {
    this.requireEnabled('fire a trigger');
    this.assertAvailable();
    this.persist();
    const record = this.records.get(id);
    if (!record) return;
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
          runs: [...failed.runs, { at: now, outcome: 'failed', detail: `action failed: ${summarizeError(error)}` }],
          lastError: summarizeError(error),
          updatedAt: now,
        });
        this.persist();
      }
      return;
    }
    const current = this.records.get(id);
    if (!current) return;
    this.records.set(id, {
      ...current,
      firedCount: current.firedCount + 1,
      lastFiredAt: now,
      runs: [...current.runs, { at: now, outcome: 'fired', detail: reason, actionResult: result }],
      updatedAt: now,
    });
    this.appendEvent({ at: now, triggerId: id, kind, event: 'fired', fingerprint });
    this.persist();
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
    this.requireEnabled('execute a trigger action'); this.assertAvailable();
    if (action.kind === 'agent-turn') {
      const prefix = action.prompt ?? '';
      return this.options.actions.runAgentTurn({
        triggerId: definition.id,
        prompt: prefix.length > 0 ? `${prefix}\n\n${prompt}` : prompt,
        ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
        ...(action.model !== undefined ? { model: action.model } : {}),
      });
    }
    const verification = verifyGrant([...this.grants.values()], action.grantId, action.digest, action.approvedAction);
    if (!verification.ok) {
      throw new Error(verification.reason);
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

  /** Poll only native children belonging to this execution owner. */
  async pollProcesses(): Promise<void> {
    if (!this.config.enabled) return;
    this.load();
    this.reconcileOnExitAfterRestart(this.now());
    const host = this.options.processHost;
    if (!host) return;
    const now = this.now();
    for (const record of [...this.records.values()]) {
      if (record.definition.spec.kind !== 'on-exit') continue;
      if (record.state !== 'running' || !record.process) continue;
      const observed = host.observe(record.process.processId);
      if (!observed || observed.running) continue;
      const termination = buildTermination({
        process: record.process,
        observed,
        now,
        ...(this.config.outputTailBytes !== undefined ? { outputTailBytes: this.config.outputTailBytes } : {}),
      });
      await this.fireOnExit(record.definition.id, termination, now);
    }
  }

  /** Persist the one-shot claim before invoking its payload. */
  private fireOnExit(id: string, termination: ReturnType<typeof buildTermination>, now: number): Promise<void> {
    return this.work.own(() => this.fireOnExitOwned(id, termination, now));
  }

  private async fireOnExitOwned(
    id: string,
    termination: ReturnType<typeof buildTermination>,
    now: number,
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record || record.state === 'fired' || record.state === 'cancelled') return;
    this.requireEnabled('fire an on-exit trigger'); this.assertAvailable();
    this.records.set(id, { ...record, state: 'fired', updatedAt: now,
      lastError: 'action reserved; completion has not been observed',
      runs: [...record.runs, { at: now, outcome: 'checked', detail: 'on-exit action reserved; completion has not been observed', termination }],
    });
    this.persist();

    const prompt = renderOnExitPrompt(termination, record.definition.label);
    let result: string;
    try {
      result = await this.executeAction(record.definition, record.definition.action, prompt);
    } catch (error) {
      const failed = this.records.get(id);
      if (failed) {
        this.records.set(id, {
          ...failed,
          runs: [...failed.runs, { at: now, outcome: 'failed', detail: `action failed: ${summarizeError(error)}`, termination }],
          lastError: summarizeError(error),
          updatedAt: now,
        });
        this.persist();
      }
      return;
    }
    const current = this.records.get(id);
    if (!current) return;
    this.records.set(id, {
      ...current,
      state: 'fired',
      lastError: undefined,
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
    this.persist();
  }

  // ─── stream ─────────────────────────────────────────────────────────────────
  // Lifecycle lives in manager-streams.ts; these keep the call sites readable.

  private async startStream(record: TriggerRecord, spec: StreamTriggerSpec, now: number): Promise<TriggerRecord> {
    return startStreamTrigger(this.streamOwner(), record, spec, now);
  }

  private drainStream(id: string, force = false): void {
    drainStreamTrigger(this.streamOwner(), id, force);
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
      persist: () => { this.persist(); },
      deferActivation: true,
      assertCurrent: (id, runtime) => {
        this.assertAvailable();
        if (this.streams.get(id) !== runtime || this.records.get(id)?.state === 'cancelled') throw new TriggerStoreError('unavailable');
      },
      fireAction: (id, reason, fingerprint, kind, promptOverride) =>
        this.fireAction(id, reason, fingerprint, kind, promptOverride),
    };
  }
}
