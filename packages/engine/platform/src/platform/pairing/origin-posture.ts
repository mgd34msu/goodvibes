/**
 * pairing/origin-posture.ts
 *
 * The honest TLS/capability posture of a web origin, served over the pairing
 * contract so every surface renders the SAME truth instead of dead buttons:
 *
 *  - Plain http on a PRIVATE-NETWORK origin (LAN IP, .local, localhost, a
 *    Tailscale name or address) is a deliberate, supported posture. The one
 *    honest line about it is stated at pairing, never a nag.
 *  - Browsers gate some capabilities on a secure context (https, or the
 *    localhost loopback). Rather than a surface showing a dead button, the
 *    daemon labels each gated capability with WHY it is unavailable and the
 *    supported way to get it (tailscale ⇒ https without minting certificates,
 *    the daemon NEVER provisions a CA or mints certificates).
 */
import { isPrivateNetworkHost, isTailnetHost } from '@goodvibes/engine/transport-http/paths';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import type { PairingStep } from './offer-copy.js';

/** The browser-gated capabilities a surface renders availability for. */
export type BrowserGatedCapability = 'service-worker' | 'push' | 'microphone';

export const BROWSER_GATED_CAPABILITIES: readonly BrowserGatedCapability[] = [
  'service-worker',
  'push',
  'microphone',
];

export interface OriginCapability {
  readonly capability: BrowserGatedCapability;
  readonly available: boolean;
  /** Present when unavailable: the label a surface renders instead of a dead button. */
  readonly reason?: string | undefined;
}

export interface OriginPosture {
  /** The origin the posture describes (scheme://host[:port]). */
  readonly origin: string;
  readonly scheme: 'http' | 'https' | 'other';
  /** Loopback, a private LAN or link-local address, .local, or a Tailscale name or address: the supported plain-http posture. */
  readonly privateNetwork: boolean;
  /** Whether browsers treat this origin as a secure context (https, or loopback). */
  readonly secureContext: boolean;
  /**
   * The ONE honest posture line, stated at pairing (never a nag): present only
   * for the plain-http-on-LAN posture; absent when the origin is already a
   * secure context.
   */
  readonly notice?: string | undefined;
  readonly capabilities: readonly OriginCapability[];
  /**
   * On the address a pairing code carries (`pairing.posture.get` with no
   * origin, `pairing.handoff.create`): whether a phone can open it, decided by
   * the daemon from its settings, and when not, the numbered steps that fix it.
   */
  readonly reach?: PairingReachAnswer | undefined;
}

/** The daemon's answer about a pairing address: the decision, and when a phone could not open it, the steps. */
export interface PairingReachAnswer extends PairingReach {
  readonly steps?: readonly PairingStep[] | undefined;
}

/** Whether a device other than this machine can open an origin, and when not, why and the one command that fixes it. */
export interface PairingReach {
  readonly otherDevices: boolean;
  /** Why another device cannot open it, one sentence; absent when it can. */
  readonly reason?: string | undefined;
  /** The one command that makes it reachable; absent when it is. */
  readonly fix?: string | undefined;
}

/** The command that binds the daemon's listener to the network and serves other devices. */
export const PAIRING_REACH_FIX = 'goodvibes-daemon webui enable --lan';

/**
 * Whether another device can open `origin` (the address the daemon answers a
 * pairing code would carry), decided from the daemon's settings with no
 * request on the network: an address on this machine's loopback is not
 * reachable from anywhere else; an address the owner set (`web.publicBaseUrl`,
 * a proxy or tunnel he runs) is his statement that it is; otherwise the
 * listener serves other machines only with `controlPlane.enabled`. A caller
 * reaching a daemon on another machine already proves that daemon serves other
 * machines, and says so with `servesOtherMachines`.
 */
