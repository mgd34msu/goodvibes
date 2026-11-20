#!/usr/bin/env bun
import { announceSettingsIngestionNotices } from '@goodvibes-jev/engine/terminal-shell/cli-config-overrides';
import { isNativeConversationTurnReady, nativeConversationTurnInputOptions } from '@goodvibes-jev/engine/terminal-shell/native-ingress';
import { readShellFrameFacts, createShellSubmissionPorts, createUiEventPublisher, readUiFrame } from '@goodvibes-jev/engine/terminal-shell/shell-frame-facts';
import { join } from 'node:path';
import { sanitizeSessionName } from '@goodvibes-jev/engine/platform/platform/sessions';
import { createHerdrSessionReporter } from '@goodvibes-jev/engine/terminal-shell';
import { runPickedCommand } from '@goodvibes-jev/engine/terminal-shell/command-registry';
import { CommandReadings } from './input/commands/command-readings.ts';
import { TestRuns } from './input/commands/test-runtime.ts';
import { wireHostPairingShell } from './shell/host-pairing-shell.ts';
import type { HostPairingController } from './shell/host-pairing-controller.ts';
import { isConversationUsageAvailable, isConversationContextAvailable } from './core/conversation-usage.ts';
import type { NativeConversationIntakeState } from './runtime/native-conversation-intake.ts';
import type { ProductInputContext } from '@goodvibes-jev/engine/terminal-shell/native';
import { dispatchNativeConversationTurn, describeFailedNativeDispatch } from './runtime/native-conversation-ingress.ts';
import { readTuiConfigValue, subscribeTuiConfigValue } from './config/host-settings.ts';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import './renderer/compositor.ts';

