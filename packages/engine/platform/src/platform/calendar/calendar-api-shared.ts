/**
 * calendar-api-shared.ts, the bearer-auth HTTP helper and honest degraded-state
 * mapping shared by the Google Calendar and Microsoft Graph clients. Every failed
 * response is turned into a named ApiDegradedState from facts the response and the
 * caller already hold: the status, the provider's own error codes, the RFC 6750
 * challenge, and which operation was attempted. No model is asked.
 *
 *  - 401 is `reconnect-needed`.
 *  - 403 with a usage-limit code (Google sends its rate limits as 403) is
 *    `rate-limited` with the retry time; 403 with a scope or access code, or an
 *    RFC 6750 `insufficient_scope` challenge, is `insufficient-scope` naming the
 *    scope the attempted operation needs; any other 403 is `provider-error`
 *    carrying the provider's own message.
 *  - 429 is `rate-limited` carrying the honored Retry-After.
 *  - everything else is `provider-error` with the status.
 */

import type { ApiDegradedState, CalendarProviderId, CalendarRequestOptions, HttpFetch, HttpResponse } from './oauth-types.js';

/** A named, honest API failure. */
export class CalendarApiError extends Error {
  readonly degraded: ApiDegradedState;
  constructor(degraded: ApiDegradedState) {
    super(degraded.detail);
    this.name = 'CalendarApiError';
    this.degraded = degraded;
  }
}

/** What a request was trying to do, so a refusal can name the scope that covers it. */
export type CalendarOperation = 'list-calendars' | 'list-events' | 'create-event';

/**
 * The scope each operation needs, as the profile in oauth-providers.ts requests
 * it. Google: calendarList and events.list are covered by calendar.readonly,
 * events.insert by calendar.events. Graph: reads by Calendars.Read, writes by
 * Calendars.ReadWrite.
 */
const REQUIRED_SCOPE: Readonly<Record<CalendarProviderId, Readonly<Record<CalendarOperation, string>>>> = {
  google: {
    'list-calendars': 'https://www.googleapis.com/auth/calendar.readonly',
    'list-events': 'https://www.googleapis.com/auth/calendar.readonly',
    'create-event': 'https://www.googleapis.com/auth/calendar.events',
  },
  microsoft: {
    'list-calendars': 'Calendars.Read',
    'list-events': 'Calendars.Read',
    'create-event': 'Calendars.ReadWrite',
  },
};

/** Provider codes that mean "slow down", whatever status carried them. */
const RATE_LIMIT_CODES = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  'ApplicationThrottled',
]);

/** Provider codes that mean the token's grant does not cover the request. */
const SCOPE_CODES = new Set([
  'insufficientPermissions',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
  'ErrorAccessDenied',
  'accessDenied',
]);

const PROVIDER_LABEL: Readonly<Record<CalendarProviderId, string>> = { google: 'Google Calendar', microsoft: 'Microsoft Outlook' };

/** The scope an operation on a provider needs. */
export function requiredCalendarScope(provider: CalendarProviderId, operation: CalendarOperation): string {
  return REQUIRED_SCOPE[provider][operation];
}

function retryAfterMs(res: HttpResponse): number {
  const header = res.header('retry-after');
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 1000;
}

/**
 * RFC 6750 §3.1: one Bearer challenge, error=insufficient_scope, and exactly one
 * required scope. A multi-scope requirement does not say which scope is absent,
 * so it is not read as naming one.
 */
function challengedScope(challenge: string): string | undefined {
  const bearer = /^Bearer\s+(.+)$/i.exec(challenge.trim());
  if (!bearer) return undefined;
  const params = new Map<string, string>();
  let rest = bearer[1] ?? '';
  while (rest) {
    const part = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)\s*=\s*(?:"([^"\\]*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))\s*(?:,\s*|$)/.exec(rest);
    if (!part) return undefined;
    const name = (part[1] ?? '').toLowerCase();
    if (params.has(name)) return undefined;
    params.set(name, part[2] ?? part[3] ?? '');
    rest = rest.slice(part[0].length);
  }
  const scope = params.get('scope');
  return params.get('error') === 'insufficient_scope' && scope !== undefined && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope) ? scope : undefined;
}

interface ProviderErrorFacts {
  readonly codes: readonly string[];
  readonly message?: string;
}

/**
 * The structured codes and message of a Google or Graph error body. Google:
 * `error.errors[].reason`, `error.status`, `error.details[].reason`. Graph:
 * `error.code`, `error.innerError.code`. A body that is not JSON has no codes.
 */
function providerErrorFacts(bodyText: string): ProviderErrorFacts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { codes: [] };
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (error === null || typeof error !== 'object') return { codes: [] };
  const record = error as {
    code?: unknown; status?: unknown; message?: unknown;
    errors?: unknown; details?: unknown; innerError?: unknown;
  };
  const codes: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) codes.push(value);
  };
  push(record.code);
  push(record.status);
  for (const list of [record.errors, record.details]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) push((entry as { reason?: unknown } | null)?.reason);
  }
  push((record.innerError as { code?: unknown } | null)?.code);
  return {
    codes,
    ...(typeof record.message === 'string' && record.message.length > 0 ? { message: record.message.slice(0, 200) } : {}),
  };
}

