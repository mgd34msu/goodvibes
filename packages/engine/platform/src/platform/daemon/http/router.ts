import { DAEMON_CHALLENGE_HEADER, daemonIdentityHeaders, dialledPort } from '../identity-proof.js';
import { createServingSettingsPrecondition } from './settings-precondition.js';
import { createServingSettingsImportPrecondition } from './settings-import-precondition.js';
import type { ConfigManager } from '../../config/manager.js';
import { deriveControlPlaneBaseUrl, readControlPlaneBinding } from '../../config/control-plane-base-url.js';
import { AddressRateLimiter, type BrowserJudgmentCapability } from '@goodvibes-jev/engine/daemon-api';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { CONFIG_SCHEMA, isValidConfigKey } from '../../config/schema.js';
import { coerceSchemaValue } from '../../config/manager-bootstrap.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { DECISION_MODEL_POLICY_HEADER, DecisionModelsDisabledError, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { DecisionModelPolicyChangedError, withDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { createCredentialStatusProvider } from '../../config/credential-status.js';
import { buildAutomationEmptyState } from '../../runtime/feature-announcements.js';
import type { UserAuthManager } from '../../security/user-auth.js';
import { OPERATOR_SESSION_COOKIE_NAME, buildOperatorSessionCookie, extractOperatorAuthToken, type CredentialRefusal } from '../../security/http-auth.js';
import { webAppLink } from '../web-app-link.js';
import type { AgentManager } from '../../tools/agent/index.js';
import {
  normalizeAtSchedule,
  normalizeCronSchedule,
  normalizeEverySchedule,
  type AutomationManager,
  type CreateAutomationJobInput,
  type UpdateAutomationJobInput,
} from '../../automation/index.js';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../../control-plane/index.js';
import type { GatewayMethodCatalog } from '../../control-plane/index.js';
import { buildOperatorContract } from '../../control-plane/operator-contract.js';
import { CLIENT_COMPATIBILITY_FLOOR, CLIENT_COMPATIBILITY_FLOOR_HEADER } from '../../control-plane/client-compatibility.js';
import { openScopedSessionEventStream } from './session-event-stream.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import {
  getProviderRuntimeSnapshot,
  getProviderUsageSnapshot,
  listProviderRuntimeSnapshots,
} from '../../providers/runtime-snapshot.js';
import type { RouteBindingManager, ChannelPolicyManager, ChannelPluginRegistry, SurfaceRegistry } from '../../channels/index.js';
import type { WatcherRegistry } from '../../watchers/index.js';
import type { InboundMailHealthLike } from './channel-route-types.js';
import type { DistributedPeerAuth, DistributedRuntimeManager, RemoteBackendHost } from '../../runtime/remote/index.js';
import type { HomeGraphService, KnowledgeService, ProjectPlanningService } from '../../knowledge/index.js';
import { inspectKnowledgeGraphqlAccess, KnowledgeGraphqlService } from '../../knowledge/index.js';
import type { VoiceService } from '../../voice/index.js';
import type { WebSearchService } from '../../web-search/index.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { MediaProviderRegistry } from '../../media/index.js';
import type { MultimodalService } from '../../multimodal/index.js';
import type { IntegrationHelperService } from '../../runtime/integration/helpers.js';
import type { DomainDispatch, RuntimeStore } from '../../runtime/store/index.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import type { DaemonBatchManager } from '../../batch/index.js';
import type { CloudflareTunnelConnector } from '../../cloudflare/tunnel-connector.js';
import { emitCompanionMessageReceived } from '../../runtime/emitters/session.js';
import { createAuthFailureAudit, type AuthFailureAudit } from '../auth-failure-audit.js';
import { emitCompanionPairRequested, emitCompanionPairVerified } from '../../runtime/emitters/security.js';
import { clientAddressOf, resolveClientAddress } from '../client-address.js';
import { handleOperatorLogin, handleOperatorLogout, SIGN_IN_ATTEMPTS_PER_MINUTE } from '../operator-login.js';
import { correlationCtx } from '../../runtime/correlation.js';
import { TelemetryApiService } from '../../runtime/telemetry/api.js';
import { inspectInboundTls, inspectOutboundTls } from '../../runtime/network/index.js';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '../../state/index.js';
import { clusterGroupRouteExtension, type ClusterGroupVerbs } from './cluster-group-routes.js';
import { buildRouterKnowledgeContext } from './router-knowledge-context.js';
import { handleGitHubAutomationWebhook, handleSlackSurfaceWebhook, handleDiscordSurfaceWebhook, handleNtfySurfaceWebhook, handleGenericWebhookSurface } from '../../adapters/index.js';
import {
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
  matchPeerRoute,
} from './remote-routes.js';
import { buildRouterSessionBrokerAdapter } from './router-session-broker-adapter.js';
import { authenticationRequired, DaemonRequestRouter, type DaemonRouteDispatcher } from './request-router.js';
import { buildDaemonRouteTable, type DaemonRouteFamilies } from './route-table.js';
import {
  buildChannelRouteContext,
  buildKnowledgeRouteContext,
  buildMediaRouteContext,
  buildSystemRouteContext,
} from './router-route-contexts.js';
import type { GenericWebhookAdapterContext, SurfaceAdapterContext } from '../../adapters/index.js';
import type { PlatformServiceManager } from '../service-manager.js';
import type { JsonRecord } from '../helpers.js';
import { jsonErrorResponse, serviceFailureStatus } from './error-response.js';
import { missingScopeRefusal } from '@goodvibes-jev/engine/daemon-api/error-response';
import { VERSION } from '../../version.js';
import type { CompanionChatManager } from '../../companion/companion-chat-manager.js';
import { principalHasScope, type RequestContext, type RequestPrincipal } from '../http-policy.js';
import { dispatchCompanionChatRoutes, isCompanionChatPath } from '../../companion/companion-chat-routes.js';
import { dispatchModelRoutes } from './model-routes.js';
import { dispatchBatchRoutes } from './batch-routes.js';
import { gateGatewayBinding } from './gateway-binding-gate.js';
import { isSurfaceIngressEnabled } from '../surface-policy.js';
import { dispatchCloudflareRoutes } from './cloudflare-routes.js';
import { dispatchMcpRoutes } from './mcp-routes.js';
import { HomeAssistantConversationRoutes } from './homeassistant-routes.js';
import { HomeGraphRoutes } from './home-graph-routes.js';
import { dispatchOpenAICompatibleRoutes } from './openai-compatible-routes.js';
import { ProjectPlanningRoutes } from './project-planning-routes.js';
import {
  parseDaemonJsonBody,
  parseDaemonJsonText,
  parseOptionalDaemonJsonBody,
} from './router-request-body.js';
import {
  applyCorsHeaders,
  handleCorsPreflight,
  resolveWebuiServingPosture,
  serveWebuiBundle,
  type WebuiServingPosture,
} from './webui-serving.js';

