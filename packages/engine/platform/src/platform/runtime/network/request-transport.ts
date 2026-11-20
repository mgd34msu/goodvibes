/**
 * request-transport.ts, how a request reached the daemon, for an effect that
 * may only cross some links (a card number never crosses a plain network).
 *
 * The inbound half of the destination rule: `card.enter` is admitted only on
 * `loopback`, `tls` or `tailnet`, and the web UI's card form reads the same
 * answer (pairing.posture.get) so it is never offered where the daemon would
 * refuse it. Read from what the listener bound to the request (its socket
 * peer and whether it came straight from this machine) and the listener's own
 * TLS; forwarding headers count only when the listener trusts a proxy.
 *
 * Imported by path, not through runtime/network/index.ts: daemon/client-address.ts
 * imports that index.
 */
import { isTailnetHost } from '@goodvibes-jev/engine/transport-http/paths';
import { clientAddressOf, isLocalOrigin } from '../../daemon/client-address.js';

export type RequestTransport = 'loopback' | 'tls' | 'tailnet' | 'plain-network';

/** How `req` reached the listener: from this machine, over TLS, over the tailnet, or over a plain network. */
export function requestTransport(req: Request, listener: { readonly tls: boolean; readonly trustProxy: boolean }): RequestTransport {
  if (isLocalOrigin(req)) return 'loopback';
  if (listener.tls) return 'tls';
  const peer = clientAddressOf(req);
  if (peer !== undefined && isTailnetHost(peer)) return 'tailnet';
  // A proxy the owner trusts (tailscale serve, cloudflared) ended TLS before forwarding.
  if (listener.trustProxy && req.headers.get('x-forwarded-proto')?.trim().toLowerCase() === 'https') return 'tls';
  return 'plain-network';
}
