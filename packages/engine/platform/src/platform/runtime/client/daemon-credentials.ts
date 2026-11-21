/**
 * daemon-credentials.ts, the bearer a client presents to a daemon it was
 * pointed at (`daemon.connectedHost.url`, an explicit `--host`), keyed by that
 * daemon's origin and kept in the client's own state. The daemon home's
 * operator-tokens.json is the token record of the daemon on this machine;
 * adopting a daemon elsewhere never writes it, so the local daemon and its
 * other clients keep their credential, and pointing the client back finds each
 * endpoint's own token. Read by the one daemon target resolver
 * (daemon-target-resolver.ts), which binds each token to its origin.
 *
 * Both terminal products write this file, so every read-change-write holds the
 * shared-file lock. A damaged file is set aside beside it (`.corrupt-*`) and
 * logged; a write that found it damaged refuses rather than replacing the
 * tokens it could not read with a store of one entry.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseDaemonOrigin } from '../../config/control-plane-base-url.js';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../../config/goodvibes-home.js';
import { withSyncFileLock } from '../../config/sync-file-lock.js';
import { readJsonFileOrQuarantine, writeFileAtomic } from '../../utils/atomic-json-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';

interface ConnectedDaemonCredentialStore {
  readonly version: 1;
  /** Daemon origin (`http://host:port`) to the bearer this terminal presents there. */
  readonly tokens: Readonly<Record<string, string>>;
  /**
   * Daemon origin to the session token `/auth login daemon` obtained there. While
   * one is held it is the bearer for that origin; signing out removes it and the
   * origin's own bearer (above, or the local daemon's shared token) applies again.
   */
  readonly sessions?: Readonly<Record<string, string>>;
}

export function connectedDaemonCredentialsPath(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', GOODVIBES_TUI_SURFACE_ROOT, 'connected-daemons.json');
}

function originKey(url: string): string | null {
  return parseDaemonOrigin(url)?.baseUrl ?? null;
}

function stringEntries(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
}

let storeRevision = 0;

/**
 * Advances on every write this process makes to the record, so a client kept
 * by a long-lived caller is rebuilt with the new bearer at once; a write from
 * another process shows in the file's stat instead.
 */
export function connectedDaemonCredentialsRevision(): number {
  return storeRevision;
}

function writeStore(homeDirectory: string, store: ConnectedDaemonCredentialStore): void {
  try {
    writeFileAtomic(connectedDaemonCredentialsPath(homeDirectory), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  } finally {
    storeRevision += 1;
  }
}

function validateStore(parsed: unknown): ConnectedDaemonCredentialStore {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the record is not an object');
  const record = parsed as Partial<ConnectedDaemonCredentialStore>;
  if (record.version !== 1) throw new Error(`the record has version ${String(record.version)}, not 1`);
  const tokens = record.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('the record has no tokens map');
  return { version: 1, tokens: stringEntries(tokens), sessions: stringEntries(record.sessions) };
}

/**
 * The stored record; `damaged` when the file was there but could not be
 * trusted and has been set aside. A missing file is an empty record.
 */
function readStore(homeDirectory: string): { readonly store: ConnectedDaemonCredentialStore; readonly damaged: boolean } {
  const path = connectedDaemonCredentialsPath(homeDirectory);
  const present = lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  const store = readJsonFileOrQuarantine<ConnectedDaemonCredentialStore>(path, {
    label: 'tui/connected-daemons',
    validate: validateStore,
    recovery: 'The stored daemon bearers and session tokens in this file are no longer used; connect to each daemon again (or sign in again) to store its credential.',
  });
  if (store) return { store, damaged: false };
  return { store: { version: 1, tokens: {} }, damaged: present };
}

/** The newest `.corrupt-*` copy of the record, for the refusal to name. */
function quarantinedCopy(path: string): string {
  const prefix = `${basename(path)}.corrupt-`;
  let names: string[] = [];
  try {
    names = readdirSync(dirname(path)).filter((name) => name.startsWith(prefix) && !name.endsWith('.why')).sort();
  } catch {
    // The directory listing is only for the message; the refusal stands without it.
  }
  const newest = names.at(-1);
  return newest ? join(dirname(path), newest) : `${path}.corrupt-*`;
}

/**
 * Read, change and write the record under the shared-file lock. A damaged
 * record was set aside by the read; the change is refused so the tokens it held
 * are not replaced unseen.
 */
function updateStore(homeDirectory: string, change: (store: ConnectedDaemonCredentialStore) => ConnectedDaemonCredentialStore): void {
  const path = connectedDaemonCredentialsPath(homeDirectory);
  withSyncFileLock(path, () => {
    const { store, damaged } = readStore(homeDirectory);
    if (damaged) {
      throw new Error(`The connected-daemon credential file ${path} could not be read and was set aside as ${quarantinedCopy(path)}; nothing was saved. Try again to start a new record, or restore the stored credentials from that copy.`);
    }
    writeStore(homeDirectory, change(store));
  });
}

/**
 * The record as a reader sees it: a file that cannot be opened (permissions)
 * holds no bearer for this dial, and the reason is logged.
 */
function readStoreForLookup(homeDirectory: string): ConnectedDaemonCredentialStore {
  try {
    return readStore(homeDirectory).store;
  } catch (error) {
    logger.warn('connected-daemon credentials could not be read; no stored bearer is used', { file: connectedDaemonCredentialsPath(homeDirectory), error: summarizeError(error) });
    return { version: 1, tokens: {} };
  }
}

/** The bearer stored for the daemon at `url`, or null. */
export function readConnectedDaemonToken(homeDirectory: string, url: string): string | null {
  const key = originKey(url);
  return key ? readStoreForLookup(homeDirectory).tokens[key] ?? null : null;
}

/** Store (or, with null, forget) the bearer for the daemon at `url`. Written owner-only. */
export function writeConnectedDaemonToken(homeDirectory: string, url: string, token: string | null): void {
  const key = originKey(url);
  if (!key) throw new Error(`${url} is not a daemon address (scheme://host:port).`);
  updateStore(homeDirectory, (store) => {
    const tokens: Record<string, string> = { ...store.tokens };
    if (token === null) delete tokens[key];
    else tokens[key] = token;
    return { ...store, tokens };
  });
}

/** The `/auth login daemon` session token held for the daemon at `url`, or null. */
export function readDaemonSessionToken(homeDirectory: string, url: string): string | null {
  const key = originKey(url);
  return key ? readStoreForLookup(homeDirectory).sessions?.[key] ?? null : null;
}

/** Hold (or, with null, drop) the session token for the daemon at `url`. Written owner-only. */
export function writeDaemonSessionToken(homeDirectory: string, url: string, token: string | null): void {
  const key = originKey(url);
  if (!key) throw new Error(`${url} is not a daemon address (scheme://host:port).`);
  updateStore(homeDirectory, (store) => {
    const sessions: Record<string, string> = { ...store.sessions };
    if (token === null) delete sessions[key];
    else sessions[key] = token;
    return { ...store, sessions };
  });
}
