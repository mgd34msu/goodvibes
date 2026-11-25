import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import { actionKeyText } from '../../input/config-modal-keys.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import type {
  ConfigModalAction,
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { describeOriginPosture, generateQrMatrix, renderQrToString, type OriginPosture, type PairingHandoffOfferKind } from '@goodvibes/engine/platform/platform/pairing';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice, SERVE_TO_NETWORK_QUESTION } from '@goodvibes/engine/platform/platform/pairing';

// ---------------------------------------------------------------------------
// Device Pairing config-modal surface. Shows the web-app origin, the per-device
// token's name, a masked token/deep-link pair, the offer set with plain-language
// consequences, and a scannable QR of the `#pair=<token>` deep link, a camera
// scan opens the web app already signed in. No raw JSON connection blob is ever
// encoded.
//
// `getConnectionInfo` is a lazy thunk (loaded on the first buildView of each
// open). The token it shows is an offer: no device is added until one uses it.
// The modal keeps the offer across close and hands it back on the next open,
// so reopening shows the same QR while nobody has used it and it has not
// expired, and adds nothing; otherwise a new offer replaces it. A missing
// pairing service, or one that refuses to mint (for example the paired-device
// cap), degrades honestly to an "unavailable" state with the reason instead of
// throwing at registration time. "new device token" asks for a fresh offer in
// place; the one it replaces stops working unless a device already used it, and
// a device that did keeps working until it is revoked in the device surface.
// ---------------------------------------------------------------------------

export interface PairingModalConnectionInfo {
  /** The web-app origin the deep link opens (e.g. http://workshop.local:3141). */
  readonly url: string;
  /** The one-time pairing secret (masked unless revealed). */
  readonly token: string;
  /** The per-device token's editable name. */
  readonly tokenName: string;
  /** The `#pair=<token>` deep link the QR encodes, opens the web app signed in. */
  readonly deepLink: string;
  /** The offer set this pairing carries (each declinable in the web app). */
  readonly offers: readonly PairingHandoffOfferKind[];
  /**
   * The honest TLS/capability posture of the web origin the deep link opens
   * (the platform's describeOriginPosture / the handoff's `posture` field). The one
   * honest LAN line and the labeled capability list both render from here, never
   * from a locally-authored string. Absent when no web origin is known.
   */
  readonly posture?: OriginPosture | undefined;
  /** The minted token's id, so the next request can reuse or replace this offer. */
  readonly tokenId?: string | undefined;
  /**
   * Present when a phone could not open the link (the daemon serves only this
   * machine): the lines that say the link is for a browser on this computer,
   * why, and the steps that let a phone reach it. No QR is drawn then.
   */
  readonly thisMachineOnly?: readonly string[] | undefined;
}
/**
 * No code was made because there is nothing to open (the daemon serves no web
 * UI): the numbered steps that say so and end in the command that fixes it,
 * from the platform's pairing copy.
 */
export interface PairingModalUnreachable {
  readonly kind: 'unreachable';
  readonly lines: readonly string[];
}
/** What the modal asks of `getConnectionInfo`. */
export interface PairingConnectionRequest {
  /** The offer the modal showed last; reused while nobody has used it, else replaced. */
  readonly held?: PairingModalConnectionInfo | undefined;
  /** A new offer even when `held` is still open (the "new device token" action). */
  readonly fresh?: boolean | undefined;
  /** The name the person gave the device; the offer is minted with it. Absent: a dated default. */
  readonly name?: string | undefined;
}

/**
 * The name typed for the device the next open of the pairing view mints for
 * (`/devices pair device --name …`, the Pair something form). Taken once by that open.
 */
let pendingDeviceName: string | undefined;
export function namePairingOffer(name: string): void {
  const trimmed = name.trim();
  pendingDeviceName = trimmed.length > 0 ? trimmed : undefined;
}
export interface PairingModalControlPlaneSnapshot { readonly activeClientIds: readonly string[]; }
export interface PairingModalReadModel<T> { getSnapshot(): T; }

