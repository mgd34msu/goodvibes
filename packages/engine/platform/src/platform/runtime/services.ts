import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import { createRuntimeSecretsManager } from './secrets-composition.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { SubscriptionManager, sharedSubscriptionsPath } from '../config/subscriptions.js';
import { AutomationDeliveryManager, AutomationManager, AutomationRouteStore, createAutomationAgentControls } from '../automation/index.js';
import { ChannelPluginRegistry, ChannelPolicyManager, RouteBindingManager, SurfaceRegistry } from '../channels/index.js';
import { ChannelDeliveryRouter } from '../channels/delivery-router.js';
import { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker, registerGatewayVerbGroups, registerNativeAutomationGatewayMethods, controlPlaneStorePath } from '../control-plane/index.js';
import { StepUpService } from '../relay/step-up-service.js';
import { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS } from '../control-plane/session-broker-sessions.js';
import { buildContinuationSpawnInput } from './continuation-spawn.js';
import { WatcherRegistry } from '../watchers/index.js';
import { TriggerManager } from '../triggers/manager.js';
import { createBunStreamHost, createProcessManagerTriggerHost, createTriggerActionExecutor } from '../triggers/hosts.js';
import { ArtifactStore } from '../artifacts/index.js';
import {
  HomeGraphService,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  assertConfiguredProjectContextReady,
  createConfiguredPlanningStore,
  configureKnowledgeArtifactReferences,
  createProviderBackedKnowledgeSemanticLlm,
  createWebKnowledgeGapRepairer,
} from '../knowledge/index.js';
import {
  GOODVIBES_AGENT_KNOWLEDGE_DB_FILE,
  HOME_GRAPH_KNOWLEDGE_DB_FILE,
  REGULAR_KNOWLEDGE_DB_FILE,
} from '../knowledge/store-config.js';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '../media/index.js';
import { MultimodalService } from '../multimodal/index.js';
import { cancelAllAgentRuns, type AgentManager } from '../tools/agent/index.js';
import type { AgentMessageBus } from '../agents/message-bus.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import type { ArchetypeLoader } from '../agents/archetypes.js';
import { PersonalCaptureHolder } from '../personal-capture/index.js';
import { ProcessManager } from '../tools/shared/process-manager.js';
import { ModeManager } from '../state/mode-manager.js';
import { FileUndoManager } from '../state/file-undo.js';
import { WorkspaceCheckpointManager } from '../workspace/checkpoint/index.js';
import { MemoryRegistry } from '../state/memory-registry.js';
import { MemoryStore } from '../state/memory-store.js';
import { CodeIndexStore } from '../state/code-index-store.js';
import { CodeIndexReindexScheduler } from '../state/code-index-reindex.js';
import { StoreSnapshotScheduler } from '../state/store-snapshots.js';
import { MemoryConsolidationScheduler } from '../state/memory-consolidation-scheduler.js';
import { PowerManager, wireRuntimePower, createUnavailablePowerSeam, type PowerPlatformSeam } from '../power/index.js';
import { emitProviderVoiceUsage } from './emitters/providers.js';
import { AppendOnlyRetentionScheduler, runStartupAppendOnlySweep } from './retention/append-only-registry.js';
import { createTokenAuditBusEmitter } from './token-audit-events.js';
import { createAsyncDisposalScope, createRuntimeStopRequests, registerRuntimePollers, type AsyncDisposalScope } from './disposal.js';
import { composeJudgment, type JudgmentServices } from './judgment-services.js';
import type { BrowserJudgmentCapability } from '@goodvibes-jev/engine/daemon-api';
import type { RuntimeEventBus } from './events/index.js';
import { createDomainDispatch } from './store/index.js';
import type { DomainDispatch, RuntimeStore } from './store/index.js';
import { DistributedRuntimeManager } from './remote/distributed-runtime-manager.js';
import { RemoteRunnerRegistry, RemoteSupervisor } from './remote/index.js';
import { IntegrationHelperService } from './integration/helpers.js';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '../voice/index.js';
import { createVoiceSetupService } from './voice-setup.js';
import { WebSearchProviderRegistry, WebSearchService } from '../web-search/index.js';
import { createConfiguredFetchDeps } from '../tools/fetch/index.js';
import type { LocalhostFetchApproval } from './permissions/localhost-fetch-approval.js';
import { MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.js';
import { HookActivityTracker } from '../hooks/activity.js';
import { HookDispatcher, createHookWorkbench, type HookWorkbench } from '../hooks/index.js';
import { PluginManager } from '../plugins/manager.js';
import { BookmarkManager } from '../bookmarks/manager.js';
import { ProfileManager } from '../profiles/manager.js';
import { SessionManager } from '../sessions/manager.js';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import { ApiTokenAuditor } from '../security/token-audit.js';
import { startPairingTokenAudit } from './pairing-token-audit.js';
import { UserAuthManager } from '../security/user-auth.js';
import { PairingTokenManager } from '../pairing/pairing-token-store.js';
import { AcpHostService } from '../acp/host.js';
import { WebhookNotifier } from '../integrations/webhooks.js';
import { McpRegistry } from '../mcp/registry.js';
import { createMcpAutonomousElicitationHandler } from '../mcp/elicitation-autonomous.js';
import {
  createApprovalDerivedHandlers,
  createBrokeredPermissionManager,
  createPolicyRuntimeState,
  createUserPermissionRuleStore,
  type ApprovalRaiser,
} from './permissions/permission-composition.js';
import type { PermissionManager } from '../permissions/manager.js';
import { resolveCanonicalMemoryDbPath } from '../state/canonical-memory.js';
import { WorkspaceTrustManager, type WorkspaceTrustLevel } from './workspace-trust.js';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser } from './workspace-trust-approval.js';
import {
  FeatureAnnouncementStore,
  featureAnnouncementsPath,
} from './feature-announcements.js';
import { ContextAccountingHolder } from '../tools/context-accounting/index.js';
import { DeterministicReplayEngine } from '../core/deterministic-replay.js';
import type { ProviderOptimizer } from '../providers/optimizer.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { ProviderCapabilityRegistry } from '../providers/capabilities.js';
import type { CacheHitTracker } from '../providers/cache-strategy.js';
import type { FavoritesStore } from '../providers/favorites.js';
import type { BenchmarkStore } from '../providers/model-benchmarks.js';
import type { ModelLimitsService } from '../providers/model-limits.js';
import type { UserPermissionRuleStore } from '../permissions/user-rule-store.js';
import { buildPricingSeams } from './cost/pricing-seams.js';
import { SessionMemoryStore } from '../core/session-memory.js';
import { SessionLineageTracker } from '../core/session-lineage.js';
import { SessionChangeTracker } from '../sessions/change-tracker.js';
import { ExecutionPlanManager } from '../core/execution-plan.js';
import { AdaptivePlanner } from '../core/adaptive-planner.js';
import { FileStateCache } from '../state/file-cache.js';
import { FileWatcher } from '../state/file-watcher.js';
import { ProjectIndex } from '../state/project-index.js';
import { IdempotencyStore } from './idempotency/index.js';
import { OverflowHandler } from '../tools/shared/overflow.js';
import type { ToolLLM } from '../config/tool-llm.js';
import { ComponentHealthMonitor } from './perf/component-health-monitor.js';
import { createWiredHealthSystem } from './health/index.js';
import { bindHealthDomainEvents } from './health/domain-events.js';
import type { RuntimeHealthAggregator } from './health/aggregator.js';
import { WorktreeRegistry } from './worktree/registry.js';
import { SandboxSessionRegistry } from './sandbox/session-registry.js';
import { createShellPathService, type ShellPathService } from './shell-paths.js';
import type { FeatureFlagManager } from './feature-flags/index.js';
import { disposeRuntimeFeatureFlags, resolveRuntimeFeatureFlags } from './feature-flag-composition.js';
import { attachComposedInstrumentation, releaseComposedTelemetry } from './telemetry/index.js';
import { createProviderStack } from './provider-stack.js';
import { createAgentGraph } from './agent-graph.js';
import type { PolicyRuntimeState } from './permissions/policy-runtime.js';
import { bindPermissionModeChangeEvent } from '../permissions/mode-change-emitter.js';
import { requireSurfaceRoot } from './surface-root.js';
import {
  createNoopKeybindingsManager,
  createNoopPanelManager,
  type KeybindingsManagerLike,
  type PanelManagerLike,
} from './host-ui.js';
import {
  createWorkflowServices,
  type WorkflowServices,
} from '../tools/workflow/index.js';
import { createProcessRegistry, withFleetArchive, attachFleetEmitBridge, type ArchivableProcessRegistry } from './fleet/index.js';
import { attachConfigEmitBridge } from './config/index.js';
import { ObservedAgentSource } from './fleet/observed/source.js';
import type { ContractRunner } from '../contract/runner.js';
import { composeContractRunner, resumeContracts } from './contract-composition.js';
import { createContractOperatorService, type ContractOperatorService } from '../contract/operator-service.js';
import type { SessionSnapshot } from './session-persistence-scope.js';
import { makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
import {
  CacheRegistry,
  PauseController,
  wireDaemonMemoryGovernance,
  type MemoryGovernor,
} from './memory/index.js';

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
 * - `surface`: one trust owner at `<workingDir>/.goodvibes/<surface root>/trust.json`, in front of every ask the
 *   graph raises. An undecided workspace asks once through `requestTrustDecision`, by default an ordinary
 *   approval record on this graph's broker that any attached surface can answer. `resolveFor` names the trust
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
  readonly raiseApproval?: ((broker: ApprovalBroker) => ApprovalRaiser) | undefined;
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
  /**
   * Opt-in: kick off the code index's initial build (Stage A) after
   * construction; fire-and-forget. Off by default so constructing
   * RuntimeServices never runs an unrequested source-tree walk.
   */
  readonly autoStartCodeIndex?: boolean | undefined;
  /**
   * Opt-in: fold host coding-agent sessions the daemon did not spawn into the
   * fleet as read-only observed rows. Off by default; a long-running daemon turns it on.
   */
  readonly observeExternalAgents?: boolean | undefined;
  /** Host power seam for sleep ownership; absent: a non-spawning unavailable seam. A long-running host passes createHostPowerSeam(). */
  readonly powerSeam?: PowerPlatformSeam | undefined;
}

