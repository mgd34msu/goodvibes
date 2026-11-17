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
import { composeRuntimeServices } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import { forwardGatewayMethodsToDaemon } from './gateway-daemon-forward.ts';
import { terminalRunsRoutines } from './terminal-routines.ts';
import { buildContinuationSpawnInput } from './continuation-spawn.ts';
import { gateConsolidationToLocalWriter } from './memory-consolidation-gate.ts';
import { createNotificationDispatcher, startNotificationFlush, wireRuntimeNotificationBridge, wireMemoryPressureNotice } from './notification-dispatch.ts';
import { resolveDaemonEnabled } from '@goodvibes-jev/engine/platform/platform/config';
import { createWorkspaceCheckpointing } from './workspace-checkpointing.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createViewPanelAdapter } from '../views/view-panel-adapter.ts';
import { createContractIntake } from '@goodvibes-jev/engine/platform/platform/contract';
import { KeybindingsManager } from '../input/keybindings.ts';
import { startReplayRecording } from '@goodvibes-jev/engine/platform/platform/core';
import type { WorkspaceTrustLevel } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
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
  const trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> } = {
    requestTrustDecision: async () => 'restricted',
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
  // With the daemon enabled (the default) it owns the home's shared housekeeping:
  // the daily copy of the canonical memory store and the wake-model sweep and
  // provisioning. This terminal's own stores stay its to keep.
  const daemonOwnsHomeHousekeeping = resolveDaemonEnabled(configManager);
  let conversationRewindClosing: Promise<void> | undefined;

  return composeRuntimeServices({
    surface: 'tui',
    roots: {
      surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
      workingDir: workingDirectory,
      homeDirectory,
      daemonHome: options.daemonHomeDirectory,
      sessionStorePath: shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'control-plane', 'sessions.json'),
      // This installation's own pairing tokens.
      pairingTokenPath: shellPaths.resolveUserPath('control-plane', 'pairing-tokens.json'),
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
      panelManager: viewPanelAdapter,
      keybindingsManager,
      localUserAuthManager: options.localUserAuthManager,
      modelDiscovery: options.modelDiscovery,
      powerSeam: options.powerSeam,
      currentSessionId: options.currentSessionId,
      provisionWakeModelsAtBoot: options.provisionWakeModelsAtBoot === true && !daemonOwnsHomeHousekeeping,
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
    taskGraphReaping: 'never',
    profileCapture: false,
    extras: (base, scope) => {
      const requestApproval = clientRaiserRef.current;
      const workspaceTrustManager = base.workspaceTrustManager;
      if (!requestApproval || !workspaceTrustManager) throw new Error('The terminal graph was composed without its approval raiser or trust owner');
      const { agentManager, configManager: config, providerRegistry, sessionBroker, contractRunner, processRegistry, surface } = base;
      if (daemonOwnsHomeHousekeeping) base.storeSnapshotScheduler.stop();
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
      const continuationRunner = async ({ task, input }: ContinuationRequest): Promise<SharedSessionContinuationOutcome> => {
        // Held, not declined with null: null reads as "consumed", and the message
        // would be lost instead of waiting for the restarted terminal.
        if (!clientBuildGuard.maySharedSessionWork()) {
          logger.warn('declined a shared-session continuation: this build is below the daemon floor', {
            sessionId: input.sessionId,
            floor: clientBuildGuard.current().floor,
          });
          return { disposition: 'held', reason: 'this terminal build is below the daemon floor; restart it to process this message' };
        }
        const record = agentManager.spawn(buildContinuationSpawnInput({ task, input }, {
          configReader: config,
          modelCandidates: providerRegistry.listModels(),
        }));
        return { agentId: record.id };
      };
      sessionBroker.setContinuationRunner(continuationRunner);
      wireSessionDispatch.setContinuationRunner(continuationRunner);
      const focusTracker = new FocusTracker();
      // Every turn is recorded as a run /replay can load (one line per turn, tool and task event).
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
      scope.registry.add('notification flush', startNotificationFlush(notificationDispatcher));
      // Stores close only after a rewind in flight has finished with them.
      scope.registry.add('conversation rewind drain', () => conversationRewindClosing);
      // While the daemon is reachable it is the one writer of its own settings:
      // a daemon-owned key set anywhere in this process goes to it
      // (ConfigManager.attachDaemonRoute). Detached when this graph closes.
      scope.registry.add('daemon settings route', configManager.attachDaemonRoute({
        reachable: () => daemonConfig.reachable(),
        write: (key, value) => daemonConfig.set(key, value),
        ...(daemonConfig.reset ? { reset: (key: string) => daemonConfig.reset!(key) } : {}),
        refused: (key, error) => logger.warn('The daemon refused a setting written from the terminal; the previous value is back', { key, error: summarizeError(error) }),
      }));
      const close = (): Promise<void> => { void requestConversationRewindStop().catch(() => {}); return base.close(); };
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
