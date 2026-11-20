/**
 * Owner fences: an effect runs only while the owner that started it still holds
 * the generation it started under.
 *
 * An owner (a job runner, a sign-in holder, a service scope) keeps a
 * {@link FenceIssuer}. Each generation of its work gets a {@link Fence} from
 * `issue()`; issuing again, or retiring the issuer (stop, dispose, sign-out),
 * makes every earlier fence stale and aborts its signal. An API that performs an
 * effect (a store write, a send, a spawn, a commit, a delivery) takes the fence
 * as its first parameter and calls `fence.check()` itself, synchronously, right
 * before the step that cannot be undone. A caller without a fence cannot call
 * it, and a late completion of a superseded generation throws at its first
 * effect instead of landing.
 *
 * Cost: `check()` is one integer compare, one `signal.aborted` read and, only
 * when the fence has a deadline, one clock read. `issue()` allocates one
 * AbortController per generation, never one per effect; `peek()` allocates
 * nothing after the first call of a generation.
 *
 * An issuer is also a {@link RevisionSource} (id = owner, revision = epoch), so
 * a step that already captures revisions can include an owner's generation in
 * the same token.
 */
import { AppError } from '../types/error-values.js';
import type { RevisionSource } from './revision.js';

/** Why an effect was refused. Stable codes for refusals and agents. */
export type FenceRefusal = 'superseded' | 'retired' | 'cancelled' | 'deadline';

const REFUSAL_TEXT: Readonly<Record<FenceRefusal, string>> = {
  superseded: 'was superseded by a newer generation of the same owner',
  retired: 'was stopped',
  cancelled: 'was cancelled',
  deadline: 'passed its deadline',
};

const REFUSAL_GUIDANCE: Readonly<Record<FenceRefusal, string>> = {
  superseded: 'The newer generation owns this work now; read its state instead of retrying this step.',
  retired: 'The owner has stopped; nothing more runs under it. Start the work again if it is still wanted.',
  cancelled: 'The work was cancelled; do not retry it unless it is asked for again.',
  deadline: 'The work ran out of time; start it again with a longer deadline if it is still wanted.',
};

/** An effect was refused because its fence is no longer current. Nothing was performed. */
export class FenceError extends AppError {
  readonly owner: string;
  readonly refusal: FenceRefusal;
  readonly heldEpoch: number;
  readonly currentEpoch: number;

  constructor(owner: string, refusal: FenceRefusal, heldEpoch: number, currentEpoch: number, cause?: unknown) {
    super(`${owner} ${REFUSAL_TEXT[refusal]} (generation ${heldEpoch}${currentEpoch !== heldEpoch ? `, now ${currentEpoch}` : ''}); the step was not performed.`, 'CONFLICT', false, {
      statusCode: 409,
      source: 'runtime',
      guidance: REFUSAL_GUIDANCE[refusal],
      ...(cause !== undefined ? { cause } : {}),
    });
    this.name = 'FenceError';
    this.owner = owner;
    this.refusal = refusal;
    this.heldEpoch = heldEpoch;
    this.currentEpoch = currentEpoch;
  }
}

/** What an effect is handed. Immutable; checking it costs one integer compare. */
export interface Fence {
  /** Names the owner in a refusal: "automation job j-12", "web sign-in". */
  readonly owner: string;
  readonly epoch: number;
  /** Aborts when the epoch moves, the issuer retires, the deadline passes, or the parent aborts. */
  readonly signal: AbortSignal;
  /** Wall-clock ms; undefined = none. */
  readonly deadline: number | undefined;
  /** Throws FenceError when the fence is no longer current. Synchronous; call right before each effect. */
  check(): void;
  readonly current: boolean;
  /** A child fence: same epoch source, tighter deadline or extra parent signal. */
  narrow(options: { readonly deadline?: number | undefined; readonly signal?: AbortSignal | undefined }): Fence;
}

/** An effect function takes the fence first; a call site without one does not type-check. */
export type FencedEffect<A extends unknown[], R> = (fence: Fence, ...args: A) => Promise<R>;

/** One generation: the epoch it holds and the controller every fence of it listens to. */
interface Generation {
  readonly epoch: number;
  readonly controller: AbortController;
  /** The plain fence of this generation, made on first `peek()`. */
  base: Fence | undefined;
}

class IssuedFence implements Fence {
  readonly owner: string;
  readonly epoch: number;
  readonly signal: AbortSignal;
  readonly deadline: number | undefined;
  readonly #issuer: FenceIssuer;
  readonly #now: () => number;

  constructor(issuer: FenceIssuer, now: () => number, epoch: number, signal: AbortSignal, deadline: number | undefined) {
    this.owner = issuer.id;
    this.epoch = epoch;
    this.signal = signal;
    this.deadline = deadline;
    this.#issuer = issuer;
    this.#now = now;
  }

  /** The refusal, or undefined while the fence is current. Same compares as `check()`. */
  #refusal(): FenceError | undefined {
    const currentEpoch = this.#issuer.epoch;
    if (currentEpoch !== this.epoch) {
      return new FenceError(this.owner, this.#issuer.retiredFrom === this.epoch ? 'retired' : 'superseded', this.epoch, currentEpoch);
    }
    if (this.signal.aborted) {
      const reason: unknown = this.signal.reason;
      return reason instanceof FenceError ? reason : new FenceError(this.owner, 'cancelled', this.epoch, currentEpoch, reason);
    }
    if (this.deadline !== undefined && this.#now() >= this.deadline) {
      return new FenceError(this.owner, 'deadline', this.epoch, currentEpoch);
    }
    return undefined;
  }

