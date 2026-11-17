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

/** Let pending microtasks and I/O callbacks run. */
export async function flush(times = 3): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
}

/**
 * Let the event loop turn until `predicate` holds, bounded in turns, never in
 * milliseconds.
 *
 * The fake IMAP server is a real loopback socket, so "the watcher has received
 * the response" is genuinely asynchronous; each turn lets the sockets deliver.
 * Everything with a duration in it runs on the fake clock instead. A condition
 * that never holds fails by name once the turns run out.
 */
export async function waitFor(
  predicate: () => boolean,
  what: string,
  turns = 40_000,
): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  if (!predicate()) throw new Error(`Gave up after ${turns} event-loop turns waiting for: ${what}`);
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

  /** Move time forward and wake everything that came due, oldest first. */
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
      await flush(2);
    }
    this.time = Math.max(this.time, target);
    await flush(2);
  }

  /** Wait, in real time, until at least `count` waits are outstanding. */
  async waitForSleepers(count = 1, what = 'a scheduled wait'): Promise<void> {
    await waitFor(() => this.sleepers.size >= count, what);
  }

  /**
   * Wait until a wait shorter than `maxMs` is outstanding.
   *
   * Distinguishing a short wait from a long one matters: the IDLE re-issue
   * timer is armed for twenty-seven minutes and is almost always pending, so
   * "some wait exists" is true before the backoff a test is actually waiting
   * for has been armed, and advancing past a wait that has not been created
   * yet leaves the test hanging on a timer that will never come due.
   */
  async waitForDue(maxMs: number, what = 'a short scheduled wait'): Promise<void> {
    await waitFor(() => this.sleepers.size > 0 && this.nextDueIn <= maxMs, what);
  }
}

/** A random source that hands back the same draw every time. */
export function fixedRandom(value: number): () => number {
  return () => value;
}
