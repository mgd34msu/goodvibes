import { createPendingHostServices } from '@goodvibes/engine/terminal-shell/host-service-status';
import { joinPromptParts } from '@goodvibes/engine/terminal-shell/prompt-parts';
import {
  createPluginCommandAdapter,
  wireTerminalMcpReload,
  announceTerminalSessionStarted,
} from '@goodvibes/engine/terminal-shell/bootstrap-lifecycle';
import { createTerminalOrchestrator, terminalCompanionInputHandler } from '@goodvibes/engine/terminal-shell/bootstrap-orchestrator';
import { buildPluginStartupContext } from '@goodvibes/engine/terminal-shell/plugin-startup';
import { createPluginStartupTask } from '@goodvibes/engine/terminal-shell/plugin-startup';
import { ownerInputFor } from '@goodvibes/engine/terminal-shell/companion-input';
/**
 * Bootstrap composition root for goodvibes-tui.
 *
 * Initializes all runtime subsystems in dependency order and returns a
 * RuntimeContext that main.ts uses to drive the render loop and terminal I/O.
 *
 * Separation of concerns:
 *   - bootstrap.ts: initialization, event wiring, manager setup
 *   - main.ts: terminal setup, render loop, stdin/stdout handlers
 *   - lifecycle.ts: save/shutdown helpers
 */
import { join } from 'node:path';
import { bearerFor } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target';
import { resolveDaemonTargetProven } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';
import { daemonLifecycleMarkerPathForHome } from '@goodvibes/engine/platform/platform/daemon/lifecycle-marker';
import { resolveGoodVibesDaemonHome } from '@goodvibes/engine/platform/platform/config/goodvibes-home';
import { AcpManager } from '@goodvibes/engine/platform/platform/acp';
import { readTierPromptSupplement } from '@goodvibes/engine/platform/platform/providers';
import { factsFor } from '@goodvibes/engine/platform/platform/routing';
import { createTaskInterventions } from '@goodvibes/engine/terminal-shell/task-interventions';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { PermissionRequestHandler } from '@goodvibes/engine/platform/platform/permissions';
import type { WorkspaceTrustLevel } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { GitStatusProvider, GitHeaderInfo } from '../renderer/git-status.ts';
import type { SelectionManager } from '@goodvibes/engine/terminal-shell';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import {
  createTaskManager,
  AcpTaskAdapter,
  loadLastConversation,
  leaveHostedSessionOnExit,
  scheduleBackgroundMcpDiscovery,
  restoreSavedModel,
  startExternalServices,
  type ExternalServicesHandle,
  createDeferredStartupCoordinator,
} from '@/runtime/index.ts';
import { bindWriteLastSessionPointerToSurface, ProcessTaskAdapter } from '@goodvibes/engine/platform/platform/runtime/operations';
import { deriveSpineFooterStatus, forwardCheckpointChangesToDaemon, type SessionSpineClient, type SessionSpineRestConnection } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import { transportRetryHooks } from '@goodvibes/engine/platform/platform/runtime/emitters';
import { bindControlCommands } from './control-surfaces.ts';
import { bindCapabilityHost, hiddenLineFrom } from '@goodvibes/engine/terminal-shell/capability-host';
import { sessionCapabilityServices } from '../input/commands/session-capabilities.ts';
import { formatWorktreeStartupReport } from '@goodvibes/engine/platform/platform/runtime/shell';
import { createSpineAdoptionSync } from './client/spine-adoption.ts';
import { announceDaemonAttached } from './daemon-attach-signal.ts';
import { pruneStaleOperatorTokens } from '@goodvibes/engine/platform/platform/pairing';
import { workspaceOperatorTokenCandidates } from '@goodvibes/engine/platform/platform/runtime/operations';
import type { UiRuntimeServices } from './ui-services.ts';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { createBootstrapShutdown } from './bootstrap-shutdown.ts';
import { ensureBootModelResolvable } from './provider-fallback.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import type { ShellViews } from '../views/builtin-views.ts';
import { announceInstallHealth } from './install-self-check-startup.ts';
import { buildSharedOrchestratorCoreServices, refreshMemoryRecallSnapshot } from './orchestrator-core-services.ts';
import { bindSessionContextAccounting } from '@goodvibes/engine/platform/platform/tools';
import {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  daemonAddressAnswers,
  DAEMON_PROGRAM_STARTED_LINE,
  daemonNotInstalledNotice,
  daemonProgramStartFailedLine,
  describeDaemonAutostart,
  waitForStartingDaemon,
  type DaemonServiceControl,
} from '@goodvibes/engine/platform/platform/runtime/client';
import { createDaemonAttachHandshake } from './client/daemon-attach-handshake.ts';
import { createPendingServiceStatus, hostServiceIsActive, hostServiceIsBlocked } from './client/host-service-status.ts';
import { createRelayReadAccessors } from './relay-reachability-bridge.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { registerStartupProviders } from './startup-provider-registration.ts';
import { createSerialSteps } from './serial-steps.ts';
import { wireFailedTurnActions } from '@goodvibes/engine/terminal-shell/turn-failure-actions';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '@goodvibes/engine/platform/platform/runtime/feature-announcements';

