/**
 * Observe rejection from work that is already owned but cannot be accepted,
 * for example a promise returned by a required synchronous authority check.
 * The caller must still report its original refusal and retain its cancellation
 * and cleanup responsibilities. This consumes a late rejection; it does not
 * await, cancel, or convert a failed operation into success. Host errors that
 * have not already been handled must continue through their normal error path.
 * Only intrinsic Promise receivers are observed: arbitrary thenables and proxy
 * wrappers are never assimilated through their .then properties. Genuine
 * Promise constructor/@@species behavior remains the intrinsic JS behavior;
 * failure there is contained, not a promise-rejection observation guarantee.
 */
const nativeThen = Promise.prototype.then;
const nativeApply = Reflect.apply;
const discardResult = () => {};
export function drainOwned(value: unknown): void {
  try { void nativeApply(nativeThen, value, [discardResult, discardResult]); }
  catch { /* A non-Promise receiver or constructor/species failure cannot replace the refusal. */ }
}
