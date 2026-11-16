import { createTerminalMemoryAdmission } from '@goodvibes-jev/engine/terminal-shell/bootstrap-lifecycle';
import { readTuiNotificationsMetadataOnly } from '../config/host-settings.ts';
/**
 * services.ts, the terminal app's composition root, as a CLIENT.
 *
 * Every gateway-serving piece, the `GatewayMethodCatalog`, the
 * inbox/triage/drafts/routing handlers, the cluster group and its election,
 * the device-posture runtime and its housekeeping, the mail service deps,
 * lives in the daemon product. This composition serves no verbs, elects
 * nothing, polls no mailbox, and supervises no remote runner. It builds what
 * a TURN needs in this process and reaches the daemon for the rest. Its
 * automation manager arms no timers while the daemon is on: routines belong to
 * the daemon, and only with the daemon off does the one terminal holding the
 * routine lock run them (runtime/terminal-routines.ts).
 *
 * ── The floor comes from the platform ───────────────────────────────────────────
 *
 * The loop essentials, the agent graph, the model stack, config/secrets/
 * services, hooks, plugins, MCP, the file-tool caches, permissions as a client,
 * the spine clients, are composed by `createClientRuntimeServices`, the platform's
 * one implementation of that shape. Not a fork of it and not a copy of it: the
 * agent product composes the same function, so a wiring step added there
 * cannot silently miss this product.
 *
 * The platform's own note on that shape applies here literally: it is a FLOOR, not a
 * ceiling. Everything below the `createClientRuntimeServices` call is what THIS
 * surface adds on top, views, keybindings, the WRFC controller wired over the
 * client's own `agentManager`, the workstream engine, the fleet read model, the
 * voice stack with its local playback sink, the knowledge stack the recall
 * surfaces read. None of those need daemon furniture; they are simply not
 * required for a turn to run, which is why they are here and not in the platform's
 * client floor.
 *
 * ── The two things that look like daemon furniture and are not ─────────────
 *
 * `sessionBroker` and `approvalBroker` are still constructed. They are this
 * surface's own record of the sessions it is running and the asks it raised,
 * what the transcript, the session browser and the approval card read. They are
 * NOT authoritative: session identity is mirrored to the daemon's spine
 * (register/heartbeat/inputs) and an ask is raised on the daemon
 * (`approvals.raise`) so every other surface can see and answer it. Where the
 * two disagree the daemon's record is the truth, and the client seams in
 * runtime/client/ are what keep them in step.
 */
