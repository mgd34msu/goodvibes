/** Credential-bearing local pairing output, separate from startup diagnostics. */
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { availablePairingOffers, resolvePairingWebOrigin } from '@goodvibes-jev/engine/platform/platform/pairing';
import { resolveRuntimeEndpointBinding } from '@goodvibes-jev/engine/terminal-shell';
import { renderPairingBanner } from '../core/pairing-banner.js';
import { localOnlyNotice } from '../daemon/pair-command.js';
import { SHIPPED_PUBLIC_BASE_URL, hasReadableWebuiBundle } from '../config/webui-bundle.js';

export function renderDaemonStartupPairing(
  config: Pick<ConfigManager, 'get'>,
  bound: { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' },
  token: string,
  version: string,
): string {
  const publicUrl = String(config.get('web.publicBaseUrl') ?? '').trim().replace(/\/+$/, '');
  const explicitOrigin = publicUrl !== '' && publicUrl !== SHIPPED_PUBLIC_BASE_URL;
  if (!explicitOrigin) {
    if (config.get('controlPlane.webui.serve') !== true) {
      return 'Device pairing link unavailable: enable a WebUI bundle or configure its public URL.';
    }
    if (!hasReadableWebuiBundle(config)) {
      return 'Device pairing link unavailable: the configured WebUI bundle has no readable app shell.';
    }
  }
  const { origin } = resolvePairingWebOrigin(config, undefined, bound);
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
  return [...renderPairingBanner({ version, origin, token,
    offers: availablePairingOffers({ relayEnabled: config.get('relay.enabled') === true, stepUpAvailable: true }),
  }).lines, `(print this again: ${reprint})`, ...localOnlyNotice(config, origin)].join('\n');
}
