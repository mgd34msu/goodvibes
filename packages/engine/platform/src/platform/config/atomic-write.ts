/** Durable configuration publication uses the platform's single owned-stage
 * primitive. Source guards retain their old mkdirp/effect contract: a parent or
 * staging creation advances only directory facts, and publication advances the
 * target only after the original staged inode is visibly in place. */
import { writeFileAtomic } from '../utils/atomic-json-store.js';

export interface AtomicWriteOptions {
  /** Optional operation lifetime restriction, checked at each physical write. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Trusted owner advances its captured write target after this operation's effect. */
  readonly onEffect?: ((published?: boolean) => void) | undefined;
  /** Exact resulting permissions; defaults to owner read/write only. */
  readonly mode?: number;
  /** Create missing ordinary parents only when explicitly true. Defaults to false. */
  readonly mkdirp?: boolean;
}

/** Write exact text/binary bytes through an exclusive original temporary inode.
 * Failures before publication preserve the old destination. A failed durability
 * confirmation after rename reports published-indeterminate and never restores
 * or removes the visible destination. Foreign temporary paths are never cleaned. */
export function atomicWriteFileSync(path: string, data: string | Uint8Array, opts: AtomicWriteOptions = {}): void {
  const assertCurrent = opts.assertCurrent?.bind(opts), onEffect = opts.onEffect?.bind(opts);
  writeFileAtomic(path, data, {
    mode: opts.mode ?? 0o600, mkdirp: opts.mkdirp === true, durable: true,
    // A configuration mutation owns this publication, not other writers' GC.
    cleanupStaleTemps: false, assertCurrent, onEffect,
  });
}
