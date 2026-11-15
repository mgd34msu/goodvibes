/**
 * device-pairing.ts, pairing a phone or another device from the Agent.
 *
 * The connected host mints a named device token through its
 * `pairing.handoff.create` verb and answers with the `#pair=` link for it, the
 * same mint the TUI's pairing modal and `goodvibes pair` use. The device is then
 * listed under the host's devices and can be revoked on its own; the Agent's own
 * host credential is never printed or put in a QR code.
 */
import {
  PAIRING_HANDOFF_OFFER_KINDS,
  defaultPairingTokenName,
  formatPairingOffers,
  formatPostureCapabilities,
  generateQrMatrix,
  pairingPostureNotice,
  renderQrToString,
  type OriginPosture,
  type PairingHandoffOfferKind,
} from '@goodvibes-jev/engine/platform/platform/pairing';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';

/** What `pairing.handoff.create` answers. */
interface PairingHandoffCreateResult {
  readonly token: { readonly id: string; readonly name: string; readonly token: string; readonly createdAt: number };
  readonly offers: readonly { readonly kind: string; readonly available?: boolean }[];
  /** `#pair=<token>&offers=...`, present even when the host has no web origin. */
  readonly fragment: string;
  /** `<webOrigin>/#pair=...`, present when the host has a web origin. */
  readonly deepLink?: string;
  readonly posture?: OriginPosture;
}

export type AgentDevicePairingOutcome =
  | { readonly ok: true; readonly tokenName: string; readonly tokenId: string; readonly link: string; readonly text: string }
  | { readonly ok: false; readonly error: string; readonly next: string };

function isOfferKind(kind: string): kind is PairingHandoffOfferKind {
  return (PAIRING_HANDOFF_OFFER_KINDS as readonly string[]).includes(kind);
}

/** One request to the connected host: mint a device token and render its link, QR and posture. */
export async function mintAgentDevicePairing(verbs: DaemonVerbCaller, options: { readonly name?: string; readonly qr?: boolean } = {}): Promise<AgentDevicePairingOutcome> {
  const reach = verbs.probe();
  if (!reach.available) {
    return { ok: false, error: `No device was paired: ${reach.reason}.`, next: 'Start or connect the GoodVibes host, then pair again.' };
  }
  let result: PairingHandoffCreateResult;
  try {
    result = await verbs.invoke<PairingHandoffCreateResult>('pairing.handoff.create', {
      name: options.name?.trim() || defaultPairingTokenName(),
      offers: [...PAIRING_HANDOFF_OFFER_KINDS],
    });
  } catch (error) {
    return {
      ok: false,
      error: `No device was paired: the connected host did not mint a device token (${error instanceof Error ? error.message : String(error)}).`,
      next: 'Check the host with goodvibes-agent status, then pair again.',
    };
  }
  const offerKinds = result.offers.map((offer) => offer.kind).filter(isOfferKind);
  const lines: string[] = [];
  const link = result.deepLink ?? result.fragment;
  if (result.deepLink === undefined) {
    lines.push(
      `Minted device token "${result.token.name}" on the connected host, but the host has no web address configured, so there is no link a device can open.`,
      `  pairing fragment: ${result.fragment}`,
      '  Set web.publicBaseUrl on the host, revoke this token in the host\'s device list, then pair again for a scannable link.',
    );
  } else {
    lines.push('Scan to pair a device; the QR opens the web app already signed in:', '', `  ${link}`);
  }
  lines.push(`  Token name: ${result.token.name}  (rename or revoke it in the host's device list)`);
  if (offerKinds.length > 0) {
    lines.push('', 'Offers carried in this pairing (each declinable in the web app):', ...formatPairingOffers(offerKinds));
  }
  const capabilities = formatPostureCapabilities(result.posture);
  if (capabilities.length > 0) lines.push('', 'This device will get:', ...capabilities);
  const notice = pairingPostureNotice(result.posture);
  if (notice) lines.push('', notice);
  if (result.deepLink !== undefined && options.qr !== false) lines.push('', renderQrToString(generateQrMatrix(link)));
  return { ok: true, tokenName: result.token.name, tokenId: result.token.id, link, text: lines.join('\n') };
}
