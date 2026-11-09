import { isDeepStrictEqual } from 'node:util';
import { assertConfirmed, HandlerError, type TypedHandler } from './handler-plumbing.js';
import type { PurchaseReconciliations } from './purchase-reconciliation.js';

/** An explicit observation of merchant history, with the same current paired
 * admin authority as answering a window. Classic policy may settle old funds;
 * this handler never invokes a decision model or grants another checkout. */
export function purchaseReconciliationHandler(owner: PurchaseReconciliations): TypedHandler<unknown, unknown> {
  return async ({ body, context }) => {
    assertConfirmed(body, context);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HandlerError('Select the original purchase operation.', 'INVALID_ARGUMENT', 400);
    const input = body as Record<string, unknown>;
    const purchaseId = input['purchaseId'], operationId = input['operationId'], outcome = input['outcome'];
    if (Object.keys(input).length !== 5 || input['inspectedMerchantHistory'] !== true
      || typeof purchaseId !== 'string' || !purchaseId.trim() || purchaseId.length > 128
      || typeof operationId !== 'string' || !operationId.trim() || operationId.length > 256
      || (outcome !== 'purchased' && outcome !== 'not-purchased')) throw new HandlerError('Inspect the merchant’s order history, then confirm the exact purchase and your finding.', 'INVALID_ARGUMENT', 400);
    const forbidden = () => new HandlerError('Reconciling a purchase requires current paired owner access with admin and write:payments.', 'FORBIDDEN', 403);
    const authority = context.nativeExecutionAuthority;
    const snapshot = () => ({ principalId: context.principalId, principalKind: context.principalKind,
      admin: context.admin, scopes: [...context.scopes], explicitUserRequest: context.explicitUserRequest });
    const expected = (() => { try { return authority?.current(); } catch { throw forbidden(); } })();
    const has = (scopes: readonly string[]) => scopes.includes('*') || scopes.includes('write:payments');
    if (!authority || !expected || expected.kind !== 'pairing-token' || !context.admin || context.principalKind !== 'token'
      || expected.principalId !== context.principalId || !has(expected.scopes) || !has(context.scopes)) throw forbidden();
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
      if (error instanceof HandlerError) throw error;
      throw new HandlerError('The purchase finding could not be fully settled. Refresh its status and repeat only the finding already saved. Do not submit another order.', 'FAILED_PRECONDITION', 409);
    }
  };
}