  check(): void {
    if (this.#issuer.epoch === this.epoch && !this.signal.aborted && (this.deadline === undefined || this.#now() < this.deadline)) return;
    const refusal = this.#refusal();
    if (refusal) throw refusal;
  }

  get current(): boolean {
    return this.#issuer.epoch === this.epoch && !this.signal.aborted && (this.deadline === undefined || this.#now() < this.deadline);
  }

  narrow(options: { readonly deadline?: number | undefined; readonly signal?: AbortSignal | undefined }): Fence {
    const deadline = options.deadline === undefined ? this.deadline
      : this.deadline === undefined ? options.deadline : Math.min(this.deadline, options.deadline);
    return this.#issuer.fenceFor(this.epoch, this.signal, deadline !== this.deadline ? deadline : undefined, options.signal, deadline);
  }
}

/**
 * The owner of one generation counter. Every effect started under a generation
 * holds that generation's fence; `issue()` and `retire()` make all of them stale.
 */
export class FenceIssuer implements RevisionSource {
  readonly id: string;
  readonly #now: () => number;
  #generation: Generation;
  #retired = false;
  #retiredFrom = -1;

  constructor(owner: string, options: { readonly now?: (() => number) | undefined } = {}) {
    this.id = owner;
    this.#now = options.now ?? Date.now;
    this.#generation = { epoch: 1, controller: new AbortController(), base: undefined };
  }

  get epoch(): number { return this.#generation.epoch; }
  get retired(): boolean { return this.#retired; }
  /** The epoch that `retire()` ended, or -1 while the issuer is live. */
  get retiredFrom(): number { return this.#retiredFrom; }
  /** {@link RevisionSource}: the epoch. */
  revision(): number { return this.#generation.epoch; }

  /** Bumps the epoch, so every fence issued before is stale and its signal aborts. */
  issue(options: { readonly deadline?: number | undefined; readonly parent?: AbortSignal | undefined } = {}): Fence {
    if (this.#retired) throw new FenceError(this.id, 'retired', this.#retiredFrom, this.#generation.epoch);
    this.#advance('superseded');
    const generation = this.#generation;
    if (options.deadline === undefined && options.parent === undefined) return this.#base(generation);
    return this.fenceFor(generation.epoch, generation.controller.signal, options.deadline, options.parent, options.deadline);
  }

  /** Current fence without bumping (several effects of one generation). Not current once the issuer retired. */
  peek(): Fence {
    return this.#base(this.#generation);
  }

  /** Bumps the epoch and refuses every later issue(); used by stop/dispose/sign-out. Idempotent. */
  retire(reason: string): void {
    if (this.#retired) return;
    this.#retired = true;
    this.#retiredFrom = this.#generation.epoch;
    this.#advance('retired', reason);
  }

  #base(generation: Generation): Fence {
    return generation.base ??= new IssuedFence(this, this.#now, generation.epoch, generation.controller.signal, undefined);
  }

  #advance(refusal: 'superseded' | 'retired', reason?: string): void {
    const ended = this.#generation;
    this.#generation = { epoch: ended.epoch + 1, controller: new AbortController(), base: undefined };
    const error = new FenceError(this.id, refusal, ended.epoch, ended.epoch + 1, reason);
    ended.controller.abort(error);
    // A retired issuer has no live generation: the one after it is born aborted, so peek() is never current.
    if (refusal === 'retired') this.#generation.controller.abort(new FenceError(this.id, 'retired', ended.epoch, ended.epoch + 1, reason));
  }

  /**
   * A fence of `epoch` whose signal also aborts on `parent` and at `timerDeadline`.
   * Internal to this module (used by `narrow`); `deadline` is the fence's whole deadline.
   */
  fenceFor(epoch: number, generationSignal: AbortSignal, timerDeadline: number | undefined, parent: AbortSignal | undefined, deadline: number | undefined): Fence {
    const sources: AbortSignal[] = [generationSignal];
    if (parent) sources.push(parent);
    if (timerDeadline !== undefined) {
      const timer = new AbortController();
      const left = timerDeadline - this.#now();
      if (left <= 0) timer.abort(new FenceError(this.id, 'deadline', epoch, this.#generation.epoch));
      else {
        // Whichever source ends the fence first, the timer and its listeners go.
        const forget = (): void => {
          generationSignal.removeEventListener('abort', clear);
          parent?.removeEventListener('abort', clear);
        };
        const clear = (): void => { clearTimeout(handle); forget(); };
        const handle = setTimeout(() => {
          forget();
          timer.abort(new FenceError(this.id, 'deadline', epoch, this.#generation.epoch));
        }, left);
        (handle as { unref?: () => void }).unref?.();
        generationSignal.addEventListener('abort', clear, { once: true });
        parent?.addEventListener('abort', clear, { once: true });
      }
      sources.push(timer.signal);
    }
    const signal = sources.length === 1 ? generationSignal : AbortSignal.any(sources);
    return new IssuedFence(this, this.#now, epoch, signal, deadline);
  }
}
