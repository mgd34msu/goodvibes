import { REGULAR_KNOWLEDGE_DB_FILE, prepareConfiguredProjectContext } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { composeRuntimeServices, registerGateRuntimeEvents, type ComposedRuntimeServices } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { askingQuestions, callingAgentAsker, daemonAgentPresence, useOwnerAnswerReader } from '@goodvibes-jev/engine/platform/platform/agents';
import { createDaemonWorkspaceTrustResolver } from './workspace-trust-composition.js';
import { installNativeHostedConversationOwner } from './native-hosted-conversation-composition.js';
import { createNativeWorkSubmissionHost } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-submission';
import { createNativeConversationIntakeHost, createNativeRequirementProposer, type NativeConversationContinuationOwner } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake';
import { createLocalWorkLedgerReadBinding } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger';
import { prepareGatewayScopePolicyOwner, registerNativeAutomationGatewayMethods, registerWorkLedgerGatewayMethods, registerWorkLedgerImportGatewayMethods, registerNativeWorkExecutionGatewayMethods, registerNativeWorkSubmissionGatewayMethods, registerNativeConversationIntakeGatewayMethods } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { openWorkspaceRegistrationStore, sharedWorkspaceRegisterPath, WorkspaceSwapManager } from '@goodvibes-jev/engine/platform/platform/workspace';
import { GatewayMethodCatalog, createOwnerInbox, ownerInboxStorePath, terminalSessionPresence, type DaemonBrowserGatewayService } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { resolvePairingWebOrigin } from '@goodvibes-jev/engine/platform/platform/pairing';
import { daemonReceiptStoreAt, daemonReceiptsPath } from '@goodvibes-jev/engine/platform/platform/daemon/receipts';
import { MailboxReaders } from '@goodvibes-jev/engine/platform/platform/email';
import { attachWsOnlyGatewayVerbHandlers } from '@goodvibes-jev/engine/terminal-shell';
import { createRuntimeAcquisitionScope } from './acquisition.js';
import { composeMailDeps } from './mail-composition.js';
import { composeBrowserJudgment } from './browser-judgment-composition.js';
import { createNativeWorkLedgerOwner } from './work-ledger-composition.js';
import { CONVERSATIONAL_CONTAINMENT } from '@goodvibes-jev/engine/platform/platform/hosted-sessions';
import { wireMemoryPressureChannelNotice } from './notification-dispatch.js';
import { createWorkspaceCheckpointing, daemonWorkspaceCheckpoints, type WorkspaceCheckpointing } from './workspace-checkpointing.js';
import { createSessionConversationRewindPort } from './conversation-rewind-port.js';
import { createShellPathService } from './index.js';
import type { DaemonHandlerCompositionOptions } from './daemon-handler-composition.js';
import { createDaemonNativeWorkExecutionActivation } from './native-work-execution-activation.js';
import { createBrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';
import { createDevicePostureServices } from './device-posture-composition.js';
// Re-exported so the daemon entrypoint reaches the housekeeping sweep through
// the same module it already imports the runtime graph from. `installDevicePosture`
// is deliberately NOT re-exported: it registers the phone TOOL into a tool
// registry, and the daemon registers no tools, the sweep is the half it needs.
export { startDeviceHousekeeping } from './device-posture-composition.js';
import { createClusterServices, startClusterServices } from './cluster-group-composition.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { observeNativeStartupPhase } from './startup-observation.js';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.js';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.js';

/**
 * Construct the daemon's runtime graph before the outer async handler boundary.
 *
 * The graph itself is the one every product composes (composeRuntimeServices),
 * with the daemon's choices: the home memory store, a workspace trust owner in
 * front of every ask (resolved per directory for autonomous protocol work),
 * jobs attributed to the service surface, and the gateway verbs, the shared
 * session runner and contract recovery left to this product. What only the
 * daemon has (owner inbox, work ledger and native intake, devices, cluster,
 * browser judgment, the ws-only verb surface) is built over it here, in a scope
 * that is torn down before the graph's own owners.
 */
export async function createRuntimeBaseServices(options: RuntimeServicesOptions): Promise<{ services: Omit<RuntimeServices, 'daemonHandlers'>; handlerOptions: Omit<DaemonHandlerCompositionOptions, 'distributedRuntimeReady'>; closeWorkLedger: () => Promise<void>; closeBrowserJudgment: () => Promise<void>; closeAutonomousPermissions: () => void; retireContinuationScope: () => void }> {
  // The daemon's own owners, drained before the composed graph they borrow from.
  const disposalScope = createRuntimeAcquisitionScope('DaemonRuntimeServices');
  let base: ComposedRuntimeServices | undefined;
  let fenceWorkLedger: (() => Promise<void>) | undefined;
  let fenceNativeWork: (() => Promise<void>) | undefined;
  let fenceBrowserJudgment: (() => Promise<void>) | undefined;
  let continuationScopeOwner: ReturnType<GatewayMethodCatalog['attachScopePolicyOwner']> | undefined;
  const retireContinuationScope = () => continuationScopeOwner?.close();
  const autonomousLifetime = new AbortController();
  const closeAutonomousPermissions = (): void => {
    retireContinuationScope();
    autonomousLifetime.abort();
    // Stop protocol children before unrelated plugin/handler owners begin draining.
    base?.stopAutonomousWork();
  };
  let nativeFleetOwnership: ReturnType<typeof createDaemonNativeWorkExecutionActivation>['fleetOwnership'] = () => [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    // Fence immediately, before reverse-order drains can await other owners.
    closeAutonomousPermissions();
    // The registered ledger owner reports any cleanup failure through the scope.
    void fenceWorkLedger?.().catch(() => {});
    void fenceBrowserJudgment?.().catch(() => {});
    const failures: unknown[] = [];
    try { await disposalScope.close(); } catch (error) { failures.push(error); }
    try { await base?.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Runtime graph shutdown failed');
  })();
  try {
    const workingDirectory = options.workingDir;
    const homeDirectory = options.homeDirectory;
    observeNativeStartupPhase('base-project-context');
    await prepareConfiguredProjectContext(options.configManager, workingDirectory, REGULAR_KNOWLEDGE_DB_FILE, { activate: true });
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory });
    // Checkpoints, gated on live workspace registration (workspace-checkpointing.ts).
    // This workspace snapshots the daemon's own sessions' turns; a hosted session
    // in another workspace is snapshotted by that workspace's manager.
    const workspaceCheckpoints = daemonWorkspaceCheckpoints(options.runtimeBus);
    const checkpointingRef: { current?: WorkspaceCheckpointing } = {};
    observeNativeStartupPhase('base-credentials');
    base = composeRuntimeServices({
      surface: 'daemon',
      roots: {
        surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
        workingDir: workingDirectory,
        homeDirectory,
        daemonHome: options.daemonHomeDirectory,
        sessionStorePath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'control-plane', 'sessions.json'),
      },
      memoryStore: 'home',
      // One trust owner in front of every ask; autonomous protocol work in
      // another directory is gated by that directory's owner.
      workspaceTrust: {
        kind: 'surface',
        resolveFor: (workspaceTrustManager) => createDaemonWorkspaceTrustResolver({ workingDirectory, homeDirectory, workspaceTrustManager }),
      },
      permissionHost: {},
      hostSeams: {
        nativeDataWriter: options.nativeDataWriter,
        capturedBunRuntimeExecutable: options.capturedBunRuntimeExecutable,
        runtimeBus: options.runtimeBus,
        runtimeStore: options.runtimeStore,
        configManager: options.configManager,
        featureFlags: options.featureFlags,
        getConversationTitle: options.getConversationTitle,
        localUserAuthManager: options.localUserAuthManager,
        observeExternalAgents: options.observeExternalAgents,
        powerSeam: options.powerSeam,
        // Native work runs count against the same fleet ceiling.
        additionalFleetOwnership: () => nativeFleetOwnership(),
        currentSessionId: options.currentSessionId,
        // Opted into by the real entrypoint only, so a one-shot command and a
        // test composing this graph fetch nothing and start no timer.
        provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true,
        workspaceCheckpoints: (input) => (checkpointingRef.current = createWorkspaceCheckpointing({
          ...input,
          ownsSession: workspaceCheckpoints.ownsSession(workingDirectory, { daemonOwn: true }),
        })),
      },
      // The daemon serves the verb groups below with its own additions.
      gatewayVerbs: 'product',
      // DaemonServer's facade installs the single runner (configureDaemonSessionContinuation)
      // with the conversation gate, the reply queue and the shared-session context.
      continuationRunner: 'product',
      // Recovered in services.ts while the host is already serving.
      contractRecovery: 'product',
      taskGraphReaping: 'never',
      // The daemon is a service, not a terminal: a job it creates is attributed to the service surface.
      automationSurfaceKind: 'service',
    });
    const graph = base;
    const {
      configManager, featureFlags, gatewayMethods, approvalBroker, sessionBroker, channelPolicy, secretsManager,
      providerRegistry, judgment, distributedRuntime, pairingTokens, knowledgeStore, projectPlanningProjectId,
      workPlan, agentManager, automationManager, nativeMutationHost: autonomousHost, triggerManager,
      workspaceTrustManager, workspaceCheckpointManager, contractRunner, contractOperator, hookDispatcher,
      permissionManager, acpHost,
    } = graph;
    const daemonCheckpointing = checkpointingRef.current;
    if (!workspaceTrustManager || !triggerManager || !daemonCheckpointing) throw new Error('The daemon graph was composed without its trust owner, triggers or checkpoints');
    // The daemon's approvals snapshot (approvals.list) reads the decisions the gate reports here.
    disposalScope.registry.add('gate events into the runtime store', registerGateRuntimeEvents(options.runtimeBus, graph.runtimeDispatch));
    const browserJudgment = options.createBrowserJudgment ? options.createBrowserJudgment(judgment)
      : composeBrowserJudgment({ judgment, providers: () => providerRegistry, config: configManager, secrets: secretsManager, methods: gatewayMethods, env: process.env, disposal: disposalScope.registry });
    let browserClosing: Promise<void> | undefined;
    fenceBrowserJudgment = () => browserClosing ??= browserJudgment.close();
    if (options.createBrowserJudgment) disposalScope.registry.add('browser judgment transport', fenceBrowserJudgment);
    // The one owner inbox: this broker's asks plus questions, claims, purchase
    // windows and queued actions, kept in the home's one store that the terminal
    // apps open too. The store opens on first use, not at start-up.
    const ownerInbox = createOwnerInbox({
      approvals: approvalBroker,
      questionsPath: ownerInboxStorePath(shellPaths),
      // Whether the session or agent that asked is open now: a terminal session's marker and file,
      // or this broker's record of it; the daemon's own agents and their channel sessions.
      presence: [daemonAgentPresence(agentManager, sessionBroker), terminalSessionPresence(sessionBroker)],
    });
    disposalScope.registry.add('owner inbox', () => ownerInbox.dispose());
    // This daemon's agents and hosted sessions read their answers from the store directly.
    useOwnerAnswerReader(ownerInbox);
    disposalScope.registry.add('owner answer reader', () => useOwnerAnswerReader(null));
    // A surface with no owner yet never takes its first sender as owner: that sender is held
    // as a claim in the owner inbox, and becomes the owner only when the owner accepts it.
    disposalScope.registry.add('channel owner claims', channelPolicy.attachOwnerInbox(ownerInbox));
    // Where the email inbox (built with the handlers) meets the mailbox reader the facade composes later.
    const mailboxReaders = new MailboxReaders();

    // This daemon's existing owner and host-selected project are authoritative.
    // Request payloads can only verify this binding, never select a store or actor.
    observeNativeStartupPhase('base-knowledge');
    const workLedgerOwner = createNativeWorkLedgerOwner({ projectId: projectPlanningProjectId, knowledgeStore });
    disposalScope.registry.add('native work ledger', workLedgerOwner.close);
    const workLedgerReadBinding = createLocalWorkLedgerReadBinding({
      available: true, projectId: projectPlanningProjectId, actorId: 'host:operator-ledger-read',
      // Gateway checks each request's read:knowledge scope before source provenance leaves the host.
      allowLegacyProvenance: true,
      service: workLedgerOwner.service, authority: workLedgerOwner.authority,
    });
    if (!workLedgerReadBinding.available) throw new Error(workLedgerReadBinding.reason);
    const workLedgerReader = workLedgerReadBinding.client;
    disposalScope.registry.add('native work ledger reader', () => workLedgerReader.dispose());
    fenceWorkLedger = async () => {
      const nativeClosing = fenceNativeWork?.();
      try { workLedgerReader.dispose(); } finally { await Promise.all([nativeClosing, workLedgerOwner.close()]); }
    };
    registerWorkLedgerGatewayMethods(gatewayMethods, workLedgerReader);

    // The paired-phone feature for this host, on the SAME runtime phones pair onto
    // and the SAME approval broker every other confirmation rides. Every `device.*`
    // setting is read live through this; see device-posture-composition.ts.
    const deviceLifetime = new AbortController();
    disposalScope.registry.add('device autonomous lifetime', async () => { deviceLifetime.abort(); await distributedRuntime.writes.drain(); });
    const { devicePosture } = createDevicePostureServices({
      configManager,
      distributedRuntime,
      approvals: approvalBroker,
      signal: AbortSignal.any([deviceLifetime.signal, autonomousLifetime.signal]),
      stateDirectory: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'devices'),
      gatewayMethods,
    });
    disposalScope.registry.add('device housekeeping', () => devicePosture.stopHousekeeping());
    // Which machines on this network are "us", and which of them reads the shared
    // inbox. Both inert until startCluster(), no socket, no key material read;
    // see cluster-group-composition.ts for why they are built together.
    const { clusterGroup, clusterCoordinator } = createClusterServices({ configManager, shellPaths, secretsManager });
    disposalScope.registry.add('cluster group', () => clusterGroup.stop());
    disposalScope.registry.add('cluster coordinator', () => clusterCoordinator.stop('runtime closing'));
    // Browser composition fills this shared holder before async host registration.
    const browserCheckoutSeam = createBrowserCheckoutSeamHolder();
    // The one browser the `browser.*` verbs serve; a session hosted for the Agent drives it too.
    let browserGateway = undefined as DaemonBrowserGatewayService | undefined;

    // The platform verb groups plus what only a daemon serves (gateway-verbs.ts):
    // checkin.*/fleet-needs-input/pairing.* register only when their deps are present.
    // calendar.*/email.* are platform-served; these two let it register (mail-composition.ts).
    const { emailServiceDeps, describeEmailConfigProblem } = composeMailDeps({ configManager, secretsManager,
      registerDispose: (dispose) => { disposalScope.registry.add('mail reply subject sources', dispose); } });
    let ciNativeContinuationRevocation: NonNullable<Parameters<typeof attachWsOnlyGatewayVerbHandlers>[1]['ciNativeContinuationRevocation']> | undefined;
    let ciNativeContinuationOwner: NonNullable<Parameters<typeof attachWsOnlyGatewayVerbHandlers>[1]['ciNativeContinuationOwner']> | undefined;
    let ciAutoWatchObserver: ((tool: string, args: Record<string, unknown>, success: boolean) => void) | undefined;
    attachWsOnlyGatewayVerbHandlers(gatewayMethods, {
      triggerSupervisor: triggerManager,
      // The surface segment every control-plane store path is built from
      // (platform control-plane-store-paths.ts). Required, not defaulted: a default
      // is what let these stores write to the unscoped orphan directory.
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
      homeDirectory, emailServiceDeps, describeEmailConfigProblem, processRegistry: graph.processRegistry,
      onBrowserCheckout: browserCheckoutSeam.set,
      onBrowserGateway: (service) => { browserGateway = service; },
      // The registration-gated surface, not the raw manager: an explicit create in
      // an unregistered workspace refuses with something actionable. Verbs naming a
      // hosted session, or a checkpoint its workspace holds, reach that workspace's manager.
      workspaceCheckpointManager: workspaceCheckpoints.gateway(daemonCheckpointing, workingDirectory),
      conversationRewindPort: createSessionConversationRewindPort(), sessionBroker, secretsManager, stepUpService: graph.stepUpService,
      // Fills the capture port with the owner-profile store and the occasions
      // service, so the `profile` tool a conversational turn is given has
      // somewhere real to write.
      personalCapture: graph.personalCapture,
      // The session intake attributes a sender on this policy's owner allowlist
      // to the owner principal instead of unknown.
      channelPolicy,
      approvalBroker,
      // approvals.raise, a surface CREATING an ask in this broker. Without it the
      // verb is cataloged and unhandled, and a client whose prompt runs outside
      // this process has no way to raise one.
      approvalRaise: approvalBroker,
      // inbox.*, the owner inbox every surface lists and answers.
      ownerInbox,
      // credentials.set / credentials.delete, a credential written THROUGH the
      // control plane, so a client with no access to the daemon's settings file can
      // configure one. The value lands in the daemon's secret tier and the verb
      // never echoes it back.
      credentialWrites: { config: configManager, secrets: secretsManager },
      watcherRegistry: graph.watcherRegistry, userPermissionRuleStore: graph.userPermissionRuleStore, shellPaths, configManager, runtimeStore: options.runtimeStore,
      ciNativeContinuationRevocation: watch => { if (!ciNativeContinuationRevocation) return Promise.reject(new Error('Native CI revocation is unavailable')); return ciNativeContinuationRevocation(watch); },
      ciNativeContinuationOwner: watch => ciNativeContinuationOwner?.(watch) ?? Promise.resolve(undefined),
      ciAutonomousHost: () => autonomousHost, onCiAutoWatch: observer => { ciAutoWatchObserver = observer; },
      channelDeliveryRouter: graph.channelDeliveryRouter, providerRegistry, automationManager, sessionLister: sessionBroker, sessionIntake: sessionBroker,
      workingDirectory, memoryRegistry: graph.memoryRegistry, pairingTokens, sessionLiveTurnControls: graph.sessionLiveTurnControls,
      powerManager: graph.powerManager, memoryGovernor: graph.memoryGovernor, voiceSetup: graph.voiceSetup,
      acpHost, // Registers acp.agents.list (discovery) and acp.sessions.create (spawn). See register-gateway-verb-groups.ts.
      attemptsController: contractRunner.fleetControls(), contractOperator,
      // The check-in reads open contracts for one waiting on the owner's decision.
      listContracts: () => contractRunner.list({ includeInputSnapshot: false }),
      // A reason the daemon itself cannot send pushes reaches the next attached surface.
      daemonReceipts: daemonReceiptStoreAt(daemonReceiptsPath(configManager)),
      relayAvailable: () => configManager.get('relay.enabled') === true,
      pairingWebOrigin: () => resolvePairingWebOrigin(configManager).origin,
      disposal: disposalScope.registry,
      runtimeBus: options.runtimeBus,
      sessionPresence: graph.sessionPresence,
    });
    disposalScope.registry.add('browser checkout seam holder', () => browserCheckoutSeam.clear()); // newer than 'browser sessions' above, so runs first
    disposalScope.registry.add('native automation updates', registerNativeAutomationGatewayMethods(gatewayMethods, { manager: automationManager, host: autonomousHost }));
    // One owner of the saved working directory: POST /config runtime.workingDir and `state set runtime.workingDir` both save through it.
    const workspaceSwap = options.daemonHomeDirectory === undefined ? null : new WorkspaceSwapManager(workingDirectory, {
      runtimeBus: options.runtimeBus, daemonHomeDir: options.daemonHomeDirectory, startOverride: options.workingDirectoryOverride,
    });
    const agentToolDependencies = {
      ...graph.agentToolDependencies,
      ...(workspaceSwap ? { workspaceSwap } : {}),
      // Workers keep the project work plan the work plan view shows.
      workPlan,
      toolExecutionObserver: (tool: string, args: Record<string, unknown>, success: boolean) => ciAutoWatchObserver?.(tool, args, success),
      // A background agent's `query` tool leaves its questions in the same inbox; the agent takes the
      // owner's answer on its next model request, or, if it stopped, on its next run (a channel's next turn).
      ownerQuestions: askingQuestions(ownerInbox, () => callingAgentAsker(agentManager)),
      // Nobody watches a daemon worker's terminal: its exec requires the boundary
      // unless a composed workstream is explicitly granted the host (see
      // native-work-execution-activation.ts).
      execContainment: CONVERSATIONAL_CONTAINMENT,
    };
    graph.agentOrchestrator.setDependencies(agentToolDependencies);
    // The same store instance the workspaces.* verbs write through, so this process orders its own readers and writers.
    const nativeScopes = openWorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(shellPaths), homeDir: homeDirectory,
      daemonStateDir: shellPaths.resolveUserPath() });
    const nativeImport = registerWorkLedgerImportGatewayMethods(gatewayMethods, {
      hostId: workLedgerOwner.importHostId, projectId: projectPlanningProjectId, projectRoot: workingDirectory,
      storeId: knowledgeStore.storagePath, service: workLedgerOwner.service, authority: workLedgerOwner.authority,
      // Work-plan tasks live in the shared plan file; a copy not yet moved there is still read from the knowledge store.
      readSource: (id) => {
        const record = knowledgeStore.getLegacyImportRecord(id);
        return record.source ? record : workPlan.service.readWorkPlanTaskImportRecord(id);
      },
      workPlanTaskImportIds: projectId => [...workPlan.service.listWorkPlanTaskImportIds(projectId), ...knowledgeStore.listWorkPlanTaskImportIds(projectId)],
      scopes: nativeScopes,
      port: judgment.port, decisionLog: judgment.decisionLog,
    });
    disposalScope.registry.add('native legacy import', nativeImport.close);
    const nativeSubmission = createNativeWorkSubmissionHost({ projectRoot: workingDirectory, projectId: projectPlanningProjectId,
      sessionId: `native-work:${projectPlanningProjectId}`, service: workLedgerOwner.service, authority: workLedgerOwner.authority, scopes: nativeScopes });
    disposalScope.registry.add('native work submission', nativeSubmission.close);
    registerNativeWorkSubmissionGatewayMethods(gatewayMethods, nativeSubmission);
    let nativeContinuationOwner: NativeConversationContinuationOwner | undefined;
    const continuationOwner: NativeConversationContinuationOwner = {
      capture: (sessionId, principalId, selectedDiff) => {
        if (!nativeContinuationOwner) throw new Error('Native hosted continuation owner unavailable');
        return nativeContinuationOwner.capture(sessionId, principalId, selectedDiff);
      },
      assertCurrent: (context, principalId, source) => {
        if (!nativeContinuationOwner) throw new Error('Native hosted continuation owner unavailable');
        nativeContinuationOwner.assertCurrent(context, principalId, source);
      },
    };
    observeNativeStartupPhase('base-native-intake-storage');
    const nativeIntake = createNativeConversationIntakeHost({ projectRoot: workingDirectory, projectId: projectPlanningProjectId,
      sessionId: `native-work:${projectPlanningProjectId}`, storage: await knowledgeStore.openNativeConversationStorage(projectPlanningProjectId),
      scopes: nativeScopes, port: judgment.port, decisionLog: judgment.decisionLog, proposer: createNativeRequirementProposer(providerRegistry), continuation: continuationOwner });
    observeNativeStartupPhase('base-native-intake-ready');
    disposalScope.registry.add('native conversation intake', nativeIntake.close);
    registerNativeConversationIntakeGatewayMethods(gatewayMethods, nativeIntake);
    const removeHostedOwner = installNativeHostedConversationOwner(gatewayMethods, { projectId: projectPlanningProjectId,
      projectRoot: workingDirectory, intake: nativeIntake, checkpoints: workspaceCheckpointManager, journalPath: shellPaths.resolveUserPath('native-hosted-turns.json'),
      installContinuationOwner: owner => { nativeContinuationOwner = owner; } });
    disposalScope.registry.add('native hosted conversation binding', removeHostedOwner);
    const nativeWork = createDaemonNativeWorkExecutionActivation({
      nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter(),
      runtimeBus: options.runtimeBus, configManager, providerRegistry,
      projectRoot: workingDirectory, projectId: projectPlanningProjectId,
      sessionId: `native-work:${projectPlanningProjectId}`, acpHost, knowledgeStore,
      nativeScopes, continuationGrants: pairingTokens,
      continuationScopeOwner: { current: () => { if (!continuationScopeOwner) throw new Error('Native CI scope owner is unavailable'); return continuationScopeOwner.current(); } },
      judgmentPort: judgment.port, decisionLog: judgment.decisionLog,
      permissionManager, hookDispatcher, featureFlags, toolDependencies: agentToolDependencies,
      additionalFleetOwnership: () => agentManager.fleetOwnership(), contractOperator,
    });
    ciNativeContinuationRevocation = async watch => (await nativeWork.acquire()).revokeCiWatch(watch);
    ciNativeContinuationOwner = async watch => (await nativeWork.acquire()).recoverCiWatchOwner(watch);
    nativeFleetOwnership = nativeWork.fleetOwnership;
    fenceNativeWork = async () => { await Promise.all([nativeImport.close(), nativeSubmission.close(), nativeIntake.close(), nativeWork.close()]); };
    disposalScope.registry.add('native work execution', nativeWork.close);
    registerNativeWorkExecutionGatewayMethods(gatewayMethods, { projectId: projectPlanningProjectId, acquire: nativeWork.acquire });

    // This process's own memory pressure, to the operator's configured notice
    // destination. Targeted at OPS_MEMORY_PRESSURE rather than subscribed to the
    // whole high-churn 'ops' domain, and sent over the SAME WebhookNotifier the
    // notification verbs keep live and boot-tasks attaches to the bus. There is
    // no panel notification router here: its targets are all screen targets and
    // this product has no screen, see notification-dispatch.ts.
    disposalScope.registry.add('memory pressure notice', wireMemoryPressureChannelNotice(options.runtimeBus, graph.webhookNotifier));

    const services: Omit<RuntimeServices, 'daemonHandlers'> = {
      ...graph,
      workspaceTrustManager,
      triggerManager,
      ownerInbox,
      mailboxReaders,
      workLedger: workLedgerOwner.service,
      workspaceSwap,
      browserJudgment,
      ...(browserGateway ? { browserGateway } : {}),
      devicePosture,
      clusterCoordinator,
      clusterGroup,
      startCluster: () => startClusterServices({ clusterGroup, clusterCoordinator }),
      close,
      dispose: (): void => { void close().catch(() => {}); },
    };
    // Drain plugin work before releasing the graph it can call into.
    disposalScope.registry.add('plugins', () => graph.pluginManager.close());
    // The facade still registers hosted/update/relay/mail handlers. Its constructor
    // completes the facade phase. Where boot is configured, plugin acquisition
    // must also settle before native continuation reads become available. Runtime
    // catalog mutations thereafter revoke first, rather than counting startup work.
    const gatewayPolicyRevision = configManager.getDurableGatewayPolicyRevision;
    continuationScopeOwner = prepareGatewayScopePolicyOwner(gatewayMethods, () => configManager.invalidateExternalPolicy(), options.createBootOperations !== undefined, snapshot => {
      if (configManager.getDurableGatewayPolicyRevision !== gatewayPolicyRevision) throw new Error('Gateway configuration policy owner changed');
      return gatewayPolicyRevision.call(configManager, snapshot);
    });
    disposalScope.registry.add('native CI gateway scope owner', retireContinuationScope);
    const handlerOptions = {
      paymentContinuationOwner: { pairing: pairingTokens, scopes: continuationScopeOwner },
      nativeDataWriter: options.nativeDataWriter,
      gatewayMethods,
      secretsManager,
      configManager,
      workingDirectory,
      homeDirectory,
      shellPaths,
      distributedRuntime,
      clusterCoordinator,
      checkoutSeam: browserCheckoutSeam.get, channelDeliveryRouter: graph.channelDeliveryRouter, inboxFactory: options.inboxFactory,
      mailboxReaders,
      triagePermissionHost: autonomousHost,
      nativeMutationHost: autonomousHost,
      hasProfile: (profileId: string): boolean => { try { graph.profileManager.load(profileId); return true; } catch { return false; } },
    };
    return { services, handlerOptions, closeWorkLedger: () => { retireContinuationScope(); return fenceWorkLedger!(); }, closeBrowserJudgment: () => { retireContinuationScope(); return fenceBrowserJudgment!(); }, closeAutonomousPermissions, retireContinuationScope };
  } catch (startupError) {
    observeNativeStartupPhase('runtime-base-failed');
    try { await close(); }
    catch (cleanupError) { throw new AggregateError([startupError, cleanupError], 'Runtime graph construction and cleanup failed'); }
    throw startupError;
  }
}