/**
 * One product's composition: the differences between the products, stated as inputs to the one graph.
 * `extras` adds what only this product has, built over the finished base graph; it may replace members but
 * owns the teardown of anything it starts (wrap `close`/`dispose` of the base it was given).
 */
export interface ProductComposition {
  readonly surface: ProductSurface;
  readonly roots: SurfaceRoots;
  readonly memoryStore: MemoryStoreChoice;
  readonly workspaceTrust: WorkspaceTrustChoice;
  readonly permissionHost: PermissionHostSeam;
  readonly hostSeams: HostSeams;
  extras?(base: RuntimeServices): Partial<RuntimeServices>;
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
  readonly componentHealthMonitor: ComponentHealthMonitor;
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
  applyProviderOptimizerConfigMode,
  bindProviderOptimizerFeatureFlag,
} from './provider-optimizer-wiring.js';

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
export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  return composeRuntimeServices(embeddedProductComposition(options));
}

/**
 * Compose one runtime graph. Every product's differences arrive as the explicit
 * choices on `product`; nothing here branches on which product asked.
 */
export function composeRuntimeServices(product: ProductComposition): RuntimeServices {
  assertConfiguredProjectContextReady(product.hostSeams.configManager, product.roots.workingDir, REGULAR_KNOWLEDGE_DB_FILE);
  const disposalScope = createAsyncDisposalScope('RuntimeServices');
  // A constructor that throws part-way would otherwise leave every timer, watch and
  // store handle already started with no owner to stop it.
  let base: RuntimeServices;
  try {
    base = buildRuntimeGraph(product, disposalScope);
  } catch (error) {
    disposalScope.dispose();
    throw error;
  }
  if (!product.extras) return base;
  try {
    return { ...base, ...product.extras(base) };
  } catch (error) {
    base.dispose();
    throw error;
  }
}

function resolveMemoryDbPath(choice: MemoryStoreChoice, roots: { readonly workingDir: string; readonly homeDirectory: string }, surfaceRoot: string): string {
  if (choice === 'home') return resolveCanonicalMemoryDbPath(roots.homeDirectory);
  if (choice === 'project') return projectMemoryDbPath(roots.workingDir, surfaceRoot);
  return choice.path;
}

function projectMemoryDbPath(workingDir: string, surfaceRoot: string): string {
  return join(workingDir, '.goodvibes', surfaceRoot, 'memory.sqlite');
}

