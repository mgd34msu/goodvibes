/**
 * daemon-target.ts, a credential can only go to the daemon it is for.
 *
 * A bearer for a daemon is a {@link BoundCredential}: it knows the one daemon
 * origin it was issued for, and the secret is reachable only through
 * {@link bearerFor}, which refuses any URL on another origin. A request,
 * stream or queued operation names its daemon by a {@link DaemonTarget}
 * (origin plus credential), and {@link daemonAuthHeaders} is the only way a
 * client builds the Authorization header, so sending this machine's token, or
 * another daemon's stored token, to the wrong daemon is a thrown
 * `CREDENTIAL_NOT_FOR_TARGET` instead of a request.
 *
 * Choosing the target is the resolver's job (daemon-target-resolver.ts, node
 * side). This file is browser-safe: no `node:` import, so the web UI and the
 * browser SDK entry use the same check.
 */
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { parseDaemonOrigin, type DaemonOrigin } from '../../config/control-plane-base-url.js';
import { sha256Base64Url } from '../../utils/sha256.js';

declare const boundBrand: unique symbol;

/** Where a bound credential came from. */
export type BoundCredentialSource = 'explicit' | 'environment' | 'session' | 'connected' | 'pairing' | 'local-daemon';

/** A bearer that knows the one daemon origin it was issued for. The string is reachable only through {@link bearerFor}. */
export interface BoundCredential {
  readonly [boundBrand]: true;
  /** `DaemonOrigin.baseUrl`: scheme://host[:port], canonical. */
  readonly origin: string;
  readonly source: BoundCredentialSource;
  /** First 12 characters of base64url sha256(token): an identity, never the secret. */
  readonly fingerprint: string;
  /** The epoch of the sign-in the token belongs to, when the source has one. */
  readonly signInEpoch: string | null;
}

/** The daemon a request, stream or queued operation is for. */
export interface DaemonTarget {
  readonly origin: DaemonOrigin;
  /** Null: an unauthenticated probe only. */
  readonly credential: BoundCredential | null;
  /** `${origin.baseUrl}#${credential?.fingerprint ?? 'none'}`; carried by queued work and compared before delivery. */
  readonly id: string;
  /** The origin is one of this machine's daemon origins (decided by the resolver). */
  readonly thisMachine: boolean;
}

/** The secrets, held apart from the credential objects so no serialisation or log of one carries the token. */
const secrets = new WeakMap<BoundCredential, string>();

/** Bind `token` to the daemon at `origin`. Throws on an empty token. */
export function bindCredential(origin: DaemonOrigin, token: string, source: BoundCredentialSource, signInEpoch: string | null = null): BoundCredential {
  const secret = token.trim();
  if (!secret) throw new TypeError('bindCredential: the token is empty.');
  const credential = Object.freeze({
    origin: origin.baseUrl,
    source,
    fingerprint: sha256Base64Url(secret).slice(0, 12),
    signInEpoch,
  }) as BoundCredential;
  secrets.set(credential, secret);
  return credential;
}

/** The daemon origin a URL dials: `ws:`/`wss:` count as the `http:`/`https:` origin they upgrade from. Null when it is not one. */
export function daemonOriginOfUrl(url: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  const protocol = parsed.protocol === 'ws:' ? 'http:' : parsed.protocol === 'wss:' ? 'https:' : parsed.protocol;
  if (protocol !== 'http:' && protocol !== 'https:') return null;
  return parseDaemonOrigin(`${protocol}//${parsed.host}`)?.baseUrl ?? null;
}

/** A daemon credential was about to be sent somewhere other than the daemon it was issued for. Nothing was sent. */
export class CredentialOriginError extends RefusalError {
  readonly credentialOrigin: string;
  readonly requestOrigin: string | null;

  constructor(credentialOrigin: string, requestOrigin: string | null) {
    super(refusal({
      code: 'CREDENTIAL_NOT_FOR_TARGET',
      state: 'nothing was sent',
      reason: `the credential for the daemon at ${credentialOrigin} is never sent to ${requestOrigin ?? 'an address that is not a daemon origin'}`,
      next: [`connect to ${requestOrigin ?? 'that daemon'} with its own token (--token, /setup Network step, or goodvibes-agent setup pair)`],
      retryable: false,
    }), { category: 'authorization', source: 'transport' });
    this.name = 'CredentialOriginError';
    this.credentialOrigin = credentialOrigin;
    this.requestOrigin = requestOrigin;
  }
}

/** The token, for a request to `url` only. Throws {@link CredentialOriginError} when `url` is not on the credential's origin. */
export function bearerFor(credential: BoundCredential, url: string | URL): string {
  const requested = daemonOriginOfUrl(url);
  if (requested !== credential.origin) throw new CredentialOriginError(credential.origin, requested);
  const secret = secrets.get(credential);
  // Only bindCredential makes credentials; a forged object has no secret.
  if (secret === undefined) throw new CredentialOriginError(credential.origin, requested);
  return secret;
}

/** Build a target. `thisMachine` is the resolver's finding, not the caller's guess. */
export function daemonTarget(origin: DaemonOrigin, credential: BoundCredential | null, thisMachine: boolean): DaemonTarget {
  if (credential !== null && credential.origin !== origin.baseUrl) throw new CredentialOriginError(credential.origin, origin.baseUrl);
  return Object.freeze({
    origin,
    credential,
    id: `${origin.baseUrl}#${credential?.fingerprint ?? 'none'}`,
    thisMachine,
  });
}

/**
 * The Authorization header for a request to `url` on `target`, or a thrown
 * {@link CredentialOriginError}: the only way any client builds the header.
 * An unauthenticated target gives no header, and still only for its own origin.
 */
export function daemonAuthHeaders(target: DaemonTarget, url: string | URL): Record<string, string> {
  if (target.credential === null) {
    const requested = daemonOriginOfUrl(url);
    if (requested !== target.origin.baseUrl) throw new CredentialOriginError(target.origin.baseUrl, requested);
    return {};
  }
  return { Authorization: `Bearer ${bearerFor(target.credential, url)}` };
}