/** tailscale.get shape, the daemon's honest tailscale detection (quiet when absent). */
export interface PairingTailscaleStatus {
  readonly available: boolean;
  readonly loggedIn: boolean;
  readonly magicDnsName?: string | undefined;
  readonly httpsUrl?: string | undefined;
  readonly detail: string;
  readonly lastServe?: PairingTailscaleServeReceipt | undefined;
  /** The serve this daemon started and has not stopped; tailscale keeps it on until tailscale.serve.stop. */
  readonly activeServe?: PairingTailscaleServeReceipt | undefined;
}
/** tailscale.serve.run / tailscale.serve.stop receipt, rendered verbatim. */
export interface PairingTailscaleServeReceipt {
  readonly at: number;
  readonly action?: 'serve' | 'stop' | undefined;
  readonly command: string;
  readonly ok: boolean;
  readonly url?: string | undefined;
  /** A link tailscale printed for the user to act on, such as the page that turns Serve on for the tailnet. */
  readonly enableUrl?: string | undefined;
  readonly detail: string;
}
/** tailscale.serve.stop result: the receipt and what happened to web.publicBaseUrl. */
export interface PairingTailscaleStopResult {
  readonly receipt: PairingTailscaleServeReceipt;
  readonly publicBaseUrlRestored: boolean;
  readonly publicBaseUrlDetail: string;
  readonly receiptRecorded: boolean;
}

export interface PairingModalDeps {
  /** Lazy connection-info provider. Returns null when the daemon/companion
   *  token cannot be resolved, or throws with the reason (for example the
   *  paired-device cap); either way the modal renders an honest degraded state. */
  readonly getConnectionInfo: (request?: PairingConnectionRequest) => PairingModalConnectionInfo | PairingModalUnreachable | null;
  readonly controlPlaneReadModel?: PairingModalReadModel<PairingModalControlPlaneSnapshot>;
  /** Copies the text: `copied` when a clipboard program confirmed it, `sent` when it went to the terminal as OSC 52. */
  readonly copyToClipboard?: (text: string) => 'copied' | 'sent' | 'failed';
  /**
   * Probe tailscale (tailscale.get) on each open. Absent dep, a null result, or
   * `available:false` all keep the tailscale affordance QUIET, never a nag.
   * Present + available ⇒ the surface offers the one-action serve.
   */
  readonly probeTailscale?: () => Promise<PairingTailscaleStatus | null>;
  /**
   * Run tailscale.serve.run (behind the standard confirm) and return its receipt.
   * Wired only when probeTailscale is; the resulting https MagicDNS URL and the
   * receipt render in place.
   */
  readonly runTailscaleServe?: () => Promise<PairingTailscaleServeReceipt | null>;
  /**
   * Run tailscale.serve.stop (behind the standard confirm): turns off the serve
   * this daemon started and puts web.publicBaseUrl back. Offered only while a
   * serve is active.
   */
  readonly stopTailscaleServe?: () => Promise<PairingTailscaleStopResult | null>;
  /**
   * The owner's yes to SERVE_TO_NETWORK_QUESTION, asked in place when a phone
   * could not open the code: the daemon serves its web UI to the network and
   * answers with a code for the address phones can open. Throws with the reason.
   * Absent: the this-computer link is shown without the question.
   */
  readonly serveToNetwork?: (name?: string) => Promise<PairingModalConnectionInfo>;
}

// Fixed-width placeholder, deliberately NOT derived from the real secret's
// length (mirrors the retired pairing view's SECRET_MASK), so masking doesn't leak length.
const SECRET_MASK = '••••••••••••';

