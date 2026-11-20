/**
 * The injected clock and random source of the inbound watcher, as things a
 * test can drive. Nothing here sleeps for real: the 27-minute IDLE re-issue
 * and the 5-minute backoff ceiling are asserted by moving a number.
 */

import type { WatcherClock } from '../../platform/src/platform/email/inbound/ports.ts';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

interface Sleeper {
  readonly at: number;
  readonly wake: () => void;
}

export class FakeClock implements WatcherClock {
  private time = 1_753_000_000_000;
  private readonly sleepers = new Set<Sleeper>();

  now(): number {
    return this.time;
  }

  /** How many waits are currently outstanding. */
  get pending(): number {
    return this.sleepers.size;
  }

  /** The shortest outstanding wait, in milliseconds from now. */
  get nextDueIn(): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const sleeper of this.sleepers) soonest = Math.min(soonest, sleeper.at - this.time);
    return soonest;
  }

  sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true || ms <= 0) {
        resolve();
        return;
      }
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        this.sleepers.delete(sleeper);
        signal?.removeEventListener('abort', settle);
        resolve();
      };
      const sleeper: Sleeper = { at: this.time + ms, wake: settle };
      this.sleepers.add(sleeper);
      signal?.addEventListener('abort', settle, { once: true });
    });
  }

  /**
   * Move time forward and wake everything that came due, oldest first. What the
   * woken code does next is the reader's to report (nextQuiet), not a pause here.
   */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let due: Sleeper | null = null;
      for (const sleeper of this.sleepers) {
        if (sleeper.at > target) continue;
        if (due === null || sleeper.at < due.at) due = sleeper;
      }
      if (due === null) break;
      this.time = Math.max(this.time, due.at);
      due.wake();
    }
    this.time = Math.max(this.time, target);
  }
}

/** A random source that hands back the same draw every time. */
export function fixedRandom(value: number): () => number {
  return () => value;
}
