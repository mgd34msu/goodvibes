import { createPendingHostServices } from '@goodvibes-jev/engine/terminal-shell/host-service-status';
import { joinPromptParts } from '@goodvibes-jev/engine/terminal-shell/prompt-parts';
import {
  createPluginCommandAdapter,
  wireTerminalMcpReload,
  announceTerminalSessionStarted,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-lifecycle';
import { createTerminalOrchestrator, terminalCompanionInputHandler } from '@goodvibes-jev/engine/terminal-shell/bootstrap-orchestrator';
import { buildPluginStartupContext } from '@goodvibes-jev/engine/terminal-shell/plugin-startup';
import { createPluginStartupTask } from '@goodvibes-jev/engine/terminal-shell/plugin-startup';
import { ownerInputFor } from './owner-input.ts';
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
import { readConnectedDaemonOrigin, resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import '@goodvibes-jev/engine/platform/platform/core';
import { AcpManager } from '@goodvibes-jev/engine/platform/platform/acp';
import { readTierPromptSupplement } from '@goodvibes-jev/engine/platform/platform/providers';
import { factsFor } from '@goodvibes-jev/engine/platform/platform/routing';
import { CONTROL_PLANE_FEATURE_FLAG, resumeContracts } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { WorkspaceTrustLevel } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { GitStatusProvider, GitHeaderInfo } from '../renderer/git-status.ts';
import type { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import {
  createTaskManager,
  OpsControlPlane,
  AcpTaskAdapter,
  loadLastConversation,
  leaveHostedSessionOnExit,
  scheduleBackgroundMcpDiscovery,
  restoreSavedModel,
  startExternalServices,
  type ExternalServicesHandle,
  createDeferredStartupCoordinator,
} from '@/runtime/index.ts';
import { bindWriteLastSessionPointerToSurface } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { deriveSpineFooterStatus, type SessionSpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';
import { transportRetryHooks } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import { bindControlCommands } from './control-surfaces.ts';
import { createSpineAdoptionSync } from './client/spine-adoption.ts';
import { pruneStaleOperatorTokens } from '@goodvibes-jev/engine/platform/platform/pairing';
import { resolveDaemonCompanionToken, workspaceOperatorTokenCandidates } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { UiRuntimeServices } from './ui-services.ts';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { createBootstrapShutdown } from './bootstrap-shutdown.ts';
import { ensureBootModelResolvable } from './provider-fallback.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import type { ShellViews } from '../views/builtin-views.ts';
import { announceResumeState } from './resume-notice.ts';
import { announceInstallHealth } from './install-self-check-startup.ts';
import { buildSharedOrchestratorCoreServices, refreshMemoryRecallSnapshot } from './orchestrator-core-services.ts';
import './daemon-attach-notices.ts';
import { wireContextAccountingSource } from './context-accounting-source.ts';
import {
  autostartInstalledDaemon,
  createDaemonServiceControl,
  describeDaemonAutostart,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { createDaemonAttachHandshake } from './client/daemon-attach-handshake.ts';
import { createPendingServiceStatus, hostServiceIsActive, hostServiceIsBlocked } from './client/host-service-status.ts';
import { createRelayReadAccessors } from './relay-reachability-bridge.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';
import { registerStartupProviders } from './startup-provider-registration.ts';
import { createSerialSteps } from './serial-steps.ts';
import { startTerminalRoutines } from './terminal-routines.ts';

type ExternalServiceFactories = NonNullable<Parameters<typeof startExternalServices>[3]>;

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
  /** Ref holding the periodic agent-status interval (use ref, not local var, to keep shutdown in sync). */
  agentStatusIntervalRef: { value: ReturnType<typeof setInterval> | null };
  /** Mutable refs for viewport/scroll/render functions; main.ts patches these after constructing UI state. */
  orchestratorRefs: { getViewportHeight: () => number; scrollToEnd: (vHeight: number) => void; requestRender: () => void };
  /** Patch the bootstrap-owned render bridge after main.ts constructs the real render loop. */
  setRenderRequest: (fn: () => void) => void;
  /** Shell-owned permission prompt bridge that main.ts patches after UI setup. */
  permissionPromptRef: { requestPermission: PermissionRequestHandler };
  /** Shell-owned trust-decision bridge that main.ts patches after UI setup (trust asks at consequence time). */
  trustPromptRef: { requestTrustDecision: () => Promise<WorkspaceTrustLevel> };
  /** True once exit has durably saved the session, even while releases still run. */
  sessionSaved?: () => boolean;
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
   * conversation.addSystemMessage() directly so routing-target config
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
  // Recent control-plane events live in the daemon and are served by its
  // operator verb; this process holds no copy to list.
  const noLocalControlPlaneEvents = (_limit: number): readonly import('@goodvibes-jev/engine/platform/platform/control-plane').ControlPlaneRecentEvent[] => [];
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
    agentStatusIntervalRef,
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
  } = await initializeBootstrapCore(stdout, options, noLocalControlPlaneEvents);
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
        contractRunner: services.contractRunner,
        contractIntake: services.contractIntake,
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
  orchestratorHandleUserInputRef.value = (text, inputOptions) => {
    const route = ownerInputFor(orchestrator);
    if (route) route(text, inputOptions);
    else localCompanionInput(text, inputOptions);
  };
  // Shared payload (single source of truth, includes the memoryRegistry,
  // see orchestrator-core-services.ts) plus this site's cacheHitTracker.
  orchestrator.setCoreServices({
    ...buildSharedOrchestratorCoreServices({ services, configManager, providerRegistry }),
    cacheHitTracker: services.cacheHitTracker,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  // Bind context_accounting's session source to the live Orchestrator (see context-accounting-source.ts).
  wireContextAccountingSource(
    {
      orchestrator,
      providerRegistry,
      sessionLineageTracker: services.sessionLineageTracker,
      runtimeBus,
      sessionId: runtime.sessionId,
      currentSessionId: () => runtime.sessionId,
    },
    services.contextAccountingHolder,
    bootstrapUnsubs,
  );

  const acpLifetime = new AbortController();
  bootstrapUnsubs.push(() => acpLifetime.abort());
  const acpManager = new AcpManager({
    permissionHost: { port: services.judgment.port, permissionManager, config: configManager, signal: acpLifetime.signal },
    runtimeBus,
    hookDispatcher: services.hookDispatcher,
  });
  // The subagents' own spawn/complete/fail/cancel events keep their task rows current.
  const acpTaskAdapter = new AcpTaskAdapter(store);
  bootstrapUnsubs.push(acpTaskAdapter.attachRuntimeBus(runtimeBus));
  orchestrator.registerDelegateTool(acpManager);
  // An ACP task row's owner is its subagent id; the ACP manager can stop it and nothing else.
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId, services.featureFlags,
    (task) => task.kind === 'acp' ? { cancel: () => acpManager.cancel(task.owner) } : undefined);
  // Operator interventions ride the control-plane gateway capability
  // (controlPlane.gateway, on by default; the old never-registered gate id shipped this dead).
  const opsControlPlane = services.featureFlags.isEnabled(CONTROL_PLANE_FEATURE_FLAG)
    ? new OpsControlPlane(opsTaskManager, runtimeBus, store, userSessionId, services.agentManager)
    : undefined;

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
    getControlPlaneRecentEvents: noLocalControlPlaneEvents,
    toolRegistry,
    forensicsRegistry,
    policyRuntimeState: services.policyRuntimeState,
    uiServices,
    taskManager: opsTaskManager,
    opsControlPlane,
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
  // Recovery can await a planner or executor. Let the shell render while it
  // runs, and stop/drain recovery before shutdown releases its dependencies.
  const contractRecovery = resumeContracts(services.contractRunner, services.workingDirectory);
  bootstrapUnsubs.unshift(async () => {
    services.contractRunner.dispose();
    await contractRecovery;
    await services.contractRunner.flushWorkPlan?.();
  });
  const commandRegistry = shell.commandRegistry;
  bindControlCommands(services, commandRegistry);
  const commandContext = shell.commandContext;
  // Recovery loads persisted history before continuing its work. Announce
  // that history without waiting for the resumed work to finish.
  void announceResumeState({
    surface: services.surface,
    sessionManager: services.sessionManager,
    checkpointManager: services.workspaceCheckpointManager,
    contractHistory: services.contractRunner.list({ includeTerminal: true, includeInputSnapshot: false }),
    memoryAvailable: Boolean(commandContext.clients?.knowledgeApi?.memory),
    router: systemMessageRouter,
  }).catch(() => {
    // Best-effort, never let the resume notice block or crash boot.
  });
  announceInstallHealth(systemMessageRouter);
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
    legacyStorePath: services.shellPaths.resolveProjectPath('tui', 'control-plane', 'sessions.json'),
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
    };
  };

  // ADOPT ONLY. This app never constructs a DaemonServer or an HttpListener: the
  // daemon is a separate product with its own binary and its own service unit,
  // and the platform's host services only adopt one. The factories carry the
  // shared bearer so an adopted daemon is authenticated the same way it always was.
  const createExternalServiceFactories = (token: string): ExternalServiceFactories => ({
    sharedDaemonToken: token,
    // Read at every start, so a restart after "connect to an existing daemon" looks there.
    daemonTarget: readConnectedDaemonOrigin((key) => configManager.get(key)),
  });

  // Replacing the external-services handle is one step at a time and always
  // releases the handle it replaces: an adopted handle still owns probes and
  // listeners, and two swaps interleaving would leave one of them orphaned.
  const swapExternalServices = createSerialSteps();

  // The one bounded recovery step: a daemon that is INSTALLED on this machine
  // and simply stopped gets started once and waited for, rather than becoming
  // the user's homework. Every boundary is in the platform's client/daemon-autostart.ts.
  const maybeStartInstalledDaemon = async (): Promise<void> => {
    // Pointed at a daemon elsewhere: starting this machine's daemon would not reach it.
    if (readConnectedDaemonOrigin((key) => configManager.get(key))) return;
    try {
      const outcome = await autostartInstalledDaemon({
        daemonMode: externalServices.daemonStatus.mode,
        control: createDaemonServiceControl({
          configManager,
          workingDirectory: services.workingDirectory,
          homeDirectory: services.homeDirectory,
        }),
        isReachable: async () => (await sessionSpine.probeReachability()) === 'online',
      });
      if (outcome.action === 'started' || outcome.action === 'came-online') {
        const companionTokenRecord = resolveDaemonCompanionToken(
          resolveGoodVibesDaemonHome(services.homeDirectory),
          GOODVIBES_TUI_SURFACE_ROOT,
        );
        await swapExternalServices(async () => {
          try {
            await externalServices.stop();
          } catch (error) {
            logger.debug('Releasing the previous external services failed', { error: summarizeError(error) });
          }
          externalServicesPromise = startExternalServices(
            configManager,
            hookDispatcher,
            services,
            createExternalServiceFactories(companionTokenRecord.token),
          );
          externalServices = await externalServicesPromise;
        });
        await daemonHandshake.attach(companionTokenRecord.token);
      }
      const notice = describeDaemonAutostart(
        outcome,
        externalServices.daemonStatus.mode === 'external',
        externalServices.daemonStatus.reason ?? externalServices.daemonStatus.mode,
      );
      if (notice) systemMessageRouter[notice.level](notice.text);
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
      const daemonHomeDir = resolveGoodVibesDaemonHome(services.homeDirectory);
      const companionTokenRecord = resolveDaemonCompanionToken(daemonHomeDir, GOODVIBES_TUI_SURFACE_ROOT);
      externalServicesPromise = startExternalServices(
        configManager,
        hookDispatcher,
        services,
        createExternalServiceFactories(companionTokenRecord.token),
      );
      externalServices = await externalServicesPromise;
      await daemonHandshake.attach(companionTokenRecord.token);
      requestRender();
      return inspectExternalServices();
    }),
  };
  // Attaching to a daemon settles both build floors and its undelivered
  // receipts off one /status read, see client/daemon-attach-handshake.ts.
  const daemonHandshake = createDaemonAttachHandshake({
    clientBuildGuard: services.clientBuildGuard,
    readDaemonStatus: () => externalServices.daemonStatus,
    recordRefusal: (status) => {
      externalServices = { ...externalServices, daemonStatus: status };
    },
    adopt: (status, daemonToken) => syncSessionSpineToHostStatus(status, daemonToken),
    notify: (text) => {
      systemMessageRouter.high(`[Daemon] ${text}`);
      requestRender();
    },
  });
  // A liveness flip is only PAINTED once something calls requestRender(); without
  // this, the footer's spine segment sat correct-but-undrawn until incidental activity redrew it (minutes, during an idle stretch).
  // The same flip is what tells the handshake a daemon came back.
  sessionUnionCache.setOnTransition((online) => {
    requestRender();
    daemonHandshake.onLivenessTransition(online);
  });
  deferredStartup.schedule(
    createPluginStartupTask(
      pluginManager,
      () => buildPluginStartupContext({ runtimeBus, commandRegistry: pluginCommandRegistry, providerRegistry, toolRegistry }, services),
      requestRender,
      (message) => systemMessageRouter.high(message),
    ),
  );
  deferredStartup.schedule({
    label: 'external-services',
    run: async () => {
      // Register the persistent companion-pairing token as the daemon's shared
      // bearer, so tokens scanned from the /qrcode modal's QR actually
      // authenticate against the daemon this surface adopts.
      const daemonHomeDir = resolveGoodVibesDaemonHome(services.homeDirectory);
      const companionTokenRecord = resolveDaemonCompanionToken(daemonHomeDir, GOODVIBES_TUI_SURFACE_ROOT);
      // Fix (TUI 0.19.20): remove stale pre-0.21.28 workspace-scoped operator
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
      externalServicesPromise = startExternalServices(
        configManager,
        hookDispatcher,
        services,
        createExternalServiceFactories(companionTokenRecord.token),
      );
      externalServices = await externalServicesPromise;
      // Installed-but-stopped recovery, before anything reads the status.
      await maybeStartInstalledDaemon();
      await daemonHandshake.attach(companionTokenRecord.token);
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
  };

  // ── Phase 8: Restore known providers; /scan owns network discovery ──────

  registerStartupProviders({
    configManager,
    providerRegistry,
    runtime,
    requestRender,
    restoreRuntimeModel: restoreSavedModel,
    systemMessageRouter,
    shellPaths: services.shellPaths,
    surfaceRoot: 'tui',
  });
  const mcpDiscovery = scheduleBackgroundMcpDiscovery({
    mcpRegistry: services.mcpRegistry,
    systemMessageRouter,
    requestRender,
    shellPaths: services.shellPaths,
    surfaceRoot: 'tui',
  });
  wireTerminalMcpReload(services.shellPaths, services.mcpRegistry, mcpDiscovery, bootstrapUnsubs, systemMessageRouter, requestRender);
  // Routines belong to the daemon, so each runs once with or without a terminal
  // open: this moves any this terminal kept to it. With the daemon off, the one
  // terminal holding the routine lock runs them (runtime/terminal-routines.ts).
  if (configManager.get('automation.enabled')) {
    deferredStartup.schedule({
      label: 'automation',
      run: async () => {
        const lines = await startTerminalRoutines({ configManager, automationManager: services.automationManager, homeDirectory: services.homeDirectory });
        if (lines.length > 0) {
          systemMessageRouter.low(lines.join('\n'));
          requestRender();
        }
      },
      onError: (error) => {
        const message = summarizeError(error);
        logger.error('Deferred automation startup failed', { error: message });
        systemMessageRouter.high(`[Startup] Scheduled routines could not be started: ${message}. /schedule list shows where they are kept.`, 'error');
        requestRender();
      },
    });
  }

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
    agentStatusIntervalRef,
    scheduleManager: services.workflow.scheduleManager,
    hookDispatcher: services.hookDispatcher,
    providerRegistry: services.providerRegistry,
    sessionOrchestration: services.sessionOrchestration,
    persistenceOptions: {
      workingDirectory: services.workingDirectory,
      homeDirectory: services.homeDirectory,
      sessionManager: services.sessionManager,
    },
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
    componentHealthMonitor: services.componentHealthMonitor,
    worktreeRegistry: services.worktreeRegistry,
    sandboxSessionRegistry: services.sandboxSessionRegistry,
    hookDispatcher,
    fileCache,
    projectIndex,
    sessionId: userSessionId,
    isResumed: false, // Sessions start fresh; use /session resume to load a previous one
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
    agentStatusIntervalRef,
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
  };

  // ── Phase 12b: Operator Control Plane wiring (capability-gated); store and
  // task manager exist unconditionally so pre-gate tasks stay visible. ───────
  ctx.commandContext.ops.acpManager = acpManager;
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
