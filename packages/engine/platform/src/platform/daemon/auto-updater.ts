/**
 * DaemonAutoUpdater, the daemon's self-update loop.
 *
 * Owner-directed behavior: the daemon looks for updates shortly after it
 * starts and hourly after that, updates when one is found, and auto-restarts.
 * It shares the platform's ONE update mechanism: runtime/self-update.ts for
 * the download/verify/swap and runtime/update-schedule.ts for the cadence
 * (boot-settle first check, hourly steady state, short retry while busy).
 *
 * Safety boundary: the daemon's activity probe is checked before downloads
 * and synchronously after staging, immediately before the first live rename.
 * A busy daemon retains the release descriptor for a short retry; downloaded
 * bytes are discarded. No clock ends a lookup or download: it ends when it
 * finishes, when the release server or the connection fails, or when the
 * updater is stopped. This final snapshot is not a work-admission lease: the host must
 * still fence new work through handover before automatic activation is safe.
 *
 * Restart: the swap is followed by the daemon's OWN orderly stop, the same
 * stop path a SIGTERM takes, so every shutdown hook fires on an update restart
 * instead of being skipped by a bare exit. Only then does the process hand
 * over: when the daemon runs under the service manager, a non-blocking service
 * restart; when it runs unsupervised, the service manager first ADOPTS it,
 * installs the unit and enqueues a service start. Only an acknowledged
 * restart or adoption request lets the old process exit, and it then exits at
 * once with status 0 rather than waiting to be stopped. An incomplete handover leaves
 * the disk update and previous binary intact, reports what happened, and
 * pauses this process's updater so it cannot install the same release twice.
 * When the orderly stop had already run, a host that owns the process
 * (onIncompleteHandover) ends it with a failure status: the stopped runtime
 * serves nothing, and a supervisor only restarts a process that has exited.
 *
 * Every applied update leaves a receipt ("updated from X to Y at HH:MM") in
 * the daemon log and in the receipt store surfaced on next surface connect.
 *
 * Two things this loop refuses to do quietly, both learned the hard way:
 *
 *   - It never re-installs a release that already crash looped here. A boot
 *     rollback records the version it rejected; the loop reads that record on
 *     every check and holds. Without it the loop and the rollback form a cycle
 *    , install, fail three starts, roll back, reinstall the same release an
 *     interval later, and the installed daemon oscillates instead of moving
 *     forward. It resumes on its own as soon as a NEWER tag ships.
 *   - It never fails silently. Persistent failures are read from the actual
 *     error and the owner is told over a channel that
 *     works (the same owner-alert path a failing channel uses), with a quiet
 *     window so a persistent failure is one message rather than one an hour.
 *     Recovery is stated too. A WARN line in a debug file is not telling
 *     anybody: that is precisely how an installed daemon sat three releases
 *     behind for three days.
 *
 * Time, network, filesystem, activity, service actions, and process exit are
 * all injectable; the whole loop is provable under test.
 */
