/**
 * device-housekeeping.ts, recovery-time and periodic garbage collection for
 * everything the paired-device feature persists.
 *
 * Two stores outlive a restart: the grants ledger (durable "always allow"
 * approvals) and the retained capture artifacts. Persistence without
 * recovery-time housekeeping does not fail loudly, it silently serves stale or
 * corrupt state forever, so both are swept on recovery AND on a timer, and
 * every sweep discloses what it removed.
 *
 * Disclosure is written to `device-housekeeping.json` beside the stores, the
 * same way the checkpoint adoption path writes `checkpoints-moved.json`: a
 * caller (or a person reading the directory) can always see what was reaped and
 * why, so a deletion is never indistinguishable from data loss.
 */
import { PersistentStore } from '../state/persistent-store.js';
import { logger } from '../utils/logger.js';
import type { DeviceGrantStore, DeviceGrantSweepReport } from './device-grants.js';
import type { DeviceArtifactDeleteResult, DeviceArtifactSweepReport, DeviceCaptureArtifactStore } from './device-capture-artifacts.js';

/** What one full pass removed, across both stores. */
export interface DeviceHousekeepingReport {
  readonly sweptAt: number;
  /** `request`: one capture the owner asked to have removed (`devices.artifacts.delete`). */
  readonly trigger: 'recovery' | 'periodic' | 'manual' | 'request';
  readonly grants: DeviceGrantSweepReport;
  readonly artifacts: DeviceArtifactSweepReport;
  /** One-line summary a surface can render without reading the itemised lists. */
  readonly summary: string;
}

interface HousekeepingLog extends Record<string, unknown> {
  readonly version: 1;
  readonly reports: readonly DeviceHousekeepingReport[];
}

/** Keep the disclosure log itself bounded, it is persisted state too. */
const MAX_DISCLOSURE_REPORTS = 20;

export type DeviceRecoveryStage = 'grant-sweep' | 'capture-sweep' | 'disclosure-read' | 'disclosure-persist';

export interface DeviceHousekeepingOptions {
  readonly grants: DeviceGrantStore;
  readonly artifacts: DeviceCaptureArtifactStore;
  /** Where the disclosure log is written. */
  readonly disclosurePath: string;
  readonly now?: (() => number) | undefined;
  /** Optional fixed observations during recovery only; never awaited. */
  readonly observeRecovery?: ((stage: DeviceRecoveryStage) => void) | undefined;
}

function summarize(grants: DeviceGrantSweepReport, artifacts: DeviceArtifactSweepReport): string {
  if (grants.removed.length === 0 && artifacts.removed.length === 0) {
    return `Device housekeeping: nothing to reap (${grants.retained} grant(s), ${artifacts.retained} capture(s) retained).`;
  }
  const grantReasons = new Map<string, number>();
  for (const removal of grants.removed) grantReasons.set(removal.reason, (grantReasons.get(removal.reason) ?? 0) + 1);
  const artifactReasons = new Map<string, number>();
  for (const removal of artifacts.removed) artifactReasons.set(removal.reason, (artifactReasons.get(removal.reason) ?? 0) + 1);
  const parts: string[] = [];
  if (grants.removed.length > 0) {
    const detail = [...grantReasons].map(([reason, count]) => `${count} ${reason}`).join(', ');
    parts.push(`${grants.removed.length} grant(s) removed (${detail})`);
  }
  if (artifacts.removed.length > 0) {
    const detail = [...artifactReasons].map(([reason, count]) => `${count} ${reason}`).join(', ');
    parts.push(`${artifacts.removed.length} capture(s) removed (${detail}), ${artifacts.bytesReclaimed} bytes reclaimed`);
  }
  return `Device housekeeping: ${parts.join('; ')}. Retained ${grants.retained} grant(s), ${artifacts.retained} capture(s).`;
}

/**
 * A sweep whose capture half could not run: the grant half ran and both are
 * disclosed under `summary`. Kept apart from a grant-sweep failure because
 * the two weigh differently at start (see `isCaptureSweepFailure`).
 */
class CaptureSweepFailure extends Error {
  readonly summary: string;

  constructor(summary: string, cause: unknown) {
    super(summary, { cause });
    this.name = 'CaptureSweepFailure';
    this.summary = summary;
  }
}

/**
 * The disclosure summary when `error` is a sweep whose capture half failed
 * after its grant half ran, else null. A capture that could not be checked
 * serves nothing stale; a grant that could not be checked might be honoured.
 */
