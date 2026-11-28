/**
 * listener.ts, the daemon's second listener: the web UI over https on the
 * local network, beside the plain listener, which is unchanged either way.
 *
 * Opt-in (`controlPlane.lanHttps.enabled`, off by default; on by itself on a
 * machine that follows its group's lead) and only while the plain listener is
 * bound beyond this machine (a loopback bind is already a secure context for
 * the browser on it). It runs the plain listener's own request handler, so
 * every route, sign-in rule and origin check is the same.
 *
 * Which certificate it serves is asked of the secure address service
 * (secure-address.ts) at every sync, which the daemon runs at each start and
 * each listener bind (a changed address, port or setting rebinds) and when a
 * `secureAddress.*` or `controlPlane.lanHttps.*` setting changes: no timer.
 * A failure to get a certificate or bind is logged and leaves the plain
 * listener serving; `state()` says what happened, for the Secure address
 * screen, `webui https status` and the pairing posture.
 */
import type { ConfigManager } from '../../config/manager.js';
import { isLoopbackHost } from '../../utils/reachable-base-url.js';
import { lanHttpsPort } from '../../pairing/web-origin.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { SecureAddressService, httpsCertificateSource, type HttpsCertificateSource, type SecureAddressSecrets } from './secure-address.js';
import { noteServedHttps } from './served-https.js';

export interface LanHttpsState {
  /** The https listener is up. */
  readonly serving: boolean;
  readonly port?: number | undefined;
  /** The names and addresses its certificate covers. */
  readonly names?: readonly string[] | undefined;
  /** When its certificate ends (epoch ms). */
  readonly notAfter?: number | undefined;
  /** Why it is not serving although it is switched on. */
  readonly problem?: string | undefined;
  /** Which certificate it serves (or would serve). */
  readonly source?: HttpsCertificateSource | undefined;
  /** `group`: the certificate came from the lead of this machine's group. */
  readonly from?: 'this-machine' | 'group' | undefined;
  /** The name phones open, when the certificate is for a name (Let's Encrypt, your own, a group's). */
  readonly hostName?: string | undefined;
}

type Serve = (port: number, tls: { readonly cert: string; readonly key: string }) => { stop(closeActiveConnections?: boolean): unknown };

/** Called after each sync with whether https is on here and what it serves (group-share.ts announces it to the group). */
type SyncObserver = (on: boolean, state: LanHttpsState) => void | Promise<void>;

export class LanHttpsListener {
  private server: { stop(closeActiveConnections?: boolean): unknown } | null = null;
  private current: LanHttpsState = { serving: false };
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private observer: SyncObserver | null = null;
  private syncWaiters: (() => void)[] = [];
  readonly secureAddress: SecureAddressService;

  constructor(private readonly deps: {
    readonly config: () => Pick<ConfigManager, 'get' | 'set' | 'setDaemonValues' | 'getControlPlaneConfigDir'>;
    readonly secrets: () => SecureAddressSecrets | null | undefined;
    readonly alertOwner?: ((text: string) => void) | undefined;
    /** The same, answering whether an owner channel carried it. */
    readonly noticeOwner?: ((text: string) => Promise<boolean>) | undefined;
    readonly secureAddress?: SecureAddressService | undefined;
  }) {
    this.secureAddress = deps.secureAddress ?? new SecureAddressService({
      config: deps.config, secrets: deps.secrets, alertOwner: (text) => deps.alertOwner?.(text),
      ...(deps.noticeOwner ? { noticeOwner: deps.noticeOwner } : {}),
    });
    this.secureAddress.attachListener(() => this.resync());
  }

  /** The plain listener's host and request handler, from its last bind; a settings change resyncs with them. */
  private bound: { readonly host: string; readonly serve: Serve } | null = null;

  state(): LanHttpsState { return this.current; }

  /** Told after each sync (the group share). */
  observe(observer: SyncObserver | null): void { this.observer = observer; }

  /** Resolves after the next sync finishes (a change on the Secure address screen waits for it). */
  nextSync(): Promise<void> { return new Promise((resolve) => { this.syncWaiters.push(resolve); }); }

  /** Sync again with the plain listener as last bound (a setting change, a new certificate). Never throws. */
  async resync(): Promise<void> {
    if (this.bound) await this.sync(this.bound.host, this.bound.serve);
  }

