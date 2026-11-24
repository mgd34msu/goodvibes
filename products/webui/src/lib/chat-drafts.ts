/**
 * Unsent drafts, one per chat: what is typed in a chat's composer, and the files
 * attached to it, stay with that chat. Changing view, opening another chat and
 * reloading the tab all keep it; another chat never shows it; sending clears it.
 * A new chat (no session yet) has its own draft under {@link NEW_CHAT_DRAFT}.
 *
 * The text is mirrored to sessionStorage under the daemon and account (the scope
 * held input uses, lib/held-input.ts), so a reload keeps it and another account
 * never sees it. Attached files live in memory (a view change keeps them) and are
 * mirrored to IndexedDB, where a browser keeps a File, so a reload keeps them too.
 * Where either store is blocked the draft lives in memory for as long as the tab.
 * Sign-out clears every draft ({@link clearChatDrafts}).
 *
 * Cost: one sessionStorage write per change of the text, one IndexedDB write per
 * change of the attached files; no request.
 */
import { currentIdentityKey } from './client-lifetime';
import { currentHeldInputScope } from './held-input';

/** The draft key of a chat that has no session yet. */
export const NEW_CHAT_DRAFT = 'new-chat';

const TEXT_PREFIX = 'goodvibes.chat-draft';
const DB_NAME = 'goodvibes-chat-drafts';
const FILE_STORE = 'files';

function scopeKey(): string {
  const scope = currentHeldInputScope(currentIdentityKey());
  return `${scope.daemon}:${scope.account}`;
}

function textKey(chat: string): string {
  return `${TEXT_PREFIX}:${scopeKey()}:${chat}`;
}

function sessionStore(): Storage | null {
  try { return globalThis.sessionStorage ?? null; } catch { return null; }
}

/** Text kept in memory too: a blocked sessionStorage still keeps a draft across a view change. */
const textInMemory = new Map<string, string>();
const filesInMemory = new Map<string, readonly File[]>();

/** The unsent text of `chat` ('' when there is none). */
export function readDraftText(chat: string): string {
  const key = textKey(chat);
  const kept = textInMemory.get(key);
  if (kept !== undefined) return kept;
  try { return sessionStore()?.getItem(key) ?? ''; } catch { return ''; }
}

/** Keep `text` as the unsent text of `chat`; empty text removes it. */
export function writeDraftText(chat: string, text: string): void {
  const key = textKey(chat);
  if (text) textInMemory.set(key, text); else textInMemory.delete(key);
  const storage = sessionStore();
  if (!storage) return;
  try {
    if (text) storage.setItem(key, text); else storage.removeItem(key);
  } catch { /* a full or blocked storage keeps the draft in memory */ }
}

/** The files attached to `chat`'s unsent draft that this tab holds in memory. */
export function draftFilesInMemory(chat: string): File[] {
  return [...(filesInMemory.get(`${scopeKey()}:${chat}`) ?? [])];
}

function sameFiles(a: readonly File[], b: readonly File[]): boolean {
  return a.length === b.length && a.every((file, index) => file === b[index]);
}

function openFileStore(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      request = indexedDB.open(DB_NAME, 1);
    } catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(FILE_STORE)) request.result.createObjectStore(FILE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withFileStore<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  const db = await openFileStore();
  if (!db) return undefined;
  try {
    return await new Promise<T | undefined>((resolve) => {
      const transaction = db.transaction(FILE_STORE, mode);
      const request = act(transaction.objectStore(FILE_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => resolve(undefined);
      transaction.onabort = () => resolve(undefined);
    });
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** Keep `files` as the attachments of `chat`'s unsent draft; none removes them. */
export function writeDraftFiles(chat: string, files: readonly File[]): void {
  const key = `${scopeKey()}:${chat}`;
  if (sameFiles(filesInMemory.get(key) ?? [], files)) return;
  if (files.length > 0) filesInMemory.set(key, [...files]); else filesInMemory.delete(key);
  if (files.length > 0) void withFileStore('readwrite', (store) => store.put([...files], key));
  else void withFileStore('readwrite', (store) => store.delete(key));
}

/**
 * The files of `chat`'s draft kept from before a reload (IndexedDB), once they are read;
 * [] when none were kept or the store cannot be read. Read ones are held in memory from then on.
 */
export async function restoreDraftFiles(chat: string): Promise<File[]> {
  const key = `${scopeKey()}:${chat}`;
  const kept = filesInMemory.get(key);
  if (kept) return [...kept];
  const stored = await withFileStore<unknown>('readonly', (store) => store.get(key));
  const files = Array.isArray(stored) ? stored.filter((entry): entry is File => entry instanceof File) : [];
  if (files.length > 0 && !filesInMemory.has(key)) filesInMemory.set(key, files);
  return files;
}

/** Sign-out: every draft of this tab goes, in memory, in sessionStorage and in IndexedDB. */
export function clearChatDrafts(): void {
  textInMemory.clear();
  filesInMemory.clear();
  const storage = sessionStore();
  if (storage) {
    try {
      for (let index = storage.length - 1; index >= 0; index--) {
        const name = storage.key(index);
        if (name?.startsWith(`${TEXT_PREFIX}:`)) storage.removeItem(name);
      }
    } catch { /* nothing to clear */ }
  }
  void withFileStore('readwrite', (store) => store.clear());
}