type ExternalServiceFactories = NonNullable<Parameters<typeof startExternalServices>[3]>;

/** The announce-once id of "no daemon is installed": said once on this machine, said again after one was found. */
const DAEMON_NOT_INSTALLED_ANNOUNCEMENT = 'daemon-not-installed';

// ── Bootstrap context type ──────────────────────────────────────────────────

/**
 * The fully-initialized context returned by bootstrapRuntime().
 *
 * A typed superset of RuntimeContext that exposes the additional fields required
 * by main.ts (UI-layer objects that do not belong in the shared RuntimeContext
 * interface, since they are not needed by anything else).
 */
export type BootstrapContext = RuntimeContext & {
  /** Compositor handles double-buffered terminal output. */
  compositor: Compositor;
  /** Manages text selection state. */
  selection: SelectionManager;
  /** Context object passed to slash-command handlers. */
  commandContext: CommandContext;
  /** Shell-facing read models, events, and narrow runtime services. */
  uiServices: UiRuntimeServices;
  /** The always-on read models and config-modal surfaces behind the built-in modals. */
  views: ShellViews;
  /** Persists and navigates input history across sessions. */
  inputHistory: InputHistory;
  /** Provides git branch/dirty state for the header. */
  gitStatusProvider: GitStatusProvider;
  /** Mutable ref so async git refreshes propagate without closure capture issues. */
  lastGitInfoRef: { value: GitHeaderInfo | undefined };
  /** Unsubscribe functions owned by bootstrap (cleared on shutdown). */
  bootstrapUnsubs: Array<() => void | Promise<void>>;
  /** Mutable refs for viewport/scroll/render functions; main.ts patches these after constructing UI state. */
  orchestratorRefs: { getViewportHeight: () => number; scrollToEnd: (vHeight: number) => void; requestRender: () => void };
  /** Patch the bootstrap-owned render bridge after main.ts constructs the real render loop. */
  setRenderRequest: (fn: () => void) => void;
  /** Shell-owned permission prompt bridge that main.ts patches after UI setup. */
  permissionPromptRef: { requestPermission: PermissionRequestHandler };
  /** Shell-owned trust-decision bridge that main.ts patches after UI setup (trust asks at consequence time). */
  trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel>; awaitingOwner?: boolean };
  /** True once exit has durably saved the session, even while releases still run. */
  sessionSaved?: () => boolean;
  /**
   * Settles once the local daemon was found, or started when it was installed and stopped, or found missing
   * (said in one line). The first turn waits for it, so the model's daemon capabilities have a daemon to run on.
   */
  daemonReady?: Promise<void>;
  /**
   * The one line a headless run says about the local daemon, once the start settled it: none is installed here (and
   * how to install it), or the daemon program was started here ("Started the GoodVibes daemon.") or failed to; else undefined.
   */
  daemonMissing?: () => string | undefined;
  /** Load the most recently saved conversation from disk. */
  loadLastConversation: () => { messages: Array<Record<string, unknown>> } | null;
  /** Write the last-session pointer file (used after session resume). */
  _writeLastSessionPointer: (sessionId: string) => void;
  /** The daemon session spine, for session switches made outside the hook bridge (crash-recovery accept). */
  _sessionSpine: SessionSpineClient;
  /** Retrieve pinned model IDs for the model picker. */
  _getPinned: () => Promise<string[]>;
  /** Retrieve configured provider IDs for the model picker. */
  _getConfiguredProviderIds: () => string[];
  /** Command registry used by InputHandler. main.ts needs this to wire input. */
  commandRegistry: import('../input/command-registry.ts').CommandRegistry;
  /**
   * System message router instantiated at startup, wired to conversation.
   *
   * @remarks
   * Route operational messages through this rather than calling
   * conversation.addNotice() directly so routing-target config
   * (target 'panel' / 'conversation' / 'both') and the forced-inline critical prefixes stay
   * centralized in one place.
   */
  systemMessageRouter: SystemMessageRouter;
};

// ── Bootstrap function ────────────────────────────────────────────────────

/**
 * Initialize all runtime subsystems and return a fully-wired RuntimeContext.
 *
 * main.ts calls this once, then uses the returned context to:
 *   - Run the render loop
 *   - Handle stdin/stdout events
 *   - Manage terminal lifecycle (alt-screen, raw mode, resize)
 *
 * Phase summary:
 *   1. Config, caches, keybindings
 *   2. Runtime event bus, conversation, compositor, selection
 *   3. Tool registry + agent wiring
 *   4. Runtime bus subscriptions (WRFC, subagent, hook bridge)
 *   5. Providers, webhooks, PermissionManager, HookDispatcher
 *   6. Orchestrator + AcpManager
 *   7. MCP auto-connect + workspace/view manager
 *   8. Command registry + plugin init + CommandContext
 *   9. Input handler wiring
 *  10. Input history, splash options
 *  11. Provider auto-registration and persisted providers; discovery is explicit
 */