import { UIFactory } from './renderer/ui-factory.ts';
import { resolveThrobberActivity } from './renderer/throbber.ts';
import { SPINNER_FRAMES } from './renderer/ui-primitives.ts';
import { ActivityAnimation } from './core/activity-animation.ts';
import '@goodvibes-jev/engine/platform/platform/core';
import { InputHandler } from './input/handler.ts';
import '@goodvibes-jev/engine/terminal-shell';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import type { OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
import { bindOwnerInput } from '@goodvibes-jev/engine/terminal-shell/companion-input';
import '@goodvibes-jev/engine/platform/platform/tools';
import '@goodvibes-jev/engine/platform/platform/tools';
import '@goodvibes-jev/engine/platform/platform/state';
import { describePermissionModeInForce } from '@goodvibes-jev/engine/platform/platform/permissions';
import '@goodvibes-jev/engine/platform/platform/acp';
import { PermissionPromptUI, buildPendingPermissionExtras } from './permissions/prompt.ts';
import {
  handleBrokerApprovalChange,
  sweepBrokerApprovals,
  createApprovalCardQueue,
  settledAskDecision,
} from './permissions/broker-approval-card.ts';
import './input/command-registry.ts';

import { createSessionContractViews, wireWorkTree } from './core/work-tree-wiring.ts';
import { createContractQuestionComposer } from '@goodvibes-jev/engine/terminal-shell/contract-question-composer';
import './input/commands.ts';
import '@goodvibes-jev/engine/platform/platform/tools';
import './input/input-history.ts';
import { describeContextWindowSource } from '@goodvibes-jev/engine/platform/platform/providers';
import './renderer/git-status.ts';

import { createShellLayout } from './renderer/layout-engine.ts';
import { buildShellFooter, estimateShellFooterHeight, promptCursorOffset, statusCostText } from './renderer/shell-surface.ts';
import { HEADER_GAP_ROWS, withHeaderGap } from './renderer/header-line.ts';
import { TranscriptScroll } from './shell/transcript-scroll.ts';
import { formatStatusReport } from './shell/status-report.ts';
import { voiceCaptureDescription } from './renderer/voice-capture-chip.ts';
import { voiceCaptureRowVisible } from './core/voice-capture-status.ts';
import { resolveWebSurfaceUrl } from '@goodvibes-jev/engine/platform/platform/runtime/feature-announcements';
import { worktreeStatusLines } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { emitAgentAwaitingMessage, emitAgentAwaitingTool } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import { resolveActiveModelDisplay } from './core/active-model-identity.ts';
import { computePromptContentWidth } from './renderer/prompt-content-width.ts';
import { buildConversationViewport, centerViewportContent } from './renderer/conversation-layout.ts';
import { applyConversationOverlays, buildConversationLayers } from './renderer/conversation-overlays.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import { selfUpdateAtLaunch } from './cli/launch-auto-update.ts';
import { buildSharedOrchestratorCoreServices, refreshMemoryRecallSnapshot } from './runtime/orchestrator-core-services.ts';
import { createSessionContinuityHintsBuilder } from './runtime/session-continuity-hints.ts';
import { readLastSessionPointer } from '@/runtime/index.ts';
import { startRecoveryAutosave } from './runtime/recovery-autosave.ts';
import { startRecoveryOffer } from './runtime/recovery-prompt.ts';
import { createStartupTypeaheadGate } from './runtime/startup-typeahead-gate.ts';
import { buildRecoveryOfferWiring, offerCrashSnapshotOnOpen } from './runtime/recovery-offer-wiring.ts';
import { whenCrashSnapshotFound } from '@goodvibes-jev/engine/terminal-shell/session-crash-recovery';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import {
  actionHint,
  createShellActionOffers,
  FIX_SESSION_CHORD_LABEL,
  handleShellActionChord,
  wireRetryOfferOnError,
} from './shell/retry-affordance.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { runNativeTurnDispatch } from './core/native-turn-dispatch.ts';
import { resolveFoldedBookmarkLine } from './core/bookmark-navigation.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { PreparedShellCliRuntime } from './cli/entrypoint.ts';
import { applyInitialTuiCliState, reportFatalStartupError } from './cli/tui-startup.ts';
import { applyConfiguredHitlMode, applyTerminalRuntimeConfigDefaults } from '@goodvibes-jev/engine/terminal-shell';
import { installVoiceCapture } from './shell/voice-capture-shell.ts';
import { createOwnerSubmission } from './shell/owner-submission.ts';
import { allowTerminalWrite, installFullScreenTerminalOutputGuard } from '@goodvibes-jev/engine/terminal-shell/terminal-output-guard';
import { installProcessLifecycle } from './runtime/process-lifecycle.ts';
import { createRenderScheduler, installTerminalExitGuards } from '@goodvibes-jev/engine/terminal-shell';
import { buildCommandArgsHint } from './input/command-args-hint.ts';
import { contractIsWorking, summarizeRunningAgents } from './renderer/process-summary.ts';
import { footerFleetCost } from './views/fleet-read-model.ts';
import { footerTargetRows } from './renderer/footer-targets.ts';
import { wireStreamEventMetrics, type WireStreamEventMetricsResult } from './core/stream-event-wiring.ts';
import { createStreamMetrics, oldestRunningTool, type StreamMetrics } from './core/stream-metrics.ts';
import { wireTurnEventHandlers } from './core/turn-event-wiring.ts';
import { createUserTurnOwner } from './core/user-turn.ts';
import { resolveContextStatusHint } from './renderer/context-status-hint.ts';
import { isEffectiveDangerMode } from '@goodvibes-jev/engine/platform/platform/config';
import { ShellPassthrough } from '@goodvibes-jev/engine/terminal-shell/shell-passthrough';
import { makeComposerEditorOpener, makeFileEditorOpener } from './input/composer-editor.ts';
import { evaluateSessionMaintenance } from '@/runtime/index.ts';
import { createCancelGeneration, runOwnedTurnRetry } from './core/turn-cancellation.ts';

/** What a retry of a turn that already ran tools sends: the turn continues from the results instead of repeating them. */
const CONTINUE_AFTER_TOOLS = 'The previous attempt stopped with an error after running tools. Their results are above; continue from them without repeating what they already did.';

/** Whether the turn that started at `from` (its message count before the prompt) ran any tool. */
function turnRanTools(conversation: { getMessageCount(): number; getMessageAt(index: number): Readonly<{ role: string; toolCalls?: readonly unknown[] | undefined }> | undefined }, from: number): boolean {
  for (let index = from; index < conversation.getMessageCount(); index++) {
    const message = conversation.getMessageAt(index);
    if (message?.role === 'tool' || (message?.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0)) return true;
  }
  return false;
}
import { wireInteractionSeams, createMemoryProvenanceUi } from './runtime/interaction-seams.ts';
import { createPowerChipSource } from './core/power-chip-source.ts';
import { createModeWordsSource, getSharedModeFlash } from '@goodvibes-jev/engine/terminal-shell/session-permission-mode';
import { keycapLabel } from '@goodvibes-jev/engine/terminal-shell/status-line';
import { drawSplashAdditions } from '@goodvibes-jev/engine/terminal-shell/first-run';
import { getSharedNotificationFeed } from './views/notifications-feed.ts';
import { keepAwakeHolding } from './core/power-status.ts';
import { createKeepAwakeForwarder, readServedKeepAwakeState, watchDaemonPowerEvents, type PowerState } from '@goodvibes-jev/engine/platform/platform/power';
import { resolveOperatorRpc } from './input/commands/operator-rpc.ts';
import { resolveDaemonEndpoint } from './runtime/client/operator-endpoint.ts';
import { wireGuidanceNotices } from './input/commands/guidance-runtime.ts';
import { proposesSpeechToText, runWakeSetupPlan, wakeSetupRunning } from './core/wake-setup-plan.ts';
import { wrapRequestPermissionWithAlert } from './core/approval-alert.ts';
import { createTerminalNotifier } from './core/terminal-notifier.ts';
import { createDeferredRender } from './renderer/deferred-render.ts';
import { wireSessionAmbience } from './runtime/session-ambience-wiring.ts';
import { createSpokenTurnInputOptions } from './audio/spoken-turn-model-routing.ts';

import {
  ALT_SCREEN_EXIT,
  MOUSE_DISABLE,
  CURSOR_SHOW,
  CLEAR_SCREEN,
  KEYBOARD_EXT_DISABLE,
  PASTE_DISABLE,
  FOCUS_DISABLE,
} from './renderer/terminal-escapes.ts';
import { installBackgroundThemeProbe } from './renderer/terminal-bg-probe.ts';
import { registerThemeRefresh } from './renderer/theme.ts';
import { VERSION } from './version.ts';
import { SessionViews } from './shell/session-views.ts';

let releaseFailedStartupSession: (() => Promise<void>) | undefined;

async function main(prepared: PreparedShellCliRuntime) {
  const stdout = process.stdout;
  const stdin = process.stdin;
  const { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory } = prepared;

  // Between binary start and the first frame, boot used to be silent (config
  // load, trust manager, memory init, hooks). One honest pre-alt-screen line,
  // placed after the help/version/completion early-exits above so those stay
  // byte-clean.
  stdout.write(`goodvibes v${VERSION} starting…\n`);

  // Launch-time self-update, before any bootstrap or terminal mode change; on
  // an installed update this restarts onto the swapped binary and never returns.
  const launchUpdateLines = await selfUpdateAtLaunch({ configManager, stdout });

  const herdrSession = createHerdrSessionReporter();
  let refreshHerdr: () => void = () => {};
  let unsubscribeHerdrHooks: () => void = () => {};
  const closeHerdr = () => {
    unsubscribeHerdrHooks();
    return herdrSession.close();
  };
  releaseFailedStartupSession = closeHerdr;

  const ctx: BootstrapContext = await bootstrapRuntime(stdout, {
    configManager,
    workingDir: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
    // Named, so GOODVIBES_DAEMON_HOME on its own moves the client's daemon tier.
    daemonHomeDirectory: resolveGoodVibesDaemonHome(bootstrapHomeDirectory),
    onHookDispatcherReady: ({ runtime: activeRuntime, surface, hookDispatcher: dispatcher }) => {
      refreshHerdr = () => {
        void herdrSession.update({
          sessionId: activeRuntime.sessionId,
          sessionPath: join(surface.sessionsDir, `${sanitizeSessionName(activeRuntime.sessionId)}.jsonl`),
          busy: dispatcher.activeInvocationCount > 0,
          waitingForOwner: false,
          resumeArgv: ['goodvibes', '--working-dir', bootstrapWorkingDir, '--resume', activeRuntime.sessionId],
        });
      };
      unsubscribeHerdrHooks = dispatcher.onActivity(() => refreshHerdr());
    },
  });
  const {
    conversation,
    orchestrator,
    runtime,
    toolRegistry,
    compositor,
    selection,
    commandContext,
    uiServices,
    commandRegistry,
    inputHistory,
    hookDispatcher,
    gitStatusProvider,
    lastGitInfoRef,
    bootstrapUnsubs,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    trustPromptRef,
    _writeLastSessionPointer: writeLastSessionPointer,
    systemMessageRouter,
  } = ctx;
  const workingDir = ctx.services.workingDirectory;
  const homeDirectory = ctx.services.homeDirectory;
  const { approvalBroker, agentManager, modeManager, processManager, providerRegistry, secretsManager, subscriptionManager } = ctx.services;
  void herdrSession.update({
    sessionId: runtime.sessionId,
    sessionPath: join(ctx.services.surface.sessionsDir, `${sanitizeSessionName(runtime.sessionId)}.jsonl`),
    busy: orchestrator.isBusy || hookDispatcher.activeInvocationCount > 0,
    waitingForOwner: false,
    resumeArgv: ['goodvibes', '--working-dir', workingDir, '--resume', runtime.sessionId],
  });
  conversation.setSessionMemoryStore(ctx.services.sessionMemoryStore);
  conversation.setSessionLineageTracker(ctx.services.sessionLineageTracker);
  // Shared payload (single source of truth, includes the memoryRegistry,
  // see orchestrator-core-services.ts) plus this site's favoritesStore.
  orchestrator.setCoreServices({
    ...buildSharedOrchestratorCoreServices({ services: ctx.services, configManager, providerRegistry }),
    favoritesStore: ctx.services.favoritesStore,
  });
  let activeConversationWidth = stdout.columns || 80;
  conversation.setWidthProvider(() => activeConversationWidth);
  // The print level (behavior.hitlMode) follows the setting into the mode manager and the notification router; TUI-side config defaults.
  applyConfiguredHitlMode(configManager, modeManager, ctx.services.notificationDispatcher.router);
  applyTerminalRuntimeConfigDefaults(configManager);

  // Re-surface pre-TUI launch-update lines in-session (the alt screen wipes
  // stdout). Launch-time update mechanics are routine, not urgent, low
  // priority, not high (a skipped/deferred check is not the kind of thing
  // that should compete with real session alerts for attention).
  for (const line of launchUpdateLines) systemMessageRouter.low(`[Update] ${line}`);

  const buildSessionContinuityHints = createSessionContinuityHintsBuilder({ readModels: uiServices.readModels });

  // Callable before the scheduler exists; see deferred-render.ts for why.
  const deferredRender = createDeferredRender();
  const render = deferredRender.render;
  refreshHerdr = render;
  const typeahead = createStartupTypeaheadGate(); // keys typed before a startup modal appeared never answer it

  let pendingPermission: PendingPermissionState | null = null;
  /** True while $EDITOR owns the terminal: frames and terminal notifications are held until it exits. */
  let externalEditorOpen = false;
  let inputEpoch = 0;
  let submissionStatus: string | null = null;
  let hostPairing: HostPairingController | null = null;
  // Actions offered after something the shell did (retry a failed turn, open a
  // started fix session): each runs only on its chord, and the footer shows
  // what is on offer (shell/retry-affordance.ts).
  const actionOffers = createShellActionOffers();
  const offeredFixSessions = new Set<string>();
  commandContext.armFixSessionAttach = (fixSessionId) => {
    if (offeredFixSessions.has(fixSessionId)) return; // a repeated run result offers it once
    offeredFixSessions.add(fixSessionId);
    actionOffers.fixSessionId = fixSessionId;
    systemMessageRouter.high(`[CI] Fix session ready: ${FIX_SESSION_CHORD_LABEL} opens it (or /session resume ${fixSessionId}).`);
    render();
  };
  type LocalCard = { readonly request: Parameters<typeof buildPendingPermissionExtras>[0]; readonly resolve: Parameters<typeof buildPendingPermissionExtras>[1]; readonly queuedAt: number };
  const localCards = createApprovalCardQueue<LocalCard>({
    getPending: () => pendingPermission,
    callIdOf: (card) => card.request.callId,
    show: ({ request, resolve, queuedAt }) => {
      // An ask that waited behind another card may have been settled meanwhile, on another surface, with an amended or per-hunk answer.
      const settled = settledAskDecision(approvalBroker.listApprovals(Number.MAX_SAFE_INTEGER), request.callId, queuedAt);
      if (settled) { resolve(settled); return false; }
      hostPairing?.cancelForTakeover();
      // A delegated agent asking the owner is waiting on them until the card is answered;
      // the answer settles its call, so it leaves the wait for that tool call.
      const askingAgent = request.attribution?.kind === 'background-agent' ? request.attribution.agentId : null;
      let answer = resolve;
      if (askingAgent !== null) {
        const bus = uiServices.runtime.runtimeBus;
        const emitter = { sessionId: runtime.sessionId, traceId: `${runtime.sessionId}:ask:${request.callId}`, source: 'permission-card' };
        emitAgentAwaitingMessage(bus, emitter, { agentId: askingAgent });
        answer = (decision) => {
          emitAgentAwaitingTool(bus, emitter, { agentId: askingAgent, callId: request.callId, tool: request.tool });
          resolve(decision);
        };
      }
      pendingPermission = { ...request, ...buildPendingPermissionExtras(request, answer, approvalBroker) };
      render();
      return true;
    },
  });
  const brokerCardParams = {
    broker: approvalBroker,
    render,
    notify: (message: string) => { systemMessageRouter.high(message); render(); },
    getPending: () => pendingPermission,
    setPending: (next: PendingPermissionState | null) => {
      if (next) hostPairing?.cancelForTakeover();
      pendingPermission = next;
      if (next === null) localCards.next();
    },
  };
  approvalBroker.subscribe((approval) => {
    handleBrokerApprovalChange({ ...brokerCardParams, approval });
    queueMicrotask(() => sweepBrokerApprovals({ ...brokerCardParams, listApprovals: () => approvalBroker.listApprovals(Number.MAX_SAFE_INTEGER) }));
  });

  // Where the main transcript is scrolled to; each frame's overlay-aware clamp (conversation-layout) is fed back so a scroll clamps against exactly what is displayed (shell/transcript-scroll.ts).
  const transcript = new TranscriptScroll();
  // Stream and tool-timer state; mutated by wireStreamEventMetrics handlers, read during render.
  const streamMetrics: StreamMetrics = createStreamMetrics();
  // When the running compaction was first seen (the throbber's elapsed time); undefined while none runs.
  let compactingSinceMs: number | undefined;

  const getPromptContentWidth = () => computePromptContentWidth(stdout.columns);
  // Live-microphone footer row (push-to-talk or the wake detector); assigned once voice capture is wired below, null until then so pre-wiring frames size correctly.
  let voiceCaptureStatus: () => import('./core/voice-capture-status.ts').VoiceCaptureIndicatorState | null = () => null;

  // Agents and background processes opened full screen (shell/session-views.ts); set once the input handler exists.
  let sessionViews: SessionViews | null = null;
  let lastHeaderModel = runtime.model;
  const getViewportHeight = (): number => {
    if (input.onboardingWizard.active) return stdout.rows || 24;
    const promptLines: number = input.getVisiblePromptLineCount(getPromptContentWidth());
    const rows = stdout.rows || 24;
    // The header row (+ the session chips), and on the main screen the empty row under them (a view's body brings its own).
    return rows - (sessionViews?.headerRows() ?? 1) - (sessionViews?.active ? 0 : HEADER_GAP_ROWS) - estimateShellFooterHeight(promptLines);
  };

  const scroll = (delta: number) => {
    if (sessionViews?.active) {
      sessionViews.scroll(-delta);
      return;
    } // a view scrolls its own lines (up is positive there)
    // The footer estimate is only a fallback for the pre-first-render frame; reaching the bottom re-locks.
    transcript.scrollBy(delta, () => Math.max(0, conversation.history.getLineCount() - getViewportHeight()));
  };

  // Back to the live bottom: re-lock, and the next frame follows the tail again.
  const scrollToLiveBottom = () => {
    transcript.toBottom();
    render();
  };

  // Respect a manual scroll-up: only follow the tail while parked at the bottom (submitInput re-locks on new input).
  const scrollToEnd = (vHeight: number) => transcript.followTail(conversation.history.getLineCount(), vHeight);

  const unsubs: Array<() => void | Promise<void>> = [];
  // `!<command>` runs here, beside the composer; Esc or closing the app stops it.
  const shellPassthrough = new ShellPassthrough();
  unsubs.push(() => shellPassthrough.cancelRunning());
  const activityAnimation = new ActivityAnimation(() => render());
  unsubs.push(() => activityAnimation.dispose());
  // Consume the registry's change feed. Querying here used to clone every
  // historical contract and inspect host processes on each frame/keystroke.
  // Controls still act through the registry and revalidate their live targets.
  type FleetNodes = ReturnType<typeof ctx.services.processRegistry.query>['nodes'];
  let currentFleet: FleetNodes = ctx.services.processRegistry.query().nodes;
  unsubs.push(
    ctx.services.processRegistry.subscribe((snapshot) => {
      currentFleet = snapshot.nodes;
      render();
    }),
  );
  const fleetNodes = (): FleetNodes => currentFleet;
  const sessionContractViews = createSessionContractViews(ctx.services.contractRunner, () => runtime.sessionId);
  unsubs.push(sessionContractViews.dispose);
  // A contract's open question: offered above the composer, answered by the next typed message unless dismissed (Alt+X).
  const contractQuestions = createContractQuestionComposer(() => sessionContractViews.read());
  // The work tree's live facts: call/turn timings, agent lanes, the call a permission prompt holds, fold persistence (work-tree-wiring.ts).
  const workTreeWiring = wireWorkTree({
    conversation,
    events: uiServices.events,
    agentManager,
    contracts: sessionContractViews,
    fleetNodes,
    pendingCallId: () => pendingPermission?.callId,
    turnActive: () => orchestrator.isThinking,
    sessionsDir: ctx.services.surface.sessionsDir,
    sessionId: () => runtime.sessionId,
    requestRender: () => render(),
  });
  unsubs.push(...workTreeWiring.unsubs);
  let recoveryInterval: ReturnType<typeof setInterval> | null = null;
  let stopSpokenOutputForExit: (() => Promise<void>) | null = null;
  // The optional "used N memories" provenance chip (default OFF), see interaction-seams.ts.
  const memoryProvenanceUi = createMemoryProvenanceUi({ render: () => render(), memorySpine: ctx.services.memorySpine });
  // Topology-aware keep-awake: in adopted-external mode the daemon owns keep-awake, the chip renders its
  // state (power-chip-source.ts), every toggle from /power, Alt+A or the settings modal (all land on the
  // power.keepAwake key) is forwarded to it, and each time it becomes reachable a toggle it has not taken is
  // sent again, on or off; otherwise this terminal takes the daemon's value. One forwarder in the engine.
  const isExternalDaemon = () => uiServices.platform.externalServices?.inspect()?.daemonStatus?.mode === 'external';
  const daemonRpc = () => resolveOperatorRpc({ configManager, homeDirectory });
  const keepAwakeForwarder = createKeepAwakeForwarder({
    where: 'this terminal',
    readKeepAwake: () => configManager.get('power.keepAwake') === true,
    adoptKeepAwake: (enabled) => configManager.set('power.keepAwake', enabled),
    notify: (line) => { systemMessageRouter.high(line); render(); },
    send: async (enabled) => {
      const rpc = daemonRpc();
      if (!rpc.available) return { attempted: true, result: { ok: false, kind: 'connected_host_unavailable', error: rpc.reason } };
      try {
        const keepAwakeState = readServedKeepAwakeState(await rpc.platformClient.operator.invoke('power.keepAwake.set', { enabled }));
        return { attempted: true, result: keepAwakeState !== undefined ? { ok: true, keepAwakeState } : { ok: true } };
      } catch (error) {
        return { attempted: true, result: { ok: false, kind: 'connected_host_error', error: summarizeError(error) } };
      }
    },
  });
  const fetchDaemonPowerState = async (): Promise<PowerState | null> => {
    let state: PowerState | null = null;
    const rpc = isExternalDaemon() ? daemonRpc() : null;
    if (rpc?.available) {
      try {
        state = await rpc.platformClient.operator.invoke('power.status.get', {}) as unknown as PowerState;
      } catch {
        state = null;
      }
    }
    keepAwakeForwarder.reachable(state !== null, typeof state?.keepAwake?.enabled === 'boolean' ? state.keepAwake.enabled : undefined);
    return state;
  };
  const powerChipSource = createPowerChipSource({
    powerManager: ctx.services.powerManager,
    render: () => render(),
    isExternalDaemon,
    onPowerEvent: (cb) => uiServices.events.ops.on('OPS_POWER_STATE_CHANGED', cb as never),
    fetchDaemonPowerState,
    // The daemon says when sleep ownership changes; the chip polls only while this stream is not open.
    watchDaemonPowerEvents: async (handlers) => {
      const endpoint = await resolveDaemonEndpoint({ configManager, homeDirectory });
      return endpoint.available ? await watchDaemonPowerEvents({ baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token, ...handlers }) : null;
    },
  });
  const unsubscribeKeepAwakeForward = configManager.subscribe('power.keepAwake', (newValue) => {
    if (isExternalDaemon()) void keepAwakeForwarder.set(newValue === true).finally(() => powerChipSource.refresh());
  });
  unsubs.push(uiServices.events.turns.on('TURN_COMPLETED', () => powerChipSource.refresh()));
  unsubs.push(powerChipSource.stop, unsubscribeKeepAwakeForward);
  // The status bar's mode words, recomputed only when the mode in force can change (session-permission-mode.ts);
  // its flash after Shift+Tab, and the unread notices count, each repaint when they change.
  const modeWords = createModeWordsSource(configManager, () => render(), getSharedModeFlash());
  getSharedModeFlash().onChange = () => render();
  unsubs.push(() => modeWords.stop(), getSharedNotificationFeed().subscribe(() => render()));
  // Turning wake detection on from anywhere (settings, /config, a model's settings
  // call) runs the same voice setup as /voice wake setup and shows its plan.
  unsubs.push(configManager.subscribe('voice.wake.enabled', (enabled) => {
    if (enabled !== true || wakeSetupRunning()) return;
    void runWakeSetupPlan(ctx.services.voiceSetup).then(
      (outcome) => {
        systemMessageRouter.userAction(['Wake-Word Setup', outcome.rendered,
          ...(proposesSpeechToText(outcome) ? ['(yes: /voice wake setup yes installs it now)'] : [])].join('\n'));
        render();
      },
      (error: unknown) => {
        systemMessageRouter.high(`Wake-Word Setup: ${error instanceof Error ? error.message : String(error)}`, 'error');
        render();
      },
    );
  }));
  const lifecycle = installProcessLifecycle({
    stdin,
    stdout,
    ctx,
    noAltScreen: cli.flags.noAltScreen,
    ansi: { CLEAR_SCREEN, ALT_SCREEN_EXIT, PASTE_DISABLE, KEYBOARD_EXT_DISABLE, MOUSE_DISABLE, CURSOR_SHOW, FOCUS_DISABLE },
    getInput: () => input,
    render: () => renderScheduler.flushNow(), // resize: synchronous immediate path
    getPromptContentWidth,
    getTerminalOutputGuard: () => terminalOutputGuard,
    buildSessionContinuityHints,
    unsubs,
    getRecoveryInterval: () => recoveryInterval,
    setRecoveryInterval: (value) => {
      recoveryInterval = value;
    },
    getStopSpokenOutputForExit: () => stopSpokenOutputForExit,
    releaseSession: closeHerdr,
  });
  const {
    exitApp,
    resizeHandler,
    sigintHandler,
    unhandledRejectionHandler,
    uncaughtExceptionHandler,
    terminationSignalHandler,
    exitListener,
  } = lifecycle;
  commandContext.exit = exitApp;
  const commandReadings = new CommandReadings(
    () => runtime.sessionId,
    () => !lifecycle.isTerminalRestored(),
  );
  commandContext.commandReadings = commandReadings;
  unsubs.push(() => commandReadings.dispose());
  const testRuns = new TestRuns();
  commandContext.testRuns = testRuns;
  unsubs.push(() => testRuns.dispose());

  // In-terminal (OSC 9) notifier (approval-wait/turn-end/agent-blocked); writes
  // are restore-gated so no escape sequence lands after the shell resumes.
  const terminalNotifier = createTerminalNotifier({
    stdout,
    focusTracker: ctx.services.focusTracker,
    isReleased: () => lifecycle.isTerminalRestored() || externalEditorOpen,
    configGet: (k: string) => readTuiConfigValue(configManager, k),
  });

  // Spoken output, scriptable statusline, auto-titling, spoken-turn routing.
  const ambience = wireSessionAmbience({
    voiceService: ctx.services.voiceService,
    configManager,
    events: uiServices.events,
    conversation,
    toolLLM: ctx.services.toolLLM,
    orchestrator,
    providerRegistry,
    workingDir,
    getSessionId: () => runtime.sessionId,
    isActive: () => !lifecycle.isTerminalRestored(),
    notify: (message) => systemMessageRouter.high(message),
    render,
  });
  stopSpokenOutputForExit = ambience.stopSpokenOutputForExit;
  const { spokenTurns, scriptableStatusline } = ambience;
  unsubs.push(...ambience.unsubs);
  const dispatchNativeTurn = async (
    state: NativeConversationIntakeState,
    spokenOutput = false,
    current: () => boolean = () => true,
  ): Promise<void> => {
    if (!isNativeConversationTurnReady(state)) return;
    const inputOptions = nativeConversationTurnInputOptions(state, spokenOutput ? createSpokenTurnInputOptions() : undefined);
    streamResult.startNewTurn();
    await runNativeTurnDispatch({
      prepare: () => refreshMemoryRecallSnapshot(ctx.services),
      current,
      begin: () => {
        submissionStatus = null;
        render();
      },
      start: () => dispatchNativeConversationTurn(state, orchestrator, inputOptions),
      failed: async (error) => {
        // A turn that provably never started gives its claim back so /work intake-retry can run it.
        submissionStatus =
          await describeFailedNativeDispatch(
            state,
            error,
            `Prompt dispatch failed: ${summarizeError(error)}. Inspect /work intake-status before retrying.`,
          );
        systemMessageRouter.high(submissionStatus);
        render();
      },
    });
  };
  commandContext.dispatchNativeIntakeTurn = (state) => dispatchNativeTurn(state);

  const beginSubmission = (): void => {
    commandReadings.cancelAll();
    hostPairing?.cancelForTakeover();
    // Acting here after another surface took the session over is what moves the conversation back for rewinds.
    if (ctx.services.conversationRewindHost.resumeIfTakenOver()) {
      systemMessageRouter.high('[Rewind] Another surface had taken over this session; this one is offering its conversation for rewinds again.');
    }
    transcript.toBottom(); // Re-lock on any user input
    conversation.dismissSplash(); // owner rule: any submission retires the splash for the run
  };

  // Typed composer text has a grammar (`@model:`, `!`, `!#`, `# `); text sent as given and speech do not.
  const submission = createOwnerSubmission({
    shellPassthrough,
    workingDir,
    sessionMemoryStore: ctx.services.sessionMemoryStore,
    begin: beginSubmission,
    switchModels: (models, rest, content, options) => { void switchThenSubmit(models, rest, content, options); },
    answerOptions: () => contractQuestions.answerOptions(),
    sendTurn: (text, content, inputOptions) => sendOwnerTurn(text, content, inputOptions),
    notify: (message, level) => systemMessageRouter.high(message, level),
    showShellOutput: (result) => conversation.addShellOutput(result.display, result.failed),
    render: () => render(),
  });
  const { submitInput, submitTurn } = submission;

  /**
   * `@model:<id> prompt`: switch through `/model <id>` (the one switch path), then
   * send the rest. A switch that did not land (an unknown id, or a provider key
   * still being entered) holds the prompt in the composer instead of sending it
   * to a model the owner did not ask for.
   */
  const switchThenSubmit = async (models: readonly string[], rest: string, content: ContentPart[] | undefined, options: ProductInputContext): Promise<void> => {
    for (const model of models) {
      const before = runtime.model;
      try {
        await commandRegistry.execute('model', [model], commandContext);
      } catch (error) {
        systemMessageRouter.high(`[Model] Could not switch to ${model}: ${summarizeError(error)}`, 'error');
      }
      const current = (() => { try { return providerRegistry.getCurrentModel(); } catch { return null; } })();
      const landed = runtime.model !== before || (current !== null && runtime.model === current.registryKey && (model === current.registryKey || model === current.id));
      if (!landed) {
        if (rest !== '' && input.prompt === '') {
          input.prompt = rest;
          input.cursorPos = rest.length;
        }
        systemMessageRouter.high(rest === ''
          ? `[Model] Still on ${runtime.model}.`
          : `[Model] Still on ${runtime.model}; your prompt was not sent and is back in the composer. Finish the switch (or pick another model), then press Enter.`);
        render();
        return;
      }
    }
    if (rest === '' && !content) {
      render();
      return;
    }
    submission.submitCaptured(rest, content, options);
  };

  /**
   * The owner-input path: typed, spoken, companion and plan input all start their
   * turn here, with the same retry context, failure status and memory refresh.
   * Chat accepts the owner's message directly. Native admission belongs to
   * explicit work submission, never to deciding whether a model may see it.
   */
  function sendOwnerTurn(text: string, content?: ContentPart[], inputOptions?: OrchestratorUserInputOptions): void {
    // A fresh prompt supersedes provider recovery for the previous submission.
    streamResult.startNewTurn();
    actionOffers.retry = null;
    const epoch = ++inputEpoch;
    submissionStatus = null;
    // Optional memory refresh must not delay displaying or sending the prompt.
    void refreshMemoryRecallSnapshot(ctx.services);
    void orchestrator
      .handleUserInput(text, content, inputOptions)
      .catch((error) => {
        if (epoch === inputEpoch) submissionStatus = `Prompt failed: ${summarizeError(error)}`;
      })
      .finally(render);
    render();
  }

  const cancelTurn = commandReadings.withCancellation(
    createCancelGeneration(orchestrator, spokenTurns),
  );
  const cancelGeneration = (): boolean => {
    shellPassthrough.cancelRunning();
    const stoppedTest = testRuns.cancel();
    return cancelTurn() || stoppedTest;
  };

  const jumpToBookmark = (key: string) => {
    conversation.getDisplayBlocks();
    const block = conversation.getBlockRegistry().find((entry) => entry.collapseKey === key);
    const line = block?.startLine ?? resolveFoldedBookmarkLine(conversation, key);
    if (line === null) {
      systemMessageRouter.high(`[Bookmark] Not found: ${key}`, 'warning');
      render();
      return;
    }
    transcript.jumpTo(line);
    render();
  };

  const scrollToLine = (line: number) => {
    conversation.getDisplayBlocks();
    const maxScroll = Math.max(0, conversation.history.getLineCount() - getViewportHeight());
    transcript.jumpTo(line, maxScroll);
    render();
  };

  Object.assign(
    commandContext,
    createShellSubmissionPorts(
      submitInput,
      submitTurn,
      () => spokenTurns.stop(),
      () => input.handlePaste(),
    ),
  );
  // Read-only view of pending [TEXT: pN, M lines] fold markers, so /pastes
  // can preview a folded paste's actual content before the user submits it.
  commandContext.getPendingPastes = () => input.pasteRegistry;
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  // Late-patched: bootstrap.ts populates uiServices.platform.externalServices AFTER commandContext is built.
  commandContext.platform.externalServices = uiServices.platform.externalServices;
  commandContext.cancelGeneration = cancelGeneration;
  commandContext.cancelSessionWork = () => { commandReadings.cancelAll(); };
  wireInteractionSeams(commandContext, {
    orchestrator,
    powerManager: ctx.services.powerManager,
    readPowerSurface: () => powerChipSource.get(),
    render: () => render(),
    notify: (m) => systemMessageRouter.high(m),
    getActiveToolCallId: () => oldestRunningTool(streamMetrics)?.callId,
    toggleMemoryProvenance: () => memoryProvenanceUi.toggle(),
  });
  commandContext.isGenerating = () => orchestrator.isBusy;
  commandContext.restoreDraft = (text) => {
    if (input.prompt.length > 0 || text.length === 0) return;
    input.prompt = text;
    input.cursorPos = text.length;
    render();
  };
  commandContext.jumpToBookmark = jumpToBookmark;
  commandContext.scrollToLine = scrollToLine;
  commandContext.clearScreen = () => {
    compositor.resetDiff();
    allowTerminalWrite(() => stdout.write(CLEAR_SCREEN));
    render();
  };
  commandContext.requestFullRepaint = () => {
    compositor.resetDiff();
    render();
  };
  commandContext.beginConcealedInput = (req) => input.beginConcealedInput(req);
  permissionPromptRef.requestPermission = wrapRequestPermissionWithAlert(
    (request) => new Promise((resolve) => { localCards.offer({ request, resolve, queuedAt: Date.now() }); }),
    {
      focusTracker: ctx.services.focusTracker,
      configGet: (k: string) => readTuiConfigValue(configManager, k),
      webhookNotifier: ctx.services.webhookNotifier,
      terminalNotifier,
      conversation,
    },
  );

  const input: InputHandler = new InputHandler(
    () => render(),
    selection,
    () => transcript.top,
    getViewportHeight,
    () => conversation.history,
    scroll,
    exitApp,
    {
      agents: {
        agentManager,
        agentMessageBus: ctx.services.agentMessageBus,
        contractRunner: ctx.services.contractRunner,
      },
      providers: {
        benchmarkStore: ctx.services.benchmarkStore,
        favoritesStore: ctx.services.favoritesStore,
        providerRegistry: ctx.services.providerRegistry,
      },
      platform: {
        configManager: ctx.services.configManager,
        localUserAuthManager: ctx.services.localUserAuthManager,
        mcpRegistry: ctx.services.mcpRegistry,
        serviceRegistry: ctx.services.serviceRegistry,
        surfaceRegistry: ctx.services.surfaceRegistry,
        subscriptionManager: ctx.services.subscriptionManager,
        secretsManager: ctx.services.secretsManager,
        pairingTokens: ctx.services.pairingTokens,
        tokenAuditor: ctx.services.tokenAuditor,
        replayEngine: ctx.services.replayEngine,
        webhookNotifier: ctx.services.webhookNotifier,
        policyRuntimeState: ctx.services.policyRuntimeState,
        externalServices: uiServices.platform.externalServices,
        focusTracker: ctx.services.focusTracker,
      },
      shell: {
        bookmarkManager: ctx.services.bookmarkManager,
        keybindingsManager: ctx.services.keybindingsManager,
        processManager,
        profileManager: ctx.services.profileManager,
      },
      sessions: {
        sessionManager: ctx.services.sessionManager,
        sessionBroker: uiServices.sessions.sessionBroker,
        sessionOrchestration: ctx.services.sessionOrchestration,
        sessionMemoryStore: ctx.services.sessionMemoryStore,
      },
      environment: {
        workingDirectory: ctx.services.workingDirectory,
        homeDirectory: ctx.services.homeDirectory,
        shellPaths: ctx.services.shellPaths,
      },
    },
  );

  // Routine notifications wait in the history while the person types, when the print level allows it.
  // Typing means a key reached the composer within the last few seconds; a draft left sitting holds nothing.
  const TYPING_IDLE_MS = 3_000;
  let lastComposerKeyAt = 0;
  ctx.services.notificationDispatcher.setTypingProbe(() =>
    modeManager.getHITLPreset().quietWhileTyping
    && input.prompt.length > 0
    && Date.now() - lastComposerKeyAt < TYPING_IDLE_MS);
  orchestratorRefs.getViewportHeight = getViewportHeight;
  orchestratorRefs.scrollToEnd = scrollToEnd;
  const views = new SessionViews({
    contractRunner: ctx.services.contractRunner,
    contracts: sessionContractViews,
    conversation,
    agentManager,
    processManager,
    fleetNodes,
    steer: (id, text) => ctx.views.fleet.actions.steer(id, text),
    killAgent: (id) => ctx.views.fleet.actions.kill(id, { cascade: true }),
    mainBusy: () => orchestrator.isThinking || orchestrator.isTurnInFlight,
    mainModel: () => lastHeaderModel,
    promptText: () => input.prompt,
    requestRender: () => render(),
  });
  sessionViews = views;
  input.sessionView = views;
  // The `ui` event domain: panel open/close/focus and view changes, read from each painted frame.
  const uiEvents = createUiEventPublisher(uiServices.runtime.runtimeBus, () => runtime.sessionId);
  unsubs.push(() => views.dispose());
  // Esc while the main transcript is scrolled back returns to the live bottom and never interrupts the turn (handler-modal-stack.ts).
  input.transcriptScroll = { scrolledBack: () => transcript.scrolledBack && !views.active, toBottom: scrollToLiveBottom };
  commandContext.openSessionView = (target) => views.open(target);

  hostPairing = wireHostPairingShell({
    configManager,
    homeDirectory,
    input,
    commandRegistry,
    commandContext,
    conversation,
    canPresent: () => !lifecycle.isTerminalRestored() && pendingPermission === null && !views.active,
    render,
    scroll,
    toBottom: () => transcript.toBottom(),
  });
  unsubs.push(() => hostPairing?.dispose());
  input.setCommandRegistry(commandRegistry, commandContext);
  commandContext.openComposerEditor = makeComposerEditorOpener({
    buffer: input,
    stdin,
    terminal: lifecycle,
    repaint: () => {
      compositor.resetDiff();
      render();
    },
    setHeld: (held) => { externalEditorOpen = held; },
    cwd: workingDir,
    env: process.env,
    notify: (m) => systemMessageRouter.high(m),
  });
  commandContext.openFileInEditor = makeFileEditorOpener({
    stdin,
    terminal: lifecycle,
    repaint: () => {
      compositor.resetDiff();
      render();
    },
    setHeld: (held) => { externalEditorOpen = held; },
    cwd: workingDir,
    env: process.env,
    notify: (m) => systemMessageRouter.high(m),
  });
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => render());
  // retirement: agentDetailModal/processModal setOnRefresh wiring removed,
  // those modals were deleted (Fleet subsumes the live process tree via F2).

  // Model picker callback is handled in bootstrap.ts, do not duplicate here.
  input.setHistory(inputHistory);
  // ONE microphone path, shared by push-to-talk voice input (Alt+V) and wake-word detection; opens no device by itself (shell/voice-capture-shell.ts).
  voiceCaptureStatus = installVoiceCapture({
    configManager,
    shellPaths: ctx.services.shellPaths,
    homeDirectory,
    sessionId: ctx.runtime.sessionId,
    commandContext,
    unsubs,
    buffer: input,
    // Speech is sent as said; only typed composer text has a grammar.
    submitInput: submission.submitSpeech,
    notify: (m) => {
      systemMessageRouter.high(m);
      render();
    },
    render: () => render(),
  });

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    model: runtime.model,
    provider: runtime.provider,
    toolCount,
    lastSessionId: readLastSessionPointer({ surface: ctx.services.surface }) ?? undefined,
    // The palette key as bound (the person's keybindings.json included), for the splash hint.
    commandPaletteKey: ctx.services.keybindingsManager.getComboLabel('command-palette'),
  };

  const renderFrame = () => {
    hostPairing?.checkPresentation();
    uiEvents.observe(readUiFrame(input, views.focus.current));
    const width = stdout.columns || 80;
    const height = stdout.rows || 24;

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();
    // Resolve the context window once, so the footer meter, the status hint and
    // the context inspector agree. Only a window some source states is shown:
    // null means unknown (a guess, or disproven by a larger accepted request),
    // and every consumer below reads 0 as "no window to measure against".
    const knownContextWindow = providerRegistry.getKnownContextWindowForModel(currentModel);
    const contextWindow = knownContextWindow ?? 0;
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const agentSnapshot = uiServices.readModels.agents.getSnapshot();

    const activeModel = resolveActiveModelDisplay({
      serving: currentModel,
      configuredRegistryKey: configManager.get('provider.model') as string,
      configuredLabel: runtime.model,
      configuredProvider: runtime.provider,
      // The engine's failover in force for this turn, so the header and footer name the model that answers.
      failover: orchestrator.turnFailoverInForce(),
    });
    lastHeaderModel = activeModel.headerModel;
    const viewFrame = views.frame(width); // an agent or process open full screen, or null in main
    const headerLines = viewFrame
      ? [viewFrame.header]
      : UIFactory.createHeader(
          width,
          activeModel.headerModel,
          conversation.title || undefined,
          lastGitInfoRef.value,
          undefined,
          activeModel.divergenceNote,
        );
    const chipsRow = views.chips(width);
    if (chipsRow) headerLines.push(chipsRow);
    // Scrolled away from the live bottom: the back-to-bottom pill, with the esc keycap only while the next Esc goes there.
    const promptEmpty = input.prompt.length === 0 && !input.commandMode;
    const backToBottom = viewFrame
      ? views.scrolledBack()
        ? { escKey: views.escGoesToBottom() }
        : null
      : transcript.scrolledBack && !conversation.isSplashShowing()
        ? { escKey: promptEmpty && !conversation.workTree.focused && !input.indicatorFocused }
        : null;
    const managerAgents = agentManager.list().filter((a) => a.status === 'running' || a.status === 'pending');
    const runtimeAgents = agentSnapshot.active;
    const sessionContracts = sessionContractViews.read();
    void herdrSession.update({
      sessionId: runtime.sessionId,
      sessionPath: join(ctx.services.surface.sessionsDir, `${sanitizeSessionName(runtime.sessionId)}.jsonl`),
      busy:
        orchestrator.isBusy ||
        hookDispatcher.activeInvocationCount > 0 ||
        sessionContracts.some((contract) => contractIsWorking(contract.status)) ||
        currentFleet.some(
          (node) =>
            node.kind === 'agent' &&
            node.sessionRef?.sessionId === runtime.sessionId &&
            ['thinking', 'executing-tool', 'streaming', 'stalled', 'retrying', 'queued'].includes(node.state),
        ),
      waitingForOwner:
        pendingPermission !== null ||
        input.waitingForOwner ||
        hostPairing?.waitingForOwner === true ||
        currentFleet.some(
          (node) => node.kind === 'agent' && node.sessionRef?.sessionId === runtime.sessionId && node.state === 'awaiting-approval',
        ) ||
        sessionContracts.some(
          (contract) =>
            contract.status === 'awaiting-owner' ||
            contract.groups.some((group) => group.status === 'awaiting-owner') ||
            contract.units.some((unit) => unit.status === 'awaiting-owner'),
        ),
      resumeArgv: ['goodvibes', '--working-dir', workingDir, '--resume', runtime.sessionId],
    });
    const runningAgentSummary = summarizeRunningAgents(managerAgents, runtimeAgents, sessionContracts);
    const runningAgentCount = runningAgentSummary.count;
    const { runningProcessCount, cw, promptInfo, commandArgsHint } = readShellFrameFacts(
      processManager,
      input,
      getPromptContentWidth,
      (prompt) => buildCommandArgsHint(prompt, commandRegistry),
    );
    const composerState = deriveComposerState({
      text: input.prompt,
      commandMode: input.commandMode,
      pendingApproval: pendingPermission !== null,
      hasAttachments: input.getImageAttachments().size > 0,
      turnState: sessionSnapshot.turnState,
    });
    const contextStatusHint = resolveContextStatusHint({
      evaluate: (args) =>
        evaluateSessionMaintenance({ configManager, ...args, sessionMemoryCount: ctx.services.sessionMemoryStore.list().length }),
      currentTokens: orchestrator.lastInputTokens,
      contextWindow,
    });
    // Main's turn, contracts and agents share the activity row above the input.
    const compacting = ctx.services.contextAccountingHolder.getSource()?.getCompactionState().isCompacting === true;
    if (compacting && compactingSinceMs === undefined) compactingSinceMs = Date.now();
    else if (!compacting) compactingSinceMs = undefined;
    const throbberNow = Date.now();
    const runningTool = oldestRunningTool(streamMetrics);
    // An ask brokered for a background agent carries an attribution; only main's own ask is main's activity.
    const mainApproval = pendingPermission && pendingPermission.attribution === undefined ? pendingPermission : null;
    const turnActive = orchestrator.isThinking || orchestrator.isTurnInFlight;
    const throbberActivity = resolveThrobberActivity({
      turnActive,
      modelActive: streamMetrics.modelActive,
      completionActivity: orchestrator.completionActivity,
      runningAgentCount,
      contracts: sessionContracts,
      compacting,
      compactingSinceMs,
      pendingApproval: mainApproval ? { name: mainApproval.tool, args: mainApproval.args } : null,
      ownerChoice: trustPromptRef.awaitingOwner === true ? 'Choose a trust level for this workspace' : null,
      activeTool:
        runningTool !== undefined
          ? {
              name: runningTool.name,
              args: streamMetrics.toolArgsByCallId.get(runningTool.callId),
              startedAtMs: runningTool.startedAtMs,
              alsoRunning: streamMetrics.runningTools.size - 1,
            }
          : null,
      modelPhrase: UIFactory.busyPhrase(
        orchestrator.thinkingFrame,
        orchestrator.streamingOutputTokens,
        UIFactory.computeRenderStallInfo(streamMetrics, throbberNow),
        mainApproval !== null,
      ),
      turnStartMs: streamMetrics.startTime,
      ttftMs: streamMetrics.ttftMs,
      tokenSpeed: (configManager.get('display.showTokenSpeed') as boolean) ? streamMetrics.tokenSpeed : undefined,
      now: throbberNow,
    });
    activityAnimation.setActive(throbberActivity !== null && !orchestrator.isThinking);
    const activityFrame = orchestrator.isThinking ? orchestrator.thinkingFrame : activityAnimation.frame;
    const throbber = throbberActivity
      ? { spinner: SPINNER_FRAMES[activityFrame % SPINNER_FRAMES.length]!, frame: activityFrame, activity: throbberActivity }
      : null;
    const footerLines = buildShellFooter({
      width,
      promptText: promptInfo.visibleLines.join('\n'),
      promptLineCount: promptInfo.visibleLines.length,
      promptCursorPos: promptCursorOffset(promptInfo),
      usage: {
        available: isConversationUsageAvailable(orchestrator.usage),
        up: orchestrator.usage.input,
        down: orchestrator.usage.output,
        cacheRead: orchestrator.usage.cacheRead,
        cacheWrite: orchestrator.usage.cacheWrite,
        // The cost as spent, each response at its own model's price: a model switch does not reprice it.
        costUsd: orchestrator.usage.costUsd,
        fleetCostUsd: footerFleetCost(fleetNodes, runningAgentCount > 0),
      },
      showExitNotice: input.showExitNotice,
      lastCopyTime: input.lastCopyTime,
      model: activeModel.footerModel, // prices the cost
      // The model's display name; while serving differs from the selection, the serving id (the header says why).
      modelLabel: activeModel.diverged ? activeModel.headerModel : currentModel.displayName || activeModel.headerModel,
      view: viewFrame?.footer ?? null,
      // '?' is the git read's "no repository here (or no answer yet)": no branch segment.
      branch: lastGitInfoRef.value && lastGitInfoRef.value.branch !== '?' ? lastGitInfoRef.value.branch : undefined,
      branchChanged: lastGitInfoRef.value?.dirty === true,
      modeWords: modeWords.current(),
      modeKey: keycapLabel(ctx.services.keybindingsManager.getComboLabel('cycle-permission-mode')),
      modeFlash: getSharedModeFlash().active(),
      unreadNotices: getSharedNotificationFeed().unreadCount(),
      noticesKey: keycapLabel(ctx.services.keybindingsManager.getComboLabel('open-notifications')),
      contextWindow: knownContextWindow,
      contextStatusHint,
      submissionStatus,
      retryHint: actionHint(actionOffers),
      contractQuestionHint: contractQuestions.hint(),
      scriptableStatusLine: scriptableStatusline.current(),
      // behavior.autoCompactThreshold is stored as a percent integer (e.g. 80);
      // the bar expects a fraction [0..1]. Clamp to [0,1] to guard nonsense values.
      compactThreshold: Math.min(1, Math.max(0, (configManager.get('behavior.autoCompactThreshold') as number) / 100)),
      dangerMode: isEffectiveDangerMode(configManager),
      lastInputTokens: orchestrator.lastInputTokens,
      contextUsageAvailable: isConversationContextAvailable(orchestrator),
      commandArgsHint,
      runningAgentCount,
      runningProcessCount,
      // Always-visible "sleep disabled" chip, topology-aware: the DAEMON's state in adopted-external mode, the in-process manager otherwise (power-chip-source.ts).
      powerKeepAwake: keepAwakeHolding(powerChipSource.get()),
      // Composer must not read as focused while the process indicator owns keyboard focus.
      promptFocused: !input.indicatorFocused && !conversation.workTree.focused && viewFrame?.footer.disabledReason === undefined,
      workTreeFocused: conversation.workTree.focused && !viewFrame,
      indicatorFocused: input.indicatorFocused,
      runningAgentProgress: runningAgentSummary.progress,
      composerFlags: composerState.flags,
      composerPendingRisk: composerState.pendingRisk,
      // The mode in force: jev-decides shows as ask-me while no decision model works (decision-model-readiness.ts).
      permissionMode: describePermissionModeInForce(configManager).mode,
      voiceCapture: voiceCaptureStatus(),
      throbber,
      turnRunning: turnActive,
      backToBottom,
    }).lines;

    const onboardingOwnsScreen = input.onboardingWizard.active;
    // The main screen keeps one empty row under the header; a view's body starts with its own.
    const shellHeaderLines = onboardingOwnsScreen ? [] : viewFrame ? headerLines : withHeaderGap(headerLines, width);
    input.bodyTopRow = shellHeaderLines.length; // mouse rows map to transcript rows from here
    const shellFooterLines = onboardingOwnsScreen ? [] : footerLines;
    input.footerTargets = footerTargetRows(shellFooterLines, height - shellFooterLines.length); // clickable usage rows open Usage
    const shellLayout = createShellLayout({
      width,
      height,
      headerHeight: shellHeaderLines.length,
      footerHeight: shellFooterLines.length,
    });
    const vHeight = shellLayout.body.height;
    const conversationWidth = shellLayout.conversation.width;
    activeConversationWidth = conversationWidth;

    // Flush pending renders after updating the width provider and splash posture
    // so the transcript and splash rebuild against the current shell layout.
    if (!viewFrame) {
      workTreeWiring.syncSession(); // a recovered or resumed session's folds come back with it
      conversation.workTree.tickLive(); // animate only the visible transcript
      conversation.getDisplayBlocks();
    }
    if (conversation.consumeSplashTransition()) compositor.requestFullRepaint(); // splash → transcript: repaint the whole viewport once

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue, file picker)
    let overlayRows = 0;
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages
    // File picker and model picker overlay rows computed from actual rendered line count below
    // Selection modal overlay rows are computed from actual rendered line count below
    // The find bar and the reverse history search line each take a row under the transcript.
    if (input.searchManager.active || input.historySearch.active) {
      overlayRows += 1;
    }

    const conversationViewport = viewFrame
      ? null
      : buildConversationViewport({
          conversation,
          width: conversationWidth,
          viewportHeight: vHeight,
          scrollTop: transcript.top,
          scrollLocked: transcript.locked,
          overlayRows,
        });
    // Unlocked but already at the bottom (a jump that landed there, output that
    // shrank) is the live bottom: it follows again, and the pill drawn this frame goes.
    if (
      conversationViewport &&
      transcript.settle(conversationViewport.nextScrollTop, conversationViewport.maxScroll) &&
      backToBottom &&
      !viewFrame
    )
      render();
    const scrollTop = transcript.top;
    let viewport = viewFrame
      ? viewFrame.body(vHeight)
      : conversation.isSplashShowing()
        ? drawSplashAdditions(centerViewportContent(conversationViewport!.viewport, conversationViewport!.effectiveHeight, conversationWidth), conversationViewport!.effectiveHeight, conversationWidth, { modeKey: keycapLabel(ctx.services.keybindingsManager.getComboLabel('cycle-permission-mode')) })
        : conversationViewport!.viewport;

    if (orchestrator.isThinking && !viewFrame) {
      // The spinner and phrase are the throbber's (above the input area); the
      // opt-in partial tool preview keeps its own faint row under the transcript.
      const partialToolPreview = (configManager.get('display.showToolPreview') as boolean) ? sessionSnapshot.streamToolPreview : undefined;
      if (partialToolPreview) viewport.push(UIFactory.createToolPreviewRow(conversationWidth, partialToolPreview));
    }

    if (!viewFrame)
      viewport.push(
        ...UIFactory.createQueuedMessageList(conversationWidth, orchestrator.listQueuedMessages()),
        ...memoryProvenanceUi.renderChip(conversationWidth, configManager),
      );

    const overlayContext = { input, conversation, commandRegistry, keybindingsManager: ctx.services.keybindingsManager, contextWindow };
    viewport = applyConversationOverlays(viewport, { ...overlayContext, conversationWidth, viewportHeight: vHeight });

    const layers = buildConversationLayers({
      ...overlayContext,
      providerInputTokens: orchestrator.lastInputTokens,
      screenWidth: width,
      screenHeight: height,
      headerRows: shellHeaderLines.length,
      footerRows: shellFooterLines.length,
      permission: pendingPermission
        ? PermissionPromptUI.renderPromptModal(width, height, pendingPermission, pendingPermission, approvalBroker, input.prompt.length === 0)
        : null,
    });
    input.surfacePointer.layers = layers;
    compositor.composite({
      width,
      height,
      header: shellHeaderLines,
      viewport,
      footer: shellFooterLines,
      selection:
        onboardingOwnsScreen || viewFrame
          ? undefined
          : {
              isCellSelected: (col, row) => selection.isCellSelected(col, row),
              scrollTop,
              lineCount: conversation.history.getLineCount(),
            },
      search:
        !onboardingOwnsScreen && !viewFrame && input.searchManager.active
          ? {
              manager: input.searchManager,
              scrollTop,
              viewportStartY: shellHeaderLines.length,
            }
          : undefined,
      layers,
    });
    typeahead.framePainted(); // a startup modal counts as seen from its first painted frame
  };
  let renderRequested = false;
  const renderNow = () => {
    renderRequested = false;
    renderFrame();
  };
  // Yield to input and daemon I/O between coalesced frames during agent fan-out.
  const renderScheduler = createRenderScheduler(
    renderNow,
    (flush) => {
      setTimeout(flush, 16);
    },
    () => lifecycle.isTerminalRestored() || externalEditorOpen,
  ); // coalescer; no frames after terminal restore or while an external editor owns the screen
  deferredRender.set(() => {
    renderRequested = true;
    renderScheduler.schedule();
  });
  unsubs.push(announceSettingsIngestionNotices(configManager, (line, level) => {
    if (!lifecycle.isTerminalRestored()) systemMessageRouter.high(line, level);
  }));
  const terminalOutputGuard = installFullScreenTerminalOutputGuard({
    stdout,
    stderr: process.stderr,
    onCapture: (total) => {
      commandContext.session.runtime.terminalWritesIntercepted = total;
      render();
    },
  });

  setRenderRequest(() => renderScheduler.flushNow()); // bootstrap's 16ms coalescer composites via the (restore-gated) scheduler
  orchestratorRefs.requestRender = render;
  commandContext.renderRequest = render;
  // /status: what the footer rows used to show, from the same sources (shell/status-report.ts).
  commandContext.describeStatus = () => {
    const serving = providerRegistry.getCurrentModel();
    const active = resolveActiveModelDisplay({
      serving,
      configuredRegistryKey: configManager.get('provider.model') as string,
      configuredLabel: runtime.model,
      configuredProvider: runtime.provider,
      // The engine's failover in force for this turn, so the header and footer name the model that answers.
      failover: orchestrator.turnFailoverInForce(),
    });
    const spine = uiServices.platform.externalServices?.inspect();
    const voice = voiceCaptureStatus();
    const git = lastGitInfoRef.value;
    return formatStatusReport({
      workingDirectory: workingDir,
      branch: git?.branch,
      dirty: git?.dirty,
      model: active.footerModel,
      provider: active.footerProvider,
      modelNote: active.divergenceNote,
      // The mode in force: jev-decides shows as ask-me while no decision model works (decision-model-readiness.ts).
      permissionMode: describePermissionModeInForce(configManager).mode,
      toolCount: toolRegistry.list().length,
      notifyMode: modeManager.getHITLMode(),
      usage: orchestrator.usage,
      contextUsageAvailable: isConversationContextAvailable(orchestrator),
      cost: statusCostText(
        {
          available: isConversationUsageAvailable(orchestrator.usage),
          up: orchestrator.usage.input,
          down: orchestrator.usage.output,
          cacheRead: orchestrator.usage.cacheRead,
          cacheWrite: orchestrator.usage.cacheWrite,
          costUsd: orchestrator.usage.costUsd,
          fleetCostUsd: footerFleetCost(() => ctx.services.processRegistry.query().nodes, true),
        },
        active.footerModel,
      ),
      contextTokens: orchestrator.lastInputTokens,
      contextWindow: providerRegistry.getKnownContextWindowForModel(serving) ?? 0,
      contextWindowSource: describeContextWindowSource(serving),
      compactFraction: Math.min(1, Math.max(0, (configManager.get('behavior.autoCompactThreshold') as number) / 100)),
      sessionSpine:
        spine?.sessionSpineActive && spine.sessionSpineStatus && spine.sessionSpineStatus !== 'unknown'
          ? spine.sessionSpineStatus
          : undefined,
      sessionSpineRefusal: spine?.sessionSpineActive ? spine.sessionSpineRefusal ?? undefined : undefined,
      webSurfaceUrl: resolveWebSurfaceUrl(configManager),
      autoApprove: isEffectiveDangerMode(configManager),
      keepAwake: powerChipSource.get().keepAwake,
      keepAwakeRefused: !keepAwakeHolding(powerChipSource.get()) && powerChipSource.get().keepAwake,
      microphone: voice && voiceCaptureRowVisible(voice) ? voiceCaptureDescription(voice) : null,
      runningAgents: agentManager.list().filter((a) => a.status === 'running' || a.status === 'pending').length,
      runningProcesses: processManager.runningCount(),
      worktrees: worktreeStatusLines(ctx.services.worktreeRegistry.lastStartupReport(), workingDir),
    });
  };
  wireShellUiOpeners({
    commandContext,
    input,
    views: ctx.views,
    viewPanelAdapter: ctx.services.panelManager,
    configManager,
    providerRegistry,
    runtime,
    featureFlags: ctx.featureFlags,
    mcpRegistry: ctx.services.mcpRegistry,
    subscriptionManager,
    secretsManager,
    daemonCredentials: ctx.services.daemonCredentials, // a daemon-scoped credential is stored by the daemon, in one verified step
    daemonConfig: ctx.services.daemonConfig, // a daemon-owned setting is written where the daemon reads it
    serviceRegistry: ctx.services.serviceRegistry,
    memoryEmbeddingRegistry: ctx.services.memoryEmbeddingRegistry,
    workingDirectory: workingDir,
    homeDirectory,
    getConfiguredProviderIds: ctx._getConfiguredProviderIds,
    getPinned: ctx._getPinned,
    render,
    trustPromptRef,
  });

  // One owner of the user turn and its failover retries, read by the turn-end
  // notices and the failover path alike (core/user-turn.ts).
  const userTurn = createUserTurnOwner({ turns: uiServices.events.turns, sessionId: () => runtime.sessionId });
  unsubs.push(() => userTurn.dispose());
  const {
    refreshGit,
    unsubs: turnUnsubs,
  } = wireTurnEventHandlers({
    userTurn,
    events: uiServices.events,
    conversation,
    runtime,
    orchestrator,
    configManager: {
      get: (key) => readTuiConfigValue(configManager, key),
      subscribe: (key, callback) => subscribeTuiConfigValue(configManager, key, callback),
    },
    providerRegistry,
    systemMessageRouter,
    hookDispatcher,
    surface: ctx.services.surface,
    gitStatusProvider,
    lastGitInfoRef,
    buildSessionContinuityHints,
    render,
    webhookNotifier: ctx.services.webhookNotifier,
    focusTracker: ctx.services.focusTracker,
    terminalNotifier,
    runtimeBus: uiServices.runtime.runtimeBus,
  });
  unsubs.push(...turnUnsubs);

  unsubs.push(uiServices.events.turns.on('TURN_COMPLETED', (evt) => memoryProvenanceUi.onTurnCompleted(evt)));
  // A new guidance occurrence reaches the notification history without /guidance.
  unsubs.push(wireGuidanceNotices(
    commandContext,
    uiServices.events.turns,
    (notification) => { ctx.services.notificationDispatcher.dispatch(notification); },
    () => orchestrator.lastInputTokens,
  ));

  /**
   * Send the failed turn's own prompt again (Alt+R). The orchestrator keeps
   * that turn's input and the message count before it. When no later turn has
   * run, the conversation is rolled back to before the failed prompt; when one
   * has (a prompt queued behind it), nothing is rolled back and the prompt is
   * sent as a new turn, so the later turn is neither erased nor sent twice.
   * A provider failure inside a turn is not retried here: the engine's turn
   * loop already moved it along the fallback order (providers/failover.ts).
   */
  const resubmitLastTurn = (): boolean => {
    const failed = orchestrator.failedTurnInput();
    if (!failed) return false; // nothing failed to send again; the caller narrates instead
    const { text, content: rContent, options: rOpts } = failed;
    if (rOpts?.nativeConversationTurnPermit && !orchestrator.canRetryNativeConversationTurn(rOpts.nativeConversationTurnPermit)) {
      systemMessageRouter.high(
        'Native turn recovery is required before another model attempt. Its transcript and original source were retained.',
        'warning',
      );
      render();
      return false;
    }
    // A turn that already ran tools is not replayed from its prompt: its tool
    // results stay, so their effects are not repeated, and the turn continues
    // from them (the rule the in-turn failover applies before any tool ran).
    const ranTools = !failed.superseded && turnRanTools(conversation, failed.rollbackCount);
    const sessionId = runtime.sessionId;
    // The failed turn stays held (its transcript and this retry) until the
    // replacement is submitted: a memory refresh that fails, a session switch or
    // a newer turn while it prepares leaves it as it was, to try again.
    void runOwnedTurnRetry({
      prepare: () => refreshMemoryRecallSnapshot(ctx.services),
      isCurrent: () => runtime.sessionId === sessionId && orchestrator.failedTurnInput()?.turnId === failed.turnId,
      submit: () => {
        orchestrator.clearFailedTurnInput(failed.turnId);
        if (ranTools) {
          conversation.removeMessagesAfter(failed.rollbackCount, { preserveCompletedTools: true });
          systemMessageRouter.high('[Retry] The failed turn had already run tools, so it continues from their results instead of starting over.', 'info');
          return orchestrator.handleUserInput(CONTINUE_AFTER_TOOLS, undefined, rOpts);
        }
        if (!failed.superseded) conversation.removeMessagesAfter(failed.rollbackCount);
        return orchestrator.handleUserInput(text, rContent, rOpts);
      },
    }).then((submitted) => {
      if (!submitted) { systemMessageRouter.high('[Retry] Not sent: the session or the failed turn changed while it was being prepared. Alt+R sends it again.', 'warning'); render(); }
    }, (e: unknown) => {
      logger.debug('retryTurn', { error: summarizeError(e) });
      // Before submission nothing was taken away; the retry is still offered.
      if (orchestrator.failedTurnInput()?.turnId === failed.turnId) {
        systemMessageRouter.high(`[Retry] Not sent: ${summarizeError(e)}. The failed turn is kept; Alt+R tries again.`, 'warning');
        render();
      }
    });
    return true;
  };
  const streamResult: WireStreamEventMetricsResult = wireStreamEventMetrics({
    events: uiServices.events,
    orchestrator,
    providerRegistry,
    systemMessageRouter,
    render,
    metrics: streamMetrics,
    getSessionId: () => runtime.sessionId,
    isActive: () => !lifecycle.isTerminalRestored(),
    userTurn,
    providerOptimizer: ctx.services.providerOptimizer,
    // The engine's failover moves get their billing line (providers/failover.ts decides the move).
    observeTurnFailover: (listener) => orchestrator.onTurnFailover(listener),
    isApprovalPending: () => pendingPermission !== null,
  });
  unsubs.push(...streamResult.unsubs);
  // Offer Alt+R when a user-visible error surfaces and the turn can be sent again.
  wireRetryOfferOnError(streamResult.onErrorSurfaced, actionOffers, () => orchestrator.failedTurnInput() !== null, render, () => {
    const failed = orchestrator.failedTurnInput();
    return failed !== null && !failed.superseded && turnRanTools(conversation, failed.rollbackCount);
  });
  // Companion messages and an activated plan take the composer's turn path as sent
  // (no composer grammar), carrying their origin. Bound once that path's state exists.
  unsubs.push(bindOwnerInput(orchestrator, (text, inputOptions) => {
    transcript.toBottom();
    conversation.dismissSplash();
    sendOwnerTurn(text, undefined, inputOptions);
  }));

  // Crash/termination handlers register BEFORE raw mode so a throw during setup or the initial
  // render still restores the terminal; 'exit' is the final safety net.
  installTerminalExitGuards(lifecycle, { onExit: exitListener }).startTerminalSession({
    registerFaults: () => {
      process.on('uncaughtException', uncaughtExceptionHandler);
      process.on('SIGTERM', terminationSignalHandler);
      process.on('SIGHUP', terminationSignalHandler);
    },
    enableRawMode: () => stdin.setRawMode(true),
    prepareInput: () => {
      stdin.resume();
      stdin.setEncoding('utf8');
    },
    enter: () => lifecycle.enterTerminal(),
  });
  // forced dark/light applies before first paint; auto (TTY only) repaints once if the OSC 11 probe says light. probePalette adds OSC 10 + OSC 4;0..15
  // and retries until the terminal answers (the shared terminal-palette reader); the `system` theme re-themes when it arrives. filterInput strips replies from stdin.
  registerThemeRefresh(() => conversation.clearLineCache()); // theme/mode change: cached transcript lines re-render in the new colours
  const themeProbe = installBackgroundThemeProbe({
    configManager,
    isTTY: Boolean(stdout.isTTY),
    writeQuery: (b) => allowTerminalWrite(() => stdout.write(b)),
    requestRepaint: () => {
      compositor.resetDiff();
      render();
    },
    probePalette: true,
    forwardInput: (b) => routeInput(b),
    subscribeResize: (l) => {
      stdout.on('resize', l);
    },
  });

  const typeaheadHooks = {
    onModalShown: () => typeahead.arm(),
    onFlowSettled: () => {
      const held = typeahead.release();
      if (held.length > 0) routeInput(held);
    },
  };
  // The crash-recovery offer: at start-up for the newest snapshot (below), and
  // whenever a session is opened (--continue, --resume, /load, /sessions, the
  // picker, /session resume) with a crash snapshot newer than its saved copy.
  const recoveryOffer = buildRecoveryOfferWiring({
    surface: ctx.services.surface,
    sessionManager: ctx.services.sessionManager,
    runtime,
    conversation,
    commandContext,
    writeLastSessionPointer,
    sessionSpine: ctx._sessionSpine,
    project: workingDir,
    receipt: (line) => systemMessageRouter.userReceipt(line),
    render,
    typeahead: typeaheadHooks,
  });
  unsubs.push(whenCrashSnapshotFound(conversation, offerCrashSnapshotOnOpen(recoveryOffer)));
  applyInitialTuiCliState({
    cli,
    input,
    commandRegistry,
    commandContext,
    shellPaths: ctx.services.shellPaths,
    surface: ctx.services.surface,
    render,
  });

  const dispatchInput = (data: string): void => {
    if (hostPairing?.ownsInput) {
      if (pendingPermission) hostPairing.cancelForTakeover();
      input.feed(data);
      return;
    }
    const blocking = handleBlockingShellInput({
      data,
      pendingPermission,
      render,
      abortTurn: () => orchestrator.abort(),
      // A card that opens over a draft leaves the keys with the composer until Tab.
      composerEmpty: input.prompt.length === 0,
    });
    pendingPermission = blocking.pendingPermission;
    localCards.next();
    if (blocking.handled) {
      return;
    }
    // Alt+X sends the next message as an ordinary one instead of the answer to a contract's question.
    if (contractQuestions.handleChord(data)) {
      render();
      return;
    }
    // Alt+R retries a failed turn, Alt+J opens a started fix session; plain
    // letters always go to the composer or the open view.
    if (handleShellActionChord(data, actionOffers, {
      retry: () => {
        if (!resubmitLastTurn()) systemMessageRouter.high('[Retry] Nothing to send again: the failed prompt was already sent again, or a prompt sent after it has completed.');
      },
      openSession: (sessionId) => { void runPickedCommand(commandContext.executeCommand, 'session', ['resume', sessionId], (message) => commandContext.print(message)).finally(render); },
      render,
    })) return;

    lastComposerKeyAt = Date.now();
    input.feed(data);
  };
  const routeInput = (data: string): void => {
    dispatchInput(data);
    // InputHandler batches the tokens in a stdin chunk. Paint its final state
    // before unrelated background work runs; only streaming waits for a frame.
    if (renderRequested) renderScheduler.flushNow();
  };
  stdin.on('data', (raw: string) => {
    const data = typeahead.filter(themeProbe.filterInput(raw));
    if (data.length > 0) routeInput(data);
  });
  stdin.on('end', () => {
    hostPairing?.dispose();
    void exitApp();
  });
  stdin.on('close', () => {
    hostPairing?.dispose();
    void exitApp();
  });
  process.on('SIGINT', sigintHandler);
  process.on('unhandledRejection', unhandledRejectionHandler);
  stdout.on('resize', resizeHandler);

  // State restores happen ONLY when the user explicitly asks, a CLI flag
  // (--continue/--resume/--fork), a slash command (/session resume,
  // /checkpoints, /rewind), or the startup recovery offer's modal. There is
  // deliberately no unconditional auto-restore here: a bare launch never
  // loads a saved conversation on its own (owner ruling).

  // Crash-recovery snapshot: asked, never assumed, and opened before the first frame so the composer is never live under it;
  // keys typed before it was painted are held and replayed into the composer once it is answered (startup-typeahead-gate.ts).
  void startRecoveryOffer(recoveryOffer);
  conversation.rebuildHistory();
  render(); // initial render

  // Snapshot for changes made outside a turn every 60s, and the session lock
  // taken at once (no refresh), see runtime/recovery-autosave.ts.
  recoveryInterval = startRecoveryAutosave({ conversation, runtime, surface: ctx.services.surface, buildSessionContinuityHints });
}

/** Runs the terminal UI for a command line that `prepareShellCliRuntime` left to it. */
export function runInteractive(prepared: PreparedShellCliRuntime): Promise<void> {
  return main(prepared).catch(async (error: unknown) => {
    await releaseFailedStartupSession?.();
    reportFatalStartupError(error);
  });
}
