/**
 * daemon-credentials.ts, the bearer a client presents to a daemon it was
 * pointed at (`daemon.connectedHost.url`, an explicit `--host`), keyed by that
 * daemon's origin and kept in the client's own state. The daemon home's
 * operator-tokens.json is the token record of the daemon on this machine;
 * adopting a daemon elsewhere never writes it, so the local daemon and its
 * other clients keep their credential, and pointing the client back finds each
 * endpoint's own token. Read by the one daemon target resolver
 * (daemon-target-resolver.ts), which binds each token to its origin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDaemonOrigin } from '../../config/control-plane-base-url.js';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';

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
  return join(homeDirectory, '.goodvibes', 'tui', 'connected-daemons.json');
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

function readStore(homeDirectory: string): ConnectedDaemonCredentialStore {
  try {
    const parsed = JSON.parse(readFileSync(connectedDaemonCredentialsPath(homeDirectory), 'utf-8')) as Partial<ConnectedDaemonCredentialStore> | null;
    const tokens = parsed?.tokens;
    if (parsed?.version === 1 && tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
      return { version: 1, tokens: stringEntries(tokens), sessions: stringEntries(parsed.sessions) };
    }
  } catch {
    // Missing or unreadable: no endpoint has a stored bearer.
  }
  return { version: 1, tokens: {} };
}

/** The bearer stored for the daemon at `url`, or null. */
export function readConnectedDaemonToken(homeDirectory: string, url: string): string | null {
  const key = originKey(url);
  return key ? readStore(homeDirectory).tokens[key] ?? null : null;
}

/** Store (or, with null, forget) the bearer for the daemon at `url`. Written owner-only. */
export function writeConnectedDaemonToken(homeDirectory: string, url: string, token: string | null): void {
  const key = originKey(url);
  if (!key) throw new Error(`${url} is not a daemon address (scheme://host:port).`);
  const store = readStore(homeDirectory);
  const tokens: Record<string, string> = { ...store.tokens };
  if (token === null) delete tokens[key];
  else tokens[key] = token;
  writeStore(homeDirectory, { ...store, tokens });
}

/** The `/auth login daemon` session token held for the daemon at `url`, or null. */
export function readDaemonSessionToken(homeDirectory: string, url: string): string | null {
  const key = originKey(url);
  return key ? readStore(homeDirectory).sessions?.[key] ?? null : null;
}

/** Hold (or, with null, drop) the session token for the daemon at `url`. Written owner-only. */
export function writeDaemonSessionToken(homeDirectory: string, url: string, token: string | null): void {
  const key = originKey(url);
  if (!key) throw new Error(`${url} is not a daemon address (scheme://host:port).`);
  const store = readStore(homeDirectory);
  const sessions: Record<string, string> = { ...store.sessions };
  if (token === null) delete sessions[key];
  else sessions[key] = token;
  writeStore(homeDirectory, { ...store, sessions });
}
