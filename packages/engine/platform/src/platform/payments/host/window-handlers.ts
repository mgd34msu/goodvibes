import { isDeepStrictEqual } from 'node:util';
import { PaymentReplyInboxClosedError, PaymentReplyWindowError } from '../reply-inbox.js';
import type { HandlerContextEnvelope, TypedHandler } from '../../control-plane/host-handlers.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import { describeCardTransportRefusal, mayCrossWithCardDetails } from '../entry-policy.js';
import type { PaymentReplyInbox } from '../reply-inbox.js';
import type { CheckoutOperations } from './checkout-operations.js';
import { PaymentOperationStoreError } from './operation-store.js';
import { SecurityCodeRequestError, type SecurityCodeRequests } from '../security-code-requests.js';
import { paymentHostStopView, type PaymentStoreStop } from '../payment-host-health.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';
interface PaymentWindowHandlerDeps { readonly replies?: PaymentReplyInbox | undefined; readonly securityCodes?: SecurityCodeRequests | undefined }

function scope(scopes: readonly string[], required: string): boolean { return missingScopes(scopes, [required]).length === 0; }
function authorizedFor(context: HandlerContextEnvelope, required: string): boolean {
  try { return context.isAuthorized?.([required]) === true; } catch { return false; }
}
function field(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new GatewayVerbError(`${name} must be a nonempty purchase/window reference.`, 'INVALID_ARGUMENT', 400, name);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unavailable(): GatewayVerbError {
  return new GatewayVerbError('Purchase windows are unavailable on this payment host.', 'FAILED_PRECONDITION', 409);
}
function forbidden(): GatewayVerbError {
  return new GatewayVerbError('Answering a purchase requires the owner with admin and write:payments: an app on the daemon\'s own machine or a paired device. '
    + 'From another device, pair it; then refresh the purchase.', 'FORBIDDEN', 403);
}

/** `stopped` is the payment host's health: the store that stopped itself, if any. */
export function purchaseWindowStatusHandler(deps: PaymentWindowHandlerDeps, operations: Pick<CheckoutOperations, 'statusReport'>,
  stopped: () => PaymentStoreStop | null = () => null): TypedHandler<unknown, unknown> {
  return async ({ body, query, context }) => {
    context.signal?.throwIfAborted();
    if (!context.principalId || !scope(context.scopes, 'read:payments') || !authorizedFor(context, 'read:payments')) {
      throw new GatewayVerbError('Reading purchase windows requires current read:payments access.', 'FORBIDDEN', 403);
    }
    const input = record(body);
    const selected = input['purchaseId'] ?? query['purchaseId'];
    const purchaseId = selected === undefined ? undefined : field(selected, 'purchaseId');
    const replies = deps.replies;
    if (!replies) throw unavailable();
    const stop = stopped();
    try {
      const { operations: rows, unreadable } = operations.statusReport(purchaseId);
      const securityCodes = deps.securityCodes?.inspect(purchaseId) ?? [];
      // Each optional list is present only when it has entries, so a reader
      // that knows nothing of the field still decodes every ordinary response.
      return { windows: replies.inspect(purchaseId), operations: rows, ...(unreadable.length ? { unreadable } : {}),
        ...(securityCodes.length ? { securityCodes } : {}), ...(stop ? { stopped: paymentHostStopView(stop) } : {}) };
    }
    catch (error) {
      throw new GatewayVerbError(stop ? paymentHostStopView(stop).message : error instanceof PaymentOperationStoreError ? error.message
        : 'Purchase status is unavailable. Inspect the original payment evidence before taking further action.', 'FAILED_PRECONDITION', 409);
    }
  };
}

/** Explicit owner choices have no model interpretation step. Transport-created
 * pairing authority, live scopes and exact window ownership still decide in code. */
export function purchaseWindowAnswerHandler(deps: PaymentWindowHandlerDeps, action: 'approve' | 'deny' | 'cancel', operations?: Pick<CheckoutOperations, 'cancel'> & Partial<Pick<CheckoutOperations, 'recordOwnerStop'>>): TypedHandler<unknown, unknown> {
  return async ({ body, context }) => {
    // Its descriptor's confirmation (owner-request) was checked before this handler ran.
    const input = record(body);
    const purchaseId = field(input['purchaseId'], 'purchaseId');
    const operationId = input['operationId'] === undefined ? undefined : field(input['operationId'], 'operationId');
    if (operationId !== undefined && (action !== 'cancel' || input['windowId'] !== undefined)) {
      throw new GatewayVerbError('Choose either the exact window or the exact operation to cancel.', 'INVALID_ARGUMENT', 400);
    }
    const windowId = operationId === undefined ? field(input['windowId'], 'windowId') : undefined;
    const replies = deps.replies;
    if (operationId === undefined ? !replies : !operations) throw unavailable();
    // An explicit owner answer is the purchase's no-model path too: a checkout
    // no decision model read waits on exactly this approval.
    const { authority, expected, current } = pairedOwner(context);
    try {
      current();
      return await authority.withCurrent(expected, assertPaired => {
        assertPaired(); current();
        if (operationId !== undefined) {
          if (!operations) throw unavailable();
          return operations.cancel(purchaseId, operationId);
        }
        if (!replies || windowId === undefined) throw unavailable();
        // Save, then acknowledge: an owner's "no" is on the purchase's record
        // before it is reported accepted, so a restart cannot resume the window
        // and buy on silence. A record that cannot be written refuses the answer.
        const stop = action !== 'approve' && replies.inspect(purchaseId).some(window => window.windowId === windowId)
          ? operations?.recordOwnerStop?.(purchaseId) ?? null : null;
        try {
          return replies.answer({ purchaseId, windowId, action });
        } catch (error) {
          // The record already says the owner stopped it: the purchase stops, never proceeds on silence.
          stop?.abort();
          throw error;
        }
      });
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      // Operation refusals name the purchase's actual state and what is still possible.
      if (error instanceof PaymentOperationStoreError) throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
      if (error instanceof PaymentReplyWindowError && error.kind === 'stale') {
        throw new GatewayVerbError('That purchase window has closed or was replaced, so this answer was not used. Read payments.purchase.status for the '
          + 'current window; to stop the purchase before it is submitted, use payments.purchase.cancel with its operationId.', 'FAILED_PRECONDITION', 409);
      }
      if (error instanceof PaymentReplyWindowError || error instanceof PaymentReplyInboxClosedError) {
        throw new GatewayVerbError(error.message, 'FAILED_PRECONDITION', 409);
      }
      // Neither pairing failures nor underlying callbacks may echo private data.
      throw new GatewayVerbError('The purchase window could not be answered. Refresh its status before trying again.', 'FAILED_PRECONDITION', 409);
    }
  };
}

/**
 * The current paired admin owner with write:payments, checked once here and
 * re-checked by `current` before the answer takes effect. Transport-created
 * pairing authority decides; nothing in the request body can.
 */
function pairedOwner(context: HandlerContextEnvelope) {
  const authority = context.nativeExecutionAuthority;
  const expected = (() => { try { return authority?.current(); } catch { throw forbidden(); } })();
  // A paired device or an app on the owner's own machine ('local').
  if (!expected || !authority || (expected.kind !== 'pairing-token' && expected.kind !== 'local') || !context.admin
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
  };
  return { authority, expected, current };
}

/**
 * The owner's typed card security code for the one purchase waiting on it
 * (`payments.cvvHandling: 'prompt'`). The code is handed to that purchase in
 * memory and never logged, stored or echoed; a refusal never quotes it.
 */
export function purchaseSecurityCodeHandler(deps: PaymentWindowHandlerDeps): TypedHandler<unknown, unknown> {
  return async ({ body, context }) => {
    // A security code is card material: it crosses only this machine, TLS or the tailnet.
    if (!mayCrossWithCardDetails(context.transport)) throw new GatewayVerbError(describeCardTransportRefusal(), 'CARD_ENTRY_TRANSPORT', 403);
    const input = record(body);
    const purchaseId = field(input['purchaseId'], 'purchaseId');
    const windowId = field(input['windowId'], 'windowId');
    const code = typeof input['code'] === 'string' && input['code'].length <= 16 ? input['code'] : '';
    const codes = deps.securityCodes;
    if (!codes) throw new GatewayVerbError('This payment host does not ask for security codes; payments.cvvHandling prompt needs the daemon the terminal app is paired with.', 'FAILED_PRECONDITION', 409);
    const { authority, expected, current } = pairedOwner(context);
    try {
      current();
      return await authority.withCurrent(expected, assertPaired => {
        assertPaired(); current();
        return codes.supply({ purchaseId, windowId, code });
      });
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      if (error instanceof SecurityCodeRequestError) {
        throw new GatewayVerbError(error.message, error.kind === 'invalid' ? 'INVALID_ARGUMENT' : 'FAILED_PRECONDITION', error.kind === 'invalid' ? 400 : 409);
      }
      throw new GatewayVerbError('The security code could not be handed to the purchase. Refresh its status before trying again.', 'FAILED_PRECONDITION', 409);
    }
  };
}

function snapshotContext(context: HandlerContextEnvelope) {
  return { principalId: context.principalId, principalKind: context.principalKind, admin: context.admin,
    scopes: [...context.scopes], explicitUserRequest: context.explicitUserRequest };
}
