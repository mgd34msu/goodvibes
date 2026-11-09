import { drainOwned } from '@goodvibes-jev/judgment/decisions';

/** Restricts already authorized checkout work; it cannot grant a purchase. */
export interface CheckoutOperationOwnership {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}
export class CheckoutOwnershipError extends Error {
  override readonly name = 'CheckoutOwnershipError';
  constructor() { super('The original checkout owner is no longer current. Inspect the purchase before retrying.'); }
}

/** Keep the original signal and synchronous guard, including when a borrowed
 * options object is later edited. Never retain an async guard as authority. */
export function captureCheckoutOwnership(options: CheckoutOperationOwnership = {}) {
  const signal = options.signal, assertion = options.assertCurrent;
  const assertCurrent = (): void => {
    signal?.throwIfAborted();
    try {
      const result: unknown = assertion?.();
      if (result !== undefined) { drainOwned(result); throw new CheckoutOwnershipError(); }
    } catch (error) { drainOwned(error); throw new CheckoutOwnershipError(); }
    signal?.throwIfAborted();
  };
  assertCurrent();
  return Object.freeze({ signal, assertCurrent });
}