function buildRuntimeGraph(product: ProductComposition, disposalScope: AsyncDisposalScope): RuntimeServices {
  const options: RuntimeServicesOptions = { ...product.roots, ...product.hostSeams };
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'RuntimeServicesOptions surfaceRoot');
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  const configManager = options.configManager;
  const featureFlags = resolveRuntimeFeatureFlags({ configManager, featureFlags: options.featureFlags });
  disposalScope.registry.add('feature flag settings bridge', () => disposeRuntimeFeatureFlags(featureFlags));
  // Registered first so it closes last: the tracer sends the spans its exporters still hold after every other teardown has ended its own.
  disposalScope.registry.add('telemetry tracer', () => releaseComposedTelemetry());
  disposalScope.registry.add('telemetry instrumentation', attachComposedInstrumentation(options.runtimeBus));
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  const gatewayMethods = new GatewayMethodCatalog();
  const panelManager = options.panelManager ?? createNoopPanelManager();
  const keybindingsManager = options.keybindingsManager ?? createNoopKeybindingsManager();
  const routeBindings = new RouteBindingManager({
    store: new AutomationRouteStore({ configManager }),
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags,
  });
  const surfaceRegistry = new SurfaceRegistry(configManager, options.runtimeStore, featureFlags);
  const channelPlugins = new ChannelPluginRegistry({ featureFlags });
  surfaceRegistry.attachPluginRegistry(channelPlugins);
  const secretsManager = createRuntimeSecretsManager({
    projectRoot: workingDirectory,
    globalHome: homeDirectory,
    surfaceRoot,
    configManager,
    ...(options.daemonHome === undefined ? {} : { daemonHome: options.daemonHome }),
  });
  // Provider subscriptions (OAuth sessions like the 'openai-subscriber' login)
  // live in the platform's SHARED tier, not this surface's own root: the
  // daemon hosts every conversational turn, and a login completed on another
  // surface (the TUI, the agent) must be visible to it. `legacyPath` is the
  // pre-shared-tier per-surface store this surface used to own; the manager
  // folds any newer records it finds there into the shared store once, at
  // construction, and never writes to or deletes it.
  const subscriptionManager = new SubscriptionManager(sharedSubscriptionsPath(shellPaths), {
    legacyPath: shellPaths.resolveUserPath(surfaceRoot, 'subscriptions.json'),
  });
  const serviceRegistry = new ServiceRegistry({ user: shellPaths.resolveUserPath(surfaceRoot, 'services.json'), project: shellPaths.resolveProjectPath(surfaceRoot, 'services.json') }, {
    secretsManager,
    subscriptionManager,
  });
  // The model stack, one implementation, shared with the pure-client
  // composition (provider-stack.ts): stores, registry, the live credential
  // chain, the tool LLM and the optimizer bound to its flag and config mode.
  const {
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    providerOptimizer,
  } = createProviderStack({
    configManager,
    registerDispose: release => { disposalScope.registry.add('provider model configuration', release); },
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    featureFlags,
    runtimeBus: options.runtimeBus,
    shellPaths,
    surfaceRoot,
  });
  const localUserAuthManager = new UserAuthManager({ bootstrapFilePath: shellPaths.resolveUserPath(surfaceRoot, 'auth-users.json'), bootstrapCredentialPath: shellPaths.resolveUserPath(surfaceRoot, 'auth-bootstrap.txt') });
  // Per-pairing named revocable operator tokens (device-scoped); consulted by the operator-auth path. The cap is read per mint, so a `device.nodes.maxPaired` change applies to the next pairing without a restart.
  const pairingTokens = new PairingTokenManager(controlPlaneStorePath(shellPaths, surfaceRoot, 'pairing-tokens.json'), { maxPaired: () => configManager.get('device.nodes.maxPaired'), nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter() });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath(surfaceRoot, 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(surfaceRoot, 'bookmarks'));
  const sessionManager = new SessionManager(workingDirectory, { surfaceRoot });
  // NOTE: sessionOrchestration is constructed AFTER sessionBroker (below), not
  // here, because its constructor reaps immediately and its owner-existence
  // predicate closes over the broker, building it here would hit a temporal
  // dead zone on the very first sweep.
  const hookActivityTracker = new HookActivityTracker();
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'watchers.json'),
    featureFlags,
    recoveryWindowMinutes: () => Number(configManager.get('watchers.recoveryWindowMinutes')), // read per restore
    resolveHeaderValue: (value) => resolveSecretInput(value, { resolveLocalSecret: (key) => secretsManager.get(key), homeDirectory: secretsManager.getGlobalHome() }),
  });
  watcherRegistry.attachRuntime({ runtimeStore: options.runtimeStore, runtimeBus: options.runtimeBus });
  // The agent graph in its one working order, shared with the pure-client
  // composition (agent-graph.ts), because the two post-construction links
  // (conversation sink, cancellation source) are easy to omit and silent when
  // omitted.
  const { archetypeLoader, agentMessageBus, agentOrchestrator, agentManager } = createAgentGraph({
    capturedBunRuntimeExecutable: options.capturedBunRuntimeExecutable,
    runtimeBus: options.runtimeBus,
    configManager,
    providerRegistry,
    workingDirectory,
  });
  const hookDispatcher = new HookDispatcher({ agentManager, toolLLM, projectRoot: workingDirectory }, hookActivityTracker);
  configManager.attachHookDispatcher(hookDispatcher);
  const hookWorkbench = createHookWorkbench({ hookDispatcher, configManager });
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'control-plane', 'approvals.json'),
  });
  // ONE home-scoped durable session store; project is DATA on each record.
  // `conversationGateConfig` keeps the live-agent handover behind the gate.
  const sessionBroker = new SharedSessionBroker({
    // Surface-SCOPED, like every other store this composition owns. The
    // default here was `resolveUserPath('control-plane', 'sessions.json')`,
    // no surface segment, so a composition that did not pass its own path got
    // the unscoped orphan directory. Same omission as the control-plane stores
    // beside it, same resolver now (control-plane-store-paths.ts).
    storePath: options.sessionStorePath ?? controlPlaneStorePath(shellPaths, surfaceRoot, 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    conversationGateConfig: configManager,
  });
  // Built here, after the broker, so the owner-existence predicate below has a
  // live broker to ask (see the note at sessionManager's construction).
  //
  // The broker is the authoritative register of session identity: every surface
  // that opens a session registers it here, and the task tool now keys its refs
  // on that same runtime session id rather than on a model-supplied argument.
  // Before that binding this predicate could not have been written honestly,
  // the graph was keyed by a free-form tool parameter that defaulted to the
  // literal 'local', which no register could ever resolve.
  //
  // Reaping on a "no" is still not the same as reaping on a certainty, so it is
  // deliberately not the only guard: the reaper additionally requires a record
  // to be older than its ownerless grace floor, and it never applies this
  // predicate to the legacy 'local' namespace at all. That way a broker that is
  // merely late, starting up, mid-reconnect, a session registering in another
  // process, costs nothing, and only a record that is both unowned AND stale
  // is collected.
  const sessionOrchestration = new CrossSessionTaskRegistry(
    shellPaths.resolveProjectPath(surfaceRoot, 'sessions', 'task-graph.json'),
    { sessionExists: (sessionId: string) => sessionBroker.getSession(sessionId) !== null },
  );
  // Created here so it can be handed to the agent tool registry below and
  // filled by registerGatewayVerbGroups further down, which is where the owner
  // profile store and occasions service are actually built.
  const personalCapture = new PersonalCaptureHolder();
  sessionBroker.setContinuationRunner(async ({ task, input, routeBinding }) => {
    const record = agentManager.spawn(buildContinuationSpawnInput(
      { task, input, ...(routeBinding ? { routeBinding } : {}) },
      { configReader: configManager, modelCandidates: providerRegistry.listModels() },
    ));
    return { agentId: record.id };
  });
  const artifactStore = new ArtifactStore({ configManager });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const memoryDbPath = resolveMemoryDbPath(product.memoryStore, options, surfaceRoot);
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  // Registered at construction: the scope unwinds newest-first, so the store closes
  // after every scheduler registered later has stopped.
  disposalScope.registry.add('memory store', () => memoryStore.close());
  const memoryRegistry = new MemoryRegistry(memoryStore);
  const judgment = composeJudgment({ config: configManager, secrets: secretsManager, env: process.env, stateRoot: shellPaths.resolveProjectPath(surfaceRoot), disposal: disposalScope.registry });
  // Repo source-tree code index (Stage A), shares memoryEmbeddingRegistry so
  // code + memory embeddings use one provider and one dimensionality. Schema
  // init only; build is not auto-triggered here (see codeIndexStore doc).
  const codeIndexDbPath = join(workingDirectory, '.goodvibes', surfaceRoot, 'code-index.sqlite');
  // Memory governance seams built EARLY so scheduler gates and the knowledge
  // background job can consult the pause controller before the MemoryGovernor
  // (constructed at the composition tail) drives it.
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];
  // Late-bound admission gate: the expensive entry points (knowledge job runs,
  // ingestion, semantic reindex/self-improve, consolidation, code-index) are
  // constructed before the MemoryGovernor; they capture this closure, and the
  // governor binds into it at the composition tail. Until then everything is
  // admitted (the daemon is still booting).
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const codeIndexStore = new CodeIndexStore(workingDirectory, codeIndexDbPath, memoryEmbeddingRegistry);
  disposalScope.registry.add('code index store', () => codeIndexStore.close());
  // init never rejects. The build starts once the store is open.
  void codeIndexStore.init().then(() => {
    if (options.autoStartCodeIndex) codeIndexStore.scheduleBuild();
  });
  // Stage B: tool-site incremental reindex. Gated on autoStartCodeIndex AND the
  // built-state check inside the scheduler, an unbuilt index is a no-op.
  const codeInjectionSettingEnabled = (): boolean => options.autoStartCodeIndex === true;
  const codeIndexReindexScheduler = new CodeIndexReindexScheduler({
    target: codeIndexStore,
    // The working directory is fixed for the life of the process; a change applies at the next start.
    workingDirectory: () => workingDirectory,
    // Honor governor backpressure: a paused code-index reindex job stops
    // scheduling new work until the governor resumes it, and the critical
    // memory tier refuses new reindex work outright.
    isEnabled: () => codeInjectionSettingEnabled() && !pauseController.isPaused('code-index-reindex') && admitExpensiveWork('code-index reindex').allowed,
    whenResumed: () => pauseController.whenResumed('code-index-reindex'),
  });
  // Daily snapshots of the store that holds primary data, bounded by the retention engine (unref'd timers).
  // The memory vector index and the code index are derived and rebuilt from it and from the tree; they get
  // one copy before a schema migration (store-versioning.ts) and no daily copy.
  const storeSnapshotScheduler = new StoreSnapshotScheduler({
    stores: [{ name: 'memory store', dbPath: memoryDbPath }],
  });
  storeSnapshotScheduler.start();
  // Each timer is registered where it starts so a later construction failure stops it;
  // registerRuntimePollers below names them again, and a second stop is a no-op.
  disposalScope.registry.add('store snapshot scheduler', () => storeSnapshotScheduler.stop());
  // Start-time janitor: one retention pass over every registered append-only
  // store (best-effort). Every root the composition knows is passed, omitting
  // logDir/telemetryDir/homeDirectory would silently skip the activity-log,
  // telemetry-ledger, and recovery-snapshot stores on every sweep.
  const appendOnlyRetentionRoots = {
    workingDirectory,
    surfaceRoot,
    homeDirectory,
    logDir: shellPaths.resolveUserPath('logs'),
    telemetryDir: shellPaths.resolveUserPath('telemetry'),
  };
  const appendOnlyRetentionConfigGet = (k: string): unknown => configManager.get(k as never);
  runStartupAppendOnlySweep(appendOnlyRetentionRoots, appendOnlyRetentionConfigGet);
  // ...and again every few hours for as long as this runtime lives. A daemon
  // that stays up for weeks would otherwise never sweep any of those six
  // stores again after boot, which is precisely the window in which they
  // grow. Unref'd timers; the host that tears a runtime down stop()s it, the
  // same posture as storeSnapshotScheduler above.
  const appendOnlyRetentionScheduler = new AppendOnlyRetentionScheduler({
    roots: appendOnlyRetentionRoots,
    configGet: appendOnlyRetentionConfigGet,
  });
  appendOnlyRetentionScheduler.start();
  disposalScope.registry.add('append-only retention scheduler', () => appendOnlyRetentionScheduler.stop());
  // External config edits apply LIVE through the same subscribe() pipeline an
  // in-process set() uses, a hand-edited settings file needs no restart. The
  // underlying file watchers are unref'd, so this never pins the event loop.
  const stopConfigWatch = configManager.watchConfigFiles(); // handle kept: dropping it is what left a 250ms poll running forever
  disposalScope.registry.add('config file watch', stopConfigWatch);
  // Memory consolidation runs HERE, this runtime is the memory store's single
  // writer. Idle trigger (no busy broker sessions) + slow schedule fallback;
  // reversible outcomes only, receipts retained, learning.consolidation.* tunes it.
  // Announce-once store (constructed HERE, before its first consumer): the
  // consolidation scheduler's run receipts join its delivery queue as notices,
  // and the sandbox containment line is announced through it once per install.
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  const memoryConsolidationScheduler = new MemoryConsolidationScheduler({
    memoryRegistry,
    configSource: configManager,
    // Idle AND not paused by the governor AND admitted at the current memory
    // tier, memory pressure defers consolidation.
    isIdle: () => sessionBroker.countBusySessions() === 0 && !pauseController.isPaused('memory-consolidation') && admitExpensiveWork('memory consolidation').allowed,
    // Attach notice per run that DID something: an platform-composed daemon records
    // what consolidation merged/decayed/proposed without consumer re-wiring.
    onReceipt: (receipt) => {
      const changed = receipt.merged.length + receipt.archived.length + receipt.decayed.length + receipt.proposed.length;
      if (changed === 0) return;
      announcementStore.notify(
        `memory-consolidation:${receipt.runId}`,
        `Memory consolidation ran (${receipt.trigger}): ${receipt.merged.length} merged, ${receipt.decayed.length} decayed, ${receipt.archived.length} archived, ${receipt.proposed.length} proposal${receipt.proposed.length === 1 ? '' : 's'} awaiting review.`,
      );
    },
  });
  memoryConsolidationScheduler.start();
  disposalScope.registry.add('memory consolidation scheduler', () => memoryConsolidationScheduler.stop());
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    secretsManager,
    serviceRegistry,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    routeBindings,
    artifactStore,
    featureFlags,
  });
  const automationManager = new AutomationManager({
    configManager,
    routeBindings,
    sessionBroker,
    defaultSurfaceKind: surfaceRoot as import('../automation/types.js').AutomationSurfaceKind,
    defaultSurfaceId: `surface:${surfaceRoot}`,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
    featureFlags,
    providerRegistry,
    // The run's agent is how a run ends: the manager reads its status to
    // settle the run and stops it to cancel the run or end it at its timeout.
    ...createAutomationAgentControls(agentManager),
  });
  const knowledgeStore = createConfiguredPlanningStore(configManager, REGULAR_KNOWLEDGE_DB_FILE, { nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter(), family: 'wiki' });
  disposalScope.registry.add('knowledge store', () => knowledgeStore.close());
  const agentKnowledgeStore = KnowledgeStore.forFamily({ nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter(), configManager, dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, family: 'agent' });
  disposalScope.registry.add('agent knowledge store', () => agentKnowledgeStore.close());
  const homeGraphKnowledgeStore = KnowledgeStore.forFamily({ nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter(), configManager, dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE, family: 'home-graph' });
  disposalScope.registry.add('home graph knowledge store', () => homeGraphKnowledgeStore.close());
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: configManager.getControlPlaneConfigDir(), stores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore] });
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, {
    maxConcurrent: 1,
  });
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  const knowledgeSemanticService = new KnowledgeSemanticService(knowledgeStore, {
    llm: knowledgeSemanticLlm,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  disposalScope.registry.add('regular knowledge semantic service', () => knowledgeSemanticService.dispose());
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  disposalScope.registry.add('home graph semantic service', () => homeGraphSemanticService.dispose());
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, {
    llm: knowledgeSemanticLlm,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  disposalScope.registry.add('agent knowledge semantic service', () => agentKnowledgeSemanticService.dispose());
  const knowledgeService = new KnowledgeService(knowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    semanticService: knowledgeSemanticService,
    admitExpensiveWork,
  });
  disposalScope.registry.add('knowledge service', () => knowledgeService.dispose());
  knowledgeService.attachRuntimeBus(options.runtimeBus);
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, {
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    admitExpensiveWork,
    semanticService: agentKnowledgeSemanticService,
  });
  disposalScope.registry.add('agent knowledge service', () => agentKnowledgeService.dispose());
  agentKnowledgeService.attachRuntimeBus(options.runtimeBus);
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, {
    semanticService: homeGraphSemanticService,
    admitExpensiveWork,
  });
  const { service: projectPlanningService } = ProjectPlanningService.forConfiguredWorkspace(knowledgeStore, configManager, workingDirectory, {
    waitForStartup: () => knowledgeService.whenReady(),
    runtimeBus: options.runtimeBus,
  });
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, {
    readConfig: (key) => configManager.get(key as never),
    readConfigIncarnation: () => configManager.getConfigurationIncarnation(),
    managedVoiceRoot: shellPaths.resolveUserPath('voice'),
  });
  // Metered voice spend -> attribution ingest; local engines emit nothing.
  const voiceService = new VoiceService(voiceProviders, (usage) => emitProviderVoiceUsage(options.runtimeBus, { sessionId: 'system', traceId: `voice:${Date.now()}`, source: 'voice-service' }, { provider: usage.providerId, modelId: usage.modelId, kind: usage.kind, billableUnits: usage.billableUnits, unit: usage.unit }));
  const webSearchProviders = new WebSearchProviderRegistry({
    env: process.env,
    serviceRegistry,
  });
  // The approval handlers are built further down; a loopback search evidence fetch reads them when it happens.
  let localhostFetchApprovalForSearch: LocalhostFetchApproval | undefined;
  const webSearchService = new WebSearchService(webSearchProviders, createConfiguredFetchDeps({
    serviceRegistry, featureFlags, configManager, localhostFetchApprovalSource: () => localhostFetchApprovalForSearch,
  }));
  knowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: knowledgeService,
  }));
  agentKnowledgeSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: agentKnowledgeService,
  }));
  homeGraphSemanticService.setGapRepairer(createWebKnowledgeGapRepairer({
    searchService: webSearchService,
    ingestService: homeGraphService,
  }));
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const pluginManager = new PluginManager({
    pathOptions: {
      cwd: shellPaths.workingDirectory,
      homeDir: shellPaths.homeDirectory,
    },
    stateFilePath: shellPaths.resolveUserPath(surfaceRoot, 'plugins.json'),
  });
  const workflow = createWorkflowServices({ workingDirectory: shellPaths.workingDirectory });
  disposalScope.registry.add('hook action dispatch', hookDispatcher.setHookActions(workflow.hookActions, featureFlags));
  const channelPolicy = new ChannelPolicyManager({
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'channels', 'policies.json'),
  });
  const distributedRuntime = new DistributedRuntimeManager(shellPaths.resolveProjectPath(surfaceRoot, 'remote', 'distributed-runtime.json'));
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager, workingDirectory);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const mcpRegistry = new McpRegistry({
    hookDispatcher,
    sandboxSessions: sandboxSessionRegistry,
  });
  mcpRegistry.setRuntimeBus(options.runtimeBus);
  mcpRegistry.setSandboxRuntime(configManager, sandboxSessionRegistry);

  const tokenAuditor = new ApiTokenAuditor({
    managed: configManager.get('security.tokenAudit.managed'),
    featureFlags,
    defaultRotationCadenceMs:
      configManager.get('security.tokenAudit.rotationCadenceDays') * 24 * 60 * 60 * 1000,
    defaultRotationWarningThresholdMs:
      configManager.get('security.tokenAudit.rotationWarningDays') * 24 * 60 * 60 * 1000,
  }, { emitter: createTokenAuditBusEmitter(options.runtimeBus) });
  disposalScope.registry.add('pairing token audit', startPairingTokenAudit(pairingTokens, tokenAuditor));
  const componentHealthMonitor = new ComponentHealthMonitor();
  const healthSystem = createWiredHealthSystem(options.runtimeBus);
  disposalScope.registry.add('runtime health event bridge', bindHealthDomainEvents(options.runtimeBus, healthSystem.wiring));
  const worktreeRegistry = new WorktreeRegistry(workingDirectory, { surfaceRoot });
  const webhookNotifier = new WebhookNotifier();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  // Poll-free runtime event for permission-mode changes so surfaces can render a live mode pill.
  bindPermissionModeChangeEvent(configManager, options.runtimeBus, 'runtime');
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  // This composition keeps no project work plan, so it has no active plan.
  const planManager = new ExecutionPlanManager(null);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler({
    baseDir: workingDirectory,
    featureFlags,
    spillBackend: configManager.get('tools.overflowSpillBackend'),
  });
  const policyRuntimeState = createPolicyRuntimeState(configManager, featureFlags);
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(workingDirectory);
  // Project files changed outside the write and edit tools: the project index
  // forgets deleted ones and Change:file:external hooks fire.
  const fileWatcher = new FileWatcher(projectIndex, { projectRoot: workingDirectory }, hookDispatcher);
  void fileWatcher.start();
  disposalScope.registry.add('file watcher', () => fileWatcher.stop());
  const channelDeliveryRouter = new ChannelDeliveryRouter({
    configManager,
    secretsManager,
    serviceRegistry,
    artifactStore,
  });
  const processManager = new ProcessManager();
  const modeManager = new ModeManager({ featureFlags });
  const fileUndoManager = new FileUndoManager({ onFileChanged: (path) => fileCache.invalidate(path) });
  const workspaceCheckpointManager = new WorkspaceCheckpointManager({
    workspaceRoot: workingDirectory,
    runtimeBus: options.runtimeBus,
  });
  // Eagerly initialize so automatic turn/agent-run snapshot subscriptions are
  // wired up immediately rather than only on first explicit use, otherwise
  // the very first TURN_COMPLETED/AGENT_COMPLETED could arrive before any
  // caller has touched the manager.
  void workspaceCheckpointManager.init().catch((err: unknown) => {
    logger.warn('WorkspaceCheckpointManager.init failed', { error: summarizeError(err) });
  });
  const integrationHelpers = new IntegrationHelperService({
    workingDirectory,
    homeDirectory,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    configManager,
    featureFlags,
    getConversationTitle: options.getConversationTitle,
    automationManager,
    approvalBroker,
    sessionBroker,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    panelManager,
    localUserAuthManager,
    providerRegistry,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
  });
  // Durable user-origin permission rules (remembered approvals): one store per project, shared by
  // every PermissionManager here; permissions.rules.* lists/deletes. Background init is fail-safe.
  // Same store + same manager wiring the pure-client composition uses (permissions/permission-composition.ts).
  const userPermissionRuleStore = createUserPermissionRuleStore(configManager);
  // The product's raiser, behind the workspace trust gate when the product has one. Every ask below
  // (tool permissions and the three approval-derived handlers) goes through this one function, so a
  // restricted workspace refuses them all the same way.
  const raiseApproval: ApprovalRaiser = product.permissionHost.raiseApproval?.(approvalBroker)
    ?? ((input) => approvalBroker.requestApproval(input));
  const trustChoice = product.workspaceTrust === 'none' ? null
    : product.workspaceTrust === 'surface' ? { kind: 'surface' as const } : product.workspaceTrust;
  const workspaceTrustManager = trustChoice ? new WorkspaceTrustManager({ shellPaths, surfaceRoot }) : undefined;
  const requestApproval: ApprovalRaiser = trustChoice && workspaceTrustManager
    ? trustGatedApprovalRaiser(
      workspaceTrustManager,
      raiseApproval,
      trustChoice.requestTrustDecision ?? createWorkspaceTrustDecisionAsk({ broker: approvalBroker, workingDirectory }),
    )
    : raiseApproval;
  const workspaceTrustFor = trustChoice?.resolveFor && workspaceTrustManager ? trustChoice.resolveFor(workspaceTrustManager) : undefined;
  const backgroundPermissionManager = createBrokeredPermissionManager({
    workspaceTrust: workspaceTrustManager ?? null,
    requestApproval,
    configManager,
    policyRuntimeState,
    hookDispatcher,
    featureFlags,
    userRuleStore: userPermissionRuleStore,
  });
  const externalPermissionLifetime = new AbortController();
  disposalScope.registry.add('external protocol permission lifetime', () => externalPermissionLifetime.abort());
  const externalPermissionHost = { port: judgment.port, permissionManager: backgroundPermissionManager,
    config: configManager, signal: externalPermissionLifetime.signal, workspaceTrust: workspaceTrustManager ?? null, workspaceRoot: workingDirectory,
    ...(workspaceTrustFor ? { workspaceTrustFor } : {}) };
  // The interactive session binds its Orchestrator-backed source onto this holder
  // after construction; passing it through here registers the context_accounting
  // tool on the shared roster (every consumer inherits it, like repo_map).
  const contextAccountingHolder = new ContextAccountingHolder();
  // The three handlers that must ride the SAME ask seam as a tool permission
  // (sandbox-boundary escalation, a blocked exec prompt, a loopback fetch) plus
  // the announce-once containment receipt, one implementation, shared with the
  // pure-client composition (permissions/permission-composition.ts).
  // (Announcement store constructed above, before the consolidation scheduler.)
  const {
    sandboxEscalationHandler,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
  } = createApprovalDerivedHandlers({
    autonomousHost: externalPermissionHost,
    requestApproval,
    configManager,
    featureFlags,
    announcementStore,
  });
  localhostFetchApprovalForSearch = localhostFetchApproval;
  // Late-bound CI auto-watch observer (filled by registerGatewayVerbGroups below).
  let ciAutoWatchObserver: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | null = null;
  // The contract runner, over the project's work plan and execution plans; its
  // units share the fleet ceiling (fleetCapacityProbe, hoisted below).
  const contracts = composeContractRunner({
    nativeDataWriter: options.nativeDataWriter ?? options.configManager.getNativeDataWriter(),
    judgmentLog: judgment.decisionLog,
    surfaceRoot,
    readAccessFilter: async (path) => (await backgroundPermissionManager.readAccess(path)) === 'allow',
    runtimeBus: options.runtimeBus,
    agentManager,
    agentMessageBus,
    configManager,
    providerRegistry,
    projectRoot: workingDirectory,
    fleetCapacity: () => fleetCapacityProbe(),
    runtimeStore: options.runtimeStore,
    workPlanService: projectPlanningService,
    planManager,
  });
  const contractRunner = contracts.runner;
  const contractOperator = createContractOperatorService({ runner: contractRunner, workingDirectory });
  agentOrchestrator.setDependencies({
    contractRunner,
    contractHooks: contractRunner.hooks(),
    personalCapture,
    sandboxEscalationHandler,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
    permissionManager: backgroundPermissionManager,
    toolCallHooks: hookDispatcher,
    contextAccountingHolder,
    fileCache,
    projectIndex,
    workingDirectory,
    surfaceRoot,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus,
    agentManager,
    webSearchService,
    channelRegistry: channelPlugins,
    remoteRunnerRegistry,
    knowledgeService,
    memoryRegistry,
    codeIndex: codeIndexStore,
    memoryEmbeddingRegistry,
    isCodeInjectionSettingEnabled: codeInjectionSettingEnabled,
    codeIndexReindexScheduler,
    toolExecutionObserver: (toolName, args, success) => ciAutoWatchObserver?.(toolName, args, success),
    archetypeLoader,
    configManager,
    providerRegistry,
    providerOptimizer,
    toolLLM,
    serviceRegistry,
    secretsManager,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
  });

  // Honest-unpriced dollars + provenance over the ONE pricing resolver (pricing-seams.ts).
  const { priceUsage, priceProvenance } = buildPricingSeams(providerRegistry);


  // Live process registry, narrow structural deps only, constructed
  // after every source manager exists. RuntimeServices.dispose() releases
  // the registry through the graph's shared disposal scope.
  // Archive-aware: finished agent/swarm subtrees can be moved out of the
  // live fleet view into a session-scoped archive (see fleet/archive.ts).
  // ACP/MCP protocol decisions use the same recorded autonomous owner as native tools.

  mcpRegistry.setPermissionHost(externalPermissionHost);
  // No person sits at this graph's surface (embedded hosts, the daemon): a server question the call's
  // own facts cannot answer is declined and handed back to the agent in the tool result.
  mcpRegistry.setElicitationHandler(createMcpAutonomousElicitationHandler(externalPermissionHost));
  const acpHost = new AcpHostService({
    permissionHost: externalPermissionHost,
    registerSession: ({ id, title, agentTitle, cwd }) => void sessionBroker
      .register({ sessionId: id, kind: 'acp', title, project: cwd, participant: { surfaceKind: 'service', surfaceId: `acp-host:${agentTitle}`, lastSeenAt: Date.now() } })
      .catch(() => { /* best-effort; the fleet row is authoritative */ }),
  })
  // The ONE fleet ceiling's live probe (fleet.maxSize): native + ACP-hosted +
  // elastic fixers; responsibility only, by construction (fleet-count.ts).
  // Hoisted fn, referenced by the engine above, called only at tick time.
  function fleetCapacityProbe() {
    return makeRuntimeFleetProbe({ readConfig: (key) => configManager.get(key as never), agentManager, acpHost })();
  }
