import { createHmac, timingSafeEqual } from 'node:crypto';

/** A host sends a fresh random value here before it has shown anything its bearer token. */
export const DAEMON_CHALLENGE_HEADER = 'x-goodvibes-challenge';
/** A daemon that holds the shared token answers a challenge with this proof, even on a 401. */
export const DAEMON_PROOF_HEADER = 'x-goodvibes-proof';

const MAX_CHALLENGE_LENGTH = 128;

/** The proof is an HMAC keyed by the shared token, so only a holder of the token can produce it and it cannot be replayed for another challenge. */
export function createDaemonIdentityProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(`goodvibes-daemon-identity\n${challenge}`).digest('hex');
}

/** The proof to attach to a refusal, or null when the request carried no usable challenge or the daemon has no token. */
export function answerDaemonChallenge(req: Request, token: string | null): string | null {
  const challenge = req.headers.get(DAEMON_CHALLENGE_HEADER);
  if (!token || !challenge || challenge.length > MAX_CHALLENGE_LENGTH) return null;
  return createDaemonIdentityProof(token, challenge);
}

export function isValidDaemonIdentityProof(token: string, challenge: string, proof: string | null): boolean {
  if (!proof) return false;
  const expected = Buffer.from(createDaemonIdentityProof(token, challenge));
  const given = Buffer.from(proof);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
