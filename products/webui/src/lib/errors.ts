import { asRecord, compactJson } from './object';

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : '';
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function serializeError(error: unknown): Record<string, unknown> {
  if (!error) return {};
  if (error instanceof Error) {
    const record = asRecord(error);
    const json = typeof record.toJSON === 'function' ? asRecord((record.toJSON as () => unknown)()) : {};
    return {
      name: error.name,
      message: error.message,
      ...json,
      ...record,
    };
  }
  return asRecord(error);
}

export function formatError(error: unknown): string {
  if (!error) return '';

  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const body = serialized.body ?? transport.body;
  // The daemon's own words about what failed (body.message / body.error) beat
  // the transport wrapper's synthetic "GET /path failed: 400 Bad Request",
  // which is ALWAYS present on an HTTP error and used to shadow an actionable
  // body ("refresh token expired... start a fresh consent") behind a bare
  // status line.
  const message = readString(asRecord(body), 'message')
    || readString(asRecord(body), 'error')
    || readString(serialized, 'message')
    || (typeof error === 'string' ? error : 'Request failed');
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  const category = readString(serialized, 'category');
  const hint = readString(serialized, 'hint');

  const details = [
    status ? `HTTP ${status}` : '',
    category && category !== 'unknown' ? category : '',
    hint,
  ].filter(Boolean);

  return details.length ? `${message} (${details.join(' · ')})` : message;
}

export function errorCode(error: unknown): string {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const body = asRecord(serialized.body ?? transport.body);
  return readString(serialized, 'code')
    || readString(body, 'code')
    || readString(asRecord(body.error), 'code')
    || '';
}

/**
 * The daemon's refusal of a non-admin credential on an admin-only route. Read
 * from the machine code, so a refused origin or a missing scope (also 403)
 * shows its own reason instead of "sign in as admin".
 */
export function isAdminRequiredError(error: unknown): boolean {
  return errorCode(error) === 'ADMIN_REQUIRED';
}

export function isSessionNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_NOT_FOUND';
}

export function isSessionClosedError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_CLOSED';
}

export function isSessionActiveError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_ACTIVE';
}

export function isSessionNotLocalError(error: unknown): boolean {
  return errorCode(error) === 'SESSION_NOT_LOCAL';
}


/**
 * The benign refusal from companion.chat.turns.cancel: no turn was in flight,
 * it finished naturally before the stop landed. Rendered quietly, never as an
 * error (the daemon promises the machine code, not message text).
 */
export function isNoActiveTurnError(error: unknown): boolean {
  return errorCode(error) === 'NO_ACTIVE_TURN';
}

/**
 * companion.chat.turns.cancel accepted the stop, but the turn has not ended yet (a tool call
 * or the provider is still finishing). The turn is stopping, not failed: the terminal
 * turn.cancelled event on the session stream settles it.
 */
export function isTurnStoppingError(error: unknown): boolean {
  return errorCode(error) === 'TURN_STOPPING';
}

/**
 * True for the daemon's honest 409 CONFLICT rejection. Two review-cockpit surfaces
 * raise it, both meaning "nothing was written, re-read and retry", never a partial apply:
 *   - checkpoints.revertHunk, when the hunk no longer reverse-applies cleanly because the
 *     file drifted since the diff was captured (control-plane/routes/checkpoints.ts throws
 *     GatewayVerbError(..., 'CONFLICT', 409));
 *   - fleet.attempts.pick, for an unknown/not-ready group or an invalid winner (never a
 *     partial merge of a best-of-N group).
 * Code-first, status-fallback, the same pattern as the other daemon-code checks above.
 */
/**
 * The daemon answered and refused (a 4xx other than a timeout, too-early or
 * rate limit): sending the same request again gets the same answer. Anything
 * else (no answer, a network failure, a 5xx) may be resent.
 */
export function isDefiniteRefusal(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status') ?? 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429;
}

export function isConflictError(error: unknown): boolean {
  if (errorCode(error) === 'CONFLICT') return true;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 409;
}

/**
 * True for the daemon's honest 501 refusal on memory.consolidation.receipts when this
 * runtime has no consolidation scheduler wired at all (method-catalog-runtime.ts's
 * own description: "a runtime without the consolidation scheduler answers an honest
 * 501"), distinct from `isMethodUnavailableError`'s 404 (the verb id itself is
 * unregistered on an older daemon build): here the verb IS registered, but this
 * daemon build genuinely never runs the scheduler. Status-only, same pattern as
 * `isConflictError`, no machine `code` is documented for this refusal.
 */
export function isConsolidationUnavailableError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 501;
}

export function isMethodUnavailableError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 404 && errorCode(error) === 'METHOD_NOT_FOUND';
}

/**
 * True when a thrown request error never reached the daemon, a network/connection
 * failure rather than an HTTP rejection. The platform transport tags these with
 * `category: 'network'` and `transport.status: 0` (createNetworkTransportError), and the
 * webui's own requestJson leaves `status` unset when fetch throws. This is what lets the
 * auth gate tell "daemon unreachable" (keep the token, reconnect) apart from a genuine
 * 401 "unauthenticated" (clear the token, show the sign-in front door).
 */