class PairingModalSurface implements ConfigModalSurface {
  readonly name = 'pairing-modal';
  readonly title = 'Device Pairing';
  private info: PairingModalConnectionInfo | null | undefined = undefined;
  /** Set when the last request made no code because a phone could not open it. */
  private unreachable: PairingModalUnreachable | null = null;
  /** The offer shown last, kept across close so the next open can reuse or replace it. */
  private held: PairingModalConnectionInfo | undefined = undefined;
  /** Why the last mint threw, shown in the degraded state; null when it returned null or has not run. */
  private infoError: string | null = null;
  private revealed = false;
  private requestRender: () => void = () => {};
  /** tailscale.get result: undefined = not probed yet, null = probed/absent (stays quiet). */
  private tailscale: PairingTailscaleStatus | null | undefined = undefined;
  /** Why the Tailscale probe failed (not "not installed": a probe that threw). */
  private tailscaleError: string | null = null;
  /** The receipt from a completed serve run, rendered verbatim under the affordance. */
  private serveReceipt: PairingTailscaleServeReceipt | null = null;
  /** True while a serve or stop run is in flight (each action is single-shot). */
  private serving = false;
  /** The serve this daemon has on (from the probe, then each serve or stop result); null when none. */
  private activeServe: PairingTailscaleServeReceipt | null = null;
  /**
   * The serve-to-network question for this open: 'ask' while it is on screen,
   * 'serving' while the daemon works on the yes, 'answered' after either
   * answer (or when it does not apply). Asked again on the next open.
   */
  private network: 'ask' | 'serving' | 'answered' = 'answered';
  /** Why the last yes did not serve, shown under the question; null when none. */
  private networkError: string | null = null;

  constructor(private readonly deps: PairingModalDeps) {}

  /** The question is on screen: the code's own keys wait until it is answered. */
  private asking(): boolean { return this.network !== 'answered'; }

  readonly actions = [
    // The two answers of the serve-to-network question, chosen with Enter (No is first, so it opens on No).
    { key: 'enter', id: 'answerNetwork', label: 'choose', enabledFor: (row: ConfigModalRow | null) => this.network === 'ask' && (row?.id === 'network:no' || row?.id === 'network:yes') },
    // While the QR code is shown alone, its one key switches to the other rows, and back.
    ((surface: PairingModalSurface): ConfigModalAction => ({
      key: 'd',
      id: 'toggleDetails',
      get label(): string { return surface.details ? 'QR code' : 'details'; },
      enabledFor: () => surface.fit === 'qr' && surface.unreachable === null && !surface.asking(),
    }))(this),
    { key: 'v', id: 'toggleReveal', label: 'reveal token', enabledFor: () => this.unreachable === null && !this.asking() && !this.qrAlone() },
    { key: 'c', id: 'copyLink', label: 'copy link', enabledFor: () => Boolean(this.deps.copyToClipboard) && this.unreachable === null && !this.asking() && !this.qrAlone() },
    { key: 'r', id: 'newToken', label: 'new device token', enabledFor: () => this.unreachable === null && !this.asking() && !this.qrAlone() },
    // The one-action serve affordance, offered ONLY when tailscale is detected
    // and not already serving https; a second 't' press (the standard confirm)
    // runs tailscale.serve.run. Absence keeps this key unadvertised and inert.
    {
      key: 't',
      id: 'tailscaleServe',
      label: 'serve over tailscale (https)',
      confirm: true,
      enabledFor: () => this.tailscale?.available === true && !this.serving && !this.qrAlone(),
    },
    // A serve stays on in tailscaled until it is stopped; 'x' (confirmed) stops
    // the one this daemon started and puts web.publicBaseUrl back.
    {
      key: 'x',
      id: 'tailscaleStop',
      label: 'stop serving over tailscale',
      confirm: true,
      enabledFor: () => Boolean(this.deps.stopTailscaleServe) && this.activeServe !== null && !this.serving && !this.qrAlone(),
    },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    // Probe tailscale on each open, so a daemon that came up since, or a serve
    // started or stopped elsewhere, is seen. The last known status stays on
    // screen until the new one lands. Tailscale being absent stays quiet; a
    // probe that failed says why in one dim row. While a serve or stop is in
    // flight its own result decides, so the probe's answer is not applied.
    if (this.deps.probeTailscale && !this.serving) {
      this.deps.probeTailscale()
        .then((status) => {
          if (this.serving) return;
          this.tailscale = status ?? null;
          this.activeServe = status?.activeServe ?? null;
          this.tailscaleError = null;
          this.requestRender();
        })
        .catch((error: unknown) => {
          if (this.serving) return;
          // The last known status stays; the row says this check did not confirm it.
          this.tailscaleError = summarizeError(error);
          this.requestRender();
        });
    }
  }

