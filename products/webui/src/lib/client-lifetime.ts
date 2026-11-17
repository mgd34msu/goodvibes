import { createBrowserTokenStore } from '@goodvibes-jev/engine/platform/auth';

export const WEBUI_TOKEN_STORE_KEY = 'goodvibes.webui.token';
export const RELAY_PAIRING_STORAGE_KEY = 'goodvibes.webui.relayPairing';
// The token and the relay pairing are the identity. The token's expiry is not: the daemon
// extends a sign-in session while it is used, and moving the stored expiry of the same token
// must not start a new generation (that would drop every cache and in-flight action).
const identityKeys = [WEBUI_TOKEN_STORE_KEY, RELAY_PAIRING_STORAGE_KEY];
const EXPIRY_KEY = `${WEBUI_TOKEN_STORE_KEY}.expiresAt`;

/** Local generation only. Credentials and pairing material never leave this module. */
export interface ClientLifetime { readonly revision: number }
let lifetime: ClientLifetime = Object.freeze({ revision: 0 });
const listeners = new Set<() => void>();
const identity = (): readonly (string | null)[] | undefined => {
  try {
    const storage = globalThis.localStorage;
    return storage ? identityKeys.map((key) => storage.getItem(key)) : undefined;
  } catch { return undefined; }
};
const readExpiry = (): string | null | undefined => {
  try {
    const storage = globalThis.localStorage;
    return storage ? storage.getItem(EXPIRY_KEY) : undefined;
  } catch { return undefined; }
};
let observed = identity();
let observedExpiry = readExpiry();
// The platform stores optional expiresAt as Unix milliseconds beside the token.
// Absence is supported for pasted tokens; malformed or elapsed expiry cannot
// support a semantic action. This does not assert that a token is authorized.
function canObserveCurrentIdentity(): boolean {
  if (observed === undefined || observedExpiry === undefined) return false;
  if (observedExpiry === null) return true;
  const expiry = Number(observedExpiry);
  return Number.isFinite(expiry) && expiry > 0 && Date.now() < expiry;
}
let observable = canObserveCurrentIdentity();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function watchExpiry(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  const expiry = Number(observedExpiry);
  if (!observable || !Number.isFinite(expiry) || expiry <= Date.now()) return;
  const scheduledFor = lifetime;
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    if (lifetime !== scheduledFor) return;
    getClientLifetime();
    if (lifetime === scheduledFor) watchExpiry();
  }, Math.min(2_147_483_647, Math.max(1, expiry - Date.now())));
  // Browser timers are numbers; offline Node/Bun checks must not be kept alive
  // by a distant token expiry. No server/runtime module enters this graph.
  const handle: unknown = expiryTimer;
  if (typeof handle === 'object' && handle !== null && 'unref' in handle && typeof handle.unref === 'function') handle.unref();
}

export function invalidateClientLifetime(): void {
  lifetime = Object.freeze({ revision: lifetime.revision + 1 });
  observed = identity();
  observedExpiry = readExpiry();
  observable = canObserveCurrentIdentity();
  watchExpiry();
  for (const listener of listeners) {
    try { listener(); } catch { /* An observer cannot prevent other requests from being invalidated. */ }
  }
}

/**
 * The same credential's stored expiry moved. Only a change in whether the credential can be
 * used starts a new generation; an extended session keeps the current one.
 */
function reobserveExpiry(): void {
  observedExpiry = readExpiry();
  const wasObservable = observable;
  observable = canObserveCurrentIdentity();
  if (observable !== wasObservable) invalidateClientLifetime();
  else watchExpiry();
}

/** Reconcile direct storage changes as well as the observed token-store writes. */
export function getClientLifetime(): ClientLifetime {
  const current = identity();
  if (current === undefined ? observed !== undefined
    : observed === undefined || current.some((value, index) => value !== observed?.[index])) invalidateClientLifetime();
  else if (readExpiry() !== observedExpiry) reobserveExpiry();
  // Background tabs can delay timers. Adoption and execution always check the
  // clock synchronously, including exactly at the expiry boundary.
  else if (observable && !canObserveCurrentIdentity()) invalidateClientLifetime();
  return lifetime;
}

export function isClientLifetimeCurrent(snapshot: ClientLifetime): boolean {
  return getClientLifetime() === snapshot && observable;
}

export function subscribeClientLifetime(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Observe the storage seam itself: platform login, setToken, clearToken and expiring
// entries all pass here, including A → B → A before a pending request resumes.
export const tokenStore = createBrowserTokenStore({ key: WEBUI_TOKEN_STORE_KEY, storage: {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem(key, value) {
    const before = globalThis.localStorage.getItem(key);
    globalThis.localStorage.setItem(key, value);
    if (before !== value) {
      if (key === EXPIRY_KEY) reobserveExpiry();
      else invalidateClientLifetime();
    }
  },
  removeItem(key) {
    const before = globalThis.localStorage.getItem(key);
    globalThis.localStorage.removeItem(key);
    if (before !== null) {
      if (key === EXPIRY_KEY) reobserveExpiry();
      else invalidateClientLifetime();
    }
  },
} });

if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== null && event.key !== EXPIRY_KEY && !identityKeys.includes(event.key)) return;
  try { if (event.storageArea !== null && event.storageArea !== window.localStorage) return; }
  catch { /* An unobservable storage identity must invalidate existing readings. */ }
  if (event.key === EXPIRY_KEY) reobserveExpiry();
  else invalidateClientLifetime();
});
watchExpiry();
