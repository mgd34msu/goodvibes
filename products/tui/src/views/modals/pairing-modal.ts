import { MODAL_TONES } from './modal-theme.ts';
import { infoRow } from './modal-surface-helpers.ts';
import { actionKeyText } from '../../input/config-modal-keys.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import type {
  ConfigModalActionContext,
  ConfigModalRow,
  ConfigModalSurface,
  ConfigModalView,
} from '../../input/config-modal-types.ts';
import { describeOriginPosture, generateQrMatrix, renderQrToString, type OriginPosture, type PairingHandoffOfferKind } from '@goodvibes-jev/engine/platform/platform/pairing';
import { formatPairingOffers, formatPostureCapabilities, pairingPostureNotice } from '@goodvibes-jev/engine/platform/platform/pairing';

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
}
/** What the modal asks of `getConnectionInfo`. */
export interface PairingConnectionRequest {
  /** The offer the modal showed last; reused while nobody has used it, else replaced. */
  readonly held?: PairingModalConnectionInfo | undefined;
  /** A new offer even when `held` is still open (the "new device token" action). */
  readonly fresh?: boolean | undefined;
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
  readonly getConnectionInfo: (request?: PairingConnectionRequest) => PairingModalConnectionInfo | null;
  readonly controlPlaneReadModel?: PairingModalReadModel<PairingModalControlPlaneSnapshot>;
  /** Writes the terminal clipboard escape; true when it was written (the terminal never confirms it). */
  readonly copyToClipboard?: (text: string) => boolean | void;
  /**
   * Probe tailscale (tailscale.get) once on open. Absent dep, a null result, or
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
}

// Fixed-width placeholder, deliberately NOT derived from the real secret's
// length (mirrors the retired pairing view's SECRET_MASK), so masking doesn't leak length.
const SECRET_MASK = '••••••••••••';

class PairingModalSurface implements ConfigModalSurface {
  readonly name = 'pairing-modal';
  readonly title = 'Device Pairing';
  private info: PairingModalConnectionInfo | null | undefined = undefined;
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

  constructor(private readonly deps: PairingModalDeps) {}

  readonly actions = [
    { key: 'v', id: 'toggleReveal', label: 'reveal token' },
    { key: 'c', id: 'copyLink', label: 'copy link', enabledFor: () => Boolean(this.deps.copyToClipboard) },
    { key: 'r', id: 'newToken', label: 'new device token' },
    // The one-action serve affordance, offered ONLY when tailscale is detected
    // and not already serving https; a second 't' press (the standard confirm)
    // runs tailscale.serve.run. Absence keeps this key unadvertised and inert.
    {
      key: 't',
      id: 'tailscaleServe',
      label: 'serve over tailscale (https)',
      confirm: true,
      enabledFor: () => this.tailscale?.available === true && !this.serving,
    },
    // A serve stays on in tailscaled until it is stopped; 'x' (confirmed) stops
    // the one this daemon started and puts web.publicBaseUrl back.
    {
      key: 'x',
      id: 'tailscaleStop',
      label: 'stop serving over tailscale',
      confirm: true,
      enabledFor: () => Boolean(this.deps.stopTailscaleServe) && this.activeServe !== null && !this.serving,
    },
  ];

  onOpen(requestRender: () => void): void {
    this.requestRender = requestRender;
    // Probe tailscale once on open; the affordance stays quiet until (and unless)
    // this resolves to an available status. Tailscale being absent stays quiet;
    // a probe that failed says why in one dim row.
    if (this.deps.probeTailscale && this.tailscale === undefined) {
      this.deps.probeTailscale()
        .then((status) => { this.tailscale = status ?? null; this.activeServe = status?.activeServe ?? null; this.tailscaleError = null; this.requestRender(); })
        .catch((error: unknown) => { this.tailscale = null; this.tailscaleError = summarizeError(error); this.requestRender(); });
    }
  }

  /** The view is rebuilt on the next open; the offer is held so that open reuses or replaces it. */
  onClose(): void {
    this.info = undefined;
    this.infoError = null;
    this.revealed = false;
  }

