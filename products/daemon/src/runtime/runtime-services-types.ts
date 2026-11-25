import type { BrowserJudgmentService } from '@goodvibes/engine/platform/platform/judgment-browser';
/**
 * runtime-services-types.ts, the public contract createRuntimeServices() takes
 * and returns.
 *
 * Split out of services.ts (the composition root that builds every one of
 * these fields) so the construction logic can stay under the repo's
 * architecture line-count gate without trimming 35 arbitrary lines to clear
 * the number. This module owns ONLY the shape of the input options and the
 * output surface, no runtime code, no wiring order, nothing that constructs
 * anything. services.ts re-exports both types from here, so no import site
 * anywhere else in the app had to change.
 */

import type { ConfigManager, HelperModel, ServiceRegistry, SubscriptionManager, ToolLLM } from '@goodvibes/engine/platform/platform/config';
import type { SecretsManager } from '../config/secrets.js';
import type { AutomationDeliveryManager, AutomationManager } from '@goodvibes/engine/platform/platform/automation';
import type { ChannelDeliveryRouter, ChannelPolicyManager, ChannelPluginRegistry, RouteBindingManager, SurfaceRegistry } from '@goodvibes/engine/platform/platform/channels';
import type { ApprovalBroker, GatewayMethodCatalog, SessionLiveTurnControlsHolder, SharedSessionBroker } from '@goodvibes/engine/platform/platform/control-plane';
import type { PowerManager } from '@goodvibes/engine/platform/platform/power';

import type { StepUpService } from '@goodvibes/engine/platform/daemon';
import type { PairingTokenManager } from '@goodvibes/engine/platform/platform/pairing';
import type { WatcherRegistry } from '@goodvibes/engine/platform/platform/watchers';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { HomeGraphService, KnowledgeService, ProjectPlanningService } from '@goodvibes/engine/platform/platform/knowledge';
import type { MediaProviderRegistry } from '@goodvibes/engine/platform/platform/media';
import type { MultimodalService } from '@goodvibes/engine/platform/platform/multimodal';
import type { AgentMessageBus, AgentOrchestrator, ArchetypeLoader } from '@goodvibes/engine/platform/platform/agents';
import type { AgentManager, ContextAccountingHolder, OverflowHandler, ProcessManager, WorkflowServices } from '@goodvibes/engine/platform/platform/tools';
import type { FileUndoManager, MemoryConsolidationScheduler, MemoryUsageTracker, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, ModeManager, ProjectIndex, CodeIndexStore, CodeIndexReindexScheduler } from '@goodvibes/engine/platform/platform/state';
import type { StoreSnapshotScheduler } from '@goodvibes/engine/platform/platform/state/store-snapshots';
import type { PermissionManager, UserPermissionRuleStore } from '@goodvibes/engine/platform/platform/permissions';
import type { buildExecPromptAnswerHandler } from '@goodvibes/engine/platform/platform/runtime/permissions/exec-prompt-wiring';
import type { buildLocalhostFetchApproval } from '@goodvibes/engine/platform/platform/runtime/permissions/localhost-fetch-approval';
import type { operations } from '@goodvibes/engine/platform/platform/runtime';
import type { MemorySpineClient } from '@goodvibes/engine/platform/platform/runtime/memory-spine';
import type { WorkspaceCheckpointManager } from '@goodvibes/engine/platform/platform/workspace';
import type { DomainDispatch, RuntimeStore } from '@goodvibes/engine/platform/platform/runtime/store';
import type { DevicePostureRuntime } from '@goodvibes/engine/platform/platform/devices';
import type { RuntimeHealthAggregator } from '@goodvibes/engine/platform/platform/runtime/observability';
import type { RuntimeEventBus, DistributedRuntimeManager, RemoteBackendHost, RemoteRunnerRegistry, RemoteSupervisor, IntegrationHelperService, PanelManagerLike, KeybindingsManagerLike, IdempotencyStore, WorktreeRegistry, SandboxSessionRegistry, ShellPathService, FeatureFlagManager, PolicyRuntimeState, SessionSurface } from './index.js';
import type { VoiceProviderRegistry, VoiceService } from '@goodvibes/engine/platform/platform/voice';
import type { CacheRegistry, PauseController, MemoryGovernor } from '@goodvibes/engine/platform/platform/runtime/memory';
import type { WebSearchProviderRegistry, WebSearchService } from '@goodvibes/engine/platform/platform/web-search';
import type { HookActivityTracker } from '@goodvibes/engine/platform/platform/hooks';
import type { HookDispatcher, HookWorkbench } from '@goodvibes/engine/platform/platform/hooks';
import type { PluginManager } from '@goodvibes/engine/platform/platform/plugins';
import type { BookmarkManager } from '@goodvibes/engine/platform/platform/bookmarks';
import type { ProfileManager } from '@goodvibes/engine/platform/platform/profiles';
import type { SessionManager, CrossSessionTaskRegistry, SessionChangeTracker } from '@goodvibes/engine/platform/platform/sessions';
import type { ApiTokenAuditor, UserAuthManager } from '@goodvibes/engine/platform/platform/security';
import type { WebhookNotifier } from '@goodvibes/engine/platform/platform/integrations';
import type { McpRegistry } from '@goodvibes/engine/platform/platform/mcp';
import type { BenchmarkStore, CacheHitTracker, FavoritesStore, ModelLimitsService, ProviderCapabilityRegistry, ProviderOptimizer, ProviderRegistry } from '@goodvibes/engine/platform/platform/providers';
import type { DeterministicReplayEngine, ExecutionPlanManager, SessionLineageTracker, SessionMemoryStore } from '@goodvibes/engine/platform/platform/core';
import type { ArchivableProcessRegistry } from '@goodvibes/engine/platform/platform/runtime/fleet';
import type { ProjectWorkPlan } from '@goodvibes/engine/platform/platform/knowledge';
import type { WorkLedgerService } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import type { DaemonHandlerSurfaces } from '../daemon/handlers/index.js';
import type { ClusterGroupComposition } from './cluster-group-composition.js';
import type { ClusterCoordinator } from '@goodvibes/engine/platform/platform/cluster';

