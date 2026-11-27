/**
 * A fetch that sends this program's call context and registration (call-context.ts `programCallHeadersFor`) on every
 * request to this machine's daemon, read again at each request: an event stream reconnecting after the daemon
 * restarted carries the registration of the new connection. The credential is read from the request's own
 * Authorization header. Without it the operator token alone is a script on this machine, and a stream it opens
 * carries none of the owner's events (control-plane/event-reach.ts).
 */
import { programCallHeadersFor } from './call-context.js';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function programFetch<F extends FetchLike>(fetchImpl: F): F {
  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const bearer = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '')?.[1]?.trim();
    let target: string;
    try { target = new URL(url).origin; } catch { return fetchImpl(input, init); }
    for (const [name, value] of Object.entries(await programCallHeadersFor(target, bearer))) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return fetchImpl(input, { ...init, headers });
  };
  return wrapped as F;
}
