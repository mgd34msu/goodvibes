/**
 * listener.ts, the daemon's second listener: the web UI over https on the
 * local network, beside the plain listener, which is unchanged either way.
 *
 * Opt-in (`controlPlane.lanHttps.enabled`, off by default) and only while the
 * plain listener is bound beyond this machine (a loopback bind is already a
 * secure context for the browser on it). It runs the plain listener's own
 * request handler, so every route, sign-in rule and origin check is the same.
 *
 * Its certificate is made again at every sync, which the daemon runs at each
 * start and each listener bind (a changed address, port or setting rebinds),
 * for the names and private addresses the machine has at that moment: no
 * timer. A failure to make or bind it is logged and leaves the plain listener
 * serving; `state()` says what happened, for `webui https status` and the
 * pairing posture.
 */
import type { ConfigManager } from '../../config/manager.js';
import { isLoopbackHost } from '../../utils/reachable-base-url.js';
import { lanHttpsPort } from '../../pairing/web-origin.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { lanServerNames, loadOrCreateLanAuthority, type LanAuthoritySecrets } from './authority.js';
import { issueLanServerCertificate } from './x509.js';

export interface LanHttpsState {
  /** The https listener is up. */
  readonly serving: boolean;
  readonly port?: number | undefined;
  /** The names and addresses its certificate covers. */
  readonly names?: readonly string[] | undefined;
  /** When its certificate ends (epoch ms); it is made again before at the next start or bind. */
  readonly notAfter?: number | undefined;
  /** Why it is not serving although it is switched on. */
  readonly problem?: string | undefined;
}

type Serve = (port: number, tls: { readonly cert: string; readonly key: string }) => { stop(closeActiveConnections?: boolean): unknown };

export class LanHttpsListener {
  private server: { stop(closeActiveConnections?: boolean): unknown } | null = null;
  private current: LanHttpsState = { serving: false };

  constructor(private readonly deps: {
    readonly config: () => Pick<ConfigManager, 'get'>;
    readonly secrets: () => LanAuthoritySecrets | null | undefined;
  }) {}

  /** The plain listener's host and request handler, from its last bind; a settings change resyncs with them. */
  private bound: { readonly host: string; readonly serve: Serve } | null = null;

  state(): LanHttpsState { return this.current; }

  /** Sync again with the plain listener as last bound (a `controlPlane.lanHttps.*` change). Never throws. */
  async resync(): Promise<void> {
    if (this.bound) await this.sync(this.bound.host, this.bound.serve);
  }

  /** Start, restart with a fresh certificate, or stop, as the settings say now. Never throws. */
  async sync(plainHost: string, serve: Serve): Promise<void> {
    this.bound = { host: plainHost, serve };
    await this.stop();
    const config = this.deps.config();
    const port = lanHttpsPort(config);
    if (port === undefined) { this.current = { serving: false }; return; }
    if (isLoopbackHost(plainHost)) {
      this.current = { serving: false, port, problem: 'the web UI is served to this machine only; serve it to your network first: goodvibes-daemon webui enable --lan --https' };
      return;
    }
    const secrets = this.deps.secrets();
    if (!secrets) { this.current = { serving: false, port, problem: 'this daemon has no secret store to keep the certificate authority in' }; return; }
    try {
      const authority = await loadOrCreateLanAuthority(secrets);
      const certificate = issueLanServerCertificate(authority, lanServerNames());
      this.server = serve(port, { cert: certificate.certPem, key: certificate.keyPem });
      this.current = { serving: true, port, names: [...certificate.dnsNames, ...certificate.addresses], notAfter: certificate.notAfter };
      logger.info('DaemonServer: the web UI is also served over https on your network', { port, names: this.current.names });
    } catch (error) {
      this.current = { serving: false, port, problem: summarizeError(error) };
      logger.warn('DaemonServer: the LAN https listener could not start; the plain listener keeps serving', { port, error: summarizeError(error) });
    }
  }

  /** Close it; `detached`: the plain listener is gone too, so a settings change starts nothing until the next bind. */
  async stop(detached = false): Promise<void> {
    if (detached) this.bound = null;
    const server = this.server;
    this.server = null;
    if (server) {
      try { await server.stop(true); } catch (error) { logger.warn('DaemonServer: the LAN https listener did not close cleanly', { error: summarizeError(error) }); }
    }
    if (this.current.serving) this.current = { serving: false };
  }
}