import type { ContractRunner, ContractOperatorService } from '@goodvibes/engine/platform/platform/contract';
import type { JudgmentServices } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { SessionSnapshot } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { DaemonInboxFactory } from './daemon-handler-composition.js';
import type { TriggerManager } from '@goodvibes/engine/platform/platform/triggers';
import type { DaemonBootController, DaemonBootOperations } from './boot-tasks.js';

export interface RuntimeServicesOptions {
  readonly nativeDataWriter?: import('@goodvibes/engine/platform/platform/runtime/self-update').NativeDataWriteOwner | undefined;
  readonly capturedBunRuntimeExecutable?: string | undefined;
  /**
   * Explicit boot composition, constructed synchronously without starting its
   * operations. The entrypoint starts the returned controller after the facade
   * initializes memory. No production default is installed until the live
   * notification privacy and awaited webhook lifetime dependencies are ready.
   */
  readonly createBootOperations?: ((services: RuntimeServices) => DaemonBootOperations) | undefined;
  /** Optional host override of the built-in WebUI registry. Receives this graph's recorded port, never browser credentials. */
  readonly createBrowserJudgment?: ((judgment: JudgmentServices) => BrowserJudgmentService) | undefined;
  /** Required explicit composition until built-in inbox migration is complete. */
  readonly inboxFactory: DaemonInboxFactory;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly configManager: ConfigManager;
  readonly localUserAuthManager?: UserAuthManager;
  readonly featureFlags?: FeatureFlagManager;
  readonly getConversationTitle?: () => string | undefined;
  readonly workingDir: string;
  readonly homeDirectory: string;
  /**
   * The daemon's state root when the host was told one (`--daemon-home`,
   * `GOODVIBES_DAEMON_HOME`); absent ⇒ `<homeDirectory>/.goodvibes/daemon`.
   * Threaded into `SecretsManager` so the override MOVES the daemon-scoped
   * credential store; without it a daemon told to run out of a temp tree still
   * read the real home's daemon secrets, so an "isolated" test daemon held the
   * owner's live credentials. One name for one thing, `resolveGoodVibesHomeOwnership`
   * is the single reader that produces it.
   */
  readonly daemonHomeDirectory?: string | undefined;
  /** Opt-in (daemon-side only): fold host-observed external coding-agent sessions
   * into the fleet as 'observed-external' rows. Interactive leaves it off and reads
   * the daemon snapshot. Mirrors the platform's own createRuntimeServices option. */
  readonly observeExternalAgents?: boolean | undefined;
  /** Host power seam opt-in. Left out, the platform's idle-power wiring falls back to
   * the non-spawning unavailable seam; the daemon entrypoint passes the real
   * host seam, which is what starts systemd-inhibit and the sleep-edge watcher. */
  readonly powerSeam?: operations.IdlePowerServicesDeps['powerSeam'];
  /** Live session id, read per crash-residue sweep so the running session is exempt. */
  readonly currentSessionId?: (() => string | null) | undefined;
  /**
   * Wake-word boot provisioning opt-in. Same shape as `powerSeam`: the real
   * entrypoint (`goodvibes-daemon serve`) asks for it, the one-shot CLI commands do
   * not, and a test composing this graph gets neither a network fetch nor an
   * hourly sweep it did not ask for.
   */
  readonly provisionWakeModelsAtBoot?: boolean | undefined;
}

