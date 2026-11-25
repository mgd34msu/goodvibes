import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { readConnectedDaemonOrigin, resolveDaemonEnabled, resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config';
import { daemonTokenOverride, resolveControlPlaneBaseUrl } from './operator-endpoint.ts';
import { statSync } from 'node:fs';
import { isLoopbackHost } from '@goodvibes/engine/platform/platform/utils/reachable-base-url';
import { operatorTokenPath } from '@goodvibes/engine/platform/platform/pairing/companion-token';
import { canonicalizePairingHost, readTuiHostPairing, tuiHostPairingStorePath, type TuiHostPairing } from '../tui-host-credential-store.ts';
import { readTuiLegacyPairingBootstrap } from '../tui-host-pairing-bootstrap.ts';

// Actual config owners retain only their latest selected frame. No host/token
// string is a process-global lookup key, and independent owners cannot share a label.
const observations = new WeakMap<ConfigManager, OwnedSelectionObservation>();

// The pairing record each (home, origin) last read, kept while the store file is
// the same file (one stat): a native request asks for its credential at every
// step, and the full read walks the home's ancestors and parses the store.
const pairingReads = new Map<string, { readonly file: string; readonly pairing: TuiHostPairing }>();
function readPairing(home: string, host: string): TuiHostPairing {
  let file: string | null;
  try {
    const stat = statSync(tuiHostPairingStorePath(home), { throwIfNoEntry: false });
    file = stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'none';
  } catch { file = null; }
  const id = `${home}\0${host}`;
  const held = pairingReads.get(id);
  if (file !== null && held?.file === file) return held.pairing;
  const pairing = readTuiHostPairing(home, host);
  if (file !== null && pairing.status !== 'unavailable') pairingReads.set(id, { file, pairing });
  else pairingReads.delete(id);
  return pairing;
}

/** Where the daemon on this machine keeps the operator token this user holds. */
export function localOperatorTokenPath(home: string): string {
  return operatorTokenPath(resolveGoodVibesDaemonHome(home));
}

// The operator token each home last read, kept while its file is the same file
// (one stat): the checked read walks the daemon home's ancestors.
const operatorTokenReads = new Map<string, { readonly file: string; readonly token: string | null }>();
function readLocalOperatorToken(home: string): string | null {
  let file: string | null;
  try {
    const stat = statSync(localOperatorTokenPath(home), { throwIfNoEntry: false });
    file = stat ? `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'none';
  } catch { file = null; }
  const held = operatorTokenReads.get(home);
  if (file !== null && held?.file === file) return held.token;
  const token = file === 'none' ? null : readTuiLegacyPairingBootstrap(home);
  if (file !== null) operatorTokenReads.set(home, { file, token });
  else operatorTokenReads.delete(home);
  return token;
}

/**
 * A daemon origin on this machine: a loopback address this terminal did not
 * reach through `daemon.connectedHost.url`. A connected host on a loopback
 * address can be a forwarded port of another machine, so it is never sent this
 * machine's token.
 */
function isLocalOrigin(origin: string, config: Pick<ConfigManager, 'get'>): boolean {
  if (readConnectedDaemonOrigin((key) => config.get(key))) return false;
  try { return isLoopbackHost(new URL(origin).hostname); } catch { return false; }
}

export interface NativeHostCredentialOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** A live operation owns its observations; passive reads share the config owner. */
  readonly observation?: OwnedSelectionObservation;
}
/**
 * The origin native work talks to, chosen in the same order as every other
 * verb (resolveControlPlaneBaseUrl): the connected daemon first, then an
 * explicit public base URL, then the bind. The public base URL keeps its exact
 * syntax so a path or query is refused rather than silently stripped.
 */
export function resolveTuiHostOrigin(config: ConfigManager): string | null {
  const connected = readConnectedDaemonOrigin((key) => config.get(key));
  if (connected) return canonicalizePairingHost(connected.baseUrl);
  const explicit: unknown = config.get('controlPlane.publicBaseUrl' as never);
  const selected = typeof explicit === 'string' && explicit.length > 0 ? explicit : resolveControlPlaneBaseUrl(config);
  return selected === null ? null : canonicalizePairingHost(selected);
}
export type NativeHostCredential =
  | { readonly available: true; readonly baseUrl: string; readonly token: string; readonly identity: string; readonly expectedPrincipalId?: string }
  | { readonly available: false; readonly identity: string; readonly reason: string };

/**
 * The credential native work presents to the selected daemon: the per-device
 * pairing bound to this exact origin when there is one. On the daemon's own
 * machine (a loopback origin not reached through a connected host) without
 * one, the bearer every other verb presents there: `GOODVIBES_DAEMON_TOKEN`
 * when set, otherwise the operator token this user already holds. The daemon
 * treats it as the owner's own machine, so there is no pairing step. A daemon on another machine is never sent that token; it is
 * paired with /devices pair host. Live scopes are enforced by each operation; a read
 * does not require write/admin.
 */
export function resolveNativeHostCredential(options: NativeHostCredentialOptions): NativeHostCredential {
  let owner: ConfigManager | undefined;
  let retained: OwnedSelectionObservation | undefined;
  try {
    retained = options.observation;
    owner = options.configManager;
    const home = typeof options.homeDirectory === 'function' ? options.homeDirectory() : options.homeDirectory;
    const enabled = resolveDaemonEnabled(owner);
    const selected = resolveControlPlaneBaseUrl(owner);
    const baseUrl = resolveTuiHostOrigin(owner);
    const pairing = baseUrl ? readPairing(home, baseUrl) : null;
    const onThisMachine = baseUrl !== null && isLocalOrigin(baseUrl, owner);
    const local = enabled && baseUrl && pairing && pairing.status !== 'paired' && pairing.status !== 'unavailable' && onThisMachine
      ? daemonTokenOverride() ?? readLocalOperatorToken(home) : null;
    // Full state, not merely the bearer: replacement and indeterminate state
    // invalidate queued reads, permits and mutation preflights as well.
    let observation = retained ?? observations.get(owner);
    if (!observation) {
      observation = new OwnedSelectionObservation();
      observations.set(owner, observation);
    }
    retained = observation;
    const identity = observation.observe([home, enabled, selected, baseUrl, pairing, local], owner);
    if (!enabled) return { available: false, identity, reason: 'Selected daemon is disabled.' };
    if (!baseUrl) return { available: false, identity, reason: 'Select an exact HTTP(S) daemon origin without a path, query, fragment or user information.' };
    if (pairing?.status === 'paired') return { available: true, baseUrl, token: pairing.token, identity, expectedPrincipalId: `pairing:${pairing.tokenId}` };
    if (local) return { available: true, baseUrl, token: local, identity };
    // For a daemon on another machine, a pairing whose reply was lost is settled
    // by repeating it under its attempt id (the host answers with the credential
    // it made, never a second one), so nothing is swapped in under it meanwhile.
    if (pairing?.status === 'unknown') return { available: false, identity, reason: 'The reply to this terminal\'s pairing request was lost. Repeat it in Devices and network: Pair something, This program with its daemon, Shared token: Yes.' };
    if (pairing?.status === 'missing') {
      return { available: false, identity, reason: onThisMachine
        ? 'The daemon on this machine is selected, but its operator token could not be read (it must be your own private file). Start the daemon once, or pair this terminal in Devices and network (Pair something, This program with its daemon).'
        : 'This terminal has no device credential for the daemon on another machine; pair it in Devices and network (Pair something, This program with its daemon).' };
    }
    return { available: false, identity, reason: 'The TUI host credential store is unavailable.' };
  } catch {
    if (retained) retained.retire();
    else if (owner) observations.get(owner)?.retire();
    return { available: false, identity: 'tui-host-credential-unavailable', reason: 'The selected TUI host credential is unavailable.' };
  }
}
