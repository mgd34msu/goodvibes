import { drainOwned } from '@goodvibes-jev/judgment/decisions';
/**
 * DaemonLifecycleRuntime, the daemon facade's lifecycle sidecar: the
 * clean-shutdown marker (crash detection), the persisted receipt store
 * ("updated from X to Y at HH:MM", "restarted after a crash at HH:MM"),
 * and the hourly auto-updater (owner-directed default-on; update.auto
 * turns it off).
 *
 * Kept beside facade.ts so the facade only carries thin lifecycle hooks:
 * onStarted() after the server is accepting, onStopping() during an
 * orderly stop, and collectReceipts() for the /status payload.
 */
import { join } from 'node:path';
import { assertNativeReaderCompatible, parseNativeReaderCapabilities, NativeDataCompatibilityError } from '../runtime/native-reader-compatibility.js';
import { observeServiceCommand, runServiceCommand, type ServiceCommandRunner, type ServiceHandoverOutcome } from './service-handover.js';
import { flushActivityLogSync, logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { ConfigManager } from '../config/manager.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import type { PlatformServiceManager } from './service-manager.js';
import { DaemonAutoUpdater, type AutoUpdateServiceActions } from './auto-updater.js';
import { prepareHandoverBeforeStop, prepareServiceHandover, ServiceHandoverPreflightError, type PreparedServiceHandover } from './service-handover-preflight.js';
import { reserveLaunchdHandover } from './launchd-handover.js';
import { fileObservationIdentity, readFileObservation } from '../utils/file-observation.js';
import { DaemonReceiptStore, formatReceiptTime } from './receipts.js';
import { writeFatalLine } from './fatal-boot-report.js';
import { FeatureAnnouncementStore, collectStartupAnnouncements, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import {
  readLifecycleMarker,
  recordDaemonAutoRollback,
  recordDaemonCleanShutdown,
  recordDaemonStart,
  recordDaemonRejection,
  withdrawDaemonRejection,
  recordDaemonStartAttempt,
  type LifecycleMarkerIo,
  type ProcessIdentityProbe,
} from './lifecycle-marker.js';
import { crashLoopRollbackReceipt, decideCrashLoopRollback } from './boot-rollback.js';
import { inspectDaemonUpdateInstallation, resolveDaemonUpdateTargets } from '../runtime/daemon-update-installation.js';
import { configuredSuiteWebuiDirectory, rollbackSuiteUpdate, SuiteUpdatePreparationError, SuiteUpdateRecoveryError } from '../runtime/suite-update.js';
import { rollbackKeptPrevious, realUpdateFileIo, captureUpdateFileIo, retainDaemonNativeFiles, UpdateTransactionError, UpdateTransactionContendedError, compareVersions, normalizeVersion, describeTransactionRecovery, type UpdateFileIo, type UpdateTransactionReceipt, type DaemonCurrentReader } from '../runtime/self-update.js';
import { currentProcessSignals, isCompiledBinaryInvocation } from './daemon-exec-invocation.js';
import { deliverOwnerAlert } from './owner-alert.js';
import type { DaemonUpdateCheckStatus, DaemonUpdateStatus } from './update-status.js';
export type { DaemonUpdateCheckOutcome, DaemonUpdateCheckStatus, DaemonUpdateStatus } from './update-status.js';
import type { RouteBindingManager } from '../channels/route-manager.js';
import type { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import { sweepStaleWebSocketOutboxes } from './websocket-outbox.js';

/**
 * The daemon's owner-alert callback: put one line in front of the owner over a
 * channel that still works.
 *
 * It reuses the SAME path a failing channel uses (owner-alert.ts) rather than
 * adding a second notification mechanism. `null` for the preferred surface
 * because the subject here is not a channel, the daemon cannot update itself,
 * or has just rolled itself back to an older build, so no surface earns the
 * first try and the order is simply the most recently used conversation.
 */
export function createDaemonOwnerAlerter(
  routeBindings: RouteBindingManager,
  delivery: Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice'>,
): (text: string) => void {
  return (text: string) => {
    void deliverOwnerAlert(routeBindings, delivery, null, text);
  };
}

export { runDaemonSessionStoreBoot } from './daemon-session-store-boot.js';

/**
 * The daemon heartbeat watcher: a polling watcher that stamps an ISO
 * timestamp on the configured heartbeat interval. Registered from start()
 * only when watchers are enabled; the facade stops it on shutdown.
 */
export function registerDaemonHeartbeatWatcher(
  watcherRegistry: {
    registerPollingWatcher(input: {
      id: string;
      label: string;
      source: { id: string; kind: 'watcher'; label: string; enabled: boolean; createdAt: number; updatedAt: number; metadata: Record<string, never> };
      intervalMs: number;
      run: () => string;
    }): void;
    startWatcher(id: string): void;
  },
  configManager: ConfigManager,
  onBeat?: () => void,
): void {
  watcherRegistry.registerPollingWatcher({
    id: 'daemon-heartbeat',
    label: 'Daemon heartbeat',
    source: {
      id: 'source:daemon-heartbeat',
      kind: 'watcher',
      label: 'Daemon heartbeat',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {},
    },
    intervalMs: Number(configManager.get('watchers.heartbeatIntervalMs') ?? DEFAULT_CONFIG.watchers.heartbeatIntervalMs),
    run: () => {
      // The reachability heartbeat is also when schedule drift is reconciled:
      // a host that slept while the daemon kept running catches its missed
      // occurrences here, not only at boot. Never let a beat throw.
      if (onBeat) {
        try {
          onBeat();
        } catch (error) {
          logger.warn('Daemon heartbeat reconcile hook failed', { error: summarizeError(error) });
        }
      }
      return new Date().toISOString();
    },
  });
  watcherRegistry.startWatcher('daemon-heartbeat');
}

/**
 * Identity of the RUNNING artifact for the auto-update loop. The daemon
 * facade must never assume the platform package is the shipped artifact: an
 * embedding host names its own version (what release tags are compared
 * against) and, optionally, the executable the swap replaces. Absent, the
 * embedded default, means the HOST manages updates: the loop stays off,
 * because comparing the platform's package version against a host's release tags
 * is meaningless and the swap would target the wrong binary.
 */
export interface DaemonUpdateArtifact {
  /** The running artifact's own version, compared against release tags. */
  readonly version: string;
  /** This actual installed executable is part of the monorepo suite. */
  readonly suite?: true;
  /** The executable the verified swap replaces. Defaults to process.execPath. */
  readonly execPath?: string | undefined;
  /** Retained healthy installation; required before normal startup or promotion. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Allows only the initial crash-loop decision to inspect a damaged current build. */
  readonly assertStarting?: (() => void) | undefined;
  /** Original healthy program's compiled readers. Its guard retains that
   * cohort while the canonical updater separately owns transaction slots. */
  readonly currentReader?: DaemonCurrentReader;
}

export interface DaemonLifecycleRuntimeOptions {
  readonly configManager: ConfigManager;
  readonly platformServiceManager: PlatformServiceManager;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  /** Absent = host-managed updates (the safe embedded default): no auto-update loop AND no boot promotion. */
  readonly updateArtifact?: DaemonUpdateArtifact | undefined;
  /** Injectable process exit (boot promotion hands over by exiting); tests observe instead of dying. */
  readonly exitProcess?: ((code: number) => void) | undefined;
  /**
   * The daemon's own orderly stop, run before an update or crash-loop-rollback
   * restart or boot service promotion hands over, so shutdown hooks fire instead of
   * being skipped by a bare exit. Absent = nothing to wind down. Reentrant
   * lifecycle stops use the explicit forHandover=true path to avoid self-wait.
   */
  readonly stopGracefully?: (() => Promise<void> | void) | undefined;
  /** Injectable marker filesystem; tests drive the crash-loop counter in memory. */
  readonly markerIo?: LifecycleMarkerIo | undefined;
  /** Seam for telling a live marker owner from a dead one; tests inject it, the real process table otherwise. */
  readonly markerProcessIdentity?: ProcessIdentityProbe | undefined;
  /** Injectable swap/rename filesystem for the crash-loop rollback. */
  readonly rollbackIo?: UpdateFileIo | undefined;
  /** Injectable clock for receipts and marker stamps. */
  readonly now?: (() => number) | undefined;
  /** Injectable stderr; the crash-loop rollback says what it did before the process hands over. */
  readonly stderr?: { write(chunk: string): unknown } | undefined;
  /** Boot-promotion idle recheck cadence. Default 60s; floored at 1s. */
  readonly promotionRetryMs?: number | undefined;
  /**
   * True when this process was told to run out of a home that is NOT the
   * machine's default, `--daemon-home`, `GOODVIBES_DAEMON_HOME`, a test
   * harness's temp tree.
   *
   * Such a daemon must NEVER adopt the machine's service unit. It happened:
   * a daemon started from a scratchpad directory found the owner's unit not
   * running, wrote its own scratchpad `ExecStart` into
   * `~/.config/systemd/user/goodvibes.service`, and exited. systemd then
   * supervised the throwaway daemon as the machine's daemon, which is how it
   * came to be reading the owner's real credentials and long-polling their
   * real Telegram bot, producing the 409 that killed inbound messages.
   *
   * Promotion means "this process should be the machine's daemon forever".
   * A process running from a directory that may not exist tomorrow cannot
   * honestly claim that, so the claim is refused rather than merely discouraged.
   */
  readonly hasOverriddenHome?: boolean | undefined;
  /**
   * Whether this process is a compiled single-file binary. Only a compiled
   * binary self-promotes to a supervised service, a source/dev run would write
   * a unit whose ExecStart is a dev command line that fails on the next boot.
   * Injectable for tests; defaults to the real process-signal check.
   */
  readonly isCompiledBinary?: (() => boolean) | undefined;
  /**
   * Put one line in front of the owner over a channel that still works. The
   * facade supplies the existing owner-alert path; absent (embedded daemons,
   * tests) means the ERROR log line is the whole record.
   */
  readonly alertOwner?: ((text: string) => void) | undefined;
  /** Observed, bounded service-manager commands; injectable without touching a real service. */
  readonly serviceCommandRunner?: ServiceCommandRunner | undefined;
  readonly serviceCommandTimeoutMs?: number | undefined;
  readonly servicePlatform?: NodeJS.Platform | undefined;
  /** Trusted host/test seam; ordinary Darwin launches use the native helper owner. */
  readonly reserveLaunchdHandover?: typeof reserveLaunchdHandover | undefined;
  /**
   * Called once when an update, rollback or promotion handover did not
   * complete AFTER this process had already stopped its runtime. Such a
   * process serves nothing and no supervisor restarts it while it stays
   * alive, so the host that owns the process ends it with a failure status.
   * Absent (embedders, tests): the incomplete handover is only reported.
   */
  readonly onIncompleteHandover?: (() => void) | undefined;
}

/**
 * A native handover the composing host must wait for before it continues.
 * `resumed` is true when the handover ended WITHOUT stopping the runtime
 * (its preparation was refused), so the host keeps serving instead of ending.
 */
export interface NativeHandover {
  readonly state: 'handover';
  readonly drain: Promise<void>;
  readonly cancel: () => void;
  readonly resumed?: (() => boolean) | undefined;
}

/** A crash-loop rollback that would not return to an older, unrejected build. */
class RollbackTargetRefusedError extends Error {}

/** The rejection of the failing build could not be recorded durably, so nothing was swapped. */
class RollbackMarkerUnwritableError extends Error {}

export class DaemonLifecycleRuntime {
  private lastRollbackPreflightRefusal: string | null = null;
  private autoUpdater: DaemonAutoUpdater | null = null;
  private appliedUpdater: DaemonAutoUpdater | null = null;
  private store: DaemonReceiptStore | null = null;
  /** Why the self-update loop is not running. Empty once it is. */
  private updateLoopOffReason = 'the daemon has not finished starting';
  private promotionTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Whether THIS process has ever reached a fully-started daemon.
   *
   * A control-plane binding change now rebinds only the listener, but an
   * embedder may still stop() and start() the same facade in-process. Each
   * such re-entry used to record another "start attempt", and a long-running,
   * perfectly healthy daemon accumulated a failed-start streak from its own
   * restart cycles and rolled ITSELF back to the kept previous binary: a
   * daemon up for ten hours restored an older build over itself, and that
   * older build could not start at all, leaving the machine with no daemon
   * overnight.
   *
   * A failed START means the process never came up. A process that came up
   * cannot retroactively become one, so once this is set the crash-loop guard
   * takes no further part in this process's life.
   */
  private reachedFullyStarted = false;
  private promotionTask: Promise<void> | null = null;
  private promotionHandover: NativeHandover | undefined;
  private promotionAbort: AbortController | null = null;
  private promotionAttempted = false;
  /** The promotion handed over and asked the process to exit; nothing about it is stale. */
  private promotionExited = false;
  private rollbackHandover: Promise<void> | null = null;
  private rollbackPreparation: Promise<boolean> | null = null;
  private rollbackExitRequested = false;
  private rollbackApplied = false;
  /** The rejection written before a rollback exchange, and the one it replaced. */
  private rejectionStamp: { readonly version: string; readonly restore: string | undefined } | null = null;
  private rollbackRecovery: UpdateTransactionReceipt | null = null;
  private installationStartRefused = false;
  private stopping = false;
  private rollbackAbort: AbortController | null = null;

  private readonly assertArtifactCurrent: (() => void) | undefined;
  private readonly assertArtifactStarting: (() => void) | undefined;
  private readonly currentReader: DaemonCurrentReader | undefined;

  constructor(private readonly options: DaemonLifecycleRuntimeOptions) {
    const artifact = options.updateArtifact;
    this.assertArtifactCurrent = artifact?.assertCurrent?.bind(artifact);
    this.assertArtifactStarting = artifact?.assertStarting?.bind(artifact) ?? this.assertArtifactCurrent;
    if (artifact?.currentReader) {
      const reader = artifact.currentReader, readers = reader.readers, guard = reader.assertCurrent, execPath = artifact.execPath, version = artifact.version;
      this.currentReader = Object.freeze({ readers: parseNativeReaderCapabilities(readers), assertCurrent: () => {
        if (options.updateArtifact !== artifact || artifact.currentReader !== reader || reader.readers !== readers || reader.assertCurrent !== guard
          || artifact.execPath !== execPath || artifact.version !== version) throw new Error('Running native reader ownership changed');
        return guard.call(reader);
      } });
    }
  }

  /** Lazily-created persisted store for update/crash receipts. */
  receiptStore(): DaemonReceiptStore {
    if (!this.store) {
      this.store = new DaemonReceiptStore(
        join(this.options.configManager.getControlPlaneConfigDir(), 'control-plane', 'daemon-receipts.json'),
      );
    }
    return this.store;
  }

  private markerPath(): string {
    return join(this.options.configManager.getControlPlaneConfigDir(), 'control-plane', 'daemon-lifecycle.json');
  }

  /**
   * Undelivered receipts for a consuming /status read (`?receipts=consume`);
   * marked delivered once served. The route only calls this when the reader
   * passed the explicit flag, plain status reads are receipt-neutral.
   *
   * Fired announce-once feature lines (web surface URL, first contained run)
   * ride the same exactly-once feed: they are drained from the announcement
   * store's pending queue here, so a surface reading receipts at attach
   * renders them instead of them dead-ending in the daemon log.
   */
  collectReceipts(): readonly { id: string; text: string; at: number }[] {
    const receipts = this.receiptStore().consumeUndelivered().map(({ id, text, at }) => ({ id, text, at }));
    const announcements = this.announcementStore().drainPending().map(({ id, text, at }) => ({
      id: `announcement-${id}`,
      text,
      at,
    }));
    return [...receipts, ...announcements];
  }

  /**
   * The same receipts and announcements as {@link collectReceipts}, left
   * undelivered. A reader that loses the response can ask again; it names what
   * it received through {@link acknowledgeReceipts}.
   */
  peekReceipts(): readonly { id: string; text: string; at: number }[] {
    const receipts = this.receiptStore().peekUndelivered().map(({ id, text, at }) => ({ id, text, at }));
    const announcements = this.announcementStore().peekPending().map(({ id, text, at }) => ({
      id: `announcement-${id}`,
      text,
      at,
    }));
    return [...receipts, ...announcements];
  }

  /** Marks the receipts and announcements a reader says it received (ids as {@link peekReceipts} returned them). */
  acknowledgeReceipts(ids: readonly string[]): void {
    const receiptIds = new Set<string>();
    const announcementIds = new Set<string>();
    for (const id of ids) {
      if (id.startsWith('announcement-')) announcementIds.add(id.slice('announcement-'.length));
      else receiptIds.add(id);
    }
    if (receiptIds.size > 0) this.receiptStore().markDelivered(receiptIds);
    if (announcementIds.size > 0) this.announcementStore().acknowledge(announcementIds);
  }

  /** The shared announce-once store (same file the runtime's announcers write). */
  private announcementStore(): FeatureAnnouncementStore {
    return new FeatureAnnouncementStore(featureAnnouncementsPath(this.options.configManager));
  }

  /**
   * Says it on stderr as well as in the log.
   *
   * The activity log buffers and flushes asynchronously, and every branch that
   * uses this exits the process moments later, so the log line that explains
   * why is exactly the line that gets discarded. stderr is synchronous and
   * lands wherever the daemon's output goes (the service journal, a terminal),
   * which is where an operator looks when a daemon keeps restarting. The same
   * reasoning already governs the fatal-error path in daemon/cli.ts.
   */
  private announceOnStderr(line: string): void {
    try {
      // Synchronous write to fd 2 by default: every branch that calls this
      // exits moments later, and `process.stderr` is both replaceable by a
      // host and asynchronously flushed, which is how the released daemon
      // came to die with zero bytes on either stream. The injected seam is
      // kept so tests can observe. See daemon/fatal-boot-report.ts.
      if (this.options.stderr) this.options.stderr.write(`${line}\n`);
      else writeFatalLine(line);
    } catch {
      // A closed/unwritable stderr must never turn a rollback into a crash.
    }
  }

  /**
   * Put a line in front of the owner AND state it at ERROR. Never throws: an
   * alert that cannot be delivered must not turn a rollback into a crash.
   */
  private alertOwner(text: string): void {
    logger.error(`DaemonServer: ${text}`);
    try {
      this.options.alertOwner?.(text);
    } catch (error) {
      logger.error('DaemonServer: the owner alert could not be sent', { error: summarizeError(error) });
    }
  }

  /** Marker call options honoring the injected filesystem/clock seams. */
  private markerOptions(): { io?: LifecycleMarkerIo; now?: () => number; processIdentity?: ProcessIdentityProbe } {
    return {
      ...(this.options.markerIo ? { io: this.options.markerIo } : {}),
      ...(this.options.markerProcessIdentity ? { processIdentity: this.options.markerProcessIdentity } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
    };
  }

  /**
   * The FIRST thing daemon start() does, before anything that can fail: record
   * this boot as an unconfirmed start attempt, and, when the boots before it
   * kept failing to reach a fully-started daemon, restore the kept previous
   * binary instead of repeating the same failure again.
   *
   * Returns true when the caller must ABANDON this boot: a rollback handover
   * is in flight, or a filesystem recovery fence requires inspection first.
   *
   * A daemon with no update-artifact identity (host-managed updates, embedded
   * daemons, dev runs) does not own the binary on disk: it neither counts its
   * boots nor restores anything, and always returns false.
   */
  onStarting(): boolean | Promise<boolean> {
    if (this.rollbackPreparation) return this.rollbackPreparation;
    if (this.rollbackRecovery) return true;
    const artifact = this.options.updateArtifact;
    if (!artifact) return false;
    if (this.rollbackApplied || this.appliedUpdater) return true;
    // An in-process restart cycle (a control-plane binding change re-enters
    // start()) is not a boot. See `reachedFullyStarted`.
    if (this.reachedFullyStarted) {
      try { this.assertArtifactCurrent?.(); }
      catch (error) { this.installationStartRefused = true; throw error; }
      return false;
    }
    try { this.assertArtifactStarting?.(); }
    catch (error) { this.installationStartRefused = true; throw error; }
    const completeStarting = (abandon: boolean): boolean => {
      if (!abandon) {
        try { this.assertArtifactCurrent?.(); }
        catch (error) { this.installationStartRefused = true; throw error; }
      }
      return abandon;
    };
    const threshold = Number(this.options.configManager.get('update.rollbackAfterFailedStarts') ?? 3);
    let attempt: ReturnType<typeof recordDaemonStartAttempt>;
    try {
      attempt = recordDaemonStartAttempt(this.markerPath(), { ...this.markerOptions(), version: artifact.version });
    } catch (error) {
      logger.warn('DaemonServer: could not record the start attempt, crash-loop rollback is not armed this boot', {
        error: summarizeError(error),
      });
      return completeStarting(false);
    }
    if (attempt.foreignOwner) {
      logger.warn('DaemonServer: another running daemon owns the lifecycle marker for this home; this boot is not counted toward a crash-loop rollback', {
        ownerPid: attempt.foreignOwner.pid,
      });
      return completeStarting(false);
    }
    if (attempt.failedStarts === 0) return completeStarting(false);
    if (!Number.isFinite(threshold) || threshold < 1) {
      logger.warn('DaemonServer: previous boots did not reach a fully-started daemon; automatic rollback is off (update.rollbackAfterFailedStarts)', {
        failedStarts: attempt.failedStarts,
      });
      return completeStarting(false);
    }
    const verdict = decideCrashLoopRollback({
      failedStarts: attempt.failedStarts,
      autoRollbackAt: attempt.autoRollbackAt,
      threshold,
    });
    if (!verdict.rollback) {
      logger.warn('DaemonServer: the previous boot(s) never reached a fully-started daemon', {
        failedStarts: attempt.failedStarts,
        rollbackAfterFailedStarts: threshold,
        reason: verdict.reason,
      });
      return completeStarting(false);
    }
    // A build that has already come up on this host was not broken by an
    // update. Its failed starts are environmental (a port in use, a bad bind
    // host), and swapping the binary would leave the machine on an older build
    // that fails the same way, with the healthy release marked rejected.
    const proven = attempt.previous?.lastStartedVersion;
    if (proven !== undefined && normalizeVersion(proven) === normalizeVersion(artifact.version)) {
      logger.warn('DaemonServer: repeated failed starts of a build that has fully started here before; not rolling back', {
        failedStarts: verdict.failedStarts,
        version: artifact.version,
      });
      this.announceOnStderr(`goodvibes daemon: ${verdict.failedStarts} starts in a row did not finish, but v${normalizeVersion(artifact.version)}`
        + ' has fully started on this machine before, so the failures are not caused by an update and no automatic rollback was made.'
        + ' Check the control-plane host and port settings and the daemon log for the startup error.');
      return completeStarting(false);
    }
    const rollback = this.rollBackToKeptPrevious(artifact.execPath ?? process.execPath, verdict.failedStarts);
    if (typeof rollback === 'boolean') return completeStarting(rollback);
    const completion = rollback.then(completeStarting).finally(() => {
      if (this.rollbackPreparation === completion) this.rollbackPreparation = null;
    });
    this.rollbackPreparation = completion;
    return completion;
  }

  /**
   * Restore each installed file from its kept `<path>.previous` copy, leave a
   * receipt, and hand over to the restored binary. Returns false, this boot
   * continues on the current build, when there is nothing on disk to restore:
   * a rollback that did not happen must never be reported as one.
   */
  private rollBackToKeptPrevious(execPath: string, failedStarts: number, admitted?: PreparedServiceHandover): boolean | Promise<boolean> {
    let handover = admitted;
    try { handover ??= prepareServiceHandover(this.buildServiceActions()); }
    catch (error) { this.reportRollbackPreflightRefusal(error); return false; }
    if (handover?.reservationRequired && !admitted) return this.reserveRollbackHandover(execPath, failedStarts, handover);
    const io = captureUpdateFileIo(this.options.rollbackIo ?? realUpdateFileIo);
    const nativeTargets = resolveDaemonUpdateTargets(execPath, process.platform, process.arch);
    if (!nativeTargets) return false;
    const targets = nativeTargets.map(({ label, path }) => ({ label, path }));
    let result: ReturnType<typeof rollbackKeptPrevious>;
    try {
      const installed = inspectDaemonUpdateInstallation(execPath, process.platform, process.arch, '', io, { integrity: false });
      if (!installed || installed.version !== this.options.updateArtifact?.version) throw new Error('The running daemon does not own the current native installation version');
      if (this.options.updateArtifact?.suite) {
        let previous: ReturnType<typeof inspectDaemonUpdateInstallation> = null;
        try { previous = inspectDaemonUpdateInstallation(execPath, process.platform, process.arch, '.previous', io); }
        catch { /* The suite transaction performs its own complete previous-cohort checks. */ }
        if (previous) this.assertRollbackTarget(previous.version, installed.version);
        const restored = rollbackSuiteUpdate({ execPath, platform: process.platform, arch: process.arch, currentVersion: this.options.updateArtifact.version,
          beforeCommit: () => { handover?.assertCurrent(); this.stampRejectionBeforeExchange(); },
          webuiDirectory: configuredSuiteWebuiDirectory(this.options.configManager), io, assertCurrent: () => {
            if (this.stopping || this.rollbackRecovery || this.rollbackApplied) throw new Error('Suite rollback no longer belongs to the current lifecycle');
          } });
        result = { restored: [...restored.files], skipped: [] };
      } else {
        const previousInstallation = inspectDaemonUpdateInstallation(execPath, process.platform, process.arch, '.previous', io);
        if (!previousInstallation) throw new Error('No complete verified previous native daemon installation is available');
        this.assertRollbackTarget(previousInstallation.version, installed.version);
        const current = retainDaemonNativeFiles(nativeTargets, io);
        result = rollbackKeptPrevious(targets, io, () => {
        handover?.assertCurrent();
        if (this.stopping || this.rollbackRecovery || this.rollbackApplied) throw new Error('Native rollback no longer belongs to the current lifecycle');
        this.stampRejectionBeforeExchange();
        current();
        const previous = inspectDaemonUpdateInstallation(execPath, process.platform, process.arch, '.previous', io);
        if (!previous) throw new Error('Previous native reader is unavailable');
        assertNativeReaderCompatible(execPath, previous.version, io, previous.readers);
      }, { requireComplete: true, native: true, assertCurrent: () => {
        if (this.stopping || this.rollbackRecovery || this.rollbackApplied) throw new Error('Native rollback no longer belongs to the current lifecycle');
      } });
      }
    } catch (failure) {
      const committedFailure = failure instanceof SuiteUpdateRecoveryError ? failure.committed
        : failure instanceof UpdateTransactionError && failure.receipt.committed;
      if (!committedFailure) this.withdrawRejectionStamp();
      if (failure instanceof RollbackTargetRefusedError) {
        try { this.receiptStore().record(failure.message); } catch { /* The synchronous owner notice still reports the refusal. */ }
        this.alertOwner(failure.message);
        this.announceOnStderr(failure.message);
        return false;
      }
      const error = failure instanceof SuiteUpdateRecoveryError
        ? new UpdateTransactionError({ operation: 'rollback', phase: 'cleanup', committed: failure.committed, recoveryRequired: true,
          targets: [...targets.map(target => target.path), ...failure.paths], recoveryPaths: [...failure.paths], recoveryErrors: failure.problems.map(problem => summarizeError(problem)) }, failure)
        : failure;
      if (error instanceof UpdateTransactionError && (error.receipt.committed || error.receipt.recoveryRequired)) {
        this.rollbackRecovery = {
          ...error.receipt,
          targets: [...error.receipt.targets],
          recoveryPaths: [...error.receipt.recoveryPaths],
          recoveryErrors: [...error.receipt.recoveryErrors],
        };
        this.rollbackApplied = error.receipt.committed;
        this.beginStopping();
        const detail = `automatic rollback requires filesystem recovery after ${error.receipt.phase}`
          + (error.receipt.committed ? '; the complete rollback is installed on disk.' : '; the complete rollback was not installed.')
          + ' This boot is paused and no service handover was requested. ' + describeTransactionRecovery(error.receipt);
        this.updateLoopOffReason = detail;
        try { this.receiptStore().record(detail); } catch (receiptError) {
          logger.warn('DaemonServer: could not persist rollback recovery receipt', { error: summarizeError(receiptError) });
        }
        this.alertOwner(detail);
        this.announceOnStderr(detail);
        flushActivityLogSync();
        return true;
      }
      const preparation = error instanceof SuiteUpdatePreparationError ? error : undefined;
      const admission = preparation && (preparation.cause instanceof ServiceHandoverPreflightError
        || preparation.cause instanceof UpdateTransactionError && !preparation.cause.receipt.committed && !preparation.cause.receipt.recoveryRequired)
        ? preparation.cause : error;
      const compatibility = admission instanceof UpdateTransactionError ? admission.cause : admission;
      if (compatibility instanceof ServiceHandoverPreflightError) {
        this.reportRollbackPreflightRefusal(compatibility, preparation?.preservedPaths);
        return false;
      }
      if (compatibility instanceof RollbackMarkerUnwritableError) {
        const detail = `Automatic rollback refused: ${compatibility.message} The installed files were not changed; continuing the current build.`;
        try { this.receiptStore().record(detail); } catch { /* The synchronous owner notice still reports the refusal. */ }
        this.alertOwner(detail);
        this.announceOnStderr(detail);
        return false;
      }
      if (compatibility instanceof UpdateTransactionContendedError) {
        const detail = `goodvibes daemon: ${failedStarts} starts in a row did not finish, but ${compatibility.message} No automatic rollback was made this boot.`;
        logger.warn('DaemonServer: automatic rollback deferred, another update holds the installation', { failedStarts });
        this.announceOnStderr(detail);
        return false;
      }
      if (compatibility instanceof NativeDataCompatibilityError) {
        const detail = `Automatic rollback refused: ${compatibility.message} Continuing the current build without a rollback.`;
        try { this.receiptStore().record(detail); } catch { /* The synchronous owner notice still reports the refusal. */ }
        this.alertOwner(detail);
        this.announceOnStderr(detail);
        return false;
      }
      logger.error('DaemonServer: automatic rollback failed; continuing the boot on the current build', {
        failedStarts,
        error: summarizeError(error),
      });
      this.announceOnStderr(`goodvibes daemon: ${failedStarts} starts in a row did not finish, but no kept previous version is on disk as a complete verified native cohort; continuing this build without a rollback`);
      return false;
    }
    if (result.restored.length === 0) {
      logger.error('DaemonServer: repeated failed starts, but no kept previous version is on disk to roll back to; continuing the boot on the current build', {
        failedStarts,
        checked: targets.map((target) => target.path),
      });
      this.announceOnStderr(
        `goodvibes daemon: ${failedStarts} starts in a row did not finish, and no kept previous version is on disk to roll back to, starting this build again`,
      );
      return false;
    }

    // Set before any receipt/marker I/O: a failed record must never swap back
    // over the successful disk restoration on a duplicate start in this process.
    this.rollbackApplied = true;
    this.updateLoopOffReason = 'this process rolled back to the kept previous version and is handing over to it; updates resume in the restored daemon';
    const at = (this.options.now ?? Date.now)();
    try {
      this.receiptStore().record(crashLoopRollbackReceipt({ failedStarts, restored: result.restored, at }));
    } catch (error) {
      logger.warn('DaemonServer: could not persist completed disk rollback receipt', { error: summarizeError(error) });
    }
    const rejectedVersion = this.options.updateArtifact?.version;
    try {
      // The rejection itself was already written before the exchange; this
      // stamps when the rollback fired, so a second one is refused until a
      // fully-started boot re-arms it.
      recordDaemonAutoRollback(this.markerPath(), {
        ...this.markerOptions(),
        ...(rejectedVersion !== undefined ? { rejectedVersion } : {}),
      });
    } catch (error) {
      logger.warn('DaemonServer: could not stamp the automatic rollback in the lifecycle marker', {
        error: summarizeError(error),
      });
    }
    // A rollback is rare, consequential, and changes which version the machine
    // is running without anyone asking. It goes to the owner directly rather
    // than waiting for a surface to happen to poll for receipts, the receipt
    // for the rollback that stranded this machine overnight was still sitting
    // undelivered the next morning.
    this.alertOwner(
      `the daemon rolled itself back${rejectedVersion !== undefined ? ` from v${rejectedVersion}` : ''}`
      + ` after ${failedStarts} starts in a row did not finish.`
      + ` The previously installed version has been restored (${result.restored.map((target) => target.label).join(', ')})`
      + ` and automatic updates will skip that release until a newer one ships`,
    );
    logger.error('DaemonServer: rolled back to the kept previous version after repeated failed starts; handing over to it', {
      failedStarts,
      restored: result.restored.map((target) => target.path),
      skipped: result.skipped.map((target) => target.path),
    });
    this.announceOnStderr(
      `goodvibes daemon: ${failedStarts} starts in a row did not finish, rolled back to the kept previous version`
      + ` (${result.restored.map((target) => target.path).join(', ')}) and handing over to it`,
    );
    this.rollbackHandover = this.handOverAfterRollback(handover).catch((error: unknown) => {
      this.reportIncompleteHandover('rollback', { status: 'failed', detail: summarizeError(error) });
    });
    return true;
  }

  /**
   * Name the failing build as rejected BEFORE the files are exchanged. Written
   * after the exchange, a failed write would leave the restored build free to
   * download and install the very release that just crash looped. Written
   * here, a failure refuses the rollback while nothing has changed, and a
   * rollback that then fails leaves only a rejection of the build still
   * running, which its own next fully-started boot clears. The rollback's own
   * `autoRollbackAt` stays after the exchange: stamping it early would block a
   * later, legitimate rollback.
   */
  private stampRejectionBeforeExchange(): void {
    const version = this.options.updateArtifact?.version;
    if (version === undefined) return;
    try { this.rejectionStamp = { version, restore: recordDaemonRejection(this.markerPath(), { ...this.markerOptions(), rejectedVersion: version }) }; }
    catch (error) {
      throw new RollbackMarkerUnwritableError(`the lifecycle marker at ${this.markerPath()} could not record that v${normalizeVersion(version)} failed to start (${summarizeError(error)}).`
        + ' Without that record the restored build would reinstall this release.');
    }
  }

  /** The exchange did not happen: the build that is still running is not a rejected release. */
  private withdrawRejectionStamp(): void {
    const stamp = this.rejectionStamp;
    this.rejectionStamp = null;
    if (!stamp) return;
    try { withdrawDaemonRejection(this.markerPath(), { ...this.markerOptions(), rejectedVersion: stamp.version, restore: stamp.restore }); }
    catch (error) { logger.warn('DaemonServer: could not withdraw the rejection recorded for a rollback that did not happen', { error: summarizeError(error) }); }
  }

  /** Native manager admission is owned before any synchronous rollback effect. */
  private reserveRollbackHandover(execPath: string, failedStarts: number, prepared: PreparedServiceHandover): Promise<boolean> {
    const abort = new AbortController();
    this.rollbackAbort = abort;
    const work = Promise.resolve().then(async () => {
      try {
        await prepared.reserve(abort.signal);
        abort.signal.throwIfAborted(); prepared.assertCurrent();
        if (this.stopping) return false;
        const rolledBack = await this.rollBackToKeptPrevious(execPath, failedStarts, prepared);
        if (rolledBack && this.rollbackHandover) await this.rollbackHandover;
        if (rolledBack && !this.rollbackExitRequested && !abort.signal.aborted) {
          throw new Error('The manager-owned rollback handover did not complete.');
        }
        return rolledBack;
      } catch (error) {
        if (this.rollbackApplied || this.rollbackRecovery) {
          this.reportIncompleteHandover('rollback', { status: 'failed', detail: 'The manager-owned rollback handover did not complete; the restored files remain on disk.' });
          throw new Error('Native rollback handover did not complete.');
        }
        if (!abort.signal.aborted) this.reportRollbackPreflightRefusal(error);
        return false;
      } finally {
        if (!this.rollbackExitRequested || abort.signal.aborted) await prepared.cancel();
        if (this.rollbackAbort === abort) this.rollbackAbort = null;
      }
    });
    this.rollbackPreparation = work;
    return work;
  }

  /** The same handover the update swap uses: orderly stop first, then restart onto the restored binary. */
  private async handOverAfterRollback(prepared?: PreparedServiceHandover): Promise<void> {
    const inheritedAbort = prepared?.reservationRequired ? this.rollbackAbort : null;
    const abort = inheritedAbort ?? new AbortController();
    this.rollbackAbort = abort;
    try {
      prepared?.assertCurrent();
      // A manager-owned reservation reports through its own admission owner,
      // whose failure fails startup; only the unreserved handover exits here.
      const exitWhenIncomplete = () => { if (!inheritedAbort && !abort.signal.aborted) this.exitAfterIncompleteHandover('rollback'); };
      const ready = await prepareHandoverBeforeStop(prepared, abort.signal);
      if (!abort.signal.aborted && ready.status !== 'accepted') {
        // Nothing has stopped and this boot is abandoned: the restored files wait
        // on disk for the next start, and the process ends so it is not left idle.
        this.reportIncompleteHandover('rollback', ready);
        exitWhenIncomplete();
        return;
      }
      try {
        await this.options.stopGracefully?.();
      } catch (error) {
        drainOwned(error);
        this.reportIncompleteHandover('rollback', { status: 'failed', detail: 'owned runtime cleanup did not complete; no service handover was requested' });
        exitWhenIncomplete();
        return;
      }
      if (abort.signal.aborted) {
        this.reportIncompleteHandover('rollback', { status: 'unknown', detail: 'handover cancelled during orderly stop' });
        return;
      }
      const actions = this.buildServiceActions(abort.signal);
      const supervised = prepared?.supervised ?? actions.isSupervised();
      let outcome = await (prepared ? prepared.request(abort.signal) : supervised ? actions.restartService() : actions.adoptIntoService());
      if (abort.signal.aborted) outcome = { status: 'unknown', detail: 'handover cancelled' };
      if (outcome?.status !== 'accepted') {
        this.reportIncompleteHandover('rollback', outcome ?? { status: 'unknown', detail: 'no outcome returned' });
        exitWhenIncomplete();
        return;
      }
      if (supervised && !prepared?.exitRequired) return;
      flushActivityLogSync();
      this.rollbackExitRequested = true;
      try { (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0); }
      catch { this.rollbackExitRequested = false; throw new Error('The original process could not exit after rollback handover.'); }
    } finally {
      if (!inheritedAbort && this.rollbackAbort === abort) this.rollbackAbort = null;
    }
  }

  /**
   * After the server is accepting: stamp the lifecycle marker (a previous
   * marker still saying "running" means the last daemon died without an
   * orderly stop, one honest crash receipt; reaching here also clears the
   * failed-start streak and re-arms the automatic rollback), then start the
   * update loop unless its composing host still owns later startup phases.
   */
  onStarted(deferNativeActivation = false): void {
    if (this.rollbackRecovery) return;
    // A native committed handover owns its replacement; it never reuses the old boot admission.
    if (!this.appliedUpdater && !this.rollbackApplied) {
      try { this.assertArtifactCurrent?.(); }
      catch (error) { this.installationStartRefused = true; throw error; }
    }
    this.stopping = false;
    // Only the FIRST fully-started moment in a process can discover that the
    // process before it died: an in-process stop/start cycle is looking at the
    // marker THIS process wrote, which of course still says `running`. Without
    // this, every such cycle minted a "restarted after a crash" receipt for a
    // crash that never happened, and the receipt store filled with them,
    // burying the receipts that meant something.
    const firstStartInThisProcess = !this.reachedFullyStarted;
    if (firstStartInThisProcess) sweepStaleWebSocketOutboxes();
    // Set before anything that can throw: this process HAS come up, and the
    // crash-loop guard must not accuse it for the rest of its life.
    this.reachedFullyStarted = true;
    try {
      const startResult = recordDaemonStart(this.markerPath(), {
        ...this.markerOptions(),
        ...(this.options.updateArtifact ? { version: this.options.updateArtifact.version } : {}),
      });
      if (startResult.foreignOwner && firstStartInThisProcess) {
        logger.warn('DaemonServer: another running daemon owns the lifecycle marker for this home; this daemon does not record crash or shutdown state', {
          ownerPid: startResult.foreignOwner.pid,
        });
      } else if (startResult.crashed && firstStartInThisProcess) {
        this.receiptStore().record(`restarted after a crash at ${formatReceiptTime((this.options.now ?? Date.now)())}`);
      } else if (startResult.previousStopHadCleanupErrors && firstStartInThisProcess) {
        this.receiptStore().record(`restarted after the previous daemon stopped with cleanup errors (it shut down in order, not by a crash) at ${formatReceiptTime((this.options.now ?? Date.now)())}`);
      }
    } catch (error) {
      logger.warn('DaemonServer: could not record the lifecycle marker', { error: summarizeError(error) });
    }
    // Announce-once lines due at daemon start (e.g. the web surface URL):
    // recorded here for EVERY daemon construction path (CLI, boot factory,
    // embedded). Each fired line is logged AND queued for surface delivery
    // through the consuming /status receipts read.
    try {
      for (const announcement of collectStartupAnnouncements({
        configManager: this.options.configManager,
        store: this.announcementStore(),
      })) {
        logger.info(announcement.text, { announcement: announcement.id });
      }
    } catch (error) {
      logger.warn('DaemonServer: startup announcements could not be collected', { error: summarizeError(error) });
    }
    if (!deferNativeActivation) this.activateNativeLifecycle();
  }

  /** Native activation waits for the composing host's complete boot, not merely
   * its first listener. An admitted promotion owns one retained handover drain. */
  activateNativeLifecycle(): void | NativeHandover {
    if (this.promotionHandover) return this.promotionHandover;
    if (!this.reachedFullyStarted || this.stopping || this.rollbackRecovery || this.rollbackApplied || this.appliedUpdater) return;
    this.startAutoUpdater();
    this.promoteToServiceAtBoot();
    return this.promotionHandover;
  }

  /** Fence handovers before the facade awaits any shutdown hooks. Never self-drains. */
  beginStopping(forHandover = false): void {
    this.stopping = true;
    if (!forHandover) { this.promotionAbort?.abort(); this.rollbackAbort?.abort(); }
    this.autoUpdater?.stop(forHandover);
    this.appliedUpdater?.stop(forHandover);
  }

  /** A repeated facade close still owns the existing handover; own stops never self-wait. */
  drainHandovers(forHandover = false): Promise<void> {
    return Promise.all([
      forHandover ? null : this.promotionTask,
      forHandover ? null : this.rollbackHandover,
      forHandover ? null : this.rollbackPreparation,
      (this.autoUpdater ?? this.appliedUpdater)?.drainHandover(forHandover),
    ]).then(() => {});
  }

  /**
   * During stop(): halt the update loop; on a real shutdown stamp the
   * clean-shutdown marker so the next start does not record a crash receipt.
   * `restarting` is true only for an embedder's own in-process stop/start
   * cycle; the facade always stops for real. Incomplete cleanup still fences
   * and drains the lifecycle and is recorded as a stop with cleanup errors.
   */
  onStopping(restarting: boolean, forHandover = false, completed = true): Promise<void> {
    this.beginStopping(forHandover);
    const updater = this.autoUpdater;
    if (updater && (updater.snapshot().appliedVersion != null || updater.snapshot().recoveryRequired === true)) this.appliedUpdater = updater;
    // Retain the old loop while a transaction settles. It can still acquire
    // a completed-disk or recovery latch, and a new loop must not race it.
    const drained = this.drainHandovers(forHandover).then(() => {
      if (updater && (updater.snapshot().appliedVersion != null || updater.snapshot().recoveryRequired === true)) this.appliedUpdater = updater;
      if (this.autoUpdater === updater) this.autoUpdater = null;
      // A promotion that did not end in an exit leaves nothing for a later
      // in-process start to inherit: its settled handover would otherwise be
      // handed to the next start as if that start were being handed over.
      if (!forHandover && !this.promotionTask && this.promotionHandover && !this.promotionExited) {
        this.promotionHandover = undefined;
        this.promotionAttempted = false;
      }
      // A stopped loop is not "on with no reason": status read after a stop
      // must say why nothing is checking.
      if (!this.autoUpdater && !this.appliedUpdater && !this.rollbackRecovery && !this.rollbackApplied) {
        this.updateLoopOffReason = 'the daemon is stopped or stopping';
      }
    });
    if (this.promotionTimer) {
      clearInterval(this.promotionTimer);
      this.promotionTimer = null;
    }
    return drained.then(() => {
      // Publish clean state only after every admitted handover really drained.
      // A refusal or rollback learned during that wait must preserve its evidence.
      if (!this.reachedFullyStarted || restarting || this.rollbackRecovery || this.installationStartRefused) return;
      try {
        // An orderly stop with a failed cleanup is recorded as such: leaving
        // `running` would make the next boot report a crash that never happened.
        recordDaemonCleanShutdown(this.markerPath(), {
          ...this.markerOptions(),
          ...(completed ? {} : { cleanupErrors: true }),
          ...(this.options.updateArtifact ? { version: this.options.updateArtifact.version } : {}),
        });
      } catch (error) {
        logger.warn('DaemonServer: could not record the clean-shutdown marker', { error: summarizeError(error) });
      }
    });
  }

  /**
   * The self-update loop: a first check shortly after boot, then the
   * configured cadence. The swap only happens at a no-active-work moment: the
   * busy probe is the session broker's real pending-input count.
   *
   * EVERY gate that leaves the loop off logs why. A daemon that quietly never
   * updates is indistinguishable from one that has nothing to update to, and
   * the log is the only place an owner can tell those apart.
   */
  private startAutoUpdater(): void {
    if (this.autoUpdater) return;
    // A completed update or unresolved filesystem transaction is terminal in
    // this process, including after an in-process start/stop cycle.
    if (this.appliedUpdater || this.rollbackRecovery) return;
    const { configManager } = this.options;
    const auto = configManager.get('update.auto');
    if (auto !== true) {
      this.updateLoopOffReason = 'update.auto is not true, so this daemon will not update itself';
      logger.info('DaemonServer: auto-update loop off, update.auto is not true; this daemon will not update itself', {
        'update.auto': auto,
      });
      return;
    }
    const artifact = this.options.updateArtifact;
    if (!artifact) {
      // No artifact identity was provided (the embedded default): the host
      // manages its own updates. Never fall back to the platform package version,
      // comparing it against the host's release tags would be meaningless and
      // the swap would replace the wrong executable. Logged so an operator
      // who set update.auto sees why no loop is running.
      this.updateLoopOffReason = 'this host manages its own updates: no artifact identity was provided, and the platform package version is never assumed to be the shipped one';
      logger.info('DaemonServer: auto-update loop off, no update artifact identity provided (host-managed updates)');
      return;
    }
    const releasesUrl = String(configManager.get('update.releasesUrl') ?? '').trim();
    if (!releasesUrl) {
      this.updateLoopOffReason = 'update.releasesUrl is empty, so there is nowhere to resolve release tags from';
      logger.info('DaemonServer: auto-update loop off, update.releasesUrl is empty, so there is nowhere to resolve release tags from');
      return;
    }
    const intervalMinutes = Number(configManager.get('update.intervalMinutes') ?? 60);
    const firstCheckSeconds = Number(configManager.get('update.firstCheckSeconds') ?? 30);
    const alertAfter = Number(configManager.get('update.alertAfterFailedChecks') ?? 3);
    const updater = new DaemonAutoUpdater({
      currentVersion: artifact.version,
      ...(artifact.suite ? { suite: { configManager } } : {}),
      ...(this.currentReader ? { currentReader: this.currentReader } : {}),
      execPath: artifact.execPath ?? process.execPath,
      platform: process.platform,
      arch: process.arch,
      releasesLatestUrl: releasesUrl,
      checkIntervalMs: Math.max(5, intervalMinutes) * 60 * 1000,
      firstCheckDelayMs: Math.max(0, Number.isFinite(firstCheckSeconds) ? firstCheckSeconds : 30) * 1000,
      isIdle: this.options.isIdle,
      receipts: this.receiptStore(),
      serviceActions: this.buildServiceActions(),
      // Read from disk on every check, not captured once: the rejection this
      // has to honor was written by the boot BEFORE the one running now.
      rejectedVersion: () => this.rejectedUpdateVersion(),
      alertOwner: (text) => this.alertOwner(text),
      ...(Number.isFinite(alertAfter) ? { alertAfterFailedChecks: alertAfter } : {}),
      ...(this.options.stopGracefully ? { stopGracefully: this.options.stopGracefully } : {}),
      ...(this.options.exitProcess ? { exitProcess: this.options.exitProcess } : {}),
      ...(this.options.stderr ? { stderr: this.options.stderr } : {}),
      ...(this.options.onIncompleteHandover ? { onIncompleteHandover: this.options.onIncompleteHandover } : {}),
    });
    this.autoUpdater = updater;
    this.updateLoopOffReason = '';
    updater.start();
    // The positive case is logged too: "no update happened" should be
    // readable as either "the loop never ran" or "the loop ran and found
    // nothing", never a guess between them.
    logger.info('DaemonServer: auto-update loop armed', {
      currentVersion: artifact.version,
      releasesUrl,
      firstCheckInMs: updater.firstCheckDelayMs,
      thenEveryMs: updater.checkIntervalMs,
    });
  }

  /**
   * The version an automatic rollback rejected and no successful boot has
   * cleared, or null. Read from the marker on disk each time it is asked for,
   * because the rollback that recorded it happened in a PREVIOUS process.
   */
  private rejectedUpdateVersion(): string | null {
    const marker = readLifecycleMarker(this.markerPath(), this.options.markerIo);
    return marker?.rejectedVersion ?? null;
  }

  /**
   * What this daemon can say about updating itself, from the state the loop
   * already keeps.
   *
   * EVERY gate that leaves the loop off is named here, not just logged. "The
   * daemon has not updated" reads identically whether there is nothing to
   * update to, the loop was never armed, or every check has been failing for a
   * week, and the difference between those is the whole question.
   */
  updateStatus(): DaemonUpdateStatus {
    const updater = this.autoUpdater ?? this.appliedUpdater;
    const rejectedVersion = this.rejectedUpdateVersion();
    if (!updater) {
      return {
        armed: false,
        offReason: this.updateLoopOffReason,
        currentVersion: this.options.updateArtifact?.version ?? null,
        releasesUrl: String(this.options.configManager.get('update.releasesUrl') ?? '').trim(),
        checkIntervalMs: null,
        firstCheckDelayMs: null,
        failedCheckCount: this.rollbackRecovery ? 1 : 0,
        lastCheckFailure: this.rollbackRecovery ? this.updateLoopOffReason : null,
        pendingVersion: null,
        rejectedVersion,
        ...(this.rollbackRecovery ? { recoveryRequired: true, transactionRecovery: {
          ...this.rollbackRecovery,
          targets: [...this.rollbackRecovery.targets],
          recoveryPaths: [...this.rollbackRecovery.recoveryPaths],
          recoveryErrors: [...this.rollbackRecovery.recoveryErrors],
        } } : {}),
      };
    }
    const snapshot = updater.snapshot();
    return {
      armed: snapshot.appliedVersion == null && snapshot.recoveryRequired !== true,
      offReason: snapshot.recoveryRequired
        ? (snapshot.lastCheckFailure ?? 'automatic updates are paused pending filesystem recovery; inspect retained transaction files before retrying')
        : snapshot.appliedVersion == null ? '' : `v${snapshot.appliedVersion} is installed on disk; service handover ${snapshot.handover?.status ?? 'pending'}; replacement health is unknown`,
      currentVersion: snapshot.currentVersion,
      releasesUrl: snapshot.releasesUrl,
      checkIntervalMs: snapshot.checkIntervalMs,
      firstCheckDelayMs: snapshot.firstCheckDelayMs,
      failedCheckCount: snapshot.failedCheckCount,
      lastCheckFailure: snapshot.lastCheckFailure,
      pendingVersion: snapshot.pendingVersion,
      rejectedVersion,
      ...(snapshot.recoveryRequired ? { recoveryRequired: true, transactionRecovery: snapshot.transactionRecovery ?? null } : {}),
    };
  }

  /**
   * Run one check now rather than waiting for the next interval, and report
   * what the loop knows afterwards.
   *
   * The same tick the schedule runs, not a second code path, so what an
   * on-demand check does and what the hourly one does cannot diverge. A check
   * that throws is recorded by the loop exactly as a scheduled failure is, and
   * the returned status carries it; this never rejects, because "the check
   * failed" is an answer and the caller asked for the state.
   */
  async checkForUpdatesNow(): Promise<DaemonUpdateCheckStatus> {
    const outcome = this.autoUpdater ? await this.autoUpdater.tick() : 'stopped';
    return { ...this.updateStatus(), check: outcome === 'stopped' ? 'loop-off' : outcome };
  }

  private hasTransactionRecovery(): boolean {
    return this.rollbackRecovery !== null || (this.autoUpdater ?? this.appliedUpdater)?.snapshot().recoveryRequired === true;
  }

  /** The service-manager actions shared by the update swap and boot promotion. */
  private buildServiceActions(signal?: AbortSignal, assertCurrent?: () => void): AutoUpdateServiceActions {
    const requestedName = String(this.options.configManager.get('service.serviceName') ?? 'goodvibes').trim() || 'goodvibes';
    let serviceName = requestedName;
    let selectedService: { name: string; path: string; pid: number | undefined; contents: string | undefined } | undefined;
    const platform = this.options.servicePlatform ?? process.platform;
    const configuredTimeout = this.options.serviceCommandTimeoutMs ?? 10_000;
    const timeoutMs = Number.isFinite(configuredTimeout) ? Math.max(1, Math.min(60_000, configuredTimeout)) : 10_000;
    const command = async (argv: readonly string[], actionSignal?: AbortSignal): Promise<ServiceHandoverOutcome> => {
      assertCurrent?.();
      const outcome: ServiceHandoverOutcome = this.hasTransactionRecovery()
        ? { status: 'unknown', detail: 'filesystem transaction recovery is required; service action is fenced' }
        : await observeServiceCommand(this.options.serviceCommandRunner ?? runServiceCommand, argv, timeoutMs, actionSignal);
      assertCurrent?.();
      return outcome;
    };
    // Adoption is prepared once: the unit is installed, the user manager probed
    // and reloaded before the runtime stops, so `enable` is the only step after the stop.
    let adoptionPrepared = false;
    const prepareAdoption = async (actionSignal: AbortSignal | undefined): Promise<ServiceHandoverOutcome> => {
      if (adoptionPrepared) return { status: 'accepted' };
      // No supported enqueue path means no unit should be installed either.
      if (platform !== 'linux') return { status: 'unsupported', detail: 'service adoption is only supported on systemd' };
      if (actionSignal?.aborted || this.hasTransactionRecovery()) return { status: 'unknown', detail: 'handover cancelled or filesystem recovery required' };
      try {
        assertCurrent?.();
        const status = this.options.platformServiceManager.status();
        assertCurrent?.();
        if (status.platform && status.platform !== 'systemd') return { status: 'unsupported', detail: `service adoption is unsupported for ${status.platform}` };
      } catch (error) {
        return { status: 'failed', detail: `service unit install failed: ${summarizeError(error)}` };
      }
      try {
        const installed = this.options.platformServiceManager.install();
        assertCurrent?.();
        if (installed.installed === false) return { status: 'failed', detail: 'service unit installation was not confirmed' };
        if (installed.actionError) return { status: 'failed', detail: installed.actionError };
        if (installed.lingerNote) logger.info(`DaemonServer: ${installed.lingerNote}`);
      } catch (error) {
        return { status: 'failed', detail: `service unit install failed: ${summarizeError(error)}` };
      }
      // A command that answers proves the user manager is reachable, while the runtime still serves.
      const probe = await command(['systemctl', '--user', 'show-environment'], actionSignal);
      if (probe.status !== 'accepted') return { status: probe.status, detail: `the systemd user manager did not answer${probe.detail ? ` (${probe.detail})` : ''}` };
      if (actionSignal?.aborted || this.hasTransactionRecovery()) return { status: 'unknown', detail: 'handover cancelled or filesystem recovery required' };
      const reload = await command(['systemctl', '--user', 'daemon-reload'], actionSignal);
      if (reload.status !== 'accepted') return reload;
      adoptionPrepared = true;
      return { status: 'accepted' };
    };
    return {
      preflight: supervised => {
        if (platform !== 'linux' && platform !== 'darwin') return { supported: false,
          detail: 'Unattended service handover is unavailable on this platform.' };
        try {
          assertCurrent?.();
          const status = this.options.platformServiceManager.status();
          assertCurrent?.();
          if (status.platform !== (platform === 'darwin' ? 'launchd' : 'systemd')) return { supported: false,
            detail: platform === 'darwin' ? 'Unattended service handover requires the launchd service manager.' : 'Unattended service handover requires the systemd service manager.' };
          if (status.actionError) return { supported: false,
            detail: 'The selected service is unavailable for unattended handover.' };
          const name = status.serviceName?.trim() || requestedName;
          if (selectedService && (name !== selectedService.name || status.path !== selectedService.path
            || platform === 'darwin' && (status.pid !== selectedService.pid || status.contents !== selectedService.contents))) return { supported: false,
            detail: 'The selected service identity or definition changed before unattended handover.' };
          if (supervised !== (status.installed && status.running)) return { supported: false,
            detail: 'The selected service identity or supervision changed before unattended handover.' };
          if (platform === 'darwin' && (!supervised || status.pid !== process.pid || !status.serviceName?.trim()
            || !status.path || typeof status.contents !== 'string' || typeof process.getuid !== 'function')) return { supported: false,
            detail: 'Unattended launchd handover requires this process to own its selected loaded service.' };
          selectedService ??= { name, path: status.path, pid: status.pid, contents: status.contents };
          serviceName = selectedService.name;
          return { supported: true };
        } catch { return { supported: false, detail: 'The selected service manager could not be confirmed for unattended handover.' }; }
      },
      ...(platform === 'darwin' ? { reserve: async (supervised: boolean, actionSignal: AbortSignal) => {
        if (!supervised || !selectedService || selectedService.pid !== process.pid) throw new ServiceHandoverPreflightError('The selected launchd service does not belong to this process.');
        const selected = selectedService;
        const source = readFileObservation(selected.path);
        const executablePath = this.options.updateArtifact?.execPath ?? process.execPath;
        const assertServiceCurrent = () => {
          // status().contents is redacted, so the raw file is compared with the raw file.
          actionSignal.throwIfAborted();
          if (this.hasTransactionRecovery()) throw new ServiceHandoverPreflightError('Filesystem recovery prevents service handover.');
          const status = this.options.platformServiceManager.status();
          if (status.platform !== 'launchd' || !status.installed || !status.running || status.pid !== process.pid
            || status.serviceName !== selected.name || status.path !== selected.path || status.contents !== selected.contents
            || fileObservationIdentity(selected.path) !== source.physical || !source.bytes.equals(readFileObservation(selected.path).bytes)) {
            throw new ServiceHandoverPreflightError('The original loaded launchd service changed during handover.');
          }
        };
        assertServiceCurrent();
        return await (this.options.reserveLaunchdHandover ?? reserveLaunchdHandover)({
          serviceName: selected.name, servicePath: selected.path, executablePath,
          uid: process.getuid!(), pid: process.pid, timeoutMs, assertServiceCurrent,
        }, actionSignal);
      } } : {}),
      isSupervised: () => {
        try {
          const status = this.options.platformServiceManager.status();
          return status.installed && status.running;
        } catch {
          return false;
        }
      },
      prepareAdoption: async (actionSignal = signal) => prepareAdoption(actionSignal),
      adoptIntoService: async (actionSignal = signal) => {
        const prepared = await prepareAdoption(actionSignal);
        if (prepared.status !== 'accepted') return prepared;
        if (actionSignal?.aborted || this.hasTransactionRecovery()) return { status: 'unknown', detail: 'handover cancelled or filesystem recovery required' };
        // --no-block observes enqueue acceptance without waiting on the replacement
        // to bind the listener still owned by this process.
        return command(['systemctl', '--user', '--no-block', 'enable', '--now', `${serviceName}.service`], actionSignal);
      },
      restartService: async (actionSignal = signal) => {
        if (actionSignal?.aborted || this.hasTransactionRecovery()) return { status: 'unknown', detail: 'handover cancelled or filesystem recovery required' };
        if (platform === 'linux') {
          try {
            const manager = this.options.platformServiceManager.status().platform;
            if (manager && manager !== 'systemd') return { status: 'unsupported', detail: `service restart is unsupported for ${manager}` };
          } catch (error) {
            return { status: 'unknown', detail: `could not verify systemd supervision: ${summarizeError(error)}` };
          }
          return command(['systemctl', '--user', '--no-block', 'restart', `${serviceName}.service`], actionSignal);
        }
        if (platform !== 'darwin') return { status: 'unsupported', detail: 'no supported service restart handover' };
        try {
          if (this.options.platformServiceManager.status().platform !== 'launchd') {
            return { status: 'unsupported', detail: 'restart-by-exit requires launchd supervision' };
          }
        } catch (error) {
          return { status: 'unknown', detail: `could not verify launchd supervision: ${summarizeError(error)}` };
        }
        // Being listed by launchd does not acknowledge a replacement job.
        // Desired restartOnFailure and the plist on disk do not establish the
        // policy loaded by launchd; KeepAlive may be disabled or stale. Until
        // an observed launchd handover exists, never turn that inference into
        // a successful exit (even when both desired and on-disk values are true).
        return { status: 'unknown', detail: 'launchd restart-by-exit has no observed manager acknowledgement; loaded KeepAlive policy is unverified' };
      },
    };
  }

  /**
   * Boot-edge service promotion, independent of updates: a STANDALONE
   * unsupervised daemon (spawned detached by a surface) installs its service
   * unit and hands over to the supervised instance at its first idle moment
   *, a freshly-spawned daemon at the latest version no longer stays
   * unref()'d forever waiting for an update swap to promote it. Embedded
   * daemons (no updateArtifact identity) never self-promote: exiting would
   * kill the host process. service.enabled=false opts out; a platform
   * without a service manager is left alone.
   */
  private promoteToServiceAtBoot(): void {
    if (this.hasTransactionRecovery() || this.appliedUpdater || this.rollbackApplied) return;
    if (!this.options.updateArtifact) return;
    // Adoption currently has an acknowledged enqueue path only on systemd.
    // Check before creating a handover or stopping the live runtime: discovering
    // an unsupported platform after cleanup leaves a running process offline.
    if ((this.options.servicePlatform ?? process.platform) !== 'linux') return;
    // A daemon running out of an overridden home is a throwaway by definition,
    // and a throwaway must not become the machine's daemon. See
    // `hasOverriddenHome`, this exact promotion put a scratchpad daemon in
    // charge of the owner's machine and their real Telegram bot.
    //
    // Checked BEFORE `service.enabled`, deliberately: that key is client-owned
    // and therefore read from the REAL home, so a test tree's own opt-out was
    // written and never read. Isolation that depends on the isolated process
    // reading its own settings file is not isolation.
    if (this.options.hasOverriddenHome === true) {
      logger.info('DaemonServer: home was overridden, skipping boot promotion', {
        detail: 'a daemon running from a non-default home never adopts the machine service unit',
      });
      return;
    }
    if (this.options.configManager.get('service.enabled') === false) return;
    // Only a compiled binary may self-promote: a source/dev run would install a
    // unit whose ExecStart reconstructs a dev command line for a binary and fail
    // on the next boot. A dev checkout stays session-only.
    const isCompiled = this.options.isCompiledBinary ?? (() => isCompiledBinaryInvocation(currentProcessSignals()));
    if (!isCompiled()) {
      logger.info('DaemonServer: source/dev run, skipping boot promotion (only a compiled binary self-promotes)');
      return;
    }
    let status: { installed: boolean; running: boolean };
    try {
      status = this.options.platformServiceManager.status();
    } catch {
      return; // no service manager on this platform, nothing to promote into
    }
    if (status.installed && status.running) return; // already supervised
    if (this.promotionAttempted || this.promotionTask || this.promotionTimer || this.stopping) return;
    let prepared: PreparedServiceHandover | undefined;
    try { prepared = prepareServiceHandover(this.buildServiceActions(undefined, this.assertArtifactCurrent)); }
    catch {
      logger.warn('DaemonServer: boot promotion requires a confirmed systemd handover; the current runtime was left running');
      return;
    }
    const attempt = (): void => {
      if (this.stopping || this.hasTransactionRecovery() || this.promotionAttempted || !this.options.isIdle()) return;
      this.promotionAttempted = true;
      if (this.promotionTimer) clearInterval(this.promotionTimer);
      this.promotionTimer = null;
      const abort = new AbortController();
      this.promotionAbort = abort;
      // Record task ownership before its synchronous stop hook can reenter.
      let runtimeStopped = false, exitRequested = false, refusedBeforeStop = false;
      this.promotionTask = Promise.resolve().then(async () => {
        try {
          if (abort.signal.aborted) return;
          this.assertArtifactCurrent?.();
          prepared?.assertCurrent();
          // The unit install and manager reload happen while the runtime still
          // serves; a refusal here leaves a working daemon, not a stopped one.
          const ready = await prepareHandoverBeforeStop(prepared, abort.signal);
          if (abort.signal.aborted) return;
          if (ready.status !== 'accepted') {
            refusedBeforeStop = true;
            this.reportIncompleteHandover('boot promotion', ready);
            return;
          }
          runtimeStopped = true;
          try { await this.options.stopGracefully?.(); }
          catch (error) {
            drainOwned(error);
            this.reportIncompleteHandover('boot promotion', { status: 'failed', detail: 'owned runtime cleanup did not complete; no service handover was requested' });
            return;
          }
          if (abort.signal.aborted || this.hasTransactionRecovery()) {
            this.reportIncompleteHandover('boot promotion', { status: 'unknown', detail: 'handover cancelled during orderly stop or filesystem recovery is required' });
            return;
          }
          this.assertArtifactCurrent?.();
          const outcome = await prepared?.request(abort.signal);
          this.assertArtifactCurrent?.();
          if (abort.signal.aborted || this.hasTransactionRecovery()) return;
          if (outcome?.status !== 'accepted') {
            this.reportIncompleteHandover('boot promotion', outcome ?? { status: 'unknown', detail: 'no outcome returned' });
            return;
          }
          logger.info('DaemonServer: service start enqueue accepted; handing over (replacement health not yet known)');
          flushActivityLogSync();
          exitRequested = true;
          this.promotionExited = true;
          (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0);
        } catch (error) {
          exitRequested = false;
          this.promotionExited = false;
          if (!abort.signal.aborted) this.reportIncompleteHandover('boot promotion', { status: 'failed', detail: summarizeError(error) });
        } finally {
          if (runtimeStopped && !exitRequested && !abort.signal.aborted) this.exitAfterIncompleteHandover('boot promotion');
        }
      }).finally(() => { this.promotionTask = null; this.promotionAbort = null; });
      this.promotionHandover = Object.freeze({ state: 'handover' as const, drain: this.promotionTask, cancel: () => this.beginStopping(false), resumed: () => refusedBeforeStop });
      void this.promotionTask.catch(() => {});
    };
    attempt();
    if (this.promotionAttempted) return;
    const retryMs = Math.max(1_000, this.options.promotionRetryMs ?? 60_000);
    this.promotionTimer = setInterval(attempt, retryMs);
    (this.promotionTimer as { unref?: () => void }).unref?.();
  }

  private reportIncompleteHandover(context: string, outcome: ServiceHandoverOutcome): void {
    const disk = context === 'rollback' ? ' The kept previous files were restored on disk; no further rollback was attempted.' : '';
    const text = `${context} handover incomplete (${outcome.status}): ${outcome.detail ?? 'no completion evidence'}.${disk} Replacement health is unknown; this process did not exit for a successful handover.`;
    try { this.receiptStore().record(text); } catch (error) {
      logger.warn('DaemonServer: could not record incomplete handover receipt', { error: summarizeError(error) });
    }
    this.alertOwner(text);
    this.announceOnStderr(text);
  }

  /**
   * The runtime was already stopped for a handover that did not complete. A
   * process left alive here holds no listener and no supervisor will restart
   * it, so the host that owns the process ends it with a failure status and
   * the service manager (when there is one) starts whatever is installed.
   */
  private exitAfterIncompleteHandover(context: string): void {
    const end = this.options.onIncompleteHandover;
    if (!end) return;
    this.announceOnStderr(`goodvibes daemon: the ${context} handover did not complete after the runtime had stopped;`
      + ' ending this process with status 1 so the service manager can start the installed build');
    flushActivityLogSync();
    try { end(); }
    catch (error) { logger.error('DaemonServer: the process could not be ended after an incomplete handover', { error: summarizeError(error) }); }
  }

  /**
   * Refuse a crash-loop rollback whose kept previous copy is not an older,
   * unrejected build. The exchange keeps the failing build as the previous
   * copy, so a later crash loop of the restored build would otherwise roll
   * "back" onto the release that was rejected, and mark the restored one
   * rejected instead.
   */
  private assertRollbackTarget(previousVersion: string, currentVersion: string): void {
    const previous = normalizeVersion(previousVersion), current = normalizeVersion(currentVersion);
    const rejected = this.rejectedUpdateVersion();
    let reason: string | null = null;
    if (rejected !== null && normalizeVersion(rejected) === previous) {
      reason = 'which is the release an earlier automatic rollback rejected after it failed to start';
    } else {
      let order: number | null = null;
      try { order = compareVersions(previous, current); } catch { /* Unparseable versions keep the existing cohort checks. */ }
      if (order !== null && order >= 0) reason = `which is not older than the running v${current}`;
    }
    if (reason === null) return;
    throw new RollbackTargetRefusedError(`Automatic rollback refused: the kept previous copy is v${previous}, ${reason},`
      + ` so restoring it would not return to a known-good build. Continuing v${current} without a rollback;`
      + ' if it keeps failing to start, install a known-good release by hand.');
  }

  private reportRollbackPreflightRefusal(error: unknown, preservedPaths: readonly string[] = []): void {
    const detail = error instanceof ServiceHandoverPreflightError ? error.message : 'Service handover support could not be confirmed.';
    const text = `Automatic rollback refused before publication: ${detail}`
      + ' The installed files and current runtime were left unchanged. Inspect the service manager and restore or restart the daemon manually.'
      + (preservedPaths.length ? ` Discarded staging was preserved at: ${preservedPaths.join(', ')}` : '');
    if (this.lastRollbackPreflightRefusal === text) return;
    this.lastRollbackPreflightRefusal = text;
    try { this.receiptStore().record(text); } catch { /* The owner notice remains available. */ }
    this.alertOwner(text); this.announceOnStderr(text);
  }
}