  private ensureInfo(fresh = false): PairingModalConnectionInfo | null {
    if (this.info === undefined) {
      this.infoError = null;
      try {
        this.info = this.deps.getConnectionInfo(this.held || fresh ? { held: this.held, fresh } : undefined);
        if (this.info) this.held = this.info;
      } catch (error) { this.info = null; this.infoError = summarizeError(error); }
    }
    return this.info;
  }

  buildView(): ConfigModalView {
    const info = this.ensureInfo();
    if (!info) {
      return { title: 'Device Pairing', degraded: this.infoError
          ? `Device pairing is unavailable: ${this.infoError}`
          : 'Device pairing is unavailable: this session has no pairing token store.', tabs: [{ id: 'pairing', label: 'Pairing', rows: [] }] };
    }
    const { url, token, tokenName, deepLink, offers, posture } = info;
    const displayToken = this.revealed ? token : SECRET_MASK;
    // The deep link carries the one-time token, so it is masked with the token.
    const displayLink = this.revealed ? deepLink : SECRET_MASK;

    const rows: ConfigModalRow[] = [];
    rows.push(infoRow('intro', 'Scan with the GoodVibes web app to pair this device; it opens already signed in.', { fg: MODAL_TONES.dim }));
    rows.push(infoRow('url', `Web app   ${url}`));
    rows.push(infoRow('name', `Device    ${tokenName}`));
    rows.push(infoRow('token', `Token     ${displayToken}`, { fg: MODAL_TONES.reasoning }));
    rows.push(infoRow('link', `Link      ${displayLink}`, { fg: MODAL_TONES.dim }));
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

    // ASCII QR of the deep link, a camera scan opens the web app already
    // carrying the one-time token. No raw JSON blob is ever encoded. The
    // multi-line preformatted string is split into one non-selectable row per row.
    const qr = renderQrToString(generateQrMatrix(deepLink));
    qr.split('\n').forEach((line, i) => rows.push(infoRow(`qr:${i}`, line, { fg: MODAL_TONES.qrDark, bg: MODAL_TONES.qrLight })));

    const hints = [this.revealed ? 'v hide token' : 'v reveal token'];
    if (this.tailscale?.available && !this.serving) hints.push('t serve over tailscale');
    if (this.deps.stopTailscaleServe && this.activeServe && !this.serving) hints.push('x stop serving');
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
    if (id === 'toggleReveal') { this.revealed = !this.revealed; this.requestRender(); return; }
    if (id === 'tailscaleServe') { this.runTailscaleServe(ctx); return; }
    if (id === 'tailscaleStop') { this.stopTailscaleServe(ctx); return; }
    if (id === 'copyLink') {
      if (!this.deps.copyToClipboard || !info) { ctx.setStatus(`No pairing link to copy; press ${actionKeyText('v')} to reveal it instead.`); return; }
      const written = this.deps.copyToClipboard(info.deepLink);
      ctx.setStatus(written === false
        ? `Could not write to the terminal clipboard; press ${actionKeyText('v')} to reveal the link instead.`
        : `Sent the pairing link to the terminal clipboard, if your terminal supports it (OSC 52); press ${actionKeyText('v')} to reveal it if the paste is empty.`);
      return;
    }
    if (id === 'newToken') {
      // A fresh offer + QR in place. The offer it replaces stops working unless a
      // device already used it; a device that did is paired and stays until revoked.
      const previous = this.info;
      this.info = undefined;
      this.revealed = false;
      if (this.ensureInfo(true) === null) {
        // A refused mint (e.g. the device cap) keeps the token already on screen rather than blanking a working QR.
        this.info = previous ?? null;
        ctx.setStatus(this.infoError ? `Could not mint a device token: ${this.infoError}` : 'Could not mint a device token.');
        this.requestRender();
        return;
      }
      this.requestRender();
      ctx.setStatus('New device token and QR shown. The previous one no longer works unless a device already paired with it; paired devices are listed by /devices, and in the web UI under Settings, Devices and pairing.');
      return;
    }
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
        if (receipt?.ok && receipt.url) this.activeServe = receipt;
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
