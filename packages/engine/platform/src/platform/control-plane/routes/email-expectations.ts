/**
 * The three verbs that let an authorized workstream say what it is about to
 * expect.
 *
 * This is the half of §2 that turns a rule into a mechanism. Mail has no
 * command authority and never will; the only thing an arriving message may do
 * is SATISFY an expectation that an already-authorized workstream registered
 * in advance. Until these verbs existed there was no way to register one, so
 * the rule was enforced by there being nothing to enforce.
 *
 * Registration is explicit, never inferred
 * ────────────────────────────────────────
 * A caller states the service domain, the recipient address and the purpose
 * before it submits the form. Nothing watches a page and decides an
 * expectation ought to exist. That distinction is the whole authority model:
 * an expectation created by inference is an expectation created by CONTENT,
 * and content is exactly what must never be able to create one.
 *
 * What these handlers do NOT do
 * ─────────────────────────────
 * Validate. The window ceiling, the open-expectation cap, the address and
 * domain normalisation, the refusal when email holds command authority, all
 * of it belongs to `VerificationExpectationBook` and is reached through
 * `InboundExpectationRegistry`. These read arguments, refuse the ones that are
 * missing or the wrong shape with an honest status, and hand the rest over. A
 * second copy of a clamp is a second clamp that can drift from the first.
 *
 * No `http` binding
 * ─────────────────
 * Deliberate, and it is why these live in their own file rather than beside
 * the mail verbs. The callers are inside the daemon. Advertising an
 * `/api/email/expectations` path that no route serves is precisely what the
 * route-reconcile gate reddens, and inventing a REST surface nothing consumes
 * would be inventing a promise to keep.
 */

import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { ExpectationMailboxUnreadableError } from '../../email/inbound/expectation-registry.js';
import { ExpectationAuthorityError, ExpectationRefusalError } from '../../google/verification-expectations.js';
import type { GatewayMethodCatalog, GatewayMethodHandler } from '../method-catalog.js';
import { attachHandler } from './attach-handler.js';
import type {
  DisclosedExpectation,
  InboundExpectationRegistry,
} from '../../email/inbound/expectation-registry.js';

/**
 * What a backend must be able to do to serve these verbs.
 *
 * Structurally satisfied by `InboundExpectationRegistry`, so the daemon wiring
 * passes the registry itself rather than an adapter, one implementation of
 * these three operations, not two.
 */
export type EmailExpectationService = Pick<
  InboundExpectationRegistry,
  'open' | 'list' | 'cancel' | 'wait'
>;

