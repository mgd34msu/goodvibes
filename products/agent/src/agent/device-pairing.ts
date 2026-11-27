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
  SERVE_TO_NETWORK_QUESTION,
  PAIRING_HANDOFF_OFFER_KINDS,
  defaultPairingTokenName,
  formatPairingOffers,
  formatPostureCapabilities,
  generateQrMatrix,
  pairingNoWebUiLines,
  pairingPostureNotice,
  pairingReadySteps,
  pairingThisMachineLines,
  pairingUnreachableLines,
  renderQrToString,
  type OriginPosture,
  type PairingHandoffOfferKind,
} from '@goodvibes/engine/platform/platform/pairing';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';

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
  /** `forThisMachine`: the link opens only in a browser on the host's machine (a phone could not open it). */
  /** `qrShown`: the text carries a QR code of the link. */
  | { readonly ok: true; readonly tokenName: string; readonly tokenId: string; readonly link: string; readonly forThisMachine: boolean; readonly qrShown: boolean; readonly text: string; readonly qr?: string | undefined }
  /** `text`, when present, is the whole answer as the numbered list `pair` prints. */
  | { readonly ok: false; readonly error: string; readonly next: string; readonly text?: string };

/** The origin a deep link opens (`<origin>/#pair=...`). */
function originOf(link: string): string {
  const cut = link.indexOf('/#');
  return cut === -1 ? link : link.slice(0, cut);
}

/** Fixed-width mask, not derived from the code's length (the terminal app's pairing view uses the same). */
const SECRET_MASK = '••••••••••••';

/** The link with its sign-in code replaced: `<origin>/#pair=••••••••••••`; the address stays readable. */
function maskPairingLink(link: string): string {
  const cut = link.indexOf('#pair=');
  return cut === -1 ? SECRET_MASK : `${link.slice(0, cut)}#pair=${SECRET_MASK}`;
}

function isOfferKind(kind: string): kind is PairingHandoffOfferKind {
  return (PAIRING_HANDOFF_OFFER_KINDS as readonly string[]).includes(kind);
}

