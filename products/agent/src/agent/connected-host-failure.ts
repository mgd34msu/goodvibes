/**
 * connected-host-failure.ts, the result-value reading of a failed connected-host
 * call for the schedule clients that still build their own platform client.
 *
 * It reads the same facts the connected-host client does (connected-host-client.ts):
 * the HTTP status, the errno code and the error's own structured fields. Never a
 * model, never the wording. A 404 gets one `/status` probe, bounded at 3 s, to
 * tell a host older than this Agent from nothing listening at all.
 */
import { categoryForCode, categoryForStatus, EngineErrorCodes, GoodVibesError, httpStatusOf } from '@goodvibes-jev/engine/errors';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { isHostFailure } from './connected-host-client.ts';
import type { AgentConnectedHostConnection } from './routine-schedule-promotion.ts';

/** Why a connected-host call failed, shared by schedules and operator gateway callers. */
export interface ConnectedHostFailure<Route extends string> {
  readonly ok: false;
  readonly kind:
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  /** `<what failed>: <cause>; <next step>`. */
  readonly error: string;
  readonly route: Route;
  readonly baseUrl?: string;
}

const STATUS_PROBE_DEADLINE_MS = 3_000;

async function hostAnswersStatus(connection: AgentConnectedHostConnection): Promise<boolean> {
  try {
    const response = await fetch(`${connection.baseUrl}/status`, {
      headers: connection.token ? { authorization: `Bearer ${connection.token}` } : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(STATUS_PROBE_DEADLINE_MS),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

function errnoCode(error: unknown): string | undefined {
  for (const value of [(error as { cause?: unknown } | null)?.cause, error]) {
    const code = (value as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}

/**
 * Classify a failed connected-host call from its status, errno and structured
 * fields. An error that carries none of them is reported verbatim as a host
 * error. No failure classification retries the call.
 */
export async function classifyConnectedHostError<Route extends string>(
  error: unknown,
  connection: AgentConnectedHostConnection,
  options: { readonly route: Route; readonly incompatibleMessage: string; readonly site?: string },
): Promise<ConnectedHostFailure<Route>> {
  const base = { ok: false as const, route: options.route, baseUrl: connection.baseUrl };
  // A cancelled call is reported as a host error here: this shape predates the cancelled kind and its callers render by kind.
  if (isHostFailure(error)) return { ...base, kind: error.kind === 'cancelled' ? 'connected_host_error' : error.kind, error: error.message };
  const cause = summarizeError(error);
  const record = (error ?? {}) as { name?: unknown; code?: unknown };
  if (record.name === 'AbortError' || record.code === EngineErrorCodes.CANCELLED) {
    return { ...base, kind: 'connected_host_error', error: `${options.route}: the call was cancelled (${cause}); repeat it if it is still wanted` };
  }
  const status = httpStatusOf(error);
  const category = status !== undefined
    ? categoryForStatus(status)
    : error instanceof GoodVibesError && error.category !== 'unknown'
      ? error.category
      : categoryForCode(errnoCode(error)) ?? (record.name === 'TimeoutError' ? 'timeout' : undefined);
  if (category === 'authentication' || category === 'authorization' || category === 'permission') {
    return { ...base, kind: 'auth_required', error: `${options.route}: the connected host refused the credential (${cause}); pair this Agent with the host again or provision a fresh connected-host token, then retry` };
  }
  if (category === 'not_found') {
    return await hostAnswersStatus(connection)
      ? { ...base, kind: 'connected_host_incompatible', error: `${options.incompatibleMessage} (${cause}); update GoodVibes on the host to the version this Agent was built with` }
      : { ...base, kind: 'connected_host_route_unavailable', error: `${options.route}: nothing at ${connection.baseUrl} served the route or /status (${cause}); check controlPlane.host and controlPlane.port` };
  }
  if (category === 'network' || category === 'timeout') {
    return { ...base, kind: 'connected_host_unavailable', error: `${options.route}: the connected host at ${connection.baseUrl} could not be reached (${cause}); start the GoodVibes daemon or check controlPlane.host and controlPlane.port, then check whether the change happened before repeating it` };
  }
  return { ...base, kind: 'connected_host_error', error: `${options.route}: ${cause}` };
}