export function isDaemonUnreachableError(error: unknown): boolean {
  if (!error) return false;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const category = readString(serialized, 'category') || readString(transport, 'category');
  if (category === 'network') return true;
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 0;
}

/**
 * True when the daemon answered with a server fault (any 5xx): it is there
 * but could not answer. Like an unreachable daemon, this is not being signed
 * out: the token is kept and the request is tried again.
 */
export function isServerFaultError(error: unknown): boolean {
  if (!error) return false;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status !== undefined && status >= 500 && status <= 599;
}

/**
 * True for a 401 / `category: 'authentication'` rejection, a token that was valid
 * when the request/stream opened but has since expired or been revoked. Distinct from
 * `isDaemonUnreachableError` (network/status-0, daemon unreachable): this is a genuine
 * "the daemon is answering and says you are no longer authenticated" signal, the one
 * that must hand off to the sign-in front door rather than retry forever. A relay
 * step-up refusal is also a 401 but means "this change needs your passkey", not
 * "signed out", so it is excluded.
 */
export function isAuthExpiredError(error: unknown): boolean {
  if (!error || isStepUpRequiredError(error)) return false;
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const category = readString(serialized, 'category') || readString(transport, 'category');
  if (category === 'authentication') return true;
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 401;
}

/**
 * True for the daemon's 400 refusals on the calendar surface that mean no
 * calendar is set up: CALENDAR_NOT_CONFIGURED (no usable CalDAV server or Google
 * account; its message names every account the daemon found and why none can be
 * read) or CALENDAR_CREDENTIALS_MISSING (the CalDAV password is not in the
 * credential store). Not a fault: distinguished from a genuine error so the
 * calendar view can show the daemon's words and point at setup.
 */
export function isCalendarUnconfiguredError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'CALENDAR_NOT_CONFIGURED' || code === 'CALENDAR_CREDENTIALS_MISSING';
}

/**
 * True for the daemon's CALENDAR_AUTH_FAILED code (HTTP 424): the configured
 * calendar (a CalDAV server answering 401/403, or a Google grant that is no
 * longer valid) rejected the stored credentials. Distinct from
 * `isCalendarUnconfiguredError`: here the operator DID configure a calendar, but
 * the credentials it holds no longer work, and distinct from an expired sign-in
 * to the daemon (401).
 */
export function isCalendarAuthFailedError(error: unknown): boolean {
  return errorCode(error) === 'CALENDAR_AUTH_FAILED';
}

/**
 * True for a 501 "Gateway method is cataloged but not invokable through method
 * dispatch" refusal (control-plane.ts), a method the daemon's contract knows
 * about but has no live handler wired for on this build. Distinct from
 * `isMethodUnavailableError` (404, the daemon has never heard of the id at
 * all): 501 means the id IS in the catalog, just not wired to a handler yet.
 * Calendar is the first surface where this matters, the platform ships the
 * `calendar.*` contract with `invokable: false` by default; a daemon build
 * that has not registered a real CalDAV handler answers this way.
 */
export function isMethodNotInvokableError(error: unknown): boolean {
  const serialized = serializeError(error);
  const transport = asRecord(serialized.transport);
  const status = readNumber(serialized, 'status') ?? readNumber(transport, 'status');
  return status === 501;
}

/**
 * True for the daemon's refusals on the email surface that mean the mail account
 * is not set up yet: `EMAIL_NOT_CONFIGURED` (a setting is invalid or the password
 * cannot be read), `EMAIL_NOT_ENABLED` (no IMAP host, SMTP host or account yet) and
 * `EMAIL_CREDENTIALS_MISSING` (the password secret is not stored). The view points
 * at setup instead of rendering a failure.
 */
export function isEmailUnconfiguredError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EMAIL_NOT_CONFIGURED' || code === 'EMAIL_NOT_ENABLED' || code === 'EMAIL_CREDENTIALS_MISSING';
}

/**
 * True for the daemon's `EMAIL_CREDENTIALS_REJECTED` (HTTP 424): the mail account
 * is configured but the IMAP or SMTP server refused the stored password (an app
 * password revoked, or the account moved). Distinct from `isEmailUnconfiguredError`:
 * there is something to replace, not something to set up, and distinct from an
 * expired sign-in to the daemon (401, `isAuthExpiredError`).
 */
export function isEmailAuthFailedError(error: unknown): boolean {
  return errorCode(error) === 'EMAIL_CREDENTIALS_REJECTED';
}

/**
 * True for the daemon's step-up refusal on a call that arrived over the relay: a 401 whose
 * body is `{ code: 'STEP_UP_REQUIRED', category: 'permission', reason, action, error, next }`
 * (the relay gate's refusal shape). The passkey ceremony in relay-connection.ts has already run
 * or could not help (cancelled, another prompt open, `action: 'register-locally'`), so the call
 * was not sent: show the daemon's reason and next step, never "your session expired".
 */
export function isStepUpRequiredError(error: unknown): boolean {
  return errorCode(error) === 'STEP_UP_REQUIRED';
}

export function errorDebugValue(error: unknown): unknown {
  const serialized = serializeError(error);
  return Object.keys(serialized).length ? serialized : undefined;
}

export function compactError(error: unknown): string {
  return compactJson(serializeError(error));
}
