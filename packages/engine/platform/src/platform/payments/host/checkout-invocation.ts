import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { readPaymentsEnabled, readPaymentsServiceConfig } from '../payments-config.js';
import type { HandlerContextEnvelope } from '../../control-plane/host-handlers.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import { nativeIdentityIsCaller } from '../../control-plane/routes/native-owner.js';
import type { PaymentsHandlerDeps } from './register.js';
import type { BrowserCheckoutSeam } from '../../control-plane/routes/browser-composition.js';
import { retainTaintEvidence } from '../../security/untrusted-content.js';
import type { PaymentsServiceConfig } from '../payments-gateway-service.js';
import type { NativePairedSnapshot } from '../../security/http-auth.js';
import { paymentContinuationBinding } from './continuation-binding.js';
import { BrowserPageConnectionError } from '../../browser/browser-page-connection-data.js';
import type { BeginCheckoutInput } from '../payments-gateway-service.js';
import type { DetachedCheckoutOwner } from './checkout-operations.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';

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
  const changed = () => new GatewayVerbError('The original checkout authority, payment settings or browser owner changed. Inspect the purchase before retrying.', 'FAILED_PRECONDITION', 409);
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
        || missingScopes(context.scopes, ['write:payments']).length > 0
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
 * The initiating request must still be current at durable admission.
 *
 * `ownerRequest: false` is a begin under the owner's standing authorisation
 * (standing-store.ts): it is made by a scheduled or triggered run, so it needs
 * no explicit request in the moment, and the entry it names is checked at
 * admission instead. Every other requirement, the paired administrative
 * principal with write:payments and continuation authority, still holds. */
export function retainDetachedCheckout(deps: PaymentsHandlerDeps, seam: BrowserCheckoutSeam, context: HandlerContextEnvelope,
  options: { readonly ownerRequest: boolean } = { ownerRequest: true }) {
  const native = context.nativeExecutionAuthority, authorized = context.isAuthorized;
  const paired = native?.current();
  // A paired device, or an app on the owner's own machine with the operator
  // token (native kind 'local', established by the transport from a loopback
  // request): no pairing on the owner's own machine. The operator token from
  // elsewhere has no native authority, so it never reaches here.
  if (!native || !native.issueContinuation || !native.revokeContinuation || !authorized || !paired
    || !context.admin || !nativeIdentityIsCaller(context, paired)
    || (options.ownerRequest && !context.explicitUserRequest)
    || missingScopes(context.scopes, ['write:payments']).length > 0
    || missingScopes(paired.scopes, ['write:payments']).length > 0
    || authorized?.(['write:payments']) !== true) {
    throw new GatewayVerbError(options.ownerRequest
      ? 'Checkout admission requires an explicit request from the owner (an app on the daemon\'s own machine, or a paired device) '
        + 'with admin and write:payments. '
        + 'A purchase a schedule or trigger starts names the owner\'s standing authorisation instead (standingId from payments.standing.list).'
      : 'Checkout admission under a standing authorisation requires the owner\'s own machine or a paired administrative principal with write:payments.', 'FORBIDDEN', 403);
  }
  return detachedSource(deps, seam, native, authorized, paired);
}

function detachedSource(deps: PaymentsHandlerDeps, seam: BrowserCheckoutSeam,
  native: NonNullable<HandlerContextEnvelope['nativeExecutionAuthority']>, authorized: NonNullable<HandlerContextEnvelope['isAuthorized']>,
  paired: NonNullable<ReturnType<NonNullable<HandlerContextEnvelope['nativeExecutionAuthority']>['current']>>) {
  const expected = captureOwnedJson(paired), config = captureOwnedJson(readPaymentsServiceConfig(deps.config));
  const issue = native.issueContinuation?.bind(native), revoke = native.revokeContinuation?.bind(native);
  const capturePage = seam.capturePageConnection?.bind(seam);
  const captureRecovery = seam.captureCheckoutRecovery?.bind(seam);
  if (!issue || !revoke) throw new GatewayVerbError('The paired host cannot retain checkout continuation authority.', 'FAILED_PRECONDITION', 409);
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
    } catch { throw new GatewayVerbError('The original paired checkout owner, payment settings or browser changed. Inspect this purchase before trying again.', 'FAILED_PRECONDITION', 409); }
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
    ...(captureRecovery ? { captureBrowserRecovery: async (input: BeginCheckoutInput, owner: DetachedCheckoutOwner) => {
      assertCurrent(); owner.assertCurrent();
      const refs = [...new Set([...input.controls.cardFields.map(field => field.ref),
        ...(input.controls.addressFields ?? []).map(field => field.ref), ...(input.controls.shippingTargets ?? []), input.controls.placeOrderTarget])];
      try {
        const original = await captureRecovery(input.sessionId, input.pageId, refs, owner);
        assertCurrent(); owner.assertCurrent(); return original;
      } catch { throw new BrowserPageConnectionError(); }
    } } : {}),
    ...(capturePage ? { capturePageConnection: async (input: BeginCheckoutInput, owner: DetachedCheckoutOwner) => {
      assertCurrent(); owner.assertCurrent();
      try {
        const original = await capturePage(input.sessionId, input.pageId, owner);
        assertCurrent(); owner.assertCurrent(); return original;
      } catch { throw new BrowserPageConnectionError(); }
    } } : {}),
    recoveryFacts: Object.freeze({ authority: expected as NativePairedSnapshot, configuration: config as PaymentsServiceConfig }) });
}
