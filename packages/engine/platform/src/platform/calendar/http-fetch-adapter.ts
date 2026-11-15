/**
 * http-fetch-adapter.ts, a pure adapter turning a standard WHATWG `fetch` into the
 * connector's injected HttpFetch boundary. This module references only the global
 * fetch/Response (no node:*), so it stays within the calendar module's purity
 * contract; the actual `fetch` used is supplied by the caller (the agent passes the
 * runtime fetch, tests pass a fake server's fetch).
 */

import type { HttpFetch, HttpRequest, HttpResponse } from './oauth-types.js';

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Default deadlines: a read waits 15 s, a write (token exchange, event create) 60 s. */
export const CALENDAR_READ_DEADLINE_MS = 15_000;
export const CALENDAR_WRITE_DEADLINE_MS = 60_000;

/**
 * Wrap a WHATWG-style fetch into an HttpFetch. Defaults to the global fetch.
 *
 * Every request carries a deadline joined to the caller's signal, so a provider
 * or token endpoint that stops answering ends the call with a `TimeoutError`
 * instead of holding it (and every caller waiting on a shared token refresh)
 * for the runtime's socket timeout.
 */
export function fetchAdapter(
  fetchImpl?: FetchLike,
  deadlines: { readonly readMs?: number; readonly writeMs?: number } = {},
): HttpFetch {
  const impl: FetchLike = fetchImpl ?? ((globalThis as { fetch: FetchLike }).fetch);
  const readMs = deadlines.readMs ?? CALENDAR_READ_DEADLINE_MS;
  const writeMs = deadlines.writeMs ?? CALENDAR_WRITE_DEADLINE_MS;
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const deadline = AbortSignal.timeout(req.method === 'GET' ? readMs : writeMs);
    const signal = req.signal ? AbortSignal.any([req.signal, deadline]) : deadline;
    const res = await impl(req.url, {
      method: req.method,
      signal,
      ...(req.headers ? { headers: { ...req.headers } } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return {
      status: res.status,
      ok: res.ok,
      header: (name: string) => res.headers.get(name),
      json: () => res.json(),
      text: () => res.text(),
    };
  };
}
