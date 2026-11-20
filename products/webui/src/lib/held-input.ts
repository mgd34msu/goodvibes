/**
 * Held input: what a person typed stays until the action carrying it is accepted.
 *
 * The composer may clear its box at send (the person sees the pending entry),
 * but the held entry is the truth until the daemon returns a receipt for it:
 * a refusal puts it back with the reason, and a send whose answer never came
 * (or could not be read) stays held as "may have been sent" and is resent only
 * with its own `clientMessageId`, so the daemon answers a resend of a message
 * it already recorded with the first one's receipt. A held entry is matched to
 * a server message by `clientMessageId` only, never by text and time.
 *
 * The store sits above every mounted pane (module scope), one per daemon and
 * account, and is mirrored to sessionStorage under that daemon and account:
 * it survives a reload of the tab, never crosses accounts, and is cleared on
 * sign-out ({@link clearHeldInputs}). The terminal products keep the same
 * contract in memory (`@goodvibes/engine/terminal-shell/held-input`).
 *
 * Cost: memory and one sessionStorage write per change; no request.
 */
import { currentIdentityKey } from './client-lifetime';

export interface HeldAttachment {
  readonly name: string;
  /** Set as the file's upload succeeds; a resend uploads only the files without one. */
  readonly artifactId?: string;
}

export interface HeldInput {
  /** Minted once when the input is held; every resend uses it. */
  readonly clientMessageId: string;
  readonly sessionId: string | 'new-chat';
  readonly text: string;
  readonly attachments: readonly HeldAttachment[];
  readonly flags: { readonly steer?: true; readonly turnId?: string };
  /** `sending`: on its way or being resent; `refused`: the daemon said no (back in the composer); `unknown`: no readable answer, may have been sent. */
  readonly state: 'sending' | 'refused' | 'unknown';
  readonly reason?: string;
}

export interface HeldInputs {
  hold(input: Omit<HeldInput, 'clientMessageId' | 'state'>): HeldInput;
  /** The server returned a receipt (messageId / input id): the entry is dropped. */
  accepted(clientMessageId: string): void;
  /** Refused (4xx with a refusal): the entry goes back to the composer with the reason. */
  refused(clientMessageId: string, reason: string): HeldInput | undefined;
  /** No answer, or an unreadable one: kept, shown as "may have been sent", resent only with its own id. */
  unknown(clientMessageId: string, reason: string): void;
  /** A resend of the entry starts: it is `sending` again, under the same id. */
  resending(clientMessageId: string): HeldInput | undefined;
  /** One attachment's upload succeeded: its artifact id is kept on the entry. */
  attachmentUploaded(clientMessageId: string, name: string, artifactId: string): void;
  get(clientMessageId: string): HeldInput | undefined;
  list(sessionId: string): readonly HeldInput[];
  /** A new chat's held entry moves to the session the daemon created for it. */
  moveToSession(clientMessageId: string, sessionId: string): void;
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/** Whose held input this is: the daemon the page talks to and the account signed in to it. */
export interface HeldInputScope {
  readonly daemon: string;
  readonly account: string;
}

const STORAGE_PREFIX = 'goodvibes.held-input';

function storageKey(scope: HeldInputScope): string {
  return `${STORAGE_PREFIX}:${scope.daemon}:${scope.account}`;
}

function sessionStore(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

function isHeldInput(value: unknown): value is HeldInput {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.clientMessageId === 'string' && typeof entry.sessionId === 'string' && typeof entry.text === 'string'
    && Array.isArray(entry.attachments) && (entry.state === 'sending' || entry.state === 'refused' || entry.state === 'unknown');
}

function readStored(storage: Storage | null, key: string): Map<string, HeldInput> {
  const entries = new Map<string, HeldInput>();
  if (!storage) return entries;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        // A send that was on its way when the tab reloaded has no answer this page can read: it may have been sent.
        if (isHeldInput(entry)) entries.set(entry.clientMessageId, entry.state === 'sending' ? { ...entry, state: 'unknown', reason: 'The page reloaded before the answer arrived' } : entry);
      }
    }
  } catch { /* an unreadable mirror holds nothing */ }
  return entries;
}

/**
 * A send id of 32 hex digits from getRandomValues: `crypto.randomUUID` exists
 * only on a secure origin, and a daemon reached at a LAN address is not one.
 * It fits the daemon's one rule for client keys (letters, digits, `.`, `_`, `:`, `-`).
 */
