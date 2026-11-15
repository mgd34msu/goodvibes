/**
 * A channel that dies has to REACH the owner, not sit in a field.
 *
 * Making the reported state honest fixes the answer to a question, but nobody
 * asks that question. The lived failure was not "the status endpoint said the
 * wrong thing", it was that the owner sent a Telegram message, got nothing
 * back, and had no way to find out why without going and looking. A truthful
 * `dead` that nothing reads is the same silence with better bookkeeping.
 *
 * So this sweeps the registry, notices the transitions, and hands each one to
 * an announcer. Three properties it is built around:
 *
 * 1. It never announces over the channel that died. The dead surface is named
 *    in the alert so the announcer can exclude it; announcing a dead Telegram
 *    over Telegram is how this class of bug hides.
 * 2. It announces recoveries too. An owner who was told a channel was dead is
 *    owed the other half of that sentence, or the next alert is one they have
 *    learned to ignore.
 * 3. It repeats while a channel stays dead, on a long interval. A one-shot
 *    alert that arrives while nobody is looking has not told anyone anything.
 */
import type { ChannelHealthState, ChannelStatusSnapshot, ChannelSurface } from './types.js';
import { isChannelFailing, isChannelWorking } from './health.js';
import { logger } from '../utils/logger.js';

/** What the owner is told, and enough structure to route it sensibly. */
export interface ChannelHealthAlert {
  readonly kind: 'failed' | 'recovered' | 'still-failing';
  readonly surface: ChannelSurface;
  readonly label: string;
  readonly state: ChannelHealthState;
  readonly previousState: ChannelHealthState | null;
  /** Why, in the surface's own words, the supervisor's named reason. */
  readonly reason: string;
  /** A complete sentence fit to send as-is. */
  readonly message: string;
  /** How long it has been in this state, when known. */
  readonly failingSinceMs?: number | undefined;
}

export interface ChannelHealthWatcherDeps {
  /** The registry sweep; the same snapshots every other surface reads. */
  readonly listStatus: () => Promise<readonly ChannelStatusSnapshot[]>;
  /**
   * Deliver the alert to the owner over some channel OTHER than
   * `alert.surface`. Absent means nothing is wired, which this class refuses to
   * treat as normal, see `start()`. Resolving `false` says nothing carried it:
   * the owner was not told, so no recovery is owed and the repeat clock is not
   * reset by it; the same alert is offered again after `retryMs`. The signal
   * aborts when the announcement outlives `announceTimeoutMs` or the watcher is
   * stopped, so a delivery that never answers can be cancelled.
   */
  readonly announce?: ((alert: ChannelHealthAlert, signal?: AbortSignal) => Promise<void | boolean> | void | boolean) | undefined;
  /** How often to sweep. */
  readonly intervalMs?: number | undefined;
  /** How long a channel must stay failing before it is announced again. */
  readonly repeatMs?: number | undefined;
  /** How long to wait before offering an alert that nobody could carry again. */
  readonly retryMs?: number | undefined;
  /** How long one announcement, or one status read, may take before the sweep gives up on it. */
  readonly announceTimeoutMs?: number | undefined;
  /** Test seam. */
  readonly now?: (() => number) | undefined;
  /** Test seam: schedule a deadline; returns the function that cancels it. */
  readonly schedule?: ((fire: () => void, ms: number) => () => void) | undefined;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_REPEAT_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_ANNOUNCE_TIMEOUT_MS = 30_000;

interface TrackedState {
  readonly state: ChannelHealthState;
  readonly since: number;
  readonly lastAnnouncedAt: number | null;
  /** When an alert about this state was last offered, delivered or not; spaces the retries. */
  readonly lastAttemptAt: number | null;
  /**
   * The owner was told this channel failed and has not been told it works.
   * Carried through `unknown` and `unconfigured`, which are neither news nor
   * recovery, so the recovery notice still arrives once it actually works.
   */
  readonly owedRecovery: boolean;
}

export class ChannelHealthWatcher {
  private readonly tracked = new Map<ChannelSurface, TrackedState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false;
  private inFlight: AbortController | null = null;

