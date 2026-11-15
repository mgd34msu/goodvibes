import { scheduleBackground } from '../cooperative.js';

/**
 * One resumable unit of background work for a space: one source to enrich, one
 * answer's device pages, one improvement round. A unit checks `shouldYield`
 * at its own boundaries; returning `'yielded'` puts it back at the front of
 * the queue so it continues, instead of restarting, once the space is idle.
 */
export interface HomeGraphBackgroundItem {
  /** Equal keys are one item: queueing it again while it waits changes nothing. */
  readonly key: string;
  run(signal: AbortSignal, shouldYield: () => boolean): Promise<'done' | 'yielded' | void>;
}

interface SpaceLanes {
  foreground: number;
  readonly pending: Map<string, HomeGraphBackgroundItem>;
  running?: { readonly key: string; readonly controller: AbortController; readonly run: Promise<void> } | undefined;
  scheduled: boolean;
  /** Items waiting out a delay, by key, and the pause re-check. */
  readonly timers: Map<string, ReturnType<typeof setTimeout>>;
}

const PAUSE_RECHECK = '\u0000pause';

/**
 * The one record of what a Home Graph space is doing. Two lanes per space:
 * foreground verbs (anything that writes, and anything the caller waits for)
 * and background items. Background work starts only while no foreground verb
 * is active; a running item is asked to yield when one starts and is never
 * aborted for it, so a long enrichment finishes across many questions instead
 * of restarting after each one.
 */
export class HomeGraphSpaceWork {
  readonly #spaces = new Map<string, SpaceLanes>();

  constructor(private readonly options: {
    readonly signal: AbortSignal;
    /** True while background knowledge work is paused for memory pressure; items wait. */
    readonly paused?: (() => boolean) | undefined;
    readonly report: (event: string, error: unknown, metadata: Record<string, unknown>) => void;
  }) {}

  /** Marks a foreground verb on the space until the returned release runs. */
  enterForeground(spaceId: string): () => void {
    const lanes = this.#lanes(spaceId);
    lanes.foreground += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      lanes.foreground -= 1;
      if (lanes.foreground === 0) this.#schedule(spaceId);
    };
  }

  isForeground(spaceId: string): boolean {
    return (this.#spaces.get(spaceId)?.foreground ?? 0) > 0;
  }

  /** Waits for the background item running in the space to reach its next boundary. */
  async settleRunning(spaceId: string): Promise<void> {
    await this.#spaces.get(spaceId)?.running?.run;
  }

  /** Queues a background item; it starts when the space has no foreground verb. */
  enqueue(spaceId: string, item: HomeGraphBackgroundItem, delayMs = 0): void {
    if (this.options.signal.aborted) return;
    const lanes = this.#lanes(spaceId);
    if (delayMs > 0) {
      if (lanes.timers.has(item.key)) return;
      lanes.timers.set(item.key, scheduleBackground(() => {
        lanes.timers.delete(item.key);
        this.enqueue(spaceId, item);
      }, delayMs, this.options.signal));
      return;
    }
    // A key already running is queued once more: what it read may have changed since it started.
    if (lanes.pending.has(item.key)) return;
    lanes.pending.set(item.key, item);
    this.#schedule(spaceId);
  }

  has(spaceId: string, key: string): boolean {
    const lanes = this.#spaces.get(spaceId);
    return lanes !== undefined && (lanes.running?.key === key || lanes.pending.has(key) || lanes.timers.has(key));
  }

  /** Drops the space's waiting items, stops the running one and waits for it. */
  async cancel(spaceId?: string): Promise<void> {
    const entries = spaceId === undefined ? [...this.#spaces.values()] : [this.#spaces.get(spaceId)].filter((lanes): lanes is SpaceLanes => Boolean(lanes));
    const runs: Promise<void>[] = [];
    for (const lanes of entries) {
      lanes.pending.clear();
      for (const timer of lanes.timers.values()) clearTimeout(timer);
      lanes.timers.clear();
      if (lanes.running) { lanes.running.controller.abort(); runs.push(lanes.running.run); }
    }
    await Promise.all(runs);
  }

  /** Every background item still running, for disposal. */
  runningItems(): Promise<void>[] {
    return [...this.#spaces.values()].flatMap((lanes) => lanes.running ? [lanes.running.run] : []);
  }

  #lanes(spaceId: string): SpaceLanes {
    let lanes = this.#spaces.get(spaceId);
    if (!lanes) {
      lanes = { foreground: 0, pending: new Map(), scheduled: false, timers: new Map() };
      this.#spaces.set(spaceId, lanes);
    }
    return lanes;
  }

  #schedule(spaceId: string): void {
    const lanes = this.#spaces.get(spaceId);
    if (!lanes || lanes.scheduled || lanes.running || lanes.foreground > 0 || lanes.pending.size === 0 || this.options.signal.aborted) return;
    lanes.scheduled = true;
    scheduleBackground(() => {
      lanes.scheduled = false;
      this.#start(spaceId, lanes);
    }, 0, this.options.signal);
  }

  #start(spaceId: string, lanes: SpaceLanes): void {
    if (lanes.running || lanes.foreground > 0 || this.options.signal.aborted) return;
    if (this.options.paused?.()) {
      // Paused for memory pressure: keep the items and look again later.
      if (!lanes.timers.has(PAUSE_RECHECK)) {
        lanes.timers.set(PAUSE_RECHECK, scheduleBackground(() => { lanes.timers.delete(PAUSE_RECHECK); this.#schedule(spaceId); }, 30_000, this.options.signal));
      }
      return;
    }
    const next = lanes.pending.entries().next();
    if (next.done) return;
    const [key, item] = next.value;
    lanes.pending.delete(key);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.options.signal]);
    const run = Promise.resolve().then(() => item.run(signal, () => lanes.foreground > 0)).then((outcome) => {
      if (outcome === 'yielded' && !signal.aborted) {
        // Resume first: put it back ahead of anything queued meanwhile.
        const rest = [...lanes.pending.entries()];
        lanes.pending.clear();
        lanes.pending.set(key, item);
        for (const [restKey, restItem] of rest) if (restKey !== key) lanes.pending.set(restKey, restItem);
      }
    }, (error: unknown) => {
      if (!signal.aborted) this.options.report('homegraph-background', error, { spaceId, item: key });
    }).finally(() => {
      if (lanes.running?.run === run) lanes.running = undefined;
      if (lanes.foreground === 0 && lanes.pending.size === 0 && lanes.timers.size === 0) this.#spaces.delete(spaceId);
      else this.#schedule(spaceId);
    });
    lanes.running = { key, controller, run };
  }
}
