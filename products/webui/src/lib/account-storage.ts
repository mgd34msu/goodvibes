/**
 * account-storage.ts, what this browser keeps for the person signed in: nothing of one signed-in person reaches the
 * next one in the same browser (a shared kiosk, a tab where the owner signed out and a member signed in).
 *
 * Every key the web UI writes for a person is kept under that person (the principal the readable sign-in marker names,
 * client-lifetime.ts), read only while that person is signed in, and removed at sign-out (goodvibes.ts `signOut`).
 * A value written before this record, under the bare key, is no one's: it is never read, and goes at the first
 * sign-out. Module state built from these keys (the project in use, a new chat's "No project") is read again when the
 * signed-in person changes (place-project.ts).
 *
 * The sweep of every key the web UI stores:
 *   kept for the person (here):
 *     - `goodvibes.places.project`: the project chosen in the places (place-project.ts);
 *     - `goodvibes.webui.companionSessions`, `goodvibes.webui.activeCompanionSessionId`: the web chats listed and the
 *       one open (companion-chat.ts);
 *     - `goodvibes.webui.preferences`: line numbers, wrapping, reduced motion, the memory chip, the setup steps put off,
 *       and the agreement to dictate with the browser's own speech service (ui-preferences.ts);
 *     - `goodvibes.webui.theme`: the theme (theme.ts);
 *     - `goodvibes.webui.sidebar`: the sidebar collapsed, pinned and its width (ShellContext.tsx);
 *     - `goodvibes.webui.stepup.credential`: the passkey this browser registered, a hint (stepup.ts).
 *   kept per person already, and cleared at sign-out (sessionStorage and IndexedDB, keyed by daemon and account):
 *     - `goodvibes.held-input:<daemon>:<account>` (held-input.ts), the chat drafts (chat-drafts.ts, its sessionStorage
 *       keys and its `goodvibes-chat-drafts` IndexedDB).
 *   the browser's own, not a person's (kept):
 *     - `goodvibes.webui.update-reloaded`, `goodvibes-preload-reload` (sessionStorage): the page reloaded once for an
 *       update or a failed chunk;
 *     - `goodvibes.webui.push.subscriptionId`, `goodvibes.webui.push.deviceId`, `goodvibes.webui.push.removalPending`,
 *       `goodvibes.webui.push.subscriber`, `goodvibes.webui.push.remakeAtSignIn`: this browser's push subscription
 *       (push-client.ts), which belongs to the person signed in: let go at sign-out (its daemon record removed, its
 *       endpoint dropped) and made again for whoever signs in next;
 *     - `goodvibes.webui.phoneNode`, `goodvibes.webui.phoneNode.executed`: this browser as a paired phone node, held
 *       by its own peer credential (phone-node-client.ts);
 *     - the native intake and execution journals (IndexedDB, native-intake-journal.ts, native-execution-journal.ts):
 *       written by no screen of the web UI.
 */
import { currentIdentityKey, heldBearerSync, readSignedInIdentity } from './client-lifetime';

/** Every key the web UI keeps for the person signed in. */
export const ACCOUNT_STORAGE_KEYS = [
  'goodvibes.places.project',
  'goodvibes.webui.companionSessions',
  'goodvibes.webui.activeCompanionSessionId',
  'goodvibes.webui.preferences',
  'goodvibes.webui.theme',
  'goodvibes.webui.sidebar',
  'goodvibes.webui.stepup.credential',
] as const;

/** Who is signed in, as a storage suffix: the marker's principal; on the relay route the sign-in held in memory; '' when nobody is. */
function accountSuffix(): string {
  const principal = readSignedInIdentity()?.principal;
  if (principal) return `@${encodeURIComponent(principal)}`;
  // The relay route's sign-in (in memory, forgotten at reload): its own keys, gone with it.
  return heldBearerSync() !== null ? `@relay:${encodeURIComponent(currentIdentityKey())}` : '@nobody';
}

/** The storage key `base` has for the person signed in now. */
export function accountKey(base: (typeof ACCOUNT_STORAGE_KEYS)[number]): string {
  return `${base}${accountSuffix()}`;
}

function localStore(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/** Whose keys are read now (see {@link clearAccountStorage}). */
export function accountStorageOwner(): string {
  return accountSuffix();
}

/**
 * Sign-out: every key kept for the person signing out goes (`owner`, read with {@link accountStorageOwner} while the
 * sign-in marker still names them; again once the sign-out ends, for what a screen wrote meanwhile), every bare key
 * written before this record (whoever's it was), and what was written while nobody was signed in.
 */
export function clearAccountStorage(owner: string = accountSuffix()): void {
  const storage = localStore();
  if (!storage) return;
  for (const base of ACCOUNT_STORAGE_KEYS) {
    for (const key of [`${base}${owner}`, base, `${base}@nobody`]) {
      try { storage.removeItem(key); } catch { /* nothing kept */ }
    }
  }
}