import { FocusTracker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { AutomationDeliveryManager, AutomationManager } from '@goodvibes-jev/engine/platform/platform/automation';
import { ChannelPolicyManager } from '@goodvibes-jev/engine/platform/platform/channels';
import { ApprovalBroker, GatewayMethodCatalog, SharedSessionBroker, type SharedSessionContinuationOutcome } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { bindHealthDomainEvents, createWiredHealthSystem } from '@goodvibes-jev/engine/platform/platform/runtime/observability';
import { createClientRuntimeServices } from '@goodvibes-jev/engine/platform/platform/runtime/client-services';
import { wireIdlePowerAndLiveTurn } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createAsyncDisposalScope, createRuntimeStopRequests } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { registerSurfaceRuntimePollers } from './disposal-wiring.ts';
import { forwardGatewayMethodsToDaemon } from './gateway-daemon-forward.ts';
import { createAutomationAgentControls } from './automation-spawn.ts';
import { terminalRunsRoutines } from './terminal-routines.ts';
import { buildContinuationSpawnInput } from './continuation-spawn.ts';
import { gateConsolidationToLocalWriter } from './memory-consolidation-gate.ts';
import { composeCredentialServices } from './credential-composition.ts';
import { WatcherRegistry } from '@goodvibes-jev/engine/platform/platform/watchers';
import { assertConfiguredProjectContextReady, createWebKnowledgeGapRepairer } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { createKnowledgeServices } from './knowledge-services.ts';
import { cancelAllAgentRuns } from '@goodvibes-jev/engine/platform/platform/tools';
import { MediaProviderRegistry, ensureBuiltinMediaProviders } from '@goodvibes-jev/engine/platform/platform/media';
import { MultimodalService } from '@goodvibes-jev/engine/platform/platform/multimodal';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
  resolveCanonicalMemoryDbPath,
} from '@goodvibes-jev/engine/platform/platform/state';
import { createApprovalDerivedHandlers } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '@goodvibes-jev/engine/platform/platform/runtime/feature-announcements';
import { createNotificationDispatcher, startNotificationFlush, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from './notification-dispatch.ts';
import { createDurabilityServices } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { MemorySpineClient, createLocalMemoryAccess } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createDomainDispatch } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import {
  DistributedRuntimeManager,
  RemoteRunnerRegistry,
  RemoteSupervisor,
  IntegrationHelperService,
  IdempotencyStore,
  ComponentHealthMonitor,
  WorktreeRegistry,
  createFeatureFlagManager,
  createShellPathService,
} from '@/runtime/index.ts';
import { createSessionStorageServices } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { VoiceProviderRegistry, VoiceService, ensureBuiltinVoiceProviders } from '@goodvibes-jev/engine/platform/platform/voice';
import '@goodvibes-jev/engine/platform/platform/runtime/memory';
import { wireMemoryGovernance } from './memory-governance-services.ts';
import { wireVoiceSetup } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createViewPanelAdapter } from '../views/view-panel-adapter.ts';
import { BookmarkManager } from '@goodvibes-jev/engine/platform/platform/bookmarks';
import { ProfileManager } from '@goodvibes-jev/engine/platform/platform/profiles';
import { SessionChangeTracker } from '@goodvibes-jev/engine/platform/platform/sessions';
import { UserAuthManager } from '@goodvibes-jev/engine/platform/platform/security';
import { createConfiguredTokenAuditor, startPairingTokenAudit } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { WebhookNotifier } from '@goodvibes-jev/engine/platform/platform/integrations';
import { createContractIntake, createContractOperatorService } from '@goodvibes-jev/engine/platform/platform/contract';
import { KeybindingsManager } from '../input/keybindings.ts';
import {
  AdaptivePlanner,
  DeterministicReplayEngine,
  ExecutionPlanManager,
  SessionLineageTracker,
  SessionMemoryStore,
  startReplayRecording,
} from '@goodvibes-jev/engine/platform/platform/core';
import { deriveFeatureStates, bindFeatureSettingsBridge } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { createChannelComposition } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { applyProviderOptimizerConfigMode, bindProviderOptimizerFeatureFlag } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { createFleetServices } from '@goodvibes-jev/engine/terminal-shell';
import {
  codeIndexDbPath,
  createCodeIndexServices,
  isCodeInjectionSettingEnabled,
} from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { WorkspaceTrustManager, trustGatedApprovalRaiser, type WorkspaceTrustLevel } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { ensureConfiguredModelIsRoutable } from '@goodvibes-jev/engine/platform/platform/providers';
import { join } from 'node:path';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { createDaemonVerbCaller } from './client/operator-endpoint.ts';
import { createTerminalApprovalUpdateSubscriber } from './client/approval-updates.ts';
import { createHostedSessionsClient } from './client/hosted-sessions.ts';
import { getSharedHostedSessionRoster } from './client/hosted-roster.ts';
import {
  createClientApprovalRaiser,
  createConversationRewindHost,
  createDaemonConfigClient,
  createDaemonCredentialsClient,
  createDevicesClient,
  createWireSessionDispatch,
  readSurfaceAgentOutcome,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { ClientBuildGuard } from './client/build-floors.ts';
import { createFleetUnionReadModel } from './client/fleet-union.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { VERSION } from '../version.ts';
import { createSessionConversationRewindPort, hasSessionConversation } from './conversation-rewind-port.ts';
import { createFleetReadModel } from '../views/fleet-read-model.ts';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { sandboxAwareApprovalRaiser, sandboxExecAskDepsFromRuntime } from '../permissions/sandbox-exec-gate.ts';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  assertConfiguredProjectContextReady(options.configManager, options.workingDir);
  const disposalScope = createAsyncDisposalScope('RuntimeServices');
  let homeGraphClosing: Promise<void> | undefined;
  let conversationRewindClosing: Promise<void> | undefined;
  let requestStops: (() => void) | undefined;
  try {
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  // Built before anything that touches session state, see session-storage-services.ts.
  const { surface, sessionManager } = createSessionStorageServices({
    nativeDataWriter: options.configManager.getNativeDataWriter(),
    workingDirectory,
    homeDirectory,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
  });
  const configManager = options.configManager;
  const featureFlags = options.featureFlags ?? createFeatureFlagManager();
  if (options.featureFlags === undefined) {
    // Owned manager: gate states derive from domain settings keys + live
    // bridge (mirrors the platform composition root; a passed manager is the caller's to wire).
    featureFlags.loadFromConfig({ flags: deriveFeatureStates(configManager) });
    disposalScope.registry.add('feature settings bridge', bindFeatureSettingsBridge(configManager, featureFlags));
  }

  // ── The client seams: one resolution of "which daemon", shared by all of them.
  const verbs = createDaemonVerbCaller({ configManager, homeDirectory });
  const daemonConfig = createDaemonConfigClient(verbs);
  const devices = createDevicesClient(verbs);
  // Daemon-hosted sessions: the session picker (built in the input layer, which
  // has no config manager to resolve a daemon from) reads the roster; this is
  // the one place that can give it a client. See client/hosted-roster.ts.
  getSharedHostedSessionRoster().bindClient(createHostedSessionsClient(verbs));

  // Built here rather than read off the client composition below because the
  // approval seam it feeds is an INPUT to that composition: the path service is
  // pure (it derives paths, it opens nothing), so building it twice costs
  // nothing and keeps the ordering honest.
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
  // The surface's own record of the asks it raised, what the approval card and
  // the modal read. The AUTHORITATIVE record is the daemon's; the raiser below
  // keeps the two in step (see the platform's client/approval-raiser.ts).
  const approvalBroker = new ApprovalBroker({
    storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'approvals.json'),
  });
  // The late-bound terminal prompt: the UI layer patches the real implementation
  // in after boot, exactly as it always did.
  const localPromptRef: { requestPermission: (request: PermissionPromptRequest) => Promise<PermissionPromptDecision> } = {
    requestPermission: async () => ({ approved: false, remember: false }),
  };
  const liveSessionIdRef: { value: string | null } = { value: null };
  const requestApproval = createClientApprovalRaiser({
    verbs,
    // The platform's raiser cannot honestly default this: it names how THIS surface
    // reports its own decision back to the daemon (`actorSurface`), so every
    // other surface can see where the answer came from. Reproduces the
    // previous hard-coded `actor: 'tui', actorSurface: 'tui'` write-back exactly.
    actor: 'tui',
    sessionId: () => liveSessionIdRef.value,
    // The "local prompt" is this surface's own broker plus the terminal ask:
    // that is what puts the ask on the approval card and in the modal while the
    // daemon holds the record every other surface reads.
    // The signal is the raiser's: a decision made on another surface aborts it,
    // which retires this broker's record and clears the card here.
    localPrompt: () => (request, options) =>
      approvalBroker.requestApproval({
        request,
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(liveSessionIdRef.value ? { sessionId: liveSessionIdRef.value } : {}),
        localPrompt: (prompt) => localPromptRef.requestPermission(prompt),
      }),
    // The push channel for a decision made on another surface. Without it the
    // raiser learns by re-reading the record on an interval; with it a phone's
    // answer reaches this terminal in the time one SSE frame takes. The interval
    // stays as the fallback, see client/approval-updates.ts.
    subscribeApprovalUpdates: createTerminalApprovalUpdateSubscriber({ configManager, homeDirectory }),
  });

  // ── The platform's client floor: everything a turn needs in this process.
  const workspaceTrustManager = new WorkspaceTrustManager({ shellPaths, surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT });
  // The trust question has one owner here: the terminal UI patches `trustPromptRef` once it exists, and
  // every trust gate (the turn's and the workers') asks through `requestTrustDecision`, which keeps a
  // single prompt open however many gates reach an undecided workspace at once.
  const trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> } = {
    requestTrustDecision: async () => 'restricted',
  };
  let pendingTrustDecision: Promise<WorkspaceTrustLevel> | null = null;
  const requestTrustDecision = (): Promise<WorkspaceTrustLevel> => {
    pendingTrustDecision ??= trustPromptRef.requestTrustDecision().finally(() => { pendingTrustDecision = null; });
    return pendingTrustDecision;
  };
  // One gated raiser for every consumer that asks on a worker's or tool's behalf (the client floor and the
  // approval-derived handlers), so a restricted workspace refuses them all the same way.
  // A contained command the turn runs without a prompt must not prompt for a worker either: the sandbox-aware
  // exec gate sits inside the trust gate here exactly as it does for the turn (see createTuiTurnPermissionManager).
  const sandboxAwareRequestApproval = sandboxAwareApprovalRaiser(sandboxExecAskDepsFromRuntime(configManager, featureFlags), requestApproval);
  const trustGatedRequestApproval = trustGatedApprovalRaiser(workspaceTrustManager, sandboxAwareRequestApproval, requestTrustDecision);
  const client = createClientRuntimeServices({
    workspaceTrust: workspaceTrustManager,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    configManager,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDirectory,
    featureFlags,
    // Workers (background agents, subagents) ask through the same trust gate as the turn: a restricted
    // workspace refuses their writes, commands and delegation without raising an approval.
    requestApproval: trustGatedRequestApproval,
    ...(options.modelDiscovery === undefined ? {} : { modelDiscovery: options.modelDiscovery }),
    ...(options.daemonHomeDirectory === undefined ? {} : { daemonHome: options.daemonHomeDirectory }),
  });
  const runtimeDispatch = createDomainDispatch(options.runtimeStore);
  const {
    agentManager,
    agentMessageBus,
    agentOrchestrator,
    archetypeLoader,
    contractRunner,
    contextAccountingHolder,
    providerRegistry,
    providerCapabilityRegistry,
    cacheHitTracker,
    favoritesStore,
    benchmarkStore,
    modelLimitsService,
    toolLLM,
    secretsManager,
    serviceRegistry,
    subscriptionManager,
    hookDispatcher,
    hookActivityTracker,
    hookWorkbench,
    pluginManager,
    workflow,
    artifactStore,
    webSearchProviders,
    webSearchService,
    mcpRegistry,
    sandboxSessionRegistry,
    processManager,
    modeManager,
    fileUndoManager,
    overflowHandler,
    policyRuntimeState,
    fileCache,
    projectIndex,
    sessionOrchestration,
  } = client;
  disposalScope.registry.add('client runtime services', () => client.close());
  const contractOperator = createContractOperatorService({ runner: contractRunner, workingDirectory });
  const contractIntake = createContractIntake({ runner: contractRunner, projectRoot: workingDirectory });

  ensureConfiguredModelIsRoutable(providerRegistry, configManager);
  // Custom providers and model discovery belong to the client composition.

  // A daemon-scoped credential goes to the daemon over `credentials.set`, which
  // writes the value AND points the config key at it in one verified sequence.
  // Everything else stays in this surface's own store.
  const daemonCredentials = createDaemonCredentialsClient(verbs);

  // Memory governance seams built EARLY so the scheduler gates and the knowledge
  // background jobs can consult the pause controller before the MemoryGovernor
  // (constructed at the composition tail) drives it.
  const {
    cacheRegistry,
    pauseController,
    MEMORY_BACKGROUND_JOB_IDS,
    admitExpensiveWorkRef,
    admitExpensiveWork,
    isKnowledgeBackgroundPaused,
  } = createTerminalMemoryAdmission();
  // The operator API's panels.list / panels.open, answered by the modal views.
  const viewPanelAdapter = createViewPanelAdapter();
  const keybindingsManager = new KeybindingsManager({
    configPath: shellPaths.resolveUserPath('tui', 'keybindings.json'),
  });
  // Channel/surface wiring: see channel-composition.ts (incl. the recorded surface-gating divergence note).
  const { routeBindings, surfaceRegistry, channelPlugins } = createChannelComposition({
    configManager,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    featureFlags,
  });
  // This product serves no verbs itself, and with adoptOnly no DaemonServer is
  // constructed, so nothing is ever served off this catalog. It exists because the
  // platform's startExternalServices takes a daemon-grade graph, plugin loading
  // is handed one, and the mail, calendar and review surfaces call it: each
  // built-in verb is answered by the daemon (gateway-daemon-forward.ts).
  const gatewayMethods = new GatewayMethodCatalog();
  forwardGatewayMethodsToDaemon(gatewayMethods, verbs);
  // The credential/identity seam (credential-composition.ts), this
  // installation's own pairing tokens and step-up service.
  const { stepUpService, pairingTokens } = composeCredentialServices({
    workingDirectory,
    homeDirectory,
    configManager,
    ...(options.daemonHomeDirectory === undefined ? {} : { daemonHomeDirectory: options.daemonHomeDirectory }),
    pairingTokenPath: shellPaths.resolveUserPath('control-plane', 'pairing-tokens.json'),
  });
  const localUserAuthManager =
    options.localUserAuthManager ??
    new UserAuthManager({
      bootstrapFilePath: shellPaths.resolveUserPath('tui', 'auth-users.json'),
      bootstrapCredentialPath: shellPaths.resolveUserPath('tui', 'auth-bootstrap.txt'),
    });
  const profileManager = new ProfileManager(shellPaths.resolveUserPath('tui', 'profiles'));
  const bookmarkManager = new BookmarkManager(shellPaths.resolveUserPath('tui', 'bookmarks'));
  // The watcher framework is the daemon's to RUN; this registry is the surface's
  // read/edit handle on the same store, so `/watch` still lists and edits.
  const watcherRegistry = new WatcherRegistry({
    storePath: shellPaths.resolveProjectPath('tui', 'watchers.json'),
    featureFlags,
  });
  watcherRegistry.attachRuntime({
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
  });
  const sessionBroker = new SharedSessionBroker({
    storePath: shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json'),
    routeBindings,
    agentStatusProvider: agentManager,
    messageSender: agentMessageBus,
    conversationGateConfig: configManager, // without this the gate runs on DEFAULTS
  });
  // Work that arrives for a session THIS surface hosts reaches the loop through
  // the same runner whether it came from the local broker or from the daemon's
  // queue. The wire half is inert until bootstrap.ts adopts a daemon (see
  // the platform's client/session-dispatch.ts); binding one runner to both is what stops a
  // continuation delivered over the wire from taking a different path, and a
  // different set of routing options, than one raised locally.
  const wireSessionDispatch = createWireSessionDispatch({
    hostedSessionIds: () => (liveSessionIdRef.value ? [liveSessionIdRef.value] : []),
    // The reply half. A continuation dispatched here runs in THIS process, so
    // the daemon's own completion poll can never see it finish; this is how the
    // answer gets reported back, and how a message that arrived over a channel
    // is answered into that channel instead of into nothing.
    readAgentOutcome: (agentId) => readSurfaceAgentOutcome(agentManager.getStatus(agentId)),
  });
  disposalScope.registry.add('wire session dispatch', () => wireSessionDispatch.stop());
  // A daemon update swaps the daemon binary and leaves this terminal running
  // the build it started with. The daemon announces the minimum client build it
  // accepts on the /status read the attach handshake already makes; when this
  // build is below it the guard latches, the owner is told on the same surface
  // daemon notices already render, and the runner below stops taking
  // shared-session work rather than executing it under superseded rules. See
  // client/build-floors.ts; bootstrap.ts feeds the reads and attaches the
  // notice sink.
  const clientBuildGuard = new ClientBuildGuard({ clientVersion: VERSION });
  // The parameter type comes from the broker's own runner rather than being
  // re-declared: a hand-written copy would drift from the routing options the
  // spawn actually forwards, and the drift would be silent.
  type ContinuationRequest = Parameters<NonNullable<Parameters<typeof sessionBroker.setContinuationRunner>[0]>>[0];
  const continuationRunner = async ({ task, input }: ContinuationRequest): Promise<SharedSessionContinuationOutcome> => {
    // Too old for the live daemon: refuse the work instead of doing it the old
    // way. The owner has already been told to restart this terminal. Held, not
    // declined with null: null reads as "consumed", and the message would be
    // lost instead of waiting for the restarted terminal.
    if (!clientBuildGuard.maySharedSessionWork()) {
      logger.warn('declined a shared-session continuation: this build is below the daemon floor', {
        sessionId: input.sessionId,
        floor: clientBuildGuard.current().floor,
      });
      return { disposition: 'held', reason: 'this terminal build is below the daemon floor; restart it to process this message' };
    }
    const record = agentManager.spawn(buildContinuationSpawnInput({ task, input }, {
      configReader: configManager,
      modelCandidates: providerRegistry.listModels(),
    }));
    return { agentId: record.id };
  };
  sessionBroker.setContinuationRunner(continuationRunner);
  wireSessionDispatch.setContinuationRunner(continuationRunner);
  const memoryEmbeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  // Open the ONE home-scoped canonical store; legacy per-project TUI memory folds in at boot (foldLegacyProjectMemory).
  const memoryDbPath = resolveCanonicalMemoryDbPath(homeDirectory);
  const memoryStore = new MemoryStore(memoryDbPath, {
    embeddingRegistry: memoryEmbeddingRegistry,
  });
  const memoryRegistry = new MemoryRegistry(memoryStore);
  disposalScope.registry.add('memory store', () => memoryStore.close());
  // Local-until-adopted access facade for spine-shaped consumers (the Memory
  // modal): bootstrap.ts activates the wire transport when a compatible
  // external daemon is adopted, same signal as the session spine.
  const memorySpine = new MemorySpineClient({ local: createLocalMemoryAccess(memoryRegistry) });
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
    defaultSurfaceKind: 'tui',
    routeBindings,
    sessionBroker,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    deliveryManager,
    providerRegistry,
    featureFlags,
    // Spawns, reads and stops a routine's agent, so a run settles and its timeout can stop it.
    ...createAutomationAgentControls(agentManager),
  });
  // Knowledge/wiki + home-graph stack (governor backpressure wired in), see knowledge-services.ts.
  const {
    knowledgeStore,
    agentKnowledgeStore,
    homeGraphKnowledgeStore,
    knowledgeSemanticService,
    homeGraphSemanticService,
    agentKnowledgeSemanticService,
    knowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
  } = createKnowledgeServices({
    ownership: disposalScope.registry,
    rewindDrain: () => conversationRewindClosing,
    homeGraphDrain: () => homeGraphClosing,
    configManager,
    providerRegistry,
    artifactStore,
    memoryRegistry,
    runtimeBus: options.runtimeBus,
    workingDirectory,
    homeDirectory,
    isBackgroundPaused: isKnowledgeBackgroundPaused,
    admitExpensiveWork,
  });
  // Voice: the PROVIDERS are local (a spoken turn plays out of this terminal's
  // own speaker), synthesis reaches `voice.tts.stream` when a daemon serves it
  // and falls back to a local provider otherwise; see audio/spoken-turn-wiring.ts.
  const voiceProviders = new VoiceProviderRegistry();
  ensureBuiltinVoiceProviders(voiceProviders, {
    readConfig: (key) => configManager.get(key as Parameters<typeof configManager.get>[0]),
    readConfigIncarnation: () => configManager.getConfigurationIncarnation(),
  });
  const voiceService = new VoiceService(voiceProviders);
  for (const [semantic, ingest] of [
    [knowledgeSemanticService, knowledgeService],
    [agentKnowledgeSemanticService, agentKnowledgeService],
    [homeGraphSemanticService, homeGraphService],
  ] as const) {
    semantic.setGapRepairer(createWebKnowledgeGapRepairer({ searchService: webSearchService, ingestService: ingest }));
  }
  const mediaProviders = new MediaProviderRegistry();
  ensureBuiltinMediaProviders(mediaProviders, artifactStore, providerRegistry);
  const multimodalService = new MultimodalService(artifactStore, mediaProviders, voiceService, knowledgeService);
  const channelPolicy = new ChannelPolicyManager({
    storePath: shellPaths.resolveProjectPath('tui', 'channels', 'policies.json'),
  });
  const distributedRuntime = new DistributedRuntimeManager(shellPaths.resolveProjectPath('tui', 'remote', 'distributed-runtime.json'));
  distributedRuntime.attachRuntime({
    sessionBridge: sessionBroker,
    approvalBridge: approvalBroker,
    automationBridge: automationManager,
  });

  // The MCP registry and sandbox session registry are the client's: it wires the
  // permission host and elicitation handler onto that MCP registry, and the
  // workflow and tool deps hold that sandbox registry, so a second pair would run
  // MCP tools without either and hide sandbox sessions from the workflow.
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager, workingDirectory);
  const remoteSupervisor = new RemoteSupervisor(remoteRunnerRegistry);
  // Audits the paired devices under the security.tokenAudit settings; findings reach the
  // security domain, and the Security screen reads the last audit of record.
  const tokenAuditor = createConfiguredTokenAuditor({ configManager, featureFlags, runtimeBus: options.runtimeBus });
  disposalScope.registry.add('pairing token audit', startPairingTokenAudit(pairingTokens, tokenAuditor));
  const componentHealthMonitor = new ComponentHealthMonitor();
  const healthSystem = createWiredHealthSystem(options.runtimeBus);
  disposalScope.registry.add('runtime health event bridge', bindHealthDomainEvents(options.runtimeBus, healthSystem.wiring));
  const worktreeRegistry = new WorktreeRegistry(workingDirectory);
  const webhookNotifier = new WebhookNotifier([], {
    metadataOnly: () => readTuiNotificationsMetadataOnly(configManager),
  });
  const focusTracker = new FocusTracker();
  const replayEngine = new DeterministicReplayEngine(workingDirectory);
  // Every turn is recorded as a run /replay can load (one line per turn, tool and task event).
  const replayRecording = startReplayRecording({
    runtimeBus: options.runtimeBus,
    replayEngine,
    directory: shellPaths.resolveProjectPath('tui', 'replay'),
    readConfig: (key) => configManager.get(key as Parameters<typeof configManager.get>[0]),
  });
  disposalScope.registry.add('replay recording', () => replayRecording.stop());
  const providerOptimizer = client.providerOptimizer;
  bindProviderOptimizerFeatureFlag(featureFlags, providerOptimizer);
  applyProviderOptimizerConfigMode(configManager, providerOptimizer);
  const sessionMemoryStore = new SessionMemoryStore();
  const sessionLineageTracker = new SessionLineageTracker();
  const sessionChangeTracker = new SessionChangeTracker();
  const planManager = new ExecutionPlanManager(workingDirectory);
  const adaptivePlanner = new AdaptivePlanner();
  const idempotencyStore = new IdempotencyStore();
  // ONE router, not two. This surface used to build a second ChannelDeliveryRouter
  // from the same four arguments AutomationDeliveryManager builds its own from,
  // and expose that second one, so the router on the service surface and the
  // router replies actually leave through were different objects, and a delivery
  // strategy registered on the exposed one reached nothing. The platform's
  // RuntimeServices contract requires the field; it now names the real router.
  const channelDeliveryRouter = deliveryManager.getDeliveryRouter();
  // Repo source-tree code index, sharing memoryEmbeddingRegistry with MemoryStore.
  const { codeIndexStore, codeIndexReindexScheduler } = createCodeIndexServices({
    workingDirectory,
    // A workspace swap moves the project index; relative reindex paths follow it.
    getWorkingDirectory: () => projectIndex.baseDir,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    configManager,
    memoryEmbeddingRegistry,
    isReindexPaused: () => pauseController.isPaused('code-index-reindex'),
    admitExpensiveWork,
  });
  disposalScope.registry.add('code index store', () => codeIndexStore.close());
  // With the daemon enabled (the default) it owns the home's shared housekeeping:
  // the daily copy of the canonical memory store and the wake-model sweep and
  // provisioning. This terminal's own stores (its knowledge files, logs,
  // telemetry and sessions, all under its own surface directory) stay its to keep.
  const daemonOwnsHomeHousekeeping = resolveDaemonEnabled(configManager);
  const codeInjectionOrchestratorDeps = {
    codeIndex: codeIndexStore,
    isCodeInjectionSettingEnabled: () => isCodeInjectionSettingEnabled(configManager),
    codeIndexReindexScheduler,
  };
  // Store snapshots, the periodic append-only sweep, durable remembered-approval rules + the live credential chain.
  const { storeSnapshotScheduler, appendOnlyRetentionScheduler, userPermissionRuleStore, stopDurabilityHousekeeping, stopConfigWatch } =
    createDurabilityServices({
      configManager,
      secretsManager,
      providerRegistry,
      memoryDbPath,
      codeIndexDbPath: codeIndexDbPath(workingDirectory, GOODVIBES_TUI_SURFACE_ROOT),
      surface,
      shellPaths,
      ...(options.currentSessionId ? { currentSessionId: options.currentSessionId } : {}),
    });
  if (daemonOwnsHomeHousekeeping) storeSnapshotScheduler.stop();
  const { processRegistry } = createFleetServices({
    // Shared archive-aware fleet registry, see fleet-services.ts
    agentManager,
    contractRunner,
    codeIndexService: codeIndexStore,
    processManager,
    watcherRegistry,
    workflow,
    approvalBroker,
    sessionBroker,
    messageBus: agentMessageBus,
    automationManager,
    runtimeBus: options.runtimeBus,
    providerRegistry,
  });
  // What the Agents modal reads: this surface's own live registry UNION the
  // adopted daemon's rows. The daemon runs work no registry here knows about
  // (scheduled jobs, channel-driven runs, sessions other surfaces started, the
  // external agents it observes), and a modal showing only half the fleet is
  // worse than one showing none, the half it shows looks complete.
  const fleetReadModel = createFleetUnionReadModel({
    local: createFleetReadModel(processRegistry, options.runtimeBus),
    verbs,
  });
  disposalScope.registry.add('fleet union refresh', () => fleetReadModel.stop());
  // Conversation-scope rewind, from ANY surface. The daemon holds the
  // checkpoint store and answers the files half; the messages live in this
  // process, so this offers them and answers the daemon's questions about them.
  // Started on adoption (bootstrap.ts), released on disposal.
  const conversationRewindHost = createConversationRewindHost({
    verbs,
    // Undo snapshots beside the sessions, so a rewind can still be undone after a restart.
    port: createSessionConversationRewindPort({ undoDir: join(surface.sessionsDir, 'rewind-undo') }),
    hosts: hasSessionConversation,
    label: 'the terminal app',
    surface,
  });
  const requestConversationRewindStop = () => {
    conversationRewindClosing ??= conversationRewindHost.stop();
    return conversationRewindClosing;
  };
  disposalScope.registry.add('conversation rewind host', () => { void requestConversationRewindStop().catch(() => {}); });
  const workspaceCheckpointManager = createWorkspaceCheckpointing({
    workspaceRoot: workingDirectory,
    surface,
    runtimeBus: options.runtimeBus,
    configManager,
  });
  const { memoryConsolidationScheduler, powerManager, sessionLiveTurnControls } = wireIdlePowerAndLiveTurn({
    configManager,
    // Consolidation writes the store, so it runs here only while no daemon owns it.
    memoryRegistry: gateConsolidationToLocalWriter(memoryRegistry, memorySpine),
    runtimeBus: options.runtimeBus,
    isIdle: () =>
      sessionBroker.countBusySessions() === 0 &&
      !pauseController.isPaused('memory-consolidation') &&
      admitExpensiveWork('memory consolidation').allowed,
    snapshotTick: () => storeSnapshotScheduler.tick(),
    // The daemon catches its routines up on wake; a terminal does only while it runs them itself (daemon off).
    heartbeat: async () => {
      if (terminalRunsRoutines(automationManager)) await automationManager.triggerHeartbeat({ source: 'wake-catchup' });
    },
    powerSeam: options.powerSeam,
  });

  const { memoryGovernor } = wireMemoryGovernance({
    configManager,
    runtimeBus: options.runtimeBus,
    cacheRegistry,
    pauseController,
    jobIds: MEMORY_BACKGROUND_JOB_IDS,
    receiptPath: shellPaths.resolveProjectPath('tui', 'memory', 'tripwire-receipt.json'),
    onTripwireShutdown: async () => {
      await storeSnapshotScheduler.snapshotAllAsync('tripwire');
    },
  });
  admitExpensiveWorkRef.current = (label) => memoryGovernor.admitExpensiveWork(label);

  // Managed local-voice provisioning (voice.local.status/install), single-flight
  // one-act install + no-network status; see voice-setup-services.ts.
  const { voiceSetup, stopWakeHousekeeping } = wireVoiceSetup({
    configManager,
    shellPaths,
    voiceProviders,
    admitExpensiveWork,
    provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true && !daemonOwnsHomeHousekeeping,
  });
  void voiceSetup;

  const integrationHelpers = new IntegrationHelperService({
    surface,
    configManager,
    automationManager,
    approvalBroker,
    sessionBroker,
    distributedRuntime,
    remoteRunnerRegistry,
    remoteSupervisor,
    panelManager: viewPanelAdapter,
    localUserAuthManager,
    providerRegistry,
    serviceRegistry,
    subscriptionManager,
    secretsManager,
    runtimeStore: options.runtimeStore,
    runtimeBus: options.runtimeBus,
    getConversationTitle: options.getConversationTitle,
  });
  const promptLifetime = new AbortController();
  disposalScope.registry.add('autonomous tool prompt lifetime', () => promptLifetime.abort());
  const approvalHandlers = createApprovalDerivedHandlers({
    autonomousHost: {
      port: client.judgment.port,
      permissionManager: client.permissionManager,
      config: configManager,
      signal: promptLifetime.signal,
      workspaceTrust: workspaceTrustManager,
    },
    requestApproval: trustGatedRequestApproval,
    configManager,
    featureFlags,
    announcementStore: new FeatureAnnouncementStore(featureAnnouncementsPath(configManager)),
  });
  const { execPromptAnswerHandler, localhostFetchApproval } = approvalHandlers;
  agentOrchestrator.setDependencies({
    ...approvalHandlers,
    permissionManager: client.permissionManager,
    contractRunner,
    contractHooks: contractRunner.hooks(),
    agentManager,
    surfaceRoot: surface.surfaceRoot,
    execPromptAnswerHandler,
    localhostFetchApproval,
    fileCache,
    projectIndex,
    workingDirectory,
    fileUndoManager,
    modeManager,
    processManager,
    agentMessageBus,
    webSearchService,
    channelRegistry: channelPlugins,
    remoteRunnerRegistry,
    knowledgeService,
    memoryRegistry,
    ...codeInjectionOrchestratorDeps, // Agent-run code injection + tool-site reindex
    archetypeLoader,
    configManager,
    providerRegistry,
    providerOptimizer,
    toolLLM,
    serviceRegistry,
    sessionOrchestration,
    featureFlags,
    overflowHandler,
    sandboxSessionRegistry,
    workflowServices: workflow,
    contextAccountingHolder,
  });

  // Give the panel_only notification target a live producer.
  const notificationDispatcher = createNotificationDispatcher(configManager);
  wireRuntimeNotificationBridge(options.runtimeBus, notificationDispatcher);
  wireMemoryPressureNotice(options.runtimeBus, notificationDispatcher);
  disposalScope.registry.add('notification flush', startNotificationFlush(notificationDispatcher));

  const stopRequests = createRuntimeStopRequests(disposalScope.registry, {
    homeGraphService: { dispose: () => { homeGraphClosing = homeGraphService.dispose(); return homeGraphClosing; } },
    memoryGovernor, watcherRegistry, conversationRewind: requestConversationRewindStop,
  });
  requestStops = stopRequests.request;

  const services: RuntimeServices = {
    workingDirectory,
    homeDirectory,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    surface,
    shellPaths,
    workspaceTrustManager,
    trustPromptRef,
    requestTrustDecision,
    configManager,
    featureFlags,
    runtimeBus: options.runtimeBus,
    runtimeStore: options.runtimeStore,
    runtimeDispatch,
    panelManager: viewPanelAdapter,
    keybindingsManager,
    routeBindings,
    surfaceRegistry,
    channelPlugins,
    channelDeliveryRouter,
    watcherRegistry,
    approvalBroker,
    requestApproval,
    daemonVerbs: verbs,
    wireSessionDispatch,
    clientBuildGuard,
    conversationRewindHost,
    gatewayMethods,
    stepUpService,
    pairingTokens,
    devices,
    daemonConfig,
    daemonCredentials,
    localPromptRef,
    liveSessionIdRef,
    localhostFetchApproval,
    execPromptAnswerHandler,
    notificationDispatcher,
    userPermissionRuleStore,
    sessionBroker,
    deliveryManager,
    automationManager,
    artifactStore,
    knowledgeService,
    agentKnowledgeService,
    homeGraphService,
    projectPlanningService,
    projectPlanningProjectId,
    workPlanStore,
    memoryStore,
    memoryRegistry,
    memorySpine,
    serviceRegistry,
    secretsManager,
    subscriptionManager,
    localUserAuthManager,
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
    focusTracker,
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
    permissionManager: client.permissionManager,
    sandboxEscalationHandler: approvalHandlers.sandboxEscalationHandler,
    onSandboxedRun: approvalHandlers.onSandboxedRun,
    contractRunner,
    contractOperator,
    contractIntake,
    judgment: client.judgment,
    sessionSnapshot: (sessionId, conversation) => ({
      ...conversation,
      contracts: contractRunner.list({ sessionId, includeTerminal: true }),
    }),
    processManager,
    codeIndexStore,
    codeIndexReindexScheduler,
    storeSnapshotScheduler,
    appendOnlyRetentionScheduler,
    stopDurabilityHousekeeping,
    stopWakeHousekeeping,
    memoryConsolidationScheduler,
    powerManager,
    memoryGovernor,
    cacheRegistry,
    pauseController,
    sessionLiveTurnControls,
    processRegistry,
    fleetReadModel,
    modeManager,
    fileUndoManager,
    workspaceCheckpointManager,
    integrationHelpers,
    cancelHostedAgentRuns: () => cancelAllAgentRuns(agentManager),
    dispose: (): void => { stopRequests.request(); disposalScope.dispose(); },
    close: (): Promise<void> => { stopRequests.request(); return disposalScope.close(); },
  };
  registerSurfaceRuntimePollers(
    disposalScope.registry,
    {
      ...services,
      homeGraphService: { dispose: stopRequests.homeGraph },
      memoryGovernor: { stop: stopRequests.memoryGovernor },
      watcherRegistry: { dispose: stopRequests.watchers },
    },
    { stopConfigWatch },
  );
  return services;
  } catch (error) {
    // Synchronous construction starts the same owned drain before propagating
    // its failure. Registrations capture only resources already constructed.
    requestStops?.();
    disposalScope.dispose();
    throw error;
  }
}