export async function bootstrapRuntime(stdout: NodeJS.WriteStream, options: BootstrapOptions): Promise<BootstrapContext> {
  const workingDir = options.workingDir;
  const configManager = options.configManager;
  const {
    userSessionId,
    runtimeBus,
    store,
    services,
    uiServices,
    conversation,
    compositor,
    selection,
    toolRegistry,
    fileCache,
    projectIndex,
    permissionManager,
    forensicsCollector,
    forensicsRegistry,
    runtime,
    bootstrapUnsubs,
    runtimeUnsubs,
    permissionPromptRef,
    trustPromptRef,
    systemMessageRouterRef,
    conversationFollowUpRef,
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest,
    runtimeSessionIdRef,
    sessionSpine,
    sessionInboundInputs,
    sessionUnionCache,
  } = await initializeBootstrapCore(stdout, options);
  const providerRegistry = services.providerRegistry;
  const { hookDispatcher, pluginManager } = services;
  options.onHookDispatcherReady?.({ runtime, surface: services.surface, hookDispatcher });
  // A saved custom-provider model must never crash boot, see provider-fallback.ts.
  const bootModelSubstitution = await ensureBootModelResolvable(providerRegistry, configManager);

  // ── Phase 6: Orchestrator + AcpManager ───────────────────────────────────

  // Mutable function refs so main.ts can patch these after constructing the scroll/viewport state.
  // The orchestrator closes over these refs, so patching them in main.ts takes immediate effect.

  const { orchestrator, orchestratorRefs } = createTerminalOrchestrator(
    {
      conversation,
      toolRegistry,
      permissionManager,
      getSystemPrompt: async (signal) => {
        signal?.throwIfAborted();
        const currentModel = providerRegistry.getCurrentModel();
        const supplement = await readTierPromptSupplement(
          factsFor({ catalog: providerRegistry }, currentModel),
          providerRegistry.modelTiers,
          'tui.conversation-system-prompt',
          { audience: 'conversation', signal },
        ).catch((error: unknown) => {
          signal?.throwIfAborted();
          logger.warn('Optional model guidance unavailable; continuing conversation', { error: summarizeError(error) });
          return '';
        });
        signal?.throwIfAborted();
        return joinPromptParts(runtime.systemPrompt, supplement);
      },
      hookDispatcher,
      flagManager: services.featureFlags,
      runtimeBus,
      sessionId: runtime.sessionId,
      resolveSessionId: () => runtime.sessionId,
      services: {
        agentManager: services.agentManager,
        // This program runs no contracts: its work runs on the daemon and is read in Work.
        contractRunner: services.contractRunner,
      },
    },
    requestRender,
  );
  conversationFollowUpRef.value = (item) => orchestrator.enqueueConversationFollowUp(item);
  // A companion message is the owner speaking from another device: once the shell
  // has bound the owner-input route it takes the composer's turn path (retry
  // context, failure status, memory refresh); before that it runs a local turn.
  const localCompanionInput = terminalCompanionInputHandler(
    orchestrator,
    (err) => {
      logger.debug('companion handleUserInput safety catch', { error: String(err) });
    },
    () => {
      void refreshMemoryRecallSnapshot(services);
    },
  );
  orchestratorHandleUserInputRef.value = (text, inputOptions, answered) => {
    const route = ownerInputFor(orchestrator);
    if (route) route(text, inputOptions, answered);
    else localCompanionInput(text, inputOptions, answered);
  };
  // Shared payload (single source of truth, includes the memoryRegistry,
  // see orchestrator-core-services.ts) plus this site's cacheHitTracker.
  orchestrator.setCoreServices({
    ...buildSharedOrchestratorCoreServices({ services, configManager, providerRegistry }),
    cacheHitTracker: services.cacheHitTracker,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  // context_accounting answers for this session (the platform's one session
  // source, as the Agent and hosted sessions bind it): its injections, token use
  // and compaction, following a resume or fork.
  bootstrapUnsubs.push(bindSessionContextAccounting(services.contextAccountingHolder, {
    orchestrator,
    runtimeBus,
    getSessionId: () => runtime.sessionId,
    getContextWindow: () => {
      const known = providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel());
      return known !== null && known > 0 ? known : null;
    },
    // The session's compaction count from its owner, the counter /compact reads.
    getCompactionCount: () => services.sessionLineageTracker.getCompactionCount(),
  }));

  const acpLifetime = new AbortController();
  bootstrapUnsubs.push(() => acpLifetime.abort());
  const acpManager = new AcpManager({
    permissionHost: { port: services.judgment.port, permissionManager, config: configManager, signal: acpLifetime.signal },
    runtimeBus,
    hookDispatcher: services.hookDispatcher,
  });
  // Every subagent still running is stopped at exit (SIGTERM, then SIGKILL once its grace runs out).
  bootstrapUnsubs.push(() => acpManager.close());
  // The subagents' own spawn/complete/fail/cancel events keep their task rows current.
  const acpTaskAdapter = new AcpTaskAdapter(store);
  bootstrapUnsubs.push(acpTaskAdapter.attachRuntimeBus(runtimeBus));
  orchestrator.registerDelegateTool(acpManager);
  // Background processes are tasks from start to exit, and a task cancel stops the process.
  const processTaskAdapter = new ProcessTaskAdapter(store, services.processManager);
  bootstrapUnsubs.push(processTaskAdapter.attach({ sessionId: userSessionId }));
  // An ACP task row's owner is its subagent id; the ACP manager can stop it and nothing else.
  // Task events carry the running session, which a resume or fork changes.
  const opsTaskManager = createTaskManager(store, runtimeBus, () => runtime.sessionId, services.featureFlags,
    (task) => task.kind === 'acp' ? { cancel: () => acpManager.cancel(task.owner) }
      : task.kind === 'exec' ? processTaskAdapter.controllerFor(task.id) : undefined);
  // Pause, go on, cancel and run again on this session's tasks: the one plane both programs build.
  const opsControlPlane = createTaskInterventions({ taskManager: opsTaskManager, runtimeBus, store, sessionId: userSessionId,
    agentCanceller: services.agentManager, featureFlags: services.featureFlags });

  // One surface-bound pointer writer, shared by the resume seam below and the
  // context's `_writeLastSessionPointer`. Both slots want a one-argument
  // function; handing them the platform's two-argument export directly is what
  // silently stopped the pointer from ever being written (see
  // session-pointer-surface.ts).
  const writeSessionPointer = bindWriteLastSessionPointerToSurface(services.surface);
  const shell = createBootstrapShell({
    ...(options.daemonHomeDirectory ? { daemonHomeDirectory: options.daemonHomeDirectory } : {}),
    configManager,
    runtimeBus,
    runtimeStore: store,
    services,
    sessionSpine,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    onSessionIdChanged: (sessionId) => {
      runtimeSessionIdRef.value = sessionId;
    },
    writeLastSessionPointer: writeSessionPointer,
    toolRegistry,
    forensicsRegistry,
    policyRuntimeState: services.policyRuntimeState,
    uiServices,
    taskManager: opsTaskManager,
    opsControlPlane,
    acpManager,
    completeModelSelectionSideEffect: () => {
      compositor.resetDiff();
    },
  });
  const systemMessageRouter = shell.systemMessageRouter;
  systemMessageRouterRef.value = systemMessageRouter;
  if (bootModelSubstitution) {
    systemMessageRouter.high(
      `[Startup] Configured model '${bootModelSubstitution.configured}' is unavailable; using '${bootModelSubstitution.replacement}' this session. Your saved model is unchanged.`,
      'warning',
    );
  }
  // Work has one runner, the daemon's: this app resumes no contract of its own (a delegation is a piece of work on the
  // daemon, which runs on whether this app is open; runtime/services.ts).
  // An older decision log carried forward to its smaller form says once how much space came back.
  void services.judgment.decisionLogCarriedForward.then((text) => { if (text) systemMessageRouter.high(`[Decision log] ${text}`); });
  const commandRegistry = shell.commandRegistry;
  bindControlCommands(services, commandRegistry);
  const commandContext = shell.commandContext;
  // The model's capability tools find every action of this app's commands and run the conversation's own on this conversation.
  bootstrapUnsubs.push(bindCapabilityHost({
    commands: () => commandRegistry.getAll(), session: () => sessionCapabilityServices(commandContext),
    // The composer's hidden line, once the screen has set it up: a value a model's call needs is typed there.
    hidden: () => hiddenLineFrom(commandContext),
  }));
  // A failed or refused turn is a row in the transcript with its next steps on keys: alt+o picks
  // another model for the prompt, alt+i opens its details, alt+s the sign-ins (alt+r is the shell's retry chord).
  wireFailedTurnActions({
    commandContext,
    render: requestRender,
  });
  announceInstallHealth(systemMessageRouter);
  // Retention for worktrees earlier runs left (the daemon runs the same pass at its start). Everything it removed
  // and each worktree it kept for the owner's decision is shown, once per worktree; only the disk-use line alone stays in the activity feed.
  void services.worktreeRegistry.startupSweep({ tellOnce: true }).then((report) => {
    const text = report ? formatWorktreeStartupReport(report, workingDir) : null;
    if (!text || !report) return;
    if (report.removed.length > 0 || report.attention.length > 0 || report.failed.length > 0) systemMessageRouter.high(`[Worktrees] ${text}`, report.attention.length > 0 || report.failed.length > 0 ? 'warning' : 'info');
    else systemMessageRouter.low(`[Worktrees] ${text}`);
  });
  const { gitStatusProvider, inputHistory, lastGitInfoRef } = shell;
  // FIX 2: dispose the header's live-repo-state poll (git-status.ts
  // startPolling) on shutdown, same pattern as acpTaskSyncInterval above.
  bootstrapUnsubs.push(() => gitStatusProvider.stopPolling());
  if (shell.closeNativeWorkSubmission) bootstrapUnsubs.push(shell.closeNativeWorkSubmission);
  const pluginCommandRegistry = createPluginCommandAdapter(commandRegistry);

  // ── Phase 7: External services + deferred startup ──────────────────────

  const deferredStartup = createDeferredStartupCoordinator();

  // Adopting a daemon: session identity, the inbound steer path, the
  // cross-surface union read, and the memory spine, see client/spine-adoption.ts.
  const syncSessionSpineToHostStatus = createSpineAdoptionSync({
    sessionSpine,
    memorySpine: services.memorySpine,
    sessionInboundInputs: sessionInboundInputs as unknown as Parameters<typeof createSpineAdoptionSync>[0]['sessionInboundInputs'],
    sessionUnionCache: sessionUnionCache as unknown as Parameters<typeof createSpineAdoptionSync>[0]['sessionUnionCache'],
    legacyStorePath: services.shellPaths.resolveProjectPath(GOODVIBES_TUI_SURFACE_ROOT, 'control-plane', 'sessions.json'),
    workingDirectory: services.workingDirectory,
    retryHooks: transportRetryHooks(runtimeBus, { sessionId: userSessionId, traceId: `${userSessionId}:daemon-http`, source: 'bootstrap' }, 'http'),
    // Both ride adoption. A message submitted into a session this surface hosts
    // must reach the loop here, because the loop is here; and a rewind driven
    // from the web app or another terminal is answerable only by the process
    // holding the messages, which is also here.
    onAdopted: (client) => {
      services.wireSessionDispatch.activate(client as never);
      if (runtime.sessionId) services.conversationRewindHost.start(runtime.sessionId);
    },
    onDetached: (reason) => {
      services.wireSessionDispatch.deactivate(reason);
      void services.conversationRewindHost.stop();
    },
  });

  // The home's shared housekeeping is the adopted daemon's; with none adopted
  // (not installed, stopped, blocked, disabled) this terminal keeps it.
  const settleHomeHousekeeping = (): void => {
    const adopted = externalServices.daemonStatus.mode === 'external';
    services.settleHomeHousekeeping(adopted);
  };

  const inspectExternalServices = () => {
    const daemonStatus = externalServices.daemonStatus;
    const httpListenerStatus = externalServices.httpListenerStatus;
    return {
      daemonRunning: hostServiceIsActive(daemonStatus),
      daemonPortInUse: hostServiceIsBlocked(daemonStatus),
      httpListenerRunning: hostServiceIsActive(httpListenerStatus),
      httpListenerPortInUse: hostServiceIsBlocked(httpListenerStatus),
      daemonStatus,
      httpListenerStatus,
      // Honest session-spine posture, independent of daemonRunning, degrades to 'offline'
      // when adopted-but-unreachable even though daemonRunning might still read a stale
      // handle as true; sessionSpine.status() alone is activity-gated, so it's derived
      // together with the union cache's 5s liveness probe (one signal, no new timer).
      sessionSpineActive: sessionSpine.active,
      sessionSpineStatus: deriveSpineFooterStatus(sessionSpine.status(), sessionUnionCache.crossSurfaceView),
      sessionSpineRefusal: sessionSpine.refusal(),
    };
  };

  // ADOPT ONLY. This app never constructs a DaemonServer or an HttpListener: the
  // daemon is a separate product with its own binary and its own service unit,
  // and the platform's host services only adopt one. The daemon and the
  // credential bound to it come from the resolver every client request uses,
  // read at every start, so a restart after "connect to an existing daemon"
  // looks there with that daemon's own token. This machine's token is minted
  // when absent, so the pairing QR's bearer authenticates against it.
  const createExternalServiceFactories = async (): Promise<ExternalServiceFactories> => ({
    daemon: await resolveDaemonTargetProven({
      configManager,
      homeDirectory: services.homeDirectory,
      mode: 'mint',
      client: GOODVIBES_TUI_SURFACE_ROOT,
    }),
  });
  // The bearer bound to the daemon a start looked at, for the attach handshake; empty when none is held for it.
  const adoptedDaemonToken = (handle: ExternalServicesHandle): string => {
    const target = handle.daemonTarget;
    return target?.credential ? bearerFor(target.credential, target.origin.baseUrl) : '';
  };
  const startDaemonServices = async (): Promise<void> => {
    externalServicesPromise = createExternalServiceFactories().then((factories) =>
      startExternalServices(configManager, hookDispatcher, services, factories));
    externalServices = await externalServicesPromise;
  };

  // Replacing the external-services handle is one step at a time and always
  // releases the handle it replaces: an adopted handle still owns probes and
  // listeners, and two swaps interleaving would leave one of them orphaned.
  const swapExternalServices = createSerialSteps();

  // The one bounded recovery step: a daemon that is INSTALLED on this machine
  // and simply stopped gets started once and waited for, rather than becoming
  // the user's homework. Every boundary is in the platform's client/daemon-autostart.ts.
  // Adopting a daemon the service manager just brought up: a fresh discovery, the attach handshake, the home's housekeeping.
  const adoptStartedDaemon = async (): Promise<void> => {
    await swapExternalServices(async () => {
      try {
        await externalServices.stop();
      } catch (error) {
        logger.debug('Releasing the previous external services failed', { error: summarizeError(error) });
      }
      await startDaemonServices();
    });
    await daemonHandshake.attach(adoptedDaemonToken(externalServices));
    settleHomeHousekeeping();
  };
  // That no daemon is installed is said once on this machine, not at every start; once a
  // daemon is found the announce-once id is forgotten, so losing it again is said again.
  const announcements = new FeatureAnnouncementStore(featureAnnouncementsPath(configManager));
  let missingDaemonLine: string | undefined;
  const announceAutostart = (outcome: Parameters<typeof describeDaemonAutostart>[0]): void => {
    // A headless run says it on every run (ctx.daemonMissing); the interface once on this machine.
    if (outcome.action === 'not-installed') missingDaemonLine = daemonNotInstalledNotice(outcome);
    // The daemon program started here, or failed to: said once in this run (a headless run on its standard error).
    if (outcome.action === 'program-started') missingDaemonLine = DAEMON_PROGRAM_STARTED_LINE;
    if (outcome.action === 'program-start-failed') missingDaemonLine = daemonProgramStartFailedLine(outcome.reason);
    if (outcome.action === 'not-installed' && !announcements.record(DAEMON_NOT_INSTALLED_ANNOUNCEMENT)) return;
    if (externalServices.daemonStatus.mode === 'external') announcements.forgetMatching((id) => id === DAEMON_NOT_INSTALLED_ANNOUNCEMENT);
    const notice = describeDaemonAutostart(
      outcome,
      externalServices.daemonStatus.mode === 'external',
      externalServices.daemonStatus.reason ?? externalServices.daemonStatus.mode,
    );
    if (notice) systemMessageRouter[notice.level](notice.text);
    requestRender();
  };
  // A daemon still starting when the boot-time wait ended is waited for off the
  // interactive path, on its lifecycle marker turning ready or its unit
  // stopping; nothing waits on it, and exit ends the wait. On ready it is
  // adopted and the status bar redraws.
  const startingDaemonWait = new AbortController();
  bootstrapUnsubs.push(() => startingDaemonWait.abort());
  const adoptWhenStarted = (control: DaemonServiceControl, serviceName: string, since: number, startedHere = false): void => {
    void waitForStartingDaemon({
      control,
      serviceName,
      since,
      markerPath: daemonLifecycleMarkerPathForHome(services.homeDirectory),
      signal: startingDaemonWait.signal,
    })
      .then(async (result) => {
        if (result === 'online') {
          await adoptStartedDaemon();
          // Started by this program's start of the service: said as started, not as one that was already starting.
          announceAutostart(startedHere ? { action: 'started', serviceName } : { action: 'came-online', serviceName });
        } else if (result === 'stopped') {
          announceAutostart({
            action: 'start-failed',
            serviceName,
            reason: `service "${serviceName}" stopped before the daemon answered (the service manager no longer reports it running), check its logs`,
          });
        }
      })
      .catch((error: unknown) => logger.warn('Adopting the daemon once it answered failed', { error: summarizeError(error) }));
  };

  const maybeStartInstalledDaemon = async (): Promise<void> => {
    // Pointed at a daemon elsewhere: starting this machine's daemon would not reach it.
    if (externalServices.daemonTarget && !externalServices.daemonTarget.thisMachine) return;
    try {
      // The service's unit and pid file live under the login home the
      // control resolves, not this app's tree home.
      const control = createDaemonServiceControl({
        configManager,
        workingDirectory: services.workingDirectory,
      });
      const isReachable = async (): Promise<boolean> => (await sessionSpine.probeReachability()) === 'online';
      const outcome = await autostartInstalledDaemon({
        daemonMode: externalServices.daemonStatus.mode,
        control,
        isReachable,
        // A daemon program started here may be the first ever: it is heard at its address before any credential exists.
        programAnswers: () => daemonAddressAnswers(configManager),
      });
      if (outcome.action === 'started' || outcome.action === 'came-online' || outcome.action === 'program-started') await adoptStartedDaemon();
      if (outcome.action === 'starting') adoptWhenStarted(control, outcome.serviceName, outcome.since, outcome.startedHere === true);
      announceAutostart(outcome);
    } catch (error) {
      logger.debug('Boot-time daemon start check failed', { error: summarizeError(error) });
    }
  };

  let externalServices: ExternalServicesHandle = createPendingHostServices((name) => createPendingServiceStatus(configManager, name));
  let externalServicesPromise: Promise<ExternalServicesHandle> | null = null;
  const platformExternalServices = uiServices.platform as typeof uiServices.platform & {
    externalServices: NonNullable<typeof uiServices.platform.externalServices>;
  };
  platformExternalServices.externalServices = {
    // The relay is a DAEMON feature: its state and pairing payload are asked of
    // the adopted daemon through its relay verbs, see relay-reachability-bridge.ts.
    ...createRelayReadAccessors(services.daemonVerbs),
    inspect: inspectExternalServices,
    restart: () => swapExternalServices(async () => {
      if (externalServicesPromise) {
        try {
          externalServices = await externalServicesPromise;
        } catch {
          // A failed previous startup should not prevent a restart attempt.
        }
      }
      await externalServices.stop();
      await startDaemonServices();
      await daemonHandshake.attach(adoptedDaemonToken(externalServices));
      settleHomeHousekeeping();
      requestRender();
      return inspectExternalServices();
    }),
  };
  /** The daemon the spine adopted and its credential, for the checkpoint notice; null when none is adopted. */
  let adoptedDaemonConnection: SessionSpineRestConnection | null = null;
  // Attaching to a daemon settles both build floors and its undelivered
  // receipts off one /status read, see client/daemon-attach-handshake.ts.
  const daemonHandshake = createDaemonAttachHandshake({
    clientBuildGuard: services.clientBuildGuard,
    readDaemonStatus: () => externalServices.daemonStatus,
    recordRefusal: (status) => {
      externalServices = { ...externalServices, daemonStatus: status };
    },
    adopt: (status, daemonToken) => {
      adoptedDaemonConnection = status.mode === 'external' && status.baseUrl !== '' ? { baseUrl: status.baseUrl, token: daemonToken } : null;
      syncSessionSpineToHostStatus(status, daemonToken);
      // A daemon adopted (at start, or one that came up later): what could not be read reads again.
      if (adoptedDaemonConnection) announceDaemonAttached();
    },
    notify: (text) => {
      systemMessageRouter.high(`[Daemon] ${text}`);
      requestRender();
    },
  });
  // A checkpoint this terminal makes, prunes or removes is announced only in this process; the
  // adopted daemon passes it on to its subscribed clients (sessions.checkpoints.changed). Sent while
  // the spine is online and the daemon holds this session; one made before that (the start-of-session
  // checkpoint) is announced once the daemon registers the session. With no daemon nothing is sent.
  bootstrapUnsubs.push(forwardCheckpointChangesToDaemon({
    spine: sessionSpine,
    sessionId: () => runtime.sessionId,
    connection: () => adoptedDaemonConnection,
  }));
  // A liveness flip is only PAINTED once something calls requestRender(); without
  // this, the footer's spine segment sat correct-but-undrawn until incidental activity redrew it (minutes, during an idle stretch).
  // The same flip is what tells the handshake a daemon came back.
  sessionUnionCache.setOnTransition((online) => {
    requestRender();
    daemonHandshake.onLivenessTransition(online);
    // Readers that failed while the daemon was away (a place's lists) read again now.
    if (online) announceDaemonAttached();
  });
  deferredStartup.schedule(
    createPluginStartupTask(
      pluginManager,
      () => buildPluginStartupContext({ runtimeBus, commandRegistry: pluginCommandRegistry, providerRegistry, toolRegistry }, services),
      requestRender,
      (message) => systemMessageRouter.high(message),
    ),
  );
  const externalServicesStarted = deferredStartup.schedule({
    label: 'external-services',
    run: async () => {
      const daemonHomeDir = resolveGoodVibesDaemonHome(services.homeDirectory);
      // Remove stale pre-0.21.28 workspace-scoped operator
      // token files so only the canonical <daemonHomeDir>/operator-tokens.json survives.
      // The prune is best-effort, it silently skips missing files, no-ops when tokens
      // already match, and records un-deletable candidates in `failedPaths` for logging.
      // See `pruneStaleOperatorTokens` in the platform for semantics.
      const prune = pruneStaleOperatorTokens({
        daemonHomeDir,
        candidatePaths: workspaceOperatorTokenCandidates(services.workingDirectory, GOODVIBES_TUI_SURFACE_ROOT),
      });
      if (prune.prunedPaths.length > 0) {
        logger.info(`[bootstrap] Pruned ${prune.prunedPaths.length} stale operator-token file(s): ${prune.prunedPaths.join(', ')}`);
      }
      if (prune.failedPaths.length > 0) {
        logger.warn(
          `[bootstrap] Failed to prune ${prune.failedPaths.length} stale operator-token file(s) (permission/race): ${prune.failedPaths.join(', ')}`,
        );
      }
      await startDaemonServices();
      // Installed-but-stopped recovery, before anything reads the status.
      await maybeStartInstalledDaemon();
      await daemonHandshake.attach(adoptedDaemonToken(externalServices));
      settleHomeHousekeeping();
      requestRender();
    },
    onError: (error) => {
      const message = summarizeError(error);
      logger.error('Deferred external service startup failed', { error: message });
      systemMessageRouter.high(`[Startup] Background services failed to start: ${message}`, 'error');
      requestRender();
    },
  });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
    // The palette key as bound (the person's keybindings.json included), for the splash hint.
    commandPaletteKey: services.keybindingsManager.getComboLabel('command-palette'),
  };

  // ── Phase 8: Restore known providers; scanning is the daemon's ──────

  registerStartupProviders({
    configManager,
    providerRegistry,
    runtime,
    requestRender,
    restoreRuntimeModel: restoreSavedModel,
    systemMessageRouter,
    shellPaths: services.shellPaths,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
  });
  const mcpDiscovery = scheduleBackgroundMcpDiscovery({
    mcpRegistry: services.mcpRegistry,
    systemMessageRouter,
    requestRender,
    shellPaths: services.shellPaths,
    surfaceRoot: GOODVIBES_TUI_SURFACE_ROOT,
    // A headless run starts them on its turn's first `mcp` call (turn-tool-composition.ts).
    connectOnStart: options.toolServersOnFirstUse !== true,
  });
  wireTerminalMcpReload(services.shellPaths, services.mcpRegistry, mcpDiscovery, bootstrapUnsubs, systemMessageRouter, requestRender);
  // Schedules belong to the daemon, so each runs once with or without a program open. Any an earlier terminal app
  // kept in its own file are taken by the daemon itself when it starts (automation/manager-runtime.ts `load`).

  // ── Phase 12: Session:start lifecycle hook ─────────────────────────────

  announceTerminalSessionStarted(runtime.sessionId, workingDir, services.hookDispatcher, runtimeBus);

  // ── Compose RuntimeContext ────────────────────────────────────────────────

  const shutdown = createBootstrapShutdown({
    runtime,
    conversationTitle: () => conversation.title || '',
    bootstrapUnsubs,
    runtimeUnsubs,
    forensicsCollector,
    sessionSpine,
    sessionInboundInputs,
    sessionUnionCache,
    leaveHostedSession: () => leaveHostedSessionOnExit({ configManager, homeDirectory: services.homeDirectory }),
    deferredStartup,
    settleExternalServices: async () => {
      if (externalServicesPromise) externalServices = await externalServicesPromise;
    },
    stopExternalServices: () => externalServices.stop(),
    closeRuntimeGraph: () => services.close(),
    scheduleManager: services.workflow.scheduleManager,
    hookDispatcher: services.hookDispatcher,
    providerRegistry: services.providerRegistry,
    sessionOrchestration: services.sessionOrchestration,
    // The surface every save of this session goes through, so the exit save lands where the turn saves do.
    persistenceOptions: { surface: services.surface },
  });

  const ctx: BootstrapContext = {
    runtimeBus,
    store,
    services,
    featureFlags: services.featureFlags,
    conversation,
    permissions: permissionManager,
    toolRegistry,
    providerRegistry,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    hookDispatcher,
    fileCache,
    projectIndex,
    sessionId: userSessionId,
    isResumed: false, // Sessions start fresh; /resume (or Sessions, resume) loads a previous one
    runtime,
    orchestrator,
    compositor,
    selection,
    commandContext,
    uiServices,
    views: shell.views,
    inputHistory,
    gitStatusProvider,
    lastGitInfoRef,
    bootstrapUnsubs,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    trustPromptRef,
    loadLastConversation: () => loadLastConversation({ surface: services.surface }),
    _writeLastSessionPointer: writeSessionPointer,
    _sessionSpine: sessionSpine,
    _getPinned: () => services.favoritesStore.getPinned(),
    _getConfiguredProviderIds: () => services.providerRegistry.getConfiguredProviderIds(),
    commandRegistry,
    systemMessageRouter,
    shutdown,
    sessionSaved: shutdown.sessionSaved,
    daemonReady: externalServicesStarted,
    daemonMissing: () => missingDaemonLine,
  };

  // ── Phase 12b: Operator Control Plane wiring (capability-gated); store and
  // task manager exist unconditionally so pre-gate tasks stay visible. ───────
  if (opsControlPlane) {
    ctx.commandContext.openOpsView = () => {
      ctx.commandContext.openView?.('ops-control');
    };
  }

  // Wire exit from options if provided; otherwise main.ts binds the shell bridge.
  if (options?.exit) {
    ctx.commandContext.exit = options.exit;
  }

  return ctx;
}
