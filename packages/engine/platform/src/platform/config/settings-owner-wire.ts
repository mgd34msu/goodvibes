/**
 * settings-owner-wire.ts: the wire both settings verbs (one change, an import)
 * share with the daemon that owns the settings.
 *
 * Every way a capture or an apply can fail maps to one small set of refusals,
 * each with the state, the reason and the step that gets past it: the daemon
 * is not reachable (start it), the client is not authorised (pair again), the
 * two sides are different versions (update the older one), or the daemon
 * refused with its own reason. Responses are read for the fields this build
 * needs; fields a newer daemon adds are ignored.
 */
import { RefusalError, formatRefusal, readNextSteps, refusal, type Refusal } from '@goodvibes-jev/engine/errors';
import { VERSION } from '../version.js';
import type { DaemonConfigEndpoint } from './daemon-config-route.js';
import { SettingsRefusalError, refusalReasonOf, refusalText } from './settings-refusal.js';

export type SettingsSubject = 'Settings change' | 'Settings import';

const START_DAEMON = 'Start the daemon with `goodvibes-daemon start-service` (or `goodvibes-daemon serve` in a terminal), then check it with `goodvibes-daemon status`';
const PAIR_AGAIN = 'Pair this client with the daemon again (`goodvibes-daemon pair`), or check the token this client sends';
const UPDATE_OLDER = 'Update the older of this client and the daemon so both run the same version; `goodvibes-daemon status` shows the daemon\'s version';
const READ_AND_RETRY = 'Read the setting to see its current value, then request the change again';

/** A refusal thrown by a settings client; its message is the reason and the first next step. */
export function settingsOwnerRefusal(init: Parameters<typeof refusal>[0], cause?: unknown): RefusalError {
  const value = refusal(init);
  const error = new RefusalError(value, cause === undefined ? {} : { cause });
  error.message = formatRefusal(value);
  return error;
}

/** The refusal a settings client threw, when it is one. */
export function settingsOwnerRefusalOf(error: unknown): Refusal | undefined {
  return error instanceof RefusalError ? error.refusal : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The endpoint's base address, or a refusal naming the configured address as unusable. */
export function settingsOwnerBase(subject: SettingsSubject, endpoint: DaemonConfigEndpoint): string {
  let url: URL | undefined;
  try { url = new URL(endpoint.baseUrl); } catch { url = undefined; }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw settingsOwnerRefusal({
      code: 'SETTINGS_OWNER_ENDPOINT_INVALID', state: `${subject.toLowerCase()} not sent; nothing was applied`,
      reason: `The daemon address from ${endpoint.source ?? 'the settings'} is not a plain http or https address`,
      next: ['Set controlPlane.host and controlPlane.port to the daemon\'s address', START_DAEMON], retryable: false,
    });
  }
  return url.href.replace(/\/+$/, '');
}

export function settingsOwnerHeaders(endpoint: DaemonConfigEndpoint): Readonly<Record<string, string>> {
  return Object.freeze({ 'content-type': 'application/json', ...(endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {}) });
}

/** Connection failures that happen before a request leaves this process. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ConnectionRefused', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'FailedToOpenSocket', 'UnableToConnect']);

/**
 * A request that never got an answer. The caller's own abort is rethrown as
 * it is; a refused connection or a timeout is "the daemon is not reachable".
 * `notSent` is true when the request cannot have reached the daemon; for an
 * apply anything else (a timeout, a connection dropped mid-answer) may have
 * been carried out.
 */
export function settingsOwnerTransportFailure(subject: SettingsSubject, error: unknown, options: { readonly signal?: AbortSignal | undefined; readonly url: string; readonly applying: boolean }): { readonly error: RefusalError; readonly notSent: boolean } {
  if (options.signal?.aborted) throw options.signal.reason ?? error;
  const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  const code = error !== null && typeof error === 'object' ? String((error as { code?: unknown }).code ?? '') : '';
  const notSent = !timedOut && NOT_SENT_CODES.has(code);
  const uncertain = options.applying && !notSent;
  return {
    notSent,
    error: settingsOwnerRefusal({
      code: 'DAEMON_UNREACHABLE',
      state: uncertain
        ? `the daemon did not answer; the ${subject.toLowerCase()} may or may not have been applied`
        : `${subject.toLowerCase()} not applied; the daemon was not reached`,
      reason: timedOut ? `The daemon at ${options.url} did not answer in time` : `The daemon at ${options.url} is not reachable`,
      next: uncertain ? [READ_AND_RETRY, START_DAEMON] : [START_DAEMON, 'Check controlPlane.host and controlPlane.port in the settings'],
      retryable: true,
    }, error),
  };
}

/** A daemon answer that is not the success shape this build reads. */
export function settingsOwnerVersionMismatch(subject: SettingsSubject, detail: string, mayHaveApplied: boolean): RefusalError {
  return settingsOwnerRefusal({
    code: 'DAEMON_VERSION_MISMATCH',
    state: mayHaveApplied ? `the daemon answered, but this client cannot read whether the ${subject.toLowerCase()} was applied` : `${subject.toLowerCase()} not applied`,
    reason: `The daemon answered in a form this client (version ${VERSION}) cannot read: ${detail}`,
    next: mayHaveApplied ? [READ_AND_RETRY, UPDATE_OLDER] : [UPDATE_OLDER],
    retryable: false,
  });
}

