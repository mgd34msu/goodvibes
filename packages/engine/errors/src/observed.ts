// RefusalError lives in index.ts, which re-exports this file; the binding is
// read only when presentOr throws, so the cycle is safe at load.
import { RefusalError } from './index.js';
import type { Refusal } from './refusal.js';

/**
 * A value that reports the world says which it is: there, there and empty,
 * not there, could not be read, or (for input) not sent. Rules:
 *
 * 1. A function that reads storage, the network, a probe or a ledger and can
 *    fail returns `Observed<T>` (or throws). It never returns
 *    `null`/`undefined`/`[]`/`0` for a failure.
 * 2. {@link presentOr} is the only way to apply a default, and it throws on
 *    `failed`: a default never fills a failure.
 * 3. A parser of a saved record keeps a missing field `undefined` and an
 *    empty list `[]`.
 * 4. An explicit empty selection is never "all" ({@link Selection}).
 * 5. A cursor moves only over what was read ({@link Page}).
 */

/** One read of something that may not exist. Empty is a `present` value with no items, never `absent`. */
export type Observed<T> =
  | { readonly kind: 'present'; readonly value: T }
  /** Looked and nothing is there (ENOENT, 404, no row, field not sent). */
  | { readonly kind: 'absent' }
  /** Could not look: unreadable, unparseable, quarantined, timed out, evicted, refused. */
  | { readonly kind: 'failed'; readonly refusal: Refusal };

export function present<T>(value: T): Observed<T> {
  return Object.freeze({ kind: 'present' as const, value });
}

/** Looked and nothing is there. */
export const absent: Observed<never> = Object.freeze({ kind: 'absent' as const });

export function failedRead(refusal: Refusal): Observed<never> {
  return Object.freeze({ kind: 'failed' as const, refusal });
}

/** The value, or `fallback` when absent. A failed read throws {@link RefusalError}: a default never fills a failure. */
export function presentOr<T>(read: Observed<T>, fallback: T): T {
  switch (read.kind) {
    case 'present': return read.value;
    case 'absent': return fallback;
    case 'failed': throw new RefusalError(read.refusal);
    default: return assertNeverObserved(read);
  }
}

/** For a switch's default branch: a new kind is a compile error at every switch. */
export function assertNeverObserved(read: never): never {
  throw new TypeError(`Unhandled observed read: ${JSON.stringify(read)}`);
}

/**
 * A list field of a request read as a selection: not sent (the documented
 * default applies), sent empty (nothing is selected), or exactly these.
 * An explicit empty selection is never "all".
 */
export type Selection<T extends string> =
  /** Field not sent: the documented default applies. */
  | { readonly kind: 'default' }
  /** Sent as `[]`. */
  | { readonly kind: 'none' }
  | { readonly kind: 'only'; readonly values: readonly [T, ...T[]] };

/**
 * One page, oldest first after the cursor. `more` true means the reader must
 * ask again from `next`. A producer returns the oldest items after its cursor
 * (never the newest slice) and says `more`; a consumer moves its cursor only
 * to the last item it handled and loops while `more`.
 */
export interface Page<T> {
  readonly items: readonly T[];
  readonly more: boolean;
  readonly next?: string;
}
