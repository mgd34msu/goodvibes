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
import { parseDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config';
import { writeFileAtomic } from '@goodvibes-jev/engine/platform/platform/utils';

interface ConnectedDaemonCredentialStore {
  readonly version: 1;
  /** Daemon origin (`http://host:port`) to the bearer this terminal presents there. */
  readonly tokens: Readonly<Record<string, string>>;
}

export function connectedDaemonCredentialsPath(homeDirectory: string): string {
  return join(homeDirectory, '.goodvibes', 'tui', 'connected-daemons.json');
}

function originKey(url: string): string | null {
  return parseDaemonOrigin(url)?.baseUrl ?? null;
}

function readStore(homeDirectory: string): ConnectedDaemonCredentialStore {
  try {
    const parsed = JSON.parse(readFileSync(connectedDaemonCredentialsPath(homeDirectory), 'utf-8')) as Partial<ConnectedDaemonCredentialStore> | null;
    const tokens = parsed?.tokens;
    if (parsed?.version === 1 && tokens && typeof tokens === 'object' && !Array.isArray(tokens)) {
      return { version: 1, tokens: Object.fromEntries(Object.entries(tokens).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0)) };
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
  const tokens: Record<string, string> = { ...readStore(homeDirectory).tokens };
  if (token === null) delete tokens[key];
  else tokens[key] = token;
  writeFileAtomic(connectedDaemonCredentialsPath(homeDirectory), `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
}
