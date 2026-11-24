import { requestedEffortOverride } from '../providers/reasoning-effort-surface.js';
import { completeGatewayScopePolicyBootstrap } from '../control-plane/scope-policy-bootstrap.js';
import { markUnservedGatewayMethods } from '../control-plane/method-catalog-route-reconcile.js';
import { channelProfileForSession, withChannelExecutionMode } from '../channel-profiles/install-inbound-intake.js';
import { applyChannelProfileToSpawn } from '../channel-profiles/intake.js';
import { applyAssignedChannelProfile, assignedChannelProfile, spawnModelOpen } from './channel-profile-assignment.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import { channelTurnScope, withTurnSurfaceId } from '../security/turn-boundary.js';
import { releaseDaemonActivityLog, runDaemonBootGuarantees } from './facade-boot-guarantees.js';
import { sayCarriedForwardNow } from '../state/carried-forward.js';
import { logger } from '../utils/logger.js';
import { jsonErrorResponse } from './http/error-response.js';
import { ModelReferenceError } from '../providers/model-id-resolution.js';
import { AgentSpawnInputError } from '../tools/agent/model-routing.js';
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
} from '../channels/index.js';
import { buildDaemonClusterCoordinator, withRestartForPendingGroupAction, type ClusterCoordinator } from './facade-cluster.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentEvent } from '../../events/agents.js';
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
import { ProcessTaskAdapter } from '../runtime/tasks/adapters/process-adapter.js';
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
import { readCompanionTokenValue, replaceCompanionToken } from '../pairing/companion-token.js';
import { publicBaseUrlIsOwnOrigin } from '../pairing/web-origin.js';
import { createAsyncDisposalScope, type AsyncDisposalScope } from '../runtime/async-disposal.js';
import type { McpServerConfig } from '../mcp/config.js';
import { isSurfaceFeatureGateEnabled } from '../runtime/feature-flags/index.js';
import { buildDaemonRelayReachability, relayRequestFactsFrom } from '../relay/daemon-wiring.js';
import { RelayCodeStore } from '../relay/relay-codes.js';
import { join } from 'node:path';
import type { RelayReachability } from '../relay/reachability.js';
import {
  readAutomationReasoningEffort,
  readAutomationWakeMode,
  readExternalContentSource,
  readStringList,
} from './helpers.js';
import type { DaemonConfig, DaemonDangerConfig, PendingSurfaceReply } from './types.js';
import { requirePortAvailable } from './port-check.js';
import { listenerWithinConfiguredHost, resolveHostBinding } from './host-resolver.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';
import { isWildcardHost } from '../config/control-plane-base-url.js';
import { LanHttpsListener, type LanHttpsState } from './lan-https/listener.js';
import { lanAuthorityCertificate } from './lan-https/authority.js';
import { lanHttpsPageResponse } from './lan-https/page.js';
import { lanHttpsOriginOf } from '../pairing/web-origin.js';
import { createHostModeRestartWatcher, RestartController } from './host-mode-watcher.js';
import { configureJudgmentRequestLifetime } from './http/judgment-request-lifetime.js';
import { createJudgmentRuntimeScope, runInJudgmentRuntime } from '../runtime/judgment-runtime-scope.js';
import { configureVoiceRequestLifetime } from './http/voice-request-lifetime.js';
import { bindClientAddress, bindLocalOrigin, isDirectLoopbackRequest, resolveClientAddress } from './client-address.js';
import { readControlPlaneStreamingMode, refuseUnservedListenerRequest } from './http/listener-admission.js';
import type { ServiceCommandRunner } from './service-handover.js';
import { inFlightWorkIds } from '../runtime/fleet/registry.js';
import { recoverGitHubReplies, resolveGitHubToken, type GitHubReplyOperation } from '../adapters/github/index.js';
import { constantTimeEquals } from '../adapters/helpers.js';
import { daemonOperationLog, daemonOperationsPath } from './operations-log.js';
import { existsSync } from 'node:fs';

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
  requestIP?(req: Request): { readonly address: string } | null;
}

type JsonBody = Record<string, unknown>;

/** One connected control-plane websocket, as the three delegators below see it. */
interface ControlPlaneWebSocketPeer { data: ControlPlaneWebSocketData; send(message: string): void }

// --- DaemonServer ---

