import { createHmac, timingSafeEqual } from 'node:crypto';

/** A host sends a fresh random value here before it has shown anything its bearer token. */
export const DAEMON_CHALLENGE_HEADER = 'x-goodvibes-challenge';
/** A daemon that holds the shared token answers a challenge with this proof on every answer, a 401 included. */
export const DAEMON_PROOF_HEADER = 'x-goodvibes-proof';

const MAX_CHALLENGE_LENGTH = 128;

/**
 * The proof is an HMAC keyed by the shared token over the challenge and the
 * TCP port: the daemon uses the port it listens on, the host the port it
 * dialled. Only a holder of the token can produce it, it cannot be replayed for
 * another challenge, and a process on another port that forwards the challenge
 * to the real daemon gets back a proof that does not verify for the port the
 * host dialled, so the host never sends that process its token.
 */
export function createDaemonIdentityProof(token: string, challenge: string, port: number): string {
  return createHmac('sha256', token).update(`goodvibes-daemon-identity\n${port}\n${challenge}`).digest('hex');
}

/**
 * The proof to attach to an answer, or null when the request carried no usable
 * challenge or the daemon has no token. `port` is the port this daemon listens on.
 */
export function answerDaemonChallenge(req: Request, token: string | null, port: number): string | null {
  const challenge = req.headers.get(DAEMON_CHALLENGE_HEADER);
  if (!token || !challenge || challenge.length > MAX_CHALLENGE_LENGTH) return null;
  return createDaemonIdentityProof(token, challenge, port);
}

/** `port` is the port the caller dialled. */
export function isValidDaemonIdentityProof(token: string, challenge: string, proof: string | null, port: number): boolean {
  if (!proof) return false;
  const expected = Buffer.from(createDaemonIdentityProof(token, challenge, port));
  const given = Buffer.from(proof);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The TCP port a URL dials: its explicit port, or the scheme's default. */
export function dialledPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : undefined;
  } catch { return undefined; }
}