export function captureSweepFailureSummary(error: unknown): string | null {
  return error instanceof CaptureSweepFailure ? error.summary : null;
}

/**
 * Sweeps both device stores and records the disclosure. Construct once at
 * startup, call `runRecoverySweep()` before serving any capability request, and
 * `start()` to keep sweeping on a timer.
 */
export class DeviceHousekeeper {
  private readonly grants: DeviceGrantStore;
  private readonly artifacts: DeviceCaptureArtifactStore;
  private readonly disclosure: PersistentStore<HousekeepingLog>;
  private readonly now: () => number;
  private readonly observeRecovery: DeviceHousekeepingOptions['observeRecovery'];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: DeviceHousekeepingReport | null = null;
  /** The sweep in progress, joined by a caller that arrives while it runs. */
  private inFlight: Promise<DeviceHousekeepingReport> | null = null;
  /** Set while a timer runs; re-read after each sweep to follow a live setting. */
  private resolveInterval: (() => number) | null = null;
  /** Disclosure appends in order, so a sweep and a deletion never drop each other's report. */
  private disclosureChain: Promise<void> = Promise.resolve();
  private armedIntervalMs = 0;

  constructor(options: DeviceHousekeepingOptions) {
    this.grants = options.grants;
    this.artifacts = options.artifacts;
    this.disclosure = new PersistentStore<HousekeepingLog>(options.disclosurePath);
    this.now = options.now ?? (() => Date.now());
    this.observeRecovery = options.observeRecovery;
  }

  /** The most recent report this process produced, or null before the first sweep. */
  getLastReport(): DeviceHousekeepingReport | null {
    return this.lastReport;
  }

  /** Disclosure history from disk, newest last. */
  async listDisclosures(): Promise<readonly DeviceHousekeepingReport[]> {
    const log = await this.disclosure.load();
    return Array.isArray(log?.reports) ? log.reports : [];
  }

  private observeRecoveryStage(trigger: DeviceHousekeepingReport['trigger'], stage: DeviceRecoveryStage): void {
    if (trigger !== 'recovery' || !this.observeRecovery) return;
    try { this.observeRecovery(stage); } catch { /* Observation never blocks recovery. */ }
  }

  /**
   * One full pass over both stores, with the result disclosed to disk. A call
   * made while a pass is running joins it: two overlapping passes would race on
   * the disclosure log and lose one report.
   */
  sweep(trigger: DeviceHousekeepingReport['trigger']): Promise<DeviceHousekeepingReport> {
    if (this.inFlight) return this.inFlight;
    const settled = this.runSweep(trigger).finally(() => { if (this.inFlight === settled) this.inFlight = null; });
    this.inFlight = settled;
    return settled;
  }

  private async runSweep(trigger: DeviceHousekeepingReport['trigger']): Promise<DeviceHousekeepingReport> {
    this.observeRecoveryStage(trigger, 'grant-sweep');
    const grants = await this.grants.sweep();
    this.observeRecoveryStage(trigger, 'capture-sweep');
    let artifacts: DeviceArtifactSweepReport;
    let captureFailure: unknown;
    try {
      artifacts = await this.artifacts.sweep();
    } catch (error) {
      // The grant removals already happened and are disclosed even though the
      // capture half could not run.
      captureFailure = error;
      artifacts = { sweptAt: this.now(), removed: [], retained: 0, bytesReclaimed: 0 };
    }
    const failureText = captureFailure === undefined ? '' : captureFailure instanceof Error ? captureFailure.message : String(captureFailure);
    const report: DeviceHousekeepingReport = {
      sweptAt: this.now(),
      trigger,
      grants,
      artifacts,
      summary: captureFailure === undefined
        ? summarize(grants, artifacts)
        : `${summarize(grants, artifacts)} The capture sweep did not run (${failureText}); captures were not checked.`,
    };
    this.lastReport = report;
    await this.appendDisclosure(report, () => this.observeRecoveryStage(trigger, 'disclosure-read'),
      () => this.observeRecoveryStage(trigger, 'disclosure-persist'));
    if (captureFailure !== undefined) throw new CaptureSweepFailure(report.summary, captureFailure);
    return report;
  }

