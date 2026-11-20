import { existsSync, statSync } from 'node:fs';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { WatcherKind, WatcherRecord, WatcherSourceStatus, WatcherState } from '../runtime/store/domains/watchers.js';
import type { AutomationSourceRecord } from '../automation/sources.js';
import type { WatcherSourceKind } from '../../events/watchers.js';
import { GoodVibesError, RefusalError, classifyFailure, refusal } from '@goodvibes-jev/engine/errors';
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
import type { AtomicWriteOutcome } from '../utils/atomic-json-store.js';
import { ownerDeliveryTargetProblem, postToPublicWebhook } from '../utils/url-safety.js';
import { PRIVATE_DELIVERY_HOSTS_SETTING } from '../runtime/network/destination.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import { GroupJobFamily, type GroupJobItem, type GroupWorkLink } from '../cluster/group-work.js';

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
  /**
   * The owner's approved hosts on their own network (`network.privateDeliveryHosts`),
   * read at each use. A watcher URL is configured by the owner, so a listed
   * host may resolve to a private address; any other private target is
   * refused when the watcher is registered, naming the setting.
   */
  readonly privateDeliveryHosts?: (() => readonly string[]) | undefined;
  /** How long one url/webhook run may take, request and body together. */
  readonly runTimeoutMs?: number | undefined;
  /**
   * Resolves a `goodvibes://secrets/` header value to the secret at request
   * time, so no header credential is stored in the watcher record. Without it
   * such a value is sent as written.
   */
  readonly resolveHeaderValue?: ((value: string) => Promise<string | null>) | undefined;
}

