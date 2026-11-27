import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import {
  PAIRING_HANDOFF_OFFER_KINDS, availablePairingOffers, defaultPairingTokenName, mintPairingHandoff, pairingNoWebUiLines,
  pairingReachFromSettings, pairingThisMachineLines, resolvePairingWebOrigin,
  type OriginPosture, type PairingHandoffOfferKind, type PairingTokenManager,
} from '@goodvibes/engine/platform/platform/pairing';
import { describeOperatorRpcError, invokePressed, resolveOperatorRpc } from './client/operator-endpoint.ts';

/**
 * Making a pairing offer for a phone or another device: the offer's link and one-time code, what it carries, and where it
 * can be opened. Pair something in Devices and network answers it as the reveal of `devices.pair`
 * (input/commands/devices-runtime.ts); nothing else keeps it.
 */
export interface PairingOffer {
  /** The web-app origin the deep link opens (the routable address, beside a name the device may not resolve). */
  readonly url: string;
  /** The one-time pairing secret. */
  readonly token: string;
  /** The per-device token's name. */
  readonly tokenName: string;
  /** The `#pair=<token>` deep link the QR encodes: opens the web app signed in. */
  readonly deepLink: string;
  /** The offer set this pairing carries (each declinable in the web app). */
  readonly offers: readonly PairingHandoffOfferKind[];
  /** The honest TLS/capability posture of the address the link opens. */
  readonly posture?: OriginPosture | undefined;
  /** The minted token's id. */
  readonly tokenId?: string | undefined;
  /** Present when a phone could not open the link (the daemon serves only this machine): the lines that say why, and the steps. */
  readonly thisMachineOnly?: readonly string[] | undefined;
}

/** No code was made because there is nothing to open (the daemon serves no web UI): the numbered steps that say so. */
export interface PairingOfferUnreachable {
  readonly kind: 'unreachable';
  readonly lines: readonly string[];
}

/** What makes a pairing offer: the settings that say where a phone could open it, and the store that holds the offer. */
export interface PairingMintDeps {
  readonly configManager: ConfigManager;
  readonly pairingTokens: PairingTokenManager;
}

/** The step that makes a new pairing code: the control that opened this. */
const PAIR_AGAIN = 'Press Pair something (A phone or another device) in Devices and network again';

/**
 * Mint a per-device offer and encode the canonical `#pair=` deep link (the same mint the pairing.handoff.create verb
 * performs). No code is made for a phone that could not open it: the same decision and steps `goodvibes pair` gives, from
 * the settings, with no probe. A failure (a token store that cannot be written, the device cap) is thrown as it is.
 */
export function buildPairingConnectionInfo(deps: PairingMintDeps, request: { readonly name?: string | undefined } = {}): PairingOffer | PairingOfferUnreachable {
  const configManager = deps.configManager;
  const webOrigin = resolvePairingWebOrigin(configManager);
  if (webOrigin === null) return { kind: 'unreachable', lines: pairingNoWebUiLines(PAIR_AGAIN) };
  const reach = pairingReachFromSettings(configManager, webOrigin.origin);
  const thisMachineOnly = reach.otherDevices ? undefined : pairingThisMachineLines(webOrigin.origin, reach, PAIR_AGAIN);
  const url = webOrigin.alternateOrigin ? `${webOrigin.origin}  (or ${webOrigin.alternateOrigin})` : webOrigin.origin;
  const offers = availablePairingOffers({
    relayEnabled: configManager.get('relay.enabled') === true,
    // The terminal app always wires a step-up service, so the passkey offer is presentable; the web app declines it if the
    // device has no authenticator.
    stepUpAvailable: true,
  });
  const handoff = mintPairingHandoff({
    pairingTokens: deps.pairingTokens,
    name: request.name ?? defaultPairingTokenName(),
    offers,
    webOrigin: webOrigin.origin,
  });
  return {
    url,
    token: handoff.token.token,
    tokenName: handoff.token.name,
    deepLink: handoff.deepLink ?? handoff.fragment,
    offers: handoff.offers,
    posture: handoff.posture,
    tokenId: handoff.token.id,
    thisMachineOnly,
  };
}

/** pairing.handoff.create's answer, the fields an offer shows. */
interface PairingHandoffAnswer {
  readonly token: { readonly id: string; readonly name: string; readonly token: string };
  readonly offers: readonly { readonly kind: PairingHandoffOfferKind }[];
  readonly fragment: string;
  readonly deepLink?: string | undefined;
  readonly posture?: OriginPosture | undefined;
}

/**
 * The owner's yes to SERVE_TO_NETWORK_QUESTION: the daemon serves its web UI to the network, waits for its own listener to
 * be bound again, and mints the code for the address phones can open, in one request (pairing.handoff.create
 * `serveToNetwork`). It throws with the daemon's reason when it cannot.
 */
export async function servePairingToNetwork(deps: { readonly configManager: ConfigManager; readonly homeDirectory: string }, name?: string): Promise<PairingOffer> {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) throw new Error(rpc.reason);
  let answer: PairingHandoffAnswer;
  try {
    // The person's own yes in Pair something: their press.
    answer = await invokePressed<PairingHandoffAnswer>(rpc.platformClient, 'pairing.handoff.create', {
      name: name ?? defaultPairingTokenName(),
      offers: [...PAIRING_HANDOFF_OFFER_KINDS],
      serveToNetwork: true,
    });
  } catch (error) { throw new Error(describeOperatorRpcError(error)); }
  const deepLink = answer.deepLink ?? answer.fragment;
  return {
    url: answer.posture?.origin ?? deepLink,
    token: answer.token.token,
    tokenName: answer.token.name,
    deepLink,
    offers: answer.offers.map((offer) => offer.kind),
    posture: answer.posture,
    tokenId: answer.token.id,
  };
}