function readRequired(value: unknown, field: string, hint: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${field} (${hint}) is required`, 'INVALID_ARGUMENT', 400);
  }
  return value.trim();
}

/**
 * An optional positive window, in milliseconds.
 *
 * Refused rather than coerced when it is present and not a positive finite
 * number: a caller that sent `"soon"` has a bug, and silently substituting the
 * default would hide it behind an expectation that expires at a time nobody
 * chose. Absent is fine, the registry's default applies, and the book clamps
 * whatever arrives to the hard maximum regardless.
 */
function readOptionalWindowMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    throw new GatewayVerbError(
      'windowMs (a positive number of milliseconds) must be a positive number when supplied',
      'INVALID_ARGUMENT',
      400,
    );
  }
  return parsed;
}

/** `signup` or `login`; anything else is refused rather than defaulted. */
function readOptionalKind(value: unknown): 'signup' | 'login' | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'signup' || value === 'login') return value;
  throw new GatewayVerbError(
    "kind must be 'signup' or 'login' when supplied",
    'INVALID_ARGUMENT',
    400,
  );
}

/** Whether a mailbox is being read right now, and if not why not. */
export interface EmailExpectationWatchState {
  readonly running: boolean;
  readonly reason: string;
}

export function createEmailExpectationOpenHandler(
  service: EmailExpectationService,
  watchState?: () => EmailExpectationWatchState,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const windowMs = readOptionalWindowMs(params.windowMs);
    const kind = readOptionalKind(params.kind);
    try {
      const opened = await service.open({
        serviceDomain: readRequired(params.serviceDomain, 'serviceDomain', 'the domain the workstream is signing up at'),
        recipientAddress: readRequired(params.recipientAddress, 'recipientAddress', 'the exact address handed to the form'),
        purpose: readRequired(params.purpose, 'purpose', 'a stated purpose'),
        ...(windowMs === undefined ? {} : { windowMs }),
        ...(kind === undefined ? {} : { kind }),
      });
      // Opening is not refused while nothing watches the mailbox (a cluster
      // standby legitimately does not), so the answer says what the caller
      // would otherwise discover only when the window runs out.
      const watching = watchState?.();
      return watching === undefined ? opened : { ...opened, watching: { running: watching.running, reason: watching.reason } };
    } catch (error) {
      // The book refuses for reasons that are the CALLER's to fix, too many
      // open expectations, an unusable domain or address, so they are 400s
      // carrying its wording, not 500s. Two refusals are NOT about the request
      // and must not be reported as though the caller sent something wrong:
      // the command-authority refusal is a statement about the platform's
      // configuration, and the unreadable-mailbox refusal is a statement about
      // the machine. A workstream that reads 400 retries with different
      // arguments; one that reads 409 knows the arguments were fine.
      // Only the book's typed refusals are the caller's to fix. Anything else,
      // a failed persist, a system error, a bug, is the daemon's own and stays
      // a 500 instead of telling the caller to retry with different arguments.
      if (!(error instanceof ExpectationRefusalError || error instanceof ExpectationMailboxUnreadableError || error instanceof ExpectationAuthorityError || error instanceof GatewayVerbError)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof ExpectationMailboxUnreadableError) {
        throw new GatewayVerbError(message, 'FAILED_PRECONDITION', 409);
      }
      if (error instanceof ExpectationAuthorityError) {
        throw new GatewayVerbError(message, 'FAILED_PRECONDITION', 409);
      }
      if (error instanceof GatewayVerbError) throw error;
      throw new GatewayVerbError(message, 'INVALID_ARGUMENT', 400);
    }
  };
}

export function createEmailExpectationListHandler(
  service: EmailExpectationService,
): GatewayMethodHandler {
  return async () => {
    const expectations: readonly DisclosedExpectation[] = service.list();
    return { expectations, total: expectations.length };
  };
}

export function createEmailExpectationCancelHandler(
  service: EmailExpectationService,
): GatewayMethodHandler {
  return async (invocation) => {
    const id = readRequired(
      readInvocationParams(invocation).id,
      'id',
      'the id returned when the expectation was opened',
    );
    const cancelled = await service.cancel(id);
    // An id that is not open is an ordinary answer to an ordinary question,
    // the workstream asked for it to be gone and it is gone. Reporting a 404
    // would make a caller retrying after a crash treat success as failure.
    return cancelled === null
      ? { cancelled: false }
      : { cancelled: true, expectation: cancelled };
  };
}

/**
 * Where one expectation stands, waiting up to `timeoutMs` (at most a minute)
 * for it to change: `arrived` carries the verification link or code the daemon
 * took from the matching message; `waiting` lists matching messages that held
 * none; `expired`, `capability-lost` and `cancelled` say how it ended;
 * `replaced` says a later open for the same address replaced it, with
 * `replacedBy` the id to wait on instead; `unknown` says no such expectation
 * is open or remembered. `watching` says whether a
 * mailbox is being read right now, so "nothing yet" is never confused with
 * "nobody is looking".
 */
export function createEmailExpectationWaitHandler(
  service: EmailExpectationService,
  watchState?: () => EmailExpectationWatchState,
): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const id = readRequired(params.id, 'id', 'the id returned when the expectation was opened');
    const timeoutMs = params.timeoutMs === undefined || params.timeoutMs === null ? 0 : Number(params.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new GatewayVerbError('timeoutMs (milliseconds to wait, at most 60000) must be a number of 0 or more when supplied', 'INVALID_ARGUMENT', 400);
    }
    const state = await service.wait(id, { timeoutMs });
    const watching = watchState?.();
    return watching === undefined ? state : { ...state, watching: { running: watching.running, reason: watching.reason } };
  };
}

/** Attach the expectation handlers to their descriptors (missing = no-op). */
export function registerEmailExpectationGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: EmailExpectationService,
  watchState?: () => EmailExpectationWatchState,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('email.expectation.open', createEmailExpectationOpenHandler(service, watchState));
  attach('email.expectation.list', createEmailExpectationListHandler(service));
  attach('email.expectation.cancel', createEmailExpectationCancelHandler(service));
  attach('email.expectation.wait', createEmailExpectationWaitHandler(service, watchState));
}
