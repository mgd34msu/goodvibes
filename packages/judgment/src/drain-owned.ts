/**
 * Observe rejection from work that is already owned but cannot be accepted,
 * for example a promise returned by a required synchronous authority check.
 * The caller must still report its original refusal and retain its cancellation
 * and cleanup responsibilities. This consumes a late rejection; it does not
 * await, cancel, or convert a failed operation into success. Host errors that
 * have not already been handled must continue through their normal error path.
 */
export function drainOwned(value: unknown): void {
  try { void Promise.resolve(value).catch(() => {}); }
  catch { /* A hostile then/catch accessor must not replace the caller's refusal. */ }
}
