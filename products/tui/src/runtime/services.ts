import { readTuiNotificationsMetadataOnly } from '../config/host-settings.ts';
/**
 * services.ts, the terminal app's composition root, as a CLIENT.
 *
 * The graph is the one every product composes (composeRuntimeServices) with
 * this surface's choices: the home memory store, a workspace trust owner that
 * asks the person at this terminal, asks raised on the daemon while prompting
 * here, MCP questions answered by the person, and everything the daemon owns
 * left to it: the built-in verbs are forwarded, triggers run there, routines
 * run here only while no daemon does, consolidation writes only while no
 * daemon owns the store.
 *
 * What only a terminal has is added over the graph in its own scope: the daemon
 * client seams, the build guard, the wire session dispatch, conversation rewind,
 * notifications, replay recording and the fleet read model.
 *
 * `sessionBroker` and `approvalBroker` are this surface's own record of the
 * sessions it is running and the asks it raised, what the transcript, the
 * session browser and the approval card read. They are NOT authoritative:
 * session identity is mirrored to the daemon's spine and an ask is raised on the
 * daemon (`approvals.raise`) so every other surface can see and answer it.
 */
import { FocusTracker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { SharedSessionContinuationOutcome } from '@goodvibes-jev/engine/platform/platform/control-plane';
import { buildContinuationSpawnInput, composeRuntimeServices } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { forwardGatewayMethodsToDaemon } from './gateway-daemon-forward.ts';
import { terminalRunsRoutines } from './terminal-routines.ts';
import { gateConsolidationToLocalWriter } from './memory-consolidation-gate.ts';
import { createNotificationDispatcher, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from './notification-dispatch.ts';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell-paths';
import { createViewPanelAdapter } from '../views/view-panel-adapter.ts';
import { createContractIntake } from '@goodvibes-jev/engine/platform/platform/contract';
import { KeybindingsManager } from '../input/keybindings.ts';
import { startReplayRecording } from '@goodvibes-jev/engine/platform/platform/core';
import { WorkspaceTrustDecisionUnsettledError, type WorkspaceTrustLevel } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { GOODVIBES_TUI_SURFACE_ROOT, TUI_TRUSTS_SAVED_SCANNED_SERVERS } from '../config/surface.ts';
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
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { VERSION } from '../version.ts';
import { createSessionConversationRewindPort, hasSessionConversation } from './conversation-rewind-port.ts';
import { createFleetReadModel } from '../views/fleet-read-model.ts';
import type { PermissionPromptDecision, PermissionPromptRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import { sandboxAwareApprovalRaiser, sandboxExecAskDepsFromRuntime } from '../permissions/sandbox-exec-gate.ts';
import type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';
export type { RuntimeServicesOptions, RuntimeServices } from './runtime-services-types.ts';

export function createRuntimeServices(options: RuntimeServicesOptions): RuntimeServices {
  const workingDirectory = options.workingDir;
  const homeDirectory = options.homeDirectory;
  const configManager = options.configManager;
  const shellPaths = createShellPathService({ workingDirectory, homeDirectory });

  // ── The client seams: one resolution of "which daemon", shared by all of them.
  const verbs = createDaemonVerbCaller({ configManager, homeDirectory });
  const daemonConfig = createDaemonConfigClient(verbs);
  const devices = createDevicesClient(verbs);
  // Daemon-hosted sessions: the session picker (built in the input layer, which
  // has no config manager to resolve a daemon from) reads the roster; this is
  // the one place that can give it a client. See client/hosted-roster.ts.
  getSharedHostedSessionRoster().bindClient(createHostedSessionsClient(verbs));
  // A daemon-scoped credential goes to the daemon over `credentials.set`, which
  // writes the value AND points the config key at it in one verified sequence.
  const daemonCredentials = createDaemonCredentialsClient(verbs);

  // The late-bound terminal prompt: the UI layer patches the real implementation in after boot.
  const localPromptRef: { requestPermission: (request: PermissionPromptRequest) => Promise<PermissionPromptDecision> } = {
    requestPermission: async () => ({ approved: false, remember: false }),
  };
  const liveSessionIdRef: { value: string | null } = { value: null };
  // The trust question has one owner here: the terminal UI patches `trustPromptRef` once it exists, and
  // every trust gate (the turn's and the workers') asks through `requestTrustDecision`, which keeps a
  // single prompt open however many gates reach an undecided workspace at once.
  // Before the UI exists (and in a headless run, where it never does) the question goes to the
  // permission prompt: a script answering a `run --answer-permissions` sees it; otherwise nobody can
  // answer, and an unanswered question leaves the workspace undecided rather than recording a choice
  // nobody made.
  const trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> } = {
    requestTrustDecision: async () => {
      const workspace = workingDirectory;
      const decision = await localPromptRef.requestPermission({
        callId: `workspace-trust-${randomUUID().slice(0, 8)}`,
        tool: 'workspace-trust',
        args: { workspace },
        category: 'read',
        analysis: {
          classification: 'workspace-trust',
          riskLevel: 'high',
          summary: `Trust the workspace ${workspace}? Approving lets writes, commands and delegation run here and is remembered for this workspace.`,
          reasons: [`${workspace} has no trust decision recorded.`, 'Refusing leaves it undecided: reads keep working, and this request is refused.'],
          target: workspace,
          targetKind: 'path',
          blastRadius: 'local',
        },
      });
      if (decision.approved) return 'trusted';
      throw new WorkspaceTrustDecisionUnsettledError();
    },
  };
  let pendingTrustDecision: Promise<WorkspaceTrustLevel> | null = null;
  const requestTrustDecision = (): Promise<WorkspaceTrustLevel> => {
    pendingTrustDecision ??= trustPromptRef.requestTrustDecision().finally(() => { pendingTrustDecision = null; });
    return pendingTrustDecision;
  };
  // The ask as this surface raises it: on the daemon, which holds the record every
  // other surface reads, while this surface's own broker puts it on the approval
  // card and in the modal. Built over the graph's broker by the composition.
  const clientRaiserRef: { current?: ReturnType<typeof createClientApprovalRaiser> } = {};
  // The operator API's panels.list / panels.open, answered by the modal views.
  const viewPanelAdapter = createViewPanelAdapter();
  const keybindingsManager = new KeybindingsManager({
    configPath: shellPaths.resolveUserPath(GOODVIBES_TUI_SURFACE_ROOT, 'keybindings.json'),
  });
  // An adopted daemon owns the home's shared housekeeping: the daily copy of the
  // canonical memory store and the wake-model sweep and provisioning. Whether one
  // was adopted is known only once the host services settle (bootstrap.ts calls
  // settleHomeHousekeeping); with the daemon turned off none will be, so this
  // terminal starts both at once. This terminal's own stores stay its to keep.
  const daemonMayOwnHomeHousekeeping = resolveDaemonEnabled(configManager);
  const provisionWakeModels = options.provisionWakeModelsAtBoot === true;
  let conversationRewindClosing: Promise<void> | undefined;

  return composeRuntimeServices({
    surface: 'tui',
    roots: {
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      workingDir: workingDirectory,
      homeDirectory,
      daemonHome: options.daemonHomeDirectory,
      sessionStorePath: shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'control-plane', 'sessions.json'),
      // No pairingTokenPath: the default is the daemon's own store (its surface root is this
      // one), so a device paired, renamed or revoked here is the one the daemon authenticates.
    },
    memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision },
    permissionHost: {
      raiseApproval: (approvalBroker, graph) => {
        const requestApproval = createClientApprovalRaiser({
          verbs,
          // How THIS surface reports its own decision back to the daemon, so every
          // other surface can see where the answer came from.
          actor: 'tui',
          sessionId: () => liveSessionIdRef.value,
          // The signal is the raiser's: a decision made on another surface aborts it,
          // which retires this broker's record and clears the card here.
          localPrompt: () => (request, promptOptions) =>
            approvalBroker.requestApproval({
              request,
              ...(promptOptions?.signal ? { signal: promptOptions.signal } : {}),
              ...(liveSessionIdRef.value ? { sessionId: liveSessionIdRef.value } : {}),
              localPrompt: (prompt) => localPromptRef.requestPermission(prompt),
            }),
          // A decision made on another surface reaches this terminal in the time one
          // SSE frame takes; the interval stays as the fallback (client/approval-updates.ts).
          subscribeApprovalUpdates: createTerminalApprovalUpdateSubscriber({ configManager, homeDirectory }),
        });
        clientRaiserRef.current = requestApproval;
        // A contained command the turn runs without a prompt does not prompt for a
        // worker either: the sandbox-aware exec gate sits inside the trust gate, as
        // it does for the turn (see createTuiTurnPermissionManager).
        return sandboxAwareApprovalRaiser(sandboxExecAskDepsFromRuntime(graph.configManager, graph.featureFlags), requestApproval);
      },
      personElicitation: true,
    },
    hostSeams: {
      nativeDataWriter: configManager.getNativeDataWriter(),
      runtimeBus: options.runtimeBus,
      runtimeStore: options.runtimeStore,
      configManager,
      featureFlags: options.featureFlags,
      getConversationTitle: options.getConversationTitle,
      ownerConversationMessages: options.ownerConversationMessages,
      panelManager: viewPanelAdapter,
      keybindingsManager,
      localUserAuthManager: options.localUserAuthManager,
      modelDiscovery: options.modelDiscovery,
      // Every server the terminal app saved was found by the owner's own /scan.
      trustScannedServer: TUI_TRUSTS_SAVED_SCANNED_SERVERS,
      powerSeam: options.powerSeam,
      currentSessionId: options.currentSessionId,
      provisionWakeModelsAtBoot: provisionWakeModels && !daemonMayOwnHomeHousekeeping,
      notificationsMetadataOnly: () => readTuiNotificationsMetadataOnly(configManager),
      tripwireExit: (receipt) => {
        logger.warn('[memory] the terminal app keeps running past a memory tripwire; save your work and restart it when convenient', {
          trigger: receipt.trigger,
          rssMb: receipt.rssMb,
          budgetMb: receipt.budgetMb,
        });
      },
      // Consolidation writes the store, so it runs here only while no daemon owns it.
      consolidationTarget: (registry, spine) => gateConsolidationToLocalWriter(registry, spine),
      // The daemon catches its routines up on wake; a terminal does only while it runs them itself (daemon off).
      runsRoutines: terminalRunsRoutines,
      workspaceCheckpoints: (input) => ({
        manager: createWorkspaceCheckpointing({ workspaceRoot: input.workspaceRoot, surface: input.surface, runtimeBus: input.runtimeBus, configManager: input.configManager }),
      }),
    },
    // Each built-in verb is answered by the daemon (gateway-daemon-forward.ts).
    gatewayVerbs: 'product',
    // Triggers are the daemon's to run.
    triggers: 'host',
    // This surface runs follow-ups for the sessions it hosts behind its build guard (below).
    continuationRunner: 'product',
    // Contracts left on disk are taken up by the long-lived hosts that follow them
    // (bootstrap.ts, for the interactive TUI and headless runs), never by a
    // one-shot command's graph that closes a moment later.
    contractRecovery: 'product',
    taskGraphReaping: 'never',
    profileCapture: false,
    extras: (base, scope) => {
      const requestApproval = clientRaiserRef.current;
      const workspaceTrustManager = base.workspaceTrustManager;
      if (!requestApproval || !workspaceTrustManager) throw new Error('The terminal graph was composed without its approval raiser or trust owner');
      const { agentManager, configManager: config, providerRegistry, sessionBroker, contractRunner, processRegistry, surface } = base;
      // This product serves no verbs itself: each built-in verb on this catalog is
      // answered by the daemon. Plugins, mail, calendar and review surfaces call it.
      forwardGatewayMethodsToDaemon(base.gatewayMethods, verbs);
      const contractIntake = createContractIntake({ runner: contractRunner, projectRoot: workingDirectory });
      // Work that arrives for a session THIS surface hosts reaches the loop through
      // the same runner whether it came from the local broker or from the daemon's
      // queue. The wire half is inert until bootstrap.ts adopts a daemon.
      const wireSessionDispatch = createWireSessionDispatch({
        hostedSessionIds: () => (liveSessionIdRef.value ? [liveSessionIdRef.value] : []),
        // A continuation dispatched here runs in THIS process, so the daemon's own
        // completion poll can never see it finish; this is how the answer gets
        // reported back, and how a channel message is answered into its channel.
        readAgentOutcome: (agentId) => readSurfaceAgentOutcome(agentManager.getStatus(agentId)),
      });
      scope.registry.add('wire session dispatch', () => wireSessionDispatch.stop());
      // A daemon update swaps the daemon binary and leaves this terminal running
      // the build it started with. When this build is below the floor the daemon
      // announces, the guard latches and the runner below stops taking
      // shared-session work rather than executing it under superseded rules.
      const clientBuildGuard = new ClientBuildGuard({ clientVersion: VERSION });
      type ContinuationRequest = Parameters<NonNullable<Parameters<typeof sessionBroker.setContinuationRunner>[0]>>[0];
      const continuationRunner = async ({ task, input, routeBinding }: ContinuationRequest): Promise<SharedSessionContinuationOutcome> => {
        // Held, not declined with null: null reads as "consumed", and the message
        // would be lost instead of waiting for the restarted terminal.
        if (!clientBuildGuard.maySharedSessionWork()) {
          logger.warn('declined a shared-session continuation: this build is below the daemon floor', {
            sessionId: input.sessionId,
            floor: clientBuildGuard.current().floor,
          });
          return { disposition: 'held', reason: 'this terminal build is below the daemon floor; restart it to process this message' };
        }
        // The platform's one spawn decision, the same the daemon and the Agent make: a
        // conversational follow-up gets the conversational tool set and the write
        // authority of the channel it arrived on.
        const record = agentManager.spawn(buildContinuationSpawnInput({ task, input, ...(routeBinding ? { routeBinding } : {}) }, {
          configReader: config,
          modelCandidates: providerRegistry.listModels(),
          sharedSessionContext: true,
        }));
        return { agentId: record.id };
      };
      sessionBroker.setContinuationRunner(continuationRunner);
      wireSessionDispatch.setContinuationRunner(continuationRunner);
      const focusTracker = new FocusTracker();
      // Every turn is recorded as a run /replay can load, written once when the turn ends.
      const replayRecording = startReplayRecording({
        runtimeBus: options.runtimeBus,
        replayEngine: base.replayEngine,
        directory: shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'replay'),
        readConfig: (key) => config.get(key as Parameters<typeof config.get>[0]),
      });
      scope.registry.add('replay recording', () => replayRecording.stop());
      // What the Agents modal reads: this surface's own live registry UNION the
      // adopted daemon's rows, so the modal never shows half the fleet as if whole.
      const fleetReadModel = createFleetUnionReadModel({
        local: createFleetReadModel(processRegistry, options.runtimeBus),
        verbs,
      });
      scope.registry.add('fleet union refresh', () => fleetReadModel.stop());
      // Conversation-scope rewind, from ANY surface. The daemon holds the
      // checkpoint store and answers the files half; the messages live in this
      // process, so this offers them. Started on adoption (bootstrap.ts).
      const conversationRewindHost = createConversationRewindHost({
        verbs,
        // Undo snapshots beside the sessions, so a rewind can still be undone after a restart.
        port: createSessionConversationRewindPort({ undoDir: join(surface.sessionsDir, 'rewind-undo') }),
        hosts: hasSessionConversation,
        label: 'the terminal app',
        surface,
      });
      const requestConversationRewindStop = (): Promise<void> => {
        conversationRewindClosing ??= conversationRewindHost.stop();
        return conversationRewindClosing;
      };
      scope.registry.add('conversation rewind host', () => { void requestConversationRewindStop().catch(() => {}); });
      // Give the panel_only notification target a live producer.
      const notificationDispatcher = createNotificationDispatcher(config);
      wireRuntimeNotificationBridge(options.runtimeBus, notificationDispatcher);
      wireMemoryPressureNotice(options.runtimeBus, notificationDispatcher);
      // Stores close only after a rewind in flight has finished with them.
      scope.registry.add('conversation rewind drain', () => conversationRewindClosing);
      // While the daemon is reachable it is the one writer of its own settings:
      // a daemon-owned key set anywhere in this process goes to it
      // (ConfigManager.attachDaemonRoute). Detached when this graph closes.
      scope.registry.add('daemon settings route', configManager.attachDaemonRoute({
        reachable: () => daemonConfig.reachable(),
        write: (key, value) => daemonConfig.set(key, value),
        writeMany: (changes) => daemonConfig.setMany(changes),
        ...(daemonConfig.reset ? { reset: (key: string) => daemonConfig.reset!(key) } : {}),
        refused: (key, error) => logger.warn('The daemon refused a setting written from the terminal; the previous value is back', { key, error: summarizeError(error) }),
      }));
      // The scheduler's first copy is an hour after start, so it runs until the
      // daemon's status settles; the wake work waits for it (it starts fetching soon).
      let housekeepingClosed = false;
      const settleHomeHousekeeping = (daemonAdopted: boolean): void => {
        if (housekeepingClosed) return;
        if (daemonAdopted) {
          base.storeSnapshotScheduler.stop();
          base.stopWakeHousekeeping();
          return;
        }
        base.storeSnapshotScheduler.start();
        if (provisionWakeModels) base.startWakeHousekeeping();
      };
      const close = (): Promise<void> => {
        housekeepingClosed = true;
        void requestConversationRewindStop().catch(() => {});
        return base.close();
      };
      return {
        panelManager: viewPanelAdapter,
        keybindingsManager,
        workspaceTrustManager,
        trustPromptRef,
        requestTrustDecision,
        requestApproval,
        daemonVerbs: verbs,
        wireSessionDispatch,
        clientBuildGuard,
        settleHomeHousekeeping,
        conversationRewindHost,
        devices,
        daemonConfig,
        daemonCredentials,
        localPromptRef,
        liveSessionIdRef,
        notificationDispatcher,
        focusTracker,
        fleetReadModel,
        contractIntake,
        close,
        dispose: (): void => { void close().catch(() => {}); },
      };
    },
  });
}