/** The last snapshot save that failed, while no later save has succeeded. */
export interface WatcherSnapshotSaveFailure {
  readonly filePath: string;
  readonly code?: string | undefined;
  readonly error: string;
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

/**
 * How long a successful run that changed no state may wait to be saved.
 * Every such run in the window shares one snapshot write; a run that changed
 * the state or cleared an error is saved at once.
 */
const HEARTBEAT_SAVE_DELAY_MS = 30_000;

type WatcherRun = () => Promise<string | void> | string | void;

interface RegisteredWatcher {
  readonly record: WatcherRecord;
  /** Absent only while a restored watcher waits for its owner to register it again. */
  readonly run: WatcherRun | undefined;
  /** The run came from the registering component, not from the record. */
  readonly ownerRun: boolean;
}

const LIVE_STATES: ReadonlySet<WatcherState> = new Set(['running', 'starting', 'degraded']);

/** What a run or the clock moves on a watcher: kept off the group's record, which carries the last run as its occurrence. */
const VOLATILE_FIELDS = ['lastHeartbeatAt', 'sourceLagMs', 'sourceStatus', 'degradedReason'] as const;

/**
 * Why a watcher with no run of its own cannot be registered: what its kind
 * needs, and what can be created without a component that owns the work.
 */
function nothingToRunRefusal(record: WatcherRecord): RefusalError {
  const accepted = "kind 'webhook' or 'polling' with a url, 'filesystem' with a path, or 'manual'";
  const needs: Record<WatcherKind, string> = {
    filesystem: 'A filesystem watcher needs a path to watch',
    webhook: 'A webhook watcher needs a url to call',
    polling: 'A polling watcher needs a url to request',
    manual: 'A manual watcher needs nothing',
    socket: `A socket watcher has no built-in check, so nothing would observe ${typeof record.metadata.address === 'string' ? record.metadata.address : 'the connection'}`,
    integration: 'An integration watcher has no built-in check, so nothing would observe the integration',
  };
  const ownerKind = record.kind === 'socket' || record.kind === 'integration';
  return new RefusalError(refusal({
    code: 'WATCHER_NOTHING_TO_RUN',
    state: `watcher "${record.id}" was not registered`,
    reason: `${needs[record.kind]}.`,
    next: ownerKind
      ? [`Register it from the component that owns the ${record.kind}, or create ${accepted}`]
      : [`Send the ${record.kind === 'filesystem' ? 'path' : 'url'}, or create ${accepted}`],
    status: 400,
  }));
}

/** The URL a webhook or polling watcher requests, or '' when it has none. */
function watchedUrl(record: WatcherRecord): string {
  if (record.kind !== 'webhook' && record.kind !== 'polling') return '';
  const merged = { ...(record.source.metadata ?? {}), ...(record.metadata ?? {}) };
  const text = (key: string): string => (typeof merged[key] === 'string' ? (merged[key] as string).trim() : '');
  return text('url') || (record.kind === 'polling' ? text('endpoint') : '');
}

/** A watcher whose URL delivery would refuse is refused when it is registered, with the setting that admits it. */
function targetRefusal(record: WatcherRecord, problem: string): RefusalError {
  return new RefusalError(refusal({
    code: 'WATCHER_TARGET_NOT_ALLOWED',
    state: `watcher "${record.id}" was not registered`,
    reason: problem,
    next: [`Use a public https URL, or approve the host on your own network in ${PRIVATE_DELIVERY_HOSTS_SETTING}`],
    status: 400,
  }));
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
   * supply, with the time they were restored. They are not armed, and do not
   * report a heartbeat, until the owner registers them again.
   */
  private readonly awaitingRegistration = new Map<string, number>();
  private readonly fetchUrl: (url: string, init: RequestInit) => Promise<Response>;
  /** True when requests go through the guarded default transport, whose rules registration applies. */
  private readonly guardedFetch: boolean;
  private readonly privateDeliveryHosts: () => readonly string[];
  private readonly runTimeoutMs: number;
  private readonly resolveHeaderValue: ((value: string) => Promise<string | null>) | undefined;
  private pendingSave: ReturnType<typeof setTimeout> | null = null;
  private saveFailure: WatcherSnapshotSaveFailure | undefined;
  /** The group's copy of the url watchers (cluster/group-work.ts), once attached; it acts only while this machine is in a group. */
  private group: GroupJobFamily | null = null;
  /** Per shared watcher, when a machine of the group last started a timed run of it. */
  private readonly groupOccurrences = new Map<string, number>();

  constructor(options: WatcherRegistryOptions = {}) {
    this.storePath = resolveWatcherStorePath(options.storePath);
    this.featureFlags = options.featureFlags ?? null;
    this.readRecoveryWindowMinutes = options.recoveryWindowMinutes
      ?? ((): number => DEFAULT_RECOVERY_WINDOW_MINUTES);
    this.privateDeliveryHosts = options.privateDeliveryHosts ?? ((): readonly string[] => []);
    this.guardedFetch = options.fetchUrl === undefined;
    this.fetchUrl = options.fetchUrl
      ?? ((url, init) => postToPublicWebhook(url, init, { allowHttp: true, approvedPrivateHosts: this.privateDeliveryHosts() }));
    this.runTimeoutMs = options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    this.resolveHeaderValue = options.resolveHeaderValue;
  }

  /**
   * The snapshot save that failed last, while none has succeeded since: the
   * watchers in memory work, but a restart would not bring back what the
   * failed save held.
   */
  snapshotSaveFailure(): WatcherSnapshotSaveFailure | undefined {
    return this.saveFailure;
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

  /**
   * Keep the url watchers made through the API (webhook and polling, whose
   * work is in the record) on the group's record (cluster/group-work.ts). In
   * a group they are listed on every machine and polled only by the machine
   * holding the automation role. Watchers a component registers with its own
   * work, and filesystem watchers (they look at this machine's disk), stay
   * this machine's own. Outside a group this changes nothing.
   */
  attachGroupWork(link: GroupWorkLink): void {
    if (this.group) return;
    const group = new GroupJobFamily(link, 'watcher');
    this.group = group;
    group.onRemoteChange((ids, caughtUp) => {
      if (ids.length > 0) this.takeFromGroup(ids);
      if (caughtUp && group.holdsRole()) for (const watcher of this.watchers.values()) if (this.sharedWithGroup(watcher)) this.armShared(watcher.record);
    });
    link.roles.onRoleChange('automation', (held) => {
      if (!held) {
        this.dropGroupTimers();
        return;
      }
      this.takeFromGroup();
      for (const watcher of this.watchers.values()) if (this.sharedWithGroup(watcher)) this.armShared(watcher.record);
    });
  }

  private sharedWithGroup(watcher: RegisteredWatcher): boolean {
    return !watcher.ownerRun && watcher.run !== undefined && (watcher.record.kind === 'webhook' || watcher.record.kind === 'polling');
  }

  /** Whether this machine polls the watcher: always outside a group, else where the automation role is held. */
  private runsHere(watcher: RegisteredWatcher): boolean {
    const group = this.group;
    if (!group || !this.sharedWithGroup(watcher) || !group.shared()) return true;
    return group.holdsRole();
  }

  private groupItem(record: WatcherRecord): GroupJobItem {
    const definition: Record<string, unknown> = { ...record, state: LIVE_STATES.has(record.state) ? 'running' : record.state };
    for (const field of VOLATILE_FIELDS) delete definition[field];
    return { id: record.id, definition, lastOccurrenceAt: this.groupOccurrences.get(record.id) ?? 0 };
  }

  private publishToGroup(): void {
    const group = this.group;
    if (!group?.shared()) return;
    const items = [...this.watchers.values()].filter((watcher) => this.sharedWithGroup(watcher)).map((watcher) => this.groupItem(watcher.record));
    void group.publish(items).catch((error: unknown) => {
      logger.warn('Watcher changes could not be written to the group\'s record; the next save tries again', { error: summarizeError(error) });
    });
  }

  /**
   * Take in what the group's record holds: url watchers made, changed,
   * stopped or removed on another machine. A removal is terminal, so a machine
   * that slept through one drops the watcher rather than bringing it back.
   */
  private takeFromGroup(only?: readonly string[]): void {
    const group = this.group;
    if (!group || !group.shared() || !this.isEnabled()) return;
    this.ensureLoaded();
    const local = new Map<string, GroupJobItem>();
    for (const watcher of this.watchers.values()) if (this.sharedWithGroup(watcher)) local.set(watcher.record.id, this.groupItem(watcher.record));
    const difference = group.difference(local, only);
    for (const id of difference.remove) {
      const timer = this.timers.get(id);
      if (timer) clearInterval(timer);
      this.timers.delete(id);
      this.watchers.delete(id);
      this.groupOccurrences.delete(id);
      this.runtimeDispatch?.removeWatcher(id, 'watchers.group');
    }
    for (const item of difference.adopt) {
      const definition = item.definition as unknown as WatcherRecord;
      if (definition.id !== item.id || typeof definition.label !== 'string' || (definition.kind !== 'webhook' && definition.kind !== 'polling') || !definition.source) continue;
      const existing = this.watchers.get(item.id);
      // A watcher this machine registers with its own work stays its own.
      if (existing?.ownerRun) continue;
      if (item.lastOccurrenceAt > 0) this.groupOccurrences.set(item.id, Math.max(this.groupOccurrences.get(item.id) ?? 0, item.lastOccurrenceAt));
      const heartbeat = Math.max(existing?.record.lastHeartbeatAt ?? 0, this.groupOccurrences.get(item.id) ?? 0);
      const record = this.normalizeRecord({ ...definition, ...(heartbeat > 0 ? { lastHeartbeatAt: heartbeat } : {}) });
      const run = this.buildRunStrategy(record);
      if (run === undefined) continue;
      const timer = this.timers.get(item.id);
      if (timer) clearInterval(timer);
      this.timers.delete(item.id);
      this.watchers.set(item.id, { record, run, ownerRun: false });
      group.adopted(item);
      this.runtimeDispatch?.syncWatcher(record, 'watchers.group');
      this.armShared(record);
    }
    if (difference.remove.length > 0 || difference.adopt.length > 0) this.persistNow();
    if (difference.seed.length > 0) {
      void group.publish(difference.seed).catch((error: unknown) => {
        logger.warn('This machine\'s watchers could not be written to the group\'s record; the next save tries again', { error: summarizeError(error) });
      });
    }
  }

  /**
   * Arm a shared watcher on the machine holding the automation role, keeping
   * the group's rhythm: its next run is one interval after the last run any
   * machine started, so a new holder neither repeats that run nor waits a
   * whole interval more.
   */
  private armShared(record: WatcherRecord): void {
    const watcher = this.watchers.get(record.id);
    if (!watcher || !this.runsHere(watcher) || this.timers.has(record.id)) return;
    if (!LIVE_STATES.has(watcher.record.state) || watcher.record.kind === 'manual' || Number(watcher.record.intervalMs ?? 0) <= 0) return;
    const intervalMs = watcher.record.intervalMs ?? 60_000;
    const last = Math.max(this.groupOccurrences.get(record.id) ?? 0, watcher.record.lastHeartbeatAt ?? 0);
    this.armInterval(record.id, intervalMs, last > 0 ? Math.max(0, last + intervalMs - now()) : 0);
  }

  /** The automation role went to another machine: stop polling every shared watcher here. */
  private dropGroupTimers(): void {
    for (const watcher of this.watchers.values()) {
      if (!this.sharedWithGroup(watcher)) continue;
      const timer = this.timers.get(watcher.record.id);
      if (timer) clearInterval(timer);
      this.timers.delete(watcher.record.id);
    }
  }

  /**
   * Arm a watcher's interval. With `firstDelayMs`, the first run comes after
   * that delay and the interval counts from it (a new holder continuing the
   * group's rhythm).
   */
  private armInterval(id: string, intervalMs: number, firstDelayMs?: number): void {
    const tick = () => this.runOnTimer(id);
    if (firstDelayMs === undefined) {
      const timer = setInterval(tick, intervalMs);
      timer.unref?.();
      this.timers.set(id, timer);
      return;
    }
    const first = setTimeout(() => {
      if (this.timers.get(id) !== first) return;
      const timer = setInterval(tick, intervalMs);
      timer.unref?.();
      this.timers.set(id, timer);
      tick();
    }, firstDelayMs);
    first.unref?.();
    this.timers.set(id, first);
  }

  /**
   * One timed run. A shared watcher runs only where the automation role is
   * held, and the run is written onto the group's record before it starts, so
   * the next holder counts its interval from it.
   */
  private runOnTimer(id: string, failure = 'Watcher interval run failed'): void {
    const watcher = this.watchers.get(id);
    const group = this.group;
    if (!watcher || !group || !this.sharedWithGroup(watcher) || !group.shared()) {
      void this.runWatcher(id).catch((error: unknown) => {
        logger.warn(failure, { watcherId: id, error: summarizeError(error) });
      });
      return;
    }
    if (!group.holdsRole() || this.inFlight.has(id)) return;
    const startedAt = now();
    this.groupOccurrences.set(id, startedAt);
    void group.publish([this.groupItem(watcher.record)])
      .then(() => this.runWatcher(id))
      .catch((error: unknown) => {
        logger.warn(failure, { watcherId: id, error: summarizeError(error) });
      });
  }

  registerWatcher(input: RegisterWatcherInput): WatcherRecord {
    this.requireEnabled('register watcher');
    this.ensureLoaded();
    const previous = this.watchers.get(input.id);
    const existing = previous?.record;
    const wasRunning = existing !== undefined && LIVE_STATES.has(existing.state);
    // An owner that brings its work ends the wait, and the wait's reason with it.
    const ownerReturned = input.run !== undefined && this.awaitingRegistration.has(input.id);
    if (ownerReturned) this.awaitingRegistration.delete(input.id);
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
      degradedReason: ownerReturned ? undefined : existing?.degradedReason,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    });
    // An update without a run (the PATCH route) keeps the owner's work.
    const ownerRun = input.run !== undefined || previous?.ownerRun === true;
    const run = input.run ?? (previous?.ownerRun === true ? previous.run : this.buildRunStrategy(record));
    // A restored watcher still waiting for its owner may be edited; anything
    // else with nothing to run would report heartbeats that observed nothing.
    if (run === undefined && !this.awaitingRegistration.has(record.id)) throw nothingToRunRefusal(record);
    if (!ownerRun && this.guardedFetch) {
      const url = watchedUrl(record);
      const problem = url ? ownerDeliveryTargetProblem(url, { allowHttp: true, approvedPrivateHosts: this.privateDeliveryHosts() }) : undefined;
      if (problem !== undefined) throw targetRefusal(record, problem);
    }
    const timer = this.timers.get(input.id);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(input.id);
    }
    this.watchers.set(record.id, { record, run, ownerRun });
    if (wasRunning && run !== undefined) {
      return this.startWatcher(record.id) ?? record;
    }
    this.persistNow();
    this.runtimeDispatch?.syncWatcher(record, 'watchers.register');
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
    this.persistNow();
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
      // In a group, a shared watcher is polled by the machine holding the
      // automation role, which takes the start from the record.
      const registered = this.watchers.get(id);
      if (registered && !this.runsHere(registered)) return started;
      this.armInterval(id, started.intervalMs ?? 60_000);
      this.runOnTimer(id, 'Watcher initial run failed');
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
   * A heartbeat save still waiting is written now, so the last runs are not
   * lost to the shutdown.
   *
   * Idempotent.
   */
  dispose(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    if (this.pendingSave !== null) this.persistNow();
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
    this.persistNow();
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
    const shared = this.sharedWithGroup(watcher) && this.group?.shared() === true;
    this.stopWatcher(id, 'removed');
    const removed = this.watchers.delete(id);
    if (removed) {
      this.awaitingRegistration.delete(id);
      this.groupOccurrences.delete(id);
      this.persistNow();
      this.runtimeDispatch?.removeWatcher(id, 'watchers.remove');
      // Removed in the group, for good: no machine polls or lists it again.
      if (shared) {
        void this.group!.remove(id, 'watchers', 'removed').catch((error: unknown) => {
          logger.warn('A watcher removal could not be written to the group\'s record', { watcherId: id, error: summarizeError(error) });
        });
      }
    }
    return removed;
  }

