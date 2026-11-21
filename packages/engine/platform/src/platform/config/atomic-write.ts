/** The durable writer, for files whose loss matters: the file and its own
 * parent directory are synced before success. Three levels, one primitive
 * (`utils/atomic-json-store.ts`):
 *   1. replace: `writeFileAtomic(path, data)`, `writeJsonFileAtomic` without
 *      `durable`, or `writeDocument` from utils: temp file plus rename, no
 *      directory sync. Enough for history, view state, markers and drafts,
 *      which must never be torn but may lose the newest write to a power cut.
 *   2. durable: this function for bytes, or `writeJsonFileAtomic(path, value,
 *      { durable: true })` for JSON. Settings files (the config manager's
 *      tiers, the shared tier, the settings control-plane store), the secret
 *      stores, OAuth sign-ins (subscriptions), daemon settings, ledgers and
 *      offsets are written at this level.
 *   3. guarded: pass `assertCurrent`/`onEffect` at either level; the guard and
 *      the parent's identity are checked once, just before the rename.
 * No level walks or syncs directories above the file's parent. */
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
