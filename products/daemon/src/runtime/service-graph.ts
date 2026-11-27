import { REGULAR_KNOWLEDGE_DB_FILE, normalizeProjectId, prepareConfiguredProjectContext, projectIdentityOfFolder } from '@goodvibes/engine/platform/platform/knowledge';
import { FileStateCache, ProjectIndex } from '@goodvibes/engine/platform/platform/state';
import { projectProxy, requestProject, routeByProject } from '@goodvibes/engine/platform/platform/control-plane';
import { createProjectWorkSet } from './project-work-set.js';
import { whoseTurn } from '@goodvibes/engine/platform/platform/security';
import { mergeKeepingGetters } from './merge-keeping-getters.js';
import { composeRuntimeServices, createBrokeredPermissionManager, registerGateRuntimeEvents, type ComposedRuntimeServices } from '@goodvibes/engine/platform/platform/runtime/bootstrap';
import { askingQuestions, callingAgentAsker, daemonAgentPresence, useOwnerAnswerReader } from '@goodvibes/engine/platform/platform/agents';
import { createDaemonWorkspaceTrustResolver } from './workspace-trust-composition.js';
import { installNativeHostedConversationProjects, type NativeHostedProjectOwner } from './native-hosted-conversation-composition.js';
import { createNativeWorkSubmissionHost } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-submission';
import { createNativeConversationIntakeHost, createNativeRequirementProposer, type NativeConversationContinuationOwner } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake';
import { carryOldWorkRecords, oldPlanningSourceIds, createLocalWorkLedgerReadBinding, createWorkPlans, askUnrecordedWorkCauses, carryProgramContracts } from '@goodvibes/engine/platform/platform/workflow/work-ledger';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '@goodvibes/engine/platform/platform/runtime/feature-announcements';
import { watchProgramSettingsFiles } from '@goodvibes/engine/platform/platform/runtime/program-settings-watch';
import { createWorkstreamDraftService } from '@goodvibes/engine/platform/platform/orchestration';
import { prepareGatewayScopePolicyOwner, registerNativeAutomationGatewayMethods, registerWorkLedgerGatewayMethods, registerNativeWorkExecutionGatewayMethods, registerNativeWorkSubmissionGatewayMethods, registerNativeConversationIntakeGatewayMethods, registerWorkGatewayMethods } from '@goodvibes/engine/platform/platform/control-plane';
import { openWorkspaceRegistrationStore, projectIdentityOf, registeredWorkspaceRoots, sharedWorkspaceRegisterPath, whyNeverAProject } from '@goodvibes/engine/platform/platform/workspace';
import { ApprovalRelay, GatewayMethodCatalog, createOwnerInbox, ownerInboxStorePath, terminalSessionPresence, type DaemonBrowserGatewayService } from '@goodvibes/engine/platform/platform/control-plane';
import { resolvePairingWebOrigin } from '@goodvibes/engine/platform/platform/pairing';
import { describeModeInForceWords, hostApprovalPresentation, hostItemPresenter, noteDaemonFolderRules } from '@goodvibes/engine/platform/platform/permissions';
import { daemonReceiptStoreAt, daemonReceiptsPath } from '@goodvibes/engine/platform/platform/daemon/receipts';
import {
  carryAgentProviderStoresToDaemon, carryProgramSecretsToDaemon, describeProviderStoresCarryForward, describeSecretsCarryForward, resolveGoodVibesDaemonHome,
  SecretsManager, ServiceRegistry,
} from '@goodvibes/engine/platform/platform/config';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { join } from 'node:path';
import { carriedRecordsFile, daemonRunRecordsRoot } from './run-records.js';
import { carryAgentPluginStateForward } from '@goodvibes/engine/platform/platform/plugins';
import { MailboxReaders } from '@goodvibes/engine/platform/platform/email';
import { attachWsOnlyGatewayVerbHandlers } from '@goodvibes/engine/terminal-shell';
import { createAgentStoreRunner } from '@goodvibes/engine/terminal-shell/agent-turn/agent-store-runner';
import { createDaemonChannelSends } from './channel-sends-composition.js';
import { createModelComparisonRunner } from '@goodvibes/engine/terminal-shell/agent-turn/model-compare-runner';
import { createKnowledgeApi } from '@goodvibes/engine/platform/platform/knowledge';
import { createRuntimeAcquisitionScope } from './acquisition.js';
import { composeMailDeps } from './mail-composition.js';
import { composeBrowserJudgment } from './browser-judgment-composition.js';
import { createNativeWorkLedgerOwner } from './work-ledger-composition.js';
import { createProjectTurnFacilities } from './project-turn-facilities.js';
import { refuseChannelChangesWithoutProject } from '@goodvibes/engine/platform/platform/channels';
import { TURN_EXEC_CONTAINMENT } from '@goodvibes/engine/platform/platform/tools';
import { createDaemonCapabilityServices, daemonCapabilityCatalog, loadedDaemonCapabilityCatalog } from '@goodvibes/engine/platform/platform/capabilities';
import { wireMemoryPressureChannelNotice } from './notification-dispatch.js';
import { createWorkspaceCheckpointing, daemonWorkspaceCheckpoints, type WorkspaceCheckpointing } from './workspace-checkpointing.js';
import { createSessionConversationRewindPort, hostedRewindStorage } from './conversation-rewind-port.js';
import { createShellPathService } from './index.js';
import { carryDaemonRecordsAtStart, daemonRecordsRoot, formerDaemonFolders, olderReleaseGroupSettingsWrittenAt } from './daemon-records.js';
import type { DaemonHandlerCompositionOptions } from './daemon-handler-composition.js';
import { createDaemonNativeWorkExecutionActivation } from './native-work-execution-activation.js';
import { createBrowserCheckoutSeamHolder } from './browser-checkout-seam-holder.js';
import { createDevicePostureServices } from './device-posture-composition.js';
import { composeUnattendedRunTools } from './unattended-run-tools.js';
import { registerDevicePhoneTool } from '@goodvibes/engine/platform/platform/devices';
import { installDaemonGoogleRepair } from './google-repair-composition.js';
import { createClusterServices, startClusterServices } from './cluster-group-composition.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';
import { resolveNodeIdentity } from '@goodvibes/engine/platform/platform/cluster';
import { observeNativeStartupPhase } from './startup-observation.js';
import { emitListChanged, emitNativeRequestChanged, onListChanged } from '@goodvibes/engine/platform/platform/runtime/emitters';
import { serveDaemonToNetwork } from './serve-to-network.js';
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

