import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { SubscriptionManager } from '../config/subscriptions.js';
import type { AutomationDeliveryManager, AutomationManager } from '../automation/index.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '../channels/index.js';
import type { ChannelDeliveryRouter } from '../channels/delivery-router.js';
import type { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker } from '../control-plane/index.js';
import type { StepUpService } from '../relay/step-up-service.js';
import type { WatcherRegistry } from '../watchers/index.js';
import type { TriggerManager } from '../triggers/manager.js';
import type { ArtifactStore } from '../artifacts/index.js';
import type { HomeGraphService, KnowledgeService, KnowledgeStore, ProjectPlanningService, ProjectWorkPlan } from '../knowledge/index.js';
import type { MediaProviderRegistry } from '../media/index.js';
import type { MultimodalService } from '../multimodal/index.js';
import type { AgentFleetOwnership, AgentManager } from '../tools/agent/index.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { ArchetypeLoader } from '../agents/archetypes.js';
import type { PersonalCaptureHolder } from '../personal-capture/index.js';
import type { ProcessManager } from '../tools/shared/process-manager.js';
import type { ModeManager } from '../state/mode-manager.js';
import type { FileUndoManager } from '../state/file-undo.js';
import type { WorkspaceCheckpointManager } from '../workspace/checkpoint/index.js';
import type { MemoryRegistry } from '../state/memory-registry.js';
import type { MemoryStore } from '../state/memory-store.js';
import type { CodeIndexStore } from '../state/code-index-store.js';
import type { CodeIndexReindexScheduler } from '../state/code-index-reindex.js';
import type { StoreSnapshotScheduler } from '../state/store-snapshots.js';
import type { MemoryConsolidationScheduler } from '../state/memory-consolidation-scheduler.js';
import type { MemoryConsolidationRunReceipt } from '../state/index.js';
import type { FileStateCache } from '../state/file-cache.js';
import type { ProjectIndex } from '../state/project-index.js';
import type { FeatureAnnouncementStore } from './feature-announcements.js';
import type { PowerManager, PowerPlatformSeam } from '../power/index.js';
import type { AppendOnlyRetentionScheduler } from './retention/append-only-registry.js';
import { assertConfiguredProjectContextReady } from '../knowledge/index.js';
import { GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, REGULAR_KNOWLEDGE_DB_FILE } from '../knowledge/store-config.js';
import { createRuntimeAcquisitionScope, type RuntimeAcquisitionScope } from './acquisition-scope.js';
import { buildRuntimeGraph } from './runtime-graph.js';
import type { JudgmentServices } from './judgment-services.js';
import type { BrowserJudgmentCapability } from '@goodvibes-jev/engine/daemon-api';
import type { RuntimeEventBus } from './events/index.js';
import type { DomainDispatch, RuntimeStore } from './store/index.js';
import type { DistributedRuntimeManager } from './remote/distributed-runtime-manager.js';
import type { RemoteRunnerRegistry, RemoteSupervisor } from './remote/index.js';
import type { IntegrationHelperService } from './integration/helpers.js';
import type { VoiceProviderRegistry, VoiceService } from '../voice/index.js';
import type { VoiceSetupService } from './voice-setup.js';
import type { WebSearchProviderRegistry, WebSearchService } from '../web-search/index.js';
import type { MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.js';
import type { HookActivityTracker } from '../hooks/activity.js';
import type { HookDispatcher, HookWorkbench } from '../hooks/index.js';
import type { PluginManager } from '../plugins/manager.js';
import type { BookmarkManager } from '../bookmarks/manager.js';
import type { ProfileManager } from '../profiles/manager.js';
import type { SessionManager } from '../sessions/manager.js';
import type { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import type { ApiTokenAuditor } from '../security/token-audit.js';
import type { UserAuthManager } from '../security/user-auth.js';
import type { PairingTokenManager } from '../pairing/pairing-token-store.js';
import type { AcpHostService } from '../acp/host.js';
import type { WebhookNotifier } from '../integrations/webhooks.js';
import type { McpRegistry } from '../mcp/registry.js';
import type { ApprovalDerivedHandlers, ApprovalRaiser } from './permissions/permission-composition.js';
import type { PermissionManager } from '../permissions/manager.js';
import type { WorkspaceTrustManager, WorkspaceTrustLevel } from './workspace-trust.js';
import type { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import type { DeterministicReplayEngine } from '../core/deterministic-replay.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import type { CacheHitTracker } from '../providers/cache-strategy.js';
import type { FavoritesStore } from '../providers/favorites.js';
import type { BenchmarkStore } from '../providers/model-benchmarks.js';
import type { ModelLimitsService } from '../providers/model-limits.js';
import type { UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import type { SessionMemoryStore } from '../core/session-memory.js';
import type { SessionLineageTracker } from '../core/session-lineage.js';
import type { SessionChangeTracker } from '../sessions/change-tracker.js';
import type { ExecutionPlanManager } from '../core/execution-plan.js';
import type { AdaptivePlanner } from '../core/adaptive-planner.js';
import type { IdempotencyStore } from './idempotency/index.js';
import type { OverflowHandler } from '../tools/shared/overflow.js';
import type { ToolLLM } from '../config/tool-llm.js';
import type { RuntimeHealthAggregator } from './health/aggregator.js';
import type { WorktreeRegistry } from './worktree/registry.js';
import type { SandboxSessionRegistry } from './sandbox/session-registry.js';
import type { ShellPathService } from './shell-paths.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import type { ProviderModelDiscoveryMode, ProviderRegistryFactory } from './provider-stack.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import type { KeybindingsManagerLike, PanelManagerLike } from './host-ui.js';
import type { WorkflowServices } from '../tools/workflow/index.js';
import type { ArchivableProcessRegistry } from './fleet/index.js';
import type { ContractRunner } from '../contract/runner.js';
import type { ContractOperatorService } from '../contract/operator-service.js';
import type { SessionSnapshot } from './session-persistence-scope.js';
import type { SessionSurface } from './session-surface.js';
import type { MemorySpineClient } from './memory-spine/index.js';
import type { CacheRegistry, MemoryGovernor, PauseController } from './memory/index.js';
import type { MemoryTripwireReceipt } from './memory/memory-governor.js';

/** Which product a composition is for. Names the graph; the choices below carry the differences. */
export type ProductSurface = 'tui' | 'agent' | 'daemon' | 'embedded';

/** Where a composition's state lives. */
export interface SurfaceRoots {
  /** The `.goodvibes/<surface root>/` segment every surface-scoped store is built under. */
  readonly surfaceRoot: string;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /**
   * The daemon's state root when the host was told one (`--daemon-home`,
   * `GOODVIBES_DAEMON_HOME`, a test harness's temp tree). Threaded into
   * `SecretsManager` so the override actually MOVES the daemon-scoped
   * credential store; see runtime/secrets-composition.ts for what went wrong
   * while it did not. Absent = the machine default.
   */
  readonly daemonHome?: string | undefined;
  /** Override the broker store path (default: home-scoped durable store). */
  readonly sessionStorePath?: string | undefined;
  /** Override the pairing-token store path (default: this surface's control-plane store). */
  readonly pairingTokenPath?: string | undefined;
  /**
   * Where this surface keeps its approvals, watchers and channel policies:
   * `project` (under the working directory, the default) or `home` (one set per
   * user, for a product that runs once per home whatever directory it starts in).
   */
  readonly stateScope?: 'project' | 'home' | undefined;
  /** The activity-log directory the retention sweep prunes; default `<home>/.goodvibes/logs`. */
  readonly logDir?: string | undefined;
  /** The telemetry-ledger directory the retention sweep prunes; default `<home>/.goodvibes/telemetry`. */
  readonly telemetryDir?: string | undefined;
}

/**
 * Where the memory store lives.
 * - `home`: the one cross-surface store under the user's home, what every shipped product opens.
 * - `project`: a per-project file under `<workingDir>/.goodvibes/<surface root>/`; it follows a workspace swap.
 * - `{ path }`: an explicit file.
 */
export type MemoryStoreChoice = 'home' | 'project' | { readonly path: string };

/** The slice of a workspace trust owner an autonomous protocol request reads. */
type WorkspaceTrustConstraint = Pick<WorkspaceTrustManager, 'prepareAutonomousConstraint'>;

/**
 * Whether this product gates asks on a per-workspace trust decision.
 * - `none`: no separate workspace policy; external and autonomous execution decline.
 * - `surface`: one trust owner for the working directory (its decision kept in the user's workspace register), in
 *   front of every ask the graph raises. An undecided workspace asks once through `requestTrustDecision`, by default
 *   an ordinary approval record on this graph's broker that any attached surface can answer. `resolveFor` names the trust
 *   owner for another directory an autonomous protocol process runs in.
 */
export type WorkspaceTrustChoice =
  | 'none'
  | 'surface'
  | {
    readonly kind: 'surface';
    readonly requestTrustDecision?: (() => Promise<WorkspaceTrustLevel>) | undefined;
    readonly resolveFor?: ((manager: WorkspaceTrustManager) => (cwd: string) => WorkspaceTrustConstraint | null | undefined) | undefined;
  };

/** How this product raises an approval ask. */
export interface PermissionHostSeam {
  /**
   * The raiser every permission ask in the graph goes through, built over the graph's own broker. Absent: the
   * broker itself. A client passes one that posts the ask to the daemon while prompting on its own screen. The
   * workspace trust gate, when chosen, wraps whatever this returns.
   */
  readonly raiseApproval?: ((broker: ApprovalBroker, graph: { readonly configManager: ConfigManager; readonly featureFlags: FeatureFlagManager }) => ApprovalRaiser) | undefined;
  /**
   * Whether a person sits at this surface to answer an MCP server's question the call's own facts cannot.
   * Absent or false: such a question is declined and handed back to the agent in the tool result.
   */
  readonly personElicitation?: boolean | undefined;
}

/** What a product's checkpoint choice returns: the manager, and optionally its gate and its teardown. */
export interface WorkspaceCheckpointing {
  readonly manager: WorkspaceCheckpointManager;
  /** Whether a checkpoint may be taken now; absent: always. */
  readonly currentlyAllowed?: (() => boolean) | undefined;
  readonly close?: (() => void | Promise<void>) | undefined;
}

/** What the host process hands the graph: its bus, store, settings and the host-only seams. */
export interface HostSeams {
  /** Trusted installed-data publisher; otherwise use the configured host writer. */
  readonly nativeDataWriter?: import('./native-reader-compatibility.js').NativeDataWriteOwner | undefined;
  /** Explicit absolute ordinary-Bun runtime for contained captured evaluation. */
  readonly capturedBunRuntimeExecutable?: string | undefined;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly featureFlags?: FeatureFlagManager | undefined;
  readonly getConversationTitle?: (() => string | undefined) | undefined;
  readonly panelManager?: PanelManagerLike | undefined;
  readonly keybindingsManager?: KeybindingsManagerLike | undefined;
  /** A local user store the host already built; absent: one under this surface's root. */
  readonly localUserAuthManager?: UserAuthManager | undefined;
  /**
   * Opt-in: build the code index at start whatever `storage.codeIndexEnabled`
   * says. Off by default so constructing the graph never walks the source tree
   * unasked.
   */
  readonly autoStartCodeIndex?: boolean | undefined;
  /**
   * Opt-in: fold host coding-agent sessions the daemon did not spawn into the
   * fleet as read-only observed rows. Off by default; a long-running daemon turns it on.
   */
  readonly observeExternalAgents?: boolean | undefined;
  /** Host power seam for sleep ownership; absent: a non-spawning unavailable seam. A long-running host passes createHostPowerSeam(). */
  readonly powerSeam?: PowerPlatformSeam | undefined;
  /** How the provider registry is constructed (a launch-tolerant one for a product that must start without credentials). */
  readonly providerRegistryFactory?: ProviderRegistryFactory | undefined;
  /** `skip` for a composition that will not outlive model discovery's unawaited write. Default: `run`. */
  readonly modelDiscovery?: ProviderModelDiscoveryMode | undefined;
  /** Agents this process owns beyond its agent runs (native work, hosted floors); they count against `fleet.maxSize`. */
  readonly additionalFleetOwnership?: (() => readonly AgentFleetOwnership[]) | undefined;
  /** The running session, exempt from crash-residue reaping. */
  readonly currentSessionId?: (() => string | null) | undefined;
  /** Fetch the wake-word model at start and keep its recovery sweep running. Off for one-shot commands and tests. */
  readonly provisionWakeModelsAtBoot?: boolean | undefined;
  /** Whether outbound notifications carry metadata only; absent: `behavior.notificationsMetadataOnly`. */
  readonly notificationsMetadataOnly?: (() => boolean) | undefined;
  /** What happens at the memory tripwire instead of exiting; a terminal keeps running and warns. */
  readonly tripwireExit?: ((receipt: MemoryTripwireReceipt) => void) | undefined;
  /** The memory registry consolidation writes through; a client consolidates only while no daemon owns the store. */
  readonly consolidationTarget?: ((registry: MemoryRegistry, spine: MemorySpineClient) => MemoryRegistry) | undefined;
  /** Whether this process runs scheduled routines now (wake catch-up runs them only then). Default: always. */
  readonly runsRoutines?: ((automation: AutomationManager) => boolean) | undefined;
  /** This product's checkpoint manager; absent: one scoped to the surface, initialised now. */
  readonly workspaceCheckpoints?: ((input: {
    readonly workspaceRoot: string;
    readonly surface: SessionSurface;
    readonly runtimeBus: RuntimeEventBus;
    readonly configManager: ConfigManager;
    readonly shellPaths: ShellPathService;
  }) => WorkspaceCheckpointing) | undefined;
  /** This product's worktree register; absent: the one register shared by every surface over the working directory. */
  readonly worktreeRegistry?: ((workingDirectory: string) => WorktreeRegistry) | undefined;
  /**
   * How many sessions this process is running a turn for, the idle gate of memory consolidation.
   * Absent: the session broker's busy count, right where the broker is the register of the sessions run here.
   */
  readonly busySessionCount?: (() => number) | undefined;
  /** Where a consolidation run's receipt goes; absent: the attach-time notice queue every surface drains. */
  readonly onConsolidationReceipt?: ((receipt: MemoryConsolidationRunReceipt) => void) | undefined;
}

/**
 * One product's composition: the differences between the products, stated as inputs to the one graph.
 * `extras` adds what only this product has, built over the finished base graph in the graph's own disposal
 * scope; it may replace members (wrap `close`/`dispose` of the base to run teardown before the base's).
 */
export interface ProductComposition<X extends object = Record<never, never>> {
  readonly surface: ProductSurface;
  readonly roots: SurfaceRoots;
  readonly memoryStore: MemoryStoreChoice;
  readonly workspaceTrust: WorkspaceTrustChoice;
  readonly permissionHost: PermissionHostSeam;
  readonly hostSeams: HostSeams;
  /** Who registers the built-in gateway verbs: `platform` here, `product` in its own composition. Default `platform`. */
  readonly gatewayVerbs?: 'platform' | 'product' | undefined;
  /** `run` supervises triggers in this process; `host` leaves them to the daemon. Default `run`. */
  readonly triggers?: 'run' | 'host' | undefined;
  /** Who runs a shared session's follow-up: `platform` spawns an agent, `product` installs its own. Default `platform`. */
  readonly continuationRunner?: 'platform' | 'product' | undefined;
  /** `broker` collects a stale task-graph record whose session the broker does not know; `never` keeps all. Default `broker`. */
  readonly taskGraphReaping?: 'broker' | 'never' | undefined;
  /** Whether agents get the `profile` tool over the owner-profile store the gateway fills. Default true. */
  readonly profileCapture?: boolean | undefined;
  /** The surface a job created here is attributed to. Default: the surface root. */
  readonly automationSurfaceKind?: AutomationSurfaceKind | undefined;
  /** `platform` resumes contracts left on disk once the graph is up; `product` resumes them itself, later in its boot. Default `platform`. */
  readonly contractRecovery?: 'platform' | 'product' | undefined;
  /**
   * Which store holds the project's knowledge and plan. `wiki` (default): the project wiki, beside the
   * agent's own knowledge and the home graph. `agent`: the agent's own knowledge store; there is no wiki
   * store and `knowledgeService` is the agent's.
   */
  readonly knowledge?: 'wiki' | 'agent' | undefined;
  /**
   * `claim` makes this graph the single live writer of `<home>/.goodvibes/<surface root>/`: a second
   * process composing over the same home is refused with the holder's pid. For a product that runs once
   * per home. Default `off`.
   */
  readonly homeSingleWriter?: 'claim' | 'off' | undefined;
  /** `withhold` keeps the agent manager from the hook dispatcher, so a `type: 'agent'` hook spawns nothing. Default `attach`. */
  readonly hookAgentRuns?: 'attach' | 'withhold' | undefined;
  /**
   * `open` (default) opens the repo code index at start and gives it to agents' tools and the fleet.
   * `on-demand` opens it only when something reads `codeIndexStore`, for a product whose agents do not
   * search the source tree; its tools and fleet then carry no code index.
   */
  readonly codeIndex?: 'open' | 'on-demand' | undefined;
  /**
   * `open` (default) opens the pairing-token store at start and audits it. `on-demand` opens it only when
   * something reads `pairingTokens`, for a product that serves no listener a paired device reaches.
   */
  readonly pairingTokens?: 'open' | 'on-demand' | undefined;
  extras?(base: ComposedRuntimeServices, scope: RuntimeAcquisitionScope): X;
}

/** The embedded graph's options: roots and host seams in one flat object (see createRuntimeServices). */
export interface RuntimeServicesOptions extends SurfaceRoots, HostSeams {}

export interface RuntimeServices {
  /** Trusted installed-data publisher; absent for non-native embedders. */
  readonly nativeDataWriter?: import('./native-reader-compatibility.js').NativeDataWriteOwner | undefined;
  /** The actual recorded autonomous host, borrowed by authenticated native HTTP writes. */
  readonly nativeMutationHost?: import('../permissions/external-request.js').ExternalPermissionHost | undefined;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /**
   * The `.goodvibes/<surface root>/` segment this composition's own state lives
   * under. Already returned by createRuntimeServices; declaring it here is what
   * lets a consumer ask for it instead of deriving a second one, the omission
   * that produced the unscoped pre-split control-plane store.
   */
  readonly surfaceRoot: string;
  /** The workspace trust owner every ask in this graph passes; absent when the product composed without one. */
  readonly workspaceTrustManager?: WorkspaceTrustManager | undefined;
  /** The permission manager background and hosted runs ask through, behind the trust gate when there is one. */
  readonly permissionManager?: PermissionManager | undefined;
  /** platform-owned memory governance: samples RSS/heap, sheds caches, pauses jobs, trips on leaks. */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can observe and shrink. */
  readonly cacheRegistry: CacheRegistry;
  /** Backpressure seam the governor drives to pause/resume deferrable background jobs. */
  readonly pauseController: PauseController;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  readonly panelManager: PanelManagerLike;
  readonly keybindingsManager: KeybindingsManagerLike;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  /**
   * The trigger family's supervisor (stream watchers, model-free condition
   * checks, on-exit process triggers). This factory always constructs one, and
   * it does no work while `watchers.triggers.enabled` is false.
   *
   * OPTIONAL because hosts hand-compose RuntimeServices: goodvibes-agent builds
   * its own object literal, and a required field here turned "this host has no
   * trigger family" into a TypeError on daemon shutdown. Absence must mean no
   * triggers, never a crash, the same contract the fleet registry's
   * `triggerSupervisor` dep already honours.
   */
  readonly triggerManager?: TriggerManager | undefined;
  readonly approvalBroker: ApprovalBroker;
  /** The daemon's owner inbox (questions, claims, purchase windows, queued actions over this broker); set by the daemon composition. */
  readonly ownerInbox?: import('../control-plane/owner-inbox.js').OwnerInbox | undefined;
  readonly userPermissionRuleStore: UserPermissionRuleStore; // durable user-origin permission rules (remembered approvals); permissions.rules.* surface
  readonly sessionBroker: SharedSessionBroker;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /** The installed judgment port and the state root's decision log. */
  readonly judgment: JudgmentServices;
  /** Optional borrowed browser transport capability; its host retains async lifecycle ownership. */
  readonly browserJudgment?: BrowserJudgmentCapability | undefined;
  /** Repo code index: schema-initialized eagerly; the build is never auto-triggered here (would walk arbitrary workingDirectories incl. test fixtures). */
  readonly codeIndexStore: CodeIndexStore;
  /** Tool-site incremental reindex scheduler (bound to codeIndexStore). */
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler;
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (same lifecycle posture as processRegistry, hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  /** Periodic re-sweep of every registered append-only store (startup alone never prunes a daemon that stays up for weeks); unref'd timers, stop() on teardown. */
  readonly appendOnlyRetentionScheduler: AppendOnlyRetentionScheduler;
  /** Idle+schedule memory consolidation driver (this runtime is the store's single writer); unref'd timers, stop() on teardown. */
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  /** Sleep ownership: work inhibition, keep-awake toggle, sleep-edge hooks (platform/power). */
  readonly powerManager: PowerManager;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  /** Relay WebAuthn step-up ceremony service (shared by the stepup.* verbs and the relay gate's verifier). */
  readonly stepUpService: StepUpService;
  readonly subscriptionManager: SubscriptionManager;
  /** Per-pairing named revocable operator tokens (device-scoped). */
  readonly pairingTokens: PairingTokenManager;
  readonly localUserAuthManager: UserAuthManager;
  readonly profileManager: ProfileManager;
  readonly bookmarkManager: BookmarkManager;
  readonly sessionManager: SessionManager;
  readonly sessionOrchestration: CrossSessionTaskRegistry;
  readonly hookDispatcher: HookDispatcher;
  readonly hookActivityTracker: HookActivityTracker;
  readonly hookWorkbench: HookWorkbench;
  readonly pluginManager: PluginManager;
  readonly workflow: WorkflowServices;
  readonly voiceProviders: VoiceProviderRegistry;
  readonly voiceService: VoiceService;
  readonly webSearchProviders: WebSearchProviderRegistry;
  readonly webSearchService: WebSearchService;
  readonly mediaProviders: MediaProviderRegistry;
  readonly multimodalService: MultimodalService;
  readonly memoryEmbeddingRegistry: MemoryEmbeddingProviderRegistry;
  readonly channelPolicy: ChannelPolicyManager;
  readonly mcpRegistry: McpRegistry;
  readonly tokenAuditor: ApiTokenAuditor;
  /** Per-domain runtime health, kept current from the runtime event bus; pass it to a diagnostics provider. */
  readonly healthAggregator: RuntimeHealthAggregator;
  readonly worktreeRegistry: WorktreeRegistry;
  readonly sandboxSessionRegistry: SandboxSessionRegistry;
  readonly webhookNotifier: WebhookNotifier;
  readonly replayEngine: DeterministicReplayEngine;
  readonly providerOptimizer: ProviderOptimizer;
  readonly providerCapabilityRegistry: ProviderCapabilityRegistry;
  readonly cacheHitTracker: CacheHitTracker;
  readonly favoritesStore: FavoritesStore;
  readonly benchmarkStore: BenchmarkStore;
  readonly modelLimitsService: ModelLimitsService;
  readonly providerRegistry: ProviderRegistry;
  readonly toolLLM: ToolLLM;
  readonly distributedRuntime: DistributedRuntimeManager;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly adaptivePlanner: AdaptivePlanner;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  /** Settable holder for the context_accounting tool's session source; an interactive consumer binds its Orchestrator-backed source here. */
  readonly contextAccountingHolder: ContextAccountingHolder;
  /** Settable holder an interactive consumer binds its Orchestrator into, powering sessions.toolCalls.cancel + sessions.queuedMessages.* (same pattern as contextAccountingHolder). */
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
  /** The contract runner (contract-composition.ts): every spawn that is not outside a contract, every turn routed to work, and the fleet's contract tree go through it. */
  readonly contractRunner: ContractRunner;
  /** The contracts operator surface over this runner and, once attached, the hosted-session floors' runners. */
  readonly contractOperator: ContractOperatorService;
  /** A session's snapshot for saving, with the trees of the contracts started in the session filled from the runner. */
  sessionSnapshot(sessionId: string, conversation: Omit<SessionSnapshot, 'contracts'>): SessionSnapshot;
  readonly processManager: ProcessManager;
  /** Live process registry (fleet aggregation). RuntimeServices.dispose() stops its tick; hosts own their process lifetimes. */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  readonly integrationHelpers: IntegrationHelperService;
  /**
   * Stop every poller this graph started (config watch, fleet tick, memory
   * governor, watcher registry, cross-session sweep, orchestration writer, push
   * sweep, knowledge scheduler, retention schedulers) and release their handles.
   *
   * Best-effort, total and idempotent: an owner that throws is logged and the
   * rest still come down. Dispose only a graph you constructed, a DaemonServer
   * handed runtime services by its caller does not own them.
   */
  dispose(): void;
  close(): Promise<void>;
}

export {
  applyProviderOptimizerSettings,
  bindProviderOptimizerConfig,
  readProviderOptimizerSettings,
  type ProviderOptimizerSettings,
} from './provider-optimizer-wiring.js';

/**
 * What composeRuntimeServices returns: RuntimeServices plus the members every
 * composed graph carries, which the narrower RuntimeServices contract (also
 * satisfied by hand-built hosts) leaves optional or out.
 */
export interface ComposedRuntimeServices extends RuntimeServices {
  readonly surface: SessionSurface;
  /** The recorded autonomous host every protocol and native mutation ask in this graph goes through. */
  readonly nativeMutationHost: import('../permissions/external-request.js').ExternalPermissionHost;
  /** The project's wiki store: planning, the work ledger and native intake read and write it. */
  readonly knowledgeStore: KnowledgeStore;
  readonly permissionManager: PermissionManager;
  /** The raiser every ask in this graph goes through, behind the trust gate when there is one. */
  readonly requestApproval: ApprovalRaiser;
  /** Whether a session has a surface attached now (the broker's fresh-participant record). */
  readonly sessionPresence: { isAttached(sessionId: string): boolean };
  readonly projectPlanningProjectId: string;
  /** The project work plan: the planning service's task rows for this project. */
  readonly workPlan: ProjectWorkPlan;
  readonly memorySpine: MemorySpineClient;
  readonly stopDurabilityHousekeeping: () => void;
  readonly stopWakeHousekeeping: () => void;
  readonly voiceSetup: VoiceSetupService;
  readonly acpHost: AcpHostService;
  /** The tool dependencies the agent orchestrator was given; a product extends them and sets them again. */
  readonly agentToolDependencies: Parameters<AgentOrchestrator['setDependencies']>[0];
  /** The late-bound owner-profile capture port the gateway verb groups fill. */
  readonly personalCapture: PersonalCaptureHolder;
  /** The announce-once notices (default-on feature receipts, settings fallbacks) every surface drains on attach. */
  readonly featureAnnouncementStore: FeatureAnnouncementStore;
  /** The file tools' state for the working directory: what was read, and the project's file index. */
  readonly fileCache: FileStateCache;
  readonly projectIndex: ProjectIndex;
  readonly checkpointsCurrentlyAllowed: () => boolean;
  readonly sandboxEscalationHandler: ApprovalDerivedHandlers['sandboxEscalationHandler'];
  readonly execPromptAnswerHandler: ApprovalDerivedHandlers['execPromptAnswerHandler'];
  readonly localhostFetchApproval: ApprovalDerivedHandlers['localhostFetchApproval'];
  readonly onSandboxedRun: ApprovalDerivedHandlers['onSandboxedRun'];
  cancelHostedAgentRuns(): number;
  /**
   * End autonomous asks and start stopping MCP connections and hosted ACP
   * agents. `close` does this first; a host whose own owners drain before the
   * graph's calls it at the start of its shutdown. Idempotent.
   */
  stopAutonomousWork(): void;
}

/**
 * The embedded product's choices: no workspace-trust gate (external and
 * autonomous execution decline), memory in a per-project file, asks raised on
 * the graph's own broker. A test that asserts trust, approval or memory
 * behaviour composes the shipped product's choices instead (`'surface'` trust,
 * `'home'` memory) through composeRuntimeServices.
 */
export function embeddedProductComposition(options: RuntimeServicesOptions): ProductComposition {
  return { surface: 'embedded', roots: options, hostSeams: options, memoryStore: 'project', workspaceTrust: 'none', permissionHost: {} };
}

/** The embedded graph: composeRuntimeServices over embeddedProductComposition. */
export function createRuntimeServices(options: RuntimeServicesOptions): ComposedRuntimeServices {
  return composeRuntimeServices(embeddedProductComposition(options));
}

/**
 * Compose one runtime graph. Every product's differences arrive as the explicit
 * choices on `product`; nothing in the graph branches on which product asked.
 * `extras` runs over the finished graph in the same disposal scope, so what it
 * registers is torn down before the graph's own owners.
 */
export function composeRuntimeServices<X extends object = Record<never, never>>(product: ProductComposition<X>): Omit<ComposedRuntimeServices, keyof X> & X {
  assertConfiguredProjectContextReady(
    product.hostSeams.configManager,
    product.roots.workingDir,
    product.knowledge === 'agent' ? GOODVIBES_AGENT_KNOWLEDGE_DB_FILE : REGULAR_KNOWLEDGE_DB_FILE,
  );
  const scope = createRuntimeAcquisitionScope('RuntimeServices');
  // A constructor that throws part-way would otherwise leave every timer, watch and
  // store handle already started with no owner to stop it.
  let base: ComposedRuntimeServices;
  try {
    base = buildRuntimeGraph(product, scope);
  } catch (error) {
    scope.dispose();
    throw error;
  }
  if (!product.extras) return base as Omit<ComposedRuntimeServices, keyof X> & X;
  try {
    // Merged by descriptor, not by spread: a member a product chose to open on
    // demand stays a getter instead of being opened by the merge.
    const extras = product.extras(base, scope);
    return Object.defineProperties({}, {
      ...Object.getOwnPropertyDescriptors(base),
      ...Object.getOwnPropertyDescriptors(extras),
    }) as Omit<ComposedRuntimeServices, keyof X> & X;
  } catch (error) {
    base.dispose();
    throw error;
  }
}