  /** The view is rebuilt on the next open; the offer is held so that open reuses or replaces it. */
  onClose(): void {
    this.info = undefined;
    this.unreachable = null;
    this.infoError = null;
    this.revealed = false;
    this.deviceName = undefined;
    // A yes in flight finishes on its own and is shown on the next open; otherwise the question is asked again then.
    if (this.network !== 'serving') { this.network = 'answered'; this.networkError = null; }
    this.networkAsked = false;
    this.fit = 'full';
    this.fitRows = undefined;
    this.details = false;
  }

  /** Set once the question has been put for this open, so a No is not asked again on the next render. */
  private networkAsked = false;

  /**
   * How the QR code fits the window: 'full' shows it under the intro and the address with the
   * other rows below; 'qr' shows the QR code and the address alone, whole, with a key that
   * switches to the other rows (`details`) and back; 'none' says in one line that the window is
   * too small, with the address and the key that shows the link.
   */
  private fit: 'full' | 'qr' | 'none' = 'full';
  /** The list rows seen in the current 'qr' or 'none' layout; a change means the window changed. */
  private fitRows: number | undefined = undefined;
  /** In the 'qr' fit: the other rows are shown instead of the QR code. */
  private details = false;
  /** The QR code's line count from the last view built (0 when none is drawn). */
  private qrLines = 0;

  /** The QR code and its address are on screen alone. */
  private qrAlone(): boolean { return this.fit === 'qr' && !this.details; }

  /**
   * The host tells how many list rows the layout just drawn gets. The full layout needs the
   * intro, the address and the whole QR code; the QR-alone layout (no search row, status or
   * blank rows) needs the address and the code. Each layout gets its own count, so the choice
   * is made again only when the window changes, never because the layout itself changed.
   */
  onViewportRows(rows: number): void {
    if (this.qrLines === 0 || this.details) return;
    const before = this.fit;
    if (this.fit === 'full') {
      if (rows < this.qrLines + 2) { this.fit = 'qr'; this.fitRows = undefined; }
    } else if (this.fit === 'qr') {
      if (this.fitRows === undefined) {
        this.fitRows = rows;
        if (rows < this.qrLines + 1) { this.fit = 'none'; this.fitRows = undefined; }
      } else if (rows !== this.fitRows) {
        this.fit = 'full';
        this.fitRows = undefined;
      }
    } else if (this.fitRows === undefined || rows < this.fitRows) {
      this.fitRows = rows;
    } else if (rows > this.fitRows) {
      // A larger window may hold the code again.
      this.fit = 'full';
      this.fitRows = undefined;
    }
    if (this.fit !== before) this.requestRender();
  }

  /** The name given for the device this open pairs, kept for a new token or a network serve in the same open. */
  private deviceName: string | undefined = undefined;

