import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import { HandlerError, type HandlerContextEnvelope } from './handler-plumbing.js';
import type { PaymentsHandlerDeps } from './register.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';

function frame(context: HandlerContextEnvelope) {
  return { principalId: context.principalId, principalKind: context.principalKind, admin: context.admin,
    scopes: [...context.scopes], explicitUserRequest: context.explicitUserRequest, authToken: context.authToken };
}

/** Restriction from the real transport and selected daemon composition. The
 * bearer and all private observations stay local; no request field can mint it.
 * This currently retains the request's signal. Detached operation admission
 * must supply its own durable owner rather than dropping this restriction.
 */
export function retainCheckoutInvocation(deps: PaymentsHandlerDeps, seam: BrowserCheckoutSeam, context: HandlerContextEnvelope) {
  const signal = context.signal, authorized = context.isAuthorized, native = context.nativeExecutionAuthority;
  const changed = () => new HandlerError('The original checkout authority, payment settings or browser owner changed. Inspect the purchase before retrying.', 'FAILED_PRECONDITION', 409);
  let original: unknown, paired: unknown, config: unknown;
  try {
    original = captureOwnedJson(frame(context));
    paired = captureOwnedJson(native?.current());
    config = captureOwnedJson(readPaymentsServiceConfig(deps.config));
  } catch { throw changed(); }
  const assertCurrent = (): void => {
    try {
      signal?.throwIfAborted();
      if (context.signal !== signal || context.isAuthorized !== authorized || context.nativeExecutionAuthority !== native
        || !isDeepStrictEqual(captureOwnedJson(frame(context)), original) || !context.principalId
        || !(context.scopes.includes('*') || context.scopes.includes('write:payments'))
        || authorized?.(['write:payments']) !== true || deps.checkout.seam() !== seam
        || !readPaymentsEnabled(deps.config) || !deps.isPaymentsLeader()
        || !isDeepStrictEqual(captureOwnedJson(readPaymentsServiceConfig(deps.config)), config)
        || !isDeepStrictEqual(captureOwnedJson(native?.current()), paired)) throw new Error();
      signal?.throwIfAborted();
    } catch { throw changed(); }
  };
  assertCurrent();
  return Object.freeze({ signal, assertCurrent });
}
