import { agentHostPairingStorePath, canonicalizePairingHost, describeUnreadableAgentHostPairing, readAgentHostPairing, type AgentHostPairing } from './connected-host-pairing-store.js';
import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { operatorTokenPath } from '@goodvibes/engine/platform/platform/pairing/companion-token';
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { isThisMachineHost } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';

type JsonRecord = Record<string, unknown>;

/** Where a connected-host credential came from, in precedence order. */
export type ConnectedHostCredentialSource = 'environment' | 'pairing' | 'operator-file';

export interface ConnectedHostOperatorToken {
  readonly path: string;
  readonly source: ConnectedHostCredentialSource;
  readonly present: boolean;
  readonly token: string | null;
  /** Only private pairing records bind a token to a locally known principal. */
  readonly expectedPrincipalId?: string;
  readonly error?: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function connectedHostOperatorTokenPath(homeDirectory: string): string {
  return operatorTokenPath(resolveGoodVibesDaemonHome(homeDirectory));
}

/** A live caller supplies its actual observer; passive snapshots issue no ID. */
export interface SelectedConnectedHostOperatorToken extends ConnectedHostOperatorToken { readonly selectionIdentity: string; }

/** Identity of a file as its writers publish it (each write renames in a new file). */
function fileStamp(path: string): string {
  try {
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return 'absent'; }
}
/**
 * The pairing and the operator token file change only when a writer replaces
 * the file, so a read is kept until its file's identity changes: asking which
 * host is selected costs one stat, not a verified re-read of the pairing store.
 */
const pairingReads = new Map<string, { readonly stamp: string; readonly value: AgentHostPairing }>();
function readPairing(homeDirectory: string, hostUrl: string): AgentHostPairing {
  const key = JSON.stringify([resolve(homeDirectory), hostUrl]);
  const stamp = fileStamp(agentHostPairingStorePath(homeDirectory));
  const prior = pairingReads.get(key);
  if (prior?.stamp === stamp) return prior.value;
  const value = readAgentHostPairing(homeDirectory, hostUrl);
  if (value.status === 'unavailable') pairingReads.delete(key);
  else pairingReads.set(key, { stamp, value });
  return value;
}
/** The Agent's pairing with one host, as the credential precedence below reads it: one stat while the store is unchanged. */
export function readConnectedHostPairing(homeDirectory: string, hostUrl: string): AgentHostPairing {
  return readPairing(homeDirectory, hostUrl);
}
const tokenFileReads = new Map<string, { readonly stamp: string; readonly token: string | null; readonly error?: string }>();

/** An environment token, which outranks every stored credential; null when none is set. */
function environmentCredential(): ConnectedHostOperatorToken | null {
  const connectedHostEnvToken = process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim();
  if (connectedHostEnvToken) return { path: 'env:GOODVIBES_CONNECTED_HOST_TOKEN', source: 'environment', present: true, token: connectedHostEnvToken };
  const legacyEnvToken = process.env.GOODVIBES_DAEMON_TOKEN?.trim();
  if (legacyEnvToken) return { path: 'env:GOODVIBES_DAEMON_TOKEN', source: 'environment', present: true, token: legacyEnvToken };
  return null;
}

/**
 * This machine's daemon token file. It is presented only to this machine's
 * daemon: for a `hostUrl` that is another machine it comes back with no token
 * and the reason, and the file is not read.
 */
function operatorFileCredential(homeDirectory: string, hostUrl: string | undefined): ConnectedHostOperatorToken {
  const path = connectedHostOperatorTokenPath(homeDirectory);
  if (hostUrl !== undefined && !isThisMachineHost(parseDaemonOrigin(hostUrl)?.host ?? '')) {
    return { path, source: 'operator-file', present: false, token: null,
      error: `This machine's daemon token is never sent to ${parseDaemonOrigin(hostUrl)?.baseUrl ?? hostUrl}, which is not this machine. Run goodvibes-agent setup pair to pair with that host, or set GOODVIBES_CONNECTED_HOST_TOKEN to its token.` };
  }
  const stamp = fileStamp(path);
  if (stamp === 'absent' && !existsSync(path)) return { path, source: 'operator-file', present: false, token: null };
  const prior = tokenFileReads.get(path);
  if (prior?.stamp === stamp) return { path, source: 'operator-file', present: true, token: prior.token, ...(prior.error ? { error: prior.error } : {}) };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const token = isRecord(parsed) && typeof parsed.token === 'string' && parsed.token.trim().length > 0
      ? parsed.token
      : null;
    tokenFileReads.set(path, { stamp, token });
    return { path, source: 'operator-file', present: true, token };
  } catch {
    // Parser diagnostics can quote the secret-bearing source text.
    tokenFileReads.delete(path);
    return { path, source: 'operator-file', present: true, token: null, error: 'Connected-host token record could not be read.' };
  }
}