  private ensureInfo(fresh = false): PairingModalConnectionInfo | null {
    if (pendingDeviceName !== undefined) {
      this.deviceName = pendingDeviceName;
      pendingDeviceName = undefined;
      this.info = undefined;
    }
    if (this.info === undefined) {
      this.infoError = null;
      this.unreachable = null;
      try {
        const name = this.deviceName;
        const answer = this.deps.getConnectionInfo(this.held || fresh || name !== undefined
          ? { held: this.held, fresh, ...(name !== undefined ? { name } : {}) } : undefined);
        if (answer !== null && 'kind' in answer) {
          this.unreachable = answer;
          this.info = null;
        } else {
          this.info = answer;
          if (this.info) this.held = this.info;
        }
      } catch (error) { this.info = null; this.infoError = summarizeError(error); }
    }
    return this.info;
  }

  buildView(): ConfigModalView {
    const info = this.ensureInfo();
    this.qrLines = 0;
    if (this.unreachable) {
      // No code is shown: there is no web UI to open. The steps end in the command that fixes it.
      const rows: ConfigModalRow[] = this.unreachable.lines.map((line, i) => infoRow(`step:${i}`, line, i === 0 ? { fg: MODAL_TONES.reasoning } : {}));
      this.appendTailscaleRows(rows);
      // The serve and stop keys come from the action table's own hints.
      return { title: 'Device Pairing', tabs: [{ id: 'pairing', label: 'Pairing', rows, hints: [] }] };
    }
    if (!info) {
      return { title: 'Device Pairing', degraded: this.infoError
          ? `Device pairing is unavailable: ${this.infoError}`
          : 'Device pairing is unavailable: this session has no pairing token store.', tabs: [{ id: 'pairing', label: 'Pairing', rows: [] }] };
    }
    // A phone could not open this code: ask, in place and opening on No, whether to serve GoodVibes to the network.
    if (info.thisMachineOnly && this.deps.serveToNetwork && !this.networkAsked) { this.networkAsked = true; this.network = 'ask'; }
    if (this.asking()) {
      const rows: ConfigModalRow[] = [infoRow('network:question', SERVE_TO_NETWORK_QUESTION, { fg: MODAL_TONES.reasoning })];
      if (this.network === 'serving') {
        rows.push(infoRow('network:serving', 'Serving GoodVibes to your network; the code for phones appears here when the daemon is listening again…', { fg: MODAL_TONES.dim }));
        return { title: 'Device Pairing', tabs: [{ id: 'pairing', label: 'Pairing', rows, hints: [] }] };
      }
      rows.push({ id: 'network:no', label: 'No, keep the link for this computer only' });
      rows.push({ id: 'network:yes', label: 'Yes, serve it to my network (what goodvibes-daemon webui enable --lan does)' });
      if (this.networkError) rows.push(infoRow('network:error', `Not served: ${this.networkError}`, { fg: MODAL_TONES.warn }));
      return { title: 'Device Pairing', tabs: [{ id: 'pairing', label: 'Pairing', rows, hints: [] }] };
    }
    const { url, token, tokenName, deepLink, offers, posture, thisMachineOnly } = info;
    const displayToken = this.revealed ? token : SECRET_MASK;
    // The deep link carries the one-time token, so it is masked with the token.
    const displayLink = this.revealed ? deepLink : SECRET_MASK;

    const rows: ConfigModalRow[] = [];
    // The QR comes right after the address, before the details and the offers, so it is
    // on screen when the view opens. None for a link only this computer opens: a QR is for
    // another device. No raw JSON blob is ever encoded.
    const qr = thisMachineOnly ? [] : renderQrToString(generateQrMatrix(deepLink)).split('\n');
    this.qrLines = qr.length;
    const fit = qr.length === 0 ? 'full' : this.fit;
    // One non-selectable row per QR line, drawn cell for cell.
    const qrRows = (): void => qr.forEach((line, i) => rows.push(infoRow(`qr:${i}`, line, { fg: MODAL_TONES.qrDark, bg: MODAL_TONES.qrLight })));
    if (fit === 'qr' && !this.details) {
      // The window holds the code only on its own: the address and the code, whole, and the one key to the rest.
      rows.push(infoRow('url', `Web app   ${url}`));
      qrRows();
      return { title: 'Device Pairing', whole: true, tabs: [{ id: 'pairing', label: 'Pairing', rows, hints: [] }] };
    }
    if (thisMachineOnly) {
      // A phone could not open this link: it is for a browser on this computer,
      // and the steps say how a phone gets one. The Tailscale serve below is the other way.
      thisMachineOnly.forEach((line, i) => rows.push(infoRow(`step:${i}`, line, i === 0 ? { fg: MODAL_TONES.reasoning } : {})));
      rows.push(infoRow('intro', `Press ${actionKeyText('v')} to show the link and the sign-in code, then open the link in a browser here, or paste the code on its sign-in page.`, { fg: MODAL_TONES.dim }));
    } else if (fit === 'none') {
      // Not even the code alone fits: said in one line that fits an 80-column window; the address is the row under it.
      rows.push(infoRow('qr-fit', 'Too small for the QR code: open this address on the phone.', { fg: MODAL_TONES.reasoning }));
    } else if (fit === 'full') {
      rows.push(infoRow('intro', 'Scan with the GoodVibes web app to pair this device; it opens already signed in.', { fg: MODAL_TONES.dim }));
    }
    rows.push(infoRow('url', `Web app   ${url}`));
    if (fit === 'full') qrRows();
    rows.push(infoRow('name', `Device    ${tokenName}`));
    rows.push(infoRow('token', `Token     ${displayToken}`, { fg: MODAL_TONES.reasoning }));
    // A shown link is a row of its own id: the view takes it as a new row and wraps the whole
    // link over as many lines as it needs, instead of holding it to the one line the mask used.
    rows.push(infoRow(this.revealed ? 'link:shown' : 'link', `Link      ${displayLink}`, { fg: MODAL_TONES.dim }));
    if (this.deps.controlPlaneReadModel) {
      const connected = this.deps.controlPlaneReadModel.getSnapshot().activeClientIds.length;
      rows.push(infoRow('companions', `Devices connected: ${connected}`, connected > 0 ? { fg: MODAL_TONES.good } : { fg: MODAL_TONES.dim }));
    }

    // The offer set carried by this pairing, each named with its plain-language
    // consequence, each declinable in the web app.
    if (offers.length > 0) {
      rows.push(infoRow('offers-h', 'Offers (each declinable when you pair):', { fg: MODAL_TONES.dim }));
      formatPairingOffers(offers).forEach((line, i) => rows.push(infoRow(`offer:${i}`, line)));
    }
    // The labeled browser-capability list, what the paired device actually gets
    // over this origin (and, for a gated one, why not). Rendered from the posture,
    // never hidden behind a dead button.
    const capabilities = formatPostureCapabilities(posture);
    if (capabilities.length > 0) {
      rows.push(infoRow('caps-h', 'This device will get:', { fg: MODAL_TONES.dim }));
      capabilities.forEach((line, i) => rows.push(infoRow(`cap:${i}`, line)));
    }
    // The ONE honest LAN line, the platform posture's own notice (LAN_PLAIN_HTTP_NOTICE),
    // present only for the plain-http-on-LAN posture, never a nag elsewhere.
    const notice = pairingPostureNotice(posture);
    if (notice) rows.push(infoRow('posture', notice, { fg: MODAL_TONES.reasoning }));
    // The tailscale serve affordance, quiet unless tailscale is detected.
    this.appendTailscaleRows(rows);

    // The keys come from the action table's own hints (reveal, copy, new token, serve, stop).
    const hints: string[] = [];
    return {
      title: 'Device Pairing',
      tabs: [{ id: 'pairing', label: 'Pairing', rows, hints }],
    };
  }