type StartupOwner = 'session broker' | 'approval broker' | 'channel policy' | 'automation manager' | 'distributed runtime' | 'cluster rollback';
interface StartupDrain { readonly pending: Set<Promise<void>>; readonly failures: Map<StartupOwner, Error>; }
// Per-facade ownership without widening the public declaration surface. A
// fail-fast join cannot retire sibling acquisitions or the first rollback stop.
const startupDrains = new WeakMap<object, StartupDrain>();
/** The client address of a request this daemon makes to itself in process: its own machine. */
const IN_PROCESS_CLIENT_ADDRESS = '127.0.0.1';
function ownStartup(owner: object, label: StartupOwner, action: () => Promise<void>): Promise<void> {
  let drain = startupDrains.get(owner);
  if (!drain) { drain = { pending: new Set(), failures: new Map() }; startupDrains.set(owner, drain); }
  const state = drain;
  // Defer invocation until ownership is recorded, including synchronous throws.
  const result = Promise.resolve().then(action).catch((error: unknown) => {
    // The owner's own sentence names what to repair (a store file, a record id),
    // so it is kept. Only a real Error is read: a thrown non-error may carry
    // getters, and the label alone still names the owner.
    const reason = error instanceof Error ? error.message : 'it threw a value that is not an error';
    const failure = new Error(`Daemon ${label} did not start: ${reason}`, { cause: error });
    state.failures.set(label, failure);
    throw failure;
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
  private owedChannelRepliesResent = false;
  private unservedMethodsMarked = false;
  private nativeStartupHandover: Exclude<ReturnType<DaemonLifecycleRuntime['activateNativeLifecycle']>, void> | undefined;
  private readonly integrationHelpers: IntegrationHelperService;
  private configManager: ConfigManager;
  private authToken: string | null = null;
  private unbindSharedToken: (() => void) | null = null;
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
  /** The opt-in https listener on the local network beside the plain one (lan-https/listener.ts). */
  private readonly lanHttps = new LanHttpsListener({ config: () => this.configManager, secrets: () => this.runtimeServices?.secretsManager });
  private readonly pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
  private readonly controlPlaneHelper: DaemonControlPlaneHelper;
  private readonly surfaceDeliveryHelper: DaemonSurfaceDeliveryHelper;
  private readonly surfaceActionHelper: DaemonSurfaceActionHelper;
  private readonly transportEventsHelper: DaemonTransportEventsHelper;
  private readonly httpRouter: DaemonHttpRouter;
  /** Whether the daemon takes new work (work-admission.ts); the agent spawn asks it. */
  private readonly workAdmission: import('./work-admission.js').DaemonWorkAdmission;
  /** Sweeps channel health and tells the owner over a channel that still works; see facade-channel-health.ts. */
  private readonly channelHealth: import('../channels/index.js').ChannelHealthWatcher;
  /** Ends the subscription that settles channel replies on each agent's terminal event. */
  private replySettlement: (() => void) | null = null;
  /** Lifecycle sidecar: clean-shutdown marker, receipts, hourly auto-update. */
  private lifecycle: DaemonLifecycleRuntime | null = null;
  private readonly companionChatManager: CompanionChatManager;
  private readonly hostedSessions: HostedSessionManager | null;
  private relayReachability: RelayReachability | null = null;
  /** Ends the subscriptions that bring the relay registration in line with relay.enabled, relay.url and the relay-connect flag. */
  private relaySettingsUnsubscribe: (() => void) | null = null;
  /** Ends the warning logged each time telemetry.includeRawPrompts is turned on. */
  private readonly stopTelemetryOptInWarning: () => void;
  /** One relay code per device paired through the relay, listed and revoked like a device token (relay/relay-codes.ts). */
  private relayCodeStore: RelayCodeStore | null = null;
  private get relayCodes(): RelayCodeStore {
    if (this.relayCodeStore) return this.relayCodeStore;
    const store = new RelayCodeStore(join(this.configManager.getControlPlaneConfigDir(), 'relay-codes.json'),
      { authority: this.runtimeServices.authorityRecord });
    // A relay code revoked on the authority record (itself, or with the device it
    // was issued to, here or on another machine of the group) ends the relay
    // connections presenting it at once, as a local revoke does.
    this.stopRelayRevocationWatch = store.onRecordRevocation(() => {
      void this.relayReachability?.closeConnectionsPresenting?.((code) => !store.holds(code), 'relay-code-revoked')
        .catch((error: unknown) => logger.warn('DaemonServer: relay connections of a revoked code could not be closed', { error: summarizeError(error) }));
    });
    return this.relayCodeStore = store;
  }
  private stopRelayRevocationWatch: (() => void) | null = null;
  private agentTaskAdapter: import('../runtime/tasks/adapters/agent-adapter.js').AgentTaskAdapter | null = null;
  private agentTaskAdapterUnsub: (() => void) | null = null;
  /** Detaches the background-process task rows from the process manager. */
  private processTaskAdapterUnsub: (() => void) | null = null;
  private tlsState: ResolvedInboundTlsContext | null = null;
  private approvalBrokerUnsubscribe: (() => void) | null = null;
  /** Stops the surface registry publishing surface changes on the runtime bus; cleared on stop(). */
  private surfaceEventsDetach: (() => void) | null = null;
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
  /**
   * This daemon's judgment scope: its composition, start, requests and
   * embedded submissions run inside it, so its readings keep its own judgment
   * port when another daemon runs in the same process.
   */
  private readonly judgmentRuntime = createJudgmentRuntimeScope();

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
    const resolved = runInJudgmentRuntime(this.judgmentRuntime, () => resolveDaemonFacadeRuntime(config, supplementalOwnership, () => this.authToken));
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
      servingListener: () => {
        const server = this.server;
        if (server === null) return null;
        return { host: server.hostname ?? this.host, port: this.boundPort, scheme: this.boundScheme };
      },
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
    this.workAdmission = collaborators.workAdmission;
    this.stopTelemetryOptInWarning = collaborators.stopTelemetryOptInWarning;
    this.channelHealth = buildDaemonChannelHealthWatcher(resolved, {
      delivery: collaborators.surfaceDeliveryHelper,
      ingressAlarm: collaborators.ingressAlarm,
    });
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
      workAdmission: collaborators.workAdmission,
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
    // A hosted Agent turn's operator tools call this daemon's own routes in
    // process: the same authentication, gate and handlers as over the wire.
    // Such a request comes from this machine, so it is served as one, and the
    // operator credential on it is the `local` credential, as the Agent's is
    // when it runs here.
    this.hostedSessions?.setRequestPath({
      serve: (req) => { bindClientAddress(req, IN_PROCESS_CLIENT_ADDRESS); bindLocalOrigin(req); return this.handleRequest(req); },
      operatorToken: () => this.authToken,
    });
    // Whether this daemon is keeping itself current, asked over the wire
    // rather than read out of a log on the host, see routes/update.ts.
    registerUpdateGatewayMethods(this.runtimeServices.gatewayMethods, this.lifecycle);
    // A join that turned sharing on finishes after a restart: the daemon restarts itself through its service.
    if (config.clusterGroupVerbs) {
      const lifecycle = this.lifecycle;
      this.httpRouter.setClusterGroupVerbs(withRestartForPendingGroupAction(config.clusterGroupVerbs, () => lifecycle.restartThroughService()));
    }
    // Relay reachability read through the SAME controller getRelayReachability()
    // returns, so an in-process surface and a client over the wire cannot
    // disagree about whether this daemon is reachable, see routes/relay.ts.
    registerRelayGatewayMethods(this.runtimeServices.gatewayMethods, () => this.relayReachability, this.relayCodes, (url) => {
      // relay.enabled also backs the relay-connect capability; the settings subscriptions below start the registration.
      const current = String(this.configManager.get('relay.url') ?? '').trim();
      if (url === undefined && current.length === 0) return false;
      if (url !== undefined && url !== current) this.configManager.set('relay.url', url);
      if (this.configManager.get('relay.enabled') !== true) this.configManager.set('relay.enabled', true);
      return true;
    });
    this.httpRouter.setDaemonStatusProviders({
      // Update/crash receipts, and which node currently reads the inbox.
      peekReceipts: (owner) => this.peekDaemonReceipts(owner),
      acknowledgeReceipts: (ids, owner) => this.acknowledgeDaemonReceipts(ids, owner),
      collectClusterStatus: () => this.clusterCoordinator.status(),
      // The artifact's own release version, when this host ships one. Reported
      // beside the platform build rather than instead of it.
      buildVersion: () => this.config.updateArtifact?.version ?? null,
    });

    // Wire AgentTaskAdapter to the RuntimeEventBus so task records reach terminal states on agent finish.
    this.agentTaskAdapter = new AgentTaskAdapter(this.runtimeStore);
    this.agentTaskAdapterUnsub = this.agentTaskAdapter.attachRuntimeBus(this.runtimeBus);
    this.agentTaskAdapter.reconcileOnRestart(); // marks tasks running at startup as aborted after daemon restart
    // Background processes the daemon's turns start are task rows from start to exit.
    this.processTaskAdapterUnsub = new ProcessTaskAdapter(this.runtimeStore, this.runtimeServices.processManager)
      .attach({ sessionId: 'daemon' });

    configureDaemonSessionContinuation({
      sessionBroker: this.sessionBroker,
      trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
      queueSurfaceReplyFromBinding: (binding, input) => this.surfaceDeliveryHelper.queueSurfaceReplyFromBinding(binding, input),
      modelCandidates: () => this.runtimeServices.providerRegistry.listModels(),
      // The continuation reaches the same gate the inbound message did.
      surfaceActionHelper: this.surfaceActionHelper,
      configReader: this.configManager,
      // While the daemon takes no new work a message is not read either: it is read once, after the restart.
      hasFreeAgentSlot: () => this.workAdmission.open && this.agentManager.hasFleetCapacity(),
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
    this.controlPlaneGateway.setServerState({ enabled: true, host: this.host, port: this.port }, this.server !== null);
    return true;
  }

  /**
   * Whether `token` is the operator token this daemon serves now (after a
   * revocation, its replacement). Compared in constant time. The webhook
   * listener asks it only to word a refusal: the listener never accepts it.
   */
  servesOperatorToken(token: string): boolean {
    return this.authToken !== null && token !== '' && constantTimeEquals(this.authToken, token);
  }

  /**
   * Bind this daemon's shared token to the pairing store, so revoking it
   * replaces the value in `<daemon home>/operator-tokens.json`, which the apps
   * on this machine read, and here. Without a daemon home, or with a token the
   * process environment set (it differs from the stored one), nothing can be
   * replaced and a revocation refuses the shared token outright.
   */
  private bindSharedTokenCustody(): void {
    const daemonHomeDir = this.config.daemonHomeDir;
    if (this.unbindSharedToken || !daemonHomeDir) return;
    this.unbindSharedToken = this.runtimeServices.pairingTokens.bindSharedTokenCustody({
      current: () => this.authToken,
      replacementRefusal: () => {
        let stored: string | null;
        try { stored = readCompanionTokenValue(daemonHomeDir); }
        catch (error) { return `the stored operator token could not be read (${summarizeError(error)})`; }
        return this.authToken !== null && stored === this.authToken ? null
          : 'this daemon serves a token set by GOODVIBES_DAEMON_TOKEN, not the one stored in its operator-tokens.json; change that variable and restart the daemon instead';
      },
      replace: (commit) => {
        const replaced = replaceCompanionToken({ daemonHomeDir }, commit);
        this.authToken = replaced.token;
      },
    });
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
   * Disconnect a server connected with {@link DaemonServer.registerMcpServer} and drop its
   * config, so its tools leave the tool surface. Exposed so an in-process
   * embedder stops a server once no session that declared it is left. Leaves
   * the name alone when it now holds another config.
   */
  async unregisterMcpServer(config: McpServerConfig): Promise<boolean> {
    return this.runtimeServices.mcpRegistry.removeServer(config);
  }

  /**
   * The conversation session and the contract an agent works for, from its
   * record (a contract's unit agents carry the session that started the
   * contract). Null for an unknown id. Exposed so an in-process embedder can
   * name which of its sessions an agent's permission ask belongs to.
   */
  agentOwnership(agentId: string): { readonly sessionId: string | undefined; readonly contractId: string | undefined } | null {
    const record = this.agentManager.getStatus(agentId);
    return record ? { sessionId: record.sessionId, contractId: record.contractId } : null;
  }

  /**
   * Start the daemon. Refuses to start if not explicitly enabled.
   */
  async start(): Promise<void | NativeHandover> {
    return runInJudgmentRuntime(this.judgmentRuntime, () => this.startInJudgmentRuntime());
  }

  /** Runs `fn` (and the work it starts) as this daemon's, for judgment readings. */
  inJudgmentRuntime<T>(fn: () => T): T {
    return runInJudgmentRuntime(this.judgmentRuntime, fn);
  }

  private async startInJudgmentRuntime(): Promise<void | NativeHandover> {
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
    // Every handler is registered by now and the shipped host activates the
    // scope policy only after this start, so the catalog says which methods
    // this daemon cannot answer before any client reads it. Once per process:
    // one route probe per handler-less descriptor.
    if (!this.unservedMethodsMarked) {
      this.unservedMethodsMarked = true;
      const unserved = await markUnservedGatewayMethods(this.gatewayMethods);
      if (unserved.length > 0) {
        logger.info('DaemonServer: methods this daemon has no handler or route for are listed as not callable', { methods: unserved });
      }
      if (this.externalStopEpoch !== stopEpoch || this.restartCycle.closed) return;
    }
    // A revoked pairing, shared token or user closes that principal's connections at once.
    this.controlPlaneHelper.watchRevocations();
    // Revoking the shared token replaces the value served here; a revocation recorded
    // while this daemon was not serving is completed now.
    this.bindSharedTokenCustody();
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
    // Surface switches and capability changes are published, so a client of surfaces.list stays current without polling.
    this.surfaceEventsDetach ??= this.surfaceRegistry.attachRuntimeBus(this.runtimeBus);
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

      // Boot precondition: fold the other session stores into the store the broker serves. See daemon-session-store-boot.ts.
      await runDaemonSessionStoreBoot({ sessionBroker: this.sessionBroker, shellPaths: this.runtimeServices.shellPaths });
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
      // Restore what survived; the report states what could not come back.
      // Once per manager: a second init (a start retried after a failure) would stack a second set of bus subscriptions and reset live entries.
      if (this.hostedSessions && !this.hostedSessionsRestored) {
        const restored = await this.hostedSessions.init();
        this.hostedSessionsRestored = true;
        reportHostedSessionRestore(restored);
      }
      // Init the canonical memory store so the daemon is a live single-writer memory service on accept (memory.records.add would else throw "not initialized" on a cold store).
      await this.runtimeServices.memoryStore.init();
      if (this.replySettlement === null) {
        // A channel reply is settled by its agent's terminal event, the same
        // event the reply pipeline and the session broker act on; no timer.
        const settle = (agentId: unknown): void => {
          if (typeof agentId !== 'string') return;
          // After the event's other handlers, so the pipeline has taken up the final first.
          setTimeout(() => {
            void this.surfaceDeliveryHelper.settleFinishedAgent(agentId, (record) => this.syncFinishedAgentTask(record)).catch((error: unknown) => {
              logger.warn('DaemonServer: a finished agent\'s channel reply could not be settled', { agentId, error: summarizeError(error) });
            });
          }, 0);
        };
        const unsubscribes = [
          this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_COMPLETED' }>>('AGENT_COMPLETED', (envelope) => settle(envelope.payload?.agentId)),
          this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_FAILED' }>>('AGENT_FAILED', (envelope) => settle(envelope.payload?.agentId)),
          this.runtimeBus.on<Extract<AgentEvent, { type: 'AGENT_CANCELLED' }>>('AGENT_CANCELLED', (envelope) => settle(envelope.payload?.agentId)),
        ];
        this.replySettlement = () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
      }
      this.surfaceRegistry.syncConfiguredSurfaces();
      // Work the owner agreed to before a restart and that never started starts now.
      if (!this.owedChannelRepliesResent) {
        void this.workProposals.init().then(() => this.surfaceActionHelper.resumeAgreedWork()).then((resumed) => {
          if (resumed > 0) logger.info('DaemonServer: agreed work saved before the restart was started', { resumed });
        }, (error: unknown) => {
          logger.error('DaemonServer: agreed work saved before the restart could not be started', { error: summarizeError(error) });
        });
      }
      // Channel answers whose send the previous process died in are sent now, once per process;
      // GitHub answers owed before the restart are posted (once) or reported.
      if (!this.owedChannelRepliesResent) {
        this.owedChannelRepliesResent = true;
        // Only a home that ever owed one has the log; starting opens nothing otherwise.
        if (existsSync(daemonOperationsPath(this.configManager))) void recoverGitHubReplies({
          operations: daemonOperationLog<GitHubReplyOperation>(this.configManager),
          awaitAgent: async (agentId) => { await this.agentManager.join(agentId); return this.agentManager.getStatus(agentId); },
          resolveToken: () => resolveGitHubToken(this.serviceRegistry),
          // Events taken while the previous process held its update admission start now, once.
          trySpawnAgent: (input, logLabel, sessionId) => this.trySpawnAgent(input, logLabel, sessionId),
        }).catch((error: unknown) => {
          logger.error('DaemonServer: GitHub answers owed before the restart could not be finished', { error: summarizeError(error) });
        });
        void this.surfaceDeliveryHelper.resendOwedChannelReplies().then((resent) => {
          if (resent > 0) logger.info('DaemonServer: channel answers owed before the restart were sent again', { resent });
        }, (error: unknown) => {
          logger.error('DaemonServer: channel answers owed before the restart could not be sent again', { error: summarizeError(error) });
        });
      }
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
      this.controlPlaneGateway.setServerState({ enabled: true, host: this.host, port: this.port }, this.server !== null);
      this._attachControlPlaneConfigWatcher();
      this.transportEventsHelper.emitTransportConnected();
      // Outbound relay reachability (default OFF; gated by relay.enabled + the
      // relay-connect flag + a configured relay.url). Non-blocking so a relay
      // hiccup never blocks daemon startup. The step-up gate judges a relayed
      // call by its catalog method's scopes and binds the assertion to the
      // principal that minted the challenge.
      this.relayReachability = buildDaemonRelayReachability(
        this.configManager,
        this.runtimeServices.secretsManager,
        this.runtimeServices.featureFlags,
        (req) => this.handleRequest(req),
        logger,
        this.runtimeServices.stepUpService.createVerifier(),
        relayRequestFactsFrom(this.gatewayMethods, (req) => this.controlPlaneHelper.authenticateRequest(req)),
        this.runtimeServices.stepUpService,
        this.relayCodes,
      );
      void this.relayReachability.start().catch((error: unknown) =>
        logger.warn('DaemonServer: relay reachability failed to start', { error: summarizeError(error) }),
      );
      // A relay setting or the relay-connect flag changed while the daemon runs:
      // start, stop or restart the registration to match, without a restart.
      const reachability = this.relayReachability;
      const reconcileRelay = (): void => {
        void reachability.reconcile().catch((error: unknown) =>
          logger.warn('DaemonServer: relay reachability could not follow a relay setting change', { error: summarizeError(error) }),
        );
      };
      const relaySettingUnsubscribes = [
        this.configManager.subscribe('relay.enabled', reconcileRelay),
        this.configManager.subscribe('relay.url', reconcileRelay),
        this.runtimeServices.featureFlags.subscribe((flagId) => { if (flagId === 'relay-connect') reconcileRelay(); }),
      ];
      this.relaySettingsUnsubscribe = () => { for (const unsubscribe of relaySettingUnsubscribes) unsubscribe(); };
      logger.info('DaemonServer started', {
        port: this.port,
        host: this.host,
        tlsMode: binding.tlsState.mode,
        scheme: binding.tlsState.scheme,
        trustProxy: this.trustProxyEnabled(),
      });
      if (!this.deferNativeActivationUntilHostReady) return this.completeHostStartup();
    } catch (err) {
      this.settingsLifetime = null;
      const message = summarizeError(err);
      this.replySettlement?.();
      this.replySettlement = null;
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
      this.surfaceEventsDetach?.();
      this.surfaceEventsDetach = null;
      this.surfaceActionHelper.closeDelegatedTelegram();
      this.relaySettingsUnsubscribe?.();
      this.relaySettingsUnsubscribe = null;
      this.relayReachability?.stop();
      this.relayReachability = null;
      await this.detachControlPlaneListener();
      this.tlsState = null;
      this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port }, this.server !== null);
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
    // The host this listener binds. A loopback listener is within every
    // setting, so only a wider one reads the configured host per request.
    const listenerHost = this.host;
    const listenerIsLoopback = isLoopbackHost(listenerHost);
    const outsideConfiguredHost = (): string | undefined => {
      if (listenerIsLoopback) return undefined;
      const configured = self.configuredControlPlaneBinding().host;
      return listenerWithinConfiguredHost(listenerHost, configured) ? undefined : configured;
    };
    this.settingsLifetime = lifetime;
    const withdrawLifetime = (): void => {
      if (this.settingsLifetime !== lifetime) return;
      this.settingsLifetime = replacing && this.server === replacing.server ? replacing.lifetime : null;
    };
    try {
      // One request handler for the listener and, when switched on, the LAN https listener beside it (lan-https/listener.ts).
      const serveWith = (address: { readonly port: number; readonly hostname: string; readonly tls?: Bun.TLSOptions | undefined }) => this.serveFactory({
        port: address.port,
        hostname: address.hostname,
        // Derived from the SSE heartbeat interval so a quiet stream outlives it (Bun's 10s default would not).
        idleTimeout: sseIdleTimeoutSeconds(),
        ...(address.tls ? { tls: address.tls } : {}),
        async fetch(req: Request, server: UpgradeCapableServer): Promise<Response | undefined> {
          configureJudgmentRequestLifetime(req, server);
          configureVoiceRequestLifetime(req, server);
          // Resolved once here; every security event, the sign-in limiter and the audit read this one value.
          const peerAddress = server.requestIP?.(req)?.address;
          const clientAddress = resolveClientAddress(req, peerAddress, { trustProxy: self.trustProxyEnabled() });
          bindClientAddress(req, clientAddress);
          // The operator token is the `local` credential only on a direct connection from this machine.
          if (isDirectLoopbackRequest(req, peerAddress) && !self.publishedElsewhere()) bindLocalOrigin(req);
          // Who is served (controlPlane.enabled) and which live stream (controlPlane.streamMode), before any route.
          const unserved = refuseUnservedListenerRequest(req, {
            servesOtherMachines: self.configManager.get('controlPlane.enabled') === true,
            streamMode: readControlPlaneStreamingMode(self.configManager.get('controlPlane.streamMode')),
            peerAddress,
            clientAddress,
            outsideConfiguredHost: outsideConfiguredHost(),
          });
          if (unserved) return unserved;
          // The page and certificate a phone installs to trust the LAN https listener: public, no sign-in.
          const lanPage = await lanHttpsPageResponse(req, () => self.lanAuthorityCertificate(), () => self.lanHttpsAddress(req));
          if (lanPage) return lanPage;
          const upgrade = self.tryUpgradeControlPlaneWebSocket(req, server);
          if (upgrade === 'upgraded') return;
          if (upgrade) return upgrade;
          return runInJudgmentRuntime(self.judgmentRuntime, () => self.handleRequest(req));
        },
        websocket: {
          open(ws) {
            self.handleControlPlaneWebSocketOpen(ws as unknown as { data: ControlPlaneWebSocketData; send(message: string): void });
          },
          message(ws, message) {
            void runInJudgmentRuntime(self.judgmentRuntime, () => self.handleControlPlaneWebSocketMessage(
              ws as unknown as { data: ControlPlaneWebSocketData; send(message: string): void },
              message,
            ).catch((error: unknown) => {
              logger.warn('DaemonServer: control-plane websocket message failed', {
                error: summarizeError(error),
              });
            }));
          },
          close(ws) {
            self.handleControlPlaneWebSocketClose(ws as unknown as { data: ControlPlaneWebSocketData });
          },
        },
      });
      const server = serveWith({ port: this.port, hostname: this.host, ...(tlsState.tls ? { tls: tlsState.tls } : {}) });
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
      // Each bind (and so each start) makes the LAN https listener's certificate again for the addresses this machine has now.
      await this.lanHttps.sync(listenerHost, (port, tls) => serveWith({ port, hostname: listenerHost, tls }));
      return true;
    } catch (error) {
      withdrawLifetime();
      throw error;
    }
  }

  /** The LAN https authority's public certificate, or null when none was made (lan-https/authority.ts). */
  private async lanAuthorityCertificate(): Promise<string | null> {
    const secrets = this.runtimeServices?.secretsManager;
    return secrets ? lanAuthorityCertificate(secrets) : null;
  }

  /** Where a phone that reached the plain listener at this request's host opens the LAN https listener, while it serves. */
  private lanHttpsAddress(req: Request): string | undefined {
    const state = this.lanHttps.state();
    if (!state.serving || state.port === undefined) return undefined;
    return lanHttpsOriginOf(new URL(req.url).origin, state.port);
  }

  /** What the LAN https listener is doing, for `webui https status` and the pairing posture. */
  lanHttpsState(): LanHttpsState {
    return this.lanHttps.state();
  }

  /** True when the serving listener is on this machine's own address and the new setting serves every interface with the same TLS mode. */
  private wideningToEveryInterface(configuredHost: string): boolean {
    if (this.server === null || !isLoopbackHost(this.host) || !isWildcardHost(configuredHost)) return false;
    try {
      return (this.tlsState?.mode ?? null) === resolveInboundTlsContext(this.configManager, 'controlPlane').mode;
    } catch {
      return false;
    }
  }

  /**
   * Stop listening on the serving listener without cutting what it is
   * answering (wideningToEveryInterface). It is closed for good, connections
   * and all, at the next detach or at stop.
   */
  private retireControlPlaneListener(): void {
    const server = this.server;
    if (server === null) return;
    void this.lanHttps.stop(true);
    this.settingsLifetime = null;
    this.server = null;
    this.tlsState = null;
    this.retiredListeners.add(server);
    void Promise.resolve(server.stop(false)).finally(() => this.retiredListeners.delete(server));
  }

  private readonly retiredListeners = new Set<ReturnType<typeof Bun.serve>>();

  private async detachControlPlaneListener(): Promise<void> {
    for (const retired of this.retiredListeners) void Promise.resolve(retired.stop(true)).catch(() => {});
    this.retiredListeners.clear();
    await this.lanHttps.stop(true);
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
      // A different port is bound BEFORE the serving listener is released, so
      // a binding that cannot be used never takes the API down, but only while
      // the serving listener is itself within the new setting: a listener the
      // setting now refuses (every interface after a change to loopback) is
      // never kept serving while its replacement binds. The same port cannot
      // be bound twice (0.0.0.0:P and 127.0.0.1:P collide), so a host change on
      // the same port, and a TLS or mode change, release first and fall back
      // only to what the new setting allows if the new bind fails.
      const swapFrom = this.server;
      let incarnation = this.configManager.getConfigurationIncarnation();
      let binding = this.configuredControlPlaneBinding();
      // The served port, not the configured one: a listener bound to port 0 serves on an assigned port, and naming that port is the same address.
      const swap = swapFrom !== null && binding.port !== this.boundPort
        && listenerWithinConfiguredHost(this.host, binding.host);
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
        // Widening from this machine to every interface, with the same TLS mode,
        // lets the old listener finish what it is answering: every connection it
        // holds came from this machine, which the new binding still serves. So a
        // request that asked for this (pairing.serve.network, a pairing with
        // serveToNetwork) gets its answer once the new listener is bound, instead
        // of being cut by the rebind it caused. Any narrowing closes every connection at once.
        if (this.wideningToEveryInterface(binding.host)) this.retireControlPlaneListener();
        else await this.detachControlPlaneListener();
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
      this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port }, this.server !== null);
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
      // The previous address only while the new setting still allows it;
      // otherwise this machine alone on the previous port, so the API stays
      // reachable for a correction and nothing the setting refuses is served.
      this.host = listenerWithinConfiguredHost(fallback.host, attempted.host) ? fallback.host : '127.0.0.1';
      this.port = fallback.port;
      const tlsState = resolveInboundTlsContext(this.configManager, 'controlPlane');
      this.tlsState = tlsState;
      try {
        if (await this.bindControlPlaneListener(transition, tlsState, this.configManager.getConfigurationIncarnation())) {
          logger.error('DaemonServer: the new control-plane binding could not be bound; still serving on the previous address', {
            wanted, serving: `${this.host}:${this.boundPort}`, error: reason,
          });
          this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port }, this.server !== null);
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
    this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port }, this.server !== null);
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
    const failures: unknown[] = [...(startupDrains.get(this)?.failures.values() ?? [])];
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
    // Every way the daemon ends comes through here; what this start carried
    // forward is said now, while the receipt store still takes it.
    sayCarriedForwardNow();
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
      if (!forHandover) releaseDaemonActivityLog(this.configManager);
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
    this.replySettlement?.();
    this.replySettlement = null;
    this.surfaceDeliveryHelper.abandonPendingSurfaceReplies('the daemon stopped before the reply was delivered');
    this.approvalBrokerUnsubscribe?.();
    this.approvalBrokerUnsubscribe = null;
    this.surfaceEventsDetach?.();
    this.surfaceEventsDetach = null;
    this.relaySettingsUnsubscribe?.();
    this.relaySettingsUnsubscribe = null;
    this.stopTelemetryOptInWarning();
    this.relayReachability?.stop();
    this.relayReachability = null;
    this.stopRelayRevocationWatch?.();
    this.stopRelayRevocationWatch = null;
    this.relayCodeStore = null;
    await close(() => this.httpRouter.dispose());
    this.controlPlaneHelper.dispose();
    this.unbindSharedToken?.();
    this.unbindSharedToken = null;
    this.surfaceActionHelper.closeDelegatedTelegram();
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
    this.processTaskAdapterUnsub?.();
    this.processTaskAdapterUnsub = null;
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
    this.controlPlaneGateway.setServerState({ enabled: this.enabled, host: this.host, port: this.port }, this.server !== null);
    // A daemon that never listened has no disconnect to announce and no "stopped" to claim; everything above was released either way.
    await close(async () => { await this.restartCycle.pending; });
    const hadListener = this.acceptedTransportBinding !== null || this.server !== null || this.listenerDrain !== null;
    await close(() => this.detachControlPlaneListener());
    if (hadListener) { this.transportEventsHelper.emitTransportDisconnected('Daemon server stopped', false); logger.info('DaemonServer stopped'); }
    else logger.debug('DaemonServer released without ever binding a socket');
    this.acceptedTransportBinding = null;
    await close(async () => { await this.lifecycle?.onStopping(false, forHandover, runtimeCloseFailures.length === 0); });
    // The activity log this daemon named ends with it: a final flush that does
    // not rebuild a directory the host removes after stop. A handover keeps it
    // for the process that takes over.
    if (!forHandover) releaseDaemonActivityLog(this.configManager);
    if (runtimeCloseFailures.length > 0) throw new AggregateError(runtimeCloseFailures, 'Daemon runtime services cleanup failed');
  }

  /** Undelivered receipts for a `?receipts=peek` read; nothing is marked delivered. Owner-only receipts reach an owner-class reader only. */
  peekDaemonReceipts(owner: boolean): readonly { id: string; text: string; at: number }[] {
    return this.lifecycle?.peekReceipts(owner) ?? [];
  }

  /** Marks the receipts a `?receipts=ack` reader says it received as delivered; a non-owner cannot take an owner-only one. */
  acknowledgeDaemonReceipts(ids: readonly string[], owner: boolean): void {
    this.lifecycle?.acknowledgeReceipts(ids, owner);
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
    // The stream mode needs no rebind: the listener reads it per request; clients read it from the gateway state.
    const unsubscribeStreamMode = this.configManager.subscribe('controlPlane.streamMode', (mode) => {
      this.controlPlaneGateway.setServerState({ streamingMode: readControlPlaneStreamingMode(mode) });
    });
    // Switching the LAN https listener on or off, or moving its port, starts, restarts or stops only it.
    const unsubscribeLanHttps = [
      this.configManager.subscribe('controlPlane.lanHttps.enabled', () => { void this.lanHttps.resync(); }),
      this.configManager.subscribe('controlPlane.lanHttps.port', () => { void this.lanHttps.resync(); }),
    ];
    this._configWatchUnsub = () => { watcher.unsubscribe(); unsubscribeStreamMode(); for (const stop of unsubscribeLanHttps) stop(); };
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

  private async invokeGatewayMethodCall(input: {
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
    /** The principal the request was authenticated as where it entered, with its actor; not authenticated again. */
    readonly principal?: Parameters<DaemonControlPlaneHelper['invokeGatewayMethodCall']>[0]['principal'];
  }): Promise<{ status: number; ok: boolean; body: unknown; replayed?: boolean }> {
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
      channelPolicy: this.channelPolicy,
      interaction,
      parseBody: (request) => this.parseOptionalJsonBody(request),
      actor: (request) => interaction
        ? `${interaction.surface}:${interaction.userId}`
        : this.requireAuthenticatedSession(request)?.username ?? (this.authToken ? 'shared-token' : 'operator'),
      surface: () => interaction?.surface ?? 'web',
      record: (request, path, response) => this.recordApiResponse(request, path, response),
    }, approvalId, action, req);
  }
  private trySpawnAgent(input: Parameters<AgentManager['spawn']>[0], logLabel = 'DaemonServer', sessionId?: string): AgentRecord | Response {
    // Every agent the daemon starts for a request, a channel message, agreed work or a follow-up starts here:
    // while it takes no new work (a self-update's restart) the start is refused, and the channel paths keep the message.
    const closed = this.workAdmission.refusalResponse();
    if (closed) return closed;
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
      // The channel's bound model fills the gap when the caller chose none, then the profile
      // channels.routing.assign gave the channel fills what is still open.
      const channelProfiled = triggerSurface && session
        ? applyChannelProfileToSpawn(copied, channelProfileForSession(this.sessionBroker, session))
        : copied;
      const profiled = triggerSurface && session && spawnModelOpen(channelProfiled)
        ? applyAssignedChannelProfile(channelProfiled, assignedChannelProfile({
          resolveProfileId: this.config.resolveChannelProfileId,
          profiles: this.runtimeServices.profileManager,
        }, session))
        : channelProfiled;
      // An agent started for a session belongs to it: that session's listings and reports carry it.
      const spawnInput = sessionId !== undefined && profiled.sessionId === undefined ? { ...profiled, sessionId } : profiled;
      // A guest's turn in scope stays the guest's (its actor), so the agent never runs with the channel's own authority.
      const scope = channelTurnScope(triggerSurface);
      const record = withTurnSurfaceId(scope.surface, () => withChannelExecutionMode(this.sessionBroker, sessionId, () => this.agentManager.spawn(spawnInput)), scope.actor);
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
      // A model or routing the request named that cannot run is the caller's
      // input: a 400 with its code, which a retry rule does not repeat.
      if (err instanceof ModelReferenceError || err instanceof AgentSpawnInputError) {
        return Response.json({ error: err.message, code: err.code, category: 'bad_request', recoverable: false, status: 400 }, { status: 400 });
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
      result: record.fullOutput,
      error: record.error,
    }, 'daemon.server.agent-finish');
  }
  private surfaceDeliveryEnabled(surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix'): boolean {
    return isSurfaceFeatureGateEnabled(this.runtimeServices.featureFlags, surface)
      && isSurfaceDeliveryEnabled(this.configManager, surface);
  }
  /**
   * A public address is configured for this daemon (a tunnel or reverse proxy
   * publishes it). A same-machine proxy can rewrite Host and add no forwarding
   * header, so then no loopback request is taken as the owner's own machine:
   * the apps there pair like any other device. `web.publicBaseUrl` holding the
   * daemon's own derived origin (which the daemon and the apps store for links)
   * publishes nothing. Three in-memory config reads, only for a direct loopback
   * request; the web URL's verdict is computed once per value and listener.
   */
  private publishedElsewhere(): boolean {
    const named = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
    if (named(this.configManager.get('controlPlane.publicBaseUrl')) || named(this.configManager.get('cloudflare.daemonHostname'))) return true;
    const web = this.configManager.get('web.publicBaseUrl');
    return named(web) && !this.webUrlIsOwnOrigin(web);
  }
  private ownWebUrlVerdict: { readonly key: string; readonly own: boolean } | undefined;
  private webUrlIsOwnOrigin(value: string): boolean {
    const bound = { host: this.boundHost, port: this.boundPort, scheme: this.boundScheme };
    const key = `${value}\u0000${bound.scheme}://${bound.host}:${bound.port}`;
    if (this.ownWebUrlVerdict?.key === key) return this.ownWebUrlVerdict.own;
    const verdict = publicBaseUrlIsOwnOrigin(this.configManager, bound);
    if (verdict.settled) this.ownWebUrlVerdict = { key, own: verdict.own };
    return verdict.own;
  }
  /** Whether forwarded client addresses are trusted, read from the setting at each request so a change applies at once. */
  private trustProxyEnabled(): boolean {
    return Boolean(this.configManager.get('controlPlane.trustProxy'));
  }
  private signWebhookPayload(body: string, secret: string): string {
    return this.surfaceDeliveryHelper.signWebhookPayload(body, secret);
  }
}
