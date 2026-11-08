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

/** Explicit handoff to a daemon-owned operation. Only the paired authority and
 * copied host facts cross this factory scope; the request/context/signal do not.
 * The initiating request must still be current at durable admission. */
export function retainDetachedCheckout(deps: PaymentsHandlerDeps, seam: BrowserCheckoutSeam, context: HandlerContextEnvelope) {
  const native = context.nativeExecutionAuthority, authorized = context.isAuthorized;
  const paired = native?.current();
  if (!native || !authorized || !paired || paired.kind !== 'pairing-token' || !context.admin || context.principalKind !== 'token'
    || !context.explicitUserRequest || context.principalId !== paired.principalId
    || !(context.scopes.includes('*') || context.scopes.includes('write:payments'))
    || !(paired.scopes.includes('*') || paired.scopes.includes('write:payments'))
    || authorized?.(['write:payments']) !== true) {
    throw new HandlerError('Checkout admission requires an explicit request from the current paired administrative owner with write:payments.', 'FORBIDDEN', 403);
  }
  return detachedSource(deps, seam, native, authorized, paired);
}

function detachedSource(deps: PaymentsHandlerDeps, seam: BrowserCheckoutSeam,
  native: NonNullable<HandlerContextEnvelope['nativeExecutionAuthority']>, authorized: NonNullable<HandlerContextEnvelope['isAuthorized']>,
  paired: NonNullable<ReturnType<NonNullable<HandlerContextEnvelope['nativeExecutionAuthority']>['current']>>) {
  const expected = captureOwnedJson(paired), config = captureOwnedJson(readPaymentsServiceConfig(deps.config));
  const principalId = paired.principalId;
  const assertCurrent = () => {
    try {
      if (authorized(['write:payments']) !== true || deps.checkout.seam() !== seam || !deps.isPaymentsLeader()
        || !readPaymentsEnabled(deps.config) || !isDeepStrictEqual(captureOwnedJson(native.current()), expected)
        || !isDeepStrictEqual(captureOwnedJson(readPaymentsServiceConfig(deps.config)), config)) throw new Error();
    } catch { throw new HandlerError('The original paired checkout owner, payment settings or browser changed. Inspect this purchase before trying again.', 'FAILED_PRECONDITION', 409); }
  };
  assertCurrent();
  return Object.freeze({ principalId, assertCurrent });
}