  private appendDisclosure(report: DeviceHousekeepingReport, beforeRead = (): void => {}, beforePersist = (): void => {}): Promise<void> {
    const run = this.disclosureChain.then(async () => {
      beforeRead();
      const existing = await this.listDisclosures();
      beforePersist();
      await this.disclosure.persist({ version: 1, reports: [...existing, report].slice(-MAX_DISCLOSURE_REPORTS) });
    });
    this.disclosureChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Remove one retained capture because the owner asked, before its retention
   * window ends, and disclose it exactly as a sweep removal is disclosed: one
   * report in the same log, with the capture's id, device, reason and size.
   */
  async deleteCapture(artifactId: string): Promise<DeviceArtifactDeleteResult & { readonly summary?: string }> {
    const result = await this.artifacts.delete(artifactId);
    if (!result.ok) return result;
    const removal = result.removal;
    const summary = removal.reason === 'deleted'
      ? result.fileRemoved
        ? `Capture ${removal.artifactId} deleted on request (${removal.byteLength} bytes).`
        : `Capture ${removal.artifactId} removed from the retained list on request; its file could not be removed now and is removed by the next housekeeping pass.`
      : removal.reason === 'file-missing'
        ? `Capture ${removal.artifactId} had no file left on disk; its record was removed on request.`
        : `Capture ${removal.artifactId} no longer matched what was taken; its record was removed on request and the file on disk was kept for inspection.`;
    const sweptAt = this.now();
    const [grantsRetained, capturesRetained] = await Promise.all([
      this.grants.list().then(grants => grants.length, () => 0),
      this.artifacts.list().then(captures => captures.length, () => 0),
    ]);
    const report: DeviceHousekeepingReport = {
      sweptAt,
      trigger: 'request',
      grants: { sweptAt, removed: [], retained: grantsRetained, auditTrimmed: 0 },
      artifacts: { sweptAt, removed: [removal], retained: capturesRetained, bytesReclaimed: result.fileRemoved ? removal.byteLength : 0 },
      summary,
    };
    try { await this.appendDisclosure(report); }
    catch (error) {
      // The capture is already gone; a disclosure that could not be written is reported, not turned into a failed delete.
      logger.warn('Device capture deletion could not be added to the housekeeping disclosure', { artifactId, error: error instanceof Error ? error.message : String(error) });
    }
    return { ...result, summary };
  }

  /**
   * The recovery pass. Runs before any capability request is served, so a grant
   * belonging to a node that is gone, or a capture torn by a crash, is removed
   * rather than honoured on the first request after a restart.
   */
  async runRecoverySweep(): Promise<DeviceHousekeepingReport> {
    return this.sweep('recovery');
  }

  /**
   * Keep sweeping on an interval. A long-lived daemon that only swept at boot
   * would never sweep at all, so this is not optional wiring.
   *
   * Pass a resolver instead of a number to follow a live setting: the cadence is
   * re-read after every sweep and the timer re-armed when it changed, so an
   * owner who shortens `device.capture.sweepIntervalMinutes` does not have to
   * restart the daemon to get the faster sweep. A resolver that returns a
   * nonsensical cadence (zero, negative, not finite) leaves the current one in
   * place rather than stopping housekeeping altogether.
   */
  start(intervalMs: number | (() => number)): void {
    this.stop();
    this.resolveInterval = typeof intervalMs === 'function' ? intervalMs : (): number => intervalMs;
    this.arm(this.resolveInterval());
  }

  /** The cadence the live timer is running at, or null when stopped. */
  getArmedIntervalMs(): number | null {
    return this.timer ? this.armedIntervalMs : null;
  }

  private arm(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      logger.warn('Device housekeeping was not scheduled: the sweep interval is not a positive number', { intervalMs });
      return;
    }
    this.armedIntervalMs = intervalMs;
    this.timer = setInterval(() => {
      void this.sweep('periodic')
        .catch((error: unknown) => {
          // The timer callback has no caller to throw to, so the failure is logged.
          logger.warn('Periodic device housekeeping failed; expired captures and grants may not have been removed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => { this.rearmIfCadenceChanged(); });
    }, intervalMs);
    this.timer.unref?.();
  }

  /** Follow a cadence change without waiting for a restart. */
  private rearmIfCadenceChanged(): void {
    const resolver = this.resolveInterval;
    if (!this.timer || !resolver) return;
    const next = resolver();
    if (!Number.isFinite(next) || next <= 0 || next === this.armedIntervalMs) return;
    clearInterval(this.timer);
    this.timer = null;
    this.arm(next);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resolveInterval = null;
  }
}
