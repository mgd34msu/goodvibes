import { isDeepStrictEqual } from 'node:util';
import type { TypedHandler } from '../../control-plane/host-handlers.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import { nativeIdentityIsCaller } from '../../control-plane/routes/native-owner.js';
import { PurchaseReconciliationError, type PurchaseReconciliations } from './purchase-reconciliation.js';
import { PaymentOperationStoreError } from './operation-store.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';

/** An explicit observation of merchant history, with the same current paired
 * admin authority as answering a window. Classic policy may settle old funds;
 * this handler never invokes a decision model or grants another checkout. */
export function purchaseReconciliationHandler(owner: PurchaseReconciliations): TypedHandler<unknown, unknown> {
  return async ({ body, context }) => {
    // Its descriptor's confirmation (owner-request) was checked before this handler ran.
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GatewayVerbError('Select the original purchase operation.', 'INVALID_ARGUMENT', 400);
    const input = body as Record<string, unknown>;
    const purchaseId = input['purchaseId'], operationId = input['operationId'], outcome = input['outcome'];
    if (Object.keys(input).length !== 5 || input['inspectedMerchantHistory'] !== true
      || typeof purchaseId !== 'string' || !purchaseId.trim() || purchaseId.length > 128
      || typeof operationId !== 'string' || !operationId.trim() || operationId.length > 256
      || (outcome !== 'purchased' && outcome !== 'not-purchased')) throw new GatewayVerbError('Inspect the merchant’s order history, then confirm the exact purchase and your finding.', 'INVALID_ARGUMENT', 400);
    const forbidden = () => new GatewayVerbError('Reconciling a purchase requires the owner with admin and write:payments: an app on the daemon\'s own machine or a paired device.', 'FORBIDDEN', 403);
    const authority = context.nativeExecutionAuthority;
    const snapshot = () => ({ principalId: context.principalId, principalKind: context.principalKind,
      admin: context.admin, scopes: [...context.scopes], explicitUserRequest: context.explicitUserRequest });
    const expected = (() => { try { return authority?.current(); } catch { throw forbidden(); } })();
    const has = (scopes: readonly string[]) => missingScopes(scopes, ['write:payments']).length === 0;
    if (!authority || !expected || !context.admin || !nativeIdentityIsCaller(context, expected)
      || !has(expected.scopes) || !has(context.scopes)) throw forbidden();
    const paired = structuredClone(expected), original = snapshot(), signal = context.signal, isAuthorized = context.isAuthorized;
    const current = () => {
      signal?.throwIfAborted();
      if (context.signal !== signal || context.isAuthorized !== isAuthorized || context.nativeExecutionAuthority !== authority
        || !isDeepStrictEqual(snapshot(), original) || !isDeepStrictEqual(authority.current(), paired)
        || isAuthorized?.(['write:payments']) !== true) throw forbidden();
    };
    try {
      current();
      return await authority.withCurrent(expected, assertPaired => owner.reconcile(purchaseId, operationId, outcome, expected.principalId,
        () => { assertPaired(); current(); }));
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      if (error instanceof PurchaseReconciliationError) throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
      if (error instanceof PaymentOperationStoreError && error.kind === 'busy') throw new GatewayVerbError(
        'This purchase is still being processed, so it cannot be reconciled yet. Wait for its status to settle, then try again. No new order was submitted.', 'FAILED_PRECONDITION', 409);
      throw new GatewayVerbError('The purchase finding could not be fully settled. Refresh its status; if it shows a saved finding, repeat that same finding. Do not submit another order.', 'FAILED_PRECONDITION', 409);
    }
  };
}
