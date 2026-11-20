import type { GoodVibesExpiringTokenStore } from '@goodvibes-jev/engine/platform/auth';

/**
 * Who this page is signed in as, and the generation every cache, reply and in-flight
 * action belongs to. No credential is ever kept where a script could read it later:
 *
 * - Direct route (the page talks to the daemon's own origin): the daemon binds the
 *   credential to an HttpOnly, SameSite=Strict cookie (`POST /api/browser-session`) that
 *   no page script can read. The page sees only the readable marker beside it,
 *   `goodvibes_identity` = `<generation>.<principal, base64url>`, which changes with
 *   every sign-in and goes with every sign-out, so this tab and every other tab can tell
 *   who is signed in and that the identity changed without seeing the token.
 * - Relay route: the relay tunnel builds each request in the page, so the bearer is
 *   held in memory here, for the life of the page. A reload forgets it and asks to sign
 *   in again. The relay pairing (relay-pairing.ts) is held the same way.
 *
 * Nothing token-shaped is written to localStorage, sessionStorage or IndexedDB.
 */
export const IDENTITY_MARKER_COOKIE = 'goodvibes_identity';

/** Local generation only. Credentials and pairing material never leave this module. */
export interface ClientLifetime { readonly revision: number }
let lifetime: ClientLifetime = Object.freeze({ revision: 0 });
const listeners = new Set<() => void>();

/** The marker cookie's value, '' when signed out on the direct route (or outside a browser). */
function readMarker(): string {
  try {
    const cookies = globalThis.document?.cookie ?? '';
    for (const segment of cookies.split(';')) {
      const [name, ...value] = segment.split('=');
      if (name?.trim() === IDENTITY_MARKER_COOKIE) return value.join('=').trim();
    }
  } catch { /* No readable cookies: no direct-route identity. */ }
  return '';
}

/** The relay-route bearer, in memory only; `id` names this hold without naming the token. */
let held: { readonly token: string; readonly expiresAt?: number; readonly id: number } | null = null;
let heldSequence = 0;
/** Moves each time the relay pairing changes (relay-pairing.ts), so a pairing change is an identity change. */
let relayGeneration = 0;
let observedMarker = readMarker();

export function invalidateClientLifetime(): void {
  lifetime = Object.freeze({ revision: lifetime.revision + 1 });
  observedMarker = readMarker();
  for (const listener of listeners) {
    try { listener(); } catch { /* An observer cannot prevent other requests from being invalidated. */ }
  }
}

/** Reconciles a sign-in or sign-out this tab or another tab made (the marker cookie moved). One cookie read, no request. */
export function getClientLifetime(): ClientLifetime {
  if (readMarker() !== observedMarker) invalidateClientLifetime();
  return lifetime;
}

export function isClientLifetimeCurrent(snapshot: ClientLifetime): boolean {
  return getClientLifetime() === snapshot;
}

export function subscribeClientLifetime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while this page holds a sign-in: the direct-route marker, or a relay-route bearer in memory. Never a verdict on it. */
export function hasSignInSync(): boolean {
  return readMarker() !== '' || held !== null;
}

/** Who the direct-route marker names, or null; the daemon's auth read stays the authority. */
export function readSignedInIdentity(): { readonly generation: string; readonly principal: string } | null {
  const marker = readMarker();
  const dot = marker.indexOf('.');
  if (dot <= 0) return null;
  try {
    const encoded = marker.slice(dot + 1).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    return { generation: marker.slice(0, dot), principal: new TextDecoder().decode(bytes) };
  } catch {
    return { generation: marker.slice(0, dot), principal: '' };
  }
}

/**
 * Names the sign-in this page holds without containing any credential: the marker's
 * generation, the memory hold's number and the relay pairing's generation. Held input is
 * kept per this key, so another account never sees it.
 */
export function currentIdentityKey(): string {
  return `${readMarker()}|${held?.id ?? ''}|${relayGeneration}`;
}

/** relay-pairing.ts: the pairing changed, which is a change of identity. */
export function noteRelayPairingChanged(): void {
  relayGeneration += 1;
  invalidateClientLifetime();
}

function hold(token: string | null | undefined, expiresAt?: number): void {
  const normalized = token?.trim() || null;
  if (normalized === held?.token && (normalized === null || expiresAt === held?.expiresAt)) return;
  const changed = normalized !== (held?.token ?? null);
  // The same token with a new end is the same sign-in: it keeps its number and generation.
  const id = changed || held === null ? ++heldSequence : held.id;
  held = normalized === null ? null : { token: normalized, ...(expiresAt === undefined ? {} : { expiresAt }), id };
  if (changed) invalidateClientLifetime();
}

/**
 * The platform client's token store: the relay-route bearer in memory, or none. With
 * none, a direct-route request carries the HttpOnly cookie the browser adds by itself.
 */
export const tokenStore: GoodVibesExpiringTokenStore = {
  async getToken() { return held?.token ?? null; },
  async setToken(token) { hold(token); },
  async clearToken() { hold(null); },
  async getTokenEntry() { return held === null ? { token: null } : held.expiresAt === undefined ? { token: held.token } : { token: held.token, expiresAt: held.expiresAt }; },
  async setTokenEntry(token, expiresAt) { hold(token, expiresAt); },
};

// Another tab signing in or out moves the marker cookie: notice it when the browser says
// a cookie changed, and when this tab comes back into view.
if (typeof window !== 'undefined') {
  const reconcile = () => { getClientLifetime(); };
  const cookieStore = (globalThis as { cookieStore?: EventTarget }).cookieStore;
  try { cookieStore?.addEventListener('change', reconcile); } catch { /* Not offered: the focus checks below still run. */ }
  window.addEventListener('focus', reconcile);
  window.addEventListener('pageshow', reconcile);
  document.addEventListener('visibilitychange', reconcile);
}
