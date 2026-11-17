import {
  createPluginCommandAdapter,
  wireTerminalMcpReload,
  announceTerminalSessionStarted,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-lifecycle';
import {
  createTerminalOrchestrator,
  terminalCompanionInputHandler,
  projectOrchestratorCoreServices,
} from '@goodvibes-jev/engine/terminal-shell/bootstrap-orchestrator';
import { buildPluginStartupContext } from '@goodvibes-jev/engine/terminal-shell/plugin-startup';
import { ownerInputFor } from './owner-input.ts';
import { createPluginStartupTask } from '@goodvibes-jev/engine/terminal-shell/plugin-startup';
import { readTierPromptSupplement } from '@goodvibes-jev/engine/platform/platform/providers';
import { factsFor } from '@goodvibes-jev/engine/platform/platform/routing';
/**
 * Bootstrap composition root for GoodVibes Agent.
 *
 * Initializes all runtime subsystems in dependency order and returns a
 * RuntimeContext that main.ts uses to drive the render loop and terminal I/O.
 *
 * Separation of concerns:
 *   - bootstrap.ts: initialization, event wiring, manager setup
 *   - main.ts: terminal setup, render loop, stdin/stdout handlers
 *   - lifecycle.ts: save/shutdown helpers
 */
import '@goodvibes-jev/engine/platform/platform/core';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { collectStartupAnnouncements } from '@goodvibes-jev/engine/platform/platform/runtime/feature-announcements';
import type { PermissionRequestHandler } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { CommandContext } from '../input/command-registry.ts';
import type { InputHistory } from '../input/input-history.ts';
import type { SelectionManager } from '@goodvibes-jev/engine/terminal-shell';
import type { Compositor } from '../renderer/compositor.ts';

import type { RuntimeContext, BootstrapOptions } from './context.ts';
import '@/runtime/index.ts';
import { createTaskManager, emitSessionResumed } from '@/runtime/index.ts';
import { ProcessTaskAdapter } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { emitSessionRecoveryFailed } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import type { SystemMessageRouter } from '../core/system-message-router.ts';
import '@/runtime/index.ts';
import { loadLastConversation } from '@/runtime/index.ts';
import { bindWriteLastSessionPointerToSurface } from '@/runtime/index.ts';
import { scheduleMcpSuggestionScan } from './mcp-suggestion-scan.ts';
import { restoreSavedModel } from '@/runtime/index.ts';
import { runGatedLanScan } from './lan-scan-consent.ts';
import { scheduleCalendarSubscriptionBootRefresh } from './calendar-boot-refresh.ts';
import type { TurnEvent } from '@/runtime/index.ts';
import type { UiRuntimeServices } from './ui-services.ts';
import { createDeferredStartupCoordinator } from '@/runtime/index.ts';
import { wireAgentExternalServices } from './bootstrap-external-services.ts';
import { initializeBootstrapCore } from './bootstrap-core.ts';
import { ensureBootModelResolvable } from './provider-boot.ts';
import { bindOrchestratorContextAccounting } from './context-accounting-source.ts';
import { createBootstrapShell } from './bootstrap-shell.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import '@goodvibes-jev/engine/terminal-shell';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../config/surface.ts';
import { registerAgentTools } from './bootstrap-agent-tools.ts';
import { foldLegacySpineStore } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';
import { reconcileMemorySpineAdoption } from './memory-spine-adoption.ts';
import { createAgentSessionInputsClient } from './client/session-inputs.ts';
import { AgentPromptContextReceiptStore, composeRuntimePromptWithReceipt } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { recordCompletedTurnAnchor } from './rewind-anchor-wiring.ts';
import { createMemoryUsageTracker } from './memory-usage-wiring.ts';
import { installOccasionsNudging } from './occasions-boot.ts';
import { watchOccasionAnnouncements } from './client/occasion-announcements.ts';
import { createRuntimeShutdown } from './bootstrap-shutdown.ts';
import { recordComposedPromptUsage } from './prompt-usage-record.ts';
import { createMemorySpineRecheck, resolveMemorySpineRecheckMs } from './memory-spine-recheck.ts';
import { capabilitySnapshot, refreshCapabilityIndex } from '../capabilities/capability-snapshot.ts';
import { GOODVIBES_AGENT_OPERATOR_POLICY } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { flushPendingChannelRows } from '../agent/channel-outbox-flush.ts';
import { createDaemonOperatorInvoke, resolveDaemonOperatorConnection } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

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
  /** Persists and navigates input history across sessions. */
  inputHistory: InputHistory;
  /** Unsubscribe functions owned by bootstrap (cleared on shutdown). */
  bootstrapUnsubs: Array<() => void | Promise<void>>;
  /** Mutable refs for viewport/scroll/render functions; main.ts patches these after constructing UI state. */
  orchestratorRefs: { getViewportHeight: () => number; scrollToEnd: (vHeight: number) => void; requestRender: () => void };
  /** Patch the bootstrap-owned render route after main.ts constructs the real render loop. */
  setRenderRequest: (fn: () => void) => void;
  /** Shell-owned permission prompt route that main.ts patches after UI setup. */
  permissionPromptRef: { requestPermission: PermissionRequestHandler };
  /** Load the most recently saved conversation from disk. */
  loadLastConversation: () => { messages: Array<Record<string, unknown>> } | null;
  /** Write the last-session pointer file (used after session resume). */
  _writeLastSessionPointer: (sessionId: string) => void;
  /** Retrieve pinned model IDs for the model picker. */
  _getPinned: () => Promise<string[]>;
  /** Retrieve configured provider IDs for the model picker. */
  _getConfiguredProviderIds: () => string[];
  /** Command registry used by InputHandler. main.ts needs this to wire input. */
  commandRegistry: import('../input/command-registry.ts').CommandRegistry;
  /**
   * System message router instantiated at startup, wired to the conversation and the activity feed.
   *
   * @remarks
   * Route operational messages through this rather than calling
   * conversation.addNotice() directly so that low-priority messages
   * stay out of the main conversation and go to the activity feed instead.
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
 *   4. Runtime bus subscriptions (delegation, subagent, hook route)
 *   5. Providers, webhooks, PermissionManager, HookDispatcher
 *   6. Orchestrator and Agent-local task read models
 *   7. MCP auto-connect + workspace
 *   8. Command registry + plugin init + CommandContext
 *   9. Input handler wiring
 *  10. Input history, splash options
 *  11. Background: provider auto-registration, persisted providers, scan
 */
export async function bootstrapRuntime(stdout: NodeJS.WriteStream, options: BootstrapOptions): Promise<BootstrapContext> {
  const workingDir = options.workingDir;
  const configManager = options.configManager;
  const controlPlaneRecentEventsRef: {
    value: (limit: number) => readonly import('@goodvibes-jev/engine/platform/platform/control-plane').ControlPlaneRecentEvent[];
  } = {
    value: (_limit) => [],
  };
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
    systemMessageRouterRef,
    startupNotices,
    conversationFollowUpRef,
    orchestratorHandleUserInputRef,
    requestRender,
    setRenderRequest,
    runtimeSessionIdRef,
  } = await initializeBootstrapCore(stdout, options, (limit) => controlPlaneRecentEventsRef.value(limit));
  options.onHookDispatcherReady?.({ runtime, surface: services.surface, hookDispatcher: services.hookDispatcher });
  const providerRegistry = services.providerRegistry;
  // A saved custom-provider model must never crash boot, see provider-boot.ts.
  const bootModelSubstitution = await ensureBootModelResolvable(providerRegistry, options.configManager);
  if (bootModelSubstitution) {
    startupNotices.report(
      `[Startup] Configured model '${bootModelSubstitution.configured}' is unavailable; using '${bootModelSubstitution.replacement}' this session. Your saved model is unchanged.`,
    );
  }
  const promptContextReceipts = new AgentPromptContextReceiptStore(
    services.shellPaths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'prompt-context-receipts.jsonl'),
  );
  let activePromptTurnId: string | null = null;
  // The current turn's raw text: the injection seam
  // (composeRuntimePromptWithReceipt, invoked from getSystemPrompt below) needs the
  // active turn's intent to rank the already-eligible memory set by relevance. This is
  // the real seam that was left unthreaded, TURN_SUBMITTED already carries `prompt`, it
  // was just never captured. Mirrors activePromptTurnId's lifecycle exactly: set on
  // TURN_SUBMITTED, cleared on every terminal event for that turn.
  let activePromptTurnText: string | null = null;
  // Idle-time memory consolidation now runs on services.memoryConsolidationScheduler
  // (the platform's own daemon-side MemoryConsolidationScheduler, constructed in
  // runtime/services.ts the way the platform's own RuntimeServices composition
  // constructs it: a standing 5-minute tick, not turn-settled events). This
  // repo's old turn-settled-driven local wiring is retired.
  // Usage-outcome instrumentation: the memories injected into a turn and, at its
  // end, one Jev reading of which the response used, written as one counter
  // update on the memory records. Consolidation's decay reads those counters
  // from the store, so every product sharing the store orders decay the same way.
  const memoryUsageTracker = createMemoryUsageTracker(services.memoryRegistry);
  // Occasion reminders reach this conversation by the pull: at the end of each
  // turn, when the host announces one while no turn runs, and once per sweep
  // interval while idle (runtime/occasions-boot.ts).
  const occasionsNudgeSurface = installOccasionsNudging({
    gatewayMethods: services.gatewayMethods,
    configManager,
    homeDirectory: services.shellPaths.homeDirectory,
    conversation,
    requestRender,
    disposals: bootstrapUnsubs,
    isIdle: () => activePromptTurnId === null,
    watchAnnouncements: async (handlers) => {
      const host = services.resolveConnectedHost();
      return 'reason' in host ? null : await watchOccasionAnnouncements({ baseUrl: host.baseUrl, token: host.token, ...handlers });
    },
  });
  runtimeUnsubs.push(
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_SUBMITTED' }>>('TURN_SUBMITTED', (event) => {
      activePromptTurnId = event.payload.turnId;
      activePromptTurnText = event.payload.prompt;
      occasionsNudgeSurface.noteTurnSubmitted();
    }),
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', (event) => {
      promptContextReceipts.recordTurnOutcome({
        turnId: event.payload.turnId,
        status: 'completed',
        terminalEvent: 'TURN_COMPLETED',
        stopReason: event.payload.stopReason,
      });
      // The join key between conversation and files rewind (rewind-anchor-wiring.ts).
      recordCompletedTurnAnchor({
        sessionId: runtimeSessionIdRef.value,
        turnId: event.payload.turnId,
        conversation,
        surface: services.surface,
      });
      if (activePromptTurnId === event.payload.turnId) {
        activePromptTurnId = null;
        activePromptTurnText = null;
      }
      void memoryUsageTracker.onTurnCompleted(event.payload.turnId, event.payload.response).catch((error) => {
        logger.debug('Memory usage reference reading failed', { error: summarizeError(error) });
      });
      // Raise anything outstanding, now that the transcript is quiet. Appending
      // the agent's own line while a response was still streaming would
      // interleave two voices in one transcript, which is why this rides the
      // turn's completion rather than its submission, and why a pull overtaken by
      // the owner's next message says nothing until that turn ends. Not awaited and it never
      // throws, a nudge that could not be pulled must not disturb the turn it
      // rode in on.
      void occasionsNudgeSurface.raiseNow();
    }),
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_ERROR' }>>('TURN_ERROR', (event) => {
      promptContextReceipts.recordTurnOutcome({
        turnId: event.payload.turnId,
        status: 'error',
        terminalEvent: 'TURN_ERROR',
        stopReason: event.payload.stopReason,
        detail: event.payload.error,
      });
      if (activePromptTurnId === event.payload.turnId) {
        activePromptTurnId = null;
        activePromptTurnText = null;
      }
      memoryUsageTracker.onTurnAborted(event.payload.turnId);
    }),
    runtimeBus.on<Extract<TurnEvent, { type: 'TURN_CANCEL' }>>('TURN_CANCEL', (event) => {
      promptContextReceipts.recordTurnOutcome({
        turnId: event.payload.turnId,
        status: 'cancelled',
        terminalEvent: 'TURN_CANCEL',
        stopReason: event.payload.stopReason,
        detail: event.payload.reason,
      });
      if (activePromptTurnId === event.payload.turnId) {
        activePromptTurnId = null;
        activePromptTurnText = null;
      }
      memoryUsageTracker.onTurnAborted(event.payload.turnId);
    }),
  );
  const { automationManager, hookDispatcher, pluginManager } = services;

  // ── Phase 6: Orchestrator and Agent-local task read models ───────────────

  // Mutable function refs so main.ts can patch these after constructing the scroll/viewport state.
  // The orchestrator closes over these refs, so patching them in main.ts takes immediate effect.

  const systemPromptBySignal = new WeakMap<AbortSignal, Promise<string>>();
  const { orchestrator, orchestratorRefs } = createTerminalOrchestrator(
    {
      conversation,
      toolRegistry,
      permissionManager,
      getSystemPrompt: (signal) => {
        const existing = signal ? systemPromptBySignal.get(signal) : undefined;
        if (existing) return existing;
        const currentModel = providerRegistry.getCurrentModel();
        const turnId = activePromptTurnId;
        const captured = {
          sessionId: runtime.sessionId,
          turnId,
          source: turnId ? ('turn' as const) : ('follow_up' as const),
          provider: runtime.provider,
          model: currentModel,
          contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel),
          runtimePrompt: runtime.systemPrompt,
          operatorPolicy: GOODVIBES_AGENT_OPERATOR_POLICY,
          shellPaths: services.shellPaths,
          memoryRegistry: services.memoryRegistry,
          turnText: activePromptTurnText,
          // Resolved once per turn (in-memory lookups and a handful of stats), so a credential
          // connected or removed mid-session is what this turn's prompt says.
          capabilityIndex: refreshCapabilityIndex() ?? capabilitySnapshot(),
        };
        const composedPrompt = (async () => {
          signal?.throwIfAborted();
          // The turn's prompt carries memory as it is now: a memory saved during
          // the last turn is in this one. The refresh runs beside the tier
          // reading, bounded by its own deadline and the turn's signal; when it
          // fails the last snapshot is used, with its own staleness note.
          const [tierPrompt, memoryRecallSnapshot] = await Promise.all([
            readTierPromptSupplement(
              factsFor({ catalog: providerRegistry }, currentModel),
              providerRegistry.modelTiers,
              'agent.conversation-system-prompt',
              { audience: 'conversation', signal },
            ),
            services.memorySpineClient.refreshRecallSnapshot(undefined, { recall: false, signal }).catch((error: unknown) => {
              logger.debug('Per-turn memory recall snapshot refresh failed', { error: summarizeError(error) });
              return services.memorySpineClient.recallSnapshot();
            }),
          ]);
          signal?.throwIfAborted();
          const composed = await composeRuntimePromptWithReceipt({ ...captured, memoryRecallSnapshot, tierPrompt });
          signal?.throwIfAborted();
          promptContextReceipts.record(composed.receipt);
          recordComposedPromptUsage(() => memoryUsageTracker.onComposed(turnId, composed.receipt));
          return composed.prompt;
        })();
        if (signal) systemPromptBySignal.set(signal, composedPrompt);
        return composedPrompt;
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
  // Bind this repo's live interactive Orchestrator into the platform's live-turn
  // controls holder (platform round: sessions.toolCalls.cancel, sessions.
  // queuedMessages.list/edit/delete). The Orchestrator's public cancelToolCall/
  // listQueuedMessages/editQueuedMessage/deleteQueuedMessage methods already
  // structurally satisfy SessionLiveTurnControls, no adapter needed. Until this
  // bind call the gateway verbs refuse honestly (LIVE_TURN_CONTROLS_UNAVAILABLE).
  services.sessionLiveTurnControls.bind(orchestrator);
  // A companion message is the owner speaking from another device: once the shell
  // has bound the owner-input route it takes the composer's path (intake, routing,
  // turn-finished signal); before that (boot, headless) it runs a local turn.
  const localCompanionInput = terminalCompanionInputHandler(orchestrator, (err) => {
    logger.debug('companion handleUserInput safety catch', { error: String(err) });
  });
  orchestratorHandleUserInputRef.value = (text, inputOptions) => {
    const route = ownerInputFor(orchestrator);
    if (route) route(text, inputOptions);
    else localCompanionInput(text, inputOptions);
  };
  orchestrator.setCoreServices({
    ...projectOrchestratorCoreServices({ configManager, providerRegistry, services }),
    cacheHitTracker: services.cacheHitTracker,
  });
  conversation.setSessionLineageTracker(services.sessionLineageTracker);

  // Bind the context_accounting tool (platform 1.6.1) to THIS Orchestrator so it
  // reports real session data instead of the unbound-holder honesty message.
  // Must run after setCoreServices (nothing here depends on it, but this
  // keeps every orchestrator.* wiring call grouped) and before the first
  // turn, see context-accounting-source.ts for what each facet reads.
  runtimeUnsubs.push(
    bindOrchestratorContextAccounting({
      orchestrator,
      holder: services.contextAccountingHolder,
      runtimeBus,
      runtimeStore: store,
      getSessionId: () => runtime.sessionId,
      getContextWindow: () => providerRegistry.getKnownContextWindowForModel(providerRegistry.getCurrentModel()),
    }),
  );

  // featureFlags is REQUIRED here in practice, even though the platform types it
  // optional. isFeatureGateEnabled(null, ...) is permissive by design, so
  // omitting it did not disable task tracking when runtime.unifiedTasks was
  // turned off, it made the setting configure nothing: createTask/etc. kept
  // working either way. The platform has corrected this key's recorded default to
  // match the behaviour every install has always shipped (true/enabled), so
  // threading the flag manager here changes nothing for an existing install
  // and only makes turning the setting off now actually turn it off.
  // Background processes are tasks from start to exit, and a task cancel stops the process.
  const processTaskAdapter = new ProcessTaskAdapter(store, services.processManager);
  runtimeUnsubs.push(processTaskAdapter.attach({ sessionId: userSessionId }));
  const opsTaskManager = createTaskManager(store, runtimeBus, userSessionId, services.featureFlags,
    (task) => task.kind === 'exec' ? processTaskAdapter.controllerFor(task.id) : undefined);

  // Surface-bound closure, not the raw multi-arg platform function, see
  // the platform's bindWriteLastSessionPointerToSurface for why that matters.
  const writeLastSessionPointerForSurface = bindWriteLastSessionPointerToSurface(services.surface);

  const shell = createBootstrapShell({
    configManager,
    runtimeBus,
    runtimeStore: store,
    services,
    conversation,
    runtime,
    orchestrator,
    requestRender,
    permissionPromptRef,
    writeLastSessionPointer: writeLastSessionPointerForSurface,
    announceSessionResumed: (resumedSessionId, turnCount) => {
      emitSessionResumed(
        runtimeBus,
        { sessionId: resumedSessionId, traceId: `${resumedSessionId}:session-resume`, source: 'bootstrap' },
        { sessionId: resumedSessionId, turnCount },
      );
    },
    announceSessionRecoveryFailed: (failedSessionId, reason) => {
      emitSessionRecoveryFailed(
        runtimeBus,
        { sessionId: runtime.sessionId, traceId: `${runtime.sessionId}:session-resume:${failedSessionId}`, source: 'bootstrap' },
        { sessionId: failedSessionId, error: reason },
      );
    },
    getControlPlaneRecentEvents: (limit) => controlPlaneRecentEventsRef.value(limit),
    toolRegistry,
    promptContextReceipts,
    forensicsRegistry,
    policyRuntimeState: services.policyRuntimeState,
    uiServices,
    taskManager: opsTaskManager,
    completeModelSelectionSideEffect: () => {
      compositor.resetDiff();
    },
  });
  const systemMessageRouter = shell.systemMessageRouter;
  systemMessageRouterRef.value = systemMessageRouter;
  startupNotices.flush();
  // Announce-once receipts due at boot (e.g. the web surface URL when
  // web.enabled). The store is shared per install, so whichever process of
  // this install boots first (daemon, TUI, or this Agent) announces; every
  // other process stays silent. Mirrors the platform daemon boot's collection.
  for (const announcement of collectStartupAnnouncements({
    configManager,
    store: services.featureAnnouncementStore,
  })) {
    logger.info(announcement.text, { announcement: announcement.id });
    systemMessageRouter.low(`[Startup] ${announcement.text}`);
  }
  // Retention for worktrees earlier runs left (the daemon runs the same pass at its start).
  void services.worktreeRegistry.startupSweep().then((notice) => { if (notice) systemMessageRouter.low(`[Worktrees] ${notice}`); });
  const commandRegistry = shell.commandRegistry;
  const commandContext = shell.commandContext;
  const inputHistory = shell.inputHistory;
  registerAgentTools({
    toolRegistry,
    commandRegistry,
    commandContext,
    configManager,
    services,
    getSessionId: () => runtimeSessionIdRef.value,
  });
  const pluginCommandRegistry = createPluginCommandAdapter(commandRegistry);

  // ── Phase 7: Connected-host posture + deferred startup ────────────────

  const deferredStartup = createDeferredStartupCoordinator();

  // GoodVibes Agent does not own the connected daemon's (or HTTP listener's)
  // lifecycle, see bootstrap-external-services.ts for the adopt-only wiring
  // and the deferred discovery probe it schedules. One bounded exception at
  // boot: a host that is INSTALLED on this machine but stopped is started
  // once through the platform service manager, with an honest receipt.
  const agentExternalServices = wireAgentExternalServices({
    configManager,
    runtimeBus,
    hookDispatcher,
    services,
    uiServices,
    deferredStartup,
    systemMessageRouter,
    requestRender,
  });

  deferredStartup.schedule(
    createPluginStartupTask(
      pluginManager,
      () => buildPluginStartupContext({ runtimeBus, commandRegistry: pluginCommandRegistry, providerRegistry, toolRegistry }, services),
      requestRender,
      (message) => systemMessageRouter.high(message),
    ),
  );
  // Probe the daemon spine OFF the interactive path. On a reachable daemon,
  // fold the agent's own per-cwd legacy session store into it (once; marked
  // migrated). Waits for connected-host discovery (which may have just started
  // an installed-but-stopped daemon) so this probe sees the settled state; a
  // down/absent daemon leaves the agent local-only with an honest offline status.
  deferredStartup.schedule({
    label: 'session-spine',
    run: async () => {
      await agentExternalServices.whenDiscovered();
      const reachability = await services.sessionSpineClient.probeReachability();
      if (reachability !== 'online') return;
      foldLegacySpineStore(services.sessionSpineClient, {
        storePath: services.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'sessions.json'),
        markerPath: services.shellPaths.resolveProjectPath(GOODVIBES_AGENT_SURFACE_ROOT, 'control-plane', 'sessions.spine-folded.json'),
        project: workingDir,
        log: logger,
      });
    },
    onError: (error) => {
      logger.debug('Deferred session-spine startup failed', { error: summarizeError(error) });
    },
  });
  // Memory spine (platform 1.1.0): the daemon-owned canonical memory store is
  // single-writer, so the agent must make an explicit adopted/not-adopted decision
  // rather than trying the wire per call. Reuses the SAME reachability signal as the
  // session-spine fold above (services.sessionSpineClient.probeReachability(), one
  // daemon, one connected-host token) instead of inventing a second probe. On a
  // reachable daemon, activate the spine for CLIENT mode, every wire-covered memory
  // op now routes over HTTP and the local store is never written again. Embedded/
  // offline is unaffected: the agent must keep working with no daemon running, and a
  // failed/absent probe simply leaves the client in its constructed LOCAL mode.
  //
  // A daemon can also appear or disappear AFTER boot, so this keeps checking for the
  // whole process lifetime on the same cadence as the runtime heartbeat: adopt late
  // if one shows up, and hand back to local (deactivate) the moment a PREVIOUSLY
  // adopted daemon stops answering, never guess and keep routing to a dead wire.
  // Armed from the deferred task below even when file watchers are off: a daemon
  // can appear or vanish after boot regardless of that setting.
  const memorySpineRecheck = createMemorySpineRecheck({
    intervalMs: () => resolveMemorySpineRecheckMs(configManager.get('watchers.heartbeatIntervalMs')),
    reconcile: () => reconcileMemorySpine(),
  });
  //
  // Inbound continuation dispatch rides the SAME adoption edge. It has to: the
  // wire dispatch polls `sessions.inputs.list` on the adopted daemon, and there
  // is nothing to poll until one is adopted. `onAttach` fires exactly on the
  // transition INTO adoption, so activating there is idempotent per attach and
  // re-activates for free when a daemon comes back after a loss; the detach side
  // deactivates so the poller stops dialing a dead wire while keeping the bound
  // runner for the next attach.
  const sessionInputsClient = createAgentSessionInputsClient(services.daemonVerbs);
  const reconcileMemorySpine = (): Promise<void> =>
    reconcileMemorySpineAdoption({
      memorySpineClient: services.memorySpineClient,
      transport: services.memorySpineTransport,
      probeReachability: () => services.sessionSpineClient.probeReachability(),
      // Reachable is not usable: a daemon below this build's floor is refused here,
      // so nothing activates and the spine keeps its local store. Re-asked per
      // attempt, so a daemon updated mid-session is adopted on the next tick.
      mayAdopt: () => services.mayAdoptDaemonBuild(),
      // One receipt-reading /status read per attach: a current daemon delivers its
      // one-shot honesty receipts ("restarted after a crash at HH:MM", "updated
      // from X to Y") only to a receipt-reading /status read (peek then acknowledge), and this adoption edge is
      // exactly where the agent (re)attaches to a daemon. The plain liveness probe
      // stays receipt-neutral.
      onAttach: () => {
        services.sessionBroker.activate(sessionInputsClient);
        // Channel drafts and routing assignments saved while the daemon was away reach it now.
        void flushPendingChannelRows(services.shellPaths, createDaemonOperatorInvoke(() =>
          resolveDaemonOperatorConnection(configManager, services.shellPaths.homeDirectory)));
        return services.consumeDaemonReceipts();
      },
      onDetach: () => services.sessionBroker.deactivate('the connected host stopped answering'),
    });
  deferredStartup.schedule({
    label: 'memory-spine',
    run: async () => {
      // Wait for connected-host discovery (which may have just started an
      // installed-but-stopped daemon) so the first adoption decision sees the
      // settled daemon state instead of racing it; the heartbeat below keeps
      // reconciling for the rest of the process lifetime either way.
      try {
        await agentExternalServices.whenDiscovered();
        await reconcileMemorySpine();
        // Prime the recall snapshot (platform 1.2.0 sync-recall seam) so the FIRST
        // system prompt built after boot already has a real snapshot to read
        // instead of the honest-but-empty "not yet captured" one, see
        // recallSnapshot's doc comment on prompt-context-receipts.ts's
        // memoryRecallSnapshot field. { recall: false } captures an unfiltered
        // browse set: the receipt's own eligibility/suppression logic (not the
        // snapshot) decides what is prompt-active, so this must mirror the old
        // memoryRegistry.getAll() read exactly, not the recall-floor-filtered set.
        await services.memorySpineClient.refreshRecallSnapshot(undefined, { recall: false }).catch((error: unknown) => {
          logger.debug('Initial memory recall snapshot refresh failed', { error: summarizeError(error) });
        });
      } finally {
        // The recheck keeps the spine honest for the whole process life, so a failed
        // first adoption must not leave it unarmed.
        memorySpineRecheck.arm();
      }
    },
    onError: (error) => {
      logger.debug('Deferred memory-spine startup failed', { error: summarizeError(error) });
    },
  });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
  };

  // ── Phase 8: Background provider registration (non-blocking) ────────────
  // These run after the initial render so they don't delay startup.
  //
  // Environment-key providers, the saved servers on this computer and a scan of
  // this computer always run; the scan of the local subnet runs only with the
  // owner's recorded consent. See src/runtime/lan-scan-consent.ts.

  runGatedLanScan({
    configManager,
    providerRegistry,
    runtime,
    requestRender,
    restoreRuntimeModel: restoreSavedModel,
    systemMessageRouter,
    shellPaths: services.shellPaths,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  // Refresh explicitly-subscribed external calendar feeds that are DUE
  // per their own bounded interval (conditional 304 requests keep it cheap).
  // Consent was given at subscribe time ("now and on each refresh"); with no
  // subscriptions this touches nothing. Non-blocking, boot never waits on it;
  // one honest aggregate line only when something refreshed or failed.
  void scheduleCalendarSubscriptionBootRefresh({
    shellPaths: services.shellPaths,
    secretsManager: services.secretsManager,
    systemMessageRouter,
    requestRender,
  });
  const mcpSuggestions = scheduleMcpSuggestionScan({
    mcpRegistry: services.mcpRegistry,
    systemMessageRouter,
    requestRender,
    shellPaths: services.shellPaths,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
  // The one release of the MCP servers started on use (mcp-lazy-start.ts),
  // run at shutdown after the config watcher has stopped.
  const mcpServers = {
    stop: (): Promise<void> => {
      mcpSuggestions.stop();
      return services.mcpRegistry.disconnectAll().catch((error: unknown) => {
        logger.warn('MCP disconnect at shutdown failed', { error: summarizeError(error) });
      });
    },
  };
  wireTerminalMcpReload(services.shellPaths, services.mcpRegistry, mcpServers, bootstrapUnsubs, systemMessageRouter, requestRender);

  // ── Phase 12: Session:start lifecycle hook ─────────────────────────────

  announceTerminalSessionStarted(runtime.sessionId, workingDir, services.hookDispatcher, runtimeBus);

  // ── Compose RuntimeContext ────────────────────────────────────────────────

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
    get sessionId() { return runtime.sessionId; },
    isResumed: false, // Sessions start fresh; use /session resume to load a previous one
    runtime,
    orchestrator,
    compositor,
    selection,
    commandContext,
    uiServices,
    inputHistory,
    bootstrapUnsubs,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    loadLastConversation: () => loadLastConversation({ surface: services.surface }),
    _writeLastSessionPointer: writeLastSessionPointerForSurface,
    _getPinned: () => services.favoritesStore.getPinned(),
    _getConfiguredProviderIds: () => services.providerRegistry.getConfiguredProviderIds(),
    commandRegistry,
    systemMessageRouter,
    shutdown: createRuntimeShutdown({
      get sessionId() { return runtime.sessionId; },
      get model() { return runtime.model; },
      get provider() { return runtime.provider; },
      conversationTitle: () => conversation.title || '',
      sessionSpineClient: services.sessionSpineClient,
      takeMemorySpineTimer: () => memorySpineRecheck.take(),
      bootstrapUnsubs,
      runtimeUnsubs,
      forensicsCollector,
      executionLedger: services.executionLedger,
      disposeRuntimeGraph: () => services.close(),
      deferredStartup,
      agentExternalServices,
      scheduleManager: services.workflow.scheduleManager,
      hookDispatcher: services.hookDispatcher,
      providerRegistry: services.providerRegistry,
      sessionOrchestration: services.sessionOrchestration,
      shutdownOptions: { surface: services.surface },
    }),
  };

  // Wire exit from options if provided; otherwise main.ts binds the operator route.
  if (options?.exit) {
    ctx.commandContext.exit = options.exit;
  }

  return ctx;
}