/** The code a host refusal carries, when it carries one. */
function refusalCode(error: unknown): string | undefined {
  const record = error as { readonly code?: unknown; readonly body?: { readonly code?: unknown } } | null;
  const code = record?.code ?? record?.body?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Before any token is minted: the host's own answer about the address a code
 * would carry (`pairing.posture.get`, which reads and mints nothing) says
 * whether a phone could open it; the host decides from its own settings.
 * `refused` when the host serves no web UI, or only its own machine and that
 * is not this one; `thisMachine` (the lines that lead the link) when only a
 * browser on the host's machine, this one, could open it;
 * null when a phone could, or the host gave no answer (the mint then reports
 * what went wrong, as before).
 */
async function pairingReadiness(
  verbs: DaemonVerbCaller,
  pairCommand: string,
  hostOnThisMachine: boolean,
): Promise<{ readonly refused: Extract<AgentDevicePairingOutcome, { ok: false }>; readonly servable?: true } | { readonly thisMachine: readonly string[] } | null> {
  let posture: OriginPosture;
  try {
    posture = (await verbs.invoke<{ readonly posture: OriginPosture }>('pairing.posture.get', {})).posture;
  } catch (error) {
    if (refusalCode(error) !== 'ORIGIN_UNKNOWN') return null;
    return {
      refused: {
        ok: false,
        error: 'No pairing code was made: the connected host serves no web UI, so a code would open nothing.',
        next: `On the host: goodvibes-daemon webui enable --lan, then ${pairCommand}.`,
        text: pairingNoWebUiLines(pairCommand).join('\n'),
      },
    };
  }
  const reach = posture.reach;
  if (reach === undefined || reach.otherDevices) return null;
  // A host on another machine: a link only its own machine opens is no use here.
  if (!hostOnThisMachine) {
    return {
      refused: {
        ok: false,
        error: `No pairing code was made: a phone could not open it yet${reach.reason ? ` (${reach.reason})` : ''}.`,
        next: `On the host: ${reach.fix ?? 'make the web UI reachable from your network'}, then ${pairCommand}.`,
        text: pairingUnreachableLines(posture.origin, reach, pairCommand).join('\n'),
      },
      // Serving the host's web UI to its network would let a phone open it.
      servable: true,
    };
  }
  return { thisMachine: pairingThisMachineLines(posture.origin, reach, pairCommand) };
}

/** One request to the connected host: mint a device token and render its link, QR and posture. */
export async function mintAgentDevicePairing(
  verbs: DaemonVerbCaller,
  options: {
    readonly name?: string; readonly qr?: boolean; readonly pairCommand?: string;
    /**
     * Asks the person, opening on No, when phones cannot reach the host yet:
     * "Phones on your network cannot reach GoodVibes yet. Serve it to your
     * network?". On yes the host serves its web UI to the network and the code
     * is made in the same request (pairing.handoff.create `serveToNetwork`).
     * Absent: No.
     */
    readonly askToServe?: ((question: string) => Promise<boolean>) | undefined;
    /**
     * Print the link and the sign-in code masked: the address stays visible, the code is replaced.
     * The conversation keeps its lines, so the code is never written there; `link` in the answer
     * still carries the real link (for a copy). The QR code is drawn as before.
     */
    readonly mask?: boolean | undefined;
    /**
     * Leave the QR code out of `text` and give it as `qr` instead: the QR code encodes the real link, so a caller that
     * shows the link once (the reveal pane) keeps it out of the words.
     */
    readonly qrApart?: boolean | undefined;
  } = {},
): Promise<AgentDevicePairingOutcome> {
  const reach = verbs.probe();
  if (!reach.available) {
    return { ok: false, error: `No device was paired: ${reach.reason}.`, next: 'Start or connect the GoodVibes host, then pair again.' };
  }
  // A code a phone could not open is never made for a phone: when only the
  // host's machine can open it, the code is made for a browser there, said so, with no QR.
  const readiness = await pairingReadiness(verbs, options.pairCommand ?? 'goodvibes-agent pair', reach.thisMachine !== false);
  // The one real question, asked in place of a command to run; its No keeps the answer below.
  const serveToNetwork = readiness !== null && (('refused' in readiness && readiness.servable === true) || 'thisMachine' in readiness)
    && options.askToServe !== undefined && await options.askToServe(SERVE_TO_NETWORK_QUESTION);
  if (!serveToNetwork && readiness !== null && 'refused' in readiness) return readiness.refused;
  const thisMachine = serveToNetwork ? undefined : readiness !== null && 'thisMachine' in readiness ? readiness.thisMachine : undefined;
  let result: PairingHandoffCreateResult;
  try {
    result = await verbs.invoke<PairingHandoffCreateResult>('pairing.handoff.create', {
      name: options.name?.trim() || defaultPairingTokenName(),
      offers: [...PAIRING_HANDOFF_OFFER_KINDS],
      ...(thisMachine ? { forThisMachine: true } : {}),
      ...(serveToNetwork ? { serveToNetwork: true } : {}),
    }, { explicitUserRequest: true }); // Only from the person's own pairing command or press: their request.
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
  const shownLink = options.mask === true ? maskPairingLink(link) : link;
  const shownCode = options.mask === true ? SECRET_MASK : result.token.token;
  const qrShown = result.deepLink !== undefined && !thisMachine && options.qr !== false;
  if (result.deepLink === undefined) {
    lines.push(
      `Minted device token "${result.token.name}" on the connected host, but the host has no web address configured, so there is no link a device can open.`,
      `  pairing fragment: ${shownLink}`,
      '  Set web.publicBaseUrl on the host, revoke this token in the host\'s device list, then pair again for a scannable link.',
    );
  } else if (thisMachine) {
    lines.push(...thisMachine, '', `  ${shownLink}`, `  Sign-in code: ${shownCode}  (to paste on the web UI's sign-in page, under Other ways to sign in)`);
  } else {
    // What is done and what is next, as one list; the code and its details follow.
    lines.push('Pair a phone', ...pairingReadySteps(result.posture?.origin ?? originOf(link), offerKinds));
    if (qrShown && options.qrApart !== true) lines.push('', renderQrToString(generateQrMatrix(link)));
    lines.push('', `  ${shownLink}`);
  }
  lines.push(`  Token name: ${result.token.name}  (rename or revoke it in the host's device list)`);
  if (offerKinds.length > 0) {
    lines.push('', 'Offers carried in this pairing (each declinable in the web app):', ...formatPairingOffers(offerKinds));
  }
  const capabilities = formatPostureCapabilities(result.posture);
  if (capabilities.length > 0) lines.push('', 'This device will get:', ...capabilities);
  const notice = pairingPostureNotice(result.posture);
  if (notice) lines.push('', notice);
  return {
    ok: true, tokenName: result.token.name, tokenId: result.token.id, link, forThisMachine: thisMachine !== undefined, qrShown, text: lines.join('\n'),
    ...(qrShown && options.qrApart === true ? { qr: renderQrToString(generateQrMatrix(link)) } : {}),
  };
}