  /** Start, restart with a fresh certificate, or stop, as the settings say now. One at a time; never throws. */
  sync(plainHost: string, serve: Serve): Promise<void> {
    this.bound = { host: plainHost, serve };
    const gen = ++this.generation;
    const run = this.queue.then(() => this.syncNow(plainHost, serve, gen));
    this.queue = run.catch(() => {});
    return run;
  }

  private async syncNow(plainHost: string, serve: Serve, gen: number): Promise<void> {
    if (gen !== this.generation || this.bound === null) {
      for (const resolve of this.syncWaiters.splice(0)) resolve();
      return;
    }
    try {
      await this.stopServer();
      if (gen !== this.generation || this.bound === null) return;
      const config = this.deps.config();
      const following = this.secureAddress.groupFollowing();
      // A node follows its lead: https is on here because it is on there, on this machine's own https port.
      const port = following ? httpsPortSetting(config) : lanHttpsPort(config);
      const source = httpsCertificateSource(config);
      if (port === undefined) { this.current = { serving: false }; return; }
      if (isLoopbackHost(plainHost)) {
        this.current = { serving: false, port, source, problem: 'the web UI is served to this machine only; serve it to your network first: goodvibes-daemon webui enable --lan --https' };
        return;
      }
      const resolved = await this.secureAddress.resolve();
      if (gen !== this.generation || this.bound === null) return;
      if (!resolved.ok) { this.current = { serving: false, port, source, problem: resolved.problem }; return; }
      const certificate = resolved.certificate;
      try {
        this.server = serve(port, { cert: certificate.certPem, key: certificate.keyPem });
      } catch (error) {
        this.current = { serving: false, port, source: certificate.source, from: certificate.from, problem: `the https listener could not bind port ${port}: ${summarizeError(error)}` };
        logger.warn('DaemonServer: the LAN https listener could not start; the plain listener keeps serving', { port, error: summarizeError(error) });
        return;
      }
      this.secureAddress.noteServed(certificate);
      this.current = { serving: true, port, names: certificate.names, notAfter: certificate.notAfter, source: certificate.source, from: certificate.from, ...(certificate.hostName ? { hostName: certificate.hostName } : {}) };
      logger.info('DaemonServer: the web UI is also served over https on your network', { port, names: this.current.names, source: certificate.source, from: certificate.from });
    } catch (error) {
      this.current = { serving: false, problem: summarizeError(error) };
      logger.warn('DaemonServer: the LAN https listener could not start; the plain listener keeps serving', { error: summarizeError(error) });
    } finally {
      if (!this.current.serving) this.secureAddress.noteServed(null);
      noteServedHttps(this.current.serving && this.current.port !== undefined ? { port: this.current.port, hostName: this.current.hostName, names: this.current.names ?? [], source: this.current.source ?? 'local-authority' } : null);
      const ownOn = lanHttpsPort(this.deps.config()) !== undefined;
      try { await this.observer?.(ownOn, this.current); } catch (error) { logger.warn('secure address: the group could not be told', { error: summarizeError(error) }); }
      for (const resolve of this.syncWaiters.splice(0)) resolve();
    }
  }

  /** One comparison per request served over https: the certificate's renewal time with the clock. */
  noteRequest(): void {
    this.secureAddress.checkDue();
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      try { await server.stop(true); } catch (error) { logger.warn('DaemonServer: the LAN https listener did not close cleanly', { error: summarizeError(error) }); }
    }
  }

  /** Close it; `detached`: the plain listener is gone too, so a settings change starts nothing until the next bind. */
  async stop(detached = false): Promise<void> {
    this.generation += 1;
    if (detached) {
      this.bound = null;
      this.secureAddress.dispose();
    }
    const done = this.queue.then(async () => {
      await this.stopServer();
      if (this.current.serving) {
        this.current = { serving: false };
        this.secureAddress.noteServed(null);
        noteServedHttps(null);
      }
    });
    this.queue = done.catch(() => {});
    await done;
  }
}

/** The https port setting, whether or not https is switched on here (a node follows its lead's switch). */
function httpsPortSetting(config: Pick<ConfigManager, 'get'>): number | undefined {
  const port = Number(config.get('controlPlane.lanHttps.port'));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}