  constructor(private readonly deps: ChannelHealthWatcherDeps) {}

  /**
   * Begin sweeping.
   *
   * A watcher with no announcer says so at WARN and keeps running: the state it
   * records is still worth having, but an embedder must not be able to believe
   * the owner is being told when nothing is wired to tell them. That belief is
   * precisely what shipped.
   */
  start(): void {
    if (this.timer) return;
    if (!this.deps.announce) {
      logger.warn('Channel health is being watched but no announcer is wired', {
        detail: 'a channel that dies will be recorded and logged, but nothing will reach the owner',
        action: 'pass `announce` to ChannelHealthWatcher so a dead channel is delivered over a surviving surface',
      });
    }
    const interval = this.deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timer = setInterval(() => { void this.sweep(); }, interval);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A sweep forced by a caller is cancelled too, not only the timer's own.
    this.inFlight?.abort();
  }

  /** One pass. Public so a caller can force a check without waiting a cycle. */
  async sweep(): Promise<readonly ChannelHealthAlert[]> {
    // Overlap protection: a slow sweep must not stack, or a surface that is
    // slow to answer produces duplicate alerts about itself.
    if (this.sweeping) return [];
    this.sweeping = true;
    this.inFlight = new AbortController();
    try {
      return await this.sweepOnce(this.inFlight.signal);
    } catch (error) {
      logger.warn('Channel health sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      this.inFlight = null;
      this.sweeping = false;
    }
  }

  /**
   * Settle within the deadline or reject. A status read or delivery that never
   * answers would otherwise hold `sweeping` for good and silence every later
   * alert, which is the failure this class exists to prevent.
   */
  private bounded<T>(run: (signal: AbortSignal) => Promise<T> | T, parent: AbortSignal, what: string): Promise<T> {
    const ms = this.deps.announceTimeoutMs ?? DEFAULT_ANNOUNCE_TIMEOUT_MS;
    const schedule = this.deps.schedule ?? ((fire, delay) => {
      const handle = setTimeout(fire, delay);
      (handle as unknown as { unref?: () => void }).unref?.();
      return () => clearTimeout(handle);
    });
    // A watcher that has already stopped starts nothing new.
    if (parent.aborted) return Promise.reject(new Error(`${what} was cancelled because the watcher stopped`));
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      // A stopped watcher ends the call now rather than waiting out the deadline.
      const onParentAbort = (): void => {
        controller.abort();
        reject(new Error(`${what} was cancelled because the watcher stopped`));
      };
      parent.addEventListener('abort', onParentAbort, { once: true });
      const cancel = schedule(() => {
        controller.abort();
        reject(new Error(`${what} did not finish within ${ms} ms`));
      }, ms);
      Promise.resolve()
        .then(() => run(controller.signal))
        .then(resolve, reject)
        .finally(() => {
          cancel();
          parent.removeEventListener('abort', onParentAbort);
        });
    });
  }

  private async sweepOnce(signal: AbortSignal): Promise<readonly ChannelHealthAlert[]> {
    const now = this.deps.now?.() ?? Date.now();
    const repeatMs = this.deps.repeatMs ?? DEFAULT_REPEAT_MS;
    const retryMs = this.deps.retryMs ?? DEFAULT_RETRY_MS;
    const snapshots = await this.bounded(() => this.deps.listStatus(), signal, 'Reading channel status');
    const alerts: ChannelHealthAlert[] = [];

    for (const snapshot of snapshots) {
      const previous = this.tracked.get(snapshot.surface) ?? null;
      const failing = isChannelFailing(snapshot.state);
      const changed = previous === null || previous.state !== snapshot.state;
      const since = changed ? now : previous.since;

      const alert = this.decide(snapshot, previous, failing, changed, now, since, repeatMs, retryMs);
      // Recorded before delivery so an overlapping read sees the new state; the
      // announcement fields are settled once delivery has answered.
      const tracked: TrackedState = {
        state: snapshot.state,
        since,
        lastAnnouncedAt: changed ? null : previous?.lastAnnouncedAt ?? null,
        lastAttemptAt: changed ? null : previous?.lastAttemptAt ?? null,
        // An owner who switched the channel off is not owed a recovery notice.
        owedRecovery: snapshot.state !== 'disabled' && (previous?.owedRecovery ?? false),
      };
      this.tracked.set(snapshot.surface, tracked);
      if (alert) alerts.push(alert);
    }

    for (const alert of alerts) {
      if (signal.aborted) break;
      const delivered = await this.emit(alert, signal);
      const tracked = this.tracked.get(alert.surface);
      if (!tracked) continue;
      if (!delivered) {
        this.tracked.set(alert.surface, { ...tracked, lastAttemptAt: now });
        continue;
      }
      this.tracked.set(alert.surface, {
        ...tracked,
        lastAnnouncedAt: now,
        lastAttemptAt: now,
        owedRecovery: alert.kind !== 'recovered',
      });
    }
    return alerts;
  }

