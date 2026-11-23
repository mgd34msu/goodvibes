/** Credential-bearing local pairing output, separate from startup diagnostics. */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { availablePairingOffers, explicitPublicBaseUrl, resolvePairingWebOrigin } from '@goodvibes/engine/platform/platform/pairing';
import { resolveRuntimeEndpointBinding } from '@goodvibes/engine/terminal-shell';
import { renderPairingBanner } from '../core/pairing-banner.js';
import { thisMachineSignIn } from '../daemon/pair-command.js';
import { hasReadableWebuiBundle } from '../config/webui-bundle.js';

export function renderDaemonStartupPairing(
  config: Pick<ConfigManager, 'get'>,
  bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' },
  token: string,
  version: string,
): string {
  if (explicitPublicBaseUrl(config) === '') {
    if (config.get('controlPlane.webui.serve') !== true) {
      return 'Device pairing link unavailable: enable a WebUI bundle or configure its public URL.';
    }
    if (!hasReadableWebuiBundle(config)) {
      return 'Device pairing link unavailable: the configured WebUI bundle has no readable app shell.';
    }
  }
  const resolved = resolvePairingWebOrigin(config, undefined, bound);
  if (resolved === null) return 'Device pairing link unavailable: enable a WebUI bundle or configure its public URL.';
  const { origin, alternateOrigin } = resolved;
  try {
    const parsed = new URL(origin);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password
      || origin.includes('?') || origin.includes('#') || /[\x00-\x20\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(origin)
      || parsed.hostname === '0.0.0.0' || parsed.hostname === '[::]') throw new Error('Invalid origin');
  } catch {
    return 'Device pairing link unavailable: the configured WebUI URL is not a usable HTTP(S) origin.';
  }
  // `pair` asks the running daemon for its token and address, but finds it on
  // the settings port; a daemon bound elsewhere is named by its port.
  const declaredPort = resolveRuntimeEndpointBinding(config, 'controlPlane').port;
  const reprint = bound.port === declaredPort ? 'goodvibes-daemon pair' : `goodvibes-daemon pair --port ${bound.port}`;
  const offers = availablePairingOffers({ relayEnabled: config.get('relay.enabled') === true, stepUpAvailable: true });
  // A link no phone could open is given for a browser on this machine, said so, with no QR.
  const thisMachine = thisMachineSignIn(config, origin, token, offers);
  if (thisMachine !== null) return [`GoodVibes daemon ${version}`, ...thisMachine.lines, `(print this again: ${reprint})`].join('\n');
  return [...renderPairingBanner({ version, origin, alternateOrigin, token, offers }).lines, `(print this again: ${reprint})`].join('\n');
}