export function describePairingReach(
  origin: string,
  settings: { readonly servesOtherMachines: boolean; readonly publicBaseUrl: string },
): PairingReach {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {
      otherDevices: false,
      reason: `the web address the daemon has (${origin}) is not a valid URL, so a phone has nothing to open`,
      fix: 'goodvibes-daemon config set web.publicBaseUrl <the address a phone opens>',
    };
  }
  if (isLoopbackHost(parsed.hostname)) {
    return {
      otherDevices: false,
      reason: `the daemon serves only this machine: ${parsed.origin} is this machine's own address, which another device cannot open`,
      fix: PAIRING_REACH_FIX,
    };
  }
  let declared = '';
  try { declared = settings.publicBaseUrl ? new URL(settings.publicBaseUrl).origin : ''; } catch { declared = ''; }
  if (declared !== '' && declared === parsed.origin) return { otherDevices: true };
  if (!settings.servesOtherMachines) {
    return {
      otherDevices: false,
      reason: `the daemon listens at ${parsed.origin}, but controlPlane.enabled is off, so it refuses every device but this machine`,
      fix: PAIRING_REACH_FIX,
    };
  }
  return { otherDevices: true };
}

/** The single honest plain-http-on-LAN line every surface renders verbatim. */
export const LAN_PLAIN_HTTP_NOTICE =
  'Connection is unencrypted on your LAN. Everything works except browser-gated features; Tailscale gives encrypted access with the full app.';

/**
 * The plain-http-on-a-tailnet line: the connection is already encrypted by
 * Tailscale, so the LAN line's advice would be wrong; only the browser-gated
 * features are missing.
 */
export const TAILNET_PLAIN_HTTP_NOTICE =
  'Connection is encrypted by Tailscale. Everything works except browser-gated features, which need https: serve this machine over Tailscale https to get them.';

const NEEDS_HTTPS_REASON = 'needs https: goodvibes-daemon webui enable --lan --https, or Tailscale';

/**
 * The line for https on a private address: the daemon's own LAN certificate
 * (daemon/lan-https). A phone opens it, and gets the browser-gated features,
 * only once it trusts that certificate.
 */
export const LAN_HTTPS_NOTICE =
  'This https address uses the certificate GoodVibes made on your computer: on each phone, install it once from the page /lan-https on the computer\'s plain address before opening this one.';

export { isLoopbackHost };

/**
 * Describe the TLS/capability posture of a web origin. Invalid origins are
 * reported honestly as scheme 'other' with every capability unavailable,
 * never a throw (this feeds a render path, not a validation gate).
 */
export function describeOriginPosture(origin: string): OriginPosture {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return {
      origin,
      scheme: 'other',
      privateNetwork: false,
      secureContext: false,
      capabilities: BROWSER_GATED_CAPABILITIES.map((capability) => ({
        capability,
        available: false,
        reason: 'origin is not a valid URL',
      })),
    };
  }
  const scheme: OriginPosture['scheme'] = parsed.protocol === 'https:' ? 'https' : parsed.protocol === 'http:' ? 'http' : 'other';
  const privateNetwork = isPrivateNetworkHost(parsed.hostname);
  // Browsers treat https everywhere and http on the loopback as secure contexts;
  // http on a LAN IP or a .local name is NOT one (that is exactly the labeled gap).
  const secureContext = scheme === 'https' || (scheme === 'http' && isLoopbackHost(parsed.hostname));
  const capabilities: OriginCapability[] = BROWSER_GATED_CAPABILITIES.map((capability) => (
    secureContext
      ? { capability, available: true }
      : { capability, available: false, reason: NEEDS_HTTPS_REASON }
  ));
  const plainHttpLan = scheme === 'http' && privateNetwork && !secureContext;
  // https on a private address that is not a tailnet name is the daemon's own LAN certificate.
  const ownCertificate = scheme === 'https' && privateNetwork && !isTailnetHost(parsed.hostname) && !isLoopbackHost(parsed.hostname);
  return {
    origin: parsed.origin,
    scheme,
    privateNetwork,
    secureContext,
    ...(plainHttpLan ? { notice: isTailnetHost(parsed.hostname) ? TAILNET_PLAIN_HTTP_NOTICE : LAN_PLAIN_HTTP_NOTICE }
      : ownCertificate ? { notice: LAN_HTTPS_NOTICE } : {}),
    capabilities,
  };
}