/** Map a non-OK response to a named degraded state. */
export async function errorFromResponse(
  res: HttpResponse,
  provider: CalendarProviderId,
  operation: CalendarOperation = 'list-events',
): Promise<CalendarApiError> {
  const bodyText = await res.text().catch(() => '');
  const label = PROVIDER_LABEL[provider];
  // The control that signs it in again: its row on the Calendar accounts tab (never a line to type).
  const reconnect = `"sign in" on its row of the Calendar accounts tab in Mail, calendar and channels`;
  if (res.status === 401) {
    return new CalendarApiError({
      kind: 'reconnect-needed',
      detail: `${label} rejected the access token (401). Reconnect the account with ${reconnect}.`,
    });
  }
  const facts = providerErrorFacts(bodyText);
  const rateCode = facts.codes.find((code) => RATE_LIMIT_CODES.has(code));
  if (res.status === 429 || (res.status === 403 && rateCode !== undefined)) {
    const waitMs = retryAfterMs(res);
    return new CalendarApiError({
      kind: 'rate-limited',
      retryAfterMs: waitMs,
      detail: `${label} is limiting requests (${String(res.status)}${rateCode ? ` ${rateCode}` : ''}). Try again in ${String(Math.max(1, Math.ceil(waitMs / 1000)))} s.`,
    });
  }
  if (res.status === 403) {
    const challenged = challengedScope(res.header('www-authenticate') ?? '');
    const scopeCode = facts.codes.find((code) => SCOPE_CODES.has(code));
    if (challenged !== undefined || scopeCode !== undefined) {
      const missingScope = challenged ?? requiredCalendarScope(provider, operation);
      return new CalendarApiError({
        kind: 'insufficient-scope',
        missingScope,
        detail: `${label} refused the request (403${scopeCode ? ` ${scopeCode}` : ''}): the connection has not been granted ${missingScope}. `
          + `Reconnect with ${reconnect} and approve that access.`,
      });
    }
    return new CalendarApiError({
      kind: 'provider-error',
      status: 403,
      detail: `${label} refused the request (403${facts.codes[0] ? ` ${facts.codes[0]}` : ''})${facts.message ? `: ${facts.message}` : ''}.`,
    });
  }
  return new CalendarApiError({
    kind: 'provider-error',
    status: res.status,
    detail: `${label} returned ${String(res.status)}${facts.message ? `: ${facts.message}` : bodyText ? `: ${bodyText.slice(0, 200)}` : ''}.`,
  });
}

/** One bearer-authorized request as the clients issue it. */
export interface AuthedRequestInput {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly token: string;
  readonly operation: CalendarOperation;
  readonly body?: unknown;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/** Send a bearer-authorized request; a non-OK answer throws its named CalendarApiError. */
async function sendAuthed(
  fetchImpl: HttpFetch,
  provider: CalendarProviderId,
  input: AuthedRequestInput,
  options: CalendarRequestOptions,
): Promise<HttpResponse> {
  options.signal?.throwIfAborted();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
    Accept: 'application/json',
    ...input.extraHeaders,
  };
  if (input.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: HttpResponse;
  try {
    res = await fetchImpl({
      url: input.url,
      method: input.method,
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    options.signal?.throwIfAborted();
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new CalendarApiError({
      kind: 'network-error',
      detail: timedOut
        ? `${PROVIDER_LABEL[provider]} did not answer in time. Try again later.`
        : `Reaching ${PROVIDER_LABEL[provider]} failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  options.signal?.throwIfAborted();
  if (!res.ok) throw await errorFromResponse(res, provider, input.operation);
  return res;
}

/** Issue a bearer-authorized read, throwing a CalendarApiError on failure. */
export async function authedRequest(
  fetchImpl: HttpFetch,
  provider: CalendarProviderId,
  input: AuthedRequestInput,
  options: CalendarRequestOptions = {},
): Promise<unknown> {
  const res = await sendAuthed(fetchImpl, provider, input, options);
  try {
    return await res.json();
  } catch {
    throw new CalendarApiError({
      kind: 'provider-error',
      status: res.status,
      detail: `${PROVIDER_LABEL[provider]} answered ${String(res.status)} with a body that is not JSON. Try again later.`,
    });
  }
}

/**
 * Issue a bearer-authorized write. The provider has accepted it once this
 * returns, so an unreadable body is not a failure: it comes back as `body:
 * undefined` with the `Location` header, and the caller reports the event as
 * created rather than inviting a retry that would make a duplicate.
 */
export async function authedWrite(
  fetchImpl: HttpFetch,
  provider: CalendarProviderId,
  input: AuthedRequestInput,
  options: CalendarRequestOptions = {},
): Promise<{ readonly body: unknown; readonly location?: string }> {
  const res = await sendAuthed(fetchImpl, provider, input, options);
  const location = res.header('location') ?? undefined;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { body, ...(location ? { location } : {}) };
}