  private decide(
    snapshot: ChannelStatusSnapshot,
    previous: TrackedState | null,
    failing: boolean,
    changed: boolean,
    now: number,
    since: number,
    repeatMs: number,
    retryMs: number,
  ): ChannelHealthAlert | null {
    // An alert nobody could carry is offered again on a short spacing, not
    // after the long repeat interval and not on every sweep. With no announcer
    // wired there is nothing to retry.
    const retryDue = !changed && this.deps.announce !== undefined
      && (previous?.lastAttemptAt == null
        || previous.lastAttemptAt === previous.lastAnnouncedAt
        || now - previous.lastAttemptAt >= retryMs);
    // A degraded surface's own reason is its healthy sentence ("the connection
    // is open"); what is wrong is in lastError.
    const reason = (failing ? snapshot.runtime?.lastError : undefined)
      ?? snapshot.runtime?.reason ?? 'no reason was reported by this surface';
    const base = {
      surface: snapshot.surface,
      label: snapshot.label,
      state: snapshot.state,
      previousState: previous?.state ?? null,
      reason,
    } as const;

    if (failing && changed) {
      return {
        ...base,
        kind: 'failed',
        message: `${snapshot.label} is not working: ${reason}`,
      };
    }
    if (failing && retryDue && previous?.lastAnnouncedAt === null) {
      return {
        ...base,
        kind: 'failed',
        message: `${snapshot.label} is not working: ${reason}`,
      };
    }
    if (failing && retryDue && (now - (previous?.lastAnnouncedAt ?? since)) >= repeatMs) {
      return {
        ...base,
        kind: 'still-failing',
        message: `${snapshot.label} is still not working after ${describeDuration(now - since)}: ${reason}`,
        failingSinceMs: now - since,
      };
    }
    // Only a channel the owner was TOLD about is owed a recovery notice, and
    // only once it is confirmed working: switched off or merely unwatched is
    // not "working again".
    if (isChannelWorking(snapshot.state) && previous?.owedRecovery && (changed || retryDue)) {
      return {
        ...base,
        kind: 'recovered',
        message: `${snapshot.label} is working again: ${reason}`,
      };
    }
    return null;
  }

  /** Returns whether the owner was actually told. */
  private async emit(alert: ChannelHealthAlert, signal: AbortSignal): Promise<boolean> {
    // Logged at ERROR regardless of whether an announcer exists, because the
    // daemon log is the one place this is guaranteed to be recoverable after
    // the fact, and a channel going dead is the most expensive state the
    // system can be in without saying anything.
    if (alert.kind === 'recovered') {
      logger.info('Channel recovered', { surface: alert.surface, detail: alert.message });
    } else {
      logger.error('Channel is not working', {
        surface: alert.surface,
        state: alert.state,
        detail: alert.message,
        reason: alert.reason,
      });
    }
    if (!this.deps.announce) return false;
    try {
      const announce = this.deps.announce;
      return (await this.bounded((aborter) => announce(alert, aborter), signal, 'Announcing the channel change')) !== false;
    } catch (error) {
      // The announcement failing is itself news: it means the owner was NOT
      // told, and the log line above is now the only record.
      logger.error('Could not tell the owner that a channel changed state', {
        surface: alert.surface,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

function describeDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