;
  // Read-only detection of externally-launched coding-agent sessions on this
  // host (Claude Code / Codex the daemon did not spawn). These fold in as
  // observed rows for visibility + steer; they NEVER count against fleet.maxSize
  // (fleet-count.ts accepts only owned sources by construction). Opt-in so the
  // generic factory never scans the host process table by default; absence (or
  // opt-out) is a quiet empty set.
  const observedAgents = options.observeExternalAgents ? new ObservedAgentSource() : undefined;
  // The trigger family. Constructed unconditionally so `watchers.triggers.enabled`
  // is a real runtime toggle rather than a restart-only one: the manager reads
  // its config live on every access and does no work while the flag is off.
  // Its process host is ProcessManager-backed, so a supervised on-exit child
  // inherits the same credential-env scrub, live output collection and
  // SIGTERM→SIGKILL watchdog as any other background command.
  const triggerManager = new TriggerManager({
    nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter(),
    storePath: shellPaths.resolveProjectPath(surfaceRoot, 'triggers-v2.json'),
    previousStorePath: shellPaths.resolveProjectPath(surfaceRoot, 'triggers.json'),
    config: () => ({
      enabled: configManager.get('watchers.triggers.enabled'),
      backoffLadderMs: configManager.get('watchers.triggers.backoffLadderMs'),
      breakerStrikes: configManager.get('watchers.triggers.breakerStrikes'),
      defaultCheckIntervalMs: configManager.get('watchers.triggers.defaultCheckIntervalMs'),
      probeTimeoutMs: configManager.get('watchers.triggers.probeTimeoutMs'),
      maxConcurrentChecks: configManager.get('watchers.triggers.maxConcurrentChecks'),
      observationRingSize: configManager.get('watchers.triggers.observationRingSize'),
      runHistoryLimit: configManager.get('watchers.triggers.runHistoryLimit'),
      runHistoryTtlHours: configManager.get('watchers.triggers.runHistoryTtlHours'),
      eventLogLimit: configManager.get('watchers.triggers.eventLogLimit'),
      eventLogTtlHours: configManager.get('watchers.triggers.eventLogTtlHours'),
      sweepIntervalMs: configManager.get('watchers.triggers.sweepIntervalMs'),
      supervisionTickMs: configManager.get('watchers.triggers.supervisionTickMs'),
      streamQueueLimit: configManager.get('watchers.triggers.streamQueueLimit'),
      streamBatchLines: configManager.get('watchers.triggers.streamBatchLines'),
      streamBatchIntervalMs: configManager.get('watchers.triggers.streamBatchIntervalMs'),
      onExitMaxDurationMs: configManager.get('watchers.triggers.onExitMaxDurationMs'),
      onExitStdin: configManager.get('watchers.triggers.onExitStdin'),
      outputTailBytes: configManager.get('watchers.triggers.outputTailBytes'),
    }),
    actions: createTriggerActionExecutor({ agents: agentManager, processManager }),
    processHost: createProcessManagerTriggerHost(processManager),
    streamHost: createBunStreamHost(processManager),
    sessionIsLive: (sessionId: string) => sessionBroker.getSession(sessionId) !== null,
  });

  const baseProcessRegistry = createProcessRegistry({
    agentManager,
    contractRunner,
    processManager,
    watcherRegistry,
    triggerSupervisor: triggerManager,
    workflow: {
      workflowManager: workflow.workflowManager,
      hookActions: workflow.hookActions,
      scheduleManager: workflow.scheduleManager,
    },
    approvalBroker,
    sessionBroker,
    runtimeBus: options.runtimeBus,
    priceUsage,
    priceProvenance,
    codeIndexService: codeIndexStore,
    acpHost,
    observedAgents,
  });
  const processRegistry = withFleetArchive(baseProcessRegistry);

  // Surface fleet lifecycle deltas on the runtime bus `fleet` domain (gateway fans it out; no polling). sessionPresence gates needs-input push suppression. Both subscriptions live for the registry's lifetime.
  // The bridge watches the unfiltered registry: archiving hides a node from the view, it does not make the node new when it is unarchived.
  attachFleetEmitBridge({ registry: baseProcessRegistry, bus: options.runtimeBus });
  // Key-level config changes on the runtime bus `config` domain, so a client whose settings live in the daemon gets live notices instead of polling; secret-bearing keys travel by name only (runtime/config/emit-bridge.ts).
  disposalScope.registry.add('config event bridge', attachConfigEmitBridge({ config: { subscribe: (key, cb) => configManager.subscribe(key as never, cb as never) }, bus: options.runtimeBus }));
  const isAttached = (sessionId: string): boolean => {
    const s = sessionBroker.getSession(sessionId);
    return s ? hasFreshSurfaceParticipant(s, Date.now(), SURFACE_ROUTE_FRESHNESS_MS) : false;
  };
  const stepUpService = new StepUpService({ secrets: secretsManager });
  const sessionLiveTurnControls = new SessionLiveTurnControlsHolder();
  // Sleep ownership: work-signal inhibition, keep-awake toggle, sleep-edge checkpoint + wake catch-up.
  const powerManager = wireRuntimePower({
    seam: options.powerSeam ?? createUnavailablePowerSeam('runtime services constructed without a host power seam'),
    readConfig: (key) => configManager.get(key as never),
    writeConfig: (key, value) => configManager.setDynamic(key as never, value),
    subscribeConfig: (key, cb) => configManager.subscribe(key as never, cb as never),
    runtimeBus: options.runtimeBus,
    sleepCheckpoint: () => storeSnapshotScheduler.tick(),
    wakeCatchUp: [() => memoryConsolidationScheduler.tick(), () => storeSnapshotScheduler.tick(), async () => { await automationManager.triggerHeartbeat({ source: 'wake-catchup' }); }] });
  // Construct + start the MemoryGovernor (default ON, a safety feature) with the
  // standard KNOWN cache adapters (see wireDaemonMemoryGovernance).
  const { memoryGovernor, configFallback: memoryConfigFallback } = wireDaemonMemoryGovernance({
    config: {
      budgetMb: configManager.get('memory.budgetMb'),
      elevatedPct: configManager.get('memory.tier.elevatedPct'),
      highPct: configManager.get('memory.tier.highPct'),
      criticalPct: configManager.get('memory.tier.criticalPct'),
      tripwireRateMbPerSec: configManager.get('memory.tripwire.rateMbPerSec'),
      tripwireSustainSec: configManager.get('memory.tripwire.sustainSec'),
      hardLimitPct: configManager.get('memory.hardLimitPct'),
    },
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath(surfaceRoot, 'memory', 'tripwire-receipt.json'),
    // REAL cache adapters: genuine counts + trims that reclaim (job-run
    // history pruning; broker GC + bucket truncation).
    knowledgeStores: [knowledgeStore, agentKnowledgeStore, homeGraphKnowledgeStore],
    sessionBroker,
    // Graceful tripwire shutdown flushes in-flight state via ASYNC store snapshots (fs/promises): sync copyFileSync on a stalled disk would block the event loop, so the governor's 10s shutdown ceiling could never fire, threadpool copies keep it enforceable.
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
  });
  // A stored memory budget or tier set the governor refused (a hand edit, or a
  // budget near this machine's memory) runs on the shipped limits; the owner is
  // told once per distinct reason, and told again if it comes back after a fix.
  if (memoryConfigFallback !== undefined) {
    announcementStore.record(`memory-config-fallback:${memoryConfigFallback}`, `Memory limits: ${memoryConfigFallback}`);
  } else {
    announcementStore.forgetMatching((id) => id.startsWith('memory-config-fallback:'));
  }
  // Late-bind the admission gate now that the governor exists: the expensive
  // entry points captured `admitExpensiveWork` earlier via this holder.
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);
  // Managed local-voice provisioning: single-flight one-act install +
  // status read carrying live install progress while an install runs
  // (surfaces poll status during the ~209MB provision). Ownership-aware
  // preconfigure, breaker reset, and admission gating live in
  // runtime/voice-setup.ts.
  const managedVoiceRoot = shellPaths.resolveUserPath('voice');
  const voiceSetup = createVoiceSetupService({
    managedVoiceRoot,
    getConfig: (k) => String(configManager.get(k as never) ?? ''),
    setConfig: (k, v) => configManager.setDynamic(k as never, v),
    resetLocalEngineFailureState: () => voiceProviders.get('local')?.resetEngineFailureState?.(),
    admitExpensiveWork: (label) => admitExpensiveWork(label),
  });
  registerGatewayVerbGroups(gatewayMethods, { triggerSupervisor: triggerManager, homeDirectory, processRegistry, workspaceCheckpointManager, sessionBroker, secretsManager, approvalBroker, watcherRegistry, userPermissionRuleStore, shellPaths, surfaceRoot, runtimeBus: options.runtimeBus, sessionPresence: { isAttached }, configManager, runtimeStore: options.runtimeStore, channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker, channelPolicy, workingDirectory, attemptsController: contractRunner.fleetControls(), contractOperator, stepUpService, memoryRegistry, pairingTokens, acpHost, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup, credentialWrites: { config: configManager, secrets: secretsManager }, approvalRaise: approvalBroker, disposal: disposalScope.registry, personalCapture, ciAutonomousHost: () => externalPermissionHost, onCiAutoWatch: (observer) => { ciAutoWatchObserver = observer; } }); // see routes/register-gateway-verb-groups.ts
  disposalScope.registry.add('native automation updates', registerNativeAutomationGatewayMethods(gatewayMethods, { manager: automationManager, host: externalPermissionHost }));
  // Teardown for every poller started above. RuntimePollerOwners is all-required,
  // so a poller added to this graph later cannot compile without being named here.
  const stopRequests = createRuntimeStopRequests(disposalScope.registry, { homeGraphService, memoryGovernor, watcherRegistry });
  registerRuntimePollers(disposalScope.registry, {
    stopConfigWatch, watcherRegistry: { dispose: stopRequests.watchers }, storeSnapshotScheduler, appendOnlyRetentionScheduler,
    memoryConsolidationScheduler, codeIndexReindexScheduler, sessionOrchestration,
    knowledgeService, agentKnowledgeService, contractRunner: contracts, homeGraphService: { dispose: stopRequests.homeGraph },
    processRegistry, memoryGovernor: { stop: stopRequests.memoryGovernor }, triggerManager, agentOrchestrator, cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
  });
  // Contracts left on disk resume once the services are up.
  void resumeContracts(contractRunner, workingDirectory);
  return {
    workingDirectory,
    nativeMutationHost: externalPermissionHost,
    homeDirectory,
    surfaceRoot,
    ...(workspaceTrustManager ? { workspaceTrustManager } : {}),
    permissionManager: backgroundPermissionManager,
    memoryGovernor,
    cacheRegistry,
    pauseController,
    shellPaths,
    configManager,
    featureFlags,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    panelManager,
    keybindingsManager,
    routeBindings,
    surfaceRegistry,
    channelPlugins,
    channelDeliveryRouter,
    watcherRegistry,
    triggerManager,
    approvalBroker,
    userPermissionRuleStore,
    sessionBroker,
    deliveryManager,
    automationManager,
    gatewayMethods,
    artifactStore,
    knowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    memoryStore,
    memoryRegistry,
    judgment,
    codeIndexStore,
    codeIndexReindexScheduler,
    storeSnapshotScheduler,
    appendOnlyRetentionScheduler,
    memoryConsolidationScheduler,
    powerManager,
    serviceRegistry,
    secretsManager,
    stepUpService,
    subscriptionManager,
    localUserAuthManager,
    pairingTokens,
    profileManager,
    bookmarkManager,
    sessionManager,
    sessionOrchestration,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    workflow,
    voiceProviders,
    voiceService,
    webSearchProviders,
    webSearchService,
    mediaProviders,
    multimodalService,
    memoryEmbeddingRegistry,
    channelPolicy,
    mcpRegistry,
    tokenAuditor,
    componentHealthMonitor,
    healthAggregator: healthSystem.aggregator,
    worktreeRegistry,
    sandboxSessionRegistry,
    webhookNotifier,
    replayEngine,
    providerOptimizer,
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    sessionMemoryStore,
    sessionLineageTracker,
    sessionChangeTracker,
    planManager,
    adaptivePlanner,
    idempotencyStore,
    overflowHandler,
    policyRuntimeState,
    archetypeLoader,
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    contextAccountingHolder,
    sessionLiveTurnControls,
    contractRunner,
    contractOperator,
    sessionSnapshot: (sessionId, conversation) => ({ ...conversation, contracts: contractRunner.list({ sessionId, includeTerminal: true }) }),
    processManager,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    dispose: (): void => { stopRequests.request(); disposalScope.dispose(); },
    close: (): Promise<void> => { stopRequests.request(); return disposalScope.close(); },
  };
}