/**
 * The credential a pairing request to `hostUrl` is sent with: the same
 * precedence as {@link readConnectedHostOperatorToken} without the pairing
 * store (whose marker or device credential is what the request settles), so an
 * environment token, else this machine's daemon token only when `hostUrl` is
 * this machine. Null token, with the reason, for another machine.
 */
export function readConnectedHostBootstrapToken(homeDirectory: string, hostUrl: string): ConnectedHostOperatorToken {
  return environmentCredential() ?? operatorFileCredential(homeDirectory, hostUrl);
}

export function readConnectedHostOperatorToken(homeDirectory: string, hostUrl: string | undefined,
  observation: OwnedSelectionObservation, sourceOwner?: object): SelectedConnectedHostOperatorToken;
export function readConnectedHostOperatorToken(homeDirectory: string, hostUrl?: string): ConnectedHostOperatorToken;
export function readConnectedHostOperatorToken(homeDirectory: string, hostUrl?: string,
  observation?: OwnedSelectionObservation, sourceOwner?: object): ConnectedHostOperatorToken | SelectedConnectedHostOperatorToken {
  const selected = (value: ConnectedHostOperatorToken, pairing?: AgentHostPairing): ConnectedHostOperatorToken | SelectedConnectedHostOperatorToken => observation
    ? { ...value, selectionIdentity: observation.observe([
      'agent-connected-host-selection', hostUrl === undefined ? null : canonicalizePairingHost(hostUrl) ?? hostUrl,
      resolve(homeDirectory), value, pairing ?? null,
    ], sourceOwner) }
    : value;
  const environment = environmentCredential();
  if (environment) return selected(environment);
  if (hostUrl !== undefined) {
    const pairing = readPairing(homeDirectory, hostUrl);
    if (pairing.status === 'paired') return selected({ path: 'Agent host-bound pairing store', source: 'pairing', present: true, token: pairing.token, expectedPrincipalId: `pairing:${pairing.tokenId}` }, pairing);
    if (pairing.status === 'unknown') return selected({ path: 'Agent host-bound pairing store', source: 'pairing', present: true, token: null, error: 'The reply to this Agent\'s pairing request was lost. Run goodvibes-agent setup pair to repeat the same request; the host answers it with the credential it made, or makes it now.' }, pairing);
    if (pairing.status === 'unavailable') return selected({ path: 'Agent host-bound pairing store', source: 'pairing', present: true, token: null, error: describeUnreadableAgentHostPairing(pairing) }, pairing);
  }
  return selected(operatorFileCredential(homeDirectory, hostUrl));
}

export function connectedHostTokenRequiredMessage(path: string): string {
  return [
    `Not connected to a GoodVibes host: there is no host token at ${path}.`,
    '  Start the host on this machine with goodvibes-daemon serve (it writes the token), or pair with a host: goodvibes-agent setup pair shows the plan and goodvibes-agent setup pair --apply pairs.',
    '  goodvibes-agent setup status shows the connection.',
  ].join('\n');
}
