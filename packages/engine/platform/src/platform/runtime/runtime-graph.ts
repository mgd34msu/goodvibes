/**
 * runtime-graph.ts, the one runtime graph every product composes.
 *
 * The daemon, the terminal app, the embedded host and the engine's own
 * standalone daemon all build this graph through composeRuntimeServices
 * (services.ts). What differs between them arrives as the explicit choices on
 * ProductComposition; nothing here asks which product it is building for. A
 * product adds what only it has over the finished graph, in its own scope.
 */
import { dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { PRIVATE_DELIVERY_HOSTS_SETTING, parseApprovedHosts } from './network/destination.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import { ServiceRegistry } from '../config/service-registry.js';
import { SubscriptionManager, sharedSubscriptionsPath } from '../config/subscriptions.js';
import { AutomationDeliveryManager, AutomationManager, createAutomationAgentControls } from '../automation/index.js';
import { UnattendedRuns } from '../automation/unattended-runs.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import { ChannelPolicyManager } from '../channels/index.js';
import {
  ApprovalBroker,
  GatewayMethodCatalog,
  SharedSessionBroker,
  controlPlaneStorePath,
  registerFlagsStatusGatewayMethods,
  registerAuthorityStatusGatewayMethods,
  type AuthorityStatusPeers,
  registerGatewayVerbGroups,
  registerNativeAutomationGatewayMethods,
} from '../control-plane/index.js';
import { StepUpService } from '../relay/step-up-service.js';
import { hasFreshSurfaceParticipant, SURFACE_ROUTE_FRESHNESS_MS } from '../control-plane/session-broker-sessions.js';
import { buildContinuationSpawnInput } from './continuation-spawn.js';
import { WatcherRegistry } from '../watchers/index.js';
import { createTriggerSupervisor } from '../triggers/compose.js';
import { ArtifactStore } from '../artifacts/index.js';
import {
  HomeGraphService,
  HOME_GRAPH_KNOWLEDGE_EXTENSION,
  KnowledgeService,
  KnowledgeSemanticService,
  KnowledgeStore,
  ProjectPlanningService,
  ProjectWorkPlan,
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
import { cancelAllAgentRuns } from '../tools/agent/index.js';
import type { AgentOrchestrator } from '../agents/orchestrator.js';
import { PersonalCaptureHolder } from '../personal-capture/index.js';
import { ClusterRoles } from '../cluster/roles.js';
import { ProcessManager } from '../tools/shared/process-manager.js';
import { ModeManager } from '../state/mode-manager.js';
import { FileUndoManager } from '../state/file-undo.js';
import { WorkspaceCheckpointManager } from '../workspace/checkpoint/index.js';
import { MemoryRegistry } from '../state/memory-registry.js';
import { MemoryStore } from '../state/memory-store.js';
import { emitProviderVoiceUsage } from './emitters/providers.js';
import { emitPlanStrategySelected } from './emitters/planner.js';
import { emitAuthorityChanged } from './emitters/security.js';
import { openAuthorityRecordFile } from '../cluster/authority-record-file.js';
import { revocationRetentionFloorMinutes } from '../cluster/group-settings.js';
import { registerRuntimePollers, createRuntimeStopRequests } from './disposal.js';
import type { RuntimeAcquisitionScope } from './acquisition-scope.js';
import { composeJudgment } from './judgment-services.js';
import { createDomainDispatch } from './store/index.js';
import { DistributedRuntimeManager } from './remote/distributed-runtime-manager.js';
import { createRemoteBackendHost } from './remote/host/backend-host.js';
import { IntegrationHelperService } from './integration/helpers.js';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '../voice/index.js';
import { WebSearchProviderRegistry, WebSearchService } from '../web-search/index.js';
import { createConfiguredFetchDeps } from '../tools/fetch/index.js';
import type { LocalhostFetchApproval } from './permissions/localhost-fetch-approval.js';
import { MemoryEmbeddingProviderRegistry } from '../state/memory-embeddings.js';
import { HookActivityTracker } from '../hooks/activity.js';
import { HookDispatcher, createHookWorkbench } from '../hooks/index.js';
import { PluginManager } from '../plugins/manager.js';
import { BookmarkManager } from '../bookmarks/manager.js';
import { ProfileManager } from '../profiles/manager.js';
import { CrossSessionTaskRegistry } from '../sessions/orchestration/index.js';
import { bindPairingRotationLimit, createConfiguredTokenAuditor, startPairingTokenAudit } from './pairing-token-audit.js';
import { UserAuthManager } from '../security/user-auth.js';
import { PairingTokenManager } from '../pairing/pairing-token-store.js';
import { AcpHostService } from '../acp/host.js';
import { WebhookNotifier } from '../integrations/webhooks.js';
import { resolveNotificationWebhook } from '../integrations/notification-webhooks.js';
import { createMcpAutonomousElicitationHandler } from '../mcp/elicitation-autonomous.js';
import { createMcpPersonElicitation } from '../mcp/elicitation.js';
import {
  createApprovalDerivedHandlers,
  createBrokeredPermissionManager,
  createPolicyRuntimeState,
  type ApprovalRaiser,
} from './permissions/permission-composition.js';
import { resolveCanonicalMemoryDbPath } from '../state/canonical-memory.js';
import { repositoryFileGate, WorkspaceTrustManager } from './workspace-trust.js';
import { createWorkspaceTrustDecisionAsk, trustGatedApprovalRaiser, WORKSPACE_TRUST_ASK_TIMEOUT_MS } from './workspace-trust-approval.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from './feature-announcements.js';
import { DeterministicReplayEngine } from '../core/deterministic-replay.js';
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
import { createWiredHealthSystem } from './health/index.js';
import { bindHealthDomainEvents } from './health/domain-events.js';
import { WorktreeRegistry } from './worktree/registry.js';
import { createShellPathService } from './shell-paths.js';
import { disposeRuntimeFeatureFlags, resolveRuntimeFeatureFlags } from './feature-flag-composition.js';
import { attachComposedInstrumentation, releaseComposedTelemetry } from './telemetry/index.js';
import { createProviderStack } from './provider-stack.js';
import { ensureConfiguredModelIsRoutable } from '../providers/fallback-model.js';
import { createAgentExecutionGraph } from './agent-graph-composition.js';
import { bindPermissionModeChangeEvent } from '../permissions/mode-change-emitter.js';
import { describeModeInForceWords } from '../permissions/decision-model-readiness.js';
import { requireSurfaceRoot } from './surface-root.js';
import { createRuntimeSecretsManager } from './secrets-composition.js';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { createNoopKeybindingsManager, createNoopPanelManager } from './host-ui.js';
import { createWorkflowServices } from '../tools/workflow/index.js';
import { createProcessRegistry, withFleetArchive, attachFleetEmitBridge } from './fleet/index.js';
import { attachConfigEmitBridge } from './config/index.js';
import { ObservedAgentSource } from './fleet/observed/source.js';
import { composeContractRunner, resumeContracts } from './contract-composition.js';
import { createContractOperatorService } from '../contract/operator-service.js';
import { fleetCeilingRefusal, makeRuntimeFleetProbe } from './orchestration/fleet-count.js';
import { CacheRegistry, PauseController, wireDaemonMemoryGovernance } from './memory/index.js';
import { DaemonWorkAdmission } from '../daemon/work-admission.js';
import { createSessionStorageServices } from './session-storage-services.js';
import { createChannelComposition } from './channel-composition.js';
import { createRemoteExecutionServices } from './remote-execution-composition.js';
import { createCodeIndexServices, codeIndexDbPath, isCodeInjectionSettingEnabled, type CodeIndexServices } from './code-index-services.js';
import { claimSurfaceHome } from './home-single-writer.js';
import { createDurabilityServices } from './durability-services.js';
import { wireIdlePowerAndLiveTurn } from './idle-power-services.js';
import { wireVoiceSetup } from './voice-setup-services.js';
import { MemorySpineClient, createLocalMemoryAccess } from './memory-spine/index.js';
import { NOTIFICATIONS_METADATA_ONLY_KEY, readNotificationsMetadataOnly } from './notification-privacy.js';
import type { ComposedRuntimeServices, HostedFleetAgentManager, MemoryStoreChoice, ProductComposition } from './services.js';

type AgentToolDependencies = Parameters<AgentOrchestrator['setDependencies']>[0];

/** Jobs the memory governor may pause under pressure. */
const MEMORY_BACKGROUND_JOB_IDS = ['knowledge-self-improvement', 'memory-consolidation', 'code-index-reindex'];

export function resolveMemoryDbPath(choice: MemoryStoreChoice, roots: { readonly workingDir: string; readonly homeDirectory: string }, surfaceRoot: string): string {
  if (choice === 'home') return resolveCanonicalMemoryDbPath(roots.homeDirectory);
  if (choice === 'project') return join(roots.workingDir, '.goodvibes', surfaceRoot, 'memory.sqlite');
  return choice.path;
}

/**
 * Build the graph in `scope`. Every owner is registered where it is
 * constructed, so a constructor that throws part way leaves nothing running
 * once the caller disposes the scope.
 */
export function buildRuntimeGraph<X extends object>(product: ProductComposition<X>, scope: RuntimeAcquisitionScope): ComposedRuntimeServices {
  const roots = product.roots;
  const seams = product.hostSeams;
  const workingDirectory = roots.workingDir;
  const homeDirectory = roots.homeDirectory;
  const surfaceRoot = requireSurfaceRoot(roots.surfaceRoot, 'RuntimeServicesOptions surfaceRoot');
  const runtimeBus = seams.runtimeBus;
  const runtimeStore = seams.runtimeStore;
  const configManager = seams.configManager;
  const nativeDataWriter = seams.nativeDataWriter ?? configManager.getNativeDataWriter();
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  // The single-writer claim comes before anything writes under the home, so a
  // refused second process has changed nothing.
  if (product.homeSingleWriter === 'claim') {
    const claim = claimSurfaceHome({ homeDirectory, surfaceRoot });
    scope.registry.add('surface home claim', () => claim.release());
  }
  // Approvals, watchers and channel policies: per project, or one set per user.
  const resolveStatePath = (...segments: string[]): string => roots.stateScope === 'home'
    ? shellPaths.resolveUserPath(surfaceRoot, ...segments)
    : shellPaths.resolveProjectPath(surfaceRoot, ...segments);
  // Built before anything that touches session state: every session path derives from it.
  const { surface, sessionManager } = createSessionStorageServices({ nativeDataWriter: seams.nativeDataWriter, surfaceRoot, workingDirectory, homeDirectory });
  // A daemon serves the telemetry traces routes, so it records spans unless its settings say otherwise.
  const featureFlags = resolveRuntimeFeatureFlags({ configManager, featureFlags: seams.featureFlags, recordTracesUnlessSet: product.surface === 'daemon' });
  scope.registry.add('feature flag settings bridge', () => disposeRuntimeFeatureFlags(featureFlags));
  // Registered first so it closes last: the tracer sends the spans its exporters still hold after every other teardown has ended its own.
  scope.registry.add('telemetry tracer', () => releaseComposedTelemetry());
  scope.registry.add('telemetry instrumentation', attachComposedInstrumentation(runtimeBus));
  const runtimeDispatch = createDomainDispatch(runtimeStore);

  // Memory governance seams built EARLY: scheduler gates and the knowledge
  // background jobs consult the pause controller and the admission gate before
  // the governor (constructed near the end) binds into them. Until then
  // everything is admitted; the process is still starting.
  const cacheRegistry = new CacheRegistry();
  const pauseController = new PauseController();
  const admitExpensiveWorkRef: { current: ((label: string) => { allowed: boolean; reason?: string | undefined }) | null } = { current: null };
  const admitExpensiveWork = (label: string): { allowed: boolean; reason?: string | undefined } =>
    admitExpensiveWorkRef.current?.(label) ?? { allowed: true };
  const isKnowledgeBackgroundPaused = (): boolean => pauseController.isPaused('knowledge-self-improvement');
  // The one admission (daemon/work-admission.ts): a daemon closes it for a self-update's restart. Every
  // scheduler below asks it before an occurrence starts and leaves a due one due while it is closed.
  const workAdmission = new DaemonWorkAdmission();
  const workAdmitted = (): boolean => workAdmission.open;

  const gatewayMethods = new GatewayMethodCatalog();
  const panelManager = seams.panelManager ?? createNoopPanelManager();
  const keybindingsManager = seams.keybindingsManager ?? createNoopKeybindingsManager();
  const { routeBindings, surfaceRegistry, channelPlugins } = createChannelComposition({ configManager, runtimeStore, runtimeBus, featureFlags });
  // Last-seen times and reply targets held in memory are written on close, after the channels that change them stop.
  scope.registry.add('channel route bindings', () => routeBindings.flush());

  // Credentials and identity.
  const secretsManager = createRuntimeSecretsManager({
    projectRoot: workingDirectory,
    globalHome: homeDirectory,
    surfaceRoot,
    configManager,
    daemonHome: roots.daemonHome ?? resolveGoodVibesDaemonHome(homeDirectory),
  });
  // Its store watches hold it; they end with this composition (registered first, so closed after its consumers).
  scope.registry.add('secret store watches', () => secretsManager.close());
  const judgment = composeJudgment({ config: configManager, secrets: secretsManager, env: process.env, stateRoot: shellPaths.resolveProjectPath(surfaceRoot), disposal: scope.registry });
  // Provider subscriptions live in the SHARED tier so a login completed on one
  // surface is visible to every other.
  const subscriptionManager = new SubscriptionManager(sharedSubscriptionsPath(shellPaths), { secrets: secretsManager });
  const serviceRegistry = new ServiceRegistry({ user: shellPaths.resolveUserPath(surfaceRoot, 'services.json'), project: shellPaths.resolveProjectPath(surfaceRoot, 'services.json') }, {
    secretsManager,
    subscriptionManager,
  });
  const {
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    providerRegistry,
    toolLLM,
    helperModel,
    providerOptimizer,
  } = createProviderStack({
    configManager,
    registerDispose: release => { scope.registry.add('provider model configuration', release); },
    subscriptionManager,
    secretsManager,
    serviceRegistry,
    featureFlags,
    runtimeBus,
    shellPaths,
    surfaceRoot,
    providerRegistryFactory: seams.providerRegistryFactory,
    modelDiscovery: seams.modelDiscovery,
    trustScannedServer: seams.trustScannedServer,
  });
  // Initial custom-provider loading and discovery are owned here too, so a
  // graph that fails before the host receives the registry still settles them.
  scope.registry.add('provider metadata startup', async () => { await Promise.all([providerRegistry.ready(), providerRegistry.modelDiscoverySettled(), benchmarkStore.benchmarksSettled()]); });
  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  // Per-pairing named revocable operator tokens. The cap is read per mint, so a
  // `device.nodes.maxPaired` change applies to the next pairing without a restart.
  // Opened at start, or on first read for a product that chose `on-demand`.
  // Wherever the store is opened (a daemon, or one hosted by a terminal app), managed
  // rotation is enforced where a device token authenticates, and the last-seen times
  // held between writes are written when the graph closes.
  // The authority record: the one answer, on this machine and every machine of
  // its group, to "is this device token, user, grant or peer token current".
  // Beside the pairing file it replaces, so every process of this home reads
  // the same one. Its changes are announced on the bus by kind and id only.
  let authorityPeers: AuthorityStatusPeers | null = null;
  const authorityRecordPath = roots.pairingTokenPath
    ? join(dirname(roots.pairingTokenPath), 'authority-record.json')
    : controlPlaneStorePath(shellPaths, surfaceRoot, 'authority-record.json');
  const authorityRecord = openAuthorityRecordFile(authorityRecordPath, () => configManager.getCategory('cluster'));
  // The retention also decides when a member counts as behind its group, so it
  // must span several gossip rounds: the pair is checked whichever one changes.
  const retentionRefusal = (retentionMinutes: unknown, gossipSeconds: unknown) => {
    const floor = revocationRetentionFloorMinutes(gossipSeconds);
    return typeof retentionMinutes === 'number' && retentionMinutes < floor
      ? { reason: `cluster.revocationRetentionMinutes must be at least ${floor} with cluster.rosterGossipSeconds ${String(gossipSeconds)}: a member is counted behind its group once it has not heard it for that long, so it must span four gossip rounds.`,
        next: [`Set cluster.revocationRetentionMinutes to ${floor} or more`, 'or lower cluster.rosterGossipSeconds first'] }
      : null;
  };
  scope.registry.add('revocation retention rule', configManager.registerWriteAdmission('cluster.revocationRetentionMinutes',
    (value) => retentionRefusal(value, configManager.get('cluster.rosterGossipSeconds'))));
  scope.registry.add('gossip interval retention rule', configManager.registerWriteAdmission('cluster.rosterGossipSeconds',
    (value) => retentionRefusal(configManager.get('cluster.revocationRetentionMinutes'), value)));
  scope.registry.add('authority record events', authorityRecord.onChange((notice) => emitAuthorityChanged(runtimeBus,
    { sessionId: 'system', traceId: `authority:${notice.rev}`, source: 'authority-record' },
    { kinds: notice.keys.map((key) => key.slice(0, key.indexOf(':'))), ids: notice.keys.map((key) => key.slice(key.indexOf(':') + 1)),
      change: notice.change, rev: notice.rev, origin: notice.origin, cascade: notice.cascade.map((key) => key.slice(key.indexOf(':') + 1)) })));
  // Step-up passkeys are on the authority record: one registered or removed on any machine of the group is so on all.
  const stepUpService = new StepUpService({ secrets: secretsManager, authority: authorityRecord });
  let pairingTokensOpened: PairingTokenManager | undefined;
  const pairingTokens = (): PairingTokenManager => {
    if (pairingTokensOpened) return pairingTokensOpened;
    const store = new PairingTokenManager(
      roots.pairingTokenPath ?? controlPlaneStorePath(shellPaths, surfaceRoot, 'pairing-tokens.json'),
      { maxPaired: () => configManager.get('device.nodes.maxPaired'), nativeDataWriter, authority: authorityRecord },
    );
    pairingTokensOpened = store;
    scope.registry.add('pairing rotation limit', bindPairingRotationLimit(store, { configManager, featureFlags }));
    scope.registry.add('pairing last-seen', () => store.flushLastSeen());
    return store;
  };
  const pairingTokensAtStart = (product.pairingTokens ?? 'open') === 'open';
  if (pairingTokensAtStart) pairingTokens();
  const localUserAuthManager = seams.localUserAuthManager ?? new UserAuthManager({
    bootstrapFilePath: shellPaths.resolveUserPath(surfaceRoot, 'auth-users.json'),
    bootstrapCredentialPath: shellPaths.resolveUserPath(surfaceRoot, 'auth-bootstrap.txt'),
    authority: authorityRecord,
  });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath(surfaceRoot, 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath(surfaceRoot, 'bookmarks'));
  const hookActivityTracker = new HookActivityTracker();
  // Hosts on the owner's own network that deliveries he configured may reach, read live on every delivery.
  const privateDeliveryHosts = (): readonly string[] => parseApprovedHosts(configManager.get(PRIVATE_DELIVERY_HOSTS_SETTING));
  // featureFlags is required in practice: a registry without one treats
  // `watchers.enabled` as on, so turning the setting off would change nothing.
  const watcherRegistry = new WatcherRegistry({
    storePath: resolveStatePath('watchers.json'),
    featureFlags,
    recoveryWindowMinutes: () => Number(configManager.get('watchers.recoveryWindowMinutes')),
    resolveHeaderValue: (value) => resolveSecretInput(value, { resolveLocalSecret: (key) => secretsManager.get(key), homeDirectory: secretsManager.getGlobalHome() }, 'dispatch'),
    privateDeliveryHosts,
    workAdmitted,
  });
  scope.ownUntilRegistered('watcher registry', () => watcherRegistry.dispose());
  watcherRegistry.attachRuntime({ runtimeStore, runtimeBus });

  // The agent graph in its one working order. ACP sessions this graph hosts and
  // whatever the product owns beyond its agent runs count against the same ceiling.
  let acpHostRef: AcpHostService | undefined;
  const acpFleetOwnership = (): { id: string; active: boolean }[] => (acpHostRef?.list() ?? []).map(session => ({ id: `acp:${session.id}`, active: true }));
  const { agentMessageBus, archetypeLoader, agentOrchestrator, agentManager, contextAccountingHolder } = createAgentExecutionGraph({
    capturedBunRuntimeExecutable: seams.capturedBunRuntimeExecutable,
    runtimeBus,
    workingDirectory,
    configManager,
    providerRegistry,
    additionalFleetOwnership: () => [...(seams.additionalFleetOwnership?.() ?? []), ...acpFleetOwnership()],
  });
  scope.ownUntilRegistered('agent orchestrator tool registries', () => agentOrchestrator.dispose());
  scope.ownUntilRegistered('hosted agent runs', () => { cancelAllAgentRuns(agentManager); });
  // The late-binding holder for the personal-capture port: the gateway verb
  // groups fill it (they own the owner-profile store and the occasions service).
  const personalCapture = new PersonalCaptureHolder();
  // Which group roles (cluster/roles.ts) this machine holds; the daemon binds it to its coordinator.
  const clusterRoles = new ClusterRoles();
  const hookDispatcher = new HookDispatcher({
    // Withheld only when the product says so by name: an agent hook then spawns nothing.
    ...((product.hookAgentRuns ?? 'attach') === 'attach' ? { agentManager } : {}),
    toolLLM,
    projectRoot: workingDirectory,
  }, hookActivityTracker);
  scope.registry.add('config hook attachment', configManager.attachHookDispatcher(hookDispatcher));
  const hookWorkbench = createHookWorkbench({ hookDispatcher, configManager });
  const approvalBroker = new ApprovalBroker({
    storePath: resolveStatePath('control-plane', 'approvals.jsonl'),
  });
  const sessionBroker = new SharedSessionBroker({
    storePath: roots.sessionStorePath ?? controlPlaneStorePath(shellPaths, surfaceRoot, 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    // Without this the gate runs on defaults: an inbound message landing in a
    // live session takes the handover whatever conversationGate.* says.
    conversationGateConfig: configManager,
  });
  if ((product.continuationRunner ?? 'platform') === 'platform') {
    sessionBroker.setContinuationRunner(async ({ task, input, routeBinding }) => {
      const record = agentManager.spawn(buildContinuationSpawnInput(
        { task, input, ...(routeBinding ? { routeBinding } : {}) },
        { configReader: configManager, modelCandidates: providerRegistry.listModels() },
      ));
      return { agentId: record.id };
    });
  }
  // The broker is the register of session identity, so a task-graph record
  // whose session it does not know, and that is past the reaper's grace
  // floor, is collected. A product whose broker is not that register keeps
  // every record.
  const sessionOrchestration = new CrossSessionTaskRegistry(
    join(surface.sessionsDir, 'task-graph.json'),
    (product.taskGraphReaping ?? 'broker') === 'broker'
      ? { sessionExists: (sessionId: string) => sessionBroker.getSession(sessionId) !== null }
      : {},
  );
  scope.ownUntilRegistered('cross-session task registry', () => sessionOrchestration.dispose());
  const artifactStore = new ArtifactStore({ configManager });
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const memoryDbPath = resolveMemoryDbPath(product.memoryStore, roots, surfaceRoot);
  const memoryStore = new MemoryStore(memoryDbPath, { embeddingRegistry: memoryEmbeddingRegistry });
  // Registered at construction: the scope unwinds newest-first, so the store
  // closes after every scheduler registered later has stopped.
  scope.registry.add('memory store', () => memoryStore.close());
  const memoryRegistry = new MemoryRegistry(memoryStore);
  // Local-until-adopted access for spine-shaped consumers; a client activates
  // the wire transport when it adopts a daemon, the daemon always serves local.
  const memorySpine = new MemorySpineClient({ local: createLocalMemoryAccess(memoryRegistry), log: logger });
  const deliveryManager = new AutomationDeliveryManager({
    configManager,
    // The delivery router replies leave through: without the secrets manager it
    // cannot resolve a goodvibes://secrets/... credential.
    secretsManager,
    serviceRegistry,
    runtimeBus,
    runtimeStore,
    routeBindings,
    artifactStore,
    featureFlags,
  });
  // A run nobody watches (a scheduled run, a trigger's turn): its answer goes to
  // the surface it names, else the owner inbox the host attaches; it gets the
  // mail and calendar tools the host reads as connected.
  const unattendedRuns = new UnattendedRuns(deliveryManager.getDeliveryRouter());
  const automationManager = new AutomationManager({
    configManager,
    defaultSurfaceKind: (product.automationSurfaceKind ?? surfaceRoot) as AutomationSurfaceKind,
    routeBindings,
    sessionBroker,
    runtimeStore,
    runtimeBus,
    deliveryManager,
    providerRegistry,
    featureFlags,
    unattendedRuns,
    workAdmitted,
    // The run's agent is how a run ends: the manager reads its status to
    // settle the run and stops it to cancel the run or end it at its timeout.
    ...createAutomationAgentControls(agentManager, () => unattendedRuns.connectedTools()),
  });
  // In a group, schedules, reminders and url watchers live on the group's
  // record and run on the machine holding the automation role
  // (cluster/group-work.ts); outside one, nothing changes.
  automationManager.attachGroupWork({ file: authorityRecord, roles: clusterRoles });
  watcherRegistry.attachGroupWork({ file: authorityRecord, roles: clusterRoles });

  // Knowledge: the project's store (the wiki, or for a product that chose
  // `agent` the agent's own knowledge, with no wiki), the agent's own knowledge
  // and the home graph, each with its semantic service, all under governor backpressure.
  const wikiStore = product.knowledge === 'agent'
    ? undefined
    : createConfiguredPlanningStore(configManager, REGULAR_KNOWLEDGE_DB_FILE, { nativeDataWriter, family: 'wiki' });
  if (wikiStore) scope.registry.add('knowledge store', () => wikiStore.close());
  const agentKnowledgeStore = wikiStore
    ? KnowledgeStore.forFamily({ nativeDataWriter, configManager, dbFileName: GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, family: 'agent' })
    : createConfiguredPlanningStore(configManager, GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, { nativeDataWriter, family: 'agent' });
  scope.registry.add('agent knowledge store', () => agentKnowledgeStore.close());
  const homeGraphKnowledgeStore = KnowledgeStore.forFamily({ nativeDataWriter, configManager, dbFileName: HOME_GRAPH_KNOWLEDGE_DB_FILE, family: 'home-graph' });
  scope.registry.add('home graph knowledge store', () => homeGraphKnowledgeStore.close());
  // The store planning, the work ledger and native intake read and write.
  const knowledgeStore = wikiStore ?? agentKnowledgeStore;
  const knowledgeStores = [...(wikiStore ? [wikiStore] : []), agentKnowledgeStore, homeGraphKnowledgeStore];
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: configManager.getControlPlaneConfigDir(), stores: knowledgeStores });
  const knowledgeSemanticLlm = createProviderBackedKnowledgeSemanticLlm(providerRegistry, { timeoutMs: 20_000, maxConcurrent: 1 });
  const wikiSemanticService = wikiStore
    ? new KnowledgeSemanticService(wikiStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, isBackgroundPaused: isKnowledgeBackgroundPaused, admitExpensiveWork })
    : undefined;
  if (wikiSemanticService) scope.registry.add('regular knowledge semantic service', () => wikiSemanticService.dispose());
  const homeGraphSemanticService = new KnowledgeSemanticService(homeGraphKnowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, objectProfiles: HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles, isBackgroundPaused: isKnowledgeBackgroundPaused, admitExpensiveWork });
  scope.registry.add('home graph semantic service', () => homeGraphSemanticService.dispose());
  const agentKnowledgeSemanticService = new KnowledgeSemanticService(agentKnowledgeStore, { llm: knowledgeSemanticLlm, maxLlmSourcesPerReindex: 3, isBackgroundPaused: isKnowledgeBackgroundPaused, admitExpensiveWork });
  scope.registry.add('agent knowledge semantic service', () => agentKnowledgeSemanticService.dispose());
  const wikiService = wikiStore && wikiSemanticService
    ? new KnowledgeService(wikiStore, artifactStore, undefined, { memoryRegistry, runtimeBus, semanticService: wikiSemanticService, admitExpensiveWork, workAdmitted })
    : undefined;
  if (wikiService) {
    scope.ownUntilRegistered('knowledge service', () => wikiService.dispose());
    wikiService.attachRuntimeBus(runtimeBus);
  }
  const agentKnowledgeService = new KnowledgeService(agentKnowledgeStore, artifactStore, undefined, { memoryRegistry, runtimeBus, semanticService: agentKnowledgeSemanticService, admitExpensiveWork, workAdmitted });
  scope.ownUntilRegistered('agent knowledge service', () => agentKnowledgeService.dispose());
  agentKnowledgeService.attachRuntimeBus(runtimeBus);
  // With no wiki, the project's knowledge service is the agent's own.
  const knowledgeService = wikiService ?? agentKnowledgeService;
  const homeGraphService = new HomeGraphService(homeGraphKnowledgeStore, artifactStore, { semanticService: homeGraphSemanticService, admitExpensiveWork });
  const { service: projectPlanningService, projectId: projectPlanningProjectId } = ProjectPlanningService.forConfiguredWorkspace(knowledgeStore, configManager, workingDirectory, {
    waitForStartup: () => knowledgeService.whenReady(),
    runtimeBus,
  });
  scope.registry.add('work plan file', () => projectPlanningService.dispose());
  // The project work plan: the planning service's task rows for this project.
  const workPlan = new ProjectWorkPlan({
    service: projectPlanningService,
    projectId: projectPlanningProjectId,
    projectRoot: workingDirectory,
    surface: surfaceRoot,
    exportDirectory: join(homeDirectory, '.goodvibes', surfaceRoot, 'work-plans'),
  });

  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, {
    readConfig: (key) => configManager.get(key as never),
    readConfigIncarnation: () => configManager.getConfigurationIncarnation(),
    managedVoiceRoot: shellPaths.resolveUserPath('voice'),
  });
  // Metered voice spend goes to attribution; local engines emit nothing.
  const voiceService = new VoiceService(voiceProviders, (usage) => emitProviderVoiceUsage(runtimeBus, { sessionId: 'system', traceId: `voice:${Date.now()}`, source: 'voice-service' }, { provider: usage.providerId, modelId: usage.modelId, kind: usage.kind, billableUnits: usage.billableUnits, unit: usage.unit }));
  const webSearchProviders = new WebSearchProviderRegistry({ env: process.env, serviceRegistry });
  // The approval handlers are built further down; a loopback search evidence fetch reads them when it happens.
  let localhostFetchApprovalForSearch: LocalhostFetchApproval | undefined;
  const webSearchService = new WebSearchService(webSearchProviders, createConfiguredFetchDeps({
    serviceRegistry, featureFlags, configManager, localhostFetchApprovalSource: () => localhostFetchApprovalForSearch,
  }));
  for (const [semantic, ingest] of [
    ...(wikiSemanticService && wikiService ? [[wikiSemanticService, wikiService] as const] : []),
    [agentKnowledgeSemanticService, agentKnowledgeService] as const,
    [homeGraphSemanticService, homeGraphService] as const,
  ]) {
    semantic.setGapRepairer(createWebKnowledgeGapRepairer({ searchService: webSearchService, ingestService: ingest }));
  }
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry, {
    // Media generation keys saved in the secret store, not only the environment.
    secrets: secretsManager,
    visionFallbackModel: () => configManager.get('provider.visionFallbackModel').trim() || undefined,
  });
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const pluginManager = new PluginManager({
    pathOptions: { cwd: shellPaths.workingDirectory, homeDir: shellPaths.homeDirectory },
    stateFilePath: shellPaths.resolveUserPath(surfaceRoot, 'plugins.json'),
    // One trust decision per plugin for every app on this machine.
    trustFilePath: shellPaths.resolveUserPath('plugin-trust.json'),
    runtimeBus,
    featureFlags,
  });
  scope.ownUntilRegistered('plugins', () => pluginManager.close());
  const workflow = createWorkflowServices({ workingDirectory: shellPaths.workingDirectory });
  scope.registry.add('hook action dispatch', hookDispatcher.setHookActions(workflow.hookActions, featureFlags));
  // A scheduled command still running when this runtime closes is stopped with it, not left to its own time limit.
  scope.registry.add('workflow schedules', () => workflow.scheduleManager.destroy());
  const channelPolicy = new ChannelPolicyManager({
    storePath: resolveStatePath('channels', 'policies.json'),
  });
  // Peer tokens are on the authority record: a peer paired on one machine of the group works on all of them.
  const distributedRuntime = new DistributedRuntimeManager(shellPaths.resolveProjectPath(surfaceRoot, 'remote', 'distributed-runtime.json'), { authority: authorityRecord });
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });
  // Hosts the daemon runs a command on itself (docker, ssh, cloud terminal, local
  // process). Nothing opens until a backend is listed, registered or invoked.
  const remoteBackends = createRemoteBackendHost({
    workingDirectory,
    homeDirectory,
    credentials: {
      resolveRef: (ref) => resolveSecretInput(ref, { resolveLocalSecret: (key) => secretsManager.get(key), homeDirectory: secretsManager.getGlobalHome() }, 'dispatch'),
    },
    logger,
    isPairedPeer: (peerId) => distributedRuntime.getPeer(peerId) !== null,
  });
  scope.registry.add('remote backends', () => remoteBackends.close());
  // Remote runners and the sandboxes tool calls are confined to, built as one.
  const { remoteRunnerRegistry, remoteSupervisor, sandboxSessionRegistry, mcpRegistry } = createRemoteExecutionServices({
    agentManager, workingDirectory, hookDispatcher, configManager, runtimeBus,
  });
  let mcpClosing: Promise<void> | undefined;
  const closeMcpConnections = (): Promise<void> => mcpClosing ??= mcpRegistry.disconnectAll();
  scope.registry.add('MCP connections', closeMcpConnections);
  // The security.tokenAudit.* settings decide the audit; findings reach the security domain.
  const tokenAuditor = createConfiguredTokenAuditor({ configManager, featureFlags, runtimeBus });
  if (pairingTokensAtStart) scope.registry.add('pairing token audit', startPairingTokenAudit(pairingTokens(), tokenAuditor));
  const healthSystem = createWiredHealthSystem(runtimeBus);
  scope.registry.add('runtime health event bridge', bindHealthDomainEvents(runtimeBus, healthSystem.wiring));
  // One worktree register per working directory, shared by every surface over it,
  // unless the product brings its own.
  const worktreeRegistry = seams.worktreeRegistry?.(workingDirectory) ?? new WorktreeRegistry(workingDirectory);
  const notificationsMetadataOnly = seams.notificationsMetadataOnly
    ?? ((): boolean => readNotificationsMetadataOnly(() => configManager.get(NOTIFICATIONS_METADATA_ONLY_KEY as never)));
  // notifications.webhookUrls holds references; each URL is read from the secret store only for its delivery.
  const webhookNotifier = new WebhookNotifier([], {
    metadataOnly: notificationsMetadataOnly, privateDeliveryHosts,
    resolveTarget: (entry) => resolveNotificationWebhook(entry, secretsManager),
  });
  // It can send memory-pressure notices before boot attaches it; own it now.
  scope.registry.add('shared webhook notifier', () => webhookNotifier.close());
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  // Poll-free runtime event for permission-mode changes so surfaces can render a live mode pill.
  scope.registry.add('permission mode change event', bindPermissionModeChangeEvent(configManager, runtimeBus, 'runtime'));
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workPlan);
  // Each strategy decision /workstream's drafting asks for is published as PLAN_STRATEGY_SELECTED.
  const adaptivePlanner = new AdaptivePlanner({
    onDecision: (decision) => emitPlanStrategySelected(runtimeBus, {
      sessionId: 'system',
      traceId: `planner:select:${decision.timestamp}`,
      source: 'adaptive-planner',
    }, decision),
  });
  const idempotencyStore = new IdempotencyStore();
  const overflowHandler = new OverflowHandler({
    baseDir: workingDirectory,
    featureFlags,
    spillBackend: configManager.get('tools.overflowSpillBackend'),
  });
  // The configured policy bundle is loaded here, and a bundle promoted before is enforced.
  const policyRuntimeState = createPolicyRuntimeState(configManager, featureFlags);
  const fileCache = new FileStateCache();
  const projectIndex = new ProjectIndex(workingDirectory);
  scope.ownUntilRegistered('default workspace project index', () => projectIndex.dispose());
  // Project files changed outside the write and edit tools: the project index
  // forgets deleted ones and Change:file:external hooks fire.
  const fileWatcher = new FileWatcher(projectIndex, { projectRoot: workingDirectory }, hookDispatcher);
  void fileWatcher.start();
  scope.registry.add('file watcher', () => fileWatcher.stop());
  // ONE delivery router: the one replies actually leave through.
  const channelDeliveryRouter = deliveryManager.getDeliveryRouter();
  const processManager = new ProcessManager();
  scope.registry.add('background processes', () => processManager.close());
  // The source-tree index shares memory embeddings; its build is setting-gated.
  // Opened now, or on first read for a product that chose `on-demand`.
  let codeIndexOpened: CodeIndexServices | undefined;
  const openCodeIndex = (): CodeIndexServices => codeIndexOpened ??= createCodeIndexServices({
    workingDirectory,
    // Relative reindex paths resolve against the project index's root, this graph's working directory.
    getWorkingDirectory: () => projectIndex.baseDir,
    surfaceRoot,
    configManager,
    memoryEmbeddingRegistry,
    isReindexPaused: () => pauseController.isPaused('code-index-reindex'),
    whenReindexResumed: () => pauseController.whenResumed('code-index-reindex'),
    admitExpensiveWork,
  });
  const codeIndexAtStart = (product.codeIndex ?? 'open') === 'open' ? openCodeIndex() : undefined;
  scope.registry.add('code index store', () => codeIndexOpened?.codeIndexStore.close());
  scope.ownUntilRegistered('code-index reindex scheduler', () => codeIndexOpened?.codeIndexReindexScheduler.dispose());
  // A host that asked for the index at start builds it whatever the setting says.
  if (seams.autoStartCodeIndex === true) {
    const { codeIndexStore } = openCodeIndex();
    void codeIndexStore.init().then(() => codeIndexStore.scheduleBuild());
  }
  const isCodeIndexEnabled = (): boolean => seams.autoStartCodeIndex === true || isCodeInjectionSettingEnabled(configManager);
  // Store snapshots, the append-only sweep, durable remembered-approval rules,
  // the live credential chain and the config file watch.
  const { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch } = createDurabilityServices({
    configManager,
    secretsManager,
    providerRegistry,
    memoryDbPath,
    codeIndexDbPath: codeIndexDbPath(workingDirectory, surfaceRoot),
    surface,
    shellPaths,
    ...(roots.logDir === undefined ? {} : { logDir: roots.logDir }),
    ...(roots.telemetryDir === undefined ? {} : { telemetryDir: roots.telemetryDir }),
    ...(seams.currentSessionId ? { currentSessionId: seams.currentSessionId } : {}),
    workAdmitted,
  });
  scope.ownUntilRegistered('config file watch', stopConfigWatch);
  scope.ownUntilRegistered('store snapshot scheduler', () => storeSnapshotScheduler.stop());
  scope.ownUntilRegistered('append-only retention scheduler', () => appendOnlyRetentionScheduler.stop());
  scope.ownUntilRegistered('durability housekeeping', stopDurabilityHousekeeping);
  // The trigger family (stream watchers, on-exit process triggers, condition
  // checks). It does no work while `watchers.triggers.enabled` is off.
  const triggerManager = (product.triggers ?? 'run') === 'run'
    ? createTriggerSupervisor({
      configManager,
      resolveStorePath: (name) => shellPaths.resolveProjectPath(surfaceRoot, name),
      agents: agentManager,
      processManager,
      unattendedRuns,
      sessionIsLive: (sessionId: string) => sessionBroker.getSession(sessionId) !== null,
    })
    : undefined;
  if (triggerManager) scope.ownUntilRegistered('trigger manager', async () => { triggerManager.shutdown(); await triggerManager.join(); });

  // Permissions. The product's raiser, behind the workspace trust gate when the
  // product has one: every ask below (tool permissions and the three
  // approval-derived handlers) goes through this one function, so a restricted
  // workspace refuses them all the same way.
  const raiseApproval: ApprovalRaiser = product.permissionHost.raiseApproval?.(approvalBroker, { configManager, featureFlags })
    ?? ((input) => approvalBroker.requestApproval(input));
  const trustChoice = product.workspaceTrust === 'none' ? null
    : product.workspaceTrust === 'surface' ? { kind: 'surface' as const } : product.workspaceTrust;
  const workspaceTrustManager = trustChoice ? new WorkspaceTrustManager({ shellPaths, surfaceRoot }) : undefined;
  const requestApproval: ApprovalRaiser = trustChoice && workspaceTrustManager
    ? trustGatedApprovalRaiser(
      workspaceTrustManager,
      raiseApproval,
      trustChoice.requestTrustDecision ?? createWorkspaceTrustDecisionAsk({ broker: approvalBroker, workingDirectory }),
      // A product's own question has a person at its screen; the broker's question may have nobody attached.
      trustChoice.requestTrustDecision ? {} : { waitMs: WORKSPACE_TRUST_ASK_TIMEOUT_MS },
    )
    : raiseApproval;
  const workspaceTrustFor = trustChoice?.resolveFor && workspaceTrustManager ? trustChoice.resolveFor(workspaceTrustManager) : undefined;
  // What a repository brings (its hooks file, its MCP server files) waits on the owner's trust of the
  // workspace in every product, including one whose own actions pass no trust gate: it reads the same
  // saved decision. An undecided workspace is not trusted.
  const repositoryTrust = workspaceTrustManager ?? new WorkspaceTrustManager({ shellPaths, surfaceRoot });
  const repositoryGate = repositoryFileGate(repositoryTrust, homeDirectory);
  scope.registry.add('repository hooks file trust', hookWorkbench.bindTrustGate(repositoryGate));
  scope.registry.add('repository MCP file trust', mcpRegistry.bindRepositoryTrust(repositoryGate));
  const permissionManager = createBrokeredPermissionManager({
    workspaceTrust: workspaceTrustManager ?? null,
    requestApproval,
    configManager,
    policyRuntimeState,
    hookDispatcher,
    featureFlags,
    userRuleStore: userPermissionRuleStore,
    secretsManager,
  });
  // Ended at the very start of shutdown (stopAutonomousWork), before any owner drains.
  const autonomousLifetime = new AbortController();
  scope.registry.add('autonomous permission lifetime', () => autonomousLifetime.abort());
  const externalPermissionHost = {
    port: judgment.port, permissionManager, config: configManager, signal: autonomousLifetime.signal,
    workspaceTrust: workspaceTrustManager ?? null, workspaceRoot: workingDirectory,
    ...(workspaceTrustFor ? { workspaceTrustFor } : {}),
  };
  const announcementStore = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  // A person at this surface answers a command's terminal prompt (and, in ask-me, the localhost ask) in a model's run.
  const personAttended = product.permissionHost.personElicitation === true;
  const { sandboxEscalationHandler, execPromptAnswerHandler, localhostFetchApproval, onSandboxedRun } = createApprovalDerivedHandlers({
    autonomousHost: externalPermissionHost,
    requestApproval,
    configManager,
    featureFlags,
    announcementStore,
    attended: () => personAttended,
    permissionMode: () => permissionManager.getMode(),
  });
  localhostFetchApprovalForSearch = localhostFetchApproval;
  // ACP/MCP protocol decisions use the same recorded autonomous owner as native tools.
  mcpRegistry.setPermissionHost(externalPermissionHost);
  // A server question the call's own facts cannot answer goes to the person at
  // this surface when there is one; otherwise it is declined and handed back to
  // the agent in the tool result.
  mcpRegistry.setElicitationHandler(product.permissionHost.personElicitation === true
    ? createMcpAutonomousElicitationHandler(externalPermissionHost, createMcpPersonElicitation(requestApproval, configManager))
    : createMcpAutonomousElicitationHandler(externalPermissionHost));
  // Child prose never replaces the original host prompt; absent origins refuse.
  const acpHost = new AcpHostService({
    permissionHost: externalPermissionHost,
    registerSession: ({ id, title, agentTitle, cwd }) => void sessionBroker
      .register({ sessionId: id, kind: 'acp', title, project: cwd, participant: { surfaceKind: 'service', surfaceId: `acp-host:${agentTitle}`, lastSeenAt: Date.now() } })
      .catch(() => { /* best-effort; the fleet row is authoritative */ }),
    // The same count spawning reads: native agents, what the product owns beyond them, and hosted sessions.
    admitSession: () => fleetCeilingRefusal((key) => configManager.get(key as never), agentManager),
  });
  acpHostRef = acpHost;
  let acpClosing: Promise<void> | undefined;
  const closeAcpAgents = (): Promise<void> => acpClosing ??= Promise.allSettled(acpHost.list().map(agent => acpHost.stop(agent.id))).then(results => {
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'Hosted ACP shutdown failed');
  });
  scope.registry.add('hosted ACP agents', closeAcpAgents);
  const stopAutonomousWork = (): void => {
    autonomousLifetime.abort();
    // Stop protocol children before unrelated owners begin draining.
    void Promise.all([closeMcpConnections(), closeAcpAgents()]).catch(() => {});
  };

  // The contract runner over the project's work plan and execution plans. Its
  // units share the fleet ceiling: native agents, whatever else this product
  // owns, and the ACP sessions it hosts.
  const fleetCapacity = makeRuntimeFleetProbe({ readConfig: (key) => configManager.get(key as never), fleet: agentManager });
  const contracts = composeContractRunner({
    nativeDataWriter,
    judgmentLog: judgment.decisionLog,
    surfaceRoot,
    ownerConversationMessages: seams.ownerConversationMessages,
    readAccessFilter: async (path) => (await permissionManager.readAccess(path)) === 'allow',
    admitSetupCommand: async (command, cwd) => {
      const decision = await permissionManager.checkDetailed('exec', { commands: [{ cmd: command }], working_dir: cwd });
      return decision.approved ? { allowed: true } : { allowed: false, reason: `the permission check refused it (${decision.reasonCode})` };
    },
    runtimeBus,
    agentManager,
    agentMessageBus,
    configManager,
    providerRegistry,
    projectRoot: workingDirectory,
    fleetCapacity,
    workPlanService: projectPlanningService,
    planManager,
  });
  scope.ownUntilRegistered('contract runner', () => contracts.dispose());
  const contractRunner = contracts.runner;
  const contractOperator = createContractOperatorService({ runner: contractRunner, workingDirectory });

  // The live process registry over every source manager: archive-aware, folding
  // scheduled jobs, hosted ACP sessions and (when asked) observed host agents.
  const { priceUsage, priceProvenance } = buildPricingSeams(providerRegistry);
  // Workers of daemon-hosted sessions run on each workspace floor's own agent
  // manager; once a host attaches them the fleet lists, cancels and steers them
  // with this runtime's own.
  let hostedFleetAgents: () => readonly HostedFleetAgentManager[] = () => [];
  const fleetAgentManager: HostedFleetAgentManager = {
    list: () => [...agentManager.list(), ...hostedFleetAgents().flatMap((manager) => manager.list())],
    cancel: (id, kind) => agentManager.cancel(id, kind) || hostedFleetAgents().some((manager) => manager.cancel(id, kind)),
    wakeWithSteer: (id, steer, options) => {
      const owner = agentManager.list().some((record) => record.id === id) ? agentManager
        : hostedFleetAgents().find((manager) => manager.list().some((record) => record.id === id));
      return owner?.wakeWithSteer ? owner.wakeWithSteer(id, steer, options) : { woke: false, reason: `No agent ${id} is known to this fleet.` };
    },
  };
  const baseProcessRegistry = createProcessRegistry({
    agentManager: fleetAgentManager,
    contractRunner,
    processManager,
    watcherRegistry,
    ...(triggerManager ? { triggerSupervisor: triggerManager } : {}),
    workflow: {
      workflowManager: workflow.workflowManager,
      hookActions: workflow.hookActions,
      scheduleManager: workflow.scheduleManager,
    },
    approvalBroker,
    sessionBroker,
    messageBus: agentMessageBus,
    automationManager,
    runtimeBus,
    priceUsage,
    priceProvenance,
    codeIndexService: codeIndexAtStart?.codeIndexStore,
    acpHost,
    observedAgents: seams.observeExternalAgents ? new ObservedAgentSource() : undefined,
  });
  const processRegistry = withFleetArchive(baseProcessRegistry);
  scope.ownUntilRegistered('fleet process registry', () => processRegistry.dispose());
  // Fleet lifecycle deltas on the runtime bus `fleet` domain. The bridge watches
  // the unfiltered registry: archiving hides a node, it does not make it new.
  scope.registry.add('fleet event bridge', attachFleetEmitBridge({ registry: baseProcessRegistry, bus: runtimeBus }));
  const sessionPresence = {
    isAttached: (sessionId: string): boolean => {
      const session = sessionBroker.getSession(sessionId);
      return session ? hasFreshSurfaceParticipant(session, Date.now(), SURFACE_ROUTE_FRESHNESS_MS) : false;
    },
  };
  const modeManager = new ModeManager({ featureFlags });
  const fileUndoManager = new FileUndoManager({ onFileChanged: (path) => fileCache.invalidate(path) });
  const checkpointing = seams.workspaceCheckpoints?.({ workspaceRoot: workingDirectory, surface, runtimeBus, configManager, shellPaths })
    ?? defaultWorkspaceCheckpoints({ workspaceRoot: workingDirectory, surface, runtimeBus });
  if (checkpointing.close) scope.registry.add('workspace checkpoint initialization and work', checkpointing.close);
  const workspaceCheckpointManager = checkpointing.manager;

  // Memory consolidation writes the store, so it runs where this product's
  // choice says the writer is; power owns the sleep edge.
  const runsRoutines = seams.runsRoutines ?? ((): boolean => true);
  const { memoryConsolidationScheduler, memoryUsageTracker, stopMemoryUsage, powerManager, sessionLiveTurnControls } = wireIdlePowerAndLiveTurn({
    configManager,
    memoryRegistry: seams.consolidationTarget?.(memoryRegistry, memorySpine) ?? memoryRegistry,
    // Every turn of this process counts its memory use on the store, whichever process consolidates.
    usageRegistry: memoryRegistry,
    runtimeBus,
    isIdle: () => (seams.busySessionCount?.() ?? sessionBroker.countBusySessions()) === 0
      && !pauseController.isPaused('memory-consolidation')
      && admitExpensiveWork('memory consolidation').allowed,
    snapshotTick: () => storeSnapshotScheduler.tick(),
    heartbeat: async () => {
      if (runsRoutines(automationManager)) await automationManager.triggerHeartbeat({ source: 'wake-catchup' });
    },
    ...(seams.powerSeam ? { powerSeam: seams.powerSeam } : {}),
    ...(seams.onConsolidationReceipt ? { onConsolidationReceipt: seams.onConsolidationReceipt } : {}),
  });
  scope.ownUntilRegistered('memory consolidation scheduler', () => memoryConsolidationScheduler.stop());
  scope.registry.add('memory usage', stopMemoryUsage);
  scope.registry.add('runtime power', () => powerManager.stop());
  // The memory governor (on by default, a safety feature) with real cache
  // adapters, then the late-bound admission gate the expensive entry points captured.
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
    runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath(surfaceRoot, 'memory', 'tripwire-receipt.json'),
    knowledgeStores,
    sessionBroker,
    // Async store snapshots keep the governor's 10s shutdown ceiling enforceable.
    onTripwireShutdown: async () => { await storeSnapshotScheduler.snapshotAllAsync('tripwire'); },
    exit: seams.tripwireExit,
  });
  scope.ownUntilRegistered('memory governor', () => memoryGovernor.stop());
  // A stored memory budget or tier the governor refused runs on the shipped
  // limits; the owner is told once per distinct reason.
  if (memoryConfigFallback !== undefined) {
    announcementStore.record(`memory-config-fallback:${memoryConfigFallback}`, `Memory limits: ${memoryConfigFallback}`);
  } else {
    announcementStore.forgetMatching((id) => id.startsWith('memory-config-fallback:'));
  }
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);
  // Managed local-voice provisioning (single-flight install, no-network status).
  const { voiceSetup, startWakeHousekeeping, stopWakeHousekeeping } = wireVoiceSetup({
    configManager, shellPaths, voiceProviders, admitExpensiveWork,
    provisionWakeModelsAtBoot: seams.provisionWakeModelsAtBoot === true,
  });
  scope.ownUntilRegistered('wake-word housekeeping', stopWakeHousekeeping);
  const integrationHelpers = new IntegrationHelperService({
    surface, configManager, featureFlags, automationManager, approvalBroker, sessionBroker, distributedRuntime,
    remoteRunnerRegistry, remoteSupervisor, panelManager, localUserAuthManager, providerRegistry,
    serviceRegistry, subscriptionManager, secretsManager, runtimeStore, runtimeBus,
    getConversationTitle: seams.getConversationTitle,
  });

  // The tool dependencies every agent this graph runs is given.
  let ciAutoWatchObserver: ((toolName: string, args: Record<string, unknown>, success: boolean) => void) | null = null;
  const agentToolDependencies: AgentToolDependencies = {
    contractRunner,
    contractHooks: contractRunner.hooks(),
    ...(product.profileCapture === false ? {} : { personalCapture }),
    sandboxEscalationHandler,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
    permissionManager,
    // Workers' tool calls fire the owner's tool hooks, as a session's own calls do.
    toolCallHooks: hookDispatcher,
    contextAccountingHolder,
    fileCache,
    projectIndex,
    workingDirectory,
    surfaceRoot: surface.surfaceRoot,
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
    memoryEmbeddingRegistry,
    // An index opened on demand is not handed to agents: their turns then search no source tree.
    ...(codeIndexAtStart ? {
      codeIndex: codeIndexAtStart.codeIndexStore,
      isCodeInjectionSettingEnabled: isCodeIndexEnabled,
      codeIndexReindexScheduler: codeIndexAtStart.codeIndexReindexScheduler,
    } : {}),
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
    // Workers can leave a watcher behind them ("tell me when this build exits") on this process's supervisor.
    ...(triggerManager ? { triggers: triggerManager } : {}),
  };
  agentOrchestrator.setDependencies(agentToolDependencies);

  // flags.status is in every host's catalog and the gate manager is this graph's,
  // so every host serves it, whichever verb groups the product registers.
  registerFlagsStatusGatewayMethods(gatewayMethods, featureFlags);
  registerAuthorityStatusGatewayMethods(gatewayMethods, authorityRecord, () => authorityPeers);
  if ((product.gatewayVerbs ?? 'platform') === 'platform') {
    registerGatewayVerbGroups(gatewayMethods, {
      triggerSupervisor: triggerManager, homeDirectory, processRegistry, workspaceCheckpointManager, sessionBroker, secretsManager,
      approvalBroker, watcherRegistry, userPermissionRuleStore, shellPaths, surfaceRoot, runtimeBus, sessionPresence, configManager,
      runtimeStore, channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker,
      channelPolicy, workingDirectory, attemptsController: contractRunner.fleetControls(), contractOperator, stepUpService, memoryRegistry,
      pairingTokens: pairingTokens(), authority: authorityRecord, acpHost, sessionLiveTurnControls, powerManager, memoryGovernor, voiceSetup,
      credentialWrites: { config: configManager, secrets: secretsManager }, approvalRaise: approvalBroker, approvalList: approvalBroker, disposal: scope.registry,
      personalCapture, clusterRoles, ciAutonomousHost: () => externalPermissionHost, onCiAutoWatch: (observer) => { ciAutoWatchObserver = observer; },
      listContracts: () => contractRunner.list({ includeInputSnapshot: false }),
      modeInForce: (chosen, explicitlyChosen) => permissionManager.modeInForce(chosen, explicitlyChosen),
      modeInForceReason: (chosen, explicitlyChosen) => permissionManager.describeModeInForce(chosen, explicitlyChosen).reason,
      modeInForceWords: (chosen, explicitlyChosen) => describeModeInForceWords(configManager, { chosen, explicitlyChosen }),
    });
    scope.registry.add('native automation updates', registerNativeAutomationGatewayMethods(gatewayMethods, { manager: automationManager, host: externalPermissionHost }));
  }
  // Key-level config changes on the runtime bus `config` domain; secret-bearing keys travel by name only.
  scope.registry.add('config event bridge', attachConfigEmitBridge({ config: { subscribe: (key, cb) => configManager.subscribe(key as never, cb as never) }, bus: runtimeBus }));

  // Teardown for every poller started above. RuntimePollerOwners is
  // all-required, so a poller added to this graph cannot compile unnamed.
  const stopRequests = createRuntimeStopRequests(scope.registry, { homeGraphService, memoryGovernor, watcherRegistry });
  const cancelHostedAgentRuns = (): number => cancelAllAgentRuns(agentManager);
  registerRuntimePollers(scope.registry, {
    stopConfigWatch, watcherRegistry: { dispose: stopRequests.watchers }, storeSnapshotScheduler, appendOnlyRetentionScheduler,
    memoryConsolidationScheduler, codeIndexReindexScheduler: { dispose: () => codeIndexOpened?.codeIndexReindexScheduler.dispose() }, sessionOrchestration,
    knowledgeService, agentKnowledgeService, contractRunner: contracts, homeGraphService: { dispose: stopRequests.homeGraph },
    processRegistry, memoryGovernor: { stop: stopRequests.memoryGovernor }, triggerManager, agentOrchestrator, cancelHostedAgentRuns,
  });
  scope.registry.add('durability housekeeping', stopDurabilityHousekeeping);
  scope.registry.add('wake-word housekeeping', stopWakeHousekeeping);
  // Drain plugin work before releasing the graph it can call into.
  scope.registry.add('plugins', () => pluginManager.close());
  // Contracts left on disk resume once the services are up.
  if ((product.contractRecovery ?? 'platform') === 'platform') void resumeContracts(contractRunner, workingDirectory);

  const close = (): Promise<void> => { stopAutonomousWork(); stopRequests.request(); return scope.close(); };
  return {
    workingDirectory,
    nativeDataWriter: seams.nativeDataWriter,
    nativeMutationHost: externalPermissionHost,
    homeDirectory,
    surfaceRoot,
    surface,
    shellPaths,
    clusterRoles,
    authorityRecord,
    setAuthorityPeers: (peers: AuthorityStatusPeers | null) => { authorityPeers = peers; },
    ...(workspaceTrustManager ? { workspaceTrustManager } : {}),
    repositoryTrust,
    permissionManager,
    requestApproval,
    memoryGovernor,
    cacheRegistry,
    pauseController,
    workAdmission,
    configManager,
    featureFlags,
    runtimeBus,
    runtimeStore,
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
    sessionPresence,
    deliveryManager,
    automationManager,
    gatewayMethods,
    artifactStore,
    knowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlan,
    knowledgeStore,
    memoryStore,
    memoryRegistry,
    memorySpine,
    judgment,
    // Getters: a product that chose `on-demand` opens these on first read.
    get codeIndexStore(): CodeIndexServices['codeIndexStore'] { return openCodeIndex().codeIndexStore; },
    get codeIndexReindexScheduler(): CodeIndexServices['codeIndexReindexScheduler'] { return openCodeIndex().codeIndexReindexScheduler; },
    storeSnapshotScheduler,
    appendOnlyRetentionScheduler,
    stopDurabilityHousekeeping,
    startWakeHousekeeping,
    stopWakeHousekeeping,
    memoryConsolidationScheduler,
    memoryUsageTracker,
    powerManager,
    voiceSetup,
    serviceRegistry,
    secretsManager,
    stepUpService,
    subscriptionManager,
    localUserAuthManager,
    get pairingTokens(): PairingTokenManager { return pairingTokens(); },
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
    acpHost,
    tokenAuditor,
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
    helperModel,
    distributedRuntime,
    remoteBackends,
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
    agentToolDependencies,
    unattendedRuns,
    personalCapture,
    featureAnnouncementStore: announcementStore,
    fileCache,
    projectIndex,
    contextAccountingHolder,
    sessionLiveTurnControls,
    contractRunner,
    contractOperator,
    attachHostedFleetAgents: (source) => { hostedFleetAgents = source ?? (() => []); },
    sessionSnapshot: (sessionId, conversation) => ({ ...conversation, contracts: contractRunner.list({ sessionId, includeTerminal: true }) }),
    processManager,
    processRegistry,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    checkpointsCurrentlyAllowed: checkpointing.currentlyAllowed ?? ((): boolean => true),
    integrationHelpers,
    sandboxEscalationHandler,
    execPromptAnswerHandler,
    localhostFetchApproval,
    onSandboxedRun,
    cancelHostedAgentRuns,
    stopAutonomousWork,
    close,
    dispose: (): void => { void close().catch(() => {}); },
  };
}

function defaultWorkspaceCheckpoints(input: {
  readonly workspaceRoot: string;
  readonly surface: ComposedRuntimeServices['surface'];
  readonly runtimeBus: ComposedRuntimeServices['runtimeBus'];
}): { readonly manager: WorkspaceCheckpointManager; readonly currentlyAllowed?: () => boolean; readonly close?: () => void | Promise<void> } {
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: input.workspaceRoot, surface: input.surface, runtimeBus: input.runtimeBus });
  // Initialised now so the automatic turn and agent-run snapshot subscriptions
  // are live before the first TURN_COMPLETED can arrive.
  void manager.init().catch((error: unknown) => {
    logger.warn('WorkspaceCheckpointManager.init failed', { error: summarizeError(error) });
  });
  return { manager };
}