/** One project's Work: its ledger, plans waiting, intake, native runs and native turns (see `buildProjectWork`). */
interface ProjectWork {
  readonly projectId: string;
  readonly reader: Extract<ReturnType<typeof createLocalWorkLedgerReadBinding>, { readonly available: true }>['client'];
  readonly submission: ReturnType<typeof createNativeWorkSubmissionHost>;
  readonly intake: ReturnType<typeof createNativeConversationIntakeHost>;
  readonly activation: ReturnType<typeof createDaemonNativeWorkExecutionActivation>;
  readonly plans: ReturnType<typeof createWorkPlans>;
  readonly hosted: NativeHostedProjectOwner;
  close(): Promise<void>;
}
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
    // The daemon's own folder is not a project: no identity is registered for it (configured-project.ts notAProject).
    await prepareConfiguredProjectContext(options.configManager, workingDirectory, REGULAR_KNOWLEDGE_DB_FILE, { activate: true, notAProject: true });
    // The daemon's own records are in its home, never in the folder it was started in (daemon-records.ts): the
    // same sessions, devices, group identity and the rest whatever that folder is. Carried there once, before any
    // store opens, from every folder a 3.5.0 daemon kept them in.
    const daemonHomeDirectory = options.daemonHomeDirectory ?? resolveGoodVibesDaemonHome(homeDirectory);
    const recordsRoot = daemonRecordsRoot(daemonHomeDirectory);
    carryDaemonRecordsAtStart({ recordsRoot, homeDirectory, daemonHomeDirectory, workingDirectory },
      (line) => daemonReceiptStoreAt(daemonReceiptsPath(options.configManager)).record(line, { audience: 'owner' }));
    const shellPaths = createShellPathService({ workingDirectory, homeDirectory, recordsRoot });
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
        recordsRoot,
        // The daemon's activity log is in its records folder; the retention sweep prunes it there.
        logDir: shellPaths.resolveProjectPath('logs'),
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
        // The daemon's own folder is not a project: no checkpoint store there; a project's are reached by its sessions.
        workspaceCheckpoints: (input) => (checkpointingRef.current = createWorkspaceCheckpointing({
          ...input,
          ownsSession: workspaceCheckpoints.ownsSession(workingDirectory, { daemonOwn: true }),
          notAProject: true,
        })),
      },
      // Nor a code index: a project's turns read their project's (project-turn-facilities.ts).
      codeIndex: 'on-demand',
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
      // A schedule or trigger 3.5.0 kept names no project: it keeps working in the folder that daemon ran in (the most
      // recently used, daemon-records.ts), never this daemon's own folder in its home.
      unplacedRecordsFolder: formerDaemonFolders(homeDirectory, daemonHomeDirectory, workingDirectory)[0],
      // The terminal app's own schedule file, where an earlier one kept schedules (its control-plane folder, and the
      // terminal's own folder): taken once by this daemon when it is not the daemon's own store; left as it was.
      formerJobStores: [
        join(homeDirectory, '.goodvibes', 'tui', 'control-plane', 'automation-jobs.json'),
        join(homeDirectory, '.goodvibes', 'tui', 'automation-jobs.json'),
      ],
    });
    const graph = base;
    const {
      configManager, featureFlags, gatewayMethods, approvalBroker, sessionBroker, channelPolicy, secretsManager,
      providerRegistry, judgment, distributedRuntime, pairingTokens, knowledgeStore,
      workPlan, agentManager, automationManager, nativeMutationHost: autonomousHost, triggerManager,
      workspaceTrustManager, contractRunner: builtContractRunner, contractOperator, hookDispatcher,
      permissionManager, acpHost,
    } = graph;
    // The daemon runs contracts (its graph is composed with the default `contracts: 'run'`).
    if (!builtContractRunner) throw new Error('The daemon\'s graph was composed without its contract runner');
    const contractRunner = builtContractRunner;
    const daemonCheckpointing = checkpointingRef.current;
    if (!workspaceTrustManager || !triggerManager || !daemonCheckpointing) throw new Error('The daemon graph was composed without its trust owner, triggers or checkpoints');
    // A hosted session's workspace is read from its session record, so the
    // checkpoint verbs reach its store after it ended or the daemon restarted.
    workspaceCheckpoints.configure({
      homeDirectory, configManager, shellPaths,
      hostedWorkspaceOf: (sessionId) => {
        const record = sessionBroker.getSession(sessionId);
        return record?.kind === 'hosted' ? record.project : undefined;
      },
      hostedWorkspaces: () => [...new Set(sessionBroker.listSessions(Number.MAX_SAFE_INTEGER, { kind: 'hosted' }).map((record) => record.project))],
    });
    disposalScope.registry.add('hosted workspace checkpoints', () => workspaceCheckpoints.close());
    const hostedRewind = hostedRewindStorage({ shellPaths, homeDirectory });
    // The daemon's approvals snapshot (approvals.list) reads the decisions the gate reports here.
    disposalScope.registry.add('gate events into the runtime store', registerGateRuntimeEvents(options.runtimeBus, graph.runtimeDispatch));
    // A decision log that had to start empty after damage reaches the next terminal or web UI that attaches.
    if (judgment.decisionLogNotice) daemonReceiptStoreAt(daemonReceiptsPath(configManager)).record(judgment.decisionLogNotice);
    // Each terminal program's own secrets, copied once into this daemon's store, which every program reads first
    // (secrets-carry-forward.ts); the programs' files are left as they are. Off the start path: two small reads.
    void carryProgramSecretsToDaemon({ globalHome: homeDirectory, daemonHome: resolveGoodVibesDaemonHome(homeDirectory) }).then((carried) => {
      const line = carried ? describeSecretsCarryForward(carried) : undefined;
      if (line) daemonReceiptStoreAt(daemonReceiptsPath(configManager)).record(line, { audience: 'owner' });
    }).catch((error: unknown) => {
      logger.warn('[daemon] the programs\' secrets could not be carried into the daemon\'s store; they are read where they are', { error: summarizeError(error) });
    });
    // The Agent's own pinned models, providers of your own and services, copied once into the daemon's, which every
    // program reads now (provider-stores-carry-forward.ts); the Agent's files are left as they are. Off the start path.
    void carryAgentProviderStoresToDaemon({ homeDirectory, daemonHome: resolveGoodVibesDaemonHome(homeDirectory) }).then((carried) => {
      const line = carried ? describeProviderStoresCarryForward(carried) : undefined;
      if (line) daemonReceiptStoreAt(daemonReceiptsPath(configManager)).record(line, { audience: 'owner' });
    }).catch((error: unknown) => {
      logger.warn('[daemon] the Agent\'s pinned models, providers and services could not be carried into the daemon\'s; the Agent\'s are left where they are', { error: summarizeError(error) });
    });
    // The Agent's own plugin state (switched on, quarantines, publisher keys), carried once into the one plugin state
    // every program reads now (plugins/state-carry-forward.ts); the Agent's file is left as it is.
    const carriedPlugins = carryAgentPluginStateForward(join(homeDirectory, '.goodvibes'));
    if (carriedPlugins.length > 0) {
      daemonReceiptStoreAt(daemonReceiptsPath(configManager)).record(`The Agent's plugin settings for ${carriedPlugins.join(', ')} now hold in every program.`, { audience: 'owner' });
    }
    const browserJudgment = options.createBrowserJudgment ? options.createBrowserJudgment(judgment)
      : composeBrowserJudgment({ judgment, providers: () => providerRegistry, config: configManager, secrets: secretsManager, methods: gatewayMethods, env: process.env, disposal: disposalScope.registry });
    let browserClosing: Promise<void> | undefined;
    fenceBrowserJudgment = () => browserClosing ??= browserJudgment.close();
    if (options.createBrowserJudgment) disposalScope.registry.add('browser judgment transport', fenceBrowserJudgment);
    // The one owner inbox: this broker's asks plus questions, claims, purchase
    // windows and queued actions, kept in the home's one store that the terminal
    // apps open too. The store opens on first use, not at start-up.
    // This daemon's approvals are stamped with its cluster node, the id the group knows it by (read on the first raise).
    approvalBroker.useHomeNode(() => resolveNodeIdentity({ stateDirectory: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'cluster') }).nodeId);
    const ownerInbox = createOwnerInbox({
      approvals: approvalBroker,
      questionsPath: ownerInboxStorePath(shellPaths),
      // Whether the session or agent that asked is open now: a terminal session's marker and file,
      // or this broker's record of it; the daemon's own agents and their channel sessions.
      presence: [daemonAgentPresence(agentManager, sessionBroker), terminalSessionPresence(sessionBroker)],
    });
    disposalScope.registry.add('owner inbox', () => ownerInbox.dispose());
    // A terminal program's own settings changed inside that program are announced like a change through the daemon.
    disposalScope.registry.add('program settings files', watchProgramSettingsFiles(shellPaths.resolveUserPath()));
    // A Google request that meets no connection, a missing scope, a dead grant or a disabled API repairs it from here.
    disposalScope.registry.add('google connection repair', installDaemonGoogleRepair({ configManager, secretsManager, homeDirectory, permissionManager, ownerInbox }));
    // Every item carries its words (question, consequence, choices) on the wire, worded with this host's facts.
    const askFactsSource = {
      configManager, homeDirectory, sessionTitle: (id: string) => sessionBroker.getSession(id)?.title,
      // A schedule's run makes its own session (automation/manager-runtime-execution.ts): a purchase it begins says "From your schedule <name>".
      scheduleOfSession: (id: string) => {
        const jobId = sessionBroker.getSession(id)?.metadata['jobId'];
        return typeof jobId === 'string' ? automationManager.getJob(jobId)?.name : undefined;
      },
    };
    ownerInbox.usePresentation(hostItemPresenter(askFactsSource));
    // The same words ride every approval-update frame and approvals.list row, so no surface reads the inbox to word an approval.
    approvalBroker.usePresentation((request, sessionId) => hostApprovalPresentation(askFactsSource, request, sessionId));
    // This daemon's agents and hosted sessions read their answers from the store directly.
    useOwnerAnswerReader(ownerInbox);
    disposalScope.registry.add('owner answer reader', () => useOwnerAnswerReader(null));
    // A surface with no owner yet never takes its first sender as owner: that sender is held
    // as a claim in the owner inbox, and becomes the owner only when the owner accepts it.
    disposalScope.registry.add('channel owner claims', channelPolicy.attachOwnerInbox(ownerInbox));
    // A scheduled run or trigger turn that names no surface, or whose send failed, leaves its answer here.
    disposalScope.registry.add('unattended answers to the owner inbox', graph.unattendedRuns.attachOwnerInbox(ownerInbox));
    // Scheduled runs and trigger turns get the mail and calendar tool once the owner has connected either.
    const unattendedRunTools = composeUnattendedRunTools({
      configManager, secretsManager, homeDirectory, artifactStore: graph.artifactStore, gatewayMethods, unattendedRuns: graph.unattendedRuns,
    });
    disposalScope.registry.add('unattended run tools', unattendedRunTools.stop);
    // Where the email inbox (built with the handlers) meets the mailbox reader the facade composes later.
    const mailboxReaders = new MailboxReaders();

    observeNativeStartupPhase('base-knowledge');
    // The daemon's own folder is no project and has no Work: every piece of work, its ledger and its runs are the
    // project's its request names (Work per project, below); fencing Work fences every project's.
    fenceWorkLedger = async () => { await fenceNativeWork?.(); };

    // The paired-phone feature for this host, on the SAME runtime phones pair onto
    // and the SAME approval broker every other confirmation rides. Every `device.*`
    // setting is read live through this; see device-posture-composition.ts.
    const deviceLifetime = new AbortController();
    disposalScope.registry.add('device autonomous lifetime', async () => { deviceLifetime.abort(); await distributedRuntime.writes.drain(); });
    const { devicePosture } = createDevicePostureServices({
      configManager,
      distributedRuntime,
      approvals: approvalBroker,
      authority: graph.authorityRecord,
      signal: AbortSignal.any([deviceLifetime.signal, autonomousLifetime.signal]),
      stateDirectory: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'devices'),
      gatewayMethods,
    });
    disposalScope.registry.add('device housekeeping', () => devicePosture.stopHousekeeping());
    // Which machines on this network are "us", and which of them reads the shared
    // inbox. Both inert until startCluster(), no socket, no key material read;
    // see cluster-group-composition.ts for why they are built together.
    const { clusterGroup, clusterCoordinator } = createClusterServices({ configManager, shellPaths, secretsManager,
      authorityRecord: graph.authorityRecord, setAuthorityPeers: graph.setAuthorityPeers,
      // Put back to 3.5.0 since the upgrade: its group-settings changes from that run are marked the owner's once.
      olderReleaseRanAt: olderReleaseGroupSettingsWrittenAt({ recordsRoot, homeDirectory, daemonHomeDirectory, workingDirectory }),
      // A group action finished (or not) at start after the restart it needed: said once, in the owner's inbox.
      // A notice: it needs no answer, only "Mark as read" (`read`), as the other reports.
      tellOwner: (title, detail) => { ownerInbox.postNow({ kind: 'report', key: 'cluster-pending-action', askedBy: 'your machine group', title, detail, options: ['read'] }, 'cluster'); } });
    disposalScope.registry.add('cluster group', () => clusterGroup.stop());
    // In a group, the members' approvals are read and decided through each other: the home node decides
    // (approval-relay.ts). Outside a group nothing is sent and only this daemon's approvals are listed.
    const approvalRelay = new ApprovalRelay(clusterGroup.runtime.tenantHost(), approvalBroker);
    approvalBroker.useRelay(approvalRelay);
    disposalScope.registry.add('approval relay', () => { approvalBroker.useRelay(null); approvalRelay.close(); });
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
    // A project's own plans before they run, once Work per project is composed (below).
    let workPlansForProject: ((folder: string) => Promise<ReturnType<typeof createWorkPlans>>) | undefined;
    let ciNativeContinuationRevocation: NonNullable<Parameters<typeof attachWsOnlyGatewayVerbHandlers>[1]['ciNativeContinuationRevocation']> | undefined;
    let ciNativeContinuationOwner: NonNullable<Parameters<typeof attachWsOnlyGatewayVerbHandlers>[1]['ciNativeContinuationOwner']> | undefined;
    let ciNativeContinuationReconcile: NonNullable<Parameters<typeof attachWsOnlyGatewayVerbHandlers>[1]['ciNativeContinuationReconcile']> | undefined;
    let ciAutoWatchObserver: ((tool: string, args: Record<string, unknown>, success: boolean, turn: { readonly project?: string | undefined }) => void) | undefined;
    // The methods that hold a request open while they wait (a host's take of rewind questions): ended by the daemon's
    // stop before it closes its listener, which waits for every running request (services.endLongWaits below).
    const longWaitEnds: { readonly label: string; readonly end: () => void }[] = [];
    attachWsOnlyGatewayVerbHandlers(gatewayMethods, {
      longWaits: { add: (label, end) => { longWaitEnds.push({ label, end }); } },
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
      // The conversations of the sessions this daemon hosts: their undo snapshots and turn boundaries outlive a restart.
      conversationRewindPort: createSessionConversationRewindPort({ undoDir: hostedRewind.undoDir }),
      rewindAnchorSurface: hostedRewind.anchorSurface,
      sessionBroker, secretsManager, stepUpService: graph.stepUpService,
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
      // A posted question names a session as its asker only when its poster registered that session.
      sessionRegistrant: (sessionId: string) => sessionBroker.registrantOf(sessionId),
      // credentials.set / credentials.delete, a credential written THROUGH the
      // control plane, so a client with no access to the daemon's settings file can
      // configure one. The value lands in the daemon's secret tier and the verb
      // never echoes it back.
      credentialWrites: { config: configManager, secrets: secretsManager },
      watcherRegistry: graph.watcherRegistry, userPermissionRuleStore: graph.userPermissionRuleStore, shellPaths, configManager, runtimeStore: options.runtimeStore,
      ciNativeContinuationRevocation: watch => { if (!ciNativeContinuationRevocation) return Promise.reject(new Error('Native CI revocation is unavailable')); return ciNativeContinuationRevocation(watch); },
      ciNativeContinuationOwner: watch => ciNativeContinuationOwner?.(watch) ?? Promise.resolve(undefined),
      ciNativeContinuationReconcile: () => ciNativeContinuationReconcile?.() ?? Promise.resolve([]),
      ciAutonomousHost: () => autonomousHost, onCiAutoWatch: observer => { ciAutoWatchObserver = observer; },
      // The owner profile and occasions: daemon methods on what the daemon keeps, decided with no folder trust.
      nativeMutationHost: () => graph.daemonMethodHost,
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
      pairingWebOrigin: () => resolvePairingWebOrigin(configManager)?.origin,
      // The owner said yes to serving the web UI to his network from a pairing surface: what
      // `webui enable --lan` writes, then the daemon's own report that its listener is bound
      // again (TRANSPORT_CONNECTED, or TRANSPORT_TERMINAL_FAILURE when it could not bind).
      pairingServeToNetwork: () => serveDaemonToNetwork(configManager, options.runtimeBus),
      // providers.subscription.signIn.*: the terminal's own sign-in code path, run by the daemon for any client.
      providerSignIn: {
        manager: graph.subscriptionManager,
        service: (provider: string) => graph.serviceRegistry.get(provider),
        signedIn: (provider: string) => providerRegistry.noteSignInChanged(provider),
        // providers.apiKey.set: the key goes to the daemon's secret store under the provider's filed key name.
        apiKeys: { registry: providerRegistry, secrets: secretsManager },
      },
      disposal: disposalScope.registry,
      runtimeBus: options.runtimeBus,
      sessionPresence: graph.sessionPresence,
      // The group's roles and record: the check-in and occasion sweep run where
      // their role is held, and occasion answers and push registrations are
      // shared through the record.
      clusterRoles: graph.clusterRoles,
      authority: graph.authorityRecord,
      // A user deleted or no longer an admin loses the push endpoints it registered.
      users: graph.localUserAuthManager,
      // sessions.permissionMode.get reports the mode the gate decides by (jev-decides
      // runs as ask-me while no decision model works), why, and the same in plain words.
      modeInForce: (chosen, explicitlyChosen) => permissionManager.modeInForce(chosen, explicitlyChosen),
      modeInForceReason: (chosen, explicitlyChosen) => permissionManager.describeModeInForce(chosen, explicitlyChosen).reason,
      modeInForceWords: (chosen, explicitlyChosen) => describeModeInForceWords(configManager, { chosen, explicitlyChosen }),
    });
    disposalScope.registry.add('browser checkout seam holder', () => browserCheckoutSeam.clear()); // newer than 'browser sessions' above, so runs first
    disposalScope.registry.add('native automation updates', registerNativeAutomationGatewayMethods(gatewayMethods, { manager: automationManager, host: graph.daemonMethodHost }));
    // A piece of work's plan before it runs ("Show me the plan before it runs", planner.showPlanFirst) and a piece of
    // work proposed with its plan wait in the project's own plans (Work per project, below); the daemon's own folder
    // has none.
    const workPlansFor = (folder: string): Promise<ReturnType<typeof createWorkPlans>> => workPlansForProject
      ? workPlansForProject(folder) : Promise.reject(new Error('Work is not ready yet; ask again in a moment.'));
    // The Agent's own stores (notes, personas, routines, drafts, saved artifacts), managed here for every program.
    const agentStores = createAgentStoreRunner({
      homeDirectory, workingDirectory: () => configManager.getWorkingDirectory() ?? workingDirectory,
      artifactStore: graph.artifactStore, channelDeliveryRouter: graph.channelDeliveryRouter, permissionManager, memory: graph.memorySpine,
      // A note's web page goes into the daemon's one knowledge store, as "Add a web page" puts it there.
      // A routine put on a schedule is made on this daemon's own schedules, reached as the routine's host.
      config: configManager,
      ingestUrl: (input) => createKnowledgeApi(graph.knowledgeService).ingest.url({ ...input, tags: [...input.tags], sourceType: 'url', connectorId: 'url', fetchMode: 'public-only' }),
      // Work and agents: a research run's sources are collected with the daemon's web search, and coding work handed to
      // the terminal app is a shared session on this daemon's broker.
      webSearchService: graph.webSearchService, sessions: sessionBroker,
    });
    // Mail, calendar and channels: a send to a channel through the daemon's router, its receipt kept by the daemon
    // (the Agent's own receipts carried in once).
    const channelSends = createDaemonChannelSends({ router: graph.channelDeliveryRouter, shellPaths });
    // Models and providers: blind model comparisons on the daemon's providers, kept in its artifact store; a winner switched
    // to becomes the default model.
    const modelComparisons = createModelComparisonRunner({
      modelCatalog: providerRegistry, providerRegistry, artifactStore: graph.artifactStore, config: configManager,
      // A comparison keeps its results in the daemon's store and works in no project folder: no folder-trust question
      // before it and no folder's restriction refusing it, as the daemon's natively admitted methods (runtime-graph.ts
      // daemonMethodHost). A deny rule or plan mode still refuses it.
      permissionManager: createBrokeredPermissionManager({
        workspaceTrust: null, requestApproval: (input) => approvalBroker.requestApproval(input), configManager,
        policyRuntimeState: graph.policyRuntimeState, hookDispatcher, featureFlags, userRuleStore: graph.userPermissionRuleStore, secretsManager,
      }),
    });
    // The folder of each project's plan the daemon's turns have worked in, by the plan's project id.
    const projectPlanFolders = new Map<string, string>();
    graph.projectPlanningService.declareProjectRoots((projectId) => projectPlanFolders.get(projectId));
    const projectTurns = createProjectTurnFacilities({
      homeDirectory, daemonHome: daemonHomeDirectory, shellPaths, hooksFile: () => String(configManager.get('tools.hooksFile')),
      trustFor: createDaemonWorkspaceTrustResolver({ workingDirectory, homeDirectory, workspaceTrustManager }),
      ...(graph.agentToolDependencies.toolLLM ? { toolLLM: graph.agentToolDependencies.toolLLM } : {}), featureFlags,
      // A project's hooks run as a program's do: agent hooks spawn on the daemon's manager, command actions on its runner.
      agentManager: graph.agentToolDependencies.agentManager, hookActions: graph.agentToolDependencies.workflowServices.hookActions,
      // The project's tool servers, contained as the shared `sandbox.*` settings say and decided by the daemon's
      // permission owner for that project.
      tools: { configManager, runtimeBus: options.runtimeBus, permissionHost: graph.nativeMutationHost },
      // The project's checklist, in the one plan file every program keeps (the same plan a program in the folder shows).
      // Each project's plan announces its changes on the daemon's bus, about that project; the daemon's own planning
      // service (the planning routes) names the project of a plan it is told of the same way.
      workPlans: {
        knowledgeStore, planFile: graph.projectPlanningService.workPlanFile, projectIdOf: (folder: string) => projectIdentityOfFolder(configManager, folder),
        runtimeBus: options.runtimeBus,
        noteProject: (projectId: string, folder: string) => { projectPlanFolders.set(normalizeProjectId(projectId), folder); },
      },
      // The project's checkpoint store (the one a hosted session in that folder uses).
      checkpoints: workspaceCheckpoints,
      // The project's secret store for its turns, the one a capability called from that project reads (secretsViewFor).
      // The project's code index, the one the terminal app keeps there, built when a turn there first asks while the
      // daemon's one setting (`storage.codeIndexEnabled`, Code and changes, Code index) is on.
      ...(graph.agentToolDependencies.memoryEmbeddingRegistry
        ? { codeIndex: { surfaceRoot: 'tui', configManager, memoryEmbeddingRegistry: graph.agentToolDependencies.memoryEmbeddingRegistry,
          enabled: () => configManager.get('storage.codeIndexEnabled') === true } } : {}),
      secretsFor: (folder: string) => new SecretsManager({ projectRoot: folder, globalHome: secretsManager.getGlobalHome(), surfaceRoot: 'tui', configManager }),
      // The services a project's turn reaches (`fetch`'s service sign-in, the context tool): the daemon's services file
      // with the project's own, a credential read from the project's secret store (a key kept for "This project" there)
      // before the daemon's, as a capability called from that project reads it.
      serviceRegistryFor: (folder: string) => new ServiceRegistry({ user: graph.serviceRegistry.userServicesFilePath, project: join(folder, '.goodvibes', 'tui', 'services.json') }, {
        secretsManager: new SecretsManager({ projectRoot: folder, globalHome: secretsManager.getGlobalHome(), surfaceRoot: 'tui', configManager }),
        subscriptionManager: graph.subscriptionManager,
      }),
    });
    disposalScope.registry.add('project turn facilities', () => projectTurns.close());
    // The daemon's own folder is no project and holds no hooks file: nothing is read there. A daemon-run turn fires its
    // project's hooks (projectTurns, above); daemon-wide hooks are a daemon setting kept in its home.
    const agentToolDependencies = {
      ...graph.agentToolDependencies,
      // Workers keep the project work plan the work plan view shows.
      workPlan,
      // The turn's project rides along: a CI watch its push makes belongs to that project (ci-watch/auto-watch.ts).
      toolExecutionObserver: (tool: string, args: Record<string, unknown>, success: boolean, turn: { readonly project?: string | undefined }) => ciAutoWatchObserver?.(tool, args, success, turn),
      // A background agent's `query` tool leaves its questions in the same inbox; the agent takes the
      // owner's answer on its next model request, or, if it stopped, on its next run (a channel's next turn).
      ownerQuestions: askingQuestions(ownerInbox, () => callingAgentAsker(agentManager)),
      // Every web chat and run of a project shares its registry: each call names its own conversation (its task list,
      // checklist, session state, questions and contracts are that conversation's; engine tools/index.ts).
      turnSessionId: () => whoseTurn().sessionId,
      // A daemon turn's commands follow the one rule every door's turn does (tools/exec/containment.ts): the shared
      // sandbox setting decides the boundary, the gate under the owner's mode decides whether the command runs, and an
      // ask nobody is present for waits for the owner in Waiting for you.
      execContainment: TURN_EXEC_CONTAINMENT,
      // GoodVibes' own capabilities for the daemon's own turns (web chat, scheduled runs, handed-off work), run here.
      capabilityTools: {
        catalog: daemonCapabilityCatalog,
        loaded: loadedDaemonCapabilityCatalog,
        services: createDaemonCapabilityServices({ configManager, hookDispatcher, secretsManager, memoryRegistry: graph.memoryRegistry, sessionBroker,
          // The daemon's remote runners (capabilities/builtin/remote.ts), the same holder every door reaches.
          remoteRunnerRegistry: graph.remoteRunnerRegistry, remoteSupervisor: graph.remoteSupervisor, runtimeStore: graph.runtimeStore,
          runtimeBus: graph.runtimeBus, agentManager, judgment: graph.judgment, permissionManager, shellPaths,
          // Permissions and safety (capabilities/builtin/permissions.ts, security.ts).
          userPermissionRuleStore: graph.userPermissionRuleStore, tokenAuditor: graph.tokenAuditor, workspaceTrustManager,
          // Permissions and safety (capabilities/builtin/security-review.ts): the policy state that writes the one activation record.
          policyRuntimeState: graph.policyRuntimeState,
          // Memory and knowledge: the Agent's own stores (capabilities/builtin/agent-stores.ts).
          agentStores,
          // Mail, calendar and channels (capabilities/builtin/channel-send.ts): the daemon's sends to a channel.
          channelSends,
          // Work (capabilities/builtin/work.ts): a piece of work proposed with its plan waits among the plans before they run,
          // the asking project's own.
          workPlansFor,
          // Work and agents (capabilities/builtin/media-collect.ts): a collected file read back to save it in the asker's project.
          artifactStore: graph.artifactStore,
          // Models and providers (capabilities/builtin/models.ts, services.ts): the daemon's provider stack, sign-ins and services file.
          providerRegistry, providerOptimizer: graph.providerOptimizer, favoritesStore: graph.favoritesStore, benchmarkStore: graph.benchmarkStore,
          subscriptionManager: graph.subscriptionManager, serviceRegistry: graph.serviceRegistry, mediaProviders: graph.mediaProviders, modelComparisons }),
        methods: gatewayMethods,
        workingDirectory: () => configManager.getWorkingDirectory() ?? workingDirectory,
      },
      // The tools of the person's own things every turn of the daemon has, whatever door it came through (the same a
      // terminal turn has): mail and calendar (`google`) and the paired phone (`phone`, the daemon's own device posture).
      decorateRegistry: (registry: Parameters<typeof unattendedRunTools.decorateRegistry>[0]) => {
        graph.agentToolDependencies.decorateRegistry?.(registry);
        unattendedRunTools.decorateRegistry(registry);
        registerDevicePhoneTool(registry, devicePosture);
        // A channel's conversation with no project ("Project for this channel") writes no file and runs no command, and
        // nothing is ever written in this daemon's own folder (channels/channel-project.ts).
        refuseChannelChangesWithoutProject(registry, workingDirectory);
      },
      // A run of the daemon's own in another project (a schedule's, a trigger's, a piece of work's) fires that
      // project's hooks file and keeps its long output there: built once per project, on its first run.
      projectFacilities: projectTurns.forFolder,
      // Let go with the folder's last kept registry: its tool servers stop and its checkpoint store closes until next used.
      releaseProjectFacilities: projectTurns.release,
      // A run's agent journals and run state are kept under the daemon's records, per project, never in its own folder.
      runRecordsRootOf: (folder: string) => daemonRunRecordsRoot(shellPaths.recordsRoot, workingDirectory, folder),
      // No daemon run has a terminal screen: each is told so in one line, as the web chat is.
      screenless: true,
    };
    graph.agentOrchestrator.setDependencies(agentToolDependencies);
    // The same store instance the workspaces.* verbs write through, so this process orders its own readers and writers.
    const nativeScopes = openWorkspaceRegistrationStore({ path: sharedWorkspaceRegisterPath(shellPaths), homeDir: homeDirectory,
      daemonStateDir: shellPaths.resolveUserPath() });
    // Rules a 3.5.0 daemon kept for its own folder whatever project its work was in: placed in their project from the
    // answers that made them, a refusal that cannot be placed kept for every project, an allow kept for the folder. At
    // every start, for the rules this version has not written yet (a rollback's included); said once per carry, off the
    // start path (permissions/daemon-folder-rules-notice.ts). The folder those rules were saved for is the one a 3.5.0
    // daemon ran in (daemon-records.ts `formerDaemonFolders`), never this daemon's own folder in its home.
    void (async () => {
      const announcements = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
      for (const folder of formerDaemonFolders(homeDirectory, daemonHomeDirectory, workingDirectory)) {
        await noteDaemonFolderRules(graph.userPermissionRuleStore, folder, announcements, approvalBroker);
      }
    })();
    // Every committed write to a native request is announced, so a client showing native requests reads them again on it.
    disposalScope.registry.add('native request change events', knowledgeStore.onNativeRequestChange((change) => {
      emitNativeRequestChanged(options.runtimeBus, { sessionId: 'system', traceId: `native-request:${change.projectId}:${Date.now()}`, source: 'native-work' }, change);
    }));
    // Every change to a list a client shows (memory, checkpoints, CI watches, check-ins, people) is announced the same way.
    disposalScope.registry.add('list change events', onListChanged((change) => {
      emitListChanged(options.runtimeBus, { sessionId: 'system', traceId: `list:${change.list}:${Date.now()}`, source: 'list-changes' }, change);
    }));
    // Every project's native turns: over that project's own intake, each request in the project it names (the daemon's
    // own folder is no project and has none: a request naming no project is refused NO_PROJECT).
    const removeHostedProjects = installNativeHostedConversationProjects(gatewayMethods,
      { route: (catalog) => routeByProject(catalog, (folder) => projectWork.ensure(folder)), forProject: (folder) => projectWork.get(folder).hosted });
    disposalScope.registry.add('native hosted conversation binding', removeHostedProjects);
    // A CI watch made by a project's work: its native continuation is held by that project's records, so every read or
    // change of it goes to the project whose store holds it, among the projects made so far and every registered one.
    const projectHoldingCiWatch = async (watch: Parameters<NonNullable<typeof ciNativeContinuationOwner>>[0]) => {
      const continuationId = watch.continuationId;
      if (!continuationId) return undefined;
      // A read of the continuation's one row in a project's store, nothing built for a project that does not hold it.
      const holds = async (projectId: string): Promise<boolean> => {
        try { return ((await knowledgeStore.openNativeWorkExecutionStorage(projectId)).continuations?.current(continuationId).record ?? null) !== null; } catch { return false; }
      };
      const roots = [...new Set([...projectWork.all().map((work) => work.hosted.projectRoot), ...registeredWorkspaceRoots(homeDirectory)])];
      for (const root of roots) {
        if (!await holds(await projectIdentityOfFolder(configManager, root))) continue;
        await projectWork.ensure(root);
        return projectWork.get(root).activation.acquire();
      }
      throw Object.assign(new Error(`The CI watch ${watch.id} names work whose project is none of the registered projects, so it was neither repaired nor changed. Register the project its work was in.`),
        { code: 'NO_PROJECT', status: 422 });
    };
    ciNativeContinuationRevocation = async watch => { const host = await projectHoldingCiWatch(watch); if (host) await host.revokeCiWatch(watch); };
    ciNativeContinuationOwner = async watch => (await projectHoldingCiWatch(watch))?.recoverCiWatchOwner(watch);
    // A settings or scope change stops the continuations that no longer hold, in every project whose Work is made.
    ciNativeContinuationReconcile = async () => (await Promise.all(projectWork.all().map(async (work) => {
      const open = (await knowledgeStore.openNativeWorkExecutionStorage(work.projectId)).continuations?.listOpen?.() ?? [];
      return open.length === 0 ? [] : (await work.activation.acquire()).reconcileCiContinuations();
    }))).flat();
    const announcements = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));

    // Work per project: each project's, made on the first request that names it (its folder as `workingDirectory`) and
    // kept for every later one. A program's Work, its messages and its native runs are its own project's, whatever folder
    // the daemon runs in; nothing of one project is read or written under another's.
    const buildProjectWork = async (root: string): Promise<ProjectWork> => {
      const projectId = await projectIdentityOfFolder(configManager, root);
      const sessionId = `native-work:${projectId}`;
      const ledger = createNativeWorkLedgerOwner({ projectId, knowledgeStore });
      const readBinding = createLocalWorkLedgerReadBinding({ available: true, projectId, actorId: 'host:operator-ledger-read',
        allowLegacyProvenance: true, service: ledger.service, authority: ledger.authority });
      if (!readBinding.available) { await ledger.close(); throw new Error(readBinding.reason); }
      // Held for good: this graph's turns use the project's hooks and long-output folder for as long as it runs.
      const turns = projectTurns.hold(root);
      const projectIndex = new ProjectIndex(root);
      // Its turns' tools are rooted in its folder, with its hooks and its own long-output folder; never the daemon's.
      // The graph's own folder is this project: its turns and runs take the project's environment (projectFacilities).
      const toolDependencies = { ...agentToolDependencies, workingDirectory: root, fileCache: new FileStateCache(), projectIndex,
        ownFolderIsProject: true, workPlan: undefined, codeIndex: undefined, codeIndexReindexScheduler: undefined,
        capabilityTools: { ...agentToolDependencies.capabilityTools, workingDirectory: () => root },
        ...(turns.toolCallHooks ? { toolCallHooks: turns.toolCallHooks } : {}), ...(turns.overflowHandler ? { overflowHandler: turns.overflowHandler } : {}) };
      const plans = createWorkPlans({
        drafts: createWorkstreamDraftService({ agentManager, configManager, projectRoot: root, contractRunner, sessionId, pricing: providerRegistry }),
        // Kept with the daemon's records, one file per project, never inside the project (carried once from the home's
        // terminal folder, where an earlier build kept it, that file left as it was).
        file: carriedRecordsFile(shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'work-plans', `${projectId}.json`),
          shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'work-plans', `${projectId}.json`)),
        showPlanFirst: () => configManager.get('planner.showPlanFirst') === true,
        // Its `work` notices name this project (the one project identity), so only its screens read again.
        project: projectIdentityOf(root),
      });
      // This project's old planning records (an earlier version's planning sources and work-plan tasks, each naming the
      // project it was kept for) carried into its Work once, by the host itself (workflow/work-ledger/carry-old-records.ts);
      // off the making's path, the old records untouched. A 3.5.0 daemon's own folder was a project: its Work is made at
      // start (below), so its records are carried there.
      void carryOldWorkRecords({
        hostId: ledger.importHostId, projectId, service: ledger.service, authority: ledger.authority,
        ready: () => knowledgeStore.init(),
        readSource: (id) => knowledgeStore.getLegacyImportRecord(id),
        sourceIds: () => oldPlanningSourceIds(knowledgeStore, projectId),
        announcements,
      }).catch((error: unknown) => logger.warn('[Work] old planning records could not be carried into Work', { project: root, error: summarizeError(error) }));
      // This project's live work with no recorded cause, put to the owner once (work-cause-question.ts).
      const stopCauseQuestions = askUnrecordedWorkCauses({ projectId, service: ledger.service, authority: ledger.authority, plans, inbox: ownerInbox });
      // Contracts a terminal program was running itself in this project (3.5.0's own runner), carried once into its
      // Work as proposed work with their remaining steps; their files are only read (carry-program-contracts.ts).
      try {
        carryProgramContracts({ projectRoot: root, plans, carriedFile: carriedRecordsFile(
          shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'carried-program-contracts', `${projectId}.json`),
          shellPaths.resolveUserPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'carried-program-contracts', `${projectId}.json`)) });
      } catch (error) { logger.warn('[Work] a program\'s contracts could not be carried into Work', { error: summarizeError(error) }); }
      const submission = createNativeWorkSubmissionHost({ projectRoot: root, projectId, sessionId, service: ledger.service, authority: ledger.authority,
        scopes: nativeScopes, registerScope: async (folder: string) => { await nativeScopes.add(folder, { origin: 'work-request' }); } });
      let hostedOwner: NativeConversationContinuationOwner | undefined;
      const continuation: NativeConversationContinuationOwner = {
        capture: (id, principalId, selectedDiff) => {
          if (!hostedOwner) throw new Error('Native hosted continuation owner unavailable');
          return hostedOwner.capture(id, principalId, selectedDiff);
        },
        assertCurrent: (context, principalId, source) => {
          if (!hostedOwner) throw new Error('Native hosted continuation owner unavailable');
          hostedOwner.assertCurrent(context, principalId, source);
        },
      };
      const intake = createNativeConversationIntakeHost({ projectRoot: root, projectId, sessionId, storage: await knowledgeStore.openNativeConversationStorage(projectId),
        scopes: nativeScopes, port: judgment.port, decisionLog: judgment.decisionLog, proposer: createNativeRequirementProposer(providerRegistry), continuation,
        artifacts: graph.artifactStore });
      const activation = createDaemonNativeWorkExecutionActivation({
        workPlans: plans, nativeDataWriter: options.nativeDataWriter ?? configManager.getNativeDataWriter(),
        runtimeBus: options.runtimeBus, configManager, providerRegistry, projectRoot: root, projectId, sessionId, acpHost, knowledgeStore,
        nativeScopes, continuationGrants: pairingTokens,
        continuationScopeOwner: { current: () => { if (!continuationScopeOwner) throw new Error('Native CI scope owner is unavailable'); return continuationScopeOwner.current(); } },
        judgmentPort: judgment.port, decisionLog: judgment.decisionLog,
        permissionManager, hookDispatcher, featureFlags, toolDependencies,
        additionalFleetOwnership: () => agentManager.fleetOwnership(), contractOperator,
        notifyFleetSlotReleased: () => agentManager.notifyFleetSlotReleased(),
        onFleetSlotReleased: (listener) => agentManager.onFleetSlotReleased(listener),
      });
      return {
        projectId, reader: readBinding.client, submission, intake, activation, plans,
        hosted: { projectId, projectRoot: root, intake, journalPath: shellPaths.resolveProjectPath(GOODVIBES_DAEMON_SURFACE_ROOT, 'native-hosted-turns', `${projectId}.json`),
          installContinuationOwner: (owner) => { hostedOwner = owner; },
          principalCanAct: (principalId) => pairingTokens.nativePrincipalCurrent(principalId) },
        async close() {
          stopCauseQuestions();
          readBinding.client.dispose();
          try { await Promise.all([submission.close(), intake.close(), activation.close()]); }
          finally { await ledger.close(); await projectIndex.dispose(); }
        },
      };
    };
    const projectWork = createProjectWorkSet<ProjectWork>({ build: buildProjectWork });
    workPlansForProject = async (folder) => { await projectWork.ensure(folder); return projectWork.get(folder).plans; };
    disposalScope.registry.add('project work', () => projectWork.close());
    nativeFleetOwnership = () => projectWork.all().flatMap((work) => work.activation.fleetOwnership());
    fenceNativeWork = async () => { await projectWork.close(); };
    // The folders a 3.5.0 daemon ran in were its projects: their Work is made at start, off the start path, so their old
    // planning records are carried into it (above) and their work stands in Work there, as 3.5.0 showed it.
    void (async () => {
      for (const folder of formerDaemonFolders(homeDirectory, daemonHomeDirectory, workingDirectory)) {
        // A 3.5.0 daemon started in the home folder (or anywhere that can never be a project) left no project's Work.
        if (whyNeverAProject(folder, { homeDirectory, goodVibesHome: join(homeDirectory, '.goodvibes'), daemonHome: daemonHomeDirectory })) continue;
        try { await projectWork.ensure(folder); }
        catch (error) { logger.warn('[Work] the Work of a folder a 3.5.0 daemon ran in could not be opened', { folder, error: summarizeError(error) }); }
      }
    })();
    // Every Work and native method is served from the project its request names; a request naming none is refused
    // (NO_PROJECT): the daemon's own folder is no project.
    const routedMethods = routeByProject(gatewayMethods, (folder) => projectWork.ensure(folder));
    const current = (): ProjectWork => projectWork.get(requestProject());
    registerWorkLedgerGatewayMethods(routedMethods, projectProxy(() => current().reader));
    registerNativeWorkSubmissionGatewayMethods(routedMethods, projectProxy(() => current().submission));
    registerNativeConversationIntakeGatewayMethods(routedMethods, projectProxy(() => current().intake));
    registerNativeWorkExecutionGatewayMethods(routedMethods, { get projectId() { return current().projectId; }, acquire: () => current().activation.acquire() });
    // Work as every surface reads it: each piece of work with where it stands and its plan, and what an act on one sends.
    registerWorkGatewayMethods(routedMethods, { get projectId() { return current().projectId; }, get reader() { return current().reader; },
      acquire: () => current().activation.acquire(), get plans() { return current().plans; } });

    // This process's own memory pressure, to the operator's configured notice
    // destination. Targeted at OPS_MEMORY_PRESSURE rather than subscribed to the
    // whole high-churn 'ops' domain, and sent over the SAME WebhookNotifier the
    // notification verbs keep live and boot-tasks attaches to the bus. There is
    // no panel notification router here: its targets are all screen targets and
    // this product has no screen, see notification-dispatch.ts.
    disposalScope.registry.add('memory pressure notice', wireMemoryPressureChannelNotice(options.runtimeBus, graph.webhookNotifier));

    // Merged by property: a spread of the graph would read its on-demand code index getter and open an index for the
    // daemon's own folder (merge-keeping-getters.ts).
    const services: Omit<RuntimeServices, 'daemonHandlers'> = mergeKeepingGetters(graph, {
      endLongWaits: () => {
        for (const { label, end } of longWaitEnds.splice(0)) {
          try { end(); } catch (error) { logger.warn('Ending a waiting request at stop failed', { label, error: summarizeError(error) }); }
        }
        graph.endLongWaits?.();
      },
      workspaceTrustManager,
      triggerManager,
      ownerInbox,
      mailboxReaders,
      // The Agent's own stores, for the capabilities that manage them through every door (and a hosted session's).
      agentStores,
      // Mail, calendar and channels: the daemon's sends to a channel and their receipts, through every door.
      channelSends,
      // Models and providers: blind model comparisons, for the capabilities that run them through every door.
      modelComparisons,
      // Work: the plans before they run, where a piece of work proposed with its plan waits (capabilities/builtin/work.ts),
      // each project's own.
      workPlansFor,
      browserJudgment,
      ...(browserGateway ? { browserGateway } : {}),
      devicePosture,
      clusterCoordinator,
      clusterGroup,
      startCluster: () => startClusterServices({ clusterGroup, clusterCoordinator }),
      close,
      dispose: (): void => { void close().catch(() => {}); },
    });
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
      // The handlers' stores (channel routes, drafts, inbox cursors and identities, triage locks) are the daemon's
      // own records: under its records folder, whatever folder it was started in.
      workingDirectory: recordsRoot,
      homeDirectory,
      shellPaths,
      distributedRuntime,
      clusterCoordinator,
      authorityRecord: graph.authorityRecord,
      clusterMemberName: (nodeId: string): string | null =>
        clusterGroup.runtime.groupState?.members.find((member) => member.nodeId === nodeId)?.displayName ?? null,
      checkoutSeam: browserCheckoutSeam.get, channelDeliveryRouter: graph.channelDeliveryRouter, inboxFactory: options.inboxFactory,
      mailboxReaders,
      serviceRegistry: graph.serviceRegistry,
      triagePermissionHost: autonomousHost,
      // Channel routing and drafts: daemon methods on what the daemon keeps, decided with no folder trust.
      nativeMutationHost: graph.daemonMethodHost,
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
