/**
 * The bearer this terminal presents to a daemon it was pointed at
 * (`daemon.connectedHost.url`), keyed by that daemon's origin and kept in the
 * terminal's own state. The daemon home's operator-tokens.json is the token
 * record of the daemon on this machine; adopting a daemon elsewhere never
 * writes it, so the local daemon and its other clients keep their credential,
 * and pointing the terminal back finds each endpoint's own token.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';
import { writeFileAtomic } from '@goodvibes-jev/engine/platform/platform/utils';

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

function writeStore(homeDirectory: string, store: ConnectedDaemonCredentialStore): void {
  writeFileAtomic(connectedDaemonCredentialsPath(homeDirectory), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
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
