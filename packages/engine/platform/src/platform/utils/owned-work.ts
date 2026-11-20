/**
 * The work an owner started, held until it ends, with an honest close report.
 *
 * A service holds its runs, children and pending opens only through its scope.
 * `close()` is the only way to stop it: it closes admission, retires the scope's
 * fence (so every effect still running under it is refused at its next
 * `check()` and its signal aborts), asks children to stop, waits up to the stop
 * deadline, kills what is left, and reports. A caller surfaces `stillRunning`
 * instead of saying "stopped": the report never claims an end it did not see.
 *
 * Tracking actual asynchronous work is independent of outward status or abort.
 * Reservation happens before invoking the callback, so a synchronous event or
 * abort listener can re-enter `join` without overlooking work being admitted.
 *
 * Cost: one Set add and delete per run, one exit listener per child; no I/O.
 */
import { FenceError, FenceIssuer, type Fence } from './owner-fence.js';

/** A child process an owner started. `exited` settles once its exit is observed. */
export interface ChildHandle {
  readonly pid?: number | undefined;
  kill(signal?: NodeJS.Signals | number): void;
  readonly exited: Promise<unknown>;
}

/** What `close()` saw. */
export interface CloseReport {
  /** Labels that ended inside the deadline. */
  readonly stopped: readonly string[];
  /** Children that needed SIGKILL (and whose exit was then observed). */
  readonly killed: readonly string[];
  /** Not confirmed ended; the caller must say so. */
  readonly stillRunning: readonly { readonly label: string; readonly pid?: number | undefined }[];
}

export interface OwnedScopeOptions {
  /** How long close() waits for runs, opens and children after asking them to stop. Default 5 s. */
  readonly stopDeadlineMs?: number | undefined;
  /** How long close() waits for a child after SIGKILL. Default 2 s. */
  readonly killGraceMs?: number | undefined;
  /** Clock for the scope fence's deadlines. */
  readonly now?: (() => number) | undefined;
}

interface Owned {
  readonly label: string;
  readonly settled: Promise<void>;
  readonly child?: ChildHandle | undefined;
  done: boolean;
}

const DEFAULT_STOP_DEADLINE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

function wait(ms: number): { readonly promise: Promise<void>; cancel(): void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>(resolve => { handle = setTimeout(resolve, Math.max(0, ms)); });
  return { promise, cancel: () => clearTimeout(handle) };
}

export class OwnedScope {
  readonly name: string;
  /** One generation for the scope's life; close() retires it. */
  readonly fence: Fence;
  readonly #issuer: FenceIssuer;
  readonly #owned = new Set<Owned>();
  readonly #stopDeadlineMs: number;
  readonly #killGraceMs: number;
  #closing: Promise<CloseReport> | undefined;

  constructor(name: string, options: OwnedScopeOptions = {}) {
    this.name = name;
    this.#issuer = new FenceIssuer(name, { now: options.now });
    this.fence = this.#issuer.peek();
    this.#stopDeadlineMs = options.stopDeadlineMs ?? DEFAULT_STOP_DEADLINE_MS;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  }

  get closed(): boolean { return this.#closing !== undefined; }

  /** True only once every admitted run, open and child has actually ended. */
  get idle(): boolean { return this.#owned.size === 0; }

  #refused(): FenceError {
    return new FenceError(this.name, 'retired', this.fence.epoch, this.#issuer.epoch);
  }

  #track(label: string, settled: Promise<unknown>, child?: ChildHandle): Owned {
    let release!: () => void;
    const entry: Owned = { label, settled: new Promise<void>(resolve => { release = resolve; }), child, done: false };
    this.#owned.add(entry);
    const finish = (): void => {
      entry.done = true;
      this.#owned.delete(entry);
      release();
    };
    // Observe both paths without changing the result (or leaving an unhandled
    // rejection). join and close are cleanup barriers, not error results.
    void settled.then(finish, finish);
    return entry;
  }

  /** Admit async work. Refused (FenceError 'retired') after close. The callback gets the scope fence. */
  run<T>(label: string, work: (fence: Fence) => T | PromiseLike<T>): Promise<T> {
    if (this.closed) return Promise.reject(this.#refused());
    let release!: () => void;
    const reserved = new Promise<void>(resolve => { release = resolve; });
    // Reserved before the callback runs, so a synchronous re-entry of join sees it.
    this.#track(label, reserved);
    let result: Promise<T>;
    try {
      result = Promise.resolve(work(this.fence));
    } catch (error) {
      result = Promise.reject(error);
    }
    void result.then(release, release);
    return result;
  }

  /** Own a child process until its exit is observed. close(): SIGTERM, wait, SIGKILL, wait. */
  child(label: string, child: ChildHandle): ChildHandle {
    if (this.closed) {
      // Never adopted: stop it at once, as close() would have.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      throw this.#refused();
    }
    this.#track(label, child.exited, child);
    return child;
  }

  /** Own an open still in flight. A value that arrives after close is disposed, never adopted. */
  opening<T>(label: string, open: (signal: AbortSignal) => Promise<T>, dispose: (value: T) => void | Promise<void>): Promise<T> {
    return this.run(label, async fence => {
      const value = await open(fence.signal);
      if (fence.current) return value;
      await dispose(value);
      throw this.#refused();
    });
  }

  /**
   * Wait until every admitted run, open and child has ended, including work
   * admitted while waiting. For an owner that closes its own admission and
   * needs a drain barrier; it does not stop anything.
   */
  async join(): Promise<void> {
    while (this.#owned.size > 0) await Promise.all([...this.#owned].map(entry => entry.settled));
  }

  /** Close admission, retire the fence, abort, join with the deadline, report. Idempotent; later calls return the same report. */
  close(reason: string): Promise<CloseReport> {
    return this.#closing ??= this.#close(reason);
  }

  async #close(reason: string): Promise<CloseReport> {
    // Admission is closed by #closing being set; retiring aborts the scope signal.
    this.#issuer.retire(reason);
    const killed: string[] = [];
    const killedSet = new Set<Owned>();
    const watched = [...this.#owned];
    for (const entry of watched) {
      if (entry.child) { try { entry.child.kill('SIGTERM'); } catch { /* already gone */ } }
    }
    const remaining = (): Owned[] => watched.filter(entry => !entry.done);
    if (remaining().length > 0) {
      const deadline = wait(this.#stopDeadlineMs);
      await Promise.race([Promise.all(watched.map(entry => entry.settled)), deadline.promise]);
      deadline.cancel();
    }
    const children = remaining().filter(entry => entry.child);
    if (children.length > 0) {
      for (const entry of children) {
        killedSet.add(entry);
        try { entry.child!.kill('SIGKILL'); } catch { /* already gone */ }
      }
      const grace = wait(this.#killGraceMs);
      await Promise.race([Promise.all(children.map(entry => entry.settled)), grace.promise]);
      grace.cancel();
      for (const entry of children) if (entry.done) killed.push(entry.label);
    }
    return Object.freeze({
      stopped: Object.freeze(watched.filter(entry => entry.done && !killedSet.has(entry)).map(entry => entry.label)),
      killed: Object.freeze(killed),
      stillRunning: Object.freeze(remaining().map(entry => Object.freeze(
        entry.child?.pid !== undefined ? { label: entry.label, pid: entry.child.pid } : { label: entry.label },
      ))),
    });
  }
}
