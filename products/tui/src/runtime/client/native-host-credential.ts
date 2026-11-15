import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveControlPlaneBaseUrl } from './operator-endpoint.ts';
import { statSync } from 'node:fs';
import { canonicalizePairingHost, readTuiHostPairing, tuiHostPairingStorePath, type TuiHostPairing } from '../tui-host-credential-store.ts';

// Actual config owners retain only their latest selected frame. No host/token
// string is a process-global lookup key, and independent owners cannot share a label.
const observations = new WeakMap<ConfigManager, OwnedSelectionObservation>();
const getObservation = WeakMap.prototype.get, setObservation = WeakMap.prototype.set;
const applyObservation = Reflect.apply;

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

export interface NativeHostCredentialOptions {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
  /** A live operation owns its observations; passive reads share the config owner. */
  readonly observation?: OwnedSelectionObservation;
}
/** Preserve explicit syntax for validation instead of silently stripping paths. */
export function resolveTuiHostOrigin(config: ConfigManager): string | null {
  const explicit: unknown = config.get('controlPlane.publicBaseUrl' as never);
  const selected = typeof explicit === 'string' && explicit.length > 0 ? explicit : resolveControlPlaneBaseUrl(config);
  return selected === null ? null : canonicalizePairingHost(selected);
}
export type NativeHostCredential =
  | { readonly available: true; readonly baseUrl: string; readonly token: string; readonly identity: string; readonly expectedPrincipalId?: string }
  | { readonly available: false; readonly identity: string; readonly reason: string };

/**
 * The credential native work presents to the selected daemon: the per-device
 * pairing bound to this exact origin. Native work is attributed to a device and
 * revocable per device, so the shared operator token is never presented here.
 * On the owner's own machine the terminal creates that pairing itself on first
 * use (`pairLocalTuiHostAutomatically`); a daemon on another machine is paired
 * with /host pair. Live scopes are enforced by each operation; a read does not
 * require write/admin.
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
    // Full state, not merely the bearer: replacement and indeterminate state
    // invalidate queued reads, permits and mutation preflights as well.
    let observation = retained ?? (applyObservation(getObservation, observations, [owner]) as OwnedSelectionObservation | undefined);
    if (!observation) {
      observation = new OwnedSelectionObservation();
      applyObservation(setObservation, observations, [owner, observation]);
    }
    retained = observation;
    const identity = observation.observe([home, enabled, selected, baseUrl, pairing], owner);
    if (!enabled) return { available: false, identity, reason: 'Selected daemon is disabled.' };
    if (!baseUrl) return { available: false, identity, reason: 'Select an exact HTTP(S) daemon origin without a path, query, fragment or user information.' };
    if (pairing?.status === 'paired') return { available: true, baseUrl, token: pairing.token, identity, expectedPrincipalId: `pairing:${pairing.tokenId}` };
    // A pairing whose outcome is unknown stays the owner's to inspect: its
    // device token may be live on the daemon, so nothing is swapped in under it.
    if (pairing?.status === 'unknown') return { available: false, identity, reason: 'A host pairing for this daemon has an unknown outcome. Check it with /host pair, then retry.' };
    if (pairing?.status === 'missing') return { available: false, identity, reason: 'This terminal has no device credential for this daemon. On this machine /work creates one on first use; for a daemon on another machine, pair this terminal with /host pair.' };
    return { available: false, identity, reason: 'The TUI host credential store is unavailable.' };
  } catch {
    if (retained) retained.retire();
    else if (owner) (applyObservation(getObservation, observations, [owner]) as OwnedSelectionObservation | undefined)?.retire();
    return { available: false, identity: 'tui-host-credential-unavailable', reason: 'The selected TUI host credential is unavailable.' };
  }
}
