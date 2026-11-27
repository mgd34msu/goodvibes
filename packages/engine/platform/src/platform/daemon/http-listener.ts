import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { httpMethodLabel, httpRequestDurationMs, httpRequestsTotal } from '../runtime/metrics.js';
import { HookDispatcher } from '../hooks/dispatcher.js';
import type { HookEvent } from '../hooks/types.js';
import {
  authenticateOperatorRequest,
  credentialKindOf,
  extractOperatorAuthToken,
  operatorPrincipalGrant,
  operatorRequestActor,
  type PairingTokenAuthenticator,
} from '../security/http-auth.js';
import { pathNamerOf, type CallerPathRules } from '../control-plane/caller-paths.js';
import { NO_OWNER_USER, type Actor } from '@goodvibes/engine/daemon-api/http-policy';
import { admitEffects } from '../security/effect-authority.js';
import { UserAuthManager } from '../security/user-auth.js';
import { ConfigManager } from '../config/manager.js';
import { resolveInboundTlsContext, type ResolvedInboundTlsContext } from '../runtime/network/index.js';
import { summarizeError } from '../utils/error-display.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import { requirePortAvailable } from './port-check.js';
import { resolveHostBinding } from './host-resolver.js';
import { createHostModeRestartWatcher, RestartController } from './host-mode-watcher.js';
import { AddressRateLimiter } from '@goodvibes/engine/daemon-api';
import { resolveClientAddress } from './client-address.js';
import { handleOperatorLogin, handleOperatorLogout, SIGN_IN_ATTEMPTS_PER_MINUTE } from './operator-login.js';
import { parseDaemonJsonBody } from './http/router-request-body.js';
import { authenticationRequiredResponse } from './http/error-response.js';
import { ownBrowserOrigins, refuseCookieWriteFromOtherOrigin } from './http/browser-origin.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitAuthFailed } from '../runtime/emitters/security.js';
import { captureJudgmentRuntime } from '../runtime/judgment-runtime-scope.js';

export { isCloudflareIp } from './client-address.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HttpListenerConfig {
  port?: number | undefined;
  host?: string | undefined;
  allowedOrigins?: string[] | undefined;
  hookDispatcher?: HookDispatcher | undefined;
  configManager: ConfigManager;
  /** The daemon's admission (work-admission.ts): while a self-update's restart holds it closed, no hook is fired. */
  workAdmission?: import('./work-admission.js').DaemonWorkAdmission | undefined;
  serveFactory?: typeof Bun.serve | undefined;
  /** Max requests per 60-second window per IP. Default: 60. */
  rateLimit?: number | undefined;
  /** Max POST /login attempts per 60-second window per IP. Default: 5. */
  loginRateLimit?: number | undefined;
  /**
   * When true, x-forwarded-for / x-real-ip headers are trusted for client IP
   * extraction (rate limiting, audit logging). Only enable behind a trusted
   * reverse proxy. Overrides the httpListener.trustProxy config value when set.
   */
  trustProxy?: boolean | undefined;
  /**
   * When true, CORS enforcement is active:
   *   - start() refuses to bind beyond loopback when allowedOrigins is empty
   *   - Requests carrying an Origin header are validated against allowedOrigins
   * Default: false (permissive, no CORS enforcement). Opt-in for multi-user,
   * internet-exposed, or enterprise deployments where browser-based CSRF is a
   * concern. Home/single-user local deployments do not need this. When true,
   * allowedOrigins must be configured or hostMode must be local/loopback.
   */
  enforceCors?: boolean | undefined;
  /**
   * When true, extract the real client IP from CF-Connecting-IP ONLY when the
   * connecting peer address belongs to a Cloudflare-owned CIDR range.
   * Requires trustProxy=true. Prevents header-injection bypass: a peer that is
   * not a Cloudflare edge node cannot fake CF-Connecting-IP to manipulate rate
   * limiting. When trustProxy=false, CF-Connecting-IP is ignored regardless.
   * Overrides the httpListener.trustCloudflare config value when set; absent,
   * that key decides. Default: false.
   */
  trustCloudflare?: boolean | undefined;
  /** Pre-configured UserAuthManager owned by the runtime service graph. */
  userAuth: UserAuthManager;
  pairingTokens?: PairingTokenAuthenticator | undefined;
  /**
   * The operator method catalog's default grant (full, or read-only for a
   * sign-in without the admin role), so a credential is judged here as the
   * control plane judges it. Absent: a credential holds only its stored list.
   */
  grantedScopes?: ((includeWrite: boolean) => readonly string[]) | undefined;
  /** When present, authentication outcomes are published on its `security` domain. */
  runtimeBus?: RuntimeEventBus | undefined;
  /**
   * Whether a refused credential is the daemon's operator token. The listener
   * never accepts that token; this only lets the refusal say why and which
   * token to send instead.
   */
  isOperatorToken?: ((token: string) => boolean) | undefined;
  /** Told when a request was refused for presenting the operator token (the host reports it to the owner once). */
  onOperatorTokenRefused?: (() => void) | undefined;
  /** Fires an event on one project's own hooks (its hooks file under the owner's trust): a webhook naming that project. */
  projectHooks?: ((folder: string, event: HookEvent) => Promise<Awaited<ReturnType<HookDispatcher['fire']>>>) | undefined;
  /** The daemon's caller rules (its one project check), read at each request naming a project. */
  callerRules?: (() => CallerPathRules | undefined) | undefined;
}

