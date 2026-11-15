import { requestedEffortOverride } from '../providers/reasoning-effort-surface.js';
import { completeGatewayScopePolicyBootstrap } from '../control-plane/scope-policy-bootstrap.js';
import { channelProfileForSession, withChannelExecutionMode } from '../channel-profiles/install-inbound-intake.js';
import { applyChannelProfileToSpawn } from '../channel-profiles/intake.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import { withTurnSurfaceId } from '../security/turn-boundary.js';
import { runDaemonBootGuarantees } from './facade-boot-guarantees.js';
import { logger } from '../utils/logger.js';
import { jsonErrorResponse } from './http/error-response.js';
import { summarizeError } from '../utils/error-display.js';
import { DaemonLifecycleRuntime, type NativeHandover, createDaemonOwnerAlerter, registerDaemonHeartbeatWatcher, runDaemonSessionStoreBoot } from './facade-lifecycle.js';
import { registerUpdateGatewayMethods } from '../control-plane/routes/update.js';
import { registerRelayGatewayMethods } from '../control-plane/routes/relay.js';
import { AgentManager } from '../tools/agent/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { UserAuthManager } from '../security/user-auth.js';
import type {
  AutomationDeliveryManager,
  AutomationManager,
} from '../automation/index.js';
import type { ApprovalBroker, ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { GatewayMethodCatalog } from '../control-plane/index.js';
import { sseIdleTimeoutSeconds } from '../control-plane/index.js';
import { buildDaemonChannelHealthWatcher } from './facade-channel-health.js';
import type {
  ChannelReplyPipeline,
  ChannelPluginRegistry,
  ChannelPolicyManager,
  RouteBindingManager,
  SurfaceRegistry,
  ChannelSurface,
} from '../channels/index.js';
import { buildDaemonClusterCoordinator, type ClusterCoordinator } from './facade-cluster.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { PlatformServiceManager } from './service-manager.js';
import type { WatcherRegistry } from '../watchers/index.js';
import { type DistributedPeerAuth } from '../runtime/remote/index.js';
import type { KnowledgeGraphqlService, KnowledgeService } from '../knowledge/index.js';
import type { IntegrationHelperService } from '../runtime/integration/helpers.js';
import type { DaemonControlPlaneHelper, ControlPlaneWebSocketData } from './control-plane.js';
import type { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import type { DaemonSurfaceActionHelper } from './surface-actions.js';
import type { DaemonTransportEventsHelper } from './transport-events.js';
import type { ResolvedDaemonFacadeRuntime } from './facade-types.js';
import type { DaemonHttpRouter } from './http/router.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { HostedSessionManager } from '../hosted-sessions/index.js';
import { reportHostedSessionRestore } from './hosted-sessions-composition.js';
import { isSurfaceDeliveryEnabled } from './surface-policy.js';
import { handleInteractiveApprovalAction } from './facade-approval-action.js';
import { AgentTaskAdapter } from '../runtime/tasks/adapters/agent-adapter.js';
import {
  configureDaemonSessionContinuation,
  createDaemonFacadeCollaborators,
  resolveDaemonFacadeRuntime,
  prepareDaemonFacadeRuntime,
} from './facade-composition.js';
import {
  GlobalNetworkTransportInstaller,
  resolveInboundTlsContext,
  type ResolvedInboundTlsContext,
} from '../runtime/network/index.js';
import { createRuntimeServices, type RuntimeServices } from '../runtime/services.js';
import { createAsyncDisposalScope, type AsyncDisposalScope } from '../runtime/async-disposal.js';
import type { McpServerConfig } from '../mcp/config.js';
import { isSurfaceFeatureGateEnabled } from '../runtime/feature-flags/index.js';
import { buildDaemonRelayReachability } from '../relay/daemon-wiring.js';
import type { RelayReachability } from '../relay/reachability.js';
import {
  readAutomationReasoningEffort,
  readAutomationWakeMode,
  readExternalContentSource,
  readStringList,
} from './helpers.js';
import type { DaemonConfig, DaemonDangerConfig, PendingSurfaceReply } from './types.js';
import { requirePortAvailable } from './port-check.js';
import { resolveHostBinding } from './host-resolver.js';
import { createHostModeRestartWatcher, RestartController } from './host-mode-watcher.js';
import { configureJudgmentRequestLifetime } from './http/judgment-request-lifetime.js';
import type { ServiceCommandRunner } from './service-handover.js';
import { inFlightWorkIds } from '../runtime/fleet/registry.js';

/**
 * The facade's configuration plus what a composing host that owns the whole
 * process may lend it. `onIncompleteHandover` ends that process with a failure
 * status once a handover stopped this runtime and then could not complete.
 */
export type DaemonServerConfig = DaemonConfig & {
  readonly onIncompleteHandover?: (() => void) | undefined;
  /** Runs the service-manager commands of an update, rollback or promotion handover. Tests inject it; the real `systemctl` otherwise. */
  readonly serviceCommandRunner?: ServiceCommandRunner | undefined;
};

interface UpgradeCapableServer {
  upgrade(req: Request, options?: { data?: unknown }): boolean;
  timeout?(req: Request, seconds: number): void;
}

type JsonBody = Record<string, unknown>;

/** One connected control-plane websocket, as the three delegators below see it. */
interface ControlPlaneWebSocketPeer { data: ControlPlaneWebSocketData; send(message: string): void }

// --- DaemonServer ---

type StartupOwner = 'session broker' | 'approval broker' | 'channel policy' | 'automation manager' | 'distributed runtime' | 'cluster rollback';
interface StartupDrain { readonly pending: Set<Promise<void>>; readonly failures: Set<StartupOwner>; }
// Per-facade ownership without widening the public declaration surface. A
// fail-fast join cannot retire sibling acquisitions or the first rollback stop.
const startupDrains = new WeakMap<object, StartupDrain>();
function ownStartup(owner: object, label: StartupOwner, action: () => Promise<void>): Promise<void> {
  let drain = startupDrains.get(owner);
  if (!drain) { drain = { pending: new Set(), failures: new Set() }; startupDrains.set(owner, drain); }
  const state = drain;
  // Defer invocation until ownership is recorded, including synchronous throws.
  const result = Promise.resolve().then(action).catch(() => {
    state.failures.add(label);
    throw new Error(`Daemon ${label} startup operation failed`);
  });
  const settled = result.then(() => {}, () => {});
  state.pending.add(settled);
  void settled.then(() => { state.pending.delete(settled); });
  return result;
}

/**
 * DaemonServer, HTTP task server. Enabled by default via `daemon.enabled`
 * (loopback-bound), resolved via resolveDaemonEnabled.
 * All routes require Bearer token auth (set via enable()).
 * POST /task   , submit a task; returns agentId.
 * GET  /task/:id, returns agent status.
 * GET  /status , server health check.
 */
export class DaemonServer {
  private enabled = false;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private port: number;
  private host: string;
  private acceptedTransportBinding: Pick<ResolvedDaemonFacadeRuntime, 'host' | 'port'> | null = null;
  private agentManager: AgentManager;
  private readonly runtimeServices: RuntimeServices;
  /** Whether this server constructed its runtime graph, and so may dispose it on stop(). */
  private readonly ownsRuntimeServices: boolean;
  private readonly closeSupplementalResources: () => Promise<void>;
  private readonly nativeHandoverDrain: DaemonConfig['drainForNativeHandover'];
  private readonly deferNativeActivationUntilHostReady: boolean;
  private hostStartupCompleted = false;
  private hostedSessionsRestored = false;
  private nativeStartupHandover: Exclude<ReturnType<DaemonLifecycleRuntime['activateNativeLifecycle']>, void> | undefined;
  private readonly integrationHelpers: IntegrationHelperService;
  private configManager: ConfigManager;
  private authToken: string | null = null;
  /** Exact serving lifetime, retired before stop callbacks and token/bind ABA. */
  private settingsLifetime: object | null = null;
  private userAuth: UserAuthManager;
  private githubWebhookSecret: string | null;
  private automationManager: AutomationManager;
  private runtimeBus: RuntimeEventBus;
  private readonly runtimeStore: RuntimeServices['runtimeStore'];
  private readonly runtimeDispatch: RuntimeServices['runtimeDispatch'];
  private readonly controlPlaneGateway: ControlPlaneGateway;
  private readonly gatewayMethods: GatewayMethodCatalog;
  private readonly sessionBroker: SharedSessionBroker;
  private readonly approvalBroker: ApprovalBroker;
  private readonly routeBindings: RouteBindingManager;
  private readonly deliveryManager: AutomationDeliveryManager;
  private readonly surfaceRegistry: SurfaceRegistry;
  private readonly channelPolicy: ChannelPolicyManager;
  private readonly channelPlugins: ChannelPluginRegistry;
  private readonly channelReplyPipeline: ChannelReplyPipeline;
  private readonly workProposals: import('../agents/work-proposal-store.js').WorkProposalStore;
  /** Decides whether THIS node is the one consuming inbound channels; see facade-cluster.ts. */
  private readonly clusterCoordinator: ClusterCoordinator;
  private readonly watcherRegistry: WatcherRegistry;
  /** Trigger family supervisor; started/stopped with the daemon so an on-exit trigger outlives the turn that created it. Undefined when the host composed its own services without one, that means no triggers, not a failure. */
  private readonly triggerManager: RuntimeServices['triggerManager'] | undefined;
  private readonly platformServiceManager: PlatformServiceManager;
  private readonly distributedRuntime: RuntimeServices['distributedRuntime'];
  private readonly voiceService: RuntimeServices['voiceService'];
  private readonly webSearchService: RuntimeServices['webSearchService'];
  private readonly knowledgeService: KnowledgeService;
  private readonly knowledgeGraphqlService: KnowledgeGraphqlService;
  private readonly mediaProviders: RuntimeServices['mediaProviders'];
  private readonly multimodalService: RuntimeServices['multimodalService'];
  private readonly artifactStore: RuntimeServices['artifactStore'];
  private readonly serviceRegistry: ServiceRegistry;
  private readonly serveFactory: typeof Bun.serve;
  private readonly pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
  private readonly controlPlaneHelper: DaemonControlPlaneHelper;
  private readonly surfaceDeliveryHelper: DaemonSurfaceDeliveryHelper;
  private readonly surfaceActionHelper: DaemonSurfaceActionHelper;
  private readonly transportEventsHelper: DaemonTransportEventsHelper;
  private readonly httpRouter: DaemonHttpRouter;
  /** Sweeps channel health and tells the owner over a channel that still works; see facade-channel-health.ts. */
  private readonly channelHealth: import('../channels/index.js').ChannelHealthWatcher;
  private replyPoller: ReturnType<typeof setInterval> | null = null;
  /** Lifecycle sidecar: clean-shutdown marker, receipts, hourly auto-update. */
  private lifecycle: DaemonLifecycleRuntime | null = null;
  private readonly companionChatManager: CompanionChatManager;
  private releaseBrowserJudgmentChats: (() => void) | undefined;
  private readonly hostedSessions: HostedSessionManager | null;
  private relayReachability: RelayReachability | null = null;
  private agentTaskAdapter: import('../runtime/tasks/adapters/agent-adapter.js').AgentTaskAdapter | null = null;
  private agentTaskAdapterUnsub: (() => void) | null = null;
  private tlsState: ResolvedInboundTlsContext | null = null;
  private approvalBrokerUnsubscribe: (() => void) | null = null;
  /** Unsubscribe from controlPlane config key watchers; cleared on stop(). */
  private _configWatchUnsub: (() => void) | null = null;
  /**
   * The config-driven rebind cycle. Its "down" state covers a binding change
   * that could bind neither the new address nor the previous one: no listener
   * exists while the daemon is otherwise up, and correcting the setting must
   * still rebind.
   */
  private readonly restartCycle = new RestartController({
    isRunning: () => this.server !== null,
    run: () => {
      logger.info('DaemonServer: controlPlane binding changed, rebinding listener…');
      return this.rebindControlPlaneListener(this.listenerTransition);
    },
    onError: (err) => logger.error('DaemonServer: restart after config change failed', { error: summarizeError(err) }),
  });
  private stoppingRuntime: Promise<void> | null = null;
  /** Full stop retires pending listener acquisition, including binding ABA. */
  private listenerTransition: object = {};
  /** The detached native socket remains owned until its actual close settles. */
  private listenerDrain: Promise<void> | null = null;
  private tornDown = false; // True once stop() tore this daemon down; cleared by a successful bind. Teardown was gated on `server === null`, which conflated "never bound a socket" with "has nothing to release". The CONSTRUCTOR starts the companion-chat GC sweep and the batch tick, so enable() plus a failed or never-called start() left both running with no reachable stop. What must not run twice is the teardown, so that is what this guards.
  /** External stop/fence retires a pending boot; its own native handover does not. */
  private externalStopEpoch = 0;

  /** Prepare the actual configured project before creating an owned runtime.
   * Synchronous construction remains available with an already prepared context
   * or a supplied runtimeServices graph. */
  static async create(config: DaemonServerConfig = {}): Promise<DaemonServer> {
    const captured = { ...config };
    await prepareDaemonFacadeRuntime(captured);
    const supplementalOwnership = createAsyncDisposalScope('daemon supplemental knowledge');
    try { return new DaemonServer(captured, supplementalOwnership); }
    catch (error) {
      try { await supplementalOwnership.close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Daemon construction and supplemental cleanup failed'); }
      throw error;
    }
  }

  constructor(
    private config: DaemonServerConfig = {},
    supplementalOwnership: AsyncDisposalScope = createAsyncDisposalScope('daemon supplemental knowledge'),
  ) {
    try {
    this.nativeHandoverDrain = config.drainForNativeHandover;
    this.deferNativeActivationUntilHostReady = config.deferNativeActivationUntilHostReady === true;
    const resolved = resolveDaemonFacadeRuntime(config, supplementalOwnership, () => this.authToken);
    this.configManager = resolved.configManager;
    this.runtimeServices = resolved.runtimeServices;
    this.ownsRuntimeServices = resolved.ownsRuntimeServices;
    this.closeSupplementalResources = resolved.closeSupplementalResources;
    this.integrationHelpers = resolved.integrationHelpers;
    this.port = resolved.port;
    this.host = resolved.host;
    this.agentManager = resolved.agentManager;
    this.userAuth = resolved.userAuth;
    this.automationManager = resolved.automationManager;
    this.runtimeBus = resolved.runtimeBus;
    this.runtimeStore = resolved.runtimeStore;
    this.runtimeDispatch = resolved.runtimeDispatch;
    this.controlPlaneGateway = resolved.controlPlaneGateway;
    this.gatewayMethods = resolved.gatewayMethods;
    this.sessionBroker = resolved.sessionBroker;
    this.approvalBroker = resolved.approvalBroker;
    this.routeBindings = resolved.routeBindings;
    this.deliveryManager = resolved.deliveryManager;
    this.surfaceRegistry = resolved.surfaceRegistry;
    this.channelPolicy = resolved.channelPolicy;
    this.channelPlugins = resolved.channelPlugins;
    this.watcherRegistry = resolved.watcherRegistry;
    this.triggerManager = resolved.triggerManager;
    this.platformServiceManager = resolved.platformServiceManager;
    this.distributedRuntime = resolved.distributedRuntime;
    this.voiceService = resolved.voiceService;
    this.webSearchService = resolved.webSearchService;
    this.knowledgeService = resolved.knowledgeService;
    this.knowledgeGraphqlService = resolved.knowledgeGraphqlService;
    this.mediaProviders = resolved.mediaProviders;
    this.multimodalService = resolved.multimodalService;
    this.artifactStore = resolved.artifactStore;
    this.serviceRegistry = resolved.serviceRegistry;
    this.serveFactory = resolved.serveFactory;
    this.githubWebhookSecret = resolved.githubWebhookSecret;
    this.companionChatManager = resolved.companionChatManager;
    this.hostedSessions = resolved.hostedSessions;

    const collaborators = createDaemonFacadeCollaborators({
      paymentReplies: config.paymentReplies,
      runtime: resolved,
      transportBinding: () => this.acceptedTransportBinding ?? { host: this.boundHost, port: this.boundPort },
      pendingSurfaceReplies: this.pendingSurfaceReplies,
      authToken: () => this.authToken,
      settingsLifetime: () => this.settingsLifetime,
      trustProxyEnabled: () => this.trustProxyEnabled(),
      dispatchApiRoutes: (req) => this.dispatchApiRoutes(req),
      parseJsonBody: (req) => this.parseJsonBody(req),
      requireAuthenticatedSession: (req) => this.requireAuthenticatedSession(req),
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      extractAuthToken: (req) => this.extractAuthToken(req),
      requireAdmin: (req) => this.requireAdmin(req),
      requireRemotePeer: (req, scope) => this.requireRemotePeer(req, scope),
      invokeGatewayMethodCall: (input) => this.invokeGatewayMethodCall(input),
      syncSpawnedAgentTask: (record, sessionId) => this.syncSpawnedAgentTask(record, sessionId),
      syncFinishedAgentTask: (record) => this.syncFinishedAgentTask(record),
      surfaceDeliveryEnabled: (surface) => this.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
      handleApprovalAction: (approvalId, action, req, interaction?: { readonly surface: string; readonly userId: string }) => this.handleApprovalAction(approvalId, action, req, interaction),
      tlsState: () => this.tlsState,
      swapManager: this.config.swapManager ?? null,
      // Resolve companion-chat defaults from the live ProviderRegistry (current route, not a startup snapshot).
      resolveDefaultProviderModel: () => {
        try {
          const current = resolved.runtimeServices.providerRegistry.getCurrentModel();
          if (!current.provider || !current.id) return null;
          return { provider: current.provider, model: current.id, reasoningEffort: requestedEffortOverride(resolved.runtimeServices.configManager) };
        } catch {
          return null;
        }
      },
    });
    this.channelReplyPipeline = collaborators.channelReplyPipeline;
    this.controlPlaneHelper = collaborators.controlPlaneHelper;
    this.surfaceDeliveryHelper = collaborators.surfaceDeliveryHelper;
    this.surfaceActionHelper = collaborators.surfaceActionHelper;
    this.workProposals = collaborators.workProposals;
    this.transportEventsHelper = collaborators.transportEventsHelper;
    this.httpRouter = collaborators.httpRouter;
    this.channelHealth = buildDaemonChannelHealthWatcher(resolved);
    this.clusterCoordinator = buildDaemonClusterCoordinator(config, resolved, collaborators);

    // Lifecycle sidecar: clean-shutdown marker, update/crash receipts, and
    // the hourly auto-updater gated on the real busy signal.
    this.lifecycle = new DaemonLifecycleRuntime({
      configManager: this.configManager,
      platformServiceManager: this.platformServiceManager,
      // The fleet is the one owner of "work in flight": agents, contracts,
      // automation runs, watchers, background processes and hosted agents.
      isIdle: () => inFlightWorkIds(this.runtimeServices.processRegistry).length === 0,
      describeActiveWork: () => inFlightWorkIds(this.runtimeServices.processRegistry),
      updateArtifact: this.config.updateArtifact, // absent = host-managed updates (see DaemonUpdateArtifact)
      // Forwarded so a daemon on an overridden home cannot seize the machine's
      // service unit. Absent = the machine default, which is the only case that
      // may promote.
      ...(this.config.hasOverriddenHome === undefined ? {} : { hasOverriddenHome: this.config.hasOverriddenHome }),
      stopGracefully: () => this.stopRuntime(true), // update/rollback restarts take the normal stop path, so shutdown hooks fire
      // The composing host that owns the process ends it after a handover
      // that could not complete once this runtime had stopped.
      ...(config.onIncompleteHandover ? { onIncompleteHandover: config.onIncompleteHandover } : {}),
      ...(config.serviceCommandRunner ? { serviceCommandRunner: config.serviceCommandRunner } : {}),
      alertOwner: createDaemonOwnerAlerter(this.routeBindings, this.surfaceDeliveryHelper),
    });
    // A hosted session may be running with nobody attached, so an undeliverable
    // message to one has no screen to appear on. Same alerter, same reason.
    this.hostedSessions?.setOwnerAlerter(createDaemonOwnerAlerter(this.routeBindings, this.surfaceDeliveryHelper));
    // Whether this daemon is keeping itself current, asked over the wire
    // rather than read out of a log on the host, see routes/update.ts.
    registerUpdateGatewayMethods(this.runtimeServices.gatewayMethods, this.lifecycle);
    // Relay reachability read through the SAME controller getRelayReachability()
    // returns, so an in-process surface and a client over the wire cannot
    // disagree about whether this daemon is reachable, see routes/relay.ts.
    registerRelayGatewayMethods(this.runtimeServices.gatewayMethods, () => this.relayReachability);
    this.httpRouter.setDaemonStatusProviders({
      // Update/crash receipts, and which node currently reads the inbox.
      collectReceipts: () => this.collectDaemonReceipts(),
      peekReceipts: () => this.peekDaemonReceipts(),
      acknowledgeReceipts: (ids) => this.acknowledgeDaemonReceipts(ids),
      collectClusterStatus: () => this.clusterCoordinator.status(),
      // The artifact's own release version, when this host ships one. Reported
      // beside the platform build rather than instead of it.
      buildVersion: () => this.config.updateArtifact?.version ?? null,
    });

    // Wire AgentTaskAdapter to the RuntimeEventBus so task records reach terminal states on agent finish.
    this.agentTaskAdapter = new AgentTaskAdapter(this.runtimeStore);
    this.agentTaskAdapterUnsub = this.agentTaskAdapter.attachRuntimeBus(this.runtimeBus);
    this.agentTaskAdapter.reconcileOnRestart(); // marks tasks running at startup as aborted after daemon restart

    configureDaemonSessionContinuation({
      sessionBroker: this.sessionBroker,
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
      modelCandidates: () => this.runtimeServices.providerRegistry.listModels(),
      // The continuation reaches the same gate the inbound message did.
      surfaceActionHelper: this.surfaceActionHelper,
      configReader: this.configManager,
    });

    this.distributedRuntime.attachRuntime({
      sessionBridge: this.sessionBroker,
      approvalBridge: this.approvalBroker,
      automationBridge: this.automationManager,
      eventPublisher: (event, payload) => {
        this.controlPlaneGateway.publishEvent(event, payload);
      },
    });
    completeGatewayScopePolicyBootstrap(this.gatewayMethods);
    } catch (error) {
      supplementalOwnership.dispose();
      throw error;
    }
  }

  listRecentControlPlaneEvents(limit = 100): readonly import('../control-plane/gateway.js').ControlPlaneRecentEvent[] {
    return this.controlPlaneGateway.listRecentEvents(limit);
  }

  /**
   * Enable the daemon. Caller passes the resolved enable decision (from
   * resolveDaemonEnabled). The token authenticates all requests. Returns false
   * if the passed-in flag forbids it.
   */
  enable(dangerConfig: DaemonDangerConfig, token?: string): boolean {
    if (!dangerConfig.daemon) {
      logger.info('DaemonServer.enable: daemon disabled by config (daemon.enabled=false), not enabling');
      return false;
    }
    // Only a successful start creates a serving lifetime after retirement.
    this.settingsLifetime = this.settingsLifetime === null || this.server === null || this.tornDown ? null : {};
    this.enabled = true;
    this.authToken = token ?? null;
    this.controlPlaneGateway.setServerState({ enabled: true, host: this.host, port: this.port });
    return true;
  }

  /** Bound TCP port after {@link DaemonServer.start} (resolves a `port: 0` request to the real port). */
  get boundPort(): number {
    const served = (this.server as { port?: number } | null)?.port;
    return typeof served === 'number' ? served : this.port;
  }

  /** The host the daemon is bound to. */
  get boundHost(): string { return this.host; }

  /** Protocol of the actual local listener; proxy presentation is not local TLS. */
  get boundScheme(): 'http' | 'https' { return this.tlsState?.tls ? 'https' : 'http'; }

  /** The daemon's shared approval broker, the SAME broker the HTTP approvals routes resolve through. Exposed so embedders and boot-factory proof tests can seed/inspect approvals (bridge an external UI, or prove per-hunk approve/deny over the live wire). */
  get approvals(): ApprovalBroker { return this.approvalBroker; }

  /** The daemon's canonical single-writer memory registry, the SAME store the HTTP memory routes serve. Exposed so embedders and boot-factory proof tests can read back a wire write as a direct canonical-store read. */
  get memory(): RuntimeServices['memoryRegistry'] { return this.runtimeServices.memoryRegistry; }
  /** The daemon's trigger-family supervisor, the same instance the fleet registry and the supervision tick use. */
  get triggers(): RuntimeServices['triggerManager'] | undefined { return this.runtimeServices.triggerManager; }

  /** The daemon's runtime event bus, the SAME bus every service emits on. Exposed so an in-process embedder (see the `/embed` subpath) can subscribe to typed runtime events without going over the wire. */
  get eventBus(): RuntimeEventBus { return this.runtimeBus; }

  /** The daemon's shared session broker, the SAME broker the HTTP session routes drive. Exposed so an in-process embedder can submit input to a session directly. */
  get sessions(): SharedSessionBroker { return this.sessionBroker; }
  /** The contracts operator surface, the SAME service the contracts.* methods and their REST paths act through. Exposed so an in-process embedder starts the contract a spawn-mode submit asks for (embed/session.ts). */
  get contracts(): RuntimeServices['contractOperator'] { return this.runtimeServices.contractOperator; }

  /**
   * Cancel a running agent by id, the SAME cooperative-plus-abort cancellation
   * the operator kill path uses: it flips the agent to `cancelled` and aborts the
   * agent's in-flight provider call so the turn stops mid-flight rather than
   * running to completion. Returns false for an unknown id. Exposed so an
   * in-process embedder (the ACP adapter) can honor a client `session/cancel` as
   * a real cancellation of the session's active agent.
   */
  cancelAgent(agentId: string): boolean {
    return this.agentManager.cancel(agentId);
  }

  /**
   * Connect a single MCP server by config into this daemon's live MCP registry,
   * the SAME registry that namespaces tools as `mcp:<name>:<tool>`. Exposed so an
   * in-process embedder (the ACP adapter) can wire the MCP servers a client
   * declared in `session/new` into the session's tool surface. stdio transport
   * only (the registry spawns a process); an error connecting one server is
   * surfaced to the caller.
   */
  async registerMcpServer(config: McpServerConfig): Promise<void> {
    await this.runtimeServices.mcpRegistry.connectServer(config);
  }

  /**
   * Start the daemon. Refuses to start if not explicitly enabled.
   */
  async start(): Promise<void | NativeHandover> {
    const stopEpoch = this.externalStopEpoch;
    await this.restartCycle.pending;
    await this.stoppingRuntime;
    if (this.externalStopEpoch !== stopEpoch || this.restartCycle.closed) return;
    if (this.server === null) this.settingsLifetime = null;
    // Guarantees the daemon refuses to inherit from its host; see
    // facade-boot-guarantees.ts for why each one is owned here and why order matters.
    await runDaemonBootGuarantees(this.configManager, this.runtimeServices);
    if (this.externalStopEpoch !== stopEpoch || this.restartCycle.closed) return;
    if (!this.enabled) {
      logger.info('Daemon mode is disabled (daemon.enabled=false). It is on by default.');
      return;
    }
    if (this.authToken === null) {
      logger.info('DaemonServer: starting with session-based authentication via UserAuth');
    }
    if (this.server !== null) {
      logger.info('DaemonServer: already running');
      return;
    }
    // A revoked pairing, shared token or user closes that principal's connections at once.
    this.controlPlaneHelper.watchRevocations();
    this.hostStartupCompleted = false;
    this.nativeStartupHandover = undefined;
    // Crash-loop guard, before anything that can fail: repeated boots that
    // never reached a fully-started daemon restore the kept previous binary
    // and hand over to it (facade-lifecycle.ts).
    const lifecycle = this.lifecycle;
    const nativeHandover = await lifecycle?.onStarting();
    if (this.externalStopEpoch !== stopEpoch || this.restartCycle.closed) {
      lifecycle?.beginStopping(false);
      await lifecycle?.drainHandovers(false);
      return;
    }
    if (nativeHandover && lifecycle) {
      const drain = lifecycle.drainHandovers();
      // The host owns this drain even when startup intentionally binds no listener.
      void drain.catch(() => {});
      return Object.freeze({ state: 'handover' as const, drain,
        cancel: () => lifecycle.beginStopping(false) });
    }

    // The most common start failure is a port already in use. Probe it before
    // any lifecycle owner is attached, so that refusal leaves nothing running.
    const transition = this.listenerTransition;
    let previousBinding = this.configuredControlPlaneBinding();
    let selectedBinding = { host: this.host, port: this.port };
    let probedIncarnation = this.configManager.getConfigurationIncarnation();
    // Skip the OS port probe when the host injects a custom serve factory.
    if (this.serveFactory === Bun.serve) {
      await requirePortAvailable(this.port, this.host, 'daemon');
    }

    this.surfaceActionHelper.startDelegatedTelegram();
    new GlobalNetworkTransportInstaller().install(this.configManager);
    if (!this.approvalBrokerUnsubscribe) {
      this.approvalBrokerUnsubscribe = this.approvalBroker.subscribe((approval) => {
        void this.surfaceDeliveryHelper.notifyApprovalUpdate(approval).catch((error: unknown) => {
          logger.warn('DaemonServer: approval notification failed', {
            approvalId: approval.id,
            error: summarizeError(error),
          });
        });
      });
    }
    this.routeBindings.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });
    this.surfaceRegistry.attachRuntime(this.runtimeStore);
    this.deliveryManager.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });
    this.automationManager.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
      deliveryManager: this.deliveryManager,
    });
    this.controlPlaneGateway.attachRuntime({
      runtimeBus: this.runtimeBus,
      runtimeStore: this.runtimeStore,
    });

    this.transportEventsHelper.emitTransportInitializing();
    try {
      // A stop admitted during asynchronous boot still owns its write drain.
      await this.stoppingRuntime;
      if (this.listenerTransition !== transition) return;
      this.tornDown = false;
      this.workProposals.startSweep();
      const acquireInitialBinding = async (): Promise<{ tlsState: ResolvedInboundTlsContext; incarnation: number } | null> => {
        while (this.listenerTransition === transition && !this.tornDown) {
          const incarnation = this.configManager.getConfigurationIncarnation();
          const latestBinding = this.configuredControlPlaneBinding();
          if (latestBinding.host !== previousBinding.host || latestBinding.port !== previousBinding.port) {
            selectedBinding = latestBinding;
          }
          previousBinding = latestBinding;
          this.host = selectedBinding.host;
          this.port = selectedBinding.port;
          if (this.serveFactory === Bun.serve && probedIncarnation !== incarnation) {
            await requirePortAvailable(this.port, this.host, 'daemon');
            probedIncarnation = incarnation;
          }
          if (this.listenerTransition !== transition || this.tornDown) return null;
          if (this.configManager.getConfigurationIncarnation() !== incarnation) continue;
          const tlsState = resolveInboundTlsContext(this.configManager, 'controlPlane');
          this.tlsState = tlsState;
          if (await this.bindControlPlaneListener(transition, tlsState, incarnation)) {
            if (this.configManager.getConfigurationIncarnation() === incarnation) return { tlsState, incarnation };
            await this.detachControlPlaneListener();
          }
        }
        return null;
      };
      let binding = await acquireInitialBinding();
      if (binding === null) return;

      // Boot precondition: fold legacy session stores into the store the broker serves, then sweep the pre-split one aside. See daemon-session-store-boot.ts.
      await runDaemonSessionStoreBoot({ sessionBroker: this.sessionBroker, shellPaths: this.runtimeServices.shellPaths, surfaceRoot: this.runtimeServices.surfaceRoot, recordReceipt: (text) => this.lifecycle?.receiptStore().record(text) });
      await Promise.all([
        ownStartup(this, 'session broker', () => this.sessionBroker.start()),
        ownStartup(this, 'approval broker', () => this.approvalBroker.start()),
        ownStartup(this, 'channel policy', () => this.channelPolicy.start()),
        ownStartup(this, 'automation manager', () => this.automationManager.start()),
        ownStartup(this, 'distributed runtime', () => this.distributedRuntime.start()),
      ]);
      await this.clusterCoordinator.start();
      this.channelHealth.start(); // after the coordinator, so the first sweep sees the ingress this node actually won rather than calling every surface dead mid-election
      await this.companionChatManager.init();
      this.releaseBrowserJudgmentChats = this.runtimeServices.browserJudgment?.bindChatSessions?.(this.companionChatManager);
      // Restore what survived; the report states what could not come back.
      // Once per manager: a second init (a start retried after a failure) would stack a second set of bus subscriptions and reset live entries.
      if (this.hostedSessions && !this.hostedSessionsRestored) {
        const restored = await this.hostedSessions.init();
        this.hostedSessionsRestored = true;
        reportHostedSessionRestore(restored);
      }
      // Init the canonical memory store so the daemon is a live single-writer memory service on accept (memory.records.add would else throw "not initialized" on a cold store).
      await this.runtimeServices.memoryStore.init();
      if (this.replyPoller === null) {
        // Poll every 2 s for asynchronously-resolved surface replies; short interval
        // keeps companion latency low while batching concurrent replies.
        this.replyPoller = setInterval(() => {
          void this.pollPendingSurfaceReplies().catch((error: unknown) => {
            logger.warn('DaemonServer: surface reply poll failed', { error: summarizeError(error) });
          });
        }, 2_000);
        // unref() so this timer never keeps the event loop alive past shutdown.
        (this.replyPoller as unknown as { unref?: () => void }).unref?.();
      }
      this.surfaceRegistry.syncConfiguredSurfaces();
      if (this.configManager.get('watchers.enabled')) {
        registerDaemonHeartbeatWatcher(this.watcherRegistry, this.configManager, () => this.automationManager.reconcileSchedules());
      }
      // Trigger family. start() always runs: it recovers persisted state (so an on-exit trigger from a
      // previous boot fires its honest unknown/daemon-restart payload) and arms the supervision tick,
      // whose body no-ops while watchers.triggers.enabled is false, the flag takes effect without a restart.
      // A host that composed its own RuntimeServices without one simply gets no triggers.
      try {
        const r = this.triggerManager?.start();
        if (!r) {
          logger.debug('No trigger family on this runtime; skipping trigger startup.');
        } else if (r.triggersLoaded > 0 || r.triggersReaped > 0 || r.quarantined) {
          logger.info('Trigger family recovered', { loaded: r.triggersLoaded, reaped: r.triggersReaped, orphanedProcesses: r.orphanedProcesses.length, ...(r.quarantined ? { quarantined: r.quarantined } : {}) });
        }
      } catch (error) {
        logger.warn('Trigger family failed to start; the daemon continues without it', { error: summarizeError(error) });
      }
      // Manager startup awaits can retire an otherwise current native bind.
      // Reacquire only the listener; the initialized backend owners stay live.
      while (this.configManager.getConfigurationIncarnation() !== binding.incarnation) {
        await this.detachControlPlaneListener();
        binding = await acquireInitialBinding();
        if (binding === null) return;
      }
      if (this.listenerTransition !== transition || this.tornDown) return;
      this.controlPlaneGateway.setServerState({ enabled: true, host: this.host, port: this.port });
      this._attachControlPlaneConfigWatcher();
      this.transportEventsHelper.emitTransportConnected();
      // Outbound relay reachability (default OFF; gated by relay.enabled + the
      // relay-connect flag + a configured relay.url). Non-blocking so a relay
      // hiccup never blocks daemon startup.
      this.relayReachability = buildDaemonRelayReachability(this.configManager, this.runtimeServices.secretsManager, this.runtimeServices.featureFlags, (req) => this.handleRequest(req), logger, this.runtimeServices.stepUpService.createVerifier());
      void this.relayReachability.start().catch((error: unknown) =>
        logger.warn('DaemonServer: relay reachability failed to start', { error: summarizeError(error) }),
      );
      logger.info('DaemonServer started', {
        port: this.port,
        host: this.host,
        tlsMode: binding.tlsState.mode,
        scheme: binding.tlsState.scheme,
        trustProxy: binding.tlsState.trustProxy,
      });
      if (!this.deferNativeActivationUntilHostReady) return this.completeHostStartup();
    } catch (err) {
      this.settingsLifetime = null;
      const message = summarizeError(err);
      this.releaseBrowserJudgmentChats?.();
      this.releaseBrowserJudgmentChats = undefined;
      if (this.replyPoller !== null) {
        clearInterval(this.replyPoller);
        this.replyPoller = null;
      }
      this.workProposals.dispose();
      this.surfaceDeliveryHelper.abandonPendingSurfaceReplies('the daemon failed to start before the reply was delivered');
      this.channelHealth.stop();
      this.automationManager.stop();
      // Retain the FIRST stop: the coordinator fences synchronously and later
      // stop calls may return before this admitted consumer drain finishes.
      void ownStartup(this, 'cluster rollback', () => this.clusterCoordinator.stop('daemon start failed')).catch(() => {});
      try {
        this.watcherRegistry.stopWatcher('daemon-heartbeat', 'daemon-start-failed');
      } catch (cleanupError) {
        logger.warn('DaemonServer startup cleanup failed to stop heartbeat watcher', {
          error: summarizeError(cleanupError),
        });
      }
      this.approvalBrokerUnsubscribe?.();
      this.approvalBrokerUnsubscribe = null;
      this.surfaceActionHelper.closeDelegatedTelegram();
      this.relayReachability?.stop();
      this.relayReachability = null;
      await this.detachControlPlaneListener();
      this.tlsState = null;
      this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
      this.transportEventsHelper.emitTransportTerminalFailure(message);
      this.acceptedTransportBinding = null;
      const rollbackDrain = this.workProposals.flush();
      // A second start must not reopen admission during failed-start cleanup.
      // An already-admitted full stop keeps ownership of its larger barrier.
      if (!this.stoppingRuntime) this.stoppingRuntime = rollbackDrain;
      try { await rollbackDrain; }
      finally { if (this.stoppingRuntime === rollbackDrain) this.stoppingRuntime = null; }
      throw err;
    }
  }

  /** The composing host calls this after its additional listeners and boot
   * tasks settle. An immediate promotion owns the same awaitable handover as
   * startup rollback; no caller may continue starting work after that result. */
  completeHostStartup(): void | NativeHandover {
    if (this.nativeStartupHandover) return this.nativeStartupHandover;
    // A host that fenced admission is shutting down; arming the updater or a service handover now would race its stop.
    if (this.restartCycle.closed) return;
    if (this.server === null || this.tornDown || this.stoppingRuntime) {
      throw new Error('Daemon native lifecycle cannot activate before its serving runtime is ready');
    }
    if (!this.hostStartupCompleted) {
      // Only the complete host boot resets the failed-start streak and records
      // startup announcements. A live socket alone does not prove readiness.
      this.hostStartupCompleted = true;
      try { this.lifecycle?.onStarted(true); }
      catch (error) { this.hostStartupCompleted = false; throw error; }
      if (this.server === null || this.tornDown || this.stoppingRuntime) {
        throw new Error('Daemon serving runtime retired during startup completion');
      }
    }
    const outcome = this.lifecycle?.activateNativeLifecycle();
    if (outcome) this.nativeStartupHandover = outcome;
    return outcome;
  }

  /**
   * Bind the control-plane listener and publish it. With `replacing`, the
   * listener it supersedes keeps serving until this one is published and is
   * closed only then; a candidate that cannot be bound or published leaves
   * that listener and its settings lifetime exactly as they were.
   */
  private async bindControlPlaneListener(
    transition: object, tlsState: ResolvedInboundTlsContext, incarnation: number,
    replacing?: { readonly server: ReturnType<typeof Bun.serve>; readonly lifetime: object | null },
  ): Promise<boolean> {
    if (this.listenerTransition !== transition || this.tornDown
      || this.configManager.getConfigurationIncarnation() !== incarnation) return false;
    const self = this;
    const lifetime = {};
    this.settingsLifetime = lifetime;
    const withdrawLifetime = (): void => {
      if (this.settingsLifetime !== lifetime) return;
      this.settingsLifetime = replacing && this.server === replacing.server ? replacing.lifetime : null;
    };
    try {
      const server = this.serveFactory({
        port: this.port,
        hostname: this.host,
        // Derived from the SSE heartbeat interval so a quiet stream outlives it (Bun's 10s default would not).
        idleTimeout: sseIdleTimeoutSeconds(),
        ...(tlsState.tls ? { tls: tlsState.tls } : {}),
        async fetch(req: Request, server: UpgradeCapableServer): Promise<Response | undefined> {
          configureJudgmentRequestLifetime(req, server);
          const upgrade = self.tryUpgradeControlPlaneWebSocket(req, server);
          if (upgrade === 'upgraded') return;
          if (upgrade) return upgrade;
          return self.handleRequest(req);
        },
        websocket: {
          open(ws) {
            self.handleControlPlaneWebSocketOpen(ws as unknown as { data: ControlPlaneWebSocketData; send(message: string): void });
          },
          message(ws, message) {
            void self.handleControlPlaneWebSocketMessage(
              ws as unknown as { data: ControlPlaneWebSocketData; send(message: string): void },
              message,
            ).catch((error: unknown) => {
              logger.warn('DaemonServer: control-plane websocket message failed', {
                error: summarizeError(error),
              });
            });
          },
          close(ws) {
            self.handleControlPlaneWebSocketClose(ws as unknown as { data: ControlPlaneWebSocketData });
          },
        },
      });
      const current = (): boolean => this.listenerTransition === transition && !this.tornDown
        && this.settingsLifetime === lifetime && this.configManager.getConfigurationIncarnation() === incarnation;
      // Publication is async: mutations queued by the native factory retire its candidate too.
      if (current()) await Promise.resolve();
      if (!current()) {
        withdrawLifetime();
        await this.closeControlPlaneListener(server);
        return false;
      }
      this.server = server;
      this.restartCycle.setDown(false);
      this.acceptedTransportBinding = { host: this.boundHost, port: this.boundPort };
      if (replacing) await this.closeControlPlaneListener(replacing.server);
      return true;
    } catch (error) {
      withdrawLifetime();
      throw error;
    }
  }

  private async detachControlPlaneListener(): Promise<void> {
    this.settingsLifetime = null;
    const server = this.server;
    this.server = null;
    this.tlsState = null;
    if (server === null) {
      await this.listenerDrain;
      return;
    }
    await this.closeControlPlaneListener(server);
  }

  private async closeControlPlaneListener(server: ReturnType<typeof Bun.serve>): Promise<void> {
    // Reserve before invoking native close: abort callbacks can reenter stop.
    const closed = Promise.withResolvers<void>();
    const drain = closed.promise;
    this.listenerDrain = drain;
    try {
      void Promise.resolve(server.stop(true)).then(closed.resolve, closed.reject);
    } catch (error) {
      closed.reject(error);
    }
    try { await drain; }
    finally { if (this.listenerDrain === drain) this.listenerDrain = null; }
  }

  private configuredControlPlaneBinding(): ReturnType<typeof resolveHostBinding> {
    return resolveHostBinding(this.configManager.get('controlPlane.hostMode') ?? 'local',
      String(this.configManager.get('controlPlane.host') ?? '127.0.0.1'),
      Number(this.configManager.get('controlPlane.port') ?? 3421), 'controlPlane');
  }

  private async rebindControlPlaneListener(transition: object): Promise<void> {
    const current = (): boolean => this.listenerTransition === transition
      && !this.tornDown && !this.restartCycle.closed;
    // The address that last served. A new binding that cannot be bound falls
    // back here, so a typo in a setting never leaves the API unreachable (and
    // therefore uncorrectable over the wire).
    const fallback = this.acceptedTransportBinding ?? (this.server !== null ? { host: this.host, port: this.boundPort } : null);
    while (current()) {
      this.restartCycle.takeDirty();
      // A different host or port is bound BEFORE the serving listener is
      // released, so a binding that cannot be used never takes the API down.
      // The same address (a TLS or mode change) cannot be bound twice, so that
      // case still releases first and falls back if the new bind fails.
      const swapFrom = this.server;
      let incarnation = this.configManager.getConfigurationIncarnation();
      let binding = this.configuredControlPlaneBinding();
      // The served port, not the configured one: a listener bound to port 0 serves on an assigned port, and naming that port is the same address.
      const swap = swapFrom !== null && !(binding.host === this.host && binding.port === this.boundPort);
      if (swap && swapFrom !== null) {
        const previous = { host: this.host, port: this.port, tlsState: this.tlsState, lifetime: this.settingsLifetime };
        try {
          if (this.serveFactory === Bun.serve) await requirePortAvailable(binding.port, binding.host, 'daemon');
          if (!current()) return;
          if (this.restartCycle.dirty || this.configManager.getConfigurationIncarnation() !== incarnation) continue;
          this.host = binding.host;
          this.port = binding.port;
          this.tlsState = resolveInboundTlsContext(this.configManager, 'controlPlane');
          if (!await this.bindControlPlaneListener(transition, this.tlsState, incarnation, { server: swapFrom, lifetime: previous.lifetime })) {
            if (this.server === swapFrom) { this.host = previous.host; this.port = previous.port; this.tlsState = previous.tlsState; }
            continue;
          }
        } catch (error) {
          if (this.server === swapFrom) { this.host = previous.host; this.port = previous.port; this.tlsState = previous.tlsState; }
          if (!current()) return;
          // A change that arrived while this candidate failed supersedes it.
          if (this.restartCycle.dirty) continue;
          logger.error('DaemonServer: the new control-plane binding could not be bound; still serving on the previous address', {
            wanted: `${binding.host}:${binding.port}`, serving: `${this.host}:${this.boundPort}`, error: summarizeError(error),
          });
          return;
        }
      } else {
        await this.detachControlPlaneListener();
        if (!current()) return;
        incarnation = this.configManager.getConfigurationIncarnation();
        binding = this.configuredControlPlaneBinding();
        try {
          if (this.serveFactory === Bun.serve) await requirePortAvailable(binding.port, binding.host, 'daemon');
          if (!current()) return;
          // Every watched mutation, including same-value/ABA, retires this candidate.
          if (this.restartCycle.dirty || this.configManager.getConfigurationIncarnation() !== incarnation) continue;
          this.host = binding.host;
          this.port = binding.port;
          this.tlsState = resolveInboundTlsContext(this.configManager, 'controlPlane');
          if (!await this.bindControlPlaneListener(transition, this.tlsState, incarnation)) continue;
        } catch (error) {
          if (!current()) return;
          // A change that arrived while this candidate failed supersedes it.
          if (this.restartCycle.dirty) continue;
          await this.recoverFromFailedRebind(transition, binding, fallback, error);
          return;
        }
      }
      if (!current()) return;
      if (this.configManager.getConfigurationIncarnation() !== incarnation) continue;
      this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
      this.transportEventsHelper.emitTransportConnected();
      if (!this.restartCycle.dirty) return;
    }
  }

  /**
   * The configured binding could not be bound. Serve on the previous address
   * again when possible; otherwise say plainly that the listener is down and
   * keep the watcher armed so a corrected setting rebinds it.
   */
  private async recoverFromFailedRebind(
    transition: object,
    attempted: { readonly host: string; readonly port: number },
    fallback: { readonly host: string; readonly port: number } | null,
    error: unknown,
  ): Promise<void> {
    const reason = summarizeError(error);
    const wanted = `${attempted.host}:${attempted.port}`;
    if (fallback !== null) {
      this.host = fallback.host;
      this.port = fallback.port;
      const tlsState = resolveInboundTlsContext(this.configManager, 'controlPlane');
      this.tlsState = tlsState;
      try {
        if (await this.bindControlPlaneListener(transition, tlsState, this.configManager.getConfigurationIncarnation())) {
          logger.error('DaemonServer: the new control-plane binding could not be bound; still serving on the previous address', {
            wanted, serving: `${this.host}:${this.boundPort}`, error: reason,
          });
          this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
          this.transportEventsHelper.emitTransportConnected();
          return;
        }
      } catch (restoreError) {
        logger.error('DaemonServer: the previous control-plane address could not be bound again', { error: summarizeError(restoreError) });
      }
      if (this.listenerTransition !== transition || this.tornDown || this.restartCycle.closed) return;
    }
    this.tlsState = null;
    this.restartCycle.setDown(true);
    logger.error('DaemonServer: no control-plane listener is bound after a binding change; correct controlPlane.host/port/hostMode to rebind', {
      wanted, error: reason,
    });
    this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
    this.transportEventsHelper.emitTransportTerminalFailure(`control-plane listener could not bind ${wanted}: ${reason}`);
  }

  /**
   * Permanently fence config restart and native startup admission. Cancelled
   * native reservations remain owned through waitForRestart(). Hosts call this
   * synchronously before draining consumers, then await and stop resources.
   */
  fenceRestartAdmission(): void {
    this.restartCycle.fence();
    this.externalStopEpoch++;
    this._configWatchUnsub?.();
    this._configWatchUnsub = null;
    this.lifecycle?.beginStopping(false);
  }

  /**
   * Wait for admitted startup, rollback and config-driven restart work.
   * Failed startup remains fail-fast; owners await this barrier before stopping
   * borrowed dependencies. Rejected operations retain fixed diagnostic labels.
   */
  async waitForRestart(): Promise<void> {
    // Loop also includes work admitted by a failed/chained restart or rollback.
    let restartFailed = false;
    while (this.restartCycle.pending || startupDrains.get(this)?.pending.size) {
      const pending = [...(startupDrains.get(this)?.pending ?? [])];
      const restart = this.restartCycle.pending;
      // Pending startup observations never reject; their fixed failures are
      // retained separately. A restart failure must not bypass their drain.
      if (restart) pending.push(restart.catch(() => { restartFailed = true; }));
      await Promise.all(pending);
    }
    const failures: unknown[] = [...(startupDrains.get(this)?.failures ?? [])]
      .map((label) => new Error(`Daemon ${label} startup operation failed`));
    if (restartFailed) failures.push(new Error('Daemon config restart failed'));
    if (this.restartCycle.closed) {
      try { await this.lifecycle?.drainHandovers(false); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Daemon startup drain failed');
  }

  async stop(): Promise<void> {
    await this.stopRuntime(false);
  }

  private stopRuntime(forHandover: boolean): Promise<void> {
    if (!forHandover) this.externalStopEpoch++;
    if (this.stoppingRuntime) {
      // A handover's own close must not wait on an external close that is
      // itself draining that handover. Preserve the lifecycle's existing
      // forHandover bypass while ordinary callers share the teardown drain.
      if (forHandover) return this.performStopRuntime(true);
      this.lifecycle?.beginStopping(false);
      return this.stoppingRuntime.then(() => this.lifecycle?.drainHandovers(false));
    }
    const stopped = Promise.withResolvers<void>();
    this.stoppingRuntime = stopped.promise;
    // Invoke synchronously: settings retirement and proposal admission closure
    // still precede re-entrant callbacks and the first teardown await.
    void this.performStopRuntime(forHandover).finally(() => this.workProposals.flush()).then(() => {
      this.stoppingRuntime = null;
      stopped.resolve();
    }, (error: unknown) => {
      this.stoppingRuntime = null;
      stopped.reject(error);
    });
    return stopped.promise;
  }

  private async performStopRuntime(forHandover: boolean): Promise<void> {
    const alreadyTornDown = this.tornDown;
    // Both public and update/rollback stops retire SETTINGS before synchronous
    // abort callbacks can re-enter enable() and mint a new serving lifetime.
    this.settingsLifetime = null;
    this.listenerTransition = {};
    this.restartCycle.reset();
    this.workProposals.dispose();
    this.tornDown = true;
    try {
      this.lifecycle?.beginStopping(forHandover);
    } catch (error) {
      // No resource teardown has begun. Preserve the caller's ability to retry
      // cleanup while the retired SETTINGS lifetime remains closed.
      this.tornDown = alreadyTornDown;
      throw error;
    }
    if (alreadyTornDown) {
      await this.workProposals.flush();
      await this.listenerDrain;
      if (forHandover) await this.nativeHandoverDrain?.();
      await this.lifecycle?.drainHandovers(forHandover);
      await this.closeSupplementalResources();
      return;
    }

    const runtimeCloseFailures: unknown[] = [];
    const close = async (action: () => void | Promise<void>): Promise<void> => {
      try { await action(); } catch (error) { runtimeCloseFailures.push(error); }
    };
    this._configWatchUnsub?.();
    this._configWatchUnsub = null;

    // Synchronous pre-stop teardown. Only stop the heartbeat watcher when start() engaged it (registered solely behind `watchers.enabled`); stopWatcher() runs requireFeatureGate('watcher-framework') and THROWS when that gate is off, which would break a clean shutdown of a watchers-disabled daemon. Wrapped as well because stop() is reachable on a daemon whose start() never ran, where the watcher is not registered and stopWatcher() runs its gate check before discovering that, a clean shutdown must not depend on the gate, the same stance start()'s own cleanup path takes.
    if (this.configManager.get('watchers.enabled')) { try { this.watcherRegistry.stopWatcher('daemon-heartbeat', 'daemon-stopped'); } catch (error) { logger.warn('DaemonServer: heartbeat watcher stop failed', { error: summarizeError(error) }); } }
    // The fleet observes triggers. Retire the owned observer before its source.
    // An injected graph remains the composing host's to close, in graph order.
    if (this.ownsRuntimeServices) {
      await close(() => this.runtimeServices.processRegistry.dispose());
      await close(async () => { this.triggerManager?.shutdown(); await this.triggerManager?.join(); });
    }
    this.channelHealth.stop();
    if (this.replyPoller !== null) {
      clearInterval(this.replyPoller);
      this.replyPoller = null;
    }
    this.surfaceDeliveryHelper.abandonPendingSurfaceReplies('the daemon stopped before the reply was delivered');
    this.approvalBrokerUnsubscribe?.();
    this.approvalBrokerUnsubscribe = null;
    this.relayReachability?.stop();
    this.relayReachability = null;
    this.httpRouter.dispose();
    this.controlPlaneHelper.dispose();
    this.surfaceActionHelper.closeDelegatedTelegram();
    this.releaseBrowserJudgmentChats?.();
    this.releaseBrowserJudgmentChats = undefined;
    try { await this.companionChatManager.close(); }
    catch (error) { runtimeCloseFailures.push(error); }
    // Kill-policy sessions end here; survive-policy ones are parked with their transcript.
    if (this.hostedSessions) await close(() => this.hostedSessions!.dispose());

    // Stop services with async teardown in reverse start order (sessionBroker,
    // approvalBroker, channelPolicy, distributedRuntime end when the socket closes).
    // Inbound consumers stop through the cluster gate so a clean shutdown hands the
    // role over in ~1s instead of making the next node wait out the crash timeout.
    await close(() => this.clusterCoordinator.stop('daemon stop'));
    this.automationManager.stop();
    // Tear down the adapter bus subscription and session broker GC interval.
    this.agentTaskAdapterUnsub?.();
    this.agentTaskAdapterUnsub = null;
    await close(() => this.sessionBroker.stop());
    try {
      await this.runtimeServices.powerManager.stop();
    } catch (error) {
      logger.warn('DaemonServer: power-manager stop failed', { error: summarizeError(error) });
      runtimeCloseFailures.push(error);
    }
    await close(this.closeSupplementalResources);
    if (this.ownsRuntimeServices) {
      try { await this.runtimeServices.close(); }
      catch (error) { runtimeCloseFailures.push(error); }
    }
    if (forHandover) {
      try { await this.nativeHandoverDrain?.(); }
      catch (error) { runtimeCloseFailures.push(error); }
    }

    // Disposal closed admission synchronously. Drain the existing serialized
    // write chain before a host can remove or replace this daemon's root.
    await close(() => this.workProposals.flush());

    this.tlsState = null;
    this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port });
    // A daemon that never listened has no disconnect to announce and no "stopped" to claim; everything above was released either way.
    await close(async () => { await this.restartCycle.pending; });
    const hadListener = this.acceptedTransportBinding !== null || this.server !== null || this.listenerDrain !== null;
    await close(() => this.detachControlPlaneListener());
    if (hadListener) { this.transportEventsHelper.emitTransportDisconnected('Daemon server stopped', false); logger.info('DaemonServer stopped'); }
    else logger.debug('DaemonServer released without ever binding a socket');
    this.acceptedTransportBinding = null;
    await close(async () => { await this.lifecycle?.onStopping(false, forHandover, runtimeCloseFailures.length === 0); });
    if (runtimeCloseFailures.length > 0) throw new AggregateError(runtimeCloseFailures, 'Daemon runtime services cleanup failed');
  }

  /** Undelivered daemon receipts for the /status payload (marked delivered once served). */
  collectDaemonReceipts(): readonly { id: string; text: string; at: number }[] {
    return this.lifecycle?.collectReceipts() ?? [];
  }

  /** Undelivered receipts for a `?receipts=peek` read; nothing is marked delivered. */
  peekDaemonReceipts(): readonly { id: string; text: string; at: number }[] {
    return this.lifecycle?.peekReceipts() ?? [];
  }

  /** Marks the receipts a `?receipts=ack` reader says it received as delivered. */
  acknowledgeDaemonReceipts(ids: readonly string[]): void {
    this.lifecycle?.acknowledgeReceipts(ids);
  }

  /**
   * Subscribe to controlPlane binding keys and restart the server on change.
   * Called once from start() after the server is up. Clears itself on stop().
   */
  private _attachControlPlaneConfigWatcher(): void {
    if (this.restartCycle.closed) return;
    if (this._configWatchUnsub) return; // idempotent

    // The controller counts a change as live while bound, mid-cycle (so it
    // reaches the queued-change path) and after a rebind that bound nothing (so
    // a corrected setting can still bring the listener back); never after an
    // intentional stop.
    const watcher = createHostModeRestartWatcher({
      configManager: this.configManager,
      keys: ['controlPlane.hostMode', 'controlPlane.host', 'controlPlane.port'],
      onRestart: () => this.restartCycle.request(),
      getIsRunning: () => this.restartCycle.active,
    });
    this._configWatchUnsub = () => watcher.unsubscribe();
  }

  /**
   * Returns true if the server is currently running.
   */
  get isRunning(): boolean {
    return this.server !== null;
  }

  // --- Auth ---

  private extractAuthToken(req: Request): string {
    return this.controlPlaneHelper.extractAuthToken(req);
  }


  private requireAuthenticatedSession(req: Request): { username: string; roles: readonly string[] } | null {
    return this.controlPlaneHelper.requireAuthenticatedSession(req);
  }

  private requireAdmin(req: Request): Response | null {
    return this.controlPlaneHelper.requireAdmin(req);
  }

  private async requireRemotePeer(req: Request, scope?: string): Promise<DistributedPeerAuth | Response> {
    return await this.controlPlaneHelper.requireRemotePeer(req, scope);
  }

  private getGrantedGatewayScopes(includeWrite: boolean): readonly string[] {
    return this.controlPlaneHelper.getGrantedGatewayScopes(includeWrite);
  }

  private validateGatewayInvocation(
    descriptor: import('../control-plane/index.js').GatewayMethodDescriptor,
    context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly scopes?: readonly string[] | undefined;
      readonly admin?: boolean | undefined;
    },
  ): { status: number; ok: false; body: Record<string, unknown> } | null {
    return this.controlPlaneHelper.validateGatewayInvocation(descriptor, context);
  }

  private tryUpgradeControlPlaneWebSocket(
    req: Request,
    server: UpgradeCapableServer,
  ): Response | 'upgraded' | null {
    return this.controlPlaneHelper.tryUpgradeControlPlaneWebSocket(req, server);
  }

  private handleControlPlaneWebSocketOpen(ws: ControlPlaneWebSocketPeer): void {
    this.controlPlaneHelper.handleControlPlaneWebSocketOpen(ws);
  }

  private async handleControlPlaneWebSocketMessage(
    ws: ControlPlaneWebSocketPeer,
    message: string | Buffer | ArrayBuffer | Uint8Array,
  ): Promise<void> {
    await this.controlPlaneHelper.handleControlPlaneWebSocketMessage(ws, message);
  }

  private handleControlPlaneWebSocketClose(ws: Pick<ControlPlaneWebSocketPeer, 'data'>): void {
    this.controlPlaneHelper.handleControlPlaneWebSocketClose(ws);
  }

  private async invokeWebSocketControlPlaneCall(input: {
    readonly authToken: string;
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, unknown> | undefined;
    readonly body?: unknown | undefined;
    readonly context?: {
      readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | undefined;
      readonly admin?: boolean | undefined;
      readonly scopes?: readonly string[] | undefined;
    };
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    return await this.controlPlaneHelper.invokeWebSocketControlPlaneCall(input);
  }

  private async invokeGatewayMethodCall(input: {
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
  }): Promise<{ status: number; ok: boolean; body: unknown }> {
    return await this.controlPlaneHelper.invokeGatewayMethodCall(input);
  }

  // --- Request handling ---

  private async handleRequest(req: Request): Promise<Response> {
    return await this.httpRouter.handleRequest(req);
  }

  /** The relay reachability controller (null until start). Exposed for surfaces. */
  getRelayReachability(): RelayReachability | null {
    return this.relayReachability;
  }

  private async dispatchApiRoutes(req: Request): Promise<Response | null> {
    return await this.httpRouter.dispatchApiRoutes(req);
  }

  private async parseJsonBody(req: Request): Promise<JsonBody | Response> {
    return await this.httpRouter.parseJsonBody(req);
  }

  private async parseOptionalJsonBody(req: Request): Promise<JsonBody | null | Response> {
    return await this.httpRouter.parseOptionalJsonBody(req);
  }

  private parseJsonText(rawBody: string): JsonBody | Response {
    return this.httpRouter.parseJsonText(rawBody);
  }

  private recordApiResponse(
    req: Request,
    path: string,
    response: Response,
    clientKind:
      | 'web'
      | 'slack'
      | 'discord'
      | 'ntfy'
      | 'webhook'
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
    return this.httpRouter.recordApiResponse(req, path, response, clientKind);
  }
  private async handleApprovalAction(
    approvalId: string,
    action: 'claim' | 'approve' | 'deny' | 'cancel',
    req: Request,
    /** Who pressed the button, when it came from a chat surface whose signature the daemon already verified. */
    interaction?: { readonly surface: string; readonly userId: string } | undefined,
  ): Promise<Response> {
    return handleInteractiveApprovalAction({
      broker: this.approvalBroker,
      parseBody: (request) => this.parseOptionalJsonBody(request),
      actor: (request) => interaction
        ? `${interaction.surface}:${interaction.userId}`
        : this.requireAuthenticatedSession(request)?.username ?? (this.authToken ? 'shared-token' : 'operator'),
      surface: () => interaction?.surface ?? 'web',
      record: (request, path, response) => this.recordApiResponse(request, path, response),
    }, approvalId, action, req);
  }
  private trySpawnAgent(input: Parameters<AgentManager['spawn']>[0], logLabel = 'DaemonServer', sessionId?: string): AgentRecord | Response {
    try {
      const copied = Array.isArray((input as { tools?: readonly string[] }).tools)
        ? {
            ...input,
            tools: [...((input as { tools?: readonly string[] }).tools ?? [])],
          }
        : input;
      // Work started for a third-party channel message runs under that channel's surface authority; local sessions keep the owner's.
      const session = sessionId === undefined ? null : this.sessionBroker.getSession(sessionId);
      const triggerSurface = session?.surfaceKinds.find(isChannelSurfaceKind);
      // The channel's bound model fills the gap when the caller chose none.
      const spawnInput = triggerSurface && session
        ? applyChannelProfileToSpawn(copied, channelProfileForSession(this.sessionBroker, session))
        : copied;
      const record = withTurnSurfaceId(triggerSurface, () => withChannelExecutionMode(this.sessionBroker, sessionId, () => this.agentManager.spawn(spawnInput)));
      this.syncSpawnedAgentTask(record, sessionId);
      // Register the agent with AgentTaskAdapter so bus events can transition its task.
      if (this.agentTaskAdapter) {
        this.agentTaskAdapter.wrapAgent(record.id, record.task, { sessionId: sessionId ?? 'daemon' }, record.id);
      }
      return record;
    } catch (err) {
      const message = summarizeError(err);
      logger.error(`${logLabel}: agent spawn failed`, { error: message });
      // Capacity-reached is backpressure, not a server error, return 429 so
      // Clients can apply the Retry-After hint through their retry policy.
      const isCapacity = typeof message === 'string' && message.includes('capacity reached');
      if (isCapacity) {
        return Response.json(
          {
            code: 'CAPACITY_EXCEEDED',
            error: message,
            category: 'service',
            source: 'runtime',
            recoverable: true,
            hint: 'Wait for the current agent to complete or raise the fleet.maxSize configuration (Maximum fleet size).',
            status: 429,
          },
          { status: 429, headers: { 'Retry-After': '5' } },
        );
      }
      return jsonErrorResponse(err, { status: 500, fallbackMessage: 'Failed to spawn agent' });
    }
  }
  private syncSpawnedAgentTask(record: AgentRecord, sessionId?: string): void {
    this.runtimeDispatch?.syncRuntimeTask({
      id: record.id,
      kind: 'agent',
      title: record.task.length > 80 ? `${record.task.slice(0, 77)}...` : record.task,
      description: record.task,
      status: record.status === 'pending' ? 'queued' : 'running',
      owner: record.id,
      cancellable: true,
      childTaskIds: [],
      queuedAt: record.startedAt,
      startedAt: record.status === 'pending' ? undefined : record.startedAt,
      correlationId: sessionId,
    }, 'daemon.server.agent-spawn');
  }
  private syncFinishedAgentTask(record: AgentRecord): void {
    const status = record.status === 'completed'
      ? 'completed'
      : record.status === 'failed'
        ? 'failed'
        : 'cancelled';
    this.runtimeDispatch?.transitionRuntimeTask(record.id, status, {
      endedAt: record.completedAt ?? Date.now(),
      result: record.fullOutput ?? record.streamingContent,
      error: record.error,
    }, 'daemon.server.agent-finish');
  }
  private surfaceDeliveryEnabled(surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix'): boolean {
    return isSurfaceFeatureGateEnabled(this.runtimeServices.featureFlags, surface)
      && isSurfaceDeliveryEnabled(this.configManager, surface);
  }
  private async pollPendingSurfaceReplies(): Promise<void> {
    await this.surfaceDeliveryHelper.pollPendingSurfaceReplies((record) => this.syncFinishedAgentTask(record));
  }
  private trustProxyEnabled(): boolean {
    return this.tlsState?.trustProxy ?? Boolean(this.configManager.get('controlPlane.trustProxy'));
  }
  private signWebhookPayload(body: string, secret: string): string {
    return this.surfaceDeliveryHelper.signWebhookPayload(body, secret);
  }
}