interface DaemonHttpRouterContext {
  readonly configManager: ConfigManager;
  /** Native listener facts, never request Host/Forwarded headers or a stored URL. */
  readonly listenerBinding?: () => { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' };
  readonly serviceRegistry: ServiceRegistry;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly automationManager: AutomationManager;
  readonly approvalBroker: ApprovalBroker;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPolicy: ChannelPolicyManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly surfaceRegistry: SurfaceRegistry;
  /** Inbound mail's health. Absent means no mailbox, NOT a healthy one. */
  readonly inboundMailHealth?: (() => InboundMailHealthLike | null) | undefined;
  readonly distributedRuntime: DistributedRuntimeManager;
  /** Registered execution backends `remote.peers.invoke` runs a command on; absent where the host keeps none. */
  readonly remoteBackends?: RemoteBackendHost | undefined;
  readonly watcherRegistry: WatcherRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchService: WebSearchService;
  readonly mcpRegistry: import('../../mcp/registry.js').McpRegistry;
  readonly mcpConfigRoots: import('../../mcp/config.js').McpConfigRoots;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly artifactStore: ArtifactStore;
  readonly memoryRegistry: MemoryRegistry;
  /** Consolidation receipts + pending proposals for the memory.consolidation.receipts route. */
  readonly memoryConsolidation?: { listReceipts(): readonly unknown[] } | null | undefined;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly platformServiceManager: PlatformServiceManager;
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
  readonly batchManager?: DaemonBatchManager | null | undefined;
  /** The daemon's Cloudflare Tunnel connector: provisioning starts it, status reports it, shutdown stops it. */
  readonly cloudflareTunnel?: CloudflareTunnelConnector | null | undefined;
  /** Borrowed from the runtime graph; the graph owns admission shutdown and awaited drain. */
  readonly browserJudgment?: BrowserJudgmentCapability | undefined;
  readonly githubWebhookSecret: string | null;
  readonly authToken: () => string | null;
  readonly settingsAuthority?: import('./settings-precondition.js').ServingSettingsAuthority | undefined;
  readonly settingsImportAuthority?: import('./settings-import-precondition.js').ServingSettingsImportAuthority | undefined;
  readonly nativeMutationHost?: import('../../permissions/external-request.js').ExternalPermissionHost | undefined;
  readonly buildSurfaceAdapterContext: () => SurfaceAdapterContext;
  readonly buildGenericWebhookAdapterContext: () => GenericWebhookAdapterContext;
  /**
   * The request's principal, authenticated once where the request entered and
   * read back by every later check on it (an integer compare while no
   * credential changed). Null when the request carries no valid credential.
   */
  readonly authenticateRequest: (req: Request) => RequestContext | null;
  /**
   * Why a presented credential the daemon knows is refused, with the next step
   * (a device token over its rotation age, an unused pairing offer that expired).
   * Asked only on the 401 path. Absent or null: the plain authentication refusal.
   */
  readonly describeCredentialRefusal?: ((token: string) => CredentialRefusal | null) | undefined;
  readonly extractAuthToken: (req: Request) => string;
  readonly requireAuthenticatedSession: (req: Request) => { username: string; roles: readonly string[] } | null;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<DistributedPeerAuth | Response>;
  readonly invokeGatewayMethodCall: (input: {
    readonly authToken: string;
    readonly methodId: string;
    readonly signal?: AbortSignal | undefined;
    readonly query?: Record<string, unknown> | undefined;
    readonly body?: unknown | undefined;
    readonly context?: {
      readonly principalId?: string | undefined;
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly admin?: boolean | undefined;
      readonly scopes?: readonly string[] | undefined;
      readonly clientKind?: string | undefined;
      /** The daemon-assigned id of the connection the call arrived on; separates one client's untrusted-content window from another's under the same principal. */
      readonly connectionId?: string | undefined;
    };
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('../../automation/routes.js').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string; readonly contractId?: string; readonly sessionId?: string },
  ) => void;
  /** A surface that ran the turn in its own process reports the answer; see DaemonSurfaceDeliveryHelper. */
  readonly completeSurfaceReplyFromSurface: (input: { readonly agentId: string; readonly sessionId?: string | undefined; readonly body: string; readonly status?: 'completed' | 'failed' | 'cancelled' | undefined }) => Promise<boolean>;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly syncSpawnedAgentTask: (record: import('../../tools/agent/index.js').AgentRecord, sessionId?: string) => void;
  readonly syncFinishedAgentTask: (record: import('../../tools/agent/index.js').AgentRecord) => void;
  /**
   * WorkspaceSwapManager instance for delegating POST /config runtime.workingDir
   * requests. Null in embedded/test contexts that don't support live workspace swaps.
   */
  readonly swapManager: import('./system-route-types.js').WorkspaceSwapManagerLike | null;
  /**
   * Optional companion chat manager. When present, companion chat routes
   * (/api/companion/chat/...) are enabled. Injected by the daemon facade
   * when the companion feature is active.
   */
  readonly companionChatManager?: CompanionChatManager | null | undefined;
  /** Resolve the current provider/model for companion-chat session creation. */
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /** Resolves provider API keys from the configured secret store. */
  readonly secretsManager?: Pick<import('../../config/secrets.js').SecretsManager, 'get' | 'set' | 'getGlobalHome' | 'list' | 'listDetailed'> & Partial<import('./settings-precondition.js').ServingSettingsSecrets & import('./settings-import-precondition.js').ServingSettingsImportSecrets> | null | undefined;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => import('../../tools/agent/index.js').AgentRecord | Response;
}

/** Unauthenticated pair requests one client address may make in a minute; a person asks once and waits for approval. */
const PAIR_REQUESTS_PER_MINUTE = 10;

/** The id (never the secret value) of the token a successful pair verification issued. */
async function pairedTokenId(response: Response): Promise<string> {
  try {
    const body: unknown = await response.clone().json();
    const token = typeof body === 'object' && body !== null ? (body as { token?: { id?: unknown } }).token : undefined;
    return typeof token?.id === 'string' ? token.id : 'unknown';
  } catch {
    return 'unknown';
  }
}

export class DaemonHttpRouter {
  private readonly settingsPrecondition: ReturnType<typeof createServingSettingsPrecondition> | undefined;
  private readonly settingsImportPrecondition: ReturnType<typeof createServingSettingsImportPrecondition> | undefined;
  private readonly telemetryApi: TelemetryApiService | null;
  private homeAssistantRoutes: HomeAssistantConversationRoutes | null = null;
  private homeGraphRoutes: HomeGraphRoutes | null = null;
  private projectPlanningRoutes: ProjectPlanningRoutes | null = null;
  /** Supplied by the daemon facade after construction; these feed /status. */
  private statusProviders: import('./router-route-contexts.js').DaemonStatusProviders = {};
  private clusterGroupVerbs: ClusterGroupVerbs | null = null;