/** The refusal for a webhook sender that presented the operator token. Names no path, value or account. */
function operatorTokenNotAcceptedResponse(): Response {
  return Response.json({
    error: 'The operator token is not accepted by the webhook listener. Send the listener token instead.',
    code: 'OPERATOR_TOKEN_NOT_ACCEPTED',
    category: 'authentication',
    status: 401,
    next: ['On the daemon\'s machine, goodvibes-daemon listener token --show prints the listener token (kept in http-listener-token.json in the daemon home, or GOODVIBES_HTTP_TOKEN when that is set).'],
  }, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
}

interface HttpDangerConfig {
  httpListener: boolean;
}

/**
 * Read the shared control-plane CORS allowlist (controlPlane.cors.allowedOrigins,
 * a comma-separated string) into a trimmed origin list. Reused by the webhook
 * HttpListener so it honors the same allowlist as the control-plane router.
 */
function readCorsAllowedOrigins(configManager: ConfigManager): string[] {
  return configManager
    .get('controlPlane.cors.allowedOrigins')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

// ---------------------------------------------------------------------------
// HttpListener
// ---------------------------------------------------------------------------

const WEBHOOK_HOOK_PHASES: ReadonlySet<string> = new Set(['Pre', 'Post', 'Fail', 'Change', 'Lifecycle']);
/** The paths this listener answers; anything else is one `unmatched` metric label. */
const LISTENER_ROUTES: ReadonlySet<string> = new Set(['/login', '/logout', '/webhook', '/health']);

/**
 * HttpListener, webhook listener, disabled by default.
 *
 * Enable via: danger.httpListener = true in config.
 * All routes require Bearer token auth (set via enable()).
 * POST /webhook, parse hook event, fire through HookDispatcher.
 * GET  /health , liveness check.
 * Rate limited to 60 requests/minute per IP by default.
 */
export class HttpListener {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  /** The CORS allowlist as last read, kept while the settings revision is unchanged. */
  private corsOriginsCache: { readonly revision: number; readonly origins: readonly string[] } | null = null;
  private hookDispatcher: HookDispatcher | null;
  private authToken: string | null = null;
  private userAuth: UserAuthManager;
  /** Kept across a restart of the listener, so a restart does not hand an address fresh attempts. */
  private readonly rateLimiter: AddressRateLimiter;
  /** Dedicated tight limit for POST /login. */
  private readonly loginRateLimiter: AddressRateLimiter;
  private readonly configManager: ConfigManager;
  private readonly serveFactory: typeof Bun.serve;
  private tlsState: ResolvedInboundTlsContext | null = null;
  /** Unsubscribe from httpListener config key watchers; cleared on stop(). */
  private _configWatchUnsub: (() => void) | null = null;
  /**
   * The config-driven restart cycle. Its "down" state is a restart that
   * stopped the listener and could not start it again: the watcher keeps
   * treating the listener as restartable, so correcting the setting brings it
   * back instead of every later change being ignored.
   */
  private readonly restartCycle = new RestartController({
    isRunning: () => this.server !== null,
    run: async () => {
      try {
        logger.info('HttpListener: httpListener binding changed, restarting HTTP listener…');
        await this.stop();
        if (this.restartCycle.closed) return;
        // Re-resolve host/port from updated config
        const newBinding = resolveHostBinding(
          (this.configManager.get('httpListener.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
          String(this.configManager.get('httpListener.host') ?? '127.0.0.1'),
          Number(this.configManager.get('httpListener.port') ?? 3422),
          'httpListener',
        );
        this.host = newBinding.host;
        this.port = newBinding.port;
        await this.start();
      } finally {
        this.restartCycle.setDown(this.server === null && !this.restartCycle.closed);
      }
    },
    onError: (err) => logger.error('HttpListener: restart after config change failed; the listener is down until its binding is corrected', {
      error: summarizeError(err),
    }),
  });

  constructor(private config: HttpListenerConfig) {
    this.configManager = config.configManager;
    const resolvedHttpBinding = resolveHostBinding(
      (this.configManager.get('httpListener.hostMode') as 'local' | 'network' | 'custom' | undefined) ?? 'local',
      String(this.configManager.get('httpListener.host') ?? '127.0.0.1'),
      Number(this.configManager.get('httpListener.port') ?? 3422),
      'httpListener',
    );
    this.port = config.port ?? resolvedHttpBinding.port;
    this.host = config.host ?? resolvedHttpBinding.host;
    this.hookDispatcher = config.hookDispatcher ?? null;
    this.userAuth = config.userAuth;
    this.rateLimiter = new AddressRateLimiter(config.rateLimit ?? 60);
    this.loginRateLimiter = new AddressRateLimiter(config.loginRateLimit ?? SIGN_IN_ATTEMPTS_PER_MINUTE);
    this.serveFactory = config.serveFactory ?? Bun.serve;
  }

  // Proxy trust and CORS are read from the settings at each request (an explicit
  // HttpListenerConfig value overrides), so tightening one applies at once
  // instead of at the next daemon start. CORS uses the shared controlPlane.cors.*
  // keys the control-plane router honors; it stays permissive by default
  // because controlPlane.cors.enabled defaults false.

  /** Whether x-forwarded-for / x-real-ip are trusted for the client address. */
  private trustsProxy(): boolean {
    return this.config.trustProxy ?? Boolean(this.configManager.get('httpListener.trustProxy'));
  }

  /** Whether CF-Connecting-IP is trusted, and then only from a Cloudflare edge address. */
  private trustsCloudflare(): boolean {
    return this.config.trustCloudflare ?? Boolean(this.configManager.get('httpListener.trustCloudflare'));
  }

  /** Opt-in strict CORS enforcement. */
  private enforcesCors(): boolean {
    return this.config.enforceCors ?? (this.configManager.get('controlPlane.cors.enabled') === true);
  }

  /** The CORS allowlist, re-read only when the settings revision moved (every request when the owner has none). */
  private allowedOrigins(): readonly string[] {
    if (this.config.allowedOrigins) return this.config.allowedOrigins;
    const revision = (this.configManager as { readonly revisionSource?: { revision(): number } }).revisionSource?.revision();
    const cached = this.corsOriginsCache;
    if (cached && revision !== undefined && cached.revision === revision) return cached.origins;
    const origins = readCorsAllowedOrigins(this.configManager);
    this.corsOriginsCache = revision === undefined ? null : { revision, origins };
    return origins;
  }

  /**
   * Enable the listener. Requires danger.httpListener = true in config.
   * The provided token is used to authenticate all incoming requests.
   * Returns true if enabled, false if the config forbids it.
   */
  enable(dangerConfig: HttpDangerConfig, token?: string): boolean {
    if (!dangerConfig.httpListener) {
      logger.info('HttpListener.enable: danger.httpListener is false, not enabling');
      return false;
    }
    this.enabled = true;
    this.authToken = token ?? null;
    return true;
  }

  /**
   * Start listening. Refuses to start if not enabled.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info('HTTP listener is disabled. Enable via danger.httpListener config.');
      return;
    }
    if (this.authToken === null) {
      logger.info('HttpListener: starting with session-based authentication via UserAuth');
    }
    if (this.server !== null) {
      logger.info('HttpListener: already running');
      return;
    }
    // With CORS enforced, refuse to bind beyond loopback with an empty allowlist,
    // judged on the current settings at every bind. Off by default: home and
    // single-user deployments do not need CORS enforcement. Decided from the
    // address actually bound, not the raw setting: 'Network', ' network ' and
    // custom with 0.0.0.0 all bind beyond loopback and get the same refusal.
    if (this.enforcesCors() && this.allowedOrigins().length === 0 && !isLoopbackHost(this.host)) {
      throw new Error(
        `SECURITY_UNSAFE_ORIGIN_CONFIG: binding ${this.host} with CORS enforced (controlPlane.cors.enabled) requires a non-empty allowlist. `
        + 'Set controlPlane.cors.allowedOrigins to the trusted origins '
        + '(for example https://companion.example.com), or turn controlPlane.cors.enabled off.',
      );
    }

    // Skip the OS port probe when the host injects a custom serve factory.
    if (this.serveFactory === Bun.serve) {
      await requirePortAvailable(this.port, this.host, 'HTTP listener');
    }
    const self = this;
    // Requests are the starting daemon's work (its judgment port), started from its start().
    const inRuntime = captureJudgmentRuntime();
    this.tlsState = resolveInboundTlsContext(this.configManager, 'httpListener');
    this.server = this.serveFactory({
      port: this.port,
      hostname: this.host,
      ...(this.tlsState.tls ? { tls: this.tlsState.tls } : {}),
      async fetch(req, server): Promise<Response> {
        return inRuntime(() => self.handleRequest(req, server.requestIP(req)?.address));
      },
    });

    this.restartCycle.setDown(false);
    this._attachHttpListenerConfigWatcher();
    logger.info('HttpListener started', {
      port: this.port,
      host: this.host,
      tlsMode: this.tlsState.mode,
      scheme: this.tlsState.scheme,
      trustProxy: this.trustsProxy(),
    });
  }

  /**
   * Permanently fence config-driven restart admission without stopping owners.
   * Already admitted work remains observable through waitForRestart(). Hosts
   * call this synchronously before draining consumers, then await and stop.
   */
  fenceRestartAdmission(): void {
    this.restartCycle.fence();
    this._configWatchUnsub?.();
    this._configWatchUnsub = null;
  }

  /**
   * Wait for any in-progress config-driven restart to settle.
   */
  async waitForRestart(): Promise<void> {
    // Loop to handle dirty-flag chained restarts: each cycle may spawn another.
    // A settled promise that is still published must end the wait, never spin.
    while (this.restartCycle.pending) {
      const cycle = this.restartCycle.pending;
      await cycle;
      if (this.restartCycle.pending === cycle) break;
    }
  }

  /**
   * Stop the listener.
   */
  async stop(): Promise<void> {
    // Tear down config watcher only on intentional stop, not mid-restart.
    // During a restart cycle the watcher must stay active so
    // config changes that arrive between stop() and the subsequent start() can be
    // captured by the dirty flag. Done before the bound check: a restart
    // that failed to start again left this listener unbound with its watcher
    // still subscribed.
    if (!this.restartCycle.restarting) {
      this.restartCycle.reset();
      this._configWatchUnsub?.();
      this._configWatchUnsub = null;
    }
    const boundServer = this.server;
    this.tlsState = null;
    if (boundServer === null) return;
    boundServer.stop(true);
    this.server = null;
    logger.info('HttpListener stopped');
  }

  /**
   * Subscribe to httpListener binding keys and restart the server on change.
   * Called once from start() after the server is up. Clears itself on stop().
   */
  private _attachHttpListenerConfigWatcher(): void {
    if (this.restartCycle.closed) return;
    if (this._configWatchUnsub) return; // idempotent

    // The controller counts a change as live while the listener is bound,
    // mid-restart (so it is queued rather than lost) and after a restart that
    // left nothing bound; never after an intentional stop.
    const watcher = createHostModeRestartWatcher({
      configManager: this.configManager,
      // The address and its TLS: a restart of the listener reads both again.
      keys: ['httpListener.hostMode', 'httpListener.host', 'httpListener.port', 'httpListener.tls.mode', 'httpListener.tls.certFile', 'httpListener.tls.keyFile'],
      onRestart: () => this.restartCycle.request(),
      getIsRunning: () => this.restartCycle.active,
      // A write of the value a binding key already holds changes no binding: no restart while one is bound.
      isBound: () => this.server !== null,
    });
    this._configWatchUnsub = () => watcher.unsubscribe();
  }

  /**
   * Returns true if the listener is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  /** Who the request is (an `Actor`), or null when its credential does not authenticate. */
  private checkAuth(req: Request): Actor | null {
    const authenticated = authenticateOperatorRequest(req, {
      sharedToken: this.authToken,
      userAuth: this.userAuth,
      pairingTokens: this.config.pairingTokens,
    });
    if (authenticated === null) return null;
    const ownerUser = this.userAuth.ownerUsername();
    return operatorRequestActor(authenticated, ownerUser === null ? NO_OWNER_USER : { ownerUser },
      this.config.grantedScopes ?? (() => []));
  }

  /** A presented credential the listener refused; never carries the credential. */
  private emitAuthFailed(requestId: string, clientIp: string): void {
    if (!this.config.runtimeBus) return;
    emitAuthFailed(this.config.runtimeBus, { sessionId: 'system', traceId: `auth:${requestId}`, source: 'http-listener' },
      { usernameAttempted: '', clientIp, reason: 'invalid_credentials' });
  }

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  private async handleRequest(req: Request, peerIp?: string): Promise<Response> {
    const requestId = randomUUID();
    const startMs = Date.now();
    const url = new URL(req.url);
    const clientIp = resolveClientAddress(req, peerIp, {
      trustProxy: this.trustsProxy(),
      trustCloudflare: this.trustsCloudflare(),
    });
    let response: Response | null = null;
    try {
      response = await this._handleRequestInner(req, url, clientIp, requestId);
      return response;
    } finally {
      const status = response?.status ?? 500;
      const latencyMs = Date.now() - startMs;
      // structured HTTP access log, SIEM-ingestable
      logger.info('HTTP_ACCESS_LOG', {
        type: 'HTTP_ACCESS_LOG',
        requestId,
        method: req.method,
        path: url.pathname,
        status,
        latencyMs,
        clientIp,
      });
      // The status's own class: a 304 is not a 2xx, and a 101 upgrade is not an answer to count as one.
      const statusClass = `${Math.floor(status / 100)}xx`;
      // Labelled by the route that answered, never the path as sent, so the label sets stay as few as the routes.
      const pathPattern = LISTENER_ROUTES.has(url.pathname) ? url.pathname : 'unmatched';
      const method = httpMethodLabel(req.method);
      httpRequestsTotal.add(1, { method, status_class: statusClass });
      httpRequestDurationMs.record(latencyMs, { method, path_pattern: pathPattern, status_class: statusClass });
    }
  }

  private async _handleRequestInner(
    req: Request,
    url: URL,
    clientIp: string,
    requestId: string,
  ): Promise<Response> {

    // CORS origin check is opt-in via enforceCors. Default is permissive
    // for home and single-user deployments. When
    // enforceCors is true:
    //   - No Origin header → same-origin or non-browser request → allow.
    //   - Origin present + allowedOrigins empty → no allowlist configured; 403 CORS_NOT_CONFIGURED.
    //     (start() already refuses a bind beyond loopback with an empty allowlist; this is
    //     defence-in-depth for non-network modes configured with enforceCors.)
    //   - Origin present + allowedOrigins non-empty → check allowlist.
    if (this.enforcesCors()) {
      const origin = req.headers.get('origin');
      if (origin !== null) {
        const allowedOrigins = this.allowedOrigins();
        if (allowedOrigins.length === 0) {
          return Response.json({ error: 'CORS_NOT_CONFIGURED: no allowedOrigins set' }, { status: 403 });
        }
        if (!allowedOrigins.includes(origin)) {
          return Response.json({ error: 'ORIGIN_NOT_ALLOWED' }, { status: 403 });
        }
      }
    }

    // /login route handled AFTER origin check and under its own tight
    // rate-limit budget (5/min per IP) to prevent online brute-force attacks.
    // x-forwarded-for is only trustworthy when running behind a trusted reverse proxy.
    if (url.pathname === '/login' && req.method === 'POST') {
      return handleOperatorLogin(req, clientIp, {
        userAuth: this.userAuth,
        limiter: this.loginRateLimiter,
        runtimeBus: this.config.runtimeBus,
        source: 'http-listener',
        trustProxy: this.trustsProxy(),
      });
    }
    // No page is served from this port: the browser origins that may use the
    // sign-in cookie here are the control plane's own (where the web UI is served,
    // web.publicBaseUrl, tailscale serve, controlPlane.cors.allowedOrigins).
    const ownOrigins = (): readonly string[] => ownBrowserOrigins(this.configManager);
    // A sign-in session may end itself here as on the daemon.
    if (url.pathname === '/logout' && req.method === 'POST') {
      return handleOperatorLogout(req, {
        userAuth: this.userAuth,
        source: 'http-listener',
        trustProxy: this.trustsProxy(),
        allowedBrowserOrigins: ownOrigins,
      });
    }

    // General rate limiting for all other routes.
    if (!this.rateLimiter.allow(clientIp)) {
      return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
    }

    // A request carried by the sign-in cookie (no bearer, which a browser never
    // adds by itself) is served only for a page on one of the daemon's own
    // origins: a page on another port of this host cannot fire the owner's hooks.
    // A bearer caller (every real webhook sender) passes at the first test.
    if (extractOperatorAuthToken(req) !== '') {
      const refusedOrigin = refuseCookieWriteFromOtherOrigin(req, ownOrigins);
      if (refusedOrigin) return refusedOrigin;
    }

    const actor = this.checkAuth(req);
    if (actor === null) {
      // A request with no credential is a probe, answered 401 and not reported as a failed sign-in.
      const presented = extractOperatorAuthToken(req);
      if (presented) this.emitAuthFailed(requestId, clientIp);
      // A sender still holding the operator token (what webhook senders were
      // given before the listener had its own token) is told which token to send.
      if (presented && this.config.isOperatorToken?.(presented) === true) {
        this.config.onOperatorTokenRefused?.();
        return operatorTokenNotAcceptedResponse();
      }
      return authenticationRequiredResponse();
    }

    const { pathname, method } = { pathname: url.pathname, method: req.method };

    if (pathname === '/webhook' && method === 'POST') {
      // Firing the owner's hooks is the `hook.fire` effect, admitted here as on
      // the daemon's own hook routes: an admin (or the owner), with write:hooks.
      const admission = admitEffects(actor, ['hook.fire']);
      if (admission.kind !== 'allowed') {
        const missing = admission.kind === 'refused' ? admission.missing : 'owner';
        return Response.json({
          error: `Firing a hook needs ${missing === 'admin' ? 'an admin credential' : missing === 'owner' ? 'the owner' : missing}; this credential does not hold it. Nothing was fired.`,
          code: admission.kind === 'refused' ? (missing === 'admin' ? 'ADMIN_REQUIRED' : admission.code) : 'OWNER_ONLY',
          category: 'authorization', status: 403, effect: admission.effect, missing,
          next: [admission.kind === 'refused' ? admission.next : 'Ask the owner to fire it from their own credential.'],
        }, { status: 403 });
      }
      // Firing a hook starts work: during a self-update's hold it is refused with the router's code and fired by a retry.
      const closed = this.config.workAdmission?.refusalResponse();
      if (closed) return closed;
      return this.handleWebhook(req, actor);
    }

    if (pathname === '/health' && method === 'GET') {
      return Response.json({ status: 'ok' });
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private async handleWebhook(req: Request, actor: Actor): Promise<Response> {
    const body = await parseDaemonJsonBody(req);
    if (body instanceof Response) return body;
    // Whose event it is, and which project's hooks it fires: the project its call names (the project header, or `project`
    // in the body), checked as every call naming a project is; only that project's hooks file (under the owner's trust of
    // it) runs. The owner's own hooks for every project fire for the owner's own events only (their sign-in, their program,
    // the listener's own token they gave their senders).
    const ownersOwn = actor.class === 'owner' && actor.agentFor === undefined;
    const headerProject = req.headers.get('x-goodvibes-project');
    let named: string | undefined;
    try { named = headerProject ? decodeURIComponent(headerProject).trim() || undefined : undefined; } catch { named = undefined; }
    if (named === undefined && typeof body.project === 'string' && body.project.trim()) named = body.project.trim();
    if (named === undefined && !ownersOwn) {
      return Response.json({ error: 'This credential fires only the hooks of a project it was given: name that project (the x-goodvibes-project header, or "project" in the body). Nothing was fired.',
        code: 'NO_PROJECT', category: 'authorization', status: 422 }, { status: 422 });
    }
    if (named !== undefined) {
      const refusal = this.webhookProjectRefusal(req, named, ownersOwn);
      if (refusal) {
        return Response.json({ error: `${refusal} Nothing was fired.`, code: 'PROJECT_NOT_GIVEN', category: 'authorization', status: 403 }, { status: 403 });
      }
    }

    // Construct a HookEvent from the incoming payload
    const eventType = typeof body.event === 'string' ? body.event : 'webhook';
    const phase = typeof body.phase === 'string' ? body.phase : 'Post';
    if (!WEBHOOK_HOOK_PHASES.has(phase)) {
      return Response.json(
        { error: `Unknown hook phase '${phase}'; expected one of ${[...WEBHOOK_HOOK_PHASES].join(', ')}` },
        { status: 400 },
      );
    }

    const hookEvent: HookEvent = {
      path: `${phase as HookEvent['phase']}:webhook:${eventType}`,
      phase: phase as HookEvent['phase'],
      category: 'webhook',
      specific: eventType,
      sessionId: '',
      timestamp: Date.now(),
      payload: body,
    };

    // A project's event fires that project's hooks; the owner's own event naming no project fires their own hooks.
    const fire = named !== undefined
      ? (this.config.projectHooks ? (event: HookEvent) => this.config.projectHooks!(named!, event) : undefined)
      : this.hookDispatcher ? (event: HookEvent) => this.hookDispatcher!.fire(event) : undefined;
    if (!fire) {
      // No dispatcher wired, acknowledge without processing
      logger.info('HttpListener: no HookDispatcher wired, acknowledging without processing', {
        event: eventType,
      });
      return Response.json(
        { acknowledged: true, fired: false, reason: 'No HookDispatcher configured' },
        { status: 202 },
      );
    }

    try {
      const result = await fire(hookEvent);
      return Response.json(
        {
          acknowledged: true,
          fired: true,
          ok: result.ok,
          decision: result.decision ?? null,
          reason: result.reason ?? null,
          error: result.error ?? null,
        },
        { status: result.ok ? 200 : 422 },
      );
    } catch (err) {
      const message = summarizeError(err);
      logger.error('HttpListener: hook dispatch failed', { error: message });
      return Response.json({ error: `Hook dispatch failed: ${message}` }, { status: 500 });
    }
  }

  /**
   * Why this caller may not fire the hooks of project `folder`, or undefined: the one project check every call naming a
   * project passes (the daemon's caller rules), with the caller the request authenticated as. No check wired: only the
   * owner's own events name a project.
   */
  private webhookProjectRefusal(req: Request, folder: string, ownersOwn: boolean): string | undefined {
    if (!this.config.projectHooks) return 'This listener fires no project\'s hooks.';
    if (ownersOwn) return undefined;
    const rules = this.config.callerRules?.();
    const authenticated = authenticateOperatorRequest(req, { sharedToken: this.authToken, userAuth: this.userAuth, pairingTokens: this.config.pairingTokens });
    if (!rules || !authenticated) return `The project ${folder} is not among the projects given to this credential.`;
    const grant = operatorPrincipalGrant(authenticated, this.config.grantedScopes ?? (() => []));
    const verdict = rules.project(folder, pathNamerOf({ credentialKind: credentialKindOf(authenticated), principalId: grant.principalId,
      actor: this.checkAuth(req) ?? undefined }));
    return verdict.ok ? undefined : `The project ${folder} is not among the projects given to this credential (${verdict.reason}).`;
  }
}