export function newClientMessageId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A held-input store over `storage` (null keeps it in memory only). */
export function createHeldInputs(scope: HeldInputScope, storage: Storage | null = sessionStore(), mintId: () => string = newClientMessageId): HeldInputs {
  const key = storageKey(scope);
  const entries = readStored(storage, key);
  const listeners = new Set<() => void>();
  const changed = (): void => {
    if (storage) {
      try {
        if (entries.size === 0) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify([...entries.values()]));
      } catch { /* a full or blocked storage keeps the entries in memory */ }
    }
    for (const listener of [...listeners]) listener();
  };
  const update = (id: string, change: (entry: HeldInput) => HeldInput): HeldInput | undefined => {
    const entry = entries.get(id);
    if (!entry) return undefined;
    const next = change(entry);
    entries.set(id, next);
    changed();
    return next;
  };
  return {
    hold(input) {
      const held: HeldInput = { ...input, clientMessageId: mintId(), state: 'sending' };
      entries.set(held.clientMessageId, held);
      changed();
      return held;
    },
    accepted(clientMessageId) { if (entries.delete(clientMessageId)) changed(); },
    refused(clientMessageId, reason) { return update(clientMessageId, (entry) => ({ ...entry, state: 'refused', reason })); },
    unknown(clientMessageId, reason) { update(clientMessageId, (entry) => ({ ...entry, state: 'unknown', reason })); },
    resending(clientMessageId) {
      return update(clientMessageId, ({ reason: _reason, ...entry }) => ({ ...entry, state: 'sending' }));
    },
    attachmentUploaded(clientMessageId, name, artifactId) {
      update(clientMessageId, (entry) => ({
        ...entry,
        attachments: entry.attachments.map((attachment) => attachment.name === name ? { ...attachment, artifactId } : attachment),
      }));
    },
    get(clientMessageId) { return entries.get(clientMessageId); },
    list(sessionId) { return [...entries.values()].filter((entry) => entry.sessionId === sessionId); },
    moveToSession(clientMessageId, sessionId) { update(clientMessageId, (entry) => ({ ...entry, sessionId })); },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** One store per daemon and account, above every mounted pane. */
const stores = new Map<string, HeldInputs>();

/** The held-input store of this daemon and account (made on first use). */
export function heldInputsFor(scope: HeldInputScope): HeldInputs {
  const key = storageKey(scope);
  let store = stores.get(key);
  if (!store) {
    store = createHeldInputs(scope);
    stores.set(key, store);
  }
  return store;
}

/** Sign-out: drops every held entry of `scope` (or of every account when omitted), in memory and in sessionStorage. */
export function clearHeldInputs(scope?: HeldInputScope): void {
  const storage = sessionStore();
  for (const key of [...stores.keys()]) {
    if (scope && key !== storageKey(scope)) continue;
    stores.delete(key);
    try { storage?.removeItem(key); } catch { /* nothing to clear */ }
  }
  if (!scope && storage) {
    try {
      for (let index = storage.length - 1; index >= 0; index--) {
        const name = storage.key(index);
        if (name?.startsWith(`${STORAGE_PREFIX}:`)) storage.removeItem(name);
      }
    } catch { /* nothing to clear */ }
  } else if (scope) {
    try { storage?.removeItem(storageKey(scope)); } catch { /* nothing to clear */ }
  }
}

/** FNV-1a, 64 bits as hex: tells two sign-ins apart without keeping the credential itself as a storage key. */
function fingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16);
}

/**
 * This page's daemon and account: the origin it talks to and a fingerprint of
 * the sign-in it holds (`identity`: the sign-in marker's generation and the
 * memory hold, never a credential), so a reload keeps held input for the same
 * sign-in and another account never sees it.
 */
export function currentHeldInputScope(identity: string): HeldInputScope {
  let daemon = '';
  try { daemon = globalThis.location?.origin ?? ''; } catch { daemon = ''; }
  return { daemon, account: fingerprint(identity) };
}

/** The held-input store of the daemon and account this page is signed in to now. */
export function heldInputsForThisPage(): HeldInputs {
  return heldInputsFor(currentHeldInputScope(currentIdentityKey()));
}