  /** Wire receipts (update/crash announcements) and the cluster role into /status. */
  setDaemonStatusProviders(providers: import('./router-route-contexts.js').DaemonStatusProviders): void {
    this.statusProviders = { ...this.statusProviders, ...providers };
  }

  /** Wire the LAN group verbs (`/api/cluster/*`), see cluster-group-routes.ts. */
  setClusterGroupVerbs(verbs: ClusterGroupVerbs): void { this.clusterGroupVerbs = verbs; }

  private readonly authFailures: AuthFailureAudit;
  /** Per-address sign-in attempts; kept for the router's life, so a listener rebind does not reset it. */
  private readonly signInLimiter = new AddressRateLimiter(SIGN_IN_ATTEMPTS_PER_MINUTE);
  /** Per-address unauthenticated pair requests: each one is stored and announced, so a stranger may not make them at line rate. */
  private readonly pairRequestLimiter = new AddressRateLimiter(PAIR_REQUESTS_PER_MINUTE);
  private servingPostureCache: { readonly revision: number; readonly posture: WebuiServingPosture } | null = null;
  /** The request path: who is calling and what is served, see request-router.ts. */
  private readonly requests: DaemonRequestRouter;

  constructor(private readonly context: DaemonHttpRouterContext) {
    this.requests = new DaemonRequestRouter({
      authenticate: (req) => context.authenticateRequest(req),
      // Built by the first request that reaches the table, then kept for the
      // router's life: the daemon hands over some owners after construction,
      // and every family reads them when a request runs, not when it is built.
      routes: () => buildDaemonRouteTable(this.routeFamilies()),
      preAuth: (req) => this.dispatchPreAuthRoutes(req),
      refuseUnauthenticated: (req) => this.refuseUnauthenticated(req),
      admit: (req) => gateGatewayBinding(req, context),
    });
    this.authFailures = createAuthFailureAudit(context.runtimeBus);
    const settingsConfigOwner = context.configManager;
    const settingsAuthorityOwner = context.settingsAuthority;
    const importAuthorityOwner = context.settingsImportAuthority;
    this.settingsImportPrecondition = importAuthorityOwner ? createServingSettingsImportPrecondition({
      manager: settingsConfigOwner, authority: importAuthorityOwner,
      secrets: () => {
        const owner = context.secretsManager;
        return owner?.prepareImport && owner.inspectPreparedImport && owner.assertPreparedImport && owner.withPreparedImport && owner.assertCompletedImport
          ? owner as import('./settings-import-precondition.js').ServingSettingsImportSecrets : null;
      },
      host: () => context.nativeMutationHost,
      assertServingOwner: () => {
        if (context.configManager !== settingsConfigOwner || context.settingsImportAuthority !== importAuthorityOwner) throw new Error('Settings import serving owner changed.');
      },
    }) : undefined;
    this.settingsPrecondition = context.settingsAuthority ? createServingSettingsPrecondition(context.configManager, context.settingsAuthority, () => {
      const owner = context.secretsManager;
      return owner?.prepareScopedDeletion && owner.inspectPreparedScopedDeletion && owner.assertPreparedScopedDeletion && owner.withPreparedScopedDeletion && owner.assertCompletedScopedDeletion
        ? owner as import('./settings-precondition.js').ServingSettingsSecrets : null;
    }, () => {
      if (context.configManager !== settingsConfigOwner || context.settingsAuthority !== settingsAuthorityOwner) throw new Error('Settings serving owner changed.');
    }) : undefined;
    this.telemetryApi = context.runtimeStore
      ? new TelemetryApiService({
        runtimeBus: context.runtimeBus,
        runtimeStore: context.runtimeStore,
        includeRawPrompts: () => this.getConfigValue('telemetry.includeRawPrompts') === true,
        // The snapshot's pending approvals are the broker's; read when a snapshot is asked for.
        listApprovals: () => context.approvalBroker.listApprovals(Number.MAX_SAFE_INTEGER),
      })
      : null;
  }

  dispose(): void {
    this.telemetryApi?.dispose();
    this.context.batchManager?.dispose();
    void this.context.cloudflareTunnel?.dispose();
  }

  /**
   * The web UI serving posture, read from settings again only when the settings
   * revision moved. A config owner without a revision is read every time.
   */
  private servingPosture(): WebuiServingPosture {
    const revision = (this.context.configManager as { readonly revisionSource?: { revision(): number } }).revisionSource?.revision();
    const cached = this.servingPostureCache;
    if (cached && revision !== undefined && cached.revision === revision) return cached.posture;
    const posture = resolveWebuiServingPosture(this.context.configManager, this.context.gatewayMethods);
    this.servingPostureCache = revision === undefined ? null : { revision, posture };
    return posture;
  }

  /** The port this daemon listens on: the bound listener's, else the configured one. */
  private listeningPort(): number {
    return this.context.listenerBinding?.().port ?? readControlPlaneBinding((key) => this.getConfigValue(key)).port;
  }

  /**
   * The ports of the public addresses this daemon declares as its own
   * (`controlPlane.publicBaseUrl`, and `web.publicBaseUrl`, which a Tailscale
   * serve sets): a host that dials one of them can verify the identity proof.
   */
  private publicPorts(): number[] {
    const ports: number[] = [];
    for (const key of ['controlPlane.publicBaseUrl', 'web.publicBaseUrl']) {
      const value = this.getConfigValue(key);
      const port = typeof value === 'string' && value.trim() ? dialledPort(value.trim()) : undefined;
      if (port !== undefined) ports.push(port);
    }
    return ports;
  }

  private getConfigValue(key: string): unknown {
    const getter = (this.context.configManager as { readonly get?: unknown }).get;
    return typeof getter === 'function' ? getter.call(this.context.configManager, key) : undefined;
  }

