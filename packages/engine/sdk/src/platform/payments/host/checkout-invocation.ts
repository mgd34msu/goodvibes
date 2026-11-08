import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import { HandlerError, type HandlerContextEnvelope } from './handler-plumbing.js';
import type { PaymentsHandlerDeps } from './register.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';
import { retainTaintEvidence } from '../../security/untrusted-content.js';
import type { PaymentsServiceConfig } from '../payments-gateway-service.js';
import type { NativePairedSnapshot } from '../../security/http-auth.js';
import { paymentContinuationBinding } from './continuation-binding.js';

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
  if (!native || !native.issueContinuation || !native.revokeContinuation || !authorized || !paired || paired.kind !== 'pairing-token' || !context.admin || context.principalKind !== 'token'
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
  const issue = native.issueContinuation?.bind(native), revoke = native.revokeContinuation?.bind(native);
  if (!issue || !revoke) throw new HandlerError('The paired host cannot retain checkout continuation authority.', 'FAILED_PRECONDITION', 409);
  // The dispatcher starts the owner turn before this handler. Include the
  // immediately displaced window, then keep these exact facts across later
  // requests and async card/address preflight. Never recapture at execution.
  const taintEvidence = retainTaintEvidence(deps.checkout.untrusted, 'since-last-boundary');
  const principalId = paired.principalId;
  const assertCurrent = () => {
    try {
      if (authorized(['write:payments']) !== true || deps.checkout.seam() !== seam || !deps.isPaymentsLeader()
        || !readPaymentsEnabled(deps.config) || !isDeepStrictEqual(captureOwnedJson(native.current()), expected)
        || !isDeepStrictEqual(captureOwnedJson(readPaymentsServiceConfig(deps.config)), config)) throw new Error();
    } catch { throw new HandlerError('The original paired checkout owner, payment settings or browser changed. Inspect this purchase before trying again.', 'FAILED_PRECONDITION', 409); }
  };
  assertCurrent();
  return Object.freeze({ principalId, assertCurrent, taintEvidence,
    issueContinuation(operationId: string, admissionCurrent: () => void) {
      const binding = paymentContinuationBinding(operationId);
      const current = () => { assertCurrent(); admissionCurrent(); };
      current(); const grant = issue(binding, current, binding);
      try { current(); return grant; }
      catch (error) { revoke(grant); throw error; }
    },
    revokeContinuation: revoke,
    recoveryFacts: Object.freeze({ authority: expected as NativePairedSnapshot, configuration: config as PaymentsServiceConfig }) });
}
