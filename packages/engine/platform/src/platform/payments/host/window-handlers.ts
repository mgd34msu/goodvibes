import { isDeepStrictEqual } from 'node:util';
import { requireDecisionFeature } from '../../runtime/decision-policy.js';
import { PaymentReplyInboxClosedError, PaymentReplyWindowError } from '../reply-inbox.js';
import { assertConfirmed, HandlerError, type HandlerContextEnvelope, type TypedHandler } from './handler-plumbing.js';
import type { PaymentReplyInbox } from '../reply-inbox.js';
import type { CheckoutOperations } from './checkout-operations.js';
interface PaymentWindowHandlerDeps { readonly replies?: PaymentReplyInbox | undefined }

function scope(scopes: readonly string[], required: string): boolean { return scopes.includes('*') || scopes.includes(required); }
function authorizedFor(context: HandlerContextEnvelope, required: string): boolean {
  try { return context.isAuthorized?.([required]) === true; } catch { return false; }
}
function field(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new HandlerError(`${name} must be a nonempty purchase/window reference.`, 'INVALID_ARGUMENT', 400);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unavailable(): HandlerError {
  return new HandlerError('Purchase windows are unavailable on this payment host.', 'FAILED_PRECONDITION', 409);
}
function forbidden(): HandlerError {
  return new HandlerError('Answering a purchase requires current paired owner access with admin and write:payments. Pair this client and refresh the purchase.', 'FORBIDDEN', 403);
}

export function purchaseWindowStatusHandler(deps: PaymentWindowHandlerDeps, operations: Pick<CheckoutOperations, 'status'>): TypedHandler<unknown, unknown> {
  return async ({ body, query, context }) => {
    context.signal?.throwIfAborted();
    if (!context.principalId || !scope(context.scopes, 'read:payments') || !authorizedFor(context, 'read:payments')) {
      throw new HandlerError('Reading purchase windows requires current read:payments access.', 'FORBIDDEN', 403);
    }
    const input = record(body);
    const selected = input['purchaseId'] ?? query['purchaseId'];
    const purchaseId = selected === undefined ? undefined : field(selected, 'purchaseId');
    const replies = deps.replies;
    if (!replies) throw unavailable();
    try { return { windows: replies.inspect(purchaseId), operations: operations.status(purchaseId) }; }
    catch { throw new HandlerError('Purchase status is unavailable. Inspect the original payment evidence before taking further action.', 'FAILED_PRECONDITION', 409); }
  };
}

/** Explicit owner choices have no model interpretation step. Transport-created
 * pairing authority, live scopes and exact window ownership still decide in code. */
export function purchaseWindowAnswerHandler(deps: PaymentWindowHandlerDeps, action: 'approve' | 'deny' | 'cancel', operations?: Pick<CheckoutOperations, 'cancel'>): TypedHandler<unknown, unknown> {
  return async ({ body, context }) => {
    assertConfirmed(body, context);
    const input = record(body);
    const purchaseId = field(input['purchaseId'], 'purchaseId');
    const operationId = input['operationId'] === undefined ? undefined : field(input['operationId'], 'operationId');
    if (operationId !== undefined && (action !== 'cancel' || input['windowId'] !== undefined)) {
      throw new HandlerError('Choose either the exact window or the exact operation to cancel.', 'INVALID_ARGUMENT', 400);
    }
    const windowId = operationId === undefined ? field(input['windowId'], 'windowId') : undefined;
    const replies = deps.replies;
    if (operationId === undefined ? !replies : !operations) throw unavailable();
    const authority = context.nativeExecutionAuthority;
    const expected = (() => { try { return authority?.current(); } catch { throw forbidden(); } })();
    if (!expected || !authority || expected.kind !== 'pairing-token' || !context.admin
      || context.principalKind !== 'token' || context.principalId !== expected.principalId
      || !scope(context.scopes, 'write:payments') || !scope(expected.scopes, 'write:payments')
      || !authorizedFor(context, 'write:payments')) throw forbidden();
    const signal = context.signal;
    const authorized = context.isAuthorized;
    const original = snapshotContext(context);
    const paired = structuredClone(expected);
    const current = (): void => {
      signal?.throwIfAborted();
      if (context.signal !== signal || context.isAuthorized !== authorized || context.nativeExecutionAuthority !== authority
        || !isDeepStrictEqual(snapshotContext(context), original)
        || !isDeepStrictEqual(authority.current(), paired) || authorized?.(['write:payments']) !== true) throw forbidden();
      if (action === 'approve') requireDecisionFeature('automated checkout cart and merchant interpretation');
    };
    if (action === 'approve') requireDecisionFeature('automated checkout cart and merchant interpretation');
    try {
      current();
      return await authority.withCurrent(expected, assertPaired => {
        assertPaired(); current();
        if (operationId !== undefined) {
          if (!operations) throw unavailable();
          return operations.cancel(purchaseId, operationId);
        }
        if (!replies || windowId === undefined) throw unavailable();
        return replies.answer({ purchaseId, windowId, action });
      });
    } catch (error) {
      if (error instanceof HandlerError) throw error;
      if (error instanceof PaymentReplyWindowError || error instanceof PaymentReplyInboxClosedError) {
        throw new HandlerError(error.message, 'FAILED_PRECONDITION', 409);
      }
      // Neither pairing failures nor underlying callbacks may echo private data.
      throw new HandlerError('The purchase window could not be answered. Refresh its status before trying again.', 'FAILED_PRECONDITION', 409);
    }
  };
}

function snapshotContext(context: HandlerContextEnvelope) {
  return { principalId: context.principalId, principalKind: context.principalKind, admin: context.admin,
    scopes: [...context.scopes], explicitUserRequest: context.explicitUserRequest };
}