  private ensureLoaded(): void {
    if (!this.isEnabled()) return;
    if (this.loaded) return;
    const snapshot = loadWatcherSnapshotFromPath(this.storePath);
    const restoredAt = now();
    const restored: string[] = [];
    if (snapshot) {
      // A watcher registered in this process keeps its closure; the snapshot only adds the rest.
      for (const record of snapshot.watchers) {
        if (this.watchers.has(record.id)) continue;
        const run = this.buildRunStrategy(record);
        if (run === undefined) this.awaitingRegistration.set(record.id, restoredAt);
        this.watchers.set(record.id, { record, run, ownerRun: false });
        restored.push(record.id);
      }
    }
    this.loaded = true;
    const recoveryWindowMs = this.recoveryWindowMs();
    for (const watcher of this.watchers.values()) {
      const normalized = this.normalizeRecord(watcher.record);
      this.watchers.set(normalized.id, { ...watcher, record: normalized });
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
        // In a group, a shared watcher waits for the automation role (armShared).
        if (!this.runsHere(watcher)) continue;
        this.armInterval(normalized.id, normalized.intervalMs ?? 60_000);
        this.catchUpAfterRestart(normalized, restoredAt, recoveryWindowMs);
      }
    }
    // Restored records reach the runtime store once here; every later change
    // dispatches only the record it changed.
    for (const id of restored) {
      const watcher = this.watchers.get(id);
      if (watcher) this.runtimeDispatch?.syncWatcher(watcher.record, 'watchers.restore');
    }
    this.takeFromGroup();
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
    const awaitingSince = this.awaitingRegistration.get(record.id);
    if (awaitingSince !== undefined) {
      // Nothing runs, so there is no heartbeat to judge: the record says what it waits for.
      const { sourceLagMs: _lag, ...rest } = record;
      return {
        ...rest,
        state: LIVE_STATES.has(record.state) ? 'degraded' : record.state,
        sourceStatus: 'unknown',
        degradedReason: `awaiting its owner since ${new Date(awaitingSince).toISOString()}: restored from disk, it runs only when the component that registered it registers it again`,
      };
    }
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
    const since = this.awaitingRegistration.get(id);
    if (since === undefined) return;
    throw new RefusalError(refusal({
      code: 'WATCHER_AWAITING_OWNER',
      state: `watcher "${id}" was restored from disk at ${new Date(since).toISOString()} and waits for the component that registered it`,
      reason: `Cannot ${operation} watcher "${id}": its work is held by the component that registered it, and that component has not registered it again.`,
      next: [
        'It runs again when that component starts and registers it',
        `If nothing registers it any more, remove it with watchers.delete (DELETE /api/watchers/${encodeURIComponent(id)})`,
      ],
      status: 409,
    }));
  }

  private async runWatcher(id: string): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.inFlight.has(id)) return;
    // No timer is armed for such a watcher, but a pending interval or a stale caller must not run the stand-in either.
    if (this.awaitingRegistration.has(id)) return;
    const watcher = this.watchers.get(id);
    if (!watcher?.run) return;
    const run = watcher.run;
    this.inFlight.add(id);
    try {
      const checkpoint = await run();
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
      // Only the heartbeat and checkpoint moved: the save can wait and share a
      // write (dispose flushes it). A change of state or a cleared error is saved now.
      if (updated.state === current.record.state && current.record.lastError === undefined) {
        this.persistSoon();
      } else {
        this.persistNow();
      }
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
      this.persistNow();
      this.runtimeDispatch?.syncWatcher(failed, 'watchers.failed');
      if (this.runtimeBus) {
        // Whether the next interval's run can clear this failure comes from the
        // error's status, errno code or class. With none of them it is
        // retryable: the next interval runs the watcher again either way.
        const retryable = classifyFailure(error)?.retryable ?? true;
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

  /**
   * The run a record carries on its own: a path to look at, a url to request,
   * or a manual trigger. Undefined when the work is a closure only the
   * registering component holds.
   */
  private buildRunStrategy(record: WatcherRecord): WatcherRun | undefined {
    const merged = { ...(record.source.metadata ?? {}), ...(record.metadata ?? {}) };
    const text = (key: string): string => (typeof merged[key] === 'string' ? (merged[key] as string).trim() : '');

    if (record.kind === 'filesystem') {
      const path = text('path') || text('filePath');
      if (!path) return undefined;
      return () => {
        // A missing file is a checkpoint change, so a file that appears or is removed is seen as an event.
        if (!existsSync(path)) return `${path}:missing`;
        const stat = statSync(path);
        return `${path}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
      };
    }

    if (record.kind === 'webhook' || record.kind === 'polling') {
      const url = watchedUrl(record);
      return url ? () => this.pollUrl(url, merged) : undefined;
    }

    // A manual run has no source to bracket: a timestamp would "advance" on every run.
    if (record.kind === 'manual') return () => undefined;

    return undefined;
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
    try {
      const response = await this.fetchUrl(url, {
        method: typeof merged.method === 'string' ? merged.method.toUpperCase() : 'GET',
        ...(headers !== undefined ? { headers } : {}),
        signal: AbortSignal.timeout(this.runTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        // The status travels on the error so whether a retry can clear it is a table lookup.
        throw new GoodVibesError(`Watched url answered HTTP ${response.status}`, { status: response.status });
      }
      const text = await response.text();
      return `${response.status}:${text.slice(0, 120)}`;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GoodVibesError(`Watched url did not answer within ${Math.round(this.runTimeoutMs / 1000)} s`, { category: 'timeout', cause: error });
      }
      throw error;
    }
  }

  /**
   * Write the snapshot now, replacing any heartbeat save still waiting.
   *
   * This must not throw: a failed write is logged with the path and errno by
   * the store, kept as {@link snapshotSaveFailure} for the caller that changed
   * something to report, and the next save retries. The in-memory registry
   * stays the source of truth. The runtime store is not touched here: each
   * caller dispatches the one record it changed.
   */
  private persistNow(): AtomicWriteOutcome {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    const outcome = saveWatcherSnapshotToPathSafe(
      sortWatchers([...this.watchers.values()].map((entry) => entry.record)),
      this.storePath,
    );
    this.saveFailure = outcome.ok
      ? undefined
      : { filePath: outcome.filePath, ...(outcome.code !== undefined ? { code: outcome.code } : {}), error: outcome.error?.message ?? 'the snapshot write failed' };
    this.publishToGroup();
    return outcome;
  }

  /** One snapshot write for every heartbeat that lands within the delay. */
  private persistSoon(): void {
    if (this.pendingSave !== null) return;
    const timer = setTimeout(() => {
      this.pendingSave = null;
      this.persistNow();
    }, HEARTBEAT_SAVE_DELAY_MS);
    timer.unref?.();
    this.pendingSave = timer;
  }
}