async function readBody(response: Response): Promise<Record<string, unknown> | undefined> {
  try { const body: unknown = await response.json(); return isRecord(body) ? body : undefined; } catch { return undefined; }
}

/**
 * A capture the daemon did not grant: a precondition refusal keeps its named
 * reason (`stale`, `managed`, ...); everything else is one of the closed set.
 * A capture has no effect, so every one of these left nothing applied.
 */
export async function settingsCaptureRefusal(subject: SettingsSubject, response: Response): Promise<Error> {
  const status = response.status;
  if (status === 401 || status === 403) return notAuthorized(subject, status);
  if (status === 404 || status === 405 || status === 501) return settingsOwnerVersionMismatch(subject, `the daemon has no settings ${subject === 'Settings import' ? 'import' : 'change'} route (status ${status})`, false);
  const body = await readBody(response);
  if (status === 409 && body?.code === 'PAIRING_STORE_FAULTED') {
    return new SettingsRefusalError('pairing-store-faulted', `${subject} refused: the daemon's pairing token store is faulted, so paired and shared-token settings authority is held. Nothing was applied. Retrying will not help until the store is readable again; a failed revoke, rename or grant write holds until the daemon restarts.`);
  }
  const reason = body ? refusalReasonOf(body) : undefined;
  if (status === 409 && reason) return new SettingsRefusalError(reason, refusalText(subject, reason));
  return daemonRefused(subject, status, body, false);
}

function notAuthorized(subject: SettingsSubject, status: number): RefusalError {
  return settingsOwnerRefusal({
    code: 'DAEMON_NOT_AUTHORIZED', state: `${subject.toLowerCase()} not applied`, status, retryable: false,
    reason: status === 401 ? 'The daemon did not accept this client\'s credential' : 'The daemon accepted this client\'s credential but it may not change settings',
    next: [PAIR_AGAIN],
  });
}

function daemonRefused(subject: SettingsSubject, status: number, body: Record<string, unknown> | undefined, mayHaveApplied: boolean): RefusalError {
  const said = typeof body?.error === 'string' && body.error.trim() ? body.error.trim() : `status ${status}`;
  const next = readNextSteps(body?.next) ?? (typeof body?.hint === 'string' && body.hint.trim() ? [body.hint.trim()] : []);
  return settingsOwnerRefusal({
    code: typeof body?.code === 'string' && body.code ? body.code : 'DAEMON_REFUSED',
    state: mayHaveApplied ? `the daemon failed while applying; the ${subject.toLowerCase()} may or may not have been applied` : `${subject.toLowerCase()} not applied`,
    reason: `The daemon refused the ${subject.toLowerCase()}: ${said}`,
    next: next.length > 0 ? next : mayHaveApplied ? [READ_AND_RETRY] : status >= 500 ? ['Check the daemon log, then request the change again'] : [READ_AND_RETRY],
    status,
  });
}

/**
 * What an apply that was not answered with success tells the caller:
 * `refused` with the named precondition reason when the daemon refused before
 * any effect, otherwise a refusal of the closed set and whether anything may
 * have been applied (only a 5xx may have been).
 */
export async function settingsApplyFailure(subject: SettingsSubject, response: Response, refusalCodes: readonly string[]): Promise<{
  readonly refusedBeforeEffect: boolean; readonly reason?: ReturnType<typeof refusalReasonOf>; readonly refusal: Refusal;
}> {
  const status = response.status;
  if (status === 401 || status === 403) return { refusedBeforeEffect: true, refusal: notAuthorized(subject, status).refusal };
  if (status === 404 || status === 405 || status === 501) {
    return { refusedBeforeEffect: true, refusal: settingsOwnerVersionMismatch(subject, `the daemon has no settings apply route (status ${status})`, false).refusal };
  }
  const body = await readBody(response);
  if ((status === 409 || status === 400) && body && refusalCodes.includes(String(body.code))) {
    const reason = refusalReasonOf(body);
    return {
      refusedBeforeEffect: true, ...(reason ? { reason } : {}),
      refusal: reason ? refusal({ code: String(body.code), state: `${subject.toLowerCase()} not applied`, reason: refusalText(subject, reason), next: [READ_AND_RETRY], status })
        : daemonRefused(subject, status, body, false).refusal,
    };
  }
  return { refusedBeforeEffect: status < 500, refusal: daemonRefused(subject, status, body, status >= 500).refusal };
}

/** The joined signal for one request: its timeout and the caller's abort. */
export function settingsOwnerSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

/** Whether `value` holds every field in `fields`; other fields are allowed (a newer daemon may add some). */
export function hasFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every(field => Object.hasOwn(value, field));
}

/** A copy of `value` holding only `fields`, so fields a newer daemon adds never travel further. */
export function pickFields<T extends Record<string, unknown>>(value: T, fields: readonly string[]): T {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]])) as T;
}
