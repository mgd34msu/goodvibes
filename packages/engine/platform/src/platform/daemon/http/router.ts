import { DAEMON_CHALLENGE_HEADER, daemonIdentityHeaders, dialledPort } from '../identity-proof.js';
import { createServingSettingsPrecondition } from './settings-precondition.js';
import type { ConfigManager } from '../../config/manager.js';
import { deriveControlPlaneBaseUrl, readControlPlaneBinding } from '../../config/control-plane-base-url.js';
import { AddressRateLimiter, withRecordReach, type BrowserJudgmentCapability } from '@goodvibes/engine/daemon-api';
import type { ServiceRegistry } from '../../config/service-registry.js';
import { CONFIG_SCHEMA, isValidConfigKey } from '../../config/schema.js';
import { coerceSchemaValue } from '../../config/manager-bootstrap.js';
import { isSecretBearingConfigKey } from '../../config/secret-bearing-config-keys.js';
import { DECISION_MODEL_POLICY_HEADER, DecisionModelsDisabledError, decisionModelPolicyState } from '@goodvibes/engine/errors';
import { DecisionModelPolicyChangedError, withDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { logger } from '../../utils/logger.js';
import { requireStopped } from '../../utils/owned-work.js';
import { summarizeError } from '../../utils/error-display.js';
import { createCredentialStatusProvider } from '../../config/credential-status.js';
import { buildAutomationEmptyState } from '../../runtime/feature-announcements.js';
import type { UserAuthManager } from '../../security/user-auth.js';
import { OPERATOR_SESSION_COOKIE_NAME, buildIdentityMarkerCookie, buildOperatorSessionCookie, extractOperatorAuthToken, readIdentityMarker, type CredentialRefusal } from '../../security/http-auth.js';
import { webAppLink } from '../web-app-link.js';
import { callerKey, LOCAL_OWNER_PRINCIPAL } from '../../pairing/principal-ids.js';
import { isTheUser } from '../method-owner-decision.js';
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
import { inspectKnowledgeGraphqlAccess, KnowledgeGraphqlService, projectIdentityOfFolder } from '../../knowledge/index.js';
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
import { createAuthFailureAudit, type AuthFailureAudit } from '../auth-failure-audit.js';
import { emitCompanionPairRequested, emitCompanionPairVerified } from '../../runtime/emitters/security.js';
import { clientAddressOf, resolveClientAddress } from '../client-address.js';
import { handleOperatorLogin, handleOperatorLogout, SIGN_IN_ATTEMPTS_PER_MINUTE } from '../operator-login.js';
import { correlationCtx } from '../../runtime/correlation.js';
import { TelemetryApiService } from '../../runtime/telemetry/api.js';
import { inspectInboundTls, inspectOutboundTls } from '../../runtime/network/index.js';
import type { MemoryEmbeddingProviderRegistry, MemoryRegistry } from '../../state/index.js';
import { memoryProjectOf } from '../../state/memory-project.js';
import { clusterGroupRouteExtension, type ClusterGroupVerbs } from './cluster-group-routes.js';
import { buildRouterKnowledgeContext } from './router-knowledge-context.js';
import { handleGitHubAutomationWebhook, handleSlackSurfaceWebhook, handleDiscordSurfaceWebhook, handleNtfySurfaceWebhook, handleGenericWebhookSurface } from '../../adapters/index.js';
import type { GitHubReplyOperation } from '../../adapters/github/index.js';
import { daemonOperationLog } from '../operations-log.js';
import {
  handleRemotePairRequest,
  handleRemotePairVerify,
  handleRemotePeerHeartbeat,
  handleRemotePeerWorkPull,
  handleRemotePeerWorkComplete,
  matchPeerRoute,
} from './remote-routes.js';
import { buildRouterSessionBrokerAdapter } from './router-session-broker-adapter.js';
import { authenticationRequired, DaemonRequestRouter, isMarkedForAdmission, type DaemonRouteDispatcher } from './request-router.js';
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
import { buildErrorResponseBody, jsonErrorResponse, serviceFailureStatus } from './error-response.js';
import { CALLER_RULES_ABSENT, callerPathRefusal } from '../../control-plane/caller-paths.js';
import { callerReachRefusal, reachableAnswer, reachFilterOf } from '../../control-plane/caller-reach.js';
import { SHARED_KIND_NOT_GIVEN } from '../../control-plane/shared-kinds.js';
import { callReachesKnowledge } from '../../knowledge/knowledge-reach.js';
import { hasArtifactMaker, withArtifactMaker, type ArtifactTurnMaker } from '../../artifacts/turn-maker.js';
import { daemonSharedKindRule, sharedKindAdmission } from '../shared-kind-gifts.js';
import type { EventReachContext } from '../../control-plane/event-reach.js';
import { methodListsOf } from '../../control-plane/record-addresses.js';
import { RECORD_NOT_YOURS } from '../../control-plane/method-catalog.js';
import { missingScopeRefusal } from '@goodvibes/engine/daemon-api/error-response';
import { VERSION } from '../../version.js';
import type { CompanionChatManager } from '../../companion/companion-chat-manager.js';
import { principalHasScope, type RequestContext, type RequestPrincipal } from '../http-policy.js';
import { memoryAuthorOfRequest, requestMayNameSession } from './memory-route-author.js';
import { makesOwnerOnlyActOf, ownerHimselfOf, ownerTypedAtProgram } from './owner-typed.js';
import { projectNamerOf, type CallerProjectVerdict, type ProjectNamer } from '../../workspace/caller-project.js';
import { admitEffects } from '../../security/effect-authority.js';
import { dispatchCompanionChatRoutes, isCompanionChatPath } from '../../companion/companion-chat-routes.js';
import { dispatchModelRoutes } from './model-routes.js';
import { dispatchBatchRoutes } from './batch-routes.js';
import { gateGatewayBinding } from './gateway-binding-gate.js';
import { riskOfDescriptor } from '../../control-plane/method-risk.js';
import { daemonProgramRegistrations } from '../program-registrations.js';
import { expectProgramNonce, PROGRAM_NONCE_PATH, startProgramSocket, type ProgramSocket } from '../program-socket.js';
import { bindLocalOrigin, isInProcessRequest, isLocalOrigin } from '../client-address.js';
import { bindDaemonHosted, bindProgramProcess, bindProgramRegistration, CALL_PROGRAM_KEY_HEADER, readDaemonHosted, readProgramRegistration } from '@goodvibes/engine/daemon-api/control-routes';
import { resolveGoodVibesDaemonHome } from '../../config/goodvibes-home.js';
import { homedir } from 'node:os';
import { assertDaemonRouteManifest, catalogPathname, declaredRouteTarget, type DaemonRouteTarget } from './route-manifest.js';
import { IdempotentReplayStore, replayKeyedRequest, takesIdempotencyKey } from '../../control-plane/idempotent-replay.js';
import { deriveRequestWithBody } from '../derived-request.js';
import { ownBrowserOrigins, refuseCookieWriteFromOtherOrigin } from './browser-origin.js';
import { handleBrowserNodeSession, handleBrowserSession } from './browser-session.js';
import { isSurfaceIngressEnabled } from '../surface-policy.js';
import { dispatchCloudflareRoutes } from './cloudflare-routes.js';
import { CloudflareControlPlaneManager } from '../../cloudflare/manager.js';
import { dispatchMcpRoutes } from './mcp-routes.js';
import { HomeAssistantConversationRoutes } from './homeassistant-routes.js';
import { HomeGraphRoutes } from './home-graph-routes.js';
import { startsWork } from '../work-admission.js';
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
  /** Answers repeats of a write that takes the shared Idempotency-Key; absent, such a key is not honoured. */
  readonly idempotentReplay?: IdempotentReplayStore | undefined;
  /** Native listener facts, never request Host/Forwarded headers or a stored URL. */
  readonly listenerBinding?: () => { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' };
  /** The control-plane listener as bound right now, or null while none is bound; what the health snapshot reports. */
  readonly servingListener?: (() => { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' } | null) | undefined;
  readonly serviceRegistry: ServiceRegistry;
  readonly userAuth: UserAuthManager;
  readonly agentManager: AgentManager;
  readonly automationManager: AutomationManager;
  readonly approvalBroker: ApprovalBroker;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly providerRegistry: ProviderRegistry;
  readonly sessionBroker: SharedSessionBroker;
  /** A hosted session's owners (creator and whoever it was shared with); absent, a hosted session is shown to the owner and admins only. */
  readonly sessionOwners?: ((sessionId: string) => readonly string[]) | undefined;
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
  readonly memoryConsolidation?: { listReceipts(): readonly unknown[]; listProposals?(): readonly unknown[] } | null | undefined;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly platformServiceManager: PlatformServiceManager;
  readonly integrationHelpers: IntegrationHelperService | null;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore | null;
  readonly runtimeDispatch: DomainDispatch | null;
  readonly batchManager?: DaemonBatchManager | null | undefined;
  /** The daemon's Cloudflare Tunnel connector: provisioning starts it, status reports it, shutdown stops it. */
  readonly cloudflareTunnel?: CloudflareTunnelConnector | null | undefined;
  /** Closed while the daemon restarts into an update: a request that would start or change work is refused (503). */
  readonly workAdmission?: import('../work-admission.js').DaemonWorkAdmission | undefined;
  /** Borrowed from the runtime graph; the graph owns admission shutdown and awaited drain. */
  readonly browserJudgment?: BrowserJudgmentCapability | undefined;
  readonly githubWebhookSecret: string | null;
  readonly authToken: () => string | null;
  readonly settingsAuthority?: import('./settings-precondition.js').ServingSettingsAuthority | undefined;
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
    readonly idempotencyKey?: string | undefined;
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
  }) => Promise<{ status: number; ok: boolean; body: unknown; replayed?: boolean }>;
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
   * Optional companion chat manager. When present, companion chat routes
   * (/api/companion/chat/...) are enabled. Injected by the daemon facade
   * when the companion feature is active.
   */
  readonly companionChatManager?: CompanionChatManager | null | undefined;
  /** The one check of a caller's project (workspace/caller-project.ts); absent: a chat's project is taken as given. */
  readonly callerProject?: ((raw: string, who: ProjectNamer) => CallerProjectVerdict) | undefined;
  /** Resolve the current provider/model for companion-chat session creation. */
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /** Resolves provider API keys from the configured secret store. */
  readonly secretsManager?: Pick<import('../../config/secrets.js').SecretsManager, 'get' | 'set' | 'getGlobalHome' | 'list' | 'listDetailed'> & Partial<import('./settings-precondition.js').ServingSettingsSecrets> | null | undefined;
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
  /** A knowledge call's maker (its caller, the project it named, checked), from its admission to its route. */
  private readonly knowledgeMakers = new WeakMap<Request, ArtifactTurnMaker>();

  constructor(private readonly context: DaemonHttpRouterContext) {
    // Every uncataloged route is declared with its effect or its reason; a manifest that is not sound stops the router here.
    assertDaemonRouteManifest(context.gatewayMethods);
    this.requests = new DaemonRequestRouter({
      authenticate: (req) => context.authenticateRequest(req),
      // Built by the first request that reaches the table, then kept for the
      // router's life: the daemon hands over some owners after construction,
      // and every family reads them when a request runs, not when it is built.
      routes: () => buildDaemonRouteTable(this.routeFamilies()),
      preAuth: (req) => this.dispatchPreAuthRoutes(req),
      refuseUnauthenticated: (req) => this.refuseUnauthenticated(req),
      // A write made with the sign-in cookie is checked for the page's origin as the socket is, then for access.
      // Then every folder a turn or process will work in that the call names: a project this caller may name.
      admit: (req) => this.bindCheckedRegistration(req) ?? refuseCookieWriteFromOtherOrigin(req, () => ownBrowserOrigins(context.configManager, context.listenerBinding)) ?? gateGatewayBinding(req, context)
        ?? this.refuseUncheckedFolders(req).then((refused) => refused ?? this.refuseUnreachableRecords(req))
          .then((refused) => refused ?? this.refuseKnowledgeProject(req)),
      // The answer of a list or a search its method declares: what this caller may reach of it (caller-reach.ts).
      answer: (req, response) => this.reachableResponse(req, response),
      // A paged list a route serves keeps only what this caller may reach before it cuts its page (caller-reach.ts).
      // A knowledge call adds as its caller, in the project it named (checked at admission): knowledge-reach.ts.
      withinReach: (req, serve) => withRecordReach(this.reachFilterOfRequest(req), () => {
        const maker = this.knowledgeMakers.get(req);
        return maker !== undefined && !hasArtifactMaker() ? withArtifactMaker(maker, serve) : serve();
      }),
      // A method of a risk class the owner decides, served by a route module: sent through the dispatch, which decides it
      // once for every door (daemon/method-owner-decision.ts) and serves the route on a yes.
      decide: (req) => this.decideRiskyRoute(req),
      keyedReplay: (req, serve) => {
        // Only a write whose method takes the shared key, and only when a key was sent.
        const store = context.idempotentReplay;
        const raw = req.headers.get('idempotency-key');
        if (!store || raw === null) return null;
        const descriptor = context.gatewayMethods.findByHttpBinding(req.method, catalogPathname(new URL(req.url).pathname));
        if (!takesIdempotencyKey(descriptor)) return null;
        const principalId = context.authenticateRequest(req)?.principal.principalId;
        if (!descriptor || principalId === undefined) return null;
        const key = IdempotentReplayStore.readKey(raw);
        if (key === undefined) return null;
        if (typeof key !== 'string') return Promise.resolve(Response.json(key.body, { status: key.status }));
        return replayKeyedRequest(store, {
          principalId, methodId: descriptor.id, key, req,
          uploadMaxBytes: context.artifactStore.getMaxBytes(),
          withBody: deriveRequestWithBody,
        }, serve);
      },
    });
    this.authFailures = createAuthFailureAudit(context.runtimeBus);
    const settingsConfigOwner = context.configManager;
    const settingsAuthorityOwner = context.settingsAuthority;
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
    // The one door a terminal program registers through (daemon/program-socket.ts): the kernel names who connected.
    const daemonHome = resolveGoodVibesDaemonHome(homedir());
    this.programSocket = startProgramSocket(daemonHome, daemonProgramRegistrations(), {
      authenticate: (token) => {
        // The token as it arrived over the socket, from this machine's own account: the operator token is `local` here.
        const request = new Request('http://127.0.0.1/api/control-plane/programs', { headers: { authorization: `Bearer ${token}` } });
        bindLocalOrigin(request);
        const principal = context.authenticateRequest(request)?.principal;
        return principal ? { principalId: principal.principalId, credentialKind: principal.credentialKind } : undefined;
      },
      port: () => this.listeningPort(),
    });
  }

  /** The program socket this router opened (stopped with it). */
  private readonly programSocket: ProgramSocket | undefined;

  /** Resolves once the tunnel connector's child exited; rejects naming it when its exit could not be seen. */
  async dispose(): Promise<void> {
    this.programSocket?.stop();
    this.telemetryApi?.dispose();
    this.context.batchManager?.dispose();
    const tunnel = await this.context.cloudflareTunnel?.dispose();
    if (tunnel) requireStopped('The Cloudflare tunnel connector', tunnel);
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
        // Reads still answer while admission is closed; anything that could start or change work waits for the restart.
        // A channel's inbound message and a GitHub event are the exception: they are taken and saved (the broker's held
        // input, the operation log's owed start) and started after the restart (a refused provider may not deliver again).
        const closed = asset === null ? this.context.workAdmission?.refusalResponse() ?? null : null;
        const refused = closed !== null && startsWork(req.method) && !this.holdsInboundDelivery(new URL(req.url).pathname, req.method) ? closed : null;
        // An error leaves as the route wrote it: its code is the fact a client reads, so nothing is attached for a model to read.
        const response = asset ?? (refused ?? await this.requests.route(req).catch((error: unknown) => this.routeFailureResponse(req, error)));
        if (response.status === 101) return response;
        // A success answers with the status its method declares (201 created, 202 accepted):
        // one declaration, read here and by the generated specs.
        const declared = response.ok && !asset
          ? this.context.gatewayMethods.findByHttpBinding(req.method, new URL(req.url).pathname)?.http?.successStatus
          : undefined;
        const observed = declared !== undefined && declared !== response.status
          ? new Response(response.body, { status: declared, headers: response.headers })
          : new Response(response.body, response);
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

  /**
   * The answer to a route that threw, the same for an HTTP request and a
   * WebSocket call: a bare rejection reaches the caller as a dropped connection
   * or an unanswered call with nothing to act on. A changed decision-model
   * policy is rethrown for the request scope that owns it.
   */
  private routeFailureResponse(req: Request, error: unknown): Response {
    if (error instanceof DecisionModelPolicyChangedError) throw error;
    // Decision models are off (no decision model) and this feature needs one: the owner's setting, not a daemon fault.
    if (error instanceof DecisionModelsDisabledError) {
      return jsonErrorResponse({
        error: error.message,
        code: 'DECISION_MODELS_DISABLED',
        category: 'bad_request',
        state: 'no decision model is in use (none is chosen, or decision models are turned off)',
        next: ['Choose a Decision model in settings to use this; or use the alternative the message names'],
      }, { status: 409 });
    }
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
    // A program of this machine names a secret of its own here, just before it connects to the program socket, so the
    // daemon can prove over the socket that it is the daemon behind this listener (program-socket.ts `expected`). From
    // this machine only (as the listener established it), with the operator token of this machine (the token the
    // program sends over the socket next), and never from a browser page: any page in a browser on this machine can post
    // to a loopback address (a plain POST needs no preflight, and the listener reads it as local), and its request
    // carries an Origin header. Anyone else could otherwise fill the table and keep the owner's programs from registering.
    if (url.pathname === PROGRAM_NONCE_PATH && req.method === 'POST') {
      if (!isLocalOrigin(req) || req.headers.has('origin') || this.principalOf(req)?.credentialKind !== 'local') {
        return jsonErrorResponse({ error: 'Only a program on the daemon\'s own machine, holding its operator token, names its secret here.', code: 'FORBIDDEN' }, { status: 403 });
      }
      let nonce: unknown;
      try { nonce = ((await req.json()) as { nonce?: unknown } | null)?.nonce; } catch { nonce = undefined; }
      return expectProgramNonce(nonce) ? new Response(null, { status: 204 }) : jsonErrorResponse({ error: 'nonce must be 64 hex characters', code: 'INVALID_ARGUMENT' }, { status: 400 });
    }
    // A session may end itself even when it no longer passes the gate's other checks.
    if (url.pathname === '/logout' && req.method === 'POST') {
      return handleOperatorLogout(req, {
        userAuth: this.context.userAuth,
        source: 'control-plane-router',
        trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
        allowedBrowserOrigins: () => ownBrowserOrigins(this.context.configManager, this.context.listenerBinding),
      });
    }
    // The web UI's direct-route sign-in: the credential goes into an HttpOnly cookie, never back to the page.
    if (url.pathname === '/api/browser-session' && req.method === 'POST') {
      return handleBrowserSession(req, {
        authenticate: (request) => this.context.authenticateRequest(request),
        passwordSignIn: (signIn, original) => handleOperatorLogin(signIn, this.clientIpOf(original), {
          userAuth: this.context.userAuth,
          limiter: this.signInLimiter,
          runtimeBus: this.context.runtimeBus,
          source: 'control-plane-router',
          trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
        }),
        describeCredentialRefusal: this.context.describeCredentialRefusal,
        recordRefused: (request) => this.authFailures.record(this.clientIpOf(request), 'control-plane-router'),
        allowedBrowserOrigins: () => ownBrowserOrigins(this.context.configManager, this.context.listenerBinding),
        trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')),
      });
    }

    // The web UI's phone node: its peer token goes into an HttpOnly cookie of its own, scoped to the peer routes.
    if ((url.pathname === '/api/browser-session/node' || url.pathname === '/api/browser-session/node/end') && req.method === 'POST') {
      return handleBrowserNodeSession(req, {
        requireRemotePeer: (request) => this.context.requireRemotePeer(request),
        allowedBrowserOrigins: () => ownBrowserOrigins(this.context.configManager, this.context.listenerBinding),
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
        // Kept with the request: Waiting to pair says where it was asked from.
        remoteAddress: this.clientIpOf(req),
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
    const cookie = { req, expiresAt: principal.expiresAt, trustProxy: Boolean(this.context.configManager.get('controlPlane.trustProxy')) };
    response.headers.append('Set-Cookie', buildOperatorSessionCookie(token, cookie));
    // The identity marker keeps its generation and moves its end with the credential's.
    const marker = readIdentityMarker(req);
    if (marker) response.headers.append('Set-Cookie', buildIdentityMarkerCookie(marker, cookie));
    return response;
  }

  /** The request's authenticated principal, or null. */
  private principalOf(req: Request): RequestPrincipal | null {
    return this.context.authenticateRequest(req)?.principal ?? null;
  }

  /** Who names the project a request names (workspace/caller-project.ts `projectNamerOf`, on the one owner definition). */
  private projectNamerOfRequest(req: Request): ProjectNamer {
    const principal = this.principalOf(req);
    if (!principal) return { ownersProgram: false };
    return projectNamerOf({ credentialKind: principal.credentialKind, actor: principal.actor, registration: readProgramRegistration(req), principalId: principal.principalId,
      ...(readDaemonHosted(req) ? { daemonHosted: true } : {}) });
  }

  /** What the daemon bound about a request's program (its checked registration, and whether it serves it to itself). */
  private checkedCallOf(req: Request): { readonly registration?: string; readonly daemonHosted?: true } | undefined {
    const registration = readProgramRegistration(req);
    const daemonHosted = readDaemonHosted(req);
    if (!registration && !daemonHosted) return undefined;
    return { ...(registration ? { registration } : {}), ...(daemonHosted ? { daemonHosted: true as const } : {}) };
  }

  /**
   * A REST call to a method that declares folders a turn or process works in, or files on this disk (`workFolders`,
   * `daemonFiles`): the same one check the method catalog applies before a handler (control-plane/caller-paths.ts), for
   * the credential that made the call, before the route reads the body. The refusal, or null.
   */
  private async refuseUncheckedFolders(req: Request): Promise<Response | null> {
    // No rules to read is never no check: only the owner in person names a folder then (caller-paths.ts).
    const rules = this.context.gatewayMethods.pathRules?.() ?? CALLER_RULES_ABSENT;
    const url = new URL(req.url);
    // Every route: a method's binding, an alias of one, or an effect row with its declared folders (route-manifest.ts).
    const target = declaredRouteTarget(this.context.gatewayMethods, req.method, catalogPathname(url.pathname));
    if (!target) return null;
    const descriptor = target.descriptor;
    if ((descriptor.workFolders ?? []).length === 0 && (descriptor.daemonFiles ?? []).length === 0) return null;
    const principal = this.principalOf(req);
    const query = { ...Object.fromEntries(url.searchParams.entries()), ...target.params };
    let body: unknown;
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      // A body that is not JSON (an upload of the caller's own file) is the route's own to read.
      try { body = await req.clone().json(); } catch { body = undefined; }
    }
    let project: string | undefined;
    try { project = req.headers.get('x-goodvibes-project') ? decodeURIComponent(req.headers.get('x-goodvibes-project')!) : undefined; } catch { project = undefined; }
    const checkedCall = this.checkedCallOf(req);
    const refusal = callerPathRefusal(descriptor, body, query, {
      ...(principal?.credentialKind ? { credentialKind: principal.credentialKind } : {}), ...(principal ? { principalId: principal.principalId } : {}),
      ...(principal?.actor ? { actor: principal.actor } : {}),
      ...(project || checkedCall ? { call: { ...checkedCall, ...(project ? { project } : {}) } } : {}),
    }, rules);
    return refusal === undefined ? null
      : Response.json(buildErrorResponseBody({ message: `Not done: ${refusal}. Nothing was read or changed.`, code: 'PROJECT_NOT_ALLOWED', status: 403 }), { status: 403 });
  }

  /** The caller a REST request reaches records as (control-plane/caller-reach.ts), and its method. */
  private reachOfRequest(req: Request): { readonly descriptor: DaemonRouteTarget['descriptor']; readonly context: Parameters<typeof callerReachRefusal>[3]; readonly params: Record<string, string> } | null {
    const url = new URL(req.url);
    const pathname = catalogPathname(url.pathname);
    // Every route: a method's binding, an alias of one (its method, the values the request path gives that method's
    // path), or an effect row (its declared addresses, kept under its id; route-manifest.ts). None: a route declared
    // public, its own credential's, or retired.
    const target = declaredRouteTarget(this.context.gatewayMethods, req.method, pathname);
    if (!target) return null;
    const principal = this.principalOf(req);
    let project: string | undefined;
    try { project = req.headers.get('x-goodvibes-project') ? decodeURIComponent(req.headers.get('x-goodvibes-project')!) : undefined; } catch { project = undefined; }
    // The route's own path values: what it names by id in its path.
    const params: Record<string, string> = { ...Object.fromEntries(url.searchParams.entries()), ...target.params };
    const descriptor = target.descriptor;
    return { descriptor, params, context: {
      ...(principal?.credentialKind ? { credentialKind: principal.credentialKind } : {}), ...(principal ? { principalId: principal.principalId } : {}),
      ...(principal?.actor ? { actor: principal.actor } : {}),
      ...(project || this.checkedCallOf(req) ? { call: { ...this.checkedCallOf(req), ...(project ? { project } : {}) } } : {}),
    } };
  }

  /**
   * The request's caller's reach, as the filter a paged list applies before it cuts its page (caller-reach.ts
   * `reachFilterOf`); null for the owner at large. Read for every request, whatever its route: who asks is the same.
   */
  private reachFilterOfRequest(req: Request): ((kind: string, id: string) => boolean) | null {
    const rules = this.context.gatewayMethods.reachRules?.();
    const principal = this.principalOf(req);
    // Nobody this daemon authenticated, or no rules to tell records apart: unknown is someone else, given no record.
    if (!principal) return () => false;
    if (!rules) return reachFilterOf({ credentialKind: principal.credentialKind, principalId: principal.principalId, actor: principal.actor }, undefined);
    const checkedCall = this.checkedCallOf(req);
    return reachFilterOf({
      credentialKind: principal.credentialKind, principalId: principal.principalId, actor: principal.actor,
      ...(checkedCall ? { call: checkedCall } : {}),
    }, rules);
  }

  /**
   * A REST call naming by id a record its caller may not reach (control-plane/caller-reach.ts): refused before the route
   * reads it, in the words that never say whether it exists. Null: it may reach every one it names.
   */
  private async refuseUnreachableRecords(req: Request): Promise<Response | null> {
    // No rules to read is never no check: only the owner in person reaches a record by id then (caller-reach.ts).
    const rules = this.context.gatewayMethods.reachRules?.() ?? CALLER_RULES_ABSENT;
    const reach = this.reachOfRequest(req);
    if (!reach) return null;
    let body: unknown;
    if (req.method !== 'GET' && req.method !== 'DELETE') {
      try { body = await req.clone().json(); } catch { body = undefined; }
    }
    const refusal = await callerReachRefusal(reach.descriptor.id, body, reach.params, reach.context, rules);
    if (refusal !== undefined) {
      return Response.json(buildErrorResponseBody({ message: `Not done: ${refusal}. Nothing was read or changed.`, code: RECORD_NOT_YOURS, status: 403 }), { status: 403 });
    }
    // The owner's shared things by their REST routes too (control-plane/shared-kinds.ts): the same rule the dispatch
    // reads. A public or peer route is admitted by its own proof.
    if (reach.descriptor.access === 'public' || reach.descriptor.access === 'remote-peer') return null;
    const shared = await sharedKindAdmission(daemonSharedKindRule(), reach.descriptor.id, body ?? reach.params, reach.context, req.signal);
    if (shared.ok) return null;
    return Response.json(buildErrorResponseBody({ message: `Not done: ${shared.reason}. Nothing was read or changed.`, code: SHARED_KIND_NOT_GIVEN, status: 403 }), { status: 403 });
  }

  /**
   * A knowledge call over REST (the family of the owner's shared kind `knowledge`, control-plane/shared-kinds.ts): the
   * project it names (`x-goodvibes-project`, else `workingDirectory` in its body or query), held by the one project
   * check for its caller, and the caller, kept as what it adds is recorded (knowledge/knowledge-reach.ts: that project's
   * knowledge; naming none, the owner's shared knowledge, which only the owner and those the owner gave it add to). The refusal of a
   * project it may not name, or null.
   */
  private async refuseKnowledgeProject(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const target = declaredRouteTarget(this.context.gatewayMethods, req.method, catalogPathname(url.pathname));
    if (!target || !callReachesKnowledge(target.descriptor.id)) return null;
    const principal = this.principalOf(req);
    let raw: string | undefined;
    try { raw = req.headers.get('x-goodvibes-project') ? decodeURIComponent(req.headers.get('x-goodvibes-project')!) : undefined; } catch { raw = undefined; }
    if (!raw && req.method !== 'GET' && req.method !== 'DELETE') {
      try {
        const body = await req.clone().json() as unknown;
        const named = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>)['workingDirectory'] : undefined;
        if (typeof named === 'string') raw = named;
      } catch { /* not JSON: the route reads it */ }
    }
    raw = (raw ?? url.searchParams.get('workingDirectory') ?? '').trim() || undefined;
    let project: string | undefined;
    if (raw) {
      const verdict = (this.context.gatewayMethods.pathRules?.() ?? CALLER_RULES_ABSENT).project(raw, this.projectNamerOfRequest(req));
      if (!verdict.ok) {
        return Response.json(buildErrorResponseBody({ message: `Not done: ${verdict.reason}. Nothing was read or changed.`, code: 'PROJECT_NOT_ALLOWED', status: 403 }), { status: 403 });
      }
      project = verdict.project;
    }
    if (principal || project) this.knowledgeMakers.set(req, { ...(principal ? { createdBy: principal.principalId } : {}), ...(project ? { project } : {}) });
    return null;
  }

  /** A REST answer of a list or a search its method declares, as the caller may read it; null: as served. */
  private async reachableResponse(req: Request, response: Response): Promise<Response | null> {
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('application/json')) return null;
    const rules = this.context.gatewayMethods.reachRules?.() ?? CALLER_RULES_ABSENT;
    const reach = this.reachOfRequest(req);
    if (!reach || methodListsOf(reach.descriptor.id).length === 0) return null;
    let answer: unknown;
    try { answer = await response.clone().json(); } catch { return null; }
    const filtered = await reachableAnswer(reach.descriptor.id, answer, reach.context, rules);
    if (filtered === answer) return null;
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(JSON.stringify(filtered), { status: response.status, headers });
  }

  /**
   * Whether the request's caller may read a shared session: any session but a
   * hosted one, and a hosted one only as its owners and admins
   * (session.transcript.read on its owners, as sessions.hosted.list decides).
   */
  private mayReadSession(req: Request, session: { readonly id: string; readonly kind?: unknown }): boolean {
    if (session.kind !== 'hosted') return true;
    const actor = this.principalOf(req)?.actor;
    if (actor === undefined) return false;
    return admitEffects(actor, ['session.transcript.read'], { owners: this.context.sessionOwners?.(session.id) ?? [] }).kind === 'allowed';
  }

  /**
   * Who an event stream belongs to and whether its credential still holds,
   * so a revoked credential's streams close: by `closeClientsOf` at once, or
   * at the next frame after a single session ended.
   */
  private streamAuthority(req: Request): { readonly principalId?: string; readonly isAuthorized?: () => boolean; readonly reachContext?: EventReachContext } {
    const opened = this.context.authenticateRequest(req)?.principal;
    if (!opened) return {};
    // Who follows: only the events about records this caller may reach (control-plane/event-reach.ts).
    const reachContext = this.reachOfRequest(req)?.context ?? {
      credentialKind: opened.credentialKind, principalId: opened.principalId, actor: opened.actor,
      ...(this.checkedCallOf(req) ? { call: this.checkedCallOf(req)! } : {}),
    };
    // A stream's grant is fixed when it opens: a credential whose rights narrowed
    // since then closes it (the client reopens it under the narrower grant), so a
    // frame the narrower grant does not cover is never written.
    const covered = (now: RequestPrincipal): boolean => (now.admin || !opened.admin)
      && (now.scopeSet.has('*') || opened.scopes.every((scope) => now.scopeSet.has(scope)));
    return {
      principalId: opened.principalId,
      reachContext,
      isAuthorized: () => {
        const now = this.context.authenticateRequest(req)?.principal;
        return now !== undefined && now.principalId === opened.principalId && (now === opened || covered(now));
      },
    };
  }

  /**
   * The registration a terminal program sent (`x-goodvibes-program-key`), checked once for this request against its own
   * principal and credential kind (daemon/program-registrations.ts) and bound to it in process; a key that is not this
   * caller's names nothing. Always null: it never refuses a request by itself.
   */
  private bindCheckedRegistration(req: Request): null {
    // A request the daemon serves to itself in process (a turn it hosts): bound as such, never from a header.
    if (isInProcessRequest(req)) bindDaemonHosted(req);
    const sent = req.headers.get(CALL_PROGRAM_KEY_HEADER)?.trim();
    if (!sent) return null;
    const principal = this.principalOf(req);
    // The Agent's credential (the owner's model, kind `agent`; the terminal app's and the Agent's model tools both use
    // it) is no credential a registration is issued to: the program sends the registration the daemon issued it for the
    // operator token it registered with, and only that names it (method-owner-decision.ts `ownersAgentProgram`).
    // Without it, that credential is a script.
    const program = principal?.credentialKind === 'agent'
      ? daemonProgramRegistrations().verify(sent, LOCAL_OWNER_PRINCIPAL, 'local')
      : daemonProgramRegistrations().verify(sent, principal?.principalId, principal?.credentialKind);
    bindProgramRegistration(req, program);
    // The registered process too, so a question it raises is held while that process runs (approvals-raise.ts).
    if (program !== undefined) bindProgramProcess(req, daemonProgramRegistrations().processOf(sent));
    return null;
  }

  /**
   * A REST request for a method a route module serves (no handler: the dispatch's invoke arm never sees it) whose risk
   * class is not `none`: sent through the dispatch as that method's call (the same `invokeGatewayRestVerb` a handler's
   * route takes, its path parameters folded in), so it is decided there as every other door is. The dispatch serves the
   * route itself when the call may run (a request it makes in process, which never comes back here). Every such call
   * goes this way whatever its body: one that is not a method's JSON input is refused there (400), never served around
   * the decision. Null: served as it is (a method of no risk, or one a handler serves, which the dispatch reaches).
   */
  private decideRiskyRoute(req: Request): Promise<Response | null> | null {
    const pathname = catalogPathname(new URL(req.url).pathname);
    // A method's binding or an alias of one (an effect row declares how it is decided: route-manifest.ts `decided`).
    const descriptor = declaredRouteTarget(this.context.gatewayMethods, req.method, pathname)?.method;
    if (!descriptor?.http || this.context.gatewayMethods.hasHandler(descriptor.id)) return null;
    if (riskOfDescriptor(descriptor) === 'none') return null;
    const refuse = (error: string, status: number): Promise<Response> => Promise.resolve(Response.json({ error, code: status === 400 ? 'INVALID_ARGUMENT' : 'NOT_INVOKABLE', status }, { status }));
    const invoke = this.requests.routeTable().handlers.invokeGatewayRestVerb;
    if (typeof invoke !== 'function') return refuse(`${descriptor.id} is decided by the owner's rule, and this daemon cannot send it through its dispatch. Nothing was changed.`, 501);
    const template = (descriptor.http.path.replace(/\/+$/, '') || '/').split('/');
    const parts = (pathname.replace(/\/+$/, '') || '/').split('/');
    if (template.length !== parts.length) return refuse(`${pathname} does not fit ${descriptor.http.path}.`, 400);
    const params: Record<string, string> = {};
    for (let index = 0; index < template.length; index += 1) {
      const want = template[index]!;
      if (!want.startsWith('{') || !want.endsWith('}')) continue;
      try { params[want.slice(1, -1)] = decodeURIComponent(parts[index]!); } catch { return refuse(`${want} in ${pathname} is not a readable path value.`, 400); }
    }
    return Promise.resolve(invoke({ methodId: descriptor.id, req, params }));
  }

  /** The route that serves this request, for a caller that already established who is asking. */
  async dispatchApiRoutes(req: Request): Promise<Response | null> {
    // A request built for a caller that has not passed the checks (a socket's method-and-path call): through every one
    // of them first, as a request over the wire is (request-router.ts `markForAdmission`).
    if (isMarkedForAdmission(req)) return this.requests.routeAuthenticated(req).catch((error: unknown) => this.routeFailureResponse(req, error));
    return this.requests.dispatch(req).catch((error: unknown) => this.routeFailureResponse(req, error));
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
      // Who queues a completion, and who reads it back: the job is the caller's own (control-plane/caller-reach.ts).
      callerPrincipal: (request: Request) => this.principalOf(request)?.principalId,
    };
    const batch: Parameters<typeof dispatchBatchRoutes>[1] | null = context.batchManager
      ? { batchManager: context.batchManager, parseJsonBody, parseOptionalJsonBody, callerPrincipal: (request: Request) => this.principalOf(request)?.principalId }
      : null;
    // One manager for the router's life: its write chain serializes token
    // creation, provision and disable across requests.
    const cloudflare: Parameters<typeof dispatchCloudflareRoutes>[1] = {
      manager: new CloudflareControlPlaneManager({
        configManager: context.configManager,
        secretsManager: context.secretsManager,
        authToken: context.authToken,
        ...(context.cloudflareTunnel ? { tunnelConnector: context.cloudflareTunnel } : {}),
      }),
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
      // Whose input a message is (security/turn-input-party.ts): the owner in person (their sign-in, a device they paired, their
      // own registered terminal program: owner-typed.ts), or someone else's; the operator token alone is a script.
      isOwnerCaller: (request) => ownerHimselfOf(this.principalOf(request), readProgramRegistration(request)),
      ...(context.callerProject ? { checkProject: (request: Request, raw: string) => context.callerProject!(raw, this.projectNamerOfRequest(request)) } : {}),
      // Who made a chat: with its project, who it belongs to (control-plane/caller-reach.ts).
      callerPrincipal: (request: Request) => this.principalOf(request)?.principalId,
      // And what it is: the chat's model acts for that maker (security/turn-session.ts).
      callerActor: (request: Request) => this.principalOf(request)?.actor,
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
        // `control.auth.current` says whether the caller is the owner in person, so the web offers the owner's own acts.
        ownerHimself: (request: Request) => ownerHimselfOf(this.principalOf(request), readProgramRegistration(request)),
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
        ...(this.context.servingListener ? { servingListener: this.context.servingListener } : {}),
        memoryEmbeddingRegistry: this.context.memoryEmbeddingRegistry,
        memoryRegistry: this.context.memoryRegistry,
        // A memory read is the project its call names (memory-project.ts), the same identity a record is kept under.
        memoryProjectOf: memoryProjectOf,
        // The one project check for the caller that sent the read (a device or a member names only a project given to it).
        ...(this.context.callerProject ? { callerProjectRefusal: (request: Request, folder: string) => {
          const verdict = this.context.callerProject!(folder, this.projectNamerOfRequest(request));
          return verdict.ok ? undefined : verdict.reason;
        } } : {}),
        // Only the owner in person reads every project's memory at once (their place's "Every project" choice).
        ownerHimself: (request: Request) => ownerHimselfOf(this.principalOf(request), readProgramRegistration(request)),
        // Only an act the owner makes changes the owner's own password: in person, or the owner's own command line (`do`).
        makesOwnerOnlyAct: (request: Request) => makesOwnerOnlyActOf(this.principalOf(request), readProgramRegistration(request)),
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
        mayReadSession: (request, session) => this.mayReadSession(request, session),
        userAuth: this.context.userAuth,
        // Who writes a memory record over these routes, from the credential (memory-route-author.ts), and whether a
        // session it names as the record's origin is its own.
        memoryAuthorOf: (request) => memoryAuthorOfRequest(request, this.principalOf(request), this.context.configManager.getHomeDirectory()),
        mayNameSession: (request, sessionId) => requestMayNameSession(request, this.principalOf(request), (id) => this.context.sessionBroker.registrantOf(id), sessionId),
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
          watcherRegistry: this.context.watcherRegistry,
        }),
      },
      runtime: {
        parseJsonBody: (request) => this.parseJsonBody(request),
        parseOptionalJsonBody: (request) => this.parseOptionalJsonBody(request),
        recordApiResponse: (request, path, response) => this.recordApiResponse(request, path, response),
        requireAdmin: (request) => this.context.requireAdmin(request),
        // Whose request it is, as the work it starts carries it: the owner's own press is theirs (method-owner-decision.ts).
        requestParty: (request) => {
          const principal = this.principalOf(request);
          const actor = principal?.actor;
          // The user, from any credential: what they start is theirs, on every device (a guest or a peer never reaches here).
          if (isTheUser(actor)) return { party: 'owner' as const };
          return { party: 'other' as const, who: `a caller that is not the user (${actor ?`${actor.class} ${actor.id}` : 'unknown'})`,
            ...(principal?.principalId ? { madeFor: principal.principalId } : {}) };
        },
        sessionBroker: buildRouterSessionBrokerAdapter(this.context.sessionBroker),
        mayReadSession: (request, session) => this.mayReadSession(request, session),
        // Kept with its kind (a sign-in user named `shared-token` is never this machine's token).
        requestPrincipalId: (request) => { const principal = this.principalOf(request); return principal ? callerKey(principal) : undefined; },
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
          defaultTimezone: () => this.context.automationManager.defaultTimezone(),
        },
        normalizeAtSchedule,
        normalizeEverySchedule,
        normalizeCronSchedule: (expression, timezone, staggerMs) => normalizeCronSchedule(expression, timezone, staggerMs, this.context.automationManager.defaultTimezone()),
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
        // `GET /api/sessions/:id/events`, see http/session-event-stream.ts.
        openSessionEventStream: (req, sessionId) => openScopedSessionEventStream(
          this.context.controlPlaneGateway,
          req,
          { clientPrefix: 'shared-session', sessionId, ...this.streamAuthority(req) },
        ),
        // The owner typed this into their own program: the owner, with a person's credential, a terminal app or the
        // Agent by its label, and a person's claim (runtime-session-routes.ts OWNER_TYPED_METADATA_KEY).
        ownerTypedAtProgram: (req) => ownerTypedAtProgram(this.principalOf(req), req.headers, readProgramRegistration(req)),
        // The owner in person sent it (runtime-session-routes.ts OWNER_HIMSELF_METADATA_KEY): in a hosted session the owner made, their turn.
        ownerHimself: (req) => ownerHimselfOf(this.principalOf(req), readProgramRegistration(req)),
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
      // ONE knowledge store: the Agent's routes (its knowledge tool, its CLI, its workspace) serve the daemon's own
      // knowledge, into which the Agent's earlier store was carried once (knowledge/agent-knowledge-carry.ts).
      agentKnowledge: this.knowledgeRouteContext(this.context.knowledgeService, this.context.knowledgeGraphqlService),
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
        // Who stores a file is who it belongs to (control-plane/caller-reach.ts).
        callerPrincipal: (request: Request) => this.principalOf(request)?.principalId,
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
        // Home Assistant's owner: whether a message is the owner's own (daemon/owner-channel-conversation.ts).
        channelPolicy: () => this.context.channelPolicy.getPolicy('homeassistant'),
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
        // The one folder check for the project a planning call names, as every call's folders are (caller-paths.ts).
        refuseProject: (request, folder) => {
          const principal = this.principalOf(request);
          const checkedCall = this.checkedCallOf(request);
          return callerPathRefusal({ id: 'projectPlanning', workFolders: ['workingDirectory'] }, { workingDirectory: folder }, undefined, {
            ...(principal?.credentialKind ? { credentialKind: principal.credentialKind } : {}), ...(principal ? { principalId: principal.principalId } : {}),
            ...(principal?.actor ? { actor: principal.actor } : {}), ...(checkedCall ? { call: checkedCall } : {}),
          }, this.context.gatewayMethods.pathRules?.() ?? CALLER_RULES_ABSENT);
        },
        projectIdOf: (folder) => projectIdentityOfFolder(this.context.configManager, folder),
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

  /** Whether a delivery to this path is saved and held through a self-update's restart instead of refused. */
  private holdsInboundDelivery(pathname: string, method: string): boolean {
    // The GitHub delivery is the route that serves it (POST /webhook/github), as the dispatcher above matches it.
    return (pathname === '/webhook/github' && method === 'POST') || this.context.channelPlugins.getByPath(pathname) !== null;
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
      // The owed answer is accepted in the daemon's operation log before GitHub is answered.
      operations: daemonOperationLog<GitHubReplyOperation>(this.context.configManager),
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