  /**
   * Append the tailscale section, quiet when tailscale is undetected or
   * unavailable. When detected, the surface names the one-action serve; once a
   * serve has produced (or tailscale already reports) an https MagicDNS URL, that
   * URL and the serve receipt render verbatim so the encrypted path is visible.
   */
  private appendTailscaleRows(rows: ConfigModalRow[]): void {
    const ts = this.tailscale;
    if (this.tailscaleError !== null) rows.push(infoRow('ts-error', `Tailscale check failed: ${this.tailscaleError}`, { fg: MODAL_TONES.dim }));
    if (!ts || !ts.available) return; // absence stays quiet
    // The detected https URL is only what a serve would yield; it is shown as
    // encrypted access only while a serve is actually on.
    const servedUrl = this.activeServe?.url;
    if (servedUrl) {
      rows.push(infoRow('ts-h', `Encrypted access (Tailscale), press ${actionKeyText('x')} to stop serving:`, { fg: MODAL_TONES.dim }));
      rows.push(infoRow('ts-url', `  ${servedUrl}`, { fg: MODAL_TONES.good }));
    } else {
      const target = ts.httpsUrl ? ` at ${ts.httpsUrl}` : ' (MagicDNS)';
      rows.push(infoRow('ts-h', `Tailscale detected: press ${actionKeyText('t')} to serve this app over https${target}.`, { fg: MODAL_TONES.reasoning }));
    }
    const receipt = this.serveReceipt ?? ts.lastServe;
    if (receipt) {
      rows.push(infoRow('ts-receipt', `  ${receipt.ok ? '✓' : '✗'} ${receipt.detail}`, receipt.ok ? { fg: MODAL_TONES.dim } : { fg: MODAL_TONES.warn }));
      if (!receipt.ok && receipt.enableUrl) {
        rows.push(infoRow('ts-enable', `  Turn on Serve for your tailnet: ${receipt.enableUrl}`, { fg: MODAL_TONES.reasoning }));
      }
    } else if (this.serving) {
      rows.push(infoRow('ts-serving', '  Working with tailscale…', { fg: MODAL_TONES.dim }));
    }
  }

