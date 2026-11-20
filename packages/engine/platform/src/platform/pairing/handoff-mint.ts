/**
 * handoff-mint.ts, the one place a pairing producer mints a link.
 *
 * Every producer (a `pair` CLI block, a pairing modal's QR, a /qrcode flow)
 * routes through mintPairingHandoff, which mints a fresh per-device token and
 * encodes the canonical `#pair=<token>` deep link from pairing-handoff.ts,
 * byte-for-byte the same shape the `pairing.handoff.create` gateway verb's
 * handler produces (mint + buildPairingHandoffLink). No producer encodes a raw
 * JSON connection blob: a camera scan of the QR opens the web app already
 * carrying the one-time token, so the device lands signed in.
 *
 * The minted token is an offer until the device uses it: showing a QR that is
 * never scanned adds no device, and an unused offer stops working after
 * PAIRING_OFFER_LIFETIME_MS (pairing-token-store.ts). A producer that shows a
 * new QR in place of its earlier one passes `replacesOffer`, so the earlier
 * offer is withdrawn unless a device already used it.
 *
 * The token rides in the URL fragment, never the query, so it is never sent to a
 * server (no access-log / Referer exposure). The offer set rides alongside so a
 * bundle-aware surface can present the notifications/relay/passkey steps.
 */
import {
  buildPairingHandoffFragment,
  buildPairingHandoffLink,
  type PairingHandoffOfferKind,
} from './pairing-handoff.js';
import { describeOriginPosture, type OriginPosture } from './origin-posture.js';
import type { MintedPairingToken } from './pairing-token-store.js';

/** The token-minting surface a handoff needs, satisfied by {@link PairingTokenManager}. */
export interface PairingTokenMinter {
  mint(input: { readonly name: string; readonly replacesOffer?: string | undefined; readonly origin?: 'owner-pairing' | 'automation' | undefined }): MintedPairingToken;
}

export interface PairingHandoff {
  readonly token: MintedPairingToken;
  readonly offers: readonly PairingHandoffOfferKind[];
  /** `#pair=<token>` (with an `offers=` key when offers are present). */
  readonly fragment: string;
  /** `<webOrigin>/#pair=<token>`, present only when a web origin is known. */
  readonly deepLink?: string | undefined;
  /**
   * The honest TLS/capability posture of the web origin the deep link opens,
   * the same field the `pairing.handoff.create` gateway verb carries (both
   * computed by describeOriginPosture). Present only when a web origin
   * is known; a surface renders its one honest LAN line and its labeled
   * capability list from here, never from a locally-authored string.
   */
  readonly posture?: OriginPosture | undefined;
}

export interface MintPairingHandoffInput {
  readonly pairingTokens: PairingTokenMinter;
  /** The device/token name shown to the user and stored on the token; editable later. */
  readonly name: string;
  readonly offers: readonly PairingHandoffOfferKind[];
  /** The web-app origin the deep link points at; absent ⇒ fragment-only. */
  readonly webOrigin?: string | undefined;
  /**
   * The token id of the offer this producer showed before. If no device used
   * it, it is withdrawn in the same write as the new mint, so a screen that is
   * opened or refreshed again holds one live offer, not one per view.
   */
  readonly replacesOffer?: string | undefined;
}

/**
 * A default name for a freshly-minted pairing token when the user did not supply
 * one. Names are shown and editable later in the device management surface, so a
 * date-stamped default is enough to tell two devices apart at a glance. The
 * stamp is UTC and says so; read as local time it would put devices on the
 * wrong day.
 */
export function defaultPairingTokenName(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace('T', ' ');
  return `paired device (${stamp} UTC)`;
}

export function mintPairingHandoff(input: MintPairingHandoffInput): PairingHandoff {
  // Minted in the owner's own process, from the pairing screen at his terminal: the owner's device.
  const token = input.pairingTokens.mint({ name: input.name, origin: 'owner-pairing', ...(input.replacesOffer !== undefined ? { replacesOffer: input.replacesOffer } : {}) });
  const fragment = buildPairingHandoffFragment({ token: token.token, offers: input.offers });
  const deepLink = input.webOrigin
    ? buildPairingHandoffLink({ webOrigin: input.webOrigin, token: token.token, offers: input.offers })
    : undefined;
  // The posture is described from the SAME web origin the deep link opens, the
  // identical computation the gateway verb performs, so a locally-minted handoff
  // carries the same honest posture as one minted over the wire.
  const posture = input.webOrigin ? describeOriginPosture(input.webOrigin) : undefined;
  return { token, offers: input.offers, fragment, ...(deepLink ? { deepLink } : {}), ...(posture ? { posture } : {}) };
}

/** The link content a QR should encode: the full deep link when known, else the fragment. */
export function pairingQrContent(handoff: PairingHandoff): string {
  return handoff.deepLink ?? handoff.fragment;
}

export interface PairingOfferAvailability {
  /** Whether the rendezvous relay is configured ⇒ the relay offer is presentable. */
  readonly relayEnabled: boolean;
  /** Whether a step-up (passkey) ceremony is wired ⇒ the passkey offer is presentable. */
  readonly stepUpAvailable: boolean;
}

/**
 * The offers this daemon can satisfy right now, in canonical order. Notifications
 * are always available (browser push needs no server-side prerequisite beyond
 * the VAPID key the daemon mints on demand); relay and passkey are gated.
 */
export function availablePairingOffers(availability: PairingOfferAvailability): PairingHandoffOfferKind[] {
  const offers: PairingHandoffOfferKind[] = ['notifications'];
  if (availability.relayEnabled) offers.push('relay');
  if (availability.stepUpAvailable) offers.push('passkey');
  return offers;
}