  async handleRequest(req: Request): Promise<Response> {
    return withDecisionModelPolicy(() => this.getConfigValue('judgment.policy'), () => correlationCtx.run(
      { requestId: req.headers.get('x-request-id') ?? crypto.randomUUID() },
      async () => {
        // Opt-in cross-origin + bundle-serving posture (both default off → no CORS,
        // no bundle, daemon behaves exactly as before). CORS preflight is answered
        // pre-auth (a browser OPTIONS carries no credentials; only allowlisted
        // origins are granted, never a wildcard).
        const serving = this.servingPosture();
        if (serving.cors.enabled && req.method === 'OPTIONS') {
          return applyCorsHeaders(req, handleCorsPreflight(req, serving), serving);
        }
        // Same-origin bundle serving is pre-auth: the built app is public and
        // token-authenticates its own API calls; reserved API paths return null
        // here (API precedence) and flow to the normal auth-gated dispatch below.
        const asset = serving.serveBundle ? await serveWebuiBundle(req, serving) : null;
        // An error leaves as the route wrote it: its code is the fact a client reads, so nothing is attached for a model to read.
        const response = asset ?? await this.requests.route(req).catch((error: unknown) => {
          if (error instanceof DecisionModelPolicyChangedError) throw error;
          // Decision models are off (no decision model) and this feature needs one: the owner's setting, not a daemon fault.
          if (error instanceof DecisionModelsDisabledError) {
            return jsonErrorResponse({
              error: error.message,
              code: 'DECISION_MODELS_DISABLED',
              category: 'bad_request',
              state: 'no decision model is in use (none is set, or judgment.policy is No Decision Model)',
              next: ['Set a decision model (judgment.model, judgment.endpoint or TYPESAFE_API_KEY) with judgment.policy Hybrid or Decision Model Only to use this, or use the alternative the message names'],
            }, { status: 409 });
          }
          // A route that throws must still answer: a bare rejection reaches the
          // listener as a dropped connection with nothing for the caller to act on.
          logger.error('[daemon-http] request handler failed', { method: req.method, path: new URL(req.url).pathname, error: summarizeError(error) });
          const status = serviceFailureStatus(error, 500);
          // An error the daemon raised on purpose names itself; anything else may carry a path or a query, so it gets a fixed sentence.
          const classified = typeof error === 'object' && error !== null && typeof (error as { readonly category?: unknown }).category === 'string';
          return classified
            ? jsonErrorResponse(error, { status })
            : Response.json({
              error: 'The daemon could not complete this request.',
              code: 'INTERNAL_ERROR',
              guidance: status === 503 ? 'Retry shortly.' : 'The failure is in the daemon log; retrying the same request is unlikely to help.',
            }, { status });
        });
        if (response.status === 101) return response;
        const observed = new Response(response.body, response);
        // Every answer to a host's identity challenge carries the proof, whatever its
        // status, so a host never takes a proof-less answer (a 200 included) for the daemon.
        if (req.headers.has(DAEMON_CHALLENGE_HEADER)) {
          const identity = daemonIdentityHeaders(req, this.context.authToken(), this.listeningPort(), this.publicPorts());
          for (const [name, value] of Object.entries(identity)) observed.headers.set(name, value);
        }
        try { observed.headers.set(DECISION_MODEL_POLICY_HEADER, JSON.stringify(decisionModelPolicyState())); }
        catch (error) {
          // An explicit policy setting write can retire its own request scope
          // after committing. Preserve the real acknowledgement; omit obsolete
          // operation metadata rather than claiming the new policy governed it.
          if (!(error instanceof DecisionModelPolicyChangedError)) throw error;
        }
        return serving.cors.enabled ? applyCorsHeaders(req, observed, serving) : observed;
      },
    ));
  }

  /** The 401 for a request without a valid credential; a refused credential the daemon knows is told why. */
  private refuseUnauthenticated(req: Request): Response {
    // Only a presented credential that was refused is a failed sign-in; a
    // request with none is a probe (a starting host's identity challenge is one).
    const presented = this.context.extractAuthToken(req);
    if (presented) this.authFailures.record(this.clientIpOf(req), 'control-plane-router');
    // A device token the pairing store knows but refuses (over its rotation age,
    // or an offer that expired unused) is told why and what to do.
    const known = presented ? this.context.describeCredentialRefusal?.(presented) ?? null : null;
    if (known) {
      return jsonErrorResponse({ error: known.reason, code: known.code, state: known.state, next: known.next }, { status: 401 });
    }
    return authenticationRequired();
  }

