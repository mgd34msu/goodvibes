// Proves: A purchase is started or continued by a caller who is not the owner asking, or the owner cannot cancel one.
// Red when: A started purchase keeps its authority after a revocation or a lowered limit, the owner (local or paired) cannot cancel, or a purchase is started or cancelled without the explicit request or without transport authority.
/**
 * Who may start and stop a purchase. An app on the owner's own machine (the
 * transport's 'local' authority) and a paired device may both start and cancel;
 * a call without the owner's explicit request, or with no authority from the
 * transport, may not. Once started, any change to the authority, settings or
 * browser owner retires the purchase's authority.
 *
 * Real `checkout-invocation.ts` and `window-handlers.ts`; the transport's
 * authority and the operations store are stand-ins that record what reached them.
 */
import { expect, test } from 'bun:test';
import { retainCheckoutInvocation, retainDetachedCheckout } from '../platform/src/platform/payments/host/checkout-invocation.js';
import { purchaseWindowAnswerHandler } from '../platform/src/platform/payments/host/window-handlers.js';
import { UntrustedContentLedger } from '../platform/src/platform/security/untrusted-content.js';
import type { CheckoutOperations } from '../platform/src/platform/payments/host/checkout-operations.js';
import { HandlerError, type HandlerContextEnvelope } from '../platform/src/platform/payments/host/handler-plumbing.js';
import type { PaymentsHandlerDeps } from '../platform/src/platform/payments/host/register.js';
import type { BrowserCheckoutSeam } from '../platform/src/platform/control-plane/routes/browser-composition.js';
import type { NativeExecutionAuthority, NativePairedSnapshot } from '../platform/src/platform/security/http-auth.js';

function fixture() {
  let allowed = true;
  const values = new Map<string, unknown>([['payments.enabled', true]]);
  const seam = {} as BrowserCheckoutSeam;
  const paired: NativePairedSnapshot = { kind: 'pairing-token', tokenId: 'owner', principalId: 'pairing:owner', authorityId: 'pairing:owner',
    authorityRevision: 'original', scopes: ['write:payments'] };
  const native: NativeExecutionAuthority = { current: () => paired, async withCurrent(_expected, work) {
    return work(() => paired);
  } };
  const abort = new AbortController();
  const context: HandlerContextEnvelope = { signal: abort.signal, principalId: paired.principalId, principalKind: 'token',
    admin: true, scopes: ['write:payments'], explicitUserRequest: true, authToken: 'private-fixture-bearer',
    nativeExecutionAuthority: native, isAuthorized: () => allowed };
  // Only the actual dependencies used by this restriction are supplied.
  const deps = { config: { get: (key: string) => values.get(key) }, isPaymentsLeader: () => true,
    checkout: { seam: () => seam } } as unknown as PaymentsHandlerDeps;
  const owner = retainCheckoutInvocation(deps, seam, context);
  return { owner, context, values, abort, deps, seam, revoke: () => { allowed = false; } };
}

test.each(['revocation', 'budget'] as const)(
  '%s changes retire checkout authority without exposing private transport state', kind => {
    const f = fixture();
    if (kind === 'revocation') f.revoke();
    if (kind === 'budget') f.values.set('payments.budget.dailyItem', 2);
    const error = (() => { try { f.owner.assertCurrent(); } catch (error) { return error; } return null; })();
    expect(error).toBeInstanceOf(HandlerError);
    expect(String(error)).not.toContain('private-fixture-bearer');
  },
);

type OwnerKind = 'local' | 'pairing-token';
function owner(kind: OwnerKind | null, explicitUserRequest = true) {
  const principalId = kind === 'local' ? 'local-owner' : 'pairing:owner';
  const snapshot: NativePairedSnapshot = { kind: kind ?? 'pairing-token', tokenId: 'owner', principalId, authorityId: principalId,
    authorityRevision: 'original', scopes: ['write:payments'] };
  const native: NativeExecutionAuthority = {
    current: () => snapshot,
    async withCurrent(_expected, work) { return work(() => snapshot); },
    issueContinuation: () => ({ binding: 'grant' }) as never,
    revokeContinuation: () => {},
  };
  const context: HandlerContextEnvelope = { principalId, principalKind: 'token', admin: true, scopes: ['write:payments'],
    explicitUserRequest, authToken: 'private-fixture-bearer', isAuthorized: () => true,
    ...(kind === null ? {} : { nativeExecutionAuthority: native }) };
  const seam = {} as BrowserCheckoutSeam;
  const values = new Map<string, unknown>([['payments.enabled', true]]);
  const deps = { config: { get: (key: string) => values.get(key) }, isPaymentsLeader: () => true,
    checkout: { seam: () => seam, untrusted: new UntrustedContentLedger() } } as unknown as PaymentsHandlerDeps;
  const cancelled: string[] = [];
  const operations: Pick<CheckoutOperations, 'cancel'> = { cancel: ((purchaseId: string, operationId: string) => {
    cancelled.push(`${purchaseId}/${operationId}`); return { cancelled: true };
  }) as unknown as CheckoutOperations['cancel'] };
  const cancel = () => purchaseWindowAnswerHandler({}, 'cancel', operations)({
    body: { confirm: true, purchaseId: 'pur-1', operationId: 'op-1' }, query: {}, context });
  return { start: () => retainDetachedCheckout(deps, seam, context), cancel, cancelled };
}

test.each(['local', 'pairing-token'] as const)('the owner on %s authority can start and cancel a purchase', async kind => {
  const f = owner(kind);
  expect(f.start().principalId).toBe(kind === 'local' ? 'local-owner' : 'pairing:owner');
  await f.cancel();
  expect(f.cancelled).toEqual(['pur-1/op-1']);
});

test('without the owner\'s explicit request a purchase can be neither started nor cancelled', async () => {
  const f = owner('local', false);
  expect(() => f.start()).toThrow(HandlerError);
  await expect(f.cancel()).rejects.toBeInstanceOf(HandlerError);
  expect(f.cancelled).toEqual([]);
});

test('a caller the transport gave no owner authority can neither start nor cancel', async () => {
  const f = owner(null);
  expect(() => f.start()).toThrow(HandlerError);
  await expect(f.cancel()).rejects.toBeInstanceOf(HandlerError);
  expect(f.cancelled).toEqual([]);
});
