#!/usr/bin/env bun
import { announceSettingsIngestionNotices } from '@goodvibes-jev/engine/terminal-shell/cli-config-overrides';
import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { isNativeConversationTurnReady, nativeConversationTurnInputOptions } from '@goodvibes-jev/engine/terminal-shell/native-ingress';
import { readShellFrameFacts, createShellSubmissionPorts, createUiEventPublisher, readUiFrame } from '@goodvibes-jev/engine/terminal-shell/shell-frame-facts';
import { readInitialExecutionMode } from './permissions/execution-mode.ts';
import { isConversationUsageAvailable, isConversationContextAvailable } from './core/conversation-usage.ts';
import { publishToSharedFeed } from './core/notices.ts';
import type { NativeConversationIntakeState } from './runtime/native-conversation-intake.ts';
import type { NativeConversationInput } from '@goodvibes-jev/engine/terminal-shell/native';
import { formatRefusal, refusal } from '@goodvibes-jev/engine/errors';
import { dispatchNativeConversationTurn, describeFailedNativeDispatch } from './runtime/native-conversation-ingress.ts';
import { createOwnerTurnSender } from './shell/owner-turn-sender.ts';
import { createNativeWorkLedgerView } from './runtime/native-work-ledger-host.ts';
import { createAgentNativeHostSelection } from './runtime/agent-native-host-selection.ts';
import { SetupPairingController } from './shell/setup-pairing-controller.ts';
import { parseSlashCommand } from './input/slash-command-parser.ts';
import { runExitSequence } from './shell/exit-sequence.ts';
import { buildAgentHerdrSessionUpdate } from './shell/herdr-session.ts';
import './renderer/compositor.ts';
import { installStartupThemeProbe } from './renderer/startup-theme-probe.ts';
import { ThinkingStallClock, buildThinkingOverlay, createThrobberSource, mainPermissionAsk } from './core/thinking-overlay.ts';
import { UIFactory } from './renderer/ui-factory.ts';
import '@goodvibes-jev/engine/platform/platform/core';
import { conversationMessagesAsSessionRecords } from './core/conversation-message-snapshot.ts';
import { createTranscriptNavigators } from './shell/transcript-navigation.ts';
import { InputHandler } from './input/handler.ts';
import { applyConfiguredHitlMode, createHerdrSessionReporter } from '@goodvibes-jev/engine/terminal-shell';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import '@goodvibes-jev/engine/platform/platform/tools';
import '@goodvibes-jev/engine/platform/platform/tools';
import '@goodvibes-jev/engine/platform/platform/state';
import '@goodvibes-jev/engine/platform/platform/permissions';
import { PermissionPromptUI } from './permissions/prompt.ts';
import './input/command-registry.ts';