import { readFailureTransience } from '@goodvibes/engine/errors';
import { daemonReadingPort } from './reading-lifetime.js';
import { captureJudgmentFailure } from '../gate/failure-input.js';
import { flushActivityLogSync, logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import {
  applyVerifiedUpdate,
  compareVersions,
  captureUpdateFileIo,
  realUpdateFileIo,
  UpdateTransactionError,
  UpdateTransactionContendedError,
  describeTransactionRecovery,
  normalizeVersion,
  resolveLatestReleaseTag,
  retainDaemonNativeFiles,
  type UpdateFetchLike,
  type UpdateFileIo,
  type UpdateTarget,
  type UpdateTransactionReceipt,
  type DaemonCurrentReader,
} from '../runtime/self-update.js';
import { parseNativeReaderCapabilities } from '../runtime/native-reader-compatibility.js';
import { PeriodicUpdateLoop, type PeriodicCheckOutcome } from '../runtime/update-schedule.js';
import { formatReceiptTime, type DaemonReceiptStore } from './receipts.js';
import { clientCompatibilityFloorFor } from '../control-plane/build-compatibility.js';
import type { ServiceHandoverOutcome } from './service-handover.js';
import type { DaemonUpdateInstallProgress } from './update-status.js';
import { inspectDaemonUpdateInstallation, resolveDaemonUpdateTargets } from '../runtime/daemon-update-installation.js';
import { assertStagedClientReaderCompatible } from '../runtime/client-reader-update.js';
import { observesUpdateFiles } from '../runtime/update-file-io.js';
import { assertSynchronousJudgmentGuard, drainOwned } from '@goodvibes/judgment/decisions';
import { applySuiteUpdate, installedSuiteNeedsRepair, retainSuiteUpdateConfiguration, SuiteUpdatePreparationError, SuiteUpdateRecoveryError, type SuiteUpdateResult } from '../runtime/suite-update.js';
import { prepareHandoverBeforeStop, prepareServiceHandover, ServiceHandoverPreflightError, type PreparedServiceHandover } from './service-handover-preflight.js';
import type { DaemonWorkAdmission } from './work-admission.js';
import { writeFatalLine } from './fatal-boot-report.js';

export interface AutoUpdateServiceActions {
  /** Side-effect-free capability check; production checks before publication and cleanup.
   * Optional for existing embedders. Support does not acknowledge a manager request. */
  preflight?(supervised: boolean): import('./service-handover-preflight.js').ServiceHandoverSupport;
  /** Reserve an independent manager-owned helper before any installed-file publication. */
  reserve?(supervised: boolean, signal: AbortSignal): Promise<import('./service-handover-preflight.js').ServiceHandoverReservation>;
  /** Whether the daemon currently runs under the platform service manager. */
  isSupervised(): boolean;
  /**
   * Everything adoption needs that can fail without harming a running daemon:
   * confirm the user manager answers, install the unit, reload the manager.
   * Run BEFORE the runtime is stopped, so a refusal leaves a serving daemon;
   * `adoptIntoService` then only has to enable. Optional for embedders, whose
   * `adoptIntoService` keeps doing the whole job.
   */
  prepareAdoption?(signal?: AbortSignal): ServiceHandoverOutcome | Promise<ServiceHandoverOutcome>;
  /** Install + enable the service unit. Legacy void carries no acknowledgement. */
  adoptIntoService(signal?: AbortSignal): void | ServiceHandoverOutcome | Promise<void | ServiceHandoverOutcome>;
  /** Enqueue a non-blocking service restart and observe manager acceptance. */
  restartService(signal?: AbortSignal): void | ServiceHandoverOutcome | Promise<void | ServiceHandoverOutcome>;
}

export interface DaemonUpdateInstallLocation {
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly io?: UpdateFileIo | undefined;
}

/**
 * One installed file an update replaces (and a rollback restores).
 * `assetName` is null when this platform/arch publishes no release asset for
 * it, such a file can still be rolled back, it just cannot be downloaded.
 */
export interface DaemonInstalledFile {
  readonly label: string;
  readonly path: string;
  readonly executable: boolean;
  readonly assetName: string | null;
}

/**
 * Fixed native daemon payloads and their installation reader evidence. Updates and
 * rollback use this same cohort, regardless of whether a required file is
 * currently present. The selected feed must supply all checksum-bound assets.
 */
export function resolveDaemonInstalledFiles(location: DaemonUpdateInstallLocation): DaemonInstalledFile[] {
  return [...(resolveDaemonUpdateTargets(location.execPath, location.platform, location.arch) ?? [])];
}

export interface DaemonAutoUpdaterOptions {
  readonly currentVersion: string;
  /** Compiled reader evidence retained by the original running installation. */
  readonly currentReader?: DaemonCurrentReader;
  /** Actual monorepo composition opts in; unrelated embedding hosts retain
   * their explicitly selected daemon-only update contract. */
  readonly suite?: { readonly configManager: { get(key: string): unknown } } | undefined;
  readonly execPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** GitHub releases/latest URL used for tag resolution. */
  readonly releasesLatestUrl: string;
  /**
   * The release address now (the owner's `update.releasesUrl`), read before
   * every check so a changed setting is followed without a restart. Absent:
   * `releasesLatestUrl` for the loop's whole life.
   */
  readonly releasesUrlNow?: (() => string) | undefined;
  /** `${releasesLatestUrl%/latest}/download/<tag>` builder override for tests. */
  readonly downloadBaseUrl?: ((tag: string) => string) | undefined;
  /** Hourly by default. */
  readonly checkIntervalMs?: number | undefined;
  /** Delay before the FIRST check after start. Default 30s (boot settle). */
  readonly firstCheckDelayMs?: number | undefined;
  /** How often to retry a discovered-but-deferred update while the daemon is busy. */
  readonly busyRetryMs?: number | undefined;
  /** The daemon's real activity signal: true only when NO work is in flight. */
  readonly isIdle: () => boolean;
  /**
   * The daemon's work admission. Closed in the same synchronous step as the
   * last idle check before the swap commits, so no work admitted after that
   * check can start; reopened when the update does not commit or the handover
   * is refused before the orderly stop. Absent: nothing is fenced.
   */
  readonly workAdmission?: DaemonWorkAdmission | undefined;
  /**
   * Ids of the work keeping the daemon busy, read only when `isIdle` said no,
   * so a waiting update can say what it waits for. Absent = not reported.
   */
  readonly describeActiveWork?: (() => readonly string[]) | undefined;
  readonly serviceActions: AutoUpdateServiceActions;
  readonly receipts: DaemonReceiptStore;
  /** The zone receipt times are stated in, read when a receipt is written (`receiptTimeZone`); this machine's zone when absent or undefined. */
  readonly receiptTimeZone?: (() => string | undefined) | undefined;
  readonly fetchImpl?: UpdateFetchLike | undefined;
  readonly io?: UpdateFileIo | undefined;
  /**
   * The daemon's own orderly stop, run BEFORE the process hands over to the
   * restarted instance, so shutdown hooks fire on an update restart instead of
   * being skipped by a bare exit. Absent = nothing to wind down. If this hook
   * reenters the updater, use stop(true)/drainHandover(true): a normal stop
   * cancels the handover, and draining it here would wait on this hook itself.
   */
  readonly stopGracefully?: (() => Promise<void> | void) | undefined;
  /** How long that orderly stop may take before the handover is reported incomplete. Default 60 s. */
  readonly handoverStopDeadlineMs?: number | undefined;
  /** Exits the current process after an unsupervised daemon is adopted. */
  readonly exitProcess?: ((code: number) => void) | undefined;
  /**
   * Called once when the handover did not complete after the orderly stop
   * already ran: the process then serves nothing and no supervisor restarts
   * it while it stays alive, so the host that owns the process ends it with a
   * failure status. Absent: the incomplete handover is only reported.
   */
  readonly onIncompleteHandover?: (() => void) | undefined;
  /** Told when what `update.status` reports changed: a check ended, an install began or ended, recovery is needed. */
  readonly onStateChange?: (() => void) | undefined;
  /** Injectable stderr; absent = a synchronous write to fd 2, so the service journal records an incomplete handover. */
  readonly stderr?: { write(chunk: string): unknown } | undefined;
  /**
   * The version a crash-loop rollback rejected, or null when none stands.
   * Consulted on every check: a release that already failed to start on this
   * host is not installed a second time just because it is still the latest
   * one. Read fresh each time (it lives in the lifecycle marker on disk), so a
   * rejection recorded by the boot before this one is seen.
   */
  readonly rejectedVersion?: (() => string | null) | undefined;
  /**
   * Put one line in front of the owner over a channel that still works, the
   * daemon's existing owner-alert path. Absent = no channel to alert on (an
   * embedded daemon, a test), in which case the ERROR log line is the record.
   */
  readonly alertOwner?: ((text: string) => void) | undefined;
  /**
   * @deprecated Compatibility only; failure transience, never a count, decides alerts.
   */
  readonly alertAfterFailedChecks?: number | undefined;
  /** Quiet window after an update alert, so a persistent failure is one message, not one per hour. Default 12h. */
  readonly alertWindowMs?: number | undefined;
  /**
   * Unbroken failing time after which a network-shaped failure is reported
   * too, and how long a found update may wait for an idle moment before the
   * owner is told what holds it. Default 24h.
   */
  readonly persistentFailureMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimer?: ((fn: () => void, ms: number) => ReturnType<typeof setTimeout>) | undefined;
  readonly clearTimer?: ((timer: ReturnType<typeof setTimeout>) => void) | undefined;
}

/** @deprecated Compatibility value only; the canonical failure reading decides alerts. */
export const DEFAULT_UPDATE_ALERT_AFTER_FAILED_CHECKS = 3;

/**
 * How long the orderly stop before a handover may take. A stop finishes in
 * seconds; past this, a step that never settles holds the process with no
 * listener, and only ending it lets the service manager start the new release.
 */
const DEFAULT_HANDOVER_STOP_DEADLINE_MS = 60_000;

/** Default quiet window between update alerts about the same ongoing failure. */
export const DEFAULT_UPDATE_ALERT_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * How long checks may fail without interruption before even a network-shaped
 * failure reaches the owner. A blocked release host looks exactly like a brief
 * outage on every single check, so the count of failures cannot tell them apart;
 * the time since the last good check can.
 */
export const DEFAULT_UPDATE_PERSISTENT_FAILURE_MS = 24 * 60 * 60 * 1000;

interface PendingSwap {
  readonly tag: string;
  readonly targets: readonly UpdateTarget[];
  /** The release address the tag was found at: its files are downloaded from the same place. */
  readonly releasesUrl: string;
}

/** The live state of one daemon's self-update loop. */
export interface DaemonUpdateLoopSnapshot {
  /** The running artifact's version, as the loop compares it. */
  readonly currentVersion: string;
  /** Where release tags are resolved from. */
  readonly releasesUrl: string;
  /** The steady-state cadence between checks. */
  readonly checkIntervalMs: number;
  /** The delay before the first check after a boot. */
  readonly firstCheckDelayMs: number;
  /** Consecutive checks that threw. Zero once one completes. */
  readonly failedCheckCount: number;
  /** What the most recent failing check said, or null when none is failing. */
  readonly lastCheckFailure: string | null;
  /** A discovered release waiting for an idle moment, or null. */
  readonly pendingVersion: string | null;
  /** When the waiting release first had to wait for active work (epoch ms), or null. */
  readonly pendingSince?: number | null;
  /** The work that kept the last check from installing it, by fleet id. */
  readonly pendingBlockedBy?: readonly string[];
  /** A release being downloaded and installed right now, with how much of it has arrived, or null. */
  readonly installing?: DaemonUpdateInstallProgress | null;
  /** The version installed on disk by this process, independently of handover. */
  readonly appliedVersion?: string | null;
  /** An incomplete filesystem transaction has paused updates pending inspection. */
  readonly recoveryRequired?: boolean;
  /** Exact retained-filesystem evidence for the paused transaction, if any. */
  readonly transactionRecovery?: UpdateTransactionReceipt | null;
  /** Service-manager acknowledgement, never proof that the new daemon is healthy. */
  readonly handover?: ServiceHandoverOutcome | null;
}

export class DaemonAutoUpdater {
  private readonly loop: PeriodicUpdateLoop;
  private failureReadAbort = new AbortController();
  /** A discovered release descriptor waiting for an idle moment. */
  private pendingSwap: PendingSwap | null = null;
  /** When the current release first had to wait for active work, or null. */
  private waitingSince: number | null = null;
  /** What held the last deferral, by fleet id. */
  private waitingFor: readonly string[] = [];
  /** The owner was told about this wait already. */
  private waitAlerted = false;
  /** A completed disk swap is terminal for this process, even if handover fails. */
  private appliedVersion: string | null = null;
  private recoveryRequired = false;
  private transactionRecovery: UpdateTransactionReceipt | null = null;
  /** The release being downloaded and installed now, or null. */
  private installing: DaemonUpdateInstallProgress | null = null;
  private handover: ServiceHandoverOutcome | null = null;
  private lastHandoverPreflightRefusal: string | null = null;
  private handoverCancelled = false;
  private handoverExitRequested = false;
  /** Set once the orderly stop for an accepted handover begins: admission then stays closed. */
  private runtimeStopStarted = false;
  /** The orderly stop ran and the handover then did not complete; exit once any reservation is released. */
  private incompleteAfterStop = false;
  /** A supervised restart (no exit of this process needed) has been asked of the service manager. */
  private restartRequested = false;
  /** An external stop arrived after that request: the manager is carrying the restart out. */
  private stoppedByRequestedRestart = false;
  private handoverTask: Promise<void> | null = null;
  private handoverAbort: AbortController | null = null;
  /** Settles only after lookup/apply/handover, including checks started by the timer. */
  private activeCheck: Promise<void> | null = null;
  private finishActiveCheck: (() => void) | null = null;
  /** Handed to the next check `checkNow` starts; the check takes it synchronously as it begins. */
  private nextCheckInstallNotice: (() => void) | null = null;
  /** The running check's notice: called once, when it has found a release and starts installing it. */
  private installNotice: (() => void) | null = null;
  /** Consecutive checks that threw. Reset by any check that completes. */
  private consecutiveFailures = 0;
  /** When the current unbroken run of failed checks began, or null. */
  private failingSince: number | null = null;
  /** When the owner was last told the daemon cannot update itself, or null. */
  private failureAlertedAt: number | null = null;
  /** The last error text told to the owner, so recovery can name what stopped. */
  private lastFailureDetail: string | null = null;
  /** Rejected releases already reported, so the skip is stated once per release, not hourly. */
  private readonly reportedRejections = new Set<string>();

  private readonly options: DaemonAutoUpdaterOptions;
  private readonly writeReceipt: DaemonReceiptStore['record'];

  constructor(options: DaemonAutoUpdaterOptions) {
    // Own the install identity and callbacks before the first await. Captured
    // probes still observe their live closure state; callers cannot redirect
    // an admitted update by replacing members on the retained options object.
    const actions = options.serviceActions;
    const reader = options.currentReader;
    this.options = {
      ...options,
      ...(reader ? { currentReader: Object.freeze({ readers: parseNativeReaderCapabilities(reader.readers), assertCurrent: reader.assertCurrent.bind(reader) }) } : {}),
      fetchImpl: options.fetchImpl ?? (fetch as unknown as UpdateFetchLike),
      serviceActions: {
        isSupervised: actions.isSupervised.bind(actions),
        adoptIntoService: actions.adoptIntoService.bind(actions),
        restartService: actions.restartService.bind(actions),
        ...(actions.preflight ? { preflight: actions.preflight.bind(actions) } : {}),
        ...(actions.prepareAdoption ? { prepareAdoption: actions.prepareAdoption.bind(actions) } : {}),
        ...(actions.reserve ? { reserve: actions.reserve.bind(actions) } : {}),
      },
    };
    this.writeReceipt = options.receipts.record.bind(options.receipts);
    this.loop = new PeriodicUpdateLoop({
      checkIntervalMs: options.checkIntervalMs,
      firstCheckDelayMs: options.firstCheckDelayMs,
      busyRetryMs: options.busyRetryMs,
      runCheck: async (): Promise<PeriodicCheckOutcome> => {
        const signal = this.failureReadAbort.signal;
        this.installNotice = this.nextCheckInstallNotice;
        this.nextCheckInstallNotice = null;
        // A separate completion promise never rejects and includes any owned
        // failure reading, so shutdown can drain it without a second retry owner.
        this.activeCheck = new Promise((resolve) => {
          this.finishActiveCheck = () => {
            this.activeCheck = null;
            this.finishActiveCheck = null;
            resolve();
          };
        });
        try {
          await this.checkAndApply(signal);
          // A failed handover must not be followed by a misleading recovery line.
          if (!signal.aborted && !this.handoverCancelled && !this.recoveryRequired && (this.handover === null || this.handover.status === 'accepted')) this.recordCheckSucceeded();
        } catch (error) {
          this.pendingSwap = null;
          if (!signal.aborted && !this.handoverCancelled) await this.recordCheckFailed(error, signal);
        } finally {
          this.installNotice = null;
          this.finishActiveCheck?.();
        }
        if (!this.pendingSwap) this.clearWait();
        // Every screen showing the update state reads it again (a check ran: found, failed or nothing new).
        this.stateChanged();
        return this.pendingSwap ? 'deferred' : 'settled';
      },
      onError: (error) => {
        // A reading failure is operational: never guess a transience class from
        // it. It only counts as time spent failing, so a daemon that cannot update
        // for a day is still reported when the reading itself is unavailable.
        logger.error('DaemonAutoUpdater: update failure reading could not complete', { error: summarizeError(error) });
        if (!this.failureReadAbort.signal.aborted && !this.handoverCancelled) this.alertIfFailingTooLong();
      },
      setTimer: options.setTimer,
      clearTimer: options.clearTimer,
    });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Put a line in front of the owner, and state it at ERROR either way. An
   * update path that has stopped working is exactly the class of failure that
   * spent three days as WARN lines in a debug log while three releases shipped
   * and the installed daemon stayed where it was.
   */
  private alertOwner(text: string): void {
    logger.error(`DaemonAutoUpdater: ${text}`);
    try {
      this.options.alertOwner?.(text);
    } catch (error) {
      logger.error('DaemonAutoUpdater: the owner alert about self-update could not be sent', {
        error: summarizeError(error),
      });
    }
  }

  /** Counts remain diagnostics. Only the canonical failure reading decides an alert. */
  private async recordCheckFailed(error: unknown, signal: AbortSignal): Promise<void> {
    const assertCurrent = () => signal.throwIfAborted();
    assertCurrent();
    this.consecutiveFailures += 1;
    this.failingSince ??= this.now();
    const captured = captureJudgmentFailure(error);
    const detail = summarizeError(captured);
    this.lastFailureDetail = detail;
    const transience = await readFailureTransience(captured, 'daemon.auto-updater.failure', {
      reading: { get port() { return daemonReadingPort('daemon.auto-updater.failure', assertCurrent, signal); }, signal, beforeAttempt: assertCurrent },
    });
    assertCurrent();
    if (transience.failureClass === 'retryable' && !this.hasFailedTooLong()) {
      logger.warn('DaemonAutoUpdater: transient update check failure; will retry on the next interval', {
        error: detail, consecutiveFailures: this.consecutiveFailures,
      });
      return;
    }
    this.alertCheckFailing(detail);
  }

  private hasFailedTooLong(): boolean {
    return this.failingSince !== null
      && this.now() - this.failingSince >= Math.max(0, this.options.persistentFailureMs ?? DEFAULT_UPDATE_PERSISTENT_FAILURE_MS);
  }

  /** The failure reading was unavailable: only the unbroken failing time can justify an alert. */
  private alertIfFailingTooLong(): void {
    if (this.hasFailedTooLong() && this.lastFailureDetail !== null) this.alertCheckFailing(this.lastFailureDetail);
  }

  private alertCheckFailing(detail: string): void {
    const windowMs = Math.max(0, this.options.alertWindowMs ?? DEFAULT_UPDATE_ALERT_WINDOW_MS);
    const now = this.now();
    if (this.failureAlertedAt !== null && now - this.failureAlertedAt < windowMs) {
      logger.warn('DaemonAutoUpdater: update check still failing; the owner has already been told', {
        error: detail,
        consecutiveFailures: this.consecutiveFailures,
      });
      return;
    }
    this.failureAlertedAt = now;
    this.alertOwner(
      `the daemon has not been able to check for updates ${this.consecutiveFailures} ${this.consecutiveFailures === 1 ? 'time' : 'times'} in a row`
      + `, it is still running v${normalizeVersion(this.options.currentVersion)} and will keep retrying.`
      + ` Last error: ${detail}`,
    );
  }

  /** A check that completed. Says so if the owner had been told it was failing. */
  private recordCheckSucceeded(): void {
    const wasAlerted = this.failureAlertedAt !== null;
    const failures = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    this.failingSince = null;
    this.failureAlertedAt = null;
    this.lastFailureDetail = null;
    if (!wasAlerted) return;
    this.alertOwner(
      `update checks are working again after ${failures} consecutive ${failures === 1 ? 'failure' : 'failures'}`
      + (this.appliedVersion
        ? `, v${this.appliedVersion} is installed on disk and the service manager accepted the handover request`
        : `, the daemon is on v${normalizeVersion(this.options.currentVersion)} and checking on schedule`),
    );
  }

  /**
   * A found release is waiting because work is in flight. Says what holds it
   * and, once the wait passes the same bar failures use, tells the owner once.
   */
  private recordWait(tag: string): void {
    const now = this.now();
    this.waitingSince ??= now;
    this.waitingFor = this.options.describeActiveWork?.() ?? [];
    logger.info('DaemonAutoUpdater: update ready but the daemon has active work; deferring the swap', {
      tag, waitingSince: this.waitingSince, blockedBy: this.waitingFor,
    });
    const limitMs = Math.max(0, this.options.persistentFailureMs ?? DEFAULT_UPDATE_PERSISTENT_FAILURE_MS);
    if (this.waitAlerted || now - this.waitingSince < limitMs) return;
    this.waitAlerted = true;
    const hours = Math.floor((now - this.waitingSince) / 3_600_000);
    this.alertOwner(
      `v${normalizeVersion(tag)} has waited ${hours} hours to install because work is still running`
      + (this.waitingFor.length > 0 ? ` (${this.waitingFor.slice(0, 5).join(', ')}${this.waitingFor.length > 5 ? ` and ${this.waitingFor.length - 5} more` : ''})` : '')
      + `. The daemon stays on v${normalizeVersion(this.options.currentVersion)} until that work ends; stop it from /agents open to install sooner.`,
    );
  }

  /** Tell the owner of this loop that what `update.status` reports changed; a listener's failure never reaches the update. */
  private stateChanged(): void {
    try { this.options.onStateChange?.(); } catch (error) {
      logger.warn('DaemonAutoUpdater: the update-state listener failed', { error: summarizeError(error) });
    }
  }

  private clearWait(): void {
    this.waitingSince = null;
    this.waitingFor = [];
    this.waitAlerted = false;
  }

  /** The most recent failure detail, exposed for the /status surface and tests. */
  get lastCheckFailure(): string | null {
    return this.lastFailureDetail;
  }

  /**
   * What the loop knows right now, as one readable record.
   *
   * Everything here was already tracked and already decided the loop's
   * behaviour; none of it was answerable from outside the process. "Is this
   * daemon updating itself, and if not why not" was a question only the log
   * could answer, and only to someone with shell access to the host, which is
   * how three releases shipped past a daemon whose checks had been failing for
   * days with nobody able to see it from any surface.
   */
  /** The release address the next check asks: the setting as it is now, when the host gave a reader for it. */
  private releasesUrl(): string {
    return this.options.releasesUrlNow ? this.options.releasesUrlNow() : this.options.releasesLatestUrl;
  }

  snapshot(): DaemonUpdateLoopSnapshot {
    return {
      currentVersion: normalizeVersion(this.options.currentVersion),
      releasesUrl: this.pendingSwap?.releasesUrl ?? this.releasesUrl(),
      checkIntervalMs: this.loop.checkIntervalMs,
      firstCheckDelayMs: this.loop.firstCheckDelayMs,
      failedCheckCount: this.consecutiveFailures,
      lastCheckFailure: this.lastFailureDetail,
      pendingVersion: this.pendingSwap ? normalizeVersion(this.pendingSwap.tag) : null,
      pendingSince: this.pendingSwap ? this.waitingSince : null,
      pendingBlockedBy: this.pendingSwap ? [...this.waitingFor] : [],
      installing: this.installing ? { ...this.installing } : null,
      appliedVersion: this.appliedVersion,
      recoveryRequired: this.recoveryRequired,
      transactionRecovery: this.transactionRecovery ? {
        ...this.transactionRecovery,
        targets: [...this.transactionRecovery.targets],
        recoveryPaths: [...this.transactionRecovery.recoveryPaths],
        recoveryErrors: [...this.transactionRecovery.recoveryErrors],
      } : null,
      handover: this.handover ? { ...this.handover } : null,
    };
  }

  /** Consecutive failed checks, exposed for the /status surface and tests. */
  get failedCheckCount(): number {
    return this.consecutiveFailures;
  }

  /** The delay before the first check, so callers can log the schedule they got. */
  get firstCheckDelayMs(): number {
    return this.loop.firstCheckDelayMs;
  }

  /** The steady-state cadence, so callers can log the schedule they got. */
  get checkIntervalMs(): number {
    return this.loop.checkIntervalMs;
  }

  /** Begin the loop. The first check runs after a short boot-settle delay. */
  start(): void {
    if (this.appliedVersion !== null || this.recoveryRequired) return;
    this.handoverCancelled = false;
    if (this.failureReadAbort.signal.aborted) this.failureReadAbort = new AbortController();
    this.loop.start();
  }

  /** Cancel future checks; only the updater-owned graceful stop preserves its handover. */
  stop(forHandover = false): void {
    this.loop.stop();
    // An external shutdown can arrive during graceful stop or during the
    // service action. Timing alone cannot distinguish it from our own stop.
    if (!forHandover) {
      // After a supervised restart was requested, the manager's stop of this
      // process is that restart, not a cancellation of it.
      if (this.restartRequested) this.stoppedByRequestedRestart = true;
      this.handoverCancelled = true;
      this.failureReadAbort.abort();
      this.handoverAbort?.abort();
    }
  }

  /** Drain lookup/apply/handover; its own graceful stop must explicitly avoid waiting on itself. */
  drainHandover(forHandover = false): Promise<void> {
    return (forHandover ? null : this.activeCheck ?? this.handoverTask) ?? Promise.resolve();
  }

  /** One loop iteration; exposed for tests driving mocked time. */
  tick(): ReturnType<PeriodicUpdateLoop['tick']> {
    return this.loop.tick();
  }

  /**
   * One check on request (the same tick the schedule runs), answered as soon
   * as the outcome is known: when it finds a release and the daemon is free to
   * take it, the answer is `installing` and is given BEFORE the download,
   * install and handover run. The handover's orderly stop closes the listener
   * and waits for the requests it is serving; a request still waiting for that
   * handover would never finish, so the stop would never finish either.
   */
  checkNow(): Promise<'ran' | 'already-in-flight' | 'stopped' | 'installing'> {
    const installing = Promise.withResolvers<'installing'>();
    // A tick that starts a check runs it synchronously up to its first await,
    // so the check has taken this notice by the time tick() returns; a tick
    // that starts none leaves it to be cleared here.
    this.nextCheckInstallNotice = () => { installing.resolve('installing'); };
    const ticked = this.loop.tick();
    this.nextCheckInstallNotice = null;
    return Promise.race([ticked, installing.promise]);
  }

  private async checkAndApply(signal: AbortSignal): Promise<void> {
    if (this.appliedVersion !== null || this.recoveryRequired || this.handoverCancelled) return;
    // Capture member methods per check, so pre-tick injected adapters remain
    // supported while asynchronous lookup cannot redirect resolve or commit I/O.
    const io = captureUpdateFileIo(this.options.io ?? realUpdateFileIo);
    const suiteConfiguration = this.options.suite ? retainSuiteUpdateConfiguration(this.options.suite.configManager) : undefined;
    const assertLifecycleCurrent = () => {
      signal.throwIfAborted();
      suiteConfiguration?.assertCurrent();
      if (signal !== this.failureReadAbort.signal || this.handoverCancelled || this.appliedVersion !== null || this.recoveryRequired) {
        throw new Error('update check no longer belongs to the current updater lifecycle');
      }
    };
    const installedTargets = resolveDaemonUpdateTargets(this.options.execPath, this.options.platform, this.options.arch);
    if (!installedTargets) return;
    const readerOwner = this.options.currentReader;
    const retainedNative = readerOwner !== undefined && observesUpdateFiles(io);
    const retainedCurrent = () => {
      if (!retainedNative || !readerOwner) return;
      assertSynchronousJudgmentGuard(() => readerOwner.assertCurrent(), () => new Error('The original installed daemon reader must be synchronous'));
    };
    // Native startup already verified this exact installed cohort. Its original
    // source assertion detects replacement or edits without rehashing every
    // program/runtime/library on each idle update tick. Borrowed installations
    // without that original owner still need their initial integrity check.
    retainedCurrent();
    const installed = inspectDaemonUpdateInstallation(this.options.execPath, this.options.platform, this.options.arch, '', io, { integrity: !retainedNative });
    retainedCurrent();
    if (!installed || compareVersions(installed.version, this.options.currentVersion) !== 0) throw new Error('Running daemon does not own the complete installed native cohort');
    const assertInstallationCurrent = retainDaemonNativeFiles(installedTargets, io);
    const assertCurrent = () => { assertLifecycleCurrent(); assertInstallationCurrent(); };
    const fetchImpl = this.options.fetchImpl ?? (fetch as unknown as UpdateFetchLike);

    if (!this.pendingSwap) {
      assertCurrent();
      const releasesUrl = this.releasesUrl();
      if (releasesUrl.length === 0) throw new Error('update.releasesUrl is empty, so there is nowhere to resolve release tags from');
      const latestTag = await resolveLatestReleaseTag(fetchImpl, releasesUrl, { signal });
      assertCurrent();
      const comparison = compareVersions(this.options.currentVersion, latestTag);
      if (comparison > 0 || comparison === 0 && (!suiteConfiguration || !installedSuiteNeedsRepair({ execPath: this.options.execPath,
        platform: this.options.platform, arch: this.options.arch, version: latestTag, io, webuiDirectory: suiteConfiguration.webuiDirectory }))) return;
      // A release that already crash looped on this host does not get installed
      // again just because it is still the newest one. Without this the loop is
      // a cycle: swap, fail to start three times, roll back, and one check
      // interval later download the identical release and do it again, which
      // is what kept an installed daemon pinned to an old build for days while
      // three releases came and went.
      const rejected = this.rejectedVersion();
      if (rejected !== null && normalizeVersion(latestTag) === rejected) {
        this.reportRejectedRelease(rejected);
        return;
      }
      const targets = this.resolveTargets(io);
      if (!targets) {
        logger.info('DaemonAutoUpdater: no prebuilt binaries for this platform; not self-updating', {
          platform: this.options.platform,
          arch: this.options.arch,
        });
        return;
      }
      this.pendingSwap = { tag: latestTag, targets, releasesUrl };
      logger.info('DaemonAutoUpdater: update found', {
        from: normalizeVersion(this.options.currentVersion),
        to: this.pendingSwap.tag,
      });
    }

    // A handover is needed only for an actual replacement or suite repair.
    // Check support before downloading assets or publishing any install files.
    let handover: PreparedServiceHandover | undefined;
    try { handover = prepareServiceHandover(this.options.serviceActions); }
    catch (error) {
      this.pendingSwap = null;
      this.reportHandoverPreflightRefusal(error);
      return;
    }
    this.handover = null;

    // Avoid downloading while already busy. The authoritative snapshot is
    // repeated below after every asynchronous download and synchronous stage.
    assertCurrent();
    if (!this.options.isIdle()) {
      this.recordWait(this.pendingSwap.tag);
      return;
    }

    try {
      try {
        await handover?.reserve(signal);
        assertCurrent(); handover?.assertCurrent();
      } catch (error) {
        this.pendingSwap = null;
        if (!signal.aborted) this.reportHandoverPreflightRefusal(error);
        return;
      }
    assertCurrent();
    // Found, idle and admitted: whoever asked for this check is answered now, before the install and handover run.
    const notice = this.installNotice;
    this.installNotice = null;
    notice?.();
    const { tag, targets, releasesUrl } = this.pendingSwap;
    const downloadBase = this.options.downloadBaseUrl
      ? this.options.downloadBaseUrl(tag)
      : defaultDownloadBaseUrl(releasesUrl, tag);
    // What `update.status` reports while the release downloads and installs.
    const installing = { version: normalizeVersion(tag), since: this.now(), receivedBytes: 0, file: null as string | null,
      fileReceivedBytes: 0, fileTotalBytes: null as number | null, fileNumber: null as number | null, fileCount: null as number | null };
    this.installing = installing;
    this.stateChanged();
    // The release's files in download order, from the update's own plan (no request): which file of how many is downloading.
    let releaseFiles: readonly string[] = suiteConfiguration ? [] : targets.map(target => target.assetName);
    const onFiles = (assetNames: readonly string[]) => { releaseFiles = assetNames; };
    const onReceived = (file: string, bytes: number, totalBytes?: number) => {
      if (installing.file !== file) {
        installing.fileReceivedBytes = 0;
        const index = releaseFiles.indexOf(file);
        installing.fileNumber = index >= 0 ? index + 1 : null;
        installing.fileCount = index >= 0 ? releaseFiles.length : null;
      }
      installing.receivedBytes += bytes;
      installing.file = file;
      installing.fileReceivedBytes += bytes;
      installing.fileTotalBytes = totalBytes ?? null;
    };

    const busyBeforeCommit = new Error('daemon became busy before update commit');
    let suiteResult: SuiteUpdateResult | undefined;
    const admitIdle = () => {
      assertCurrent();
      handover?.assertCurrent();
      const idle = this.options.isIdle();
      assertCurrent();
      if (!idle) throw busyBeforeCommit;
      // Same synchronous step as the idle answer: nothing admitted after it can start.
      this.options.workAdmission?.close(`it is installing v${normalizeVersion(tag)} and will restart into it`);
    };
    try {
      if (suiteConfiguration) {
        suiteResult = await applySuiteUpdate({ execPath: this.options.execPath, platform: this.options.platform, arch: this.options.arch,
          version: tag, downloadBaseUrl: downloadBase, fetchImpl, io, signal, onReceived, onFiles,
          webuiDirectory: suiteConfiguration.webuiDirectory, ...(this.options.currentReader ? { currentReader: this.options.currentReader } : {}),
          assertCurrent: assertLifecycleCurrent, beforeCommit: admitIdle });
      } else await applyVerifiedUpdate({
        fetchImpl,
        downloadBaseUrl: downloadBase,
        targets,
        io,
        platform: this.options.platform,
        signal,
        onReceived,
        ...(this.options.platform === 'linux' ? { daemonNative: { execPath: this.options.execPath, platform: this.options.platform, arch: this.options.arch, version: tag,
          ...(this.options.currentReader ? { currentReader: this.options.currentReader } : {}) } } : { native: true, readerExecPath: this.options.execPath }),
        assertCurrent: assertLifecycleCurrent,
        beforeCommit: stage => {
          admitIdle();
          if (this.options.platform === 'darwin') assertStagedClientReaderCompatible(this.options.execPath, this.options.execPath + '.update-download', io, tag, undefined, stage, true);
        },
      });
    } catch (error) {
      if (error instanceof SuiteUpdateRecoveryError) {
        const original = error.cause;
        if (original instanceof UpdateTransactionError) this.pauseForTransactionRecovery(tag, new UpdateTransactionError({ ...original.receipt,
          targets: [...new Set([...original.receipt.targets, ...error.paths])], recoveryPaths: [...new Set([...original.receipt.recoveryPaths, ...error.paths])] }, error));
        else this.pauseForTransactionRecovery(tag, new UpdateTransactionError({ operation: 'update', phase: 'cleanup', committed: error.committed,
          recoveryRequired: true, targets: [...targets.map(target => target.path), ...error.paths], recoveryPaths: [...error.paths],
          recoveryErrors: error.problems.map(problem => summarizeError(problem)) }, error));
        return;
      }
      const preparation = error instanceof SuiteUpdatePreparationError ? error : undefined;
      // A safely discarded private stage can be preserved without making the
      // live installation uncertain. Only that typed, non-recovery wrapper
      // may expose its original admission failure; recovery fences stay above.
      const failure = preparation && (preparation.cause instanceof ServiceHandoverPreflightError
        || preparation.cause instanceof UpdateTransactionError && !preparation.cause.receipt.committed && !preparation.cause.receipt.recoveryRequired)
        ? preparation.cause : error;
      if (failure instanceof UpdateTransactionError) {
        if (failure.receipt.recoveryRequired) {
          this.pauseForTransactionRecovery(tag, failure);
          return;
        }
        if (failure.receipt.phase === 'claim' && !failure.receipt.committed && failure.cause instanceof UpdateTransactionContendedError) {
          // Another live updater holds the installation; nothing was changed.
          // Keep the descriptor and retry on the short cadence, like a busy daemon.
          logger.info('DaemonAutoUpdater: another update holds the installation; deferring this one', { tag, detail: failure.cause.message });
          return;
        }
        if (failure.receipt.phase === 'admission' && !failure.receipt.committed && failure.cause === busyBeforeCommit) {
          assertCurrent();
          this.recordWait(tag);
          if (preparation?.preservedPaths.length) this.recordReceipt(`Update deferred before publication because the daemon became busy. Discarded staging was preserved at: ${preparation.preservedPaths.join(', ')}`);
          return;
        }
        if (!failure.receipt.committed && failure.cause instanceof ServiceHandoverPreflightError) {
          this.reportHandoverPreflightRefusal(failure.cause, preparation?.preservedPaths);
          return;
        }
      }
      if (failure instanceof ServiceHandoverPreflightError) {
        this.reportHandoverPreflightRefusal(failure, preparation?.preservedPaths);
        return;
      }
      throw error;
    } finally {
      this.installing = null;
      this.stateChanged();
    }
    this.pendingSwap = null;
    // Set the latch before any receipt, shutdown hook, or service action can
    // fail. The old running version must never re-swap the installed release
    // and overwrite its previous binary while waiting for a new process.
    this.appliedVersion = normalizeVersion(tag);
    this.handover = { status: 'unknown', detail: 'service handover is pending' };
    this.loop.stop();

    const now = this.options.now ?? Date.now;
    const from = normalizeVersion(this.options.currentVersion);
    const to = normalizeVersion(tag);
    // One update, one receipt. A suite swap replaces installed files, while
    // every terminal UI and agent process already attached keeps running the
    // build it started with until restarted. Report those distinct outcomes.
    // Once the new daemon answers, clients below ITS floor (derived from the
    // version installed, not this running build) additionally stop taking
    // shared-session work (control-plane/client-compatibility.ts) rather than
    // only being asked to restart.
    this.recordReceipt(
      `updated from ${from} to ${to} at ${formatReceiptTime(now(), this.options.receiptTimeZone?.())}`
      + (suiteResult ? `; installed suite: ${suiteResult.programs.join(', ')}, browser/WebUI directories: ${suiteResult.directoryPaths.join(', ')};` + (suiteResult.preservedPaths.length ? ` retained earlier backups: ${suiteResult.preservedPaths.join(', ')};` : '') : '')
      + ` on disk; service handover is pending, already-running goodvibes clients keep their old build until restarted;`
      + ` once the new daemon answers, any client older than ${clientCompatibilityFloorFor(to)} stops taking shared-session work until it is restarted`,
    );

    if (this.handoverCancelled) {
      this.reportIncompleteHandover({ status: 'unknown', detail: 'updater stopped while applying the disk update; process handover was cancelled' });
      return;
    }
    await this.restartIntoNewBinary(handover);
    } finally {
      // Not stopping after all (no commit, a refused or cancelled handover): take work again, under a new generation.
      if (!this.runtimeStopStarted) this.options.workAdmission?.reopen();
      try { if (!this.handoverExitRequested || this.handoverCancelled) await handover?.cancel(); }
      catch {
        this.handoverCancelled = true;
        if (this.appliedVersion !== null) this.reportIncompleteHandover({ status: 'unknown', detail: 'The manager-owned handover helper could not be retired.' });
        else this.reportHandoverPreflightRefusal(new ServiceHandoverPreflightError('The manager-owned handover helper could not be retired; automatic updates are paused.'));
      }
      // Only after any manager-owned reservation was released.
      if (this.incompleteAfterStop && !this.handoverCancelled) this.exitAfterIncompleteHandover();
    }
  }

  /** The runtime already stopped and nothing took over: the process owner ends it so a supervisor starts the installed build. */
  private exitAfterIncompleteHandover(): void {
    this.incompleteAfterStop = false;
    const end = this.options.onIncompleteHandover;
    if (!end) return;
    this.announce(`goodvibes daemon: the update handover did not complete after the runtime had stopped; ending this process with status 1 so the service manager can start the installed v${this.appliedVersion ?? 'unknown'}`);
    flushActivityLogSync();
    try { end(); }
    catch (error) { logger.error('DaemonAutoUpdater: the process could not be ended after an incomplete handover', { error: summarizeError(error) }); }
  }

  /** Synchronous stderr: the activity log flushes asynchronously and this process may exit next. Never throws. */
  private announce(line: string): void {
    try {
      if (this.options.stderr) this.options.stderr.write(`${line}\n`);
      else writeFatalLine(line);
    } catch { /* An unwritable stderr must not change the update outcome. */ }
  }

  /** Filesystem recovery is an observed outcome, never an automatic retry decision. */
  private pauseForTransactionRecovery(tag: string, error: UpdateTransactionError): void {
    this.recoveryRequired = true;
    this.transactionRecovery = {
      ...error.receipt,
      targets: [...error.receipt.targets],
      recoveryPaths: [...error.receipt.recoveryPaths],
      recoveryErrors: [...error.receipt.recoveryErrors],
    };
    this.pendingSwap = null;
    this.loop.stop();
    this.consecutiveFailures += 1;
    if (error.receipt.committed) {
      this.appliedVersion = normalizeVersion(tag);
      this.handover = { status: 'unknown', detail: 'update committed but transaction cleanup requires recovery; no service handover was requested' };
    }
    const detail = `update to v${normalizeVersion(tag)} requires filesystem recovery after ${error.receipt.phase}`
      + (error.receipt.committed ? '; the complete update is installed on disk.' : '; the complete update was not installed.')
      + ' Automatic updates are paused in this process and no service handover was requested. ' + describeTransactionRecovery(error.receipt);
    this.lastFailureDetail = detail;
    this.recordReceipt(detail);
    this.alertOwner(detail);
    flushActivityLogSync();
  }

  /** The version a crash-loop rollback rejected, normalized, or null. Never throws into the loop. */
  private rejectedVersion(): string | null {
    try {
      const raw = this.options.rejectedVersion?.() ?? null;
      return raw === null || raw.trim().length === 0 ? null : normalizeVersion(raw);
    } catch (error) {
      // An unreadable marker must not stop the daemon from updating, the
      // failure mode of guessing "nothing is rejected" is one retry of a bad
      // release, and the failure mode of throwing is never updating again.
      logger.warn('DaemonAutoUpdater: could not read the rejected-version record; proceeding as if none stands', {
        error: summarizeError(error),
      });
      return null;
    }
  }

  /**
   * Say, once per rejected release, to the owner, that the newest release is
   * being held back because it would not start here. Once per release, not once
   * per check: this repeats hourly until a fixed release ships, and an alert
   * that fires hourly is an alert nobody reads. The daemon resumes updating on
   * its own the moment a NEWER tag appears; no owner action is required.
   */
  private reportRejectedRelease(rejected: string): void {
    if (this.reportedRejections.has(rejected)) {
      logger.info('DaemonAutoUpdater: the newest release is the one that failed to start here; still holding', {
        rejected,
        running: normalizeVersion(this.options.currentVersion),
      });
      return;
    }
    this.reportedRejections.add(rejected);
    this.alertOwner(
      `not installing v${rejected}: it was installed here, failed to start, and was rolled back automatically.`
      + ` The daemon is staying on v${normalizeVersion(this.options.currentVersion)} and will update itself`
      + ` as soon as a newer release ships. Run /update apply to force v${rejected} anyway`,
    );
  }

  /** The update targets, or null when this platform/arch publishes no assets. */
  private resolveTargets(io: UpdateFileIo): UpdateTarget[] | null {
    const files = resolveDaemonInstalledFiles({
      execPath: this.options.execPath,
      platform: this.options.platform,
      arch: this.options.arch,
      io,
    });
    const targets = files.flatMap((file) =>
      file.assetName === null
        ? []
        : [{ label: file.label, path: file.path, assetName: file.assetName, executable: file.executable }],
    );
    // The daemon binary itself must be downloadable; without it there is no
    // update to apply on this platform.
    return targets.some((target) => target.path === this.options.execPath) ? targets : null;
  }

  private async restartIntoNewBinary(handover?: PreparedServiceHandover): Promise<void> {
    // Install ownership before graceful stop begins. An external close must
    // cancel and drain this entire sequence, even while a stop hook is pending.
    // The explicitly updater-owned stop uses stop(true)/drainHandover(true).
    const abort = new AbortController();
    this.handoverAbort = abort;
    const task = Promise.resolve().then(async () => {
      if (this.handoverCancelled) {
        this.reportIncompleteHandover({ status: 'unknown', detail: 'process handover was cancelled before graceful stop started' });
        return;
      }
      try { handover?.assertCurrent(); }
      catch (error) {
        this.reportIncompleteHandover(error instanceof ServiceHandoverPreflightError ? error.outcome
          : { status: 'unknown', detail: 'Service handover support could not be confirmed before cleanup.' });
        return;
      }
      // Whatever can refuse an adoption is settled while the runtime still
      // serves; the files are already swapped, so a refusal is reported and the
      // process keeps running rather than stopping into an unrecoverable state.
      // Admission is closed first (already, since the idle check before the commit).
      this.options.workAdmission?.close(`it is restarting into v${this.appliedVersion ?? 'the installed update'}`);
      const prepared = await prepareHandoverBeforeStop(handover, abort.signal);
      if (prepared.status !== 'accepted') { this.reportIncompleteHandover(prepared); return; }
      this.runtimeStopStarted = true;
      if (!await this.stopGracefully()) return;
      await this.requestServiceHandover(abort.signal, handover);
    });
    this.handoverTask = task;
    try {
      await task;
    } finally {
      this.handoverTask = null;
      this.handoverAbort = null;
    }
  }

  private async requestServiceHandover(signal: AbortSignal, prepared?: PreparedServiceHandover): Promise<void> {
    if (this.handoverCancelled) {
      this.reportIncompleteHandover({ status: 'unknown', detail: 'process handover was cancelled before the service action started' });
      return;
    }
    const actions = this.options.serviceActions;
    let supervised: boolean;
    let outcome: void | ServiceHandoverOutcome;
    try {
      supervised = prepared?.supervised ?? actions.isSupervised();
      logger.info(supervised
        ? 'DaemonAutoUpdater: requesting restart via the service manager'
        : 'DaemonAutoUpdater: unsupervised daemon; requesting adoption into the service manager');
      // A supervised restart ends this process from outside: the manager's stop
      // of this service is the restart's first step, so an external stop from
      // here on is the handover being carried out (see stop()).
      this.restartRequested = supervised && prepared?.exitRequired !== true;
      outcome = await (prepared ? prepared.request(signal) : supervised ? actions.restartService(signal) : actions.adoptIntoService(signal));
    } catch (error) {
      if (this.stoppedByRequestedRestart) { this.recordRestartUnderway(); return; }
      // Includes rejected promises and even `throw undefined`: an exception
      // cannot be confused with a legacy action that returned no evidence.
      this.reportIncompleteHandover({ status: 'failed', detail: summarizeError(error) });
      this.incompleteAfterStop = true;
      return;
    }
    if (this.stoppedByRequestedRestart) { this.recordRestartUnderway(); return; }

    // Legacy void actions remain source-compatible, but silence is not an
    // acknowledgement. Only positive acceptance authorizes an adoption exit.
    this.handover = outcome ?? { status: 'unknown', detail: 'service action returned no handover acknowledgement' };
    if (this.handover.status !== 'accepted') {
      this.reportIncompleteHandover(this.handover);
      this.incompleteAfterStop = true;
      return;
    }
    if (this.handoverCancelled) {
      this.reportIncompleteHandover({
        status: 'unknown',
        detail: 'updater stopped while service handover was pending; the manager later accepted the request, but process handover was cancelled',
      });
      return;
    }
    logger.info('DaemonAutoUpdater: service manager accepted the handover request', {
      versionOnDisk: this.appliedVersion,
      supervised,
    });
    // An accepted handover ends this process now, supervised or not. The
    // runtime has stopped and its listener is closed; a supervised restart
    // would stop the process anyway (systemd runs the queued restart as a start
    // once the unit has exited). Idling until then is not harmless on Bun
    // 1.3.14: with the entry module's top-level await still pending
    // (products/daemon/src/cli/entrypoint.ts awaits runDaemonCli) and nothing
    // referenced left in the event loop, Bun's waitForPromise loop ticks
    // without sleeping and holds a full core until the process ends.
    // The handover record has to be on disk before this process stops being
    // one. Without it an update that goes wrong reads, in the log, as a daemon
    // that simply vanished mid-sentence.
    flushActivityLogSync();
    this.handoverExitRequested = true;
    try { (this.options.exitProcess ?? ((code: number) => process.exit(code)))(0); }
    catch {
      this.handoverExitRequested = false;
      this.reportIncompleteHandover({ status: 'failed', detail: 'The original process could not exit after the acknowledged handover.' });
      this.incompleteAfterStop = true;
    }
  }

  /**
   * The service manager stopped this process after it was asked to restart
   * it: that stop is the restart, so the handover is under way. Whatever the
   * request's own observation says (cancelled by this stop, or its client
   * ended by the same stop) is not a refusal and is not reported as one.
   */
  private recordRestartUnderway(): void {
    this.handover = { status: 'accepted', detail: 'the service manager is stopping this daemon to start the installed release' };
    logger.info('DaemonAutoUpdater: the service manager is carrying out the requested restart', { versionOnDisk: this.appliedVersion });
  }

  private reportIncompleteHandover(outcome: ServiceHandoverOutcome): void {
    this.handover = { ...outcome };
    const detail = `v${this.appliedVersion} is installed on disk, but service handover is incomplete`
      + ` (${outcome.status}${outcome.detail ? `: ${outcome.detail}` : ''}).`
      + ' No successful handover exit was requested; the previous binary is preserved.'
      + ' Automatic updates are paused in this process; inspect the service manager and restart the daemon.';
    this.recordReceipt(detail);
    this.alertOwner(detail);
    this.announce(`goodvibes daemon: ${detail}`);
    flushActivityLogSync();
  }

  private reportHandoverPreflightRefusal(error: unknown, preservedPaths: readonly string[] = []): void {
    const outcome: ServiceHandoverOutcome = error instanceof ServiceHandoverPreflightError ? error.outcome
      : { status: 'unknown', detail: 'Service handover support could not be confirmed.' };
    this.handover = outcome;
    const detail = `Automatic update refused before publication (${outcome.status}): ${outcome.detail}`
      + ' The installed files and runtime were left unchanged. Install the released suite and restart the daemon manually.'
      + (preservedPaths.length ? ` Discarded staging was preserved at: ${preservedPaths.join(', ')}` : '');
    if (this.lastHandoverPreflightRefusal === detail) return;
    this.lastHandoverPreflightRefusal = detail;
    this.lastFailureDetail = detail;
    this.recordReceipt(detail); this.alertOwner(detail);
  }

  /** Receipt persistence must not undo a completed swap or detach its handover. */
  private recordReceipt(text: string): void {
    try {
      this.writeReceipt(text);
    } catch (error) {
      logger.error(`DaemonAutoUpdater: ${text}`, {
        receiptError: summarizeError(error),
      });
    }
  }

  /** The installed update stays on disk when its original runtime cannot drain.
   * A failed stop cannot authorize another process to acquire those resources. */
  private async stopGracefully(): Promise<boolean> {
    const stop = this.options.stopGracefully;
    if (!stop) return true;
    // The stop is bounded: a teardown step that never settles (work that keeps
    // the thread busy, a wait nothing resolves) must not hold the process,
    // listener gone, until someone restarts it by hand. When the bound passes,
    // the handover is incomplete and the process owner ends this process, so
    // the service manager starts the installed release. The bound stays
    // referenced: once the listeners are closed it is what this process is
    // waiting on, and an unreferenced one would leave Bun ticking a full core
    // under the entry module's pending top-level await until it fired.
    const limitMs = Math.max(1, this.options.handoverStopDeadlineMs ?? DEFAULT_HANDOVER_STOP_DEADLINE_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = (this.options.setTimer ?? setTimeout)(() => resolve('expired'), limitMs);
    });
    const stopping = Promise.resolve().then(() => stop()).then(() => 'stopped' as const);
    try {
      if (await Promise.race([stopping, expired]) === 'stopped') return true;
      // The stop keeps running; its eventual failure is already this report.
      void stopping.catch(drainOwned);
      this.reportIncompleteHandover({ status: 'failed',
        detail: `the orderly stop did not finish within ${Math.round(limitMs / 1000)} seconds; no service handover was requested` });
      this.incompleteAfterStop = true;
      return false;
    } catch (error) {
      drainOwned(error);
      this.reportIncompleteHandover({ status: 'failed', detail: 'owned runtime cleanup did not complete; no service handover was requested' });
      this.incompleteAfterStop = true;
      return false;
    } finally {
      if (timer !== undefined) (this.options.clearTimer ?? clearTimeout)(timer);
    }
  }
}

/** `https://github.com/o/r/releases/latest` -> `https://github.com/o/r/releases/download/<tag>`. */
export function defaultDownloadBaseUrl(releasesLatestUrl: string, tag: string): string {
  const base = releasesLatestUrl.replace(/\/latest\/?$/, '');
  return `${base}/download/${tag}`;
}