  onAction(id: string, ctx: ConfigModalActionContext): void {
    const info = this.ensureInfo();
    if (id === 'answerNetwork') { this.answerNetwork(ctx.row?.id === 'network:yes', ctx); return; }
    if (id === 'toggleDetails') { this.details = !this.details; this.requestRender(); return; }
    if (id === 'toggleReveal') { this.revealed = !this.revealed; this.requestRender(); return; }
    if (id === 'tailscaleServe') { this.runTailscaleServe(ctx); return; }
    if (id === 'tailscaleStop') { this.stopTailscaleServe(ctx); return; }
    if (id === 'copyLink') {
      if (!this.deps.copyToClipboard || !info) { ctx.setStatus(`No pairing link to copy; press ${actionKeyText('v')} to reveal it instead.`); return; }
      const written = this.deps.copyToClipboard(info.deepLink);
      ctx.setStatus(written === 'failed'
        ? `Could not copy the link; press ${actionKeyText('v')} to reveal it instead.`
        : written === 'copied'
          ? 'Copied the pairing link.'
          : `Sent the pairing link to your terminal's clipboard, if your terminal supports it (OSC 52); press ${actionKeyText('v')} to reveal it if the paste is empty.`);
      return;
    }
    if (id === 'newToken') {
      // A fresh offer + QR in place. The offer it replaces stops working unless a
      // device already used it; a device that did is paired and stays until revoked.
      const previous = this.info;
      this.info = undefined;
      this.revealed = false;
      const fresh = this.ensureInfo(true);
      if (fresh === null) {
        // A refused mint (e.g. the device cap) keeps the token already on screen rather than blanking a working QR.
        this.info = previous ?? null;
        ctx.setStatus(this.infoError ? `Could not mint a device token: ${this.infoError}` : 'Could not mint a device token.');
        this.requestRender();
        return;
      }
      this.requestRender();
      ctx.setStatus(`New device token${fresh.thisMachineOnly ? '' : ' and QR'} shown. The previous one no longer works unless a device already paired with it; paired devices are listed in Devices and network, on its Paired tab (also in the web UI).`);
      return;
    }
  }