  /**
   * Dispatches routes that are exempt from the auth gate: login, remote-peer
   * handshake, webhooks, and the control-plane web UI.
   */
  private async dispatchPreAuthRoutes(req: Request): Promise<Response | null> {
    const url = new URL(req.url);

    if (url.pathname === '/login' && req.method === 'POST') {
      return this.handleLogin(req);
    }
    // A session may end itself even when it no longer passes the gate's other checks.
    if (url.pathname === '/logout' && req.method === 'POST') {
      return handleOperatorLogout(req, {
        userAuth: this.context.userAuth,
        source: 'control-plane-router',
        trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
      });
    }

    // The peer endpoints, matched by the method and path the published peer contract states.
    const peerRoute = matchPeerRoute(req.method, url.pathname);
    if (peerRoute?.id === 'pair.request') {
      if (!this.pairRequestLimiter.allow(this.clientIpOf(req))) {
        const refused = jsonErrorResponse({
          error: 'Too many requests', code: 'RATE_LIMITED', state: 'this address used its pair requests for the minute',
          next: ['Wait a minute, then ask to pair again'],
        }, { status: 429 });
        refused.headers.set('Retry-After', '60');
        return refused;
      }
      const response = await handleRemotePairRequest({
        parseJsonBody: (request) => this.parseJsonBody(request),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
      if (response.ok) emitCompanionPairRequested(this.context.runtimeBus, this.securityContext(req, 'pair-request'), { clientIp: this.clientIpOf(req) });
      return response;
    }
    if (peerRoute?.id === 'pair.verify') {
      const response = await handleRemotePairVerify({
        parseJsonBody: (request) => this.parseJsonBody(request),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
      if (response.ok) {
        const tokenId = await pairedTokenId(response);
        emitCompanionPairVerified(this.context.runtimeBus, this.securityContext(req, 'pair-verify'), { tokenId, clientIp: this.clientIpOf(req) });
      }
      return response;
    }
    if (peerRoute?.id === 'peer.heartbeat') {
      return handleRemotePeerHeartbeat({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
    }
    if (peerRoute?.id === 'work.pull') {
      return handleRemotePeerWorkPull({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        distributedRuntime: this.context.distributedRuntime,
      }, req);
    }
    if (peerRoute?.id === 'work.complete' && peerRoute.params.workId) {
      return handleRemotePeerWorkComplete({
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        distributedRuntime: this.context.distributedRuntime,
      }, peerRoute.params.workId, req);
    }

    if (url.pathname === '/webhook/github' && req.method === 'POST') {
      return this.handleGitHubWebhook(req);
    }
    if (url.pathname.startsWith('/webhook/')) {
      const inboundPlugin = this.context.channelPlugins.getByPath(url.pathname);
      if (inboundPlugin && !isSurfaceIngressEnabled(this.context.configManager, inboundPlugin.surface)) {
        // Refused before any adapter reads the body or authorizes the sender.
        return Response.json({
          error: `The ${inboundPlugin.surface} surface is turned off`,
          code: 'SURFACE_DISABLED',
          guidance: `Set surfaces.${inboundPlugin.surface}.enabled to true to accept messages from it again.`,
        }, { status: 503 });
      }
      const pluginResponse = await this.context.channelPlugins.handleInbound(url.pathname, req);
      if (pluginResponse) return pluginResponse;
    }

    if (url.pathname === '/api/control-plane/web' && req.method === 'GET') {
      // Links sent before approvals opened the web app still land there, on the approval or session they name.
      const target = webAppLink(this.context.configManager, {
        approvalId: url.searchParams.get('approval') ?? undefined,
        sessionId: url.searchParams.get('session') ?? undefined,
      }, { reachableOffHost: false });
      if (target) return new Response(null, { status: 302, headers: { Location: target } });
      // No web app is served anywhere this daemon knows of: the control plane's
      // built-in page is the operator page this daemon has.
      return this.context.controlPlaneGateway.renderWebUi();
    }
    if (url.pathname === '/api/control-plane/auth' && req.method === 'GET') {
      const apiResponse = await this.requests.dispatch(req);
      if (apiResponse) return this.renewSessionCookie(req, apiResponse);
    }

    return null;
  }

  /**
   * Null when the caller holds `scope` (the admin token holds every scope), the
   * 403 naming the missing scope otherwise. A request with no recognised
   * principal holds none.
   */
  private requireCallerScope(req: Request, scope: string): Response | null {
    const principal = this.context.authenticateRequest(req)?.principal;
    if (principal && principalHasScope(principal, scope)) return null;
    const refusal = missingScopeRefusal('this request', [scope], principal?.scopes);
    return refusal ? jsonErrorResponse(refusal, { status: 403 }) : null;
  }

  /**
   * A sign-in session is extended while it is used, but the browser drops its cookie at the
   * end it was given at sign-in. When the session arrived as that cookie, the auth status read
   * gives the cookie the session's current end, so a session in use stays signed in.
   */
  private renewSessionCookie(req: Request, response: Response): Response {
    if (!response.ok || req.headers.get('authorization')?.trim()) return response;
    const token = extractOperatorAuthToken(req);
    const principal = token ? this.context.authenticateRequest(req)?.principal : undefined;
    if (!principal || principal.credentialKind !== 'user-session' || principal.expiresAt === undefined) return response;
    response.headers.append('Set-Cookie', buildOperatorSessionCookie(token, {
      req,
      expiresAt: principal.expiresAt,
      trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
    }));
    return response;
  }

  /** The request's authenticated principal, or null. */
  private principalOf(req: Request): RequestPrincipal | null {
    return this.context.authenticateRequest(req)?.principal ?? null;
  }

  /**
   * Who an event stream belongs to and whether its credential still holds,
   * so a revoked credential's streams close: by `closeClientsOf` at once, or
   * at the next frame after a single session ended.
   */
  private streamAuthority(req: Request): { readonly principalId?: string; readonly isAuthorized?: () => boolean } {
    const opened = this.context.authenticateRequest(req)?.principal;
    if (!opened) return {};
    return {
      principalId: opened.principalId,
      isAuthorized: () => this.context.authenticateRequest(req)?.principal.principalId === opened.principalId,
    };
  }

  /** The route that serves this request, for a caller that already established who is asking. */
  async dispatchApiRoutes(req: Request): Promise<Response | null> {
    return this.requests.dispatch(req);
  }

  /**
   * The route families served by their own dispatchers, tried before the
   * handler table. Their contexts are built here, once, with the table; a
   * request only reads the settings that switch a family on or move its path.
   */
  private ownRouteDispatcher(): DaemonRouteDispatcher {
    const context = this.context;
    const parseJsonBody = (request: Request) => this.parseJsonBody(request);
    const parseOptionalJsonBody = (request: Request) => this.parseOptionalJsonBody(request);
    const requireAdmin = (request: Request) => context.requireAdmin(request);
    const openAICompatible: Parameters<typeof dispatchOpenAICompatibleRoutes>[1] = {
      providerRegistry: context.providerRegistry,
      parseJsonBody,
      recordApiResponse: (request, path, routeResponse) => this.recordApiResponse(request, path, routeResponse),
      // Chat completions spend provider money; only listing models stays open.
      requireAdmin,
      // A non-streaming completion is batch-capable: batch.mode decides whether it is queued.
      ...(context.batchManager ? { batch: context.batchManager } : {}),
    };
    const batch: Parameters<typeof dispatchBatchRoutes>[1] | null = context.batchManager
      ? { batchManager: context.batchManager, parseJsonBody, parseOptionalJsonBody }
      : null;
    const cloudflare: Parameters<typeof dispatchCloudflareRoutes>[1] = {
      configManager: context.configManager,
      secretsManager: context.secretsManager,
      authToken: context.authToken,
      ...(context.cloudflareTunnel ? { tunnelConnector: context.cloudflareTunnel } : {}),
      parseJsonBody,
      parseOptionalJsonBody,
    };
    const mcp: Parameters<typeof dispatchMcpRoutes>[1] = {
      mcpRegistry: context.mcpRegistry,
      roots: context.mcpConfigRoots,
      parseJsonBody,
      parseOptionalJsonBody,
      requireAdmin,
    };
    const models: Parameters<typeof dispatchModelRoutes>[1] = {
      providerRegistry: context.providerRegistry,
      configManager: context.configManager,
      runtimeBus: context.runtimeBus,
      parseJsonBody,
    };
    const gateway = context.controlPlaneGateway;
    const chatManager = context.companionChatManager;
    const companionChat: Parameters<typeof dispatchCompanionChatRoutes>[1] | null = chatManager ? {
      chatManager,
      parseJsonBody,
      parseOptionalJsonBody,
      resolveDefaultProviderModel: context.resolveDefaultProviderModel,
      requireAdmin,
      requireScope: (request, scope) => this.requireCallerScope(request, scope),
      openSessionEventStream: (request: Request, sessionId: string) => {
        // Turn events are published to the registered client, so it must be this connection's own id.
        return openScopedSessionEventStream(gateway, request, {
          clientPrefix: 'companion-chat', sessionId,
          onClientId: (clientId) => chatManager.registerSubscriber(sessionId, clientId),
          ...this.streamAuthority(request),
        });
      },
    } : null;

    return async (req) => {
      const url = new URL(req.url);
      if (this.getConfigValue('controlPlane.openaiCompatible.enabled') !== false) {
        const pathPrefix = this.getConfigValue('controlPlane.openaiCompatible.pathPrefix');
        const response = await dispatchOpenAICompatibleRoutes(req, openAICompatible, typeof pathPrefix === 'string' && pathPrefix.trim() ? pathPrefix : '/v1');
        if (response) return response;
      }

      // Creating, ticking or cancelling a batch spends provider money: those
      // methods are admin-only in the catalog, which gateGatewayBinding enforced
      // before this point. Listing stays open to any authenticated caller.
      if (url.pathname.startsWith('/api/batch')) {
        if (!batch) {
          return Response.json({ error: 'Batch manager is not available', code: 'BATCH_MANAGER_UNAVAILABLE' }, { status: 503 });
        }
        const batchResponse = await dispatchBatchRoutes(req, batch);
        if (batchResponse) return batchResponse;
      }

      if (url.pathname.startsWith('/api/cloudflare')) {
        const adminError = context.requireAdmin(req);
        if (adminError) return adminError;
        const cloudflareResponse = await dispatchCloudflareRoutes(req, cloudflare);
        if (cloudflareResponse) return cloudflareResponse;
      }

      if (url.pathname.startsWith('/api/mcp')) {
        const mcpResponse = await dispatchMcpRoutes(req, mcp);
        if (mcpResponse) return mcpResponse;
      }

      if (url.pathname.startsWith('/api/homeassistant')) {
        const homeGraphResponse = await this.getHomeGraphRoutes().handle(req);
        if (homeGraphResponse) return homeGraphResponse;
        const homeAssistantResponse = await this.getHomeAssistantRoutes().handle(req);
        if (homeAssistantResponse) return homeAssistantResponse;
      }

      if (url.pathname.startsWith('/api/projects/planning')) {
        const projectPlanningResponse = await this.getProjectPlanningRoutes().handle(req);
        if (projectPlanningResponse) return projectPlanningResponse;
      }

      // Model catalog + model-switching routes. Provider runtime metadata is owned
      // by the operator contract under /api/providers.
      // Switching the model rewrites the daemon-wide setting: the catalog method
      // needs write:providers, which only an admin holds, and gateGatewayBinding
      // enforced it before this point.
      if (url.pathname === '/api/models' || url.pathname.startsWith('/api/models/')) {
        const providerResponse = await dispatchModelRoutes(req, models);
        if (providerResponse) return providerResponse;
      }

      // Companion chat routes, scoped to /api/companion/chat/..., session-isolated.
      // Handled before the handler table so they never touch the global control-plane feed.
      if (companionChat && isCompanionChatPath(url)) {
        const companionResponse = await dispatchCompanionChatRoutes(req, companionChat);
        if (companionResponse) return companionResponse;
      }

      return null;
    };
  }

  /**
   * What each route family reads, taken from the daemon's owners. Called once,
   * when the route table is built; every value a family is handed is either an
   * owner that lives as long as the router or a function that reaches the
   * current one when a request runs.
   */
  private routeFamilies(): DaemonRouteFamilies {
    const context = this.context;
    const statusProviders = () => this.statusProviders;
    return {
      control: {
        // The daemon hands these over after the router exists, so each is read when /status runs.
        get authToken() { return context.authToken(); },
        get buildVersion() { return statusProviders().buildVersion; },
        get peekReceipts() { return statusProviders().peekReceipts; },
        get acknowledgeReceipts() { return statusProviders().acknowledgeReceipts; },
        get collectClusterStatus() { return statusProviders().collectClusterStatus; },
        version: VERSION,
        // Read by every client on the probe it already makes: below this
        // build it stops taking shared-session work and asks to be restarted.
        clientCompatibilityFloor: CLIENT_COMPATIBILITY_FLOOR,
        clientCompatibilityFloorHeader: CLIENT_COMPATIBILITY_FLOOR_HEADER,
        sessionCookieName: OPERATOR_SESSION_COOKIE_NAME,
        controlPlaneGateway: this.context.controlPlaneGateway,
        extractAuthToken: this.context.extractAuthToken,
        resolveAuthenticatedPrincipal: (request) => this.principalOf(request),
        gatewayMethods: this.context.gatewayMethods,
        getOperatorContract: () => buildOperatorContract(this.context.gatewayMethods),
        invokeGatewayMethodCall: this.context.invokeGatewayMethodCall,
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: this.context.requireAdmin,
        requireAuthenticatedSession: this.context.requireAuthenticatedSession,
        login: (request) => this.handleLogin(request),
      },
      integration: {
        channelPlugins: this.context.channelPlugins,
        integrationHelpers: this.context.integrationHelpers,
        memoryEmbeddingRegistry: this.context.memoryEmbeddingRegistry,
        memoryRegistry: this.context.memoryRegistry,
        memoryConsolidation: this.context.memoryConsolidation ?? null,
        parseJsonBody: (request) => this.parseJsonBody(request),
        providerRuntime: {
          listSnapshots: () => {
            // The same TTL-respecting re-check GET /api/models runs, without waiting for it:
            // a list read is when a provider or local model server that appeared since is wanted.
            void this.context.providerRegistry.refreshLiveModelDiscovery().catch((error: unknown) => {
              logger.warn('[providers] live-discovery refresh on list failed', { error: summarizeError(error) });
            });
            return listProviderRuntimeSnapshots(this.context.providerRegistry);
          },
          getSnapshot: (providerId) => getProviderRuntimeSnapshot(this.context.providerRegistry, providerId),
          getUsageSnapshot: (providerId) => getProviderUsageSnapshot(this.context.providerRegistry, providerId),
        },
        requireAdmin: (request) => this.context.requireAdmin(request),
        resolveAuthenticatedPrincipal: (request) => this.principalOf(request),
        userAuth: this.context.userAuth,
      },
      telemetry: {
        telemetryApi: this.telemetryApi,
        resolveAuthenticatedPrincipal: (request) => this.principalOf(request),
        ingestSink: this.telemetryApi,
      },
      channel: {
        ...buildChannelRouteContext({
          channelPlugins: this.context.channelPlugins,
          channelPolicy: this.context.channelPolicy,
          parseJsonBody: (request) => this.parseJsonBody(request),
          parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
          requireAdmin: (request) => this.context.requireAdmin(request),
          surfaceRegistry: this.context.surfaceRegistry,
          // The call that was missing. `inboundMailHealth()` had no callers
          // repo-wide, so a watched mailbox reported its state to nothing.
          ...(this.context.inboundMailHealth === undefined
            ? {}
            : { inboundMailHealth: this.context.inboundMailHealth }),
        }),
      },
      system: {
        ...buildSystemRouteContext({
          settingsPrecondition: this.settingsPrecondition,
          settingsImportPrecondition: this.settingsImportPrecondition,
          approvalBroker: this.context.approvalBroker,
          configManager: this.context.configManager,
          credentialStatus: this.context.secretsManager
            ? createCredentialStatusProvider(this.context.secretsManager)
            : null,
          integrationHelpers: this.context.integrationHelpers,
          inspectInboundTls: (surface) => inspectInboundTls(this.context.configManager, surface),
          inspectOutboundTls: () => inspectOutboundTls(this.context.configManager),
          isValidConfigKey,
          isSecretBearingConfigKey,
          coerceConfigValue: (key, value) => coerceSchemaValue(key, CONFIG_SCHEMA.find((setting) => setting.key === key), value),
          parseJsonBody: (request) => this.parseJsonBody(request),
          parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
          platformServiceManager: this.context.platformServiceManager,
          recordApiResponse: (request, path, response, clientKind) => this.recordApiResponse(request, path, response, clientKind),
          requireAdmin: (request) => this.context.requireAdmin(request),
          requireAuthenticatedSession: (request) => this.context.requireAuthenticatedSession(request),
          resolveAuthenticatedPrincipal: (request) => this.principalOf(request),
          routeBindings: this.context.routeBindings,
          swapManager: this.context.swapManager,
          watcherRegistry: this.context.watcherRegistry,
        }),
      },
      runtime: {
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        recordApiResponse: (request, path, response) => this.recordApiResponse(request, path, response),
        requireAdmin: (request) => this.context.requireAdmin(request),
        sessionBroker: buildRouterSessionBrokerAdapter(this.context.sessionBroker),
        agentManager: { getStatus: (agentId) => this.context.agentManager.getStatus(agentId), cancel: (agentId) => this.context.agentManager.cancel(agentId) },
        // platform-owned empty-state copy, served while automation is enabled with zero routines (see feature-announcements).
        automationEmptyState: () => buildAutomationEmptyState({ enabled: this.getConfigValue('automation.enabled') === true, routineCount: this.context.automationManager.listJobs().length }),
        automationManager: {
          listJobs: () => this.context.automationManager.listJobs(),
          listRuns: () => this.context.automationManager.listRuns(),
          getRun: (runId) => this.context.automationManager.getRun(runId) ?? null,
          triggerHeartbeat: (input) => this.context.automationManager.triggerHeartbeat(input),
          listHeartbeatWakes: () => this.context.automationManager.listHeartbeatWakes(),
          cancelRun: (runId, reason) => this.context.automationManager.cancelRun(runId, reason),
          retryRun: (runId) => this.context.automationManager.retryRun(runId),
          createJob: (input: CreateAutomationJobInput) => this.context.automationManager.createJob(input),
          updateJob: (jobId, input: UpdateAutomationJobInput) => this.context.automationManager.updateJob(jobId, input),
          removeJob: async (jobId) => {
            await this.context.automationManager.removeJob(jobId);
          },
          setEnabled: (jobId, enabled) => this.context.automationManager.setEnabled(jobId, enabled),
          runNow: (jobId) => this.context.automationManager.runNow(jobId) as never,
          getSchedulerCapacity: () => this.context.automationManager.getSchedulerCapacity(),
        },
        normalizeAtSchedule,
        normalizeEverySchedule,
        normalizeCronSchedule,
        routeBindings: {
          start: () => this.context.routeBindings.start(),
          getBinding: (id) => this.context.routeBindings.getBinding(id),
        },
        trySpawnAgent: (input, logLabel, sessionId) => {
          const { tools, ...spawnInput } = input;
          return this.context.trySpawnAgent({
            ...spawnInput,
            ...(tools ? { tools: [...tools] } : {}),
          }, logLabel, sessionId);
        },
        queueSurfaceReplyFromBinding: (binding, input) => this.context.queueSurfaceReplyFromBinding(
          binding as Parameters<typeof this.context.queueSurfaceReplyFromBinding>[0],
          input,
        ),
        completeSurfaceReplyFromSurface: (input) => this.context.completeSurfaceReplyFromSurface(input),
        surfaceDeliveryEnabled: (surface) => this.context.surfaceDeliveryEnabled(surface),
        syncSpawnedAgentTask: (record, sessionId) => this.context.syncSpawnedAgentTask(
          record as Parameters<typeof this.context.syncSpawnedAgentTask>[0],
          sessionId,
        ),
        syncFinishedAgentTask: (record) => this.context.syncFinishedAgentTask(
          record as Parameters<typeof this.context.syncFinishedAgentTask>[0],
        ),
        configManager: this.context.configManager,
        runtimeStore: this.context.runtimeStore,
        runtimeDispatch: this.context.runtimeDispatch,
        publishConversationFollowup: (sessionId, envelope) => {
          // Scope the event to TUI-kind clients only: non-TUI clients (web, companion
          // app, etc.) must not receive raw operator conversation follow-ups. Using
          // clientKind:'tui' ensures only the TUI surface receives this event.
          this.context.controlPlaneGateway.publishEvent(
            'conversation.followup.companion',
            { sessionId, ...envelope },
            { clientKind: 'tui' },
          );
          // Also emit on the runtime bus so the in-process TUI surface can
          // subscribe and render the companion message in the conversation view.
          emitCompanionMessageReceived(
            this.context.runtimeBus,
            { sessionId, traceId: `companion:${envelope.messageId}`, source: 'companion-followup' },
            { sessionId, ...envelope },
          );
        },
        // `GET /api/sessions/:id/events`, see http/session-event-stream.ts.
        openSessionEventStream: (req, sessionId) => openScopedSessionEventStream(
          this.context.controlPlaneGateway,
          req,
          { clientPrefix: 'shared-session', sessionId, ...this.streamAuthority(req) },
        ),
      },
      remote: {
        resolveAuthenticatedPrincipal: (request) => this.principalOf(request),
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
        requireRemotePeer: (request, scope) => this.context.requireRemotePeer(request, scope),
        requireAuthenticatedSession: (request) => this.context.requireAuthenticatedSession(request),
        distributedRuntime: this.context.distributedRuntime,
        remoteBackends: this.context.remoteBackends,
      },
      knowledge: this.knowledgeRouteContext(this.context.knowledgeService, this.context.knowledgeGraphqlService),
      agentKnowledge: this.knowledgeRouteContext(
        this.context.agentKnowledgeService,
        new KnowledgeGraphqlService(this.context.agentKnowledgeService),
      ),
      media: {
        ...buildMediaRouteContext({
          artifactStore: this.context.artifactStore,
          configManager: this.context.configManager,
          mediaProviders: this.context.mediaProviders,
          multimodalService: this.context.multimodalService,
          parseJsonBody: (request) => this.parseJsonBody(request),
          requireAdmin: (request) => this.context.requireAdmin(request),
          voiceService: this.context.voiceService,
          webSearchService: this.context.webSearchService,
        }),
      },
      browserJudgment: {
        authenticate: (request) => this.principalOf(request),
        sameOrigins: () => {
          const configured = readControlPlaneBinding((key) => this.getConfigValue(key));
          const listener = this.context.listenerBinding?.();
          if (listener && (!Number.isSafeInteger(listener.port) || listener.port <= 0 || listener.port > 65535)) return [];
          const binding = listener ? { ...configured, hostMode: 'custom', host: listener.host, port: listener.port,
            tlsMode: listener.scheme === 'https' ? 'self-signed' : 'off' } : configured;
          return (['loopback', 'external'] as const).flatMap((audience) => {
            try { return [new URL(deriveControlPlaneBaseUrl(binding, audience)).origin]; }
            catch { return []; }
          });
        },
        cors: () => this.servingPosture().cors,
        service: this.context.browserJudgment,
      },
      ownDispatchers: [this.ownRouteDispatcher()],
      extensions: [
        clusterGroupRouteExtension(() => this.clusterGroupVerbs, {
          requireAdmin: (candidate) => this.context.requireAdmin(candidate),
          parseJsonBody: (candidate) => this.parseJsonBody(candidate),
        }),
      ],
    };
  }

  /** Knowledge route context for one surface, see router-knowledge-context.ts. */
  private knowledgeRouteContext(
    knowledgeService: Parameters<typeof buildRouterKnowledgeContext>[2],
    knowledgeGraphqlService: Parameters<typeof buildRouterKnowledgeContext>[3],
  ): ReturnType<typeof buildRouterKnowledgeContext> {
    return buildRouterKnowledgeContext(this.context, {
      parseJsonBody: (request) => this.parseJsonBody(request),
      parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
      parseJsonText: (raw) => this.parseJsonText(raw),
    }, knowledgeService, knowledgeGraphqlService);
  }

  private getHomeAssistantRoutes(): HomeAssistantConversationRoutes {
    if (!this.homeAssistantRoutes) {
      const chatManager = this.context.companionChatManager;
      if (!chatManager) {
        throw new Error('Home Assistant remote chat manager is unavailable.');
      }
      this.homeAssistantRoutes = new HomeAssistantConversationRoutes({
        configManager: this.context.configManager,
        routeBindings: this.context.routeBindings,
        chatManager,
        parseJsonBody: (request) => this.parseJsonBody(request),
        requireScope: (request, scope) => this.requireCallerScope(request, scope),
        requireAdmin: (request) => this.context.requireAdmin(request),
        resolveDefaultProviderModel: this.context.resolveDefaultProviderModel,
        homeGraph: this.context.homeGraphService,
      });
    }
    return this.homeAssistantRoutes;
  }

  private getHomeGraphRoutes(): HomeGraphRoutes {
    if (!this.homeGraphRoutes) {
      this.homeGraphRoutes = new HomeGraphRoutes({
        artifactStore: this.context.artifactStore,
        homeGraphService: this.context.homeGraphService,
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
        callerId: (request) => this.principalOf(request)?.principalId,
      });
    }
    return this.homeGraphRoutes;
  }

  private getProjectPlanningRoutes(): ProjectPlanningRoutes {
    if (!this.projectPlanningRoutes) {
      this.projectPlanningRoutes = new ProjectPlanningRoutes({
        projectPlanningService: this.context.projectPlanningService,
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        requireAdmin: (request) => this.context.requireAdmin(request),
      });
    }
    return this.projectPlanningRoutes;
  }

  async parseJsonBody(req: Request): Promise<JsonRecord | Response> {
    return parseDaemonJsonBody(req);
  }

  async parseOptionalJsonBody(req: Request): Promise<JsonRecord | null | Response> {
    return parseOptionalDaemonJsonBody(req);
  }

  parseJsonText(rawBody: string): JsonRecord | Response {
    return parseDaemonJsonText(rawBody);
  }

  recordApiResponse(
    req: Request,
    path: string,
    response: Response,
    clientKind:
      | 'web'
      | 'slack'
      | 'discord'
      | 'ntfy'
      | 'webhook'
      | 'homeassistant'
      | 'telegram'
      | 'google-chat'
      | 'signal'
      | 'whatsapp'
      | 'telephony'
      | 'imessage'
      | 'msteams'
      | 'bluebubbles'
      | 'mattermost'
      | 'matrix'
      | 'daemon' = 'web',
  ): Response {
    this.context.controlPlaneGateway.recordApiRequest({
      method: req.method,
      path,
      status: response.status,
      clientKind,
      ...(response.status >= 400 ? { error: `${req.method} ${path} -> ${response.status}` } : {}),
    });
    return response;
  }

  /** The address the listener resolved for this request; a request handed in without one is resolved from settings alone. */
  private clientIpOf(req: Request): string {
    return clientAddressOf(req) ?? resolveClientAddress(req, undefined, { trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')) });
  }

  private securityContext(req: Request, kind: string) {
    return { sessionId: 'system', traceId: `${kind}:${req.headers.get('x-request-id') ?? crypto.randomUUID()}`, source: 'control-plane-router' } as const;
  }

  private handleLogin(req: Request): Promise<Response> {
    return handleOperatorLogin(req, this.clientIpOf(req), {
      userAuth: this.context.userAuth,
      limiter: this.signInLimiter,
      runtimeBus: this.context.runtimeBus,
      source: 'control-plane-router',
      trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
    });
  }

  private async handleGitHubWebhook(req: Request): Promise<Response> {
    return handleGitHubAutomationWebhook(req, {
      serviceRegistry: this.context.serviceRegistry,
      githubWebhookSecret: this.context.githubWebhookSecret,
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
      // The integration posts the finished answer with its own token, so the
      // agent is not asked to post a comment it has no credential for.
      awaitAgent: async (agentId) => {
        await this.context.agentManager.join(agentId);
        return this.context.agentManager.getStatus(agentId);
      },
    });
  }

  async handleSlackWebhook(req: Request): Promise<Response> {
    return handleSlackSurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleDiscordWebhook(req: Request): Promise<Response> {
    return handleDiscordSurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleNtfyWebhook(req: Request): Promise<Response> {
    return handleNtfySurfaceWebhook(req, this.context.buildSurfaceAdapterContext());
  }

  async handleGenericWebhook(req: Request): Promise<Response> {
    return handleGenericWebhookSurface(req, this.context.buildGenericWebhookAdapterContext());
  }
}
