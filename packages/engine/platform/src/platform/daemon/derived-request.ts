/**
 * derived-request.ts, the same daemon request with another body.
 *
 * What the listener and the auth gate learned about a request (its principal,
 * its client address, whether it came from the daemon's own machine) is bound
 * to that Request object. A request rebuilt around a new body (an upload read
 * back from a spool file) carries those bindings over, so every later check
 * answers for it exactly as for the original.
 */
import { bindClientAddress, bindLocalOrigin, clientAddressOf, isLocalOrigin } from './client-address.js';
import { bindRequestContext, requestContextOf } from './request-context.js';

export function deriveRequestWithBody(from: Request, body: ReadableStream<Uint8Array>): Request {
  // `duplex` is required by the fetch standard for a streamed request body and is not in every RequestInit type.
  const init: RequestInit & { readonly duplex: 'half' } = { method: from.method, headers: from.headers, body, signal: from.signal, duplex: 'half' };
  const next = new Request(from.url, init);
  const context = requestContextOf(from);
  if (context) bindRequestContext(next, context);
  const address = clientAddressOf(from);
  if (address !== undefined) bindClientAddress(next, address);
  if (isLocalOrigin(from)) bindLocalOrigin(next);
  return next;
}