import './input/commands.ts';
import '@goodvibes-jev/engine/platform/platform/tools';
import './input/input-history.ts';
import { ShellContextHold, ShellPassthrough } from './input/shell-passthrough.ts';
import { buildShellFooter, estimateShellFooterHeight } from './renderer/shell-surface.ts';
import { HEADER_GAP_ROWS, withHeaderGap } from './renderer/header-line.ts';
import { TranscriptScroll, mainBackToBottom, transcriptEscape } from './shell/transcript-scroll.ts';
import { buildConversationViewport, centerViewportContent } from './renderer/conversation-layout.ts';
import { applyConversationOverlays, buildConversationLayers } from './renderer/conversation-overlays.ts';
import { WorkBoardModal } from '@goodvibes-jev/engine/terminal-shell/work-board-input';
import { createVerbSpawnGateway, FleetSpawn } from '@goodvibes-jev/engine/terminal-shell/fleet-spawn';
import { confirmThrough } from './input/confirm-dialog.ts';
import { envFlag, logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { emitAgentAwaitingMessage, emitAgentAwaitingTool } from '@goodvibes-jev/engine/platform/platform/runtime/emitters';
import { bootstrapRuntime } from './runtime/bootstrap.ts';
import { readAgentHostSetting } from './config/host-settings.ts';
import type { BootstrapContext } from './runtime/bootstrap.ts';
import { startFirstRenderFollowups, type DaemonRepairPrompt } from './shell/first-render-followups.ts';
import './tools/agent-harness-model-routing.ts';
import './tools/agent-harness-setup-model-helpers.ts';
import { deleteRecoveryFile, removeRecoveryPoint } from '@/runtime/index.ts';
import type { SessionSnapshot } from '@/runtime/index.ts';
import { buildAgentRecoveryApply } from './shell/recovery-apply.ts';
import { announceRecoveryOffer } from './shell/startup-wiring.ts';
import { whenCrashSnapshotFound } from '@goodvibes-jev/engine/terminal-shell/session-crash-recovery';
import { handleBlockingShellInput, type PendingPermissionState } from './shell/blocking-input.ts';
import { cardAwaitsTab } from '@goodvibes-jev/engine/terminal-shell/blocking-permission-input';
import { createWorkspaceRegistrationQuestion } from './shell/workspace-registration-question.ts';
import { createDaemonRepairQuestion } from './shell/daemon-repair-prompt.ts';
import { getTerminalSize } from './shell/terminal-size.ts';
import { buildShellSessionContinuityHints } from './shell/session-continuity-hints.ts';
import { wireShellUiOpeners } from './shell/ui-openers.ts';
import { deriveComposerState } from './core/composer-state.ts';
import { createPowerNoteSource } from './runtime/power-note-source.ts';
import { createModeWordsSource, getSharedModeFlash } from '@goodvibes-jev/engine/terminal-shell/session-permission-mode';
import { terminalAskFacts, type TerminalAskContext } from '@goodvibes-jev/engine/terminal-shell/permission-prompt-facts';
import { OwnerQuestionCard, ownerQuestionInbox, withOwnerQuestionCard } from '@goodvibes-jev/engine/terminal-shell/question-card';
import { keycapLabel } from '@goodvibes-jev/engine/terminal-shell/status-line';
import { drawSplashAdditions } from '@goodvibes-jev/engine/terminal-shell/first-run';
import { GitStatusProvider, type GitHeaderInfo } from '@goodvibes-jev/engine/terminal-shell/git-status';
import { describeExecutionModeWords } from './permissions/execution-mode.ts';
import { footerTargetRows } from './renderer/footer-targets.ts';
import { getSharedNotificationFeed } from './core/notifications-feed.ts';
import { watchDaemonPowerEvents, type PowerState } from '@goodvibes-jev/engine/platform/platform/power';
import { buildPersistedSessionContextFromFacts, holdOfferedRecoverySnapshot } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { installFocusModeExitGuard, markFocusModeEnabled, wrapRequestPermissionWithApprovalAlert } from './shell/terminal-focus-mode.ts';
import { createTerminalLifecycle, installTerminalExitGuards, makeFileEditorOpener } from '@goodvibes-jev/engine/terminal-shell';
import type { PreparedShellCliRuntime } from './cli/entrypoint.ts';
import { reachabilityAtLaunch } from './runtime/path-shadow-startup.ts';
import { selfUpdateAtLaunch } from './cli/launch-auto-update.ts';
import { startPeriodicSelfUpdate } from './runtime/periodic-update.ts';
import { applyInitialTuiCliState, getInteractiveTerminalLaunchError, reportFatalStartupError } from './cli/tui-startup.ts';
import { writeFatalLine } from './utils/fatal-boot-write.ts';
import { wireSpokenTurnRuntime } from './audio/spoken-turn-wiring.ts';
import { installVoiceCapture } from './shell/voice-capture-shell.ts';
import { createOwnerSubmission } from './shell/owner-submission.ts';
import { createProcessFaultHandlers } from './runtime/process-fault-capture.ts';
import { attachSpokenTurnModelRouting, createSpokenTurnInputOptions } from './audio/spoken-turn-model-routing.ts';
import { bindOwnerInput } from '@goodvibes-jev/engine/terminal-shell/companion-input';
import type { NoticeLevel, OrchestratorUserInputOptions } from '@goodvibes-jev/engine/platform/platform/core';
import { allowTerminalWrite, createShellLayout, installFullScreenTerminalOutputGuard } from '@goodvibes-jev/engine/terminal-shell';
import { buildCommandArgsHint } from './input/command-args-hint.ts';
import './config/surface.ts';
import { createAutonomySurfacing, buildSkillDraftProposer } from './shell/autonomy-surfacing.ts';
import { bindApprovals } from './shell/approvals-binding.ts';
import { listAutomationRunsSince } from './agent/automation-runs-source.ts';
import { createConnectedHost } from '@goodvibes-jev/engine/terminal-shell/agent-turn/connected-host-client';
import './core/hardware-profile.ts';
import { readApprovalPostureFromConfig } from './permissions/approval-posture.ts';
import { cancelConversationGeneration, installRemoteConversationRouting } from './shell/remote-conversation-wiring.ts';
import { applyAtModelSwitches } from './input/at-model-switch.ts';
import { createCommandContextUi } from './shell/command-context-ui.ts';
import { createTerminalPaintWindow } from './shell/terminal-paint-window.ts';
import { createSessionContractViews, wireWorkTree } from './core/work-tree-wiring.ts';
import { createContractQuestionComposer } from '@goodvibes-jev/engine/terminal-shell/contract-question-composer';
import { SessionViews } from './shell/session-views.ts';
import { proposesSpeechToText, runWakeSetupPlan, wakeSetupRunning } from './core/wake-setup-plan.ts';

// Escape bytes and enter/exit sequencing live in renderer/terminal-escapes.ts (re-exported from @goodvibes-jev/engine/terminal-shell) so this file never holds its own drifting copy.

let releaseFailedStartupSession: (() => Promise<void>) | undefined;
// Set once the terminal lifecycle exists, so a startup failure after terminal
// entry hands the screen back before its explanation is printed.
let restoreTerminalAfterFailedStartup: (() => void) | undefined;

async function main(prepared: PreparedShellCliRuntime) {
  const stdout = process.stdout;
  const stdin = process.stdin;
  installFocusModeExitGuard(stdout); // see shell/terminal-focus-mode.ts
  const { cli, configManager, bootstrapWorkingDir, bootstrapHomeDirectory } = prepared;

  const terminalLaunchError = getInteractiveTerminalLaunchError({
    binary: cli.binary,
    stdinIsTTY: stdin.isTTY,
    stdoutIsTTY: stdout.isTTY,
  });
  if (terminalLaunchError !== null) {
    // Descriptor write, not process.stderr: this is a refusal that exits
    // immediately, and a stream write can still be in flight when the process
    // stops existing. See utils/fatal-boot-write.ts.
    writeFatalLine(terminalLaunchError);
    process.exit(2);
  }

  // Launch-time self-update, before any bootstrap or terminal mode change; on
  // an installed update this restarts onto the swapped binary and never returns.
  const launchUpdateLines = await selfUpdateAtLaunch({ configManager, stdout });
  const reachabilityLines = await reachabilityAtLaunch({ stdout });

  const herdrSession = createHerdrSessionReporter();
  let refreshHerdr = (): void => {};
  let unsubscribeHookActivity = (): void => {};
  const closeHerdr = (): Promise<void> => {
    unsubscribeHookActivity();
    return herdrSession.close();
  };
  releaseFailedStartupSession = closeHerdr;
  const ctx: BootstrapContext = await bootstrapRuntime(stdout, {
    configManager,
    workingDir: bootstrapWorkingDir,
    homeDirectory: bootstrapHomeDirectory,
    onHookDispatcherReady: (source) => {
      refreshHerdr = () => {
        void herdrSession.update(
          buildAgentHerdrSessionUpdate({ ...source, orchestrator: { isBusy: true, isThinking: false }, workingDir: bootstrapWorkingDir }),
        );
      };
      unsubscribeHookActivity = source.hookDispatcher.onActivity(() => refreshHerdr());
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
    bootstrapUnsubs,
    orchestratorRefs,
    setRenderRequest,
    permissionPromptRef,
    systemMessageRouter,
  } = ctx;
  void herdrSession.update(
    buildAgentHerdrSessionUpdate({
      runtime,
      surface: ctx.services.surface,
      orchestrator,
      hookDispatcher,
      workingDir: ctx.services.workingDirectory,
    }),
  );
  const workingDir = ctx.services.workingDirectory;
  const homeDirectory = ctx.services.homeDirectory;
  const { approvalBroker, agentManager, modeManager, processManager, providerRegistry, secretsManager, subscriptionManager } = ctx.services;
  conversation.setSessionMemoryStore(ctx.services.sessionMemoryStore);
  conversation.setSessionLineageTracker(ctx.services.sessionLineageTracker);
  orchestrator.setCoreServices({
    configManager,
    providerRegistry,
    favoritesStore: ctx.services.favoritesStore,
    planManager: ctx.services.planManager,
    adaptivePlanner: ctx.services.adaptivePlanner,
    sessionMemoryStore: ctx.services.sessionMemoryStore,
    sessionLineageTracker: ctx.services.sessionLineageTracker,
    idempotencyStore: ctx.services.idempotencyStore,
    helperModel: ctx.services.helperModel,
  });
  let activeConversationWidth = getTerminalSize(stdout).width;
  conversation.setWidthProvider(() => activeConversationWidth);

  // Re-surface pre-bootstrap launch-update lines in-session (the alternate
  // screen wipes the stdout copies written before the renderer existed).
  // A notice in the count, as in the terminal app: never a toast over the splash.
  for (const line of launchUpdateLines) systemMessageRouter.low(`[Update] ${line}`);
  for (const line of reachabilityLines) systemMessageRouter.high(`[Install] ${line}`);
  // The print level (behavior.hitlMode) follows the setting, whoever changes it.
  applyConfiguredHitlMode(configManager, modeManager);

  const buildSessionContinuityHints = () =>
    buildShellSessionContinuityHints(
      uiServices.readModels.session.getSnapshot(),
      uiServices.readModels.tasks.getSnapshot(),
      uiServices.readModels.remote.getSnapshot(),
    );
  const buildCurrentSessionSnapshot = (): SessionSnapshot => {
    const messages = conversation.getMessageSnapshot();
    const persisted = buildPersistedSessionContextFromFacts(messages, conversation.getTitleSource(), buildSessionContinuityHints());
    return {
      messages: conversationMessagesAsSessionRecords(messages),
      timestamp: Date.now(),
      title: conversation.title,
      ...conversation.branchState(),
      ...persisted,
    };
  };

  let setupPairing: SetupPairingController | null = null;
  let pendingPermission: PendingPermissionState | null = null;
  const approvalsBinding = bindApprovals({
    broker: approvalBroker,
    approvalsView: ctx.services.approvalsView,
    // Deferred: `render` is declared further down, and the binding only ever
    // calls it from inside the broker subscription.
    render: () => {
      render();
    },
    getPending: () => pendingPermission,
    setPending: (next) => {
      if (next) setupPairing?.cancelForTakeover();
      pendingPermission = next;
    },
    onResolveFailed: (error) => systemMessageRouter.high(
      `[Approval] Your answer was not recorded: ${summarizeError(error)}. The request is still waiting; answer it again.`,
      'error',
    ),
  });

  let streamTokenSpeed = 0;
  // A turn occupies the orchestrator from admission to finalization, which
  // starts before and can outlast isThinking (abort clears it while the turn
  // still settles); input submitted then is queued, so the shell shows busy.
  const mainTurnBusy = (): boolean => orchestrator.isTurnActive;

  const thinkingClock = new ThinkingStallClock(); // thinking-indicator stall clock

  // Where the main transcript is scrolled to; each frame's clamp is fed back (shell/transcript-scroll.ts).
  const transcript = new TranscriptScroll();

  const shellPassthrough = new ShellPassthrough();
  let shellCommandsRunning = 0;

  // Ambient autonomy surfacing: the away digest at launch, read from the
  // connected host where schedules live and run.
  const automationHost = createConnectedHost({ configManager, homeDirectory });
  const autonomy = createAutonomySurfacing({
    shellPaths: ctx.services.shellPaths,
    listAutomationRunsSince: (since, signal) => listAutomationRunsSince(automationHost, since, { signal }),
    listApprovals: approvalsBinding.listApprovals,
    describeApprovalsUnavailable: approvalsBinding.describeApprovalsUnavailable,
    getTasksSnapshot: () => uiServices.readModels.tasks.getSnapshot().tasks,
    router: {
      high: (message) => systemMessageRouter.high(message),
      low: (message) => systemMessageRouter.low(message),
    },
    render: () => render(),
    onAwayDigest: buildSkillDraftProposer(toolRegistry, ctx),
    isIdle: () => !mainTurnBusy() && pendingPermission === null,
  });

  const getPromptContentWidth = () => {
    // Composer text runs from column 5 and wraps at width-9 (composer.ts), leaving the cursor room at width-4.
    return Math.max(1, getTerminalSize(stdout).width - 9);
  };

  // Live-microphone footer row (the wake detector); assigned once voice capture is wired below, null until then so pre-wiring frames size correctly.
  let voiceCaptureStatus: () => import('./core/voice-capture-status.ts').VoiceCaptureIndicatorState | null = () => null;

  // One cached contract snapshot for the session (no manifest), rebuilt on a contract event: every per-frame lookup reads it.
  const sessionContractViews = createSessionContractViews(ctx.services.contractRunner, () => runtime.sessionId,
    (listener) => ctx.services.runtimeBus.onDomain('contracts', listener));
  // A contract's open question: offered above the composer, answered by the next typed message unless dismissed (Alt+X).
  const contractQuestions = createContractQuestionComposer(() => sessionContractViews.read());
  // Agents and background processes opened full screen: Enter on a lane or ▶ bead, the Activity modal, the process monitor (shell/session-views.ts).
  const sessionViews = new SessionViews({
    conversation,
    agentManager,
    processManager,
    contractRunner: ctx.services.contractRunner,
    contracts: sessionContractViews,
    fleetNodes: () => ctx.services.processRegistry.query().nodes,
    steer: (id, text) => ctx.services.processRegistry.steer(id, text),
    killAgent: (id) => ctx.services.processRegistry.kill(id, { cascade: true }),
    mainBusy: mainTurnBusy,
    mainModel: () => providerRegistry.getCurrentModel().id,
    promptText: () => input.prompt,
    requestRender: () => render(),
  });
  commandContext.openSessionView = (target) => sessionViews.open(target);
  const getViewportHeight = (): number =>
    // less the header row (+ chips) and, on the main screen, the empty row under them (a view's body brings its own)
    getTerminalSize(stdout).height -
    sessionViews.headerRows() -
    (sessionViews.active ? 0 : HEADER_GAP_ROWS) -
    estimateShellFooterHeight(input.getVisiblePromptLineCount(getPromptContentWidth()));

  const scroll = (delta: number) => {
    if (sessionViews.active) {
      sessionViews.scroll(-delta);
      return;
    } // a view scrolls its own lines (up is positive there)
    transcript.scrollBy(delta, () => Math.max(0, conversation.history.getLineCount() - getViewportHeight()));
  };

  // Only follow the tail while parked at the bottom (a manual scroll-up stays); a submission re-locks.
  const scrollToEnd = (vHeight: number) => transcript.followTail(conversation.history.getLineCount(), vHeight);

  const unsubs: Array<() => void> = [];
  const nativeLedgerHost = createAgentNativeHostSelection({ configManager, homeDirectory: () => ctx.services.shellPaths.homeDirectory,
    observation: new OwnedSelectionObservation() });
  commandContext.nativeWorkLedger = createNativeWorkLedgerView(
    () => {
      const host = nativeLedgerHost.resolve();
      return 'reason' in host
        ? host
        : {
            ...host,
            workspace: ctx.services.workingDirectory,
            journalPath: ctx.services.shellPaths.resolveUserPath('agent', 'native-work-submission.json'),
            readExecutionMode: () => readInitialExecutionMode(configManager),
          };
    },
    () => render(),
  );
  commandContext.nativeConversationIntake = commandContext.nativeWorkLedger.intake;
  unsubs.push(() => commandContext.nativeWorkLedger?.dispose());
  unsubs.push(() => shellPassthrough.cancelRunning());
  unsubs.push(() => input.settingsModal.close());
  // The footer's power note: the adopted daemon's state (the daemon owns keep-awake), else this process's manager.
  // Read when the daemon says sleep ownership changed, when keep-awake changes here and when a turn ends.
  const powerNote = createPowerNoteSource({
    local: () => ctx.services.powerManager.getState(),
    isAdopted: () => ctx.services.memorySpineClient.active,
    fetchDaemon: async () => await automationHost.invoke('power.status.get', {}) as unknown as PowerState,
    watchEvents: async (handlers) => {
      const host = ctx.services.resolveConnectedHost();
      return 'reason' in host ? null : await watchDaemonPowerEvents({ baseUrl: host.baseUrl, getAuthToken: () => host.token, ...handlers });
    },
    render: () => render(),
  });
  // The status line shows only the short chip; the full note goes to the notifications once each time it changes.
  let postedPowerNote: string | null = null;
  const currentPowerChip = (): string | undefined => {
    const note = powerNote.get();
    const previous = postedPowerNote;
    // Recorded before posting: posting repaints, and that paint must find this note already posted.
    postedPowerNote = note?.detail ?? null;
    if (note && note.detail !== previous) publishToSharedFeed(note.detail, { restored: false, notice: { level: 'warning' } });
    return note?.chip ?? undefined;
  };
  // The status bar's mode words, recomputed only when the mode in force can change (session-permission-mode.ts);
  // its flash after Shift+Tab, and the unread notices count, each repaint when they change.
  const modeWords = createModeWordsSource(configManager, () => render(), getSharedModeFlash());
  getSharedModeFlash().onChange = () => render();
  // The count repaints after the change that moved it, never inside the paint that posted a notice.
  unsubs.push(() => modeWords.stop(), getSharedNotificationFeed().subscribe(() => queueMicrotask(render)));
  // What an ask is worded from (the approval card and the question card): the folder, the mode in force, this chat.
  const askContext = (): TerminalAskContext => ({ workingDirectory: workingDir, homeDirectory, modeInForce: modeWords.current(), currentSessionId: runtime.sessionId });
  // A question this chat's agent left for the owner, pinned above the composer (terminal-shell question-card.ts).
  const ownerQuestionCard = new OwnerQuestionCard({
    inbox: ownerQuestionInbox(ctx.services.shellPaths, 'agent'),
    sessionId: () => runtime.sessionId,
    facts: () => terminalAskFacts(askContext()),
    render: () => render(),
    notify: (message) => { systemMessageRouter.high(message); render(); },
  });
  unsubs.push(ownerQuestionCard.start());
  // The status bar's branch: read once, then polled the way the terminal app does (a few file stats
  // every 5 s; git runs only when git's own files moved or the terminal regains focus) and after each turn.
  const gitStatus = new GitStatusProvider(ctx.services.workingDirectory);
  let gitInfo: GitHeaderInfo | undefined;
  const showGit = (info: GitHeaderInfo): void => { gitInfo = info; render(); };
  void gitStatus.getStatus().then(showGit, () => undefined);
  gitStatus.startPolling(5_000, showGit, () => ctx.services.focusTracker.isFocused());
  unsubs.push(
    () => gitStatus.stopPolling(),
    uiServices.events.turns.on('TURN_COMPLETED', () => { void gitStatus.refresh().then(showGit, () => undefined); }),
  );
  unsubs.push(
    () => powerNote.stop(),
    configManager.subscribe('power.keepAwake', () => powerNote.refresh()),
    uiServices.events.turns.on('TURN_COMPLETED', () => powerNote.refresh()),
  );
  // The work tree's live facts: call/turn timings, agent lanes, the call a permission prompt holds, fold persistence (work-tree-wiring.ts).
  const workTreeWiring = wireWorkTree({
    conversation,
    events: uiServices.events,
    agentManager,
    contracts: sessionContractViews,
    fleetNodes: () => ctx.services.processRegistry.query().nodes,
    pendingCallId: () => pendingPermission?.callId,
    turnActive: mainTurnBusy,
    sessionsDir: ctx.services.surface.sessionsDir,
    sessionId: () => runtime.sessionId,
    requestRender: () => render(),
  });
  unsubs.push(...workTreeWiring.unsubs, () => sessionViews.dispose(), sessionContractViews.dispose);
  const throbberSource = createThrobberSource(
    uiServices.events.tools,
    () => ctx.services.contextAccountingHolder.getSource()?.getCompactionState().isCompacting === true,
  );
  unsubs.push(...throbberSource.unsubs); // the throbber's running call and compaction clock
  // A provider reconnect reads as "retrying n/m" in the throbber instead of a generic stall.
  unsubs.push(uiServices.events.turns.on('STREAM_RETRY', (event) => {
    thinkingClock.noteReconnect(event.attempt, event.maxAttempts);
    render();
  }));
  let stopSpokenOutputForExit: (() => Promise<void>) | null = null;
  // sessionId of the offered recovery snapshot, or null when none is pending.
  let recoveryPending: string | null = null,
    daemonRepairPrompt: DaemonRepairPrompt | null = null;
  /** True while $EDITOR owns the terminal: frames are held until it exits. */
  let externalEditorOpen = false;
  // The window in which this app owns the screen: opened by the enter sequence below, closed by exitApp before the terminal-restore write. render() paints only inside it, see shell/terminal-paint-window.ts for what the early frames did to the boot surface and to the shell's screen.
  let terminalOutputGuard: ReturnType<typeof installFullScreenTerminalOutputGuard> | undefined;
  const terminalLifecycle = createTerminalLifecycle({
    write: (data) => { stdout.write(data); },
    noAltScreen: cli.flags.noAltScreen,
    guardedWrite: allowTerminalWrite,
    disposeOutputGuard: () => terminalOutputGuard?.dispose(),
    setRawMode: (enabled) => stdin.setRawMode(enabled),
  });
  const paintWindow = createTerminalPaintWindow({
    enter: () => {
      terminalLifecycle.enterTerminal();
      markFocusModeEnabled();
    },
    discardCompositorState: () => compositor.resetDiff(),
  });
  // The final safety net: any exit, including a failed startup after terminal
  // entry, leaves the alt screen, mouse and keyboard modes. Restore is
  // idempotent and writes nothing for a terminal that was never entered. The
  // paint window closes first so no late frame follows the restore write.
  const terminalGuards = installTerminalExitGuards(terminalLifecycle, {
    restore: () => {
      paintWindow.close();
      terminalLifecycle.restoreTerminal();
    },
  });
  const handBackTerminal = terminalGuards.handBack;
  restoreTerminalAfterFailedStartup = handBackTerminal;

  const sigintHandler = (): void => input.feed('\x03');
  const processFaults = createProcessFaultHandlers({
    notifyHigh: (message) => systemMessageRouter.high(message),
    render: () => render(),
    shellPaths: ctx.services.shellPaths,
    activeSessionId: () => runtime.sessionId,
    // Hand the screen back first so the crash lines land on the user's own
    // screen instead of the alternate one that exit then discards.
    restoreTerminal: handBackTerminal,
    exit: (code) => exitApp(undefined, code),
  });
  const resizeHandler = (): void => {
    input.setContentWidth(getPromptContentWidth());
    compositor.resetDiff();
    render();
  };

  let exiting = false;
  // `handOver` replaces the process AFTER the orderly teardown below and exits
  // with its code, how a periodic self-update restarts onto its new binary.
  // `exitCode` is the code for a plain exit (1 after a crash).
  const exitApp = (handOver?: () => number, exitCode = 0): void => {
    // Reentrancy guard: a second /exit or keypress during the bounded
    // spoken-audio drain must not re-run teardown.
    if (exiting) return;
    exiting = true;
    runExitSequence<SessionSnapshot>({
      closeHerdr,
      disposePairing: () => setupPairing?.dispose(),
      closePaintWindow: () => paintWindow.close(),
      stopSpokenOutput: () => stopSpokenOutputForExit?.(),
      unsubs,
      stopAutonomy: () => autonomy.stop(),
      detachHostedSession: () => remoteConversation.detachHostedSession(),
      buildSnapshot: buildCurrentSessionSnapshot,
      buildMessagesSnapshot: () => ({ messages: conversationMessagesAsSessionRecords(conversation.getMessageSnapshot()), timestamp: Date.now(), title: conversation.title, ...conversation.branchState() }),
      shutdown: (saved) => ctx.shutdown(saved),
      // Scoped to this session only, a keyless call would clear every snapshot in the recovery dir.
      // The clean save supersedes the live snapshot; a crash snapshot of this session still on offer is kept apart.
      removeRecoveryPoint: () => deleteRecoveryFile({ surface: ctx.services.surface }, runtime.sessionId),
      detach: () => {
        stdin.removeAllListeners('data');
        stdout.removeListener('resize', resizeHandler);
        process.removeListener('SIGINT', sigintHandler);
        // SIGTERM and SIGHUP keep their listener until the process exits: exitApp ignores a repeat, and with no listener left the power watcher's reaper would re-raise the signal and kill the process before the session is saved and the Herdr pane released.
        stdin.removeListener('end', terminalClosed);
        stdin.removeListener('close', terminalClosed);
        processFaults.dispose();
      },
      restoreTerminal: () => terminalLifecycle.restoreTerminal(),
      warn: (message, error) => logger.warn(message, { error: summarizeError(error) }),
      warnPlain: (message) => logger.warn(message),
      printToTerminal: writeFatalLine,
      exit: (code) => process.exit(code),
    }, handOver, exitCode);
  };

  const terminalClosed = (): void => exitApp();
  commandContext.exit = exitApp;

  // A long-running agent looks for a newer release too, not only at launch: it
  // installs at an idle moment and restarts in place (runtime/periodic-update.ts).
  unsubs.push(
    startPeriodicSelfUpdate({
      configManager,
      services: ctx.services,
      exit: exitApp,
      // The person is in the middle of something this shell can see.
      userIsMidGesture: () => input.prompt.length > 0 || input.surfaceModals.active || input.waitingForOwner
        || shellCommandsRunning > 0 || setupPairing?.ownsInput === true || pendingPermission !== null,
      workRunningHere: () => mainTurnBusy() || uiServices.readModels.agents.getSnapshot().active.length > 0
        || processManager.list().some((entry) => !entry.done),
      sessionId: () => runtime.sessionId,
      notify: (line) => {
        systemMessageRouter.high(`[Update] ${line}`);
        render();
      },
    }),
  );

  const spokenTurns = wireSpokenTurnRuntime({
    voiceService: ctx.services.voiceService,
    configManager,
    events: uiServices.events,
    notify: (message) => {
      systemMessageRouter.high(message);
      render();
    },
  });
  // Exit-path stop: bounded drain of the audio already playing (see stopForExit).
  stopSpokenOutputForExit = () => spokenTurns.stopForExit();
  unsubs.push(...spokenTurns.unsubs);
  unsubs.push(
    attachSpokenTurnModelRouting({
      orchestrator,
      providerRegistry,
      configManager,
      notify: (message) => {
        systemMessageRouter.high(message);
        render();
      },
    }),
  );
  // Where a turn runs, see shell/remote-conversation-wiring.ts.
  // A refused, unsent prompt goes back into an empty composer; text typed since is never overwritten.
  const restoreDraft = (text: string): void => {
    if (input.prompt.length > 0 || text.length === 0) return;
    input.prompt = text;
    input.cursorPos = text.length;
    render();
  };
  // Shell output taken for a message that has not been admitted yet. If the message is refused
  // the output goes back to the buffer, so the retry still carries it.
  const shellContextHold = new ShellContextHold(shellPassthrough);
  // Why a message was not sent, or what it needs: in the conversation at once (and the activity feed).
  const showInputNotice = (message: string, level?: NoticeLevel): void => {
    conversation.addInputNotice(message, level);
    systemMessageRouter.activity(message);
  };
  const remoteConversation = installRemoteConversationRouting(ctx, {
    render: () => render(),
    notify: (message) => showInputNotice(message),
    record: (message) => systemMessageRouter.activity(message),
  });
  unsubs.push(() => remoteConversation.dispose());
  // A cleared or replaced conversation must not keep steering into the hosted session of the one it left.
  commandContext.abandonHostedSession = () => remoteConversation.resetHostedSession();
  // Explicit recovery (/work intake-*) reports its results to the hosted owner,
  // so a settled input stops blocking execution-mode changes.
  if (commandContext.nativeConversationIntake) {
    commandContext.nativeConversationIntake = remoteConversation.observeIntake(commandContext.nativeConversationIntake);
  }

  const dispatchNativeTurn = async (
    state: NativeConversationIntakeState,
    spokenOutput = false,
    turnOptions?: OrchestratorUserInputOptions,
  ): Promise<void> => {
    if (state.hostedTurn && commandContext.nativeConversationIntake) {
      await remoteConversation.observeNative(state, commandContext.nativeConversationIntake);
      return;
    }
    if (!isNativeConversationTurnReady(state)) return;
    const inputOptions = nativeConversationTurnInputOptions(state, spokenOutput ? { ...turnOptions, ...createSpokenTurnInputOptions() } : turnOptions);
    try {
      await dispatchNativeConversationTurn(state, orchestrator, inputOptions);
    } catch (error) {
      // A turn that provably never started gives its claim back so /work intake-retry can run it.
      systemMessageRouter.userAction(
        await describeFailedNativeDispatch(
          state,
          error,
          'Native turn dispatch requires recovery. Its durable claim was preserved; no legacy fallback was started.',
        ),
        'error',
      );
      render();
    }
  };
  commandContext.dispatchNativeIntakeTurn = (state) => dispatchNativeTurn(state);

  // The owner-input path every message ends in, see shell/owner-turn-sender.ts.
  const ownerTurns = createOwnerTurnSender({
    remoteConversation,
    intake: () => commandContext.nativeConversationIntake,
    shellContextHold,
    restoreDraft,
    runTurn: (text, spokenOutput, turnOptions) => orchestrator.handleUserInput(text, undefined,
      spokenOutput ? { ...turnOptions, ...createSpokenTurnInputOptions() } : turnOptions),
    dispatchNativeTurn: (state, spokenOutput, turnOptions) => dispatchNativeTurn(state, spokenOutput, turnOptions),
    isBusy: () => orchestrator.isBusy,
    messages: {
      high: (message, level) => systemMessageRouter.high(message, level),
      userAction: (message) => systemMessageRouter.userAction(message),
      activity: (message) => systemMessageRouter.activity(message),
      aboutInput: (message, level) => showInputNotice(message, level),
    },
    render: () => render(),
  });
  unsubs.push(() => ownerTurns.dispose());

  // Every submission starts here: a pending setup takeover is let go, the
  // conversation is offered for rewinds again, and the view returns to the bottom.
  const prepareSubmission = (): void => {
    setupPairing?.cancelForTakeover();
    // Acting here after another surface took the session over is what moves the conversation back for rewinds.
    if (ctx.services.conversationRewindHost.resumeIfTakenOver()) {
      systemMessageRouter.high('[Rewind] Another surface had taken over this session; this one is offering its conversation for rewinds again.');
    }
    transcript.toBottom(); // Re-lock on user input
  };

  // A conversation turn carries text. `!@file` and `@path`/URL references are
  // already text by the time the composer submits (the composer expands them,
  // each file capped with the cut stated, and refuses any other binary file),
  // and held `!` output goes in front of the message in ownerTurns.sendTurn.
  // Only an image (pasted, `/image`, or a typed reference to an image file)
  // cannot go with it: say so before anything is pinned or sent, and give the draft back.
  const refuseUnsendable = (draft: string, source: NativeConversationInput | undefined, content: readonly ContentPart[] | undefined): boolean => {
    const images = (source?.unsupportedSources ?? []).filter((part) => part.kind === 'image');
    if (content?.some((part) => part.type !== 'text') && images.length === 0) images.push({ kind: 'image', label: 'attached image' });
    if (images.length === 0) return false;
    systemMessageRouter.high(formatRefusal(refusal({
      code: 'TURN_SOURCE_UNSUPPORTED',
      state: 'not sent; your text is back in the composer',
      reason: `Not sent: a conversation turn carries text only, and this message has ${images.map((part) => part.label).join(', ')}`,
      next: ['Your text is back in the composer; to send it, remove the image and describe it in words, then press Enter'],
    })), 'warning');
    restoreDraft(draft);
    render();
    return true;
  };

  // Typed composer text has a grammar (`@model:`, `!`, `!#`, `# `); text sent as given and speech do not.
  const submission = createOwnerSubmission({
    shellPassthrough,
    workingDir,
    sessionMemoryStore: ctx.services.sessionMemoryStore,
    prepare: prepareSubmission,
    applyModelSwitches: (text) => applyAtModelSwitches(text, {
      providerRegistry,
      configManager,
      onModelChanged: (model) => {
        runtime.model = model.id;
        runtime.provider = model.provider;
      },
      notify: (message) => systemMessageRouter.high(message),
    }),
    refuseUnsendable,
    answerOptions: () => contractQuestions.answerOptions(),
    sendTurn: (text, options, turnOptions, how) => ownerTurns.sendTurn(text, options, turnOptions, how),
    restoreDraft: (text) => restoreDraft(text),
    onShellCommandsRunning: (running) => { shellCommandsRunning = running; },
    notify: (message, level) => systemMessageRouter.high(message, level),
    showShellOutput: (result) => conversation.addShellOutput(result.display, result.failed),
    render: () => render(),
  });
  const { submitComposerText, submitTurn } = submission;

  const cancelGeneration = () => {
    spokenTurns.stop('Spoken output stopped.');
    // A hosted turn sets the same isThinking the local path does, but its
    // waiting state is owned here, not by orchestrator.abort().
    cancelConversationGeneration(orchestrator, remoteConversation);
    shellPassthrough.cancelRunning();
  };

  const { jumpToBookmark, scrollToLine } = createTranscriptNavigators({
    conversation,
    getViewportHeight,
    setScrollTop: (line) => {
      transcript.jumpTo(line);
    },
    render: () => render(),
    notify: (message) => systemMessageRouter.high(message),
  });

  Object.assign(
    commandContext,
    // Spoken input and submitTurn send text as given; only typed composer text has a grammar.
    createShellSubmissionPorts(
      submitComposerText,
      submitTurn,
      () => spokenTurns.stop(),
      () => input.handlePaste(),
    ),
  );
  // Companion messages and an activated plan take the composer's path as sent; one refused is held (shell/owner-turn-sender.ts).
  bindOwnerInput(orchestrator, (text, turnOptions) => ownerTurns.receiveOwnerInput(text, turnOptions));
  // Composer line prompts: masked for card material, echoed for addresses (see input/handler-line-prompts.ts).
  commandContext.beginConcealedInput = (request) => input.beginConcealedInput(request);
  commandContext.beginPlainInput = (request) => input.beginPlainInput(request);
  commandContext.executeCommand = (name, args) => commandRegistry.execute(name, args, commandContext);
  commandContext.cancelGeneration = cancelGeneration;
  commandContext.isGenerating = () => orchestrator.isBusy;
  commandContext.jumpToBookmark = jumpToBookmark;
  commandContext.scrollToLine = scrollToLine;
  commandContext.openFileInEditor = makeFileEditorOpener({
    stdin,
    terminal: terminalLifecycle,
    repaint: () => {
      compositor.resetDiff();
      render();
    },
    setHeld: (held) => { externalEditorOpen = held; },
    cwd: workingDir,
    env: process.env,
    notify: (m) => systemMessageRouter.high(m),
  });
  const commandUi = createCommandContextUi({
    compositor,
    stdout,
    render: () => render(),
    terminalWidth: () => getTerminalSize(stdout).width,
    setPendingPermission: (pending) => {
      if (pending) setupPairing?.cancelForTakeover();
      pendingPermission = pending;
    },
  });
  commandContext.clearScreen = commandUi.clearScreen;
  // Your agents (Ctrl+O, /agents): the work board over this process's fleet and the
  // connected host's, the same panel as the terminal app's (terminal-shell work-board-input.ts).
  // Finished work listed is this run's; n hosts a coding agent on the connected host.
  const sessionStartedAt = Math.floor(performance.timeOrigin);
  const agentSpawn = new FleetSpawn({
    resolveGateway: () => createVerbSpawnGateway(ctx.services.daemonVerbs),
    currentDirectory: () => ctx.services.workingDirectory,
    notify: (message) => systemMessageRouter.high(message),
    markDirty: () => render(),
  });
  commandContext.openAgents = () => {
    const open = input.surfaceModals.modals().find((modal) => modal instanceof WorkBoardModal);
    input.surfaceModals.push(open ?? new WorkBoardModal({
      sources: { nodes: () => ctx.services.fleetUnion.nodes(), sessionStartedAt },
      subscribe: (listener) => ctx.services.processRegistry.subscribe(() => listener()),
      requestRender: () => render(),
      openSessionView: (target) => {
        if (sessionViews.open(target)) return true;
        // A background process this view cannot open is in the process monitor.
        if (target.kind !== 'process') return false;
        input.processModal.open();
        return true;
      },
      kill: (id) => ctx.services.processRegistry.kill(id, { cascade: true }),
      resume: (id) => ctx.services.processRegistry.resume(id),
      confirm: (options) => confirmThrough(input.surfaceModals, options),
      spawn: agentSpawn,
    }));
    render();
  };
  // see shell/terminal-focus-mode.ts
  const showPermissionCard = commandUi.requestPermission as typeof permissionPromptRef.requestPermission;
  // A delegated agent asking the owner is waiting on them until the card is answered;
  // the answer settles its call, so it leaves the wait for that tool call.
  const askOwner: typeof permissionPromptRef.requestPermission = (request, options) => {
    const askingAgent = request.attribution?.kind === 'background-agent' ? request.attribution.agentId : null;
    if (askingAgent === null) return showPermissionCard(request, options);
    const bus = ctx.services.runtimeBus;
    const emitter = { sessionId: runtime.sessionId, traceId: `${runtime.sessionId}:ask:${request.callId}`, source: 'permission-card' };
    emitAgentAwaitingMessage(bus, emitter, { agentId: askingAgent });
    return showPermissionCard(request, options).then((decision) => {
      emitAgentAwaitingTool(bus, emitter, { agentId: askingAgent, callId: request.callId, tool: request.tool });
      return decision;
    });
  };
  permissionPromptRef.requestPermission = wrapRequestPermissionWithApprovalAlert(
    askOwner,
    { focusTracker: ctx.services.focusTracker, configGet: (key) => readAgentHostSetting(configManager, key), conversation },
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
        tokenAuditor: ctx.services.tokenAuditor,
        replayEngine: ctx.services.replayEngine,
        webhookNotifier: ctx.services.webhookNotifier,
        focusTracker: ctx.services.focusTracker,
        policyRuntimeState: ctx.services.policyRuntimeState,
        externalServices: uiServices.platform.externalServices,
      },
      shell: {
        bookmarkManager: ctx.services.bookmarkManager,
        keybindingsManager: ctx.services.keybindingsManager,
        processManager,
        profileManager: ctx.services.profileManager,
      },
      sessions: {
        sessionManager: ctx.services.sessionManager,
        sessionBroker: ctx.services.automationSessionRegister,
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
  setupPairing = new SetupPairingController(
    { configManager, homeDirectory },
    {
      print: (text) => {
        transcript.toBottom();
        conversation.logWrapped(text);
        render();
      },
      scroll: (lines) => {
        scroll(lines);
        render();
      },
      readPrompt: () => input.prompt,
      setPrompt: (text) => {
        input.prompt = text;
        input.cursorPos = text.length;
        input.commandMode = false;
        input.autocomplete?.reset();
        render();
      },
      // No modal open but, at most, command mode: the command that started this is still in it.
      canPresent: () => {
        return !exiting &&
          pendingPermission === null &&
          recoveryPending === null &&
          !daemonRepairPrompt?.pending() &&
          !input.concealedInput &&
          !input.plainLineInput &&
          input.surfaceModals.modals().every((modal) => modal === input.modals.command) &&
          !input.searchManager.active &&
          !input.historySearch.active &&
          !sessionViews.active;
      },
      executeOwnerCommand: (line) => {
        const parsed = parseSlashCommand(line);
        void commandRegistry.executeFromOwner(parsed.name, [...parsed.args], commandContext).catch(() => {
          systemMessageRouter.userAction('Pairing replacement command failed. Preview pairing again before taking further action.', 'error');
          render();
        });
      },
    },
  );
  input.setupPairing = setupPairing;
  commandContext.beginSetupPairing = (request) => setupPairing!.start(request);

  orchestratorRefs.getViewportHeight = getViewportHeight;
  orchestratorRefs.scrollToEnd = scrollToEnd;

  input.setCommandRegistry(commandRegistry, commandContext);
  input.setConversationManager(conversation);
  input.setContentWidth(getPromptContentWidth());
  input.filePicker.setOnUpdate(() => render());
  input.processModal.setOnRefresh(() => render());
  input.surfaceModals.onChange = () => render();
  // A click on a status bar segment opens its view (status-line.ts); the Agent keeps no changes view, so its branch only reads.
  input.onFooterTarget = (target) => {
    if (target === 'mode') commandContext.openSettingsModal?.('permissions.mode');
    else if (target === 'notices') commandContext.openNotifications?.();
    else if (target === 'context') commandContext.openContextInspector?.();
    else if (target === 'model') commandContext.openModelPicker?.();
    else if (target === 'agents') commandContext.openAgents?.();
    else if (target === 'commands') commandContext.openCommandPalette?.();
    render();
  };
  input.sessionView = sessionViews;
  input.transcriptScroll = transcriptEscape(
    transcript,
    () => sessionViews.active,
    () => render(),
  ); // Esc while scrolled back returns to the bottom, never interrupts

  // Model picker callback is handled in bootstrap.ts, do not duplicate here.
  input.setHistory(inputHistory);
  // The wake-word capture host: one microphone path, opened only when voice.wake.enabled AND voice.wake.surfaces.agent are both on (shell/voice-capture-shell.ts).
  voiceCaptureStatus = installVoiceCapture({
    configManager,
    voiceService: ctx.services.voiceService,
    voiceProviders: ctx.services.voiceProviders,
    daemonVerbs: ctx.services.daemonVerbs,
    ensureWakeProvisioned: async () => {
      const outcome = await ctx.services.voiceSetup.wakeEnsureProvisioned();
      return { ready: outcome.ready, message: outcome.message };
    },
    shellPaths: ctx.services.shellPaths,
    sessionId: runtime.sessionId,
    unsubs,
    buffer: input,
    submitTurn: submission.submitSpeech,
    notify: (m) => {
      systemMessageRouter.high(m);
      render();
    },
    render: () => render(),
  });
  // Turning wake detection on from anywhere (settings, /settings, a model's settings
  // call) runs the same voice setup as /voice wake setup and shows its plan.
  unsubs.push(configManager.subscribe('voice.wake.enabled', (enabled) => {
    if (enabled !== true || wakeSetupRunning()) return;
    void runWakeSetupPlan(ctx.services.voiceSetup).then(
      (outcome) => {
        systemMessageRouter.userAction(['Wake-Word Setup', outcome.rendered,
          ...(proposesSpeechToText(outcome) ? ['(yes: /voice wake setup --yes yes installs it now)'] : [])].join('\n'));
        render();
      },
      (error: unknown) => {
        systemMessageRouter.high(`Wake-Word Setup: ${error instanceof Error ? error.message : String(error)}`, 'error');
        render();
      },
    );
  }));

  const toolCount = toolRegistry.list().length;
  conversation.splashOptions = {
    workingDir,
    // Read when the splash is drawn, so it names the model in use now (first run may have chosen it).
    get model() { return runtime.model; },
    get provider() { return runtime.provider; },
    toolCount,
  };

  // The `ui` event domain: panel open/close/focus and view changes, read from each painted frame.
  const uiEvents = createUiEventPublisher(ctx.services.runtimeBus, () => runtime.sessionId);

  // A hoisted DECLARATION, not `const`: callbacks wired above fire before this
  // line (bindApprovals starts an unawaited refresh + stream that repaint).
  // Under a `const` they hit the temporal dead zone, every boot logged "Cannot
  // access 'render' before initialization" as an unhandled rejection, which killed
  // that wiring, so the surface never repainted from any async source again.
  function render(): void {
    // Outside the window where this app owns the screen: the alternate screen does not exist yet, or the terminal has already been handed back. Never paint in either case.
    if (!paintWindow.isOpen() || externalEditorOpen) return;
    uiEvents.observe(readUiFrame(input, sessionViews.focus.current));
    void herdrSession.update(
      buildAgentHerdrSessionUpdate({
        runtime,
        surface: ctx.services.surface,
        orchestrator,
        hookDispatcher,
        fleetNodes: ctx.services.processRegistry.query().nodes,
        workingDir,
        input,
        pendingPermission,
        recoveryPending,
        daemonRepairPrompt,
        setupPairing,
        contracts: sessionContractViews.active(),
      }),
    );
    setupPairing?.checkPresentation();
    const { width, height } = getTerminalSize(stdout);

    // Cache the current model for consistent values across the entire render frame
    const currentModel = providerRegistry.getCurrentModel();
    const sessionSnapshot = uiServices.readModels.session.getSnapshot();
    const agentSnapshot = uiServices.readModels.agents.getSnapshot();
    const activeAgents = agentSnapshot.active;
    const primaryActiveAgent = activeAgents.find((agent) => agent.latestProgress?.trim()) ?? activeAgents[0];

    const viewFrame = sessionViews.frame(width); // an agent or process open full screen, or null in main
    const headerLines = viewFrame ? [viewFrame.header] : UIFactory.createHeader(width, currentModel.id, conversation.title || undefined);
    const chipsRow = sessionViews.chips(width); // every session to switch to, when there is more than main
    if (chipsRow) headerLines.push(chipsRow);
    const backToBottom = viewFrame
      ? sessionViews.scrolledBack()
        ? { escKey: sessionViews.escGoesToBottom() }
        : null
      : mainBackToBottom(transcript, {
          splash: conversation.isSplashShowing(),
          keysInInput: input.prompt.length === 0 && !input.commandMode && !conversation.workTree.focused && !input.indicatorFocused,
        });
    const thinkingDeps = {
      orchestrator,
      configManager,
      streamTokenSpeed,
      clock: thinkingClock,
      streamToolPreview: remoteConversation.hostedToolPreview() ?? sessionSnapshot.streamToolPreview,
      approvalPending: mainPermissionAsk(pendingPermission) !== null, // a background agent's ask is not main's activity
    };
    const throbber = throbberSource.state({ ...thinkingDeps, width, pendingApproval: mainPermissionAsk(pendingPermission) }); // what main is doing: the row above the input area
    const runningAgentCount = activeAgents.length;
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
    const footerLines = buildShellFooter({
      width,
      promptText: promptInfo.visibleLines.join('\n'),
      promptLineCount: promptInfo.visibleLines.length,
      promptCursorPos:
        promptInfo.visibleCursorLine >= 0
          ? promptInfo.visibleLines.slice(0, promptInfo.visibleCursorLine).reduce((sum: number, line: string) => sum + line.length + 1, 0) +
            promptInfo.visibleCursorCol
          : undefined,
      // The cost as spent, each response at its own model's price: a model switch does not reprice it.
      usage: {
        available: isConversationUsageAvailable(orchestrator.usage),
        up: orchestrator.usage.input,
        down: orchestrator.usage.output,
        cacheRead: orchestrator.usage.cacheRead,
        cacheWrite: orchestrator.usage.cacheWrite,
        costUsd: orchestrator.usage.costUsd,
      },
      showExitNotice: input.showExitNotice,
      lastCopyTime: input.lastCopyTime,
      model: runtime.model, // prices the cost
      modelLabel: currentModel.displayName || currentModel.id,
      // '?' is the git read's "no repository here (or no answer yet)": no branch segment.
      branch: gitInfo && gitInfo.branch !== '?' ? gitInfo.branch : undefined,
      branchChanged: gitInfo?.dirty === true,
      modeWords: describeExecutionModeWords(configManager, () => modeWords.current()),
      modeKey: keycapLabel(ctx.services.keybindingsManager.getComboLabel('cycle-permission-mode')),
      modeFlash: getSharedModeFlash().active(),
      unreadNotices: getSharedNotificationFeed().unreadCount(),
      noticesKey: keycapLabel(ctx.services.keybindingsManager.getComboLabel('open-notifications')),
      view: viewFrame?.footer ?? null,
      contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel), // null: unknown, the meter says so
      compactThreshold: configManager.get('behavior.autoCompactThreshold') as number,
      // The footer and status report the same effective execution mode.
      dangerMode: readApprovalPostureFromConfig(configManager).automaticApprovals,
      executionMode: readApprovalPostureFromConfig(configManager).mode,
      powerNote: currentPowerChip(), // the daemon's state while one is adopted (runtime/power-note-source.ts)
      lastInputTokens: orchestrator.lastInputTokens,
      contextUsageAvailable: isConversationContextAvailable(orchestrator),
      commandArgsHint,
      hitlMode: modeManager.getHITLMode(),
      runningAgentCount,
      runningProcessCount,
      indicatorFocused: input.indicatorFocused,
      promptFocused: !input.indicatorFocused && !conversation.workTree.focused && viewFrame?.footer.disabledReason === undefined,
      workTreeFocused: conversation.workTree.focused && !viewFrame,
      runningAgentProgress: primaryActiveAgent
        ? `${primaryActiveAgent.label}: ${primaryActiveAgent.latestProgress?.trim() || primaryActiveAgent.status}`
        : undefined,
      composerMode: composerState.modeLabel,
      composerFlags: composerState.flags,
      composerPendingRisk: composerState.pendingRisk,
      voiceCapture: voiceCaptureStatus(),
      contractQuestionHint: contractQuestions.hint(),
      throbber,
      turnRunning: mainTurnBusy(),
      backToBottom,
    }).lines;

    const shellHeaderLines = viewFrame ? headerLines : withHeaderGap(headerLines, width); // a view's body starts with its own empty row
    input.bodyTopRow = shellHeaderLines.length; // mouse rows map to transcript rows from here
    const shellFooterLines = footerLines;
    input.footerTargets = footerTargetRows(shellFooterLines, height - shellFooterLines.length); // status bar segments open their views on a click
    const shellLayout = createShellLayout({
      width,
      height,
      headerHeight: shellHeaderLines.length,
      footerHeight: shellFooterLines.length,
      panelWidth: 0,
    });
    const vHeight = shellLayout.body.height;
    const conversationWidth = shellLayout.conversation.width;
    activeConversationWidth = conversationWidth;
    conversation.setSplashSuppressed(false);

    // Flush pending renders after updating the width provider and splash posture
    // so the transcript and splash rebuild against the current shell layout.
    workTreeWiring.syncSession(); // a resumed session's folds come back with it
    conversation.workTree.tickLive(); // running beads spin and count up
    conversation.getDisplayBlocks();

    // Calculate how many rows are consumed by overlays (thinking, permissions, queue, file picker)
    let overlayRows = 0;
    // The opt-in partial tool preview row (the spinner lives on the status line).
    const thinkingRows = buildThinkingOverlay({ ...thinkingDeps, width: conversationWidth });
    overlayRows += thinkingRows.length;
    overlayRows += orchestrator.messageQueue.length * 3; // queued messages
    // File picker and model picker overlay rows computed from actual rendered line count below
    // Selection modal overlay rows are computed from actual rendered line count below
    // The find bar and the reverse history search line each take a row under the transcript.
    if (input.searchManager.active || input.historySearch.active) {
      overlayRows += 1;
    }

    const conversationViewport = buildConversationViewport({
      conversation,
      width: conversationWidth,
      viewportHeight: vHeight,
      scrollTop: transcript.top,
      scrollLocked: transcript.locked,
      overlayRows,
    });
    if (transcript.settle(conversationViewport.nextScrollTop, conversationViewport.maxScroll) && backToBottom && !viewFrame) render(); // unlocked at the bottom re-locks: repaint without the pill
    const scrollTop = transcript.top;
    // The home splash sits in the middle of the conversation area, never clipped.
    let viewport = viewFrame
      ? viewFrame.body(vHeight)
      : conversation.isSplashShowing()
        ? drawSplashAdditions(centerViewportContent(conversationViewport.viewport, conversationViewport.effectiveHeight, conversationWidth), conversationViewport.effectiveHeight, conversationWidth, { modeKey: keycapLabel(ctx.services.keybindingsManager.getComboLabel('cycle-permission-mode')) })
        : conversationViewport.viewport;

    if (!viewFrame) viewport.push(...thinkingRows); // main's own rows stay with main

    (viewFrame ? [] : orchestrator.messageQueue).forEach((msg) => {
      viewport.push(...UIFactory.createQueuedMessageFragment(conversationWidth, msg.text));
    });

    viewport = applyConversationOverlays(viewport, {
      input,
      conversation,
      commandRegistry,
      keybindingsManager: ctx.services.keybindingsManager,
      conversationWidth,
      viewportHeight: vHeight,
      contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel) ?? 0,
    });

    compositor.composite({
      width,
      height,
      header: shellHeaderLines,
      viewport,
      footer: shellFooterLines,
      selection: viewFrame
        ? undefined
        : {
            isCellSelected: (col, row) => selection.isCellSelected(col, row),
            scrollTop,
            lineCount: conversation.history.getLineCount(),
          },
      search:
        !viewFrame && input.searchManager.active
          ? {
              manager: input.searchManager,
              scrollTop,
              viewportStartY: shellHeaderLines.length,
            }
          : undefined,
      // Modals, the permission dialog and kit modals: stamped over the dimmed screen.
      layers: withOwnerQuestionCard(buildConversationLayers({
        input,
        conversation,
        commandRegistry,
        keybindingsManager: ctx.services.keybindingsManager,
        screenWidth: width,
        screenHeight: height,
        headerRows: shellHeaderLines.length,
        footerRows: shellFooterLines.length,
        contextWindow: providerRegistry.getKnownContextWindowForModel(currentModel) ?? 0,
        providerInputTokens: orchestrator.lastInputTokens,
        permission: pendingPermission
          ? PermissionPromptUI.createPromptLayer(width, height, pendingPermission, {
            awaitingTab: cardAwaitsTab(pendingPermission, input.prompt.length === 0),
            queueCount: commandUi.waitingCount(),
            context: askContext(),
          })
          : null,
      }), ownerQuestionCard, { width, height, footerRows: shellFooterLines.length, hidden: pendingPermission !== null }),
    });
  }
  unsubs.push(announceSettingsIngestionNotices(configManager, (line, level) => {
    if (!exiting) systemMessageRouter.high(line, level);
  }));
  terminalOutputGuard = installFullScreenTerminalOutputGuard({
    stdout,
    stderr: process.stderr,

  });

  refreshHerdr = render;
  unsubs.push(ctx.services.processRegistry.subscribe(() => refreshHerdr()));
  setRenderRequest(render);
  orchestratorRefs.requestRender = render;
  commandContext.renderRequest = render;
  wireShellUiOpeners({
    commandContext,
    input,
    conversation,
    configManager,
    providerRegistry,
    runtime,
    featureFlags: ctx.featureFlags,
    mcpRegistry: ctx.services.mcpRegistry,
    subscriptionManager,
    secretsManager,
    serviceRegistry: ctx.services.serviceRegistry,
    workingDirectory: workingDir,
    homeDirectory,
    getConfiguredProviderIds: ctx._getConfiguredProviderIds,
    getPinned: ctx._getPinned,
    render,
  });

  // Crash capture before raw mode and terminal entry, as in the TUI: a throw
  // anywhere from here on restores the terminal before its record is printed.
  terminalGuards.startTerminalSession({
    registerFaults: () => processFaults.register(),
    enableRawMode: () => stdin.setRawMode(true),
    prepareInput: () => {
      stdin.resume();
      stdin.setEncoding('utf8');
    },
    enter: () => paintWindow.open(),
  });

  // Theme + forced dark/light before first paint; auto (TTY) probes + repaints once if light; the palette feeds `system`.
  const themeProbe = installStartupThemeProbe({
    configManager,
    stdout,
    writeAllowed: allowTerminalWrite,
    resetDiff: () => compositor.resetDiff(),
    render,
    invalidateTranscript: () => conversation.invalidateRenderedLines(),
    forwardInput: (b) => routeInput(b),
  });

  // A session opened later (`sessions resume`, --resume, /load, /sessions, the
  // picker) with a crash snapshot newer than its saved copy gets the start-up
  // offer: the same lines, the same Ctrl+R / Esc.
  unsubs.push(whenCrashSnapshotFound(conversation, ({ info }) => {
    if (recoveryPending !== info.sessionId) announceRecoveryOffer(info, systemMessageRouter, render);
    recoveryPending = info.sessionId;
    // The opened session is now live: its writes keep this snapshot apart until it is restored or discarded.
    holdOfferedRecoverySnapshot(ctx.services.surface, info.sessionId);
    return 'offered';
  }));
  applyInitialTuiCliState({
    cli,
    input,
    commandRegistry,
    commandContext,
    shellPaths: ctx.services.shellPaths,
    surface: ctx.services.surface,
    render,
  });

  const routeInput = (data: string): void => {
    // The administrative gesture has one input owner throughout its I/O. A
    // new blocking prompt cancels it before that prompt may consume any key.
    if (setupPairing?.ownsInput) {
      if (pendingPermission || recoveryPending || daemonRepairPrompt?.pending()) setupPairing.cancelForTakeover();
      input.feed(data);
      return;
    }
    const blocking = handleBlockingShellInput({
      data,
      pendingPermission,
      recoveryPending,
      abortTurn: () => orchestrator.abort(),
      composerEmpty: input.prompt.length === 0,
      systemMessageRouter,
      render,
      // Keyed to the OFFERED snapshot's sessionId (recoveryPending) so a
      // second, unrelated recovery snapshot on disk is never touched.
      applyRecovery: buildAgentRecoveryApply({
        surface: ctx.services.surface,
        sessionManager: ctx.services.sessionManager,
        runtime,
        conversation,
        hydrateSessionUsage: commandContext.session?.hydrateSessionUsage,
      }),
      removeRecoveryPoint: () => {
        removeRecoveryPoint(ctx.services.surface, recoveryPending ?? undefined);
      },
    });
    ({ pendingPermission, recoveryPending } = blocking);
    if (blocking.handled) {
      render();
      return;
    }
    // The question card's keys (arrows, 1-9, Enter, Esc) while it is on screen and the composer is empty.
    if (input.prompt.length === 0 && ownerQuestionCard.handleInput(data)) return;
    // Alt+X sends the next message as an ordinary one instead of the answer to a contract's question.
    if (contractQuestions.handleChord(data)) {
      render();
      return;
    }

    input.feed(data);
  };
  // Strip the terminal probe replies (OSC 11, and OSC 10 / OSC 4 for the palette) before the input pipeline sees them.
  stdin.on('data', (raw: string) => {
    const data = themeProbe.filterInput(raw);
    if (data.length > 0) routeInput(data);
  });
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', terminalClosed);
  process.on('SIGHUP', terminalClosed);
  stdin.on('end', terminalClosed);
  stdin.on('close', terminalClosed);
  stdout.on('resize', resizeHandler);

  conversation.rebuildHistory();
  render();
  const followups = startFirstRenderFollowups({
    shellPaths: ctx.services.shellPaths,
    providerRegistry,
    commandContext,
    // The connected-host controller's daemon: an accepted repair re-probes and adopts it in this session.
    daemonRepair: { config: configManager, ask: createDaemonRepairQuestion(input), host: ctx.daemonHost },
    askWorkspaceRegistration: createWorkspaceRegistrationQuestion(input),
    isHostedTurn: (turnId) => remoteConversation.isHostedTurn?.(turnId) ?? false,
    autonomy,
    buildCurrentSessionSnapshot,
    runtime,
    conversation,
    workingDir,
    homeDirectory,
    surface: ctx.services.surface,
    systemMessageRouter,
    render,
    unsubs,
    uiServicesTurns: uiServices.events.turns,
    hookDispatcher,
    onStreamSpeedUpdate: (speed) => {
      streamTokenSpeed = speed;
    },
  });
  // A resume at start-up may already have offered its session's snapshot.
  recoveryPending = followups.recoveryPending ?? recoveryPending;
  daemonRepairPrompt = followups.daemonRepairPrompt;
  render();
}
/** Runs the terminal UI for a command line that `prepareShellCliRuntime` left to it. */
export function runInteractive(prepared: PreparedShellCliRuntime): Promise<void> {
  return main(prepared).catch(async (err: unknown) => {
    // Leave the alternate screen and input modes first, so the explanation below
    // lands on the user's own screen and their shell is usable afterwards.
    try { restoreTerminalAfterFailedStartup?.(); } catch { /* best effort before the fatal report */ }
    await releaseFailedStartupSession?.();
    reportFatalStartupError(
      err,
      {
        binary: 'goodvibes-agent',
        debug: envFlag(process.env['GOODVIBES_AGENT_DEBUG']),
      },
      {
        logError: (message, context) => logger.error(message, context),
        // NOT process.stderr.write: installFullScreenTerminalOutputGuard above
        // replaces it, so a failure raised after that install had its explanation
        // intercepted and swallowed, measured on a compiled binary as exit 1 with
        // zero bytes on both streams. A descriptor write cannot be intercepted.
        writeStderr: writeFatalLine,
        exit: (code) => process.exit(code),
      },
    );
  });
}
