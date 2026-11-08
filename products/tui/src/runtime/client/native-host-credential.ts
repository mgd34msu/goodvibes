import { OwnedSelectionObservation } from '@goodvibes-jev/engine/sdk/platform/runtime/client';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/sdk/platform/config';
import { resolveControlPlaneBaseUrl } from './operator-endpoint.ts';
import { canonicalizePairingHost, readTuiHostPairing } from '../tui-host-credential-store.ts';

// Actual config owners retain only their latest selected frame. No host/token
// string is a process-global lookup key, and independent owners cannot share a label.
const observations = new WeakMap<ConfigManager, OwnedSelectionObservation>();
const getObservation = WeakMap.prototype.get, setObservation = WeakMap.prototype.set;
const applyObservation = Reflect.apply;

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

/** Passive snapshot only. Native operations never borrow another product's secret,
 * read the daemon-global token, honor unbound environment credentials, or mint.
 * Live scopes are enforced by each operation; a read does not require write/admin.
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
    const pairing = baseUrl ? readTuiHostPairing(home, baseUrl) : null;
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
    if (pairing?.status === 'unknown') return { available: false, identity, reason: 'A TUI host pairing outcome is unknown. Inspect this host before further action; no credential fallback or automatic remint is allowed.' };
    if (pairing?.status === 'unavailable') return { available: false, identity, reason: 'The TUI host credential store could not be read safely. Native work is unavailable.' };
    return { available: false, identity, reason: 'No TUI credential is bound to this exact daemon origin. Run goodvibes host pair --bootstrap-shared to review pairing, then use --apply in an owner terminal.' };
  } catch {
    if (retained) retained.retire();
    else if (owner) (applyObservation(getObservation, observations, [owner]) as OwnedSelectionObservation | undefined)?.retire();
    return { available: false, identity: 'tui-host-credential-unavailable', reason: 'The selected TUI host credential is unavailable.' };
  }
}