  /**
   * No keeps the this-computer link on screen. Yes asks the daemon to serve its
   * web UI to the network; its answer is the code for phones, shown here in
   * place of the this-computer link. A refusal keeps the question with its reason.
   */
  private answerNetwork(yes: boolean, ctx: ConfigModalActionContext): void {
    if (!yes || !this.deps.serveToNetwork) { this.network = 'answered'; this.requestRender(); return; }
    this.network = 'serving';
    this.networkError = null;
    this.requestRender();
    this.deps.serveToNetwork(this.deviceName)
      .then((served) => {
        this.info = served;
        this.held = served;
        this.revealed = false;
        this.network = 'answered';
        ctx.setStatus(`GoodVibes is served to your network; phones can open ${served.url}.`);
        this.requestRender();
      })
      .catch((error: unknown) => {
        this.network = 'ask';
        // In full: the daemon's reason ends in the command that fixes it.
        this.networkError = error instanceof Error ? error.message : String(error);
        this.requestRender();
      });
  }

  /**
   * Run the one-action tailscale serve (tailscale.serve.run) after the standard
   * confirm has fired. The resulting https MagicDNS URL and receipt render in
   * place; a failed run keeps its honest receipt detail rather than a dead row.
   */
  private runTailscaleServe(ctx: ConfigModalActionContext): void {
    if (!this.deps.runTailscaleServe || this.serving) return;
    this.serving = true;
    this.requestRender();
    this.deps.runTailscaleServe()
      .then((receipt) => {
        this.serving = false;
        this.serveReceipt = receipt;
        if (receipt?.ok && receipt.url) {
          this.activeServe = receipt;
          // The address a code would carry changed: decided again on the next render.
          this.info = undefined;
        }
        if (receipt?.ok && receipt.url) ctx.setStatus(`Serving over tailscale: ${receipt.url}`);
        else if (receipt) ctx.setStatus(`Tailscale serve did not complete: ${receipt.detail}`);
        this.requestRender();
      })
      .catch((err: unknown) => {
        this.serving = false;
        this.serveReceipt = { at: Date.now(), command: 'tailscale serve', ok: false, detail: summarizeError(err) };
        ctx.setStatus(`Tailscale serve failed: ${summarizeError(err)}`);
        this.requestRender();
      });
  }

  /**
   * Stop the serve this daemon started (tailscale.serve.stop) after the standard
   * confirm. The receipt renders in place and the status names what happened to
   * web.publicBaseUrl.
   */
  private stopTailscaleServe(ctx: ConfigModalActionContext): void {
    if (!this.deps.stopTailscaleServe || this.serving || !this.activeServe) return;
    this.serving = true;
    this.requestRender();
    this.deps.stopTailscaleServe()
      .then((result) => {
        this.serving = false;
        if (result) {
          this.serveReceipt = result.receipt;
          if (result.receipt.ok) {
            this.activeServe = null;
            // The address a code would carry changed: decided again on the next render.
            this.info = undefined;
            ctx.setStatus(`Stopped serving over tailscale. ${result.publicBaseUrlDetail}`);
          } else {
            ctx.setStatus(`Tailscale serve was not stopped: ${result.receipt.detail}`);
          }
        } else {
          ctx.setStatus('Tailscale serve was not stopped: the daemon is not reachable.');
        }
        this.requestRender();
      })
      .catch((err: unknown) => {
        this.serving = false;
        this.serveReceipt = { at: Date.now(), action: 'stop', command: 'tailscale serve --https=443 off', ok: false, detail: summarizeError(err) };
        ctx.setStatus(`Tailscale stop failed: ${summarizeError(err)}`);
        this.requestRender();
      });
  }
}

export function createPairingModalSurface(deps: PairingModalDeps): ConfigModalSurface {
  return new PairingModalSurface(deps);
}
