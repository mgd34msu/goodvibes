/** The checkout seam selected by the native browser composition.
 *
 * service-graph.ts creates this holder before attachWsOnlyGatewayVerbHandlers,
 * which installs the seam synchronously. Native handler options then borrow
 * get() after that graph is assembled; browser engine/driver initialization
 * remains lazy. Native boot does not need to wait for a later seam callback.
 *
 * Keep the getter rather than a copied value so clearing/replacing the serving
 * browser retires previously retained checkout sources. Narrow embedders may
 * omit browser composition and leave it undefined; no receipt or request can
 * create a replacement seam. The browser disposal path clears the holder
 * before retiring its sessions. Payment execution must drain through its own
 * registration owner before a replacement graph can reuse those stores.
 */
import type { BrowserCheckoutSeam } from '@goodvibes-jev/engine/sdk/platform/control-plane';

export interface BrowserCheckoutSeamHolder {
  readonly get: () => BrowserCheckoutSeam | undefined;
  readonly set: (seam: BrowserCheckoutSeam) => void;
  /**
   * Forgets the held seam. Call this from the browser's own disposal path
   * (services.ts, registered on the SAME disposal scope the browser sessions
   * teardown runs on), so a daemon that has started shutting its browser down
   * cannot hand a checkout call a seam whose `driverFor`/`cardFieldGuard` point
   * at an engine that is being (or has been) torn down. After this, `get()`
   * returns `undefined` again, and `payments.checkout.begin`/`.fillCard` fall
   * back to their ordinary "checkout is not available right now" 409 refusal,
   * see checkout-handlers.ts, rather than reaching into a disposed engine.
   */
  readonly clear: () => void;
}

export function createBrowserCheckoutSeamHolder(): BrowserCheckoutSeamHolder {
  let seam: BrowserCheckoutSeam | undefined;
  return {
    get: () => seam,
    set: (received) => {
      seam = received;
    },
    clear: () => {
      seam = undefined;
    },
  };
}