export interface RuntimeServices {
  readonly nativeDataWriter?: import('@goodvibes/engine/platform/platform/runtime/self-update').NativeDataWriteOwner | undefined;
  readonly nativeMutationHost?: import('@goodvibes/engine/platform/platform/control-plane').NativeMutationHost | undefined;
  /** Absent when the host did not supply the pending product boot composition. */
  readonly bootTasks?: DaemonBootController | undefined;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  /**
   * The `.goodvibes/<surface root>/` segment this daemon's own state lives
   * under, always GOODVIBES_DAEMON_SURFACE_ROOT here (config/surface.ts).
   * Declared so a consumer ASKS for it instead of deriving a second one; the
   * unscoped pre-split control-plane store is what deriving it twice produced.
   */
  readonly surfaceRoot: string;
  /** The declare-once session-storage handle every session reader and writer threads through. */
  readonly surface: SessionSurface;
  readonly shellPaths: ShellPathService;
  readonly configManager: ConfigManager;
  readonly featureFlags: FeatureFlagManager;
  readonly runtimeBus: RuntimeEventBus;
  readonly runtimeStore: RuntimeStore;
  readonly runtimeDispatch: DomainDispatch;
  /** No-op stand-ins: the facade's contract names them, and the daemon has no screen. */
  readonly panelManager: PanelManagerLike;
  readonly keybindingsManager: KeybindingsManagerLike;
  readonly routeBindings: RouteBindingManager;
  readonly surfaceRegistry: SurfaceRegistry;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly channelDeliveryRouter: ChannelDeliveryRouter;
  readonly watcherRegistry: WatcherRegistry;
  readonly approvalBroker: ApprovalBroker;
  /** The one owner inbox: approvals, questions, claims, purchase windows and queued actions. */
  readonly ownerInbox?: import('@goodvibes/engine/platform/platform/control-plane').OwnerInbox | undefined;
  /** Where the email inbox meets the one mailbox reader the daemon facade composes. */
  readonly mailboxReaders?: import('@goodvibes/engine/platform/platform/email').MailboxReaders | undefined;
  /** Loopback-fetch approval that rides the approval broker; shared by the tool registry and orchestrator so every surface asks the same way. */
  readonly localhostFetchApproval: ReturnType<typeof buildLocalhostFetchApproval>;
  /** Terminal prompt-answer handler that rides the approval broker; shared by the tool registry and orchestrator so an interactive command's prompt gets an ask/card on every surface. */
  readonly execPromptAnswerHandler: ReturnType<typeof buildExecPromptAnswerHandler>;
  /** Durable user-origin permission rules (remembered approvals); permissions.rules.* surface. Mirrors the platform composition. */
  readonly userPermissionRuleStore: UserPermissionRuleStore;
  readonly sessionBroker: SharedSessionBroker;
  readonly deliveryManager: AutomationDeliveryManager;
  readonly automationManager: AutomationManager;
  readonly gatewayMethods: GatewayMethodCatalog;
  readonly artifactStore: ArtifactStore;
  readonly knowledgeService: KnowledgeService;
  readonly agentKnowledgeService: KnowledgeService;
  readonly homeGraphService: HomeGraphService;
  readonly projectPlanningService: ProjectPlanningService;
  readonly projectPlanningProjectId: string;
  readonly workPlan: ProjectWorkPlan;
  /** Native project ledger; actor issuance stays in trusted host composition. */
  readonly workLedger: WorkLedgerService;
  readonly memoryStore: MemoryStore;
  readonly memoryRegistry: MemoryRegistry;
  /** Host-vs-client memory access: local until bootstrap.ts activates it for an adopted 'external' daemon (mirrors sessionSpine). */
  readonly memorySpine: MemorySpineClient;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: SecretsManager;
  readonly stepUpService: StepUpService;
  readonly pairingTokens: PairingTokenManager; // backs pairing.tokens.* verbs + the settings device surface (mirrors the platform composition)
  readonly subscriptionManager: SubscriptionManager;
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
  /** Stream watchers, on-exit process triggers and condition checks, supervised as one, see trigger-services.ts. */
  readonly triggerManager: TriggerManager;
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
  /** Per-domain runtime health, kept current from the runtime event bus. */
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
  /** The one helper route for supporting work; the orchestrator, resume summaries and titles share it. */
  readonly helperModel: HelperModel;
  readonly distributedRuntime: DistributedRuntimeManager;
  /** Registered execution backends `remote.peers.invoke` runs a command on (docker, ssh, cloud terminal, local process). */
  readonly remoteBackends: RemoteBackendHost;
  /**
   * The paired-phone feature for this host: the grants ledger, the capture
   * store, the housekeeping sweeps, and the capability service every `device.*`
   * setting governs. Bound to the `devices.*` verbs at composition; the `phone`
   * tool is registered on it in the bootstrap tail.
   */
  readonly devicePosture: DevicePostureRuntime;
  readonly daemonHandlers: DaemonHandlerSurfaces;
  /** Elects the one node on this network that consumes inbound messages; hand it to the DaemonServer so its consumers share this leadership instead of holding a second election. */
  readonly clusterCoordinator: ClusterCoordinator;
  /** LAN group membership: identity, keys, roster, and the `cluster` verbs. */
  readonly clusterGroup: ClusterGroupComposition;
  /** Start the group layer and then the election, in that order. Idempotent. */
  readonly startCluster: () => Promise<void>;
  readonly remoteRunnerRegistry: RemoteRunnerRegistry;
  readonly remoteSupervisor: RemoteSupervisor;
  readonly sessionMemoryStore: SessionMemoryStore;
  readonly sessionLineageTracker: SessionLineageTracker;
  readonly sessionChangeTracker: SessionChangeTracker;
  readonly planManager: ExecutionPlanManager;
  readonly idempotencyStore: IdempotencyStore;
  readonly overflowHandler: OverflowHandler;
  readonly policyRuntimeState: PolicyRuntimeState;
  readonly archetypeLoader: ArchetypeLoader;
  readonly agentManager: AgentManager;
  readonly agentMessageBus: AgentMessageBus;
  readonly agentOrchestrator: AgentOrchestrator;
  readonly contextAccountingHolder: ContextAccountingHolder; // never bound to a session: workers answer through their own scoped source, and each hosted session binds its own holder (hosted-sessions/session-runtime.ts)
  readonly contractRunner: ContractRunner;
  readonly contractOperator: ContractOperatorService;
  /** Joins the hosted-session floors' workers into this runtime's fleet (the composed graph's own). */
  readonly attachHostedFleetAgents: import('@goodvibes/engine/platform/platform/runtime/bootstrap').RuntimeServices['attachHostedFleetAgents'];
  readonly judgment: JudgmentServices;
  readonly browserJudgment?: BrowserJudgmentService | undefined;
  /** The daemon's `browser.*` service; absent when the composition had no home directory for a browser. */
  readonly browserGateway?: import('@goodvibes/engine/platform/platform/control-plane').DaemonBrowserGatewayService | undefined;
  /** Canonical saved conversation plus its contract trees. */
  sessionSnapshot(sessionId: string, conversation: Omit<SessionSnapshot, 'contracts'>): SessionSnapshot;
  readonly processManager: ProcessManager;
  /** The repo source-tree code index. */
  readonly codeIndexStore: CodeIndexStore;
  readonly codeIndexReindexScheduler: CodeIndexReindexScheduler; // tool-site reindex
  /** Daily snapshots of every SQLite store this runtime writes, with bounded retention; unref'd timers (mirrors the platform composition, hosts that tear down a runtime stop() it themselves). */
  readonly storeSnapshotScheduler: StoreSnapshotScheduler;
  readonly appendOnlyRetentionScheduler: operations.DurabilityServices['appendOnlyRetentionScheduler']; // periodic append-only sweep; unref'd timers, stop() on teardown
  /** Stops the recurring crash-residue sweep; idempotent, unref'd timer (hosts that tear a runtime down call it). */
  readonly stopDurabilityHousekeeping: () => void;
  /** Stops the wake-word recovery sweep and a pending boot provision; a no-op unless `provisionWakeModelsAtBoot` was set. */
  readonly stopWakeHousekeeping: () => void;
  readonly memoryConsolidationScheduler: MemoryConsolidationScheduler;
  /** The process's one per-turn memory usage tracker (the platform graph's); consolidation's decay reads its counters. */
  readonly memoryUsageTracker: MemoryUsageTracker;
  readonly powerManager: PowerManager;
  /** The daemon's memory governor (default ON). Backs ops.memory.get and defends the daemon's footprint by tier. */
  readonly memoryGovernor: MemoryGovernor;
  /** Registry of every retained cache the governor can shrink (knowledge stores + shared session broker). */
  readonly cacheRegistry: CacheRegistry;
  /** Controller the governor uses to pause/resume the deferrable background jobs under pressure. */
  readonly pauseController: PauseController;
  /** Whether the daemon takes new work (the graph's one admission): closed for a self-update's restart; the hook listener asks it too. */
  readonly workAdmission?: import('@goodvibes/engine/platform/platform/runtime/bootstrap').ComposedRuntimeServices['workAdmission'];
  readonly sessionLiveTurnControls: SessionLiveTurnControlsHolder;
  /** Unified live process registry (agents, WRFC chains, workflows, watchers, background processes) backing the Fleet panel; archive-aware, finished subtrees can be moved to the session archive view. */
  readonly processRegistry: ArchivableProcessRegistry;
  readonly modeManager: ModeManager;
  readonly fileUndoManager: FileUndoManager;
  readonly workspaceCheckpointManager: WorkspaceCheckpointManager;
  /** Whether checkpoints are currently permitted for this workspace; re-reads the registration store on every call. */
  readonly checkpointsCurrentlyAllowed: () => boolean;
  /** Surface-scoped continuity reads (recovery-file presence, last-session pointer). */
  readonly integrationHelpers: IntegrationHelperService;
  /** Per-workspace trust gate, restricts write/execute/delegate tools until the workspace is trusted. */
  readonly workspaceTrustManager: operations.WorkspaceTrustManager;
  /**
   * The permission manager the runs this daemon hosts ask through. Its ask seam
   * is the workspace trust gate over the approval broker, so an undecided
   * workspace has the trust question raised as an approval record rather than
   * being treated as trusted (which is what a missing manager means to the
   * background permission gate) or refused without a word.
   */
  readonly permissionManager: PermissionManager;
  /**
   * Cancel the agent runs this graph is hosting, returning how many.
   *
   * The shared poller registry cancels these calls before closing the runner,
   * fleet and process owners they depend on.
   */
  cancelHostedAgentRuns(): number;
  /** Await before replacing this graph or removing its owned files. */
  close(): Promise<void>;
  dispose(): void; // Stops every poller this graph started: best-effort, total, idempotent. This surface owns its graph, and the platform's disposal scope drives it.
}
