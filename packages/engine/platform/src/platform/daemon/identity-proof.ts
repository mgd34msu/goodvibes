import { createHmac, timingSafeEqual } from 'node:crypto';

/** A host sends a fresh random value here before it has shown anything its bearer token. */
export const DAEMON_CHALLENGE_HEADER = 'x-goodvibes-challenge';
/** A daemon that holds the shared token answers a challenge with this proof on every answer, a 401 included. */
export const DAEMON_PROOF_HEADER = 'x-goodvibes-proof';

/** The port the daemon listens on, the one {@link DAEMON_PROOF_HEADER} is bound to. */
export const DAEMON_PROOF_PORT_HEADER = 'x-goodvibes-proof-port';
/**
 * Proofs bound to the port of each public address the daemon declares as its
 * own (`controlPlane.publicBaseUrl`, `web.publicBaseUrl`, which a Tailscale serve
 * sets), comma-separated, so a host that dials the daemon through one of them
 * (https 443 fronting 3421, a reverse proxy) can verify the answer.
 */
export const DAEMON_PUBLIC_PROOFS_HEADER = 'x-goodvibes-public-proofs';

const MAX_CHALLENGE_LENGTH = 128;
const MAX_PUBLIC_PROOFS = 8;

/**
 * The proof is an HMAC keyed by the shared token over the challenge and the
 * TCP port: the daemon uses the port it listens on (and the ports of the public
 * addresses it declares), the host the port it dialled. Only a holder of the token can produce it, it cannot be replayed for
 * another challenge, and a process on another port that forwards the challenge
 * to the real daemon gets back a proof that does not verify for the port the
 * host dialled, so the host never sends that process its token.
 */
export function createDaemonIdentityProof(token: string, challenge: string, port: number): string {
  return createHmac('sha256', token).update(`goodvibes-daemon-identity\n${port}\n${challenge}`).digest('hex');
}

/** `port` is the port the caller dialled. */
export function isValidDaemonIdentityProof(token: string, challenge: string, proof: string | null, port: number): boolean {
  if (!proof) return false;
  const expected = Buffer.from(createDaemonIdentityProof(token, challenge, port));
  const given = Buffer.from(proof);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The identity headers a daemon attaches to an answer: the proof for the port
 * it listens on, that port, and one proof for each other port its declared
 * public addresses dial. Empty when the request carried no usable challenge or
 * the daemon has no token.
 */
export function daemonIdentityHeaders(req: Request, token: string | null, listeningPort: number, publicPorts: readonly number[]): Record<string, string> {
  const challenge = req.headers.get(DAEMON_CHALLENGE_HEADER);
  if (!token || !challenge || challenge.length > MAX_CHALLENGE_LENGTH) return {};
  const others = [...new Set(publicPorts)].filter((port) => port !== listeningPort).slice(0, MAX_PUBLIC_PROOFS);
  return {
    [DAEMON_PROOF_HEADER]: createDaemonIdentityProof(token, challenge, listeningPort),
    [DAEMON_PROOF_PORT_HEADER]: String(listeningPort),
    ...(others.length ? { [DAEMON_PUBLIC_PROOFS_HEADER]: others.map((port) => createDaemonIdentityProof(token, challenge, port)).join(',') } : {}),
  };
}

/**
 * Whether an answer proves it came from the daemon that holds `token`, for a
 * host that dialled `dialled`:
 *  - the proof verifies for the dialled port (the daemon listens there), or
 *  - a public proof verifies for it (the address is one the daemon declares as
 *    its own: a Tailscale serve, a reverse proxy), or
 *  - the address is https and the proof verifies for the port the daemon says
 *    it listens on: TLS already proved the server holds that name's
 *    certificate, so a forwarder on another port cannot stand in for it.
 * Over plain http the proof stays bound to the dialled port, so a process on
 * another port that relays the challenge never receives the token.
 */
export function verifyDaemonIdentityAnswer(
  token: string,
  challenge: string,
  headers: Pick<Headers, 'get'>,
  dialled: { readonly port: number; readonly scheme: 'http' | 'https' },
): boolean {
  const proof = headers.get(DAEMON_PROOF_HEADER);
  if (isValidDaemonIdentityProof(token, challenge, proof, dialled.port)) return true;
  const publicProofs = headers.get(DAEMON_PUBLIC_PROOFS_HEADER)?.split(',').slice(0, MAX_PUBLIC_PROOFS) ?? [];
  if (publicProofs.some((entry) => isValidDaemonIdentityProof(token, challenge, entry.trim(), dialled.port))) return true;
  if (dialled.scheme !== 'https') return false;
  const stated = Number(headers.get(DAEMON_PROOF_PORT_HEADER));
  return Number.isInteger(stated) && stated > 0 && stated <= 65_535 && isValidDaemonIdentityProof(token, challenge, proof, stated);
}

/** The TCP port a URL dials: its explicit port, or the scheme's default. */
export function dialledPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined;
  } catch { return undefined; }
}
