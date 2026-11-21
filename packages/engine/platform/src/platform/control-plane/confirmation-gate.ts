/**
 * confirmation-gate.ts, the one confirmation gate in front of a destructive
 * or outward write, with one refusal.
 *
 * Two facts can be asked of a call. `confirm: true` in its input says the call
 * was reviewed. `explicitUserRequest` in its context says a person asked for
 * it; the daemon keeps that claim only from a credential the transport
 * established as a person's (a sign-in, a paired device, an app on the
 * daemon's own machine) and drops it from any other (daemon/control-plane.ts).
 *
 * A method declares what it needs (`GatewayMethodDescriptor.confirmation`):
 *  - `confirm`: the input carries `confirm: true`, and the caller did not
 *    declare the call was not a person's request (`explicitUserRequest: false`).
 *    Scheduled and channel-driven work, which honestly is not a person, passes.
 *  - `owner-request`: `confirm: true`, and a person's credential asked for it.
 *  - `not-declined`: nothing is required but that the caller did not declare
 *    the call was not a person's request.
 *
 * Every refusal is one body: code CONFIRMATION_REQUIRED, field `confirm`, what
 * is true and what to do. A caller that sent `confirm: true` on a credential
 * that cannot state a person asked is told that, never told to confirm again.
 */
import { GatewayVerbError } from './routes/gateway-verb-error.js';
import type { GatewayMethodInvocation } from './method-catalog-shared.js';

export type ConfirmationLevel = 'confirm' | 'owner-request' | 'not-declined';

/** The code every confirmation refusal carries. */
export const CONFIRMATION_REQUIRED = 'CONFIRMATION_REQUIRED';

function refusal(action: string, reason: string, state: string, next: readonly string[], status: number): GatewayVerbError {
  return new GatewayVerbError(`${action}: ${reason}`, CONFIRMATION_REQUIRED, status, 'confirm', { state, next: [...next] });
}

/**
 * Refuse a call that does not meet `level`, before anything is written.
 * `input` is the call's input (body or params); `context` its invocation
 * context (`explicitUserRequest` as the daemon kept it).
 */
export function requireConfirmation(
  level: ConfirmationLevel,
  action: string,
  input: unknown,
  context: { readonly explicitUserRequest?: boolean | undefined; readonly metadata?: Readonly<Record<string, unknown>> | undefined },
): void {
  const claim = context.explicitUserRequest ?? context.metadata?.['explicitUserRequest'];
  if (claim === false) {
    throw refusal(action, 'the caller declared this was not a person\'s request, so it was refused rather than done on someone\'s behalf',
      'nothing was changed', ['Send it as a person\'s request (from a sign-in, a paired device or this machine), or leave it to the owner.'], 403);
  }
  if (level === 'not-declined') return;
  const confirmed = typeof input === 'object' && input !== null && (input as { confirm?: unknown }).confirm === true;
  if (!confirmed) {
    throw refusal(action, 'it changes something that is not undone by asking again, so it runs only with confirm: true',
      'nothing was changed', ['Review the change, then send it again with confirm: true.'], 400);
  }
  if (level === 'owner-request' && claim !== true) {
    throw refusal(action, 'confirm: true was sent, but this credential cannot state that a person asked; use a sign-in, a paired device or this machine',
      'nothing was changed', ['Make the call from a sign-in, a paired device or an app on the daemon\'s own machine.'], 403);
  }
}

/**
 * The `not-declined` level for a route whose own exception decides whether it
 * applies (a write the owner's profile delegation already admitted): the same
 * gate and refusal, from the invocation.
 */
export function refuseDeclinedRequest(invocation: GatewayMethodInvocation, action: string): void {
  requireConfirmation('not-declined', action, undefined, invocation.context);
}
