import {
  categoryForCode, categoryForStatus, GoodVibesError, httpStatusOf,
  isKnownErrorCode, readFailure, EngineErrorCodes, type ErrorCategory,
} from '@goodvibes-jev/engine/errors';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { AgentConnectedHostConnection } from './routine-schedule-promotion.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/** Why a connected-host call failed, shared by schedules and operator gateway callers. */
export interface ConnectedHostFailure<Route extends string> {
  readonly ok: false;
  readonly kind:
    | 'auth_required'
    | 'connected_host_unavailable'
    | 'connected_host_incompatible'
    | 'connected_host_route_unavailable'
    | 'connected_host_error';
  readonly error: string;
  readonly route: Route;
  readonly baseUrl?: string;
}

async function fetchConnectedHostStatus(connection: AgentConnectedHostConnection): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly body: unknown;
}> {
  try {
    const response = await fetch(`${connection.baseUrl}/status`, {
      headers: connection.token ? { authorization: `Bearer ${connection.token}` } : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text.trim() ? JSON.parse(text) as unknown : {};
    } catch {
      body = text;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: summarizeError(error) };
  }
}

/** Structure is authoritative; only otherwise unclassified wording needs judgment. */
async function connectedHostFailureCategory(error: unknown, message: string, site: string): Promise<ErrorCategory> {
  const record = isRecord(error) ? error : {};
  const code = readString(record, 'code') ?? undefined;
  const cause = isRecord(record.cause) ? record.cause : {};
  // Cancellation is an explicit stop, never evidence of a dead host or permission to retry.
  if (code === EngineErrorCodes.CANCELLED || record.name === 'AbortError'
    || cause.code === EngineErrorCodes.CANCELLED || cause.name === 'AbortError') return 'unknown';
  const status = httpStatusOf(error);
  if (status !== undefined) return categoryForStatus(status) ?? 'unknown';
  switch (code) {
    case EngineErrorCodes.AUTH_REQUIRED:
    case EngineErrorCodes.TOKEN_EXPIRED: return 'authentication';
    case EngineErrorCodes.PERMISSION_DENIED: return 'authorization';
    case EngineErrorCodes.NOT_FOUND:
    case EngineErrorCodes.METHOD_NOT_FOUND: return 'not_found';
    case EngineErrorCodes.NETWORK_UNREACHABLE: return 'network';
    case EngineErrorCodes.TIMEOUT: return 'timeout';
  }
  if (error instanceof GoodVibesError && error.category !== 'unknown') return error.category;
  const errnoCategory = categoryForCode(code) ?? categoryForCode(readString(cause, 'code') ?? undefined);
  if (errnoCategory !== undefined) return errnoCategory;
  if (record.name === 'TimeoutError') return 'timeout';
  // Other declared platform failures (validation, billing, conflict, etc.) are not transport failures.
  if (code !== undefined && isKnownErrorCode(code) && code !== EngineErrorCodes.UNKNOWN) return 'unknown';
  if (!message.trim()) return 'unknown';
  try {
    return (await readFailure({
      message,
      code,
      errorName: readString(record, 'name') ?? undefined,
    }, site)).category;
  } catch {
    // Reporting a failed connected-host call must still work before bootstrap or if judgment is unavailable.
    // Keep the original failure observable; do not guess, retry or grant authority.
    return 'unknown';
  }
}

/**
 * Connected-host callers share typed engine failure classification. A missing
 * route gets one read-only status probe to distinguish an old host from an
 * unavailable route; no failure classification retries the mutation.
 */
export async function classifyConnectedHostError<Route extends string>(
  error: unknown,
  connection: AgentConnectedHostConnection,
  options: { readonly route: Route; readonly incompatibleMessage: string; readonly site: string },
): Promise<ConnectedHostFailure<Route>> {
  const message = summarizeError(error);
  const category = await connectedHostFailureCategory(error, message, options.site);
  const base = { ok: false, error: message, route: options.route, baseUrl: connection.baseUrl } as const;
  if (category === 'authentication' || category === 'authorization' || category === 'permission') {
    return { ...base, kind: 'auth_required' };
  }
  if (category === 'not_found') {
    const connectedHost = await fetchConnectedHostStatus(connection);
    if (connectedHost.ok) {
      return { ...base, kind: 'connected_host_incompatible', error: options.incompatibleMessage };
    }
    return { ...base, kind: 'connected_host_route_unavailable' };
  }
  if (category === 'network' || category === 'timeout') {
    return { ...base, kind: 'connected_host_unavailable' };
  }
  return { ...base, kind: 'connected_host_error' };
}

