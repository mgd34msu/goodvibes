import { existsSync, statSync } from 'node:fs';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { WatcherKind, WatcherRecord, WatcherSourceStatus, WatcherState } from '../runtime/store/domains/watchers.js';
import type { AutomationSourceRecord } from '../automation/sources.js';
import type { WatcherSourceKind } from '../../events/watchers.js';
import { readFailureTransience } from '../integrations/delivery.js';
import { summarizeError } from '../utils/error-display.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import { logger } from '../utils/logger.js';
import {
  emitWatcherFailed,
  emitWatcherCheckpointAdvanced,
  emitWatcherHeartbeat,
  emitWatcherStarted,
  emitWatcherStopped,
} from '../runtime/emitters/index.js';
import {
  loadWatcherSnapshotFromPath,
  resolveWatcherStorePath,
  saveWatcherSnapshotToPathSafe,
} from './store.js';
import { postToPublicWebhook } from '../utils/url-safety.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';

export interface RegisterWatcherInput {
  readonly id: string;
  readonly label: string;
  readonly kind?: WatcherKind | undefined;
  readonly source: AutomationSourceRecord;
  readonly intervalMs?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly run?: (() => Promise<string | void> | string | void) | undefined;
}

export interface RegisterPollingWatcherInput {
  readonly id: string;
  readonly label: string;
  readonly source: AutomationSourceRecord;
  readonly intervalMs: number;
  readonly run: () => Promise<string | void> | string | void;
}

export interface WatcherRegistryOptions {
  readonly storePath?: string | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
  /**
   * `watchers.recoveryWindowMinutes`, read at each use.
   *
   * A getter rather than a number for the same reason `PairingTokenManager`
   * takes `maxPaired` as one: the registry outlives a config edit, and a
   * captured number would mean the operator's new window applied at the next
   * process start instead of the next restore.
   */
  readonly recoveryWindowMinutes?: (() => number) | undefined;
  /**
   * Sends a url/webhook watcher's request. Defaults to the platform's guarded
   * request (public hosts only, resolved addresses checked, redirects not followed).
   */
  readonly fetchUrl?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  /** How long one url/webhook run may take, request and body together. */
  readonly runTimeoutMs?: number | undefined;
  /**
   * Resolves a `goodvibes://secrets/` header value to the secret at request
   * time, so no header credential is stored in the watcher record. Without it
   * such a value is sent as written.
   */
  readonly resolveHeaderValue?: ((value: string) => Promise<string | null>) | undefined;
  /** Reads whether a failure can clear on the next run. Defaults to the platform reading. */
  readonly readTransience?: ((error: unknown, site: string) => Promise<{ readonly failureClass: string }>) | undefined;
}

/**
 * The watcher lifecycle, declared from the moves this registry makes:
 * start (stopped/failed -> running), a run outcome (-> running | failed),
 * freshness (running -> degraded, derived in `sourceStatusFor`), stop (-> stopped).
 * A run on a stopped manual watcher may also end failed.
 *
 * `starting` is declared but never assigned: `startWatcher` is synchronous and
 * goes straight to running, so no start is ever in flight. It is still read
 * from persisted records and treated as live.
 */
export const watcherLifecycle = defineLifecycle<WatcherState>('watcher', {
  stopped: ['starting', 'running', 'failed'],
  starting: ['running', 'degraded', 'failed', 'stopped'],
  running: ['degraded', 'failed', 'stopped'],
  degraded: ['running', 'failed', 'stopped'],
  failed: ['running', 'degraded', 'stopped'],
});

/**
 * Whether the outcome of a run that began while the watcher was `ranFrom` may
 * still be written to the record it finds now. A watcher stopped during its run
 * stays stopped; one that was already stopped when the run began (a manual
 * run-now) keeps recording its outcome. The move itself must be in the table.
 */
function runOutcomeApplies(ranFrom: WatcherState, now: WatcherState, outcome: WatcherState): boolean {
  if (now === 'stopped' && ranFrom !== 'stopped') return false;
  return now === outcome || watcherLifecycle.can(now, outcome);
}

/** A run that has not answered by then has failed; its in-flight slot is released. */
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

/** The shipped `watchers.recoveryWindowMinutes` default, for hosts that pass none. */
const DEFAULT_RECOVERY_WINDOW_MINUTES = 10;

interface RegisteredWatcher {
  readonly record: WatcherRecord;
  readonly run: () => Promise<string | void> | string | void;
}

function now(): number {
  return Date.now();
}

function sortWatchers(watchers: Iterable<WatcherRecord>): WatcherRecord[] {
  return [...watchers].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function toWatcherSourceKind(kind: WatcherKind): WatcherSourceKind {
  switch (kind) {
    case 'webhook':
      return 'webhook';
    case 'filesystem':
      return 'file';
    case 'socket':
      return 'stream';
    case 'integration':
      return 'api';
    case 'manual':
      return 'api';
    case 'polling':
    default:
      return 'poll';
  }
}

function sourceStatusFor(record: WatcherRecord, ts = now()): {
  readonly sourceLagMs?: number | undefined;
  readonly sourceStatus: WatcherSourceStatus;
  readonly degradedReason?: string | undefined;
  readonly nextState?: WatcherRecord['state'] | undefined;
} {
  const lastSeenAt = record.lastHeartbeatAt ?? record.source.lastSeenAt ?? record.source.updatedAt ?? record.source.createdAt;
  if (record.state === 'failed') {
    return {
      sourceLagMs: lastSeenAt ? Math.max(0, ts - lastSeenAt) : undefined,
      sourceStatus: 'failed',
      degradedReason: record.lastError ?? 'watcher failed',
      nextState: 'failed',
    };
  }
  if (record.state === 'stopped') {
    return {
      sourceLagMs: lastSeenAt ? Math.max(0, ts - lastSeenAt) : undefined,
      sourceStatus: 'unknown',
    };
  }
  if (!lastSeenAt) {
    return {
      sourceStatus: 'lagging',
      degradedReason: 'watcher has not reported a heartbeat yet',
      nextState: 'degraded',
    };
  }
  const interval = Math.max(1_000, Number(record.intervalMs ?? 0) || 0);
  const lag = Math.max(0, ts - lastSeenAt);
  const staleThreshold = interval > 0 ? interval * 2 : 60_000;
  if (lag >= staleThreshold) {
    return {
      sourceLagMs: lag,
      sourceStatus: 'stale',
      degradedReason: `heartbeat stale by ${lag}ms`,
      nextState: 'degraded',
    };
  }
  if (interval > 0 && lag >= interval) {
    return {
      sourceLagMs: lag,
      sourceStatus: 'lagging',
      degradedReason: `heartbeat lagging by ${lag}ms`,
      nextState: 'degraded',
    };
  }
  return {
    sourceLagMs: lag,
    sourceStatus: record.lastError ? 'degraded' : 'healthy',
    ...(record.lastError ? { degradedReason: record.lastError } : {}),
    nextState: record.state === 'degraded' && !record.lastError ? 'running' : undefined,
  };
}

export class WatcherRegistry {
  private readonly watchers = new Map<string, RegisteredWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
  private readonly storePath: string;
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly featureFlags: FeatureFlagReader;
  private readonly readRecoveryWindowMinutes: () => number;
  private loaded = false;
  /**
   * Restored watchers whose work lives in a closure only their owner can
   * supply. They are not armed, and do not report a heartbeat, until the owner
   * registers them again.
   */
  private readonly awaitingRegistration = new Set<string>();
  private readonly fetchUrl: (url: string, init: RequestInit) => Promise<Response>;
  private readonly runTimeoutMs: number;
  private readonly resolveHeaderValue: ((value: string) => Promise<string | null>) | undefined;
  private readonly readTransience: (error: unknown, site: string) => Promise<{ readonly failureClass: string }>;

  constructor(options: WatcherRegistryOptions = {}) {
    this.storePath = resolveWatcherStorePath(options.storePath);
    this.featureFlags = options.featureFlags ?? null;
    this.readRecoveryWindowMinutes = options.recoveryWindowMinutes
      ?? ((): number => DEFAULT_RECOVERY_WINDOW_MINUTES);
    this.fetchUrl = options.fetchUrl
      ?? ((url, init) => postToPublicWebhook(url, init, { allowHttp: true }));
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.resolveHeaderValue = options.resolveHeaderValue;
    this.readTransience = options.readTransience ?? readFailureTransience;
  }

  /**
   * How far back a restart will still try to catch up, in milliseconds.
   *
   * A non-finite or negative value, which only a hand-edited settings file
   * produces, since `ConfigManager.set()` holds the key to 0…1440, reads as the
   * shipped default rather than as "never catch up", because an unreadable number
   * should not silently switch a recovery behaviour off.
   */
  private recoveryWindowMs(): number {
    const minutes = this.readRecoveryWindowMinutes();
    const usable = typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0
      ? minutes
      : DEFAULT_RECOVERY_WINDOW_MINUTES;
    return usable * 60_000;
  }

  private isEnabled(): boolean {
    const enabled = isFeatureGateEnabled(this.featureFlags, 'watcher-framework');
    if (!enabled) {
      this.clearTimers();
      // The next enabled call must arm the running watchers again.
      this.loaded = false;
    }
    return enabled;
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, 'watcher-framework', operation);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null | undefined;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      for (const watcher of this.watchers.values()) {
        this.runtimeDispatch.syncWatcher(this.normalizeRecord(watcher.record), 'watchers.attach');
      }
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
  }

  registerWatcher(input: RegisterWatcherInput): WatcherRecord {
    this.requireEnabled('register watcher');
    this.ensureLoaded();
    const existing = this.watchers.get(input.id)?.record;
    const wasRunning = existing?.state === 'running' || existing?.state === 'starting' || existing?.state === 'degraded';
    const timer = this.timers.get(input.id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(input.id);
    }
    const record = this.normalizeRecord({
      id: input.id,
      kind: input.kind ?? existing?.kind ?? 'polling',
      label: input.label,
      state: existing?.state ?? 'stopped',
      source: input.source,
      intervalMs: input.intervalMs ?? existing?.intervalMs,
      lastHeartbeatAt: existing?.lastHeartbeatAt,
      lastCheckpoint: existing?.lastCheckpoint,
      lastError: existing?.lastError,
      sourceLagMs: existing?.sourceLagMs,
      sourceStatus: existing?.sourceStatus,
      degradedReason: existing?.degradedReason,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    });
    this.watchers.set(record.id, {
      record,
      run: input.run ?? this.buildRunStrategy(record),
    });
    // Only a registration that brings the work ends the wait; an update without
    // a run (the PATCH route) must not turn the stand-in on.
    if (input.run !== undefined || this.hasStandaloneStrategy(record)) this.awaitingRegistration.delete(record.id);
    this.persist();
    this.runtimeDispatch?.syncWatcher(record, 'watchers.register');
    if (wasRunning && !this.awaitingRegistration.has(record.id)) {
      return this.startWatcher(record.id) ?? record;
    }
    return record;
  }

  registerPollingWatcher(input: RegisterPollingWatcherInput): WatcherRecord {
    return this.registerWatcher({
      id: input.id,
      label: input.label,
      kind: 'polling',
      source: input.source,
      intervalMs: input.intervalMs,
      metadata: {
        ...input.source.metadata,
        runMode: 'polling',
      },
      run: input.run,
    });
  }

  list(): WatcherRecord[] {
    if (!this.isEnabled()) {
      this.clearTimers();
      return [];
    }
    this.ensureLoaded();
    // Freshness is a projection of the clock, not a watcher mutation. Rendering
    // the fleet must not write a snapshot or dispatch another render event.
    return sortWatchers([...this.watchers.values()].map(watcher => this.normalizeRecord(watcher.record)));
  }

  getWatcher(id: string): WatcherRecord | null {
    if (!this.isEnabled()) {
      this.clearTimers();
      return null;
    }
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    return this.normalizeRecord(watcher.record);
  }

  startWatcher(id: string): WatcherRecord | null {
    this.requireEnabled('start watcher');
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    this.refuseWhileAwaitingOwner(id, 'start');
    if (this.timers.has(id)) return watcher.record;

    const started: WatcherRecord = this.normalizeRecord({
      ...watcher.record,
      state: 'running',
      lastHeartbeatAt: now(),
      sourceStatus: 'healthy',
      degradedReason: undefined,
      sourceLagMs: 0,
    });
    this.watchers.set(id, { ...watcher, record: started });
    this.persist();
    this.runtimeDispatch?.syncWatcher(started, 'watchers.start');
    if (this.runtimeBus) {
      emitWatcherStarted(this.runtimeBus, {
        sessionId: 'watchers',
        source: 'watcher-registry',
        traceId: id,
      }, {
        watcherId: id,
        sourceKind: toWatcherSourceKind(started.kind),
        name: started.label,
      });
    }

    if (started.kind !== 'manual' && Number(started.intervalMs ?? 0) > 0) {
      const timer = setInterval(() => {
        void this.runWatcher(id).catch((error: unknown) => {
          logger.warn('Watcher interval run failed', { watcherId: id, error: summarizeError(error) });
        });
      }, started.intervalMs ?? 60_000);
      timer.unref?.();
      this.timers.set(id, timer);
      void this.runWatcher(id).catch((error: unknown) => {
        logger.warn('Watcher initial run failed', { watcherId: id, error: summarizeError(error) });
      });
    }
    return started;
  }

  /**
   * Stop every interval this registry started, without touching persisted state.
   *
   * Deliberately NOT `stopWatcher()` in a loop: that call runs
   * `requireEnabled()`, which throws when the watcher-framework gate is off, and
   * it rewrites each record to `state: 'stopped'`. Neither is wanted at
   * shutdown, a daemon whose watchers were running must find them running
   * again when it restarts, and a clean shutdown must not depend on a feature
   * gate being on. This releases process resources and nothing else.
   *
   * Idempotent.
   */
  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  stopWatcher(id: string, reason = 'stopped'): WatcherRecord | null {
    this.requireEnabled('stop watcher');
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    const timer = this.timers.get(id);
    if (timer) clearInterval(timer);
    this.timers.delete(id);

    const stopped: WatcherRecord = this.normalizeRecord({
      ...watcher.record,
      state: 'stopped',
      sourceStatus: 'unknown',
    });
    this.watchers.set(id, { ...watcher, record: stopped });
    this.persist();
    this.runtimeDispatch?.syncWatcher(stopped, 'watchers.stop');
    if (this.runtimeBus) {
      emitWatcherStopped(this.runtimeBus, {
        sessionId: 'watchers',
        source: 'watcher-registry',
        traceId: id,
      }, {
        watcherId: id,
        sourceKind: toWatcherSourceKind(stopped.kind),
        reason,
      });
    }
    return stopped;
  }

  async runWatcherNow(id: string): Promise<WatcherRecord | null> {
    this.requireEnabled('run watcher');
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return null;
    this.refuseWhileAwaitingOwner(id, 'run');
    await this.runWatcher(id);
    return this.getWatcher(id);
  }

  removeWatcher(id: string): boolean {
    this.requireEnabled('remove watcher');
    this.ensureLoaded();
    const watcher = this.watchers.get(id);
    if (!watcher) return false;
    this.stopWatcher(id, 'removed');
    const removed = this.watchers.delete(id);
    if (removed) {
      this.persist();
      this.runtimeDispatch?.removeWatcher(id, 'watchers.remove');
    }
    return removed;
  }

  private ensureLoaded(): void {
    if (!this.isEnabled()) return;
    if (this.loaded) return;
    const snapshot = loadWatcherSnapshotFromPath(this.storePath);
    if (snapshot) {
      // A watcher registered in this process keeps its closure; the snapshot only adds the rest.
      for (const record of snapshot.watchers) {
        if (this.watchers.has(record.id)) continue;
        const normalized = this.normalizeRecord(record);
        this.watchers.set(normalized.id, {
          record: normalized,
          run: this.buildRunStrategy(normalized),
        });
        if (!this.hasStandaloneStrategy(normalized)) this.awaitingRegistration.add(normalized.id);
      }
    }
    this.loaded = true;
    const recoveryWindowMs = this.recoveryWindowMs();
    const restoredAt = now();
    for (const watcher of this.watchers.values()) {
      const normalized = this.normalizeRecord(watcher.record);
      this.watchers.set(normalized.id, {
        ...watcher,
        record: normalized,
        run: watcher.run ?? this.buildRunStrategy(normalized),
      });
      if (
        (normalized.state === 'running' || normalized.state === 'degraded' || normalized.state === 'starting')
        && normalized.kind !== 'manual'
        && Number(normalized.intervalMs ?? 0) > 0
        && !this.timers.has(normalized.id)
      ) {
        if (this.awaitingRegistration.has(normalized.id)) {
          logger.info('Restored watcher waits for its owner to register it again', { watcherId: normalized.id });
          continue;
        }
        const timer = setInterval(() => {
          void this.runWatcher(normalized.id).catch((error: unknown) => {
            logger.warn('Watcher interval run failed', { watcherId: normalized.id, error: summarizeError(error) });
          });
        }, normalized.intervalMs ?? 60_000);
        timer.unref?.();
        this.timers.set(normalized.id, timer);
        this.catchUpAfterRestart(normalized, restoredAt, recoveryWindowMs);
      }
    }
  }

  /**
   * Whether the record carries what its run needs (an inline result, a path or
   * a url). Without it the work is a closure only the registering owner holds.
   */
  private hasStandaloneStrategy(record: WatcherRecord): boolean {
    const merged = { ...(record.source.metadata ?? {}), ...(record.metadata ?? {}) };
    if (typeof merged.run === 'string' && merged.run.trim().length > 0) return true;
    if (record.kind === 'filesystem') return true;
    if (record.kind === 'webhook') return true;
    if (record.kind === 'manual') return true;
    if (record.kind === 'integration' || record.kind === 'socket') return false;
    return typeof merged.url === 'string' || typeof merged.endpoint === 'string';
  }

  /**
   * `watchers.recoveryWindowMinutes`, the restart half of the recovery story.
   *
   * A watcher that was running when the process stopped is re-armed above, but
   * re-arming alone means it does nothing until its first interval tick: on a
   * 30-minute poller, a restart used to cost half an hour of blindness on top of
   * however long the daemon was down. `startWatcher` has always run once
   * immediately for exactly that reason; the restore path never did.
   *
   * The window bounds that immediate catch-up. When the gap since the last
   * heartbeat is inside it, the watcher runs at once and picks up what it missed.
   * When the gap is longer, an immediate run would be reading a source whose
   * events the checkpoint can no longer bracket, so the watcher waits for its
   * normal tick and the skipped catch-up is stated in the log rather than left
   * for someone to infer from a hole in the heartbeats. A window of 0 means
   * "never catch up on restart", which is the honest floor of the key's range.
   */
  private catchUpAfterRestart(record: WatcherRecord, restoredAt: number, windowMs: number): void {
    const lastSeenAt = record.lastHeartbeatAt;
    const gapMs = lastSeenAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, restoredAt - lastSeenAt);
    if (windowMs > 0 && gapMs <= windowMs) {
      void this.runWatcher(record.id).catch((error: unknown) => {
        logger.warn('Watcher recovery catch-up run failed', { watcherId: record.id, error: summarizeError(error) });
      });
      return;
    }
    logger.info('Watcher restart skipped missed-event catch-up', {
      watcherId: record.id,
      gapMs: Number.isFinite(gapMs) ? gapMs : null,
      recoveryWindowMs: windowMs,
    });
  }

  private normalizeRecord(record: WatcherRecord): WatcherRecord {
    const freshness = sourceStatusFor(record);
    const state = freshness.nextState ?? record.state;
    return {
      ...record,
      state,
      ...(freshness.sourceLagMs !== undefined ? { sourceLagMs: freshness.sourceLagMs } : {}),
      sourceStatus: freshness.sourceStatus,
      ...(freshness.degradedReason ? { degradedReason: freshness.degradedReason } : {}),
    };
  }

  /**
   * A restored watcher whose work lives only in its owner's closure would run a
   * stand-in that reports healthy without checking anything; it is refused with
   * the state and the way out instead.
   */
  private refuseWhileAwaitingOwner(id: string, operation: 'start' | 'run'): void {
    if (!this.awaitingRegistration.has(id)) return;
    throw new Error(`Cannot ${operation} watcher "${id}": it was restored from disk and its work is held by the component that registered it. It runs again once that component registers it; until then it reports no heartbeat.`);
  }

  private async runWatcher(id: string): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.inFlight.has(id)) return;
    // No timer is armed for such a watcher, but a pending interval or a stale caller must not run the stand-in either.
    if (this.awaitingRegistration.has(id)) return;
    const watcher = this.watchers.get(id);
    if (!watcher) return;
    this.inFlight.add(id);
    try {
      const checkpoint = await watcher.run();
      // Re-read: the watcher may have been stopped, removed or re-registered while it ran.
      const current = this.watchers.get(id);
      // A manual run of a stopped watcher records its result but does not start it: no timer would drive it.
      // The same holds for a timer-driven watcher whose manual run failed first (stopped, then failed): with no timer it is not running.
      const undriven = watcher.record.state === 'stopped'
        || (watcher.record.state === 'failed' && !this.timers.has(id) && watcher.record.kind !== 'manual');
      const successState: WatcherState = undriven ? 'stopped' : 'running';
      if (!current || !runOutcomeApplies(watcher.record.state, current.record.state, successState)) return;
      const updated: WatcherRecord = this.normalizeRecord({
        ...current.record,
        state: successState,
        lastHeartbeatAt: now(),
        lastCheckpoint: checkpoint ? String(checkpoint) : watcher.record.lastCheckpoint,
        lastError: undefined,
        sourceStatus: 'healthy',
        sourceLagMs: 0,
        degradedReason: undefined,
      });
      this.watchers.set(id, { ...current, record: updated });
      this.persist();
      this.runtimeDispatch?.syncWatcher(updated, 'watchers.heartbeat');
      if (this.runtimeBus) {
        emitWatcherHeartbeat(this.runtimeBus, {
          sessionId: 'watchers',
          source: 'watcher-registry',
          traceId: id,
        }, {
          watcherId: id,
          sourceKind: toWatcherSourceKind(updated.kind),
          seenAt: updated.lastHeartbeatAt ?? now(),
          checkpoint: updated.lastCheckpoint ?? '',
        });
        // The heartbeat says the watcher ran; this says the source moved.
        if (checkpoint && updated.lastCheckpoint !== watcher.record.lastCheckpoint) {
          emitWatcherCheckpointAdvanced(this.runtimeBus, {
            sessionId: 'watchers',
            source: 'watcher-registry',
            traceId: id,
          }, {
            watcherId: id,
            sourceKind: toWatcherSourceKind(updated.kind),
            checkpoint: updated.lastCheckpoint ?? '',
          });
        }
      }
    } catch (error) {
      const current = this.watchers.get(id);
      if (!current || !runOutcomeApplies(watcher.record.state, current.record.state, 'failed')) {
        logger.warn('Watcher run failed after the watcher was stopped or removed; outcome discarded', { watcherId: id, error: summarizeError(error) });
        return;
      }
      const failed: WatcherRecord = this.normalizeRecord({
        ...current.record,
        state: 'failed',
        lastError: summarizeError(error),
        sourceStatus: 'failed',
        degradedReason: summarizeError(error),
      });
      this.watchers.set(id, { ...current, record: failed });
      this.persist();
      this.runtimeDispatch?.syncWatcher(failed, 'watchers.failed');
      if (this.runtimeBus) {
        // Whether the next interval's run can clear this failure is read from
        // the error, not asserted for every failure. The reading may reach a
        // model: when it cannot be made the failure is still published, as retryable.
        let retryable = true;
        try {
          retryable = (await this.readTransience(error, 'watchers.run')).failureClass === 'retryable';
        } catch (readingError) {
          logger.warn('Watcher failure transience could not be read; publishing it as retryable', {
            watcherId: id,
            error: summarizeError(readingError),
          });
        }
        // The watcher may have been stopped or removed during the reading; a
        // failure event after its stop event would end the stream on the wrong state.
        if (this.watchers.get(id)?.record.state !== 'failed') return;
        emitWatcherFailed(this.runtimeBus, {
          sessionId: 'watchers',
          source: 'watcher-registry',
          traceId: id,
        }, {
          watcherId: id,
          sourceKind: toWatcherSourceKind(failed.kind),
          error: failed.lastError ?? 'watcher failed',
          retryable,
        });
      }
    } finally {
      this.inFlight.delete(id);
    }
  }

  private buildRunStrategy(record: WatcherRecord): () => Promise<string | void> | string | void {
    const metadata = record.metadata ?? {};
    const sourceMetadata = record.source.metadata ?? {};
    const merged = { ...sourceMetadata, ...metadata };

    if (typeof merged.run === 'string' && merged.run.trim().length > 0) {
      return () => merged.run as string;
    }

    if (record.kind === 'filesystem') {
      const path = typeof merged.path === 'string' ? merged.path : typeof merged.filePath === 'string' ? merged.filePath : '';
      return () => {
        // A watcher with nothing to look at is a failed watcher, not a quiet one.
        if (!path) throw new Error('Filesystem watcher has no path to watch. Re-register it with a path.');
        // A missing file is a checkpoint change, so a file that appears or is removed is seen as an event.
        if (!existsSync(path)) return `${path}:missing`;
        const stat = statSync(path);
        return `${path}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      };
    }

    if (record.kind === 'webhook') {
      const url = typeof merged.url === 'string' ? merged.url : '';
      return () => {
        if (!url) throw new Error('Webhook watcher has no url to call. Re-register it with a url.');
        return this.pollUrl(url, merged);
      };
    }

    if (record.kind === 'integration') {
      return () => `integration:${record.source.id}:${record.label}`;
    }

    if (record.kind === 'socket') {
      return () => `socket:${typeof merged.address === 'string' ? merged.address : record.label}`;
    }

    // A manual run has no source to bracket: a timestamp would "advance" on every run.
    if (record.kind === 'manual') return () => undefined;

    const url = typeof merged.url === 'string' ? merged.url : typeof merged.endpoint === 'string' ? merged.endpoint : '';
    if (url) return () => this.pollUrl(url, merged);

    return () => undefined;
  }

  /**
   * One request of a url/webhook watcher. The whole run, request and body, is
   * bounded by one timeout so a stalled endpoint fails the run instead of
   * holding the watcher's in-flight slot forever, and a non-2xx answer fails
   * it too: an unreachable or unauthorised source is not a healthy one.
   */
  private async pollUrl(url: string, merged: Record<string, unknown>): Promise<string> {
    const headers = typeof merged.headers === 'object' && merged.headers !== null
      ? Object.fromEntries(Object.entries(merged.headers).filter(([, value]) => typeof value === 'string')) as Record<string, string>
      : undefined;
    if (headers !== undefined && this.resolveHeaderValue) {
      for (const [name, value] of Object.entries(headers)) {
        if (!value.trim().startsWith('goodvibes://secrets/')) continue;
        const resolved = await this.resolveHeaderValue(value);
        // Sending the request without its credential would report an auth failure as the source's.
        if (resolved === null) throw new Error(`Header "${name}" refers to a secret that could not be read; the request was not sent`);
        headers[name] = resolved;
      }
    }
    const response = await this.fetchUrl(url, {
      method: typeof merged.method === 'string' ? merged.method.toUpperCase() : 'GET',
      ...(headers !== undefined ? { headers } : {}),
      signal: AbortSignal.timeout(this.runTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Watched url answered HTTP ${response.status}`);
    }
    const text = await response.text();
    return `${response.status}:${text.slice(0, 120)}`;
  }

  /**
   * Write the snapshot and refresh the runtime store's copy of every record.
   *
   * Mutations and heartbeat completions persist, including timer callbacks
   * with nothing above them. This must not throw: a failed snapshot write is
   * logged loudly with the path and errno by the store and then dropped, the
   * in-memory registry carries on as the source of truth, and the next persist
   * retries. Watcher state rebuilds from live registrations on any load, so
   * losing a snapshot costs nothing that killing the process would not cost a
   * great deal more.
   */
  private persist(): void {
    saveWatcherSnapshotToPathSafe(
      sortWatchers([...this.watchers.values()].map((entry) => entry.record)),
      this.storePath,
    );
    for (const watcher of this.watchers.values()) {
      this.runtimeDispatch?.syncWatcher(watcher.record, 'watchers.persist');
    }
  }
}
