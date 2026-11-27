import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { NoticeLevel } from '@goodvibes/engine/platform/platform/core';
import type { HookDispatcher, HookEventPath, HookPhase, HookCategory } from '@goodvibes/engine/platform/platform/hooks';
import {
  checkRecoveryFile,
  createShellPathService,
  deleteRecoveryFile,
  persistConversation,
  writeRecoveryFile,
} from '@/runtime/index.ts';
import type { RecoveryFileInfo, SessionSnapshot, SessionSurface } from '@/runtime/index.ts';
import { closeSessionHere, crashSnapshotTurn, holdOfferedRecoverySnapshot, openSessionHere, writeCrashSnapshotAtTurnMoments, type CrashSnapshotTurnMoment } from '@goodvibes/engine/platform/platform/runtime/operations';
import { moveLiveSessionArtifacts } from '../core/session-resume-core.ts';
import { readOnboardingCheckMarker } from '../runtime/onboarding/index.ts';
import { deriveOnboardingState } from '../runtime/onboarding/onboarding-state.ts';
import { readOnboardingDoneMarker } from '../runtime/onboarding/completion.ts';
import { buildSetupIncompleteHint } from '../core/setup-incomplete-hint.ts';
import { isBroadWorkspaceRoot, normalizeWorkspaceRoot, registerStartedWorkspace, resolveWorkspaceRegistrationSync } from '../config/workspace-registration.ts';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { repairDaemonConnection } from './daemon-repair-prompt.ts';
import { recoveryOfferLine } from '@goodvibes/engine/terminal-shell/session-crash-recovery';
import { setSplashRecoveryLine } from '@goodvibes/engine/terminal-shell/first-run';
import { diagnoseDaemonRepair, type DaemonHost, type DaemonRepairConfig } from '../runtime/daemon-repair.ts';
import type { DaemonCliRunner } from '../runtime/daemon-cli-service.ts';

export interface SessionPersistenceAndRecoveryDeps {
  readonly buildCurrentSessionSnapshot: () => SessionSnapshot;
  readonly runtime: { readonly sessionId: string; readonly model: string; readonly provider: string };
  /** `hasPartialReply` says whether a reply is still arriving, recorded in the crash snapshot. */
  readonly conversation: { readonly title?: string | null; hasPartialReply(): boolean };
  readonly workingDir: string;
  readonly homeDirectory: string;
  /** Declare-once session-storage handle (platform/runtime/session-surface.ts); threaded through every persistConversation/checkRecoveryFile/writeRecoveryFile call below instead of loose workingDirectory/homeDirectory options. */
  readonly surface: SessionSurface;
  readonly systemMessageRouter: { high(message: string, level?: NoticeLevel): void; low(message: string): void; userAction(message: string, level?: NoticeLevel): void };
  readonly render: () => void;
  readonly unsubs: Array<() => void>;
  readonly uiServicesTurns: {
    on(event: 'TURN_COMPLETED' | 'STREAM_START' | 'STREAM_DELTA' | 'TURN_SUBMITTED' | 'TOOL_BATCH_READY' | 'TOOLS_DONE', handler: (event?: { readonly turnId?: string }) => void): () => void;
  };
  /**
   * True for a turn the connected host ran (shell/remote-conversation-wiring.ts).
   * Its transcript is kept by the host and mirrored under the hosted id, so the
   * local autosave and crash snapshot skip it instead of saving a second copy.
   */
  readonly isHostedTurn?: ((turnId: string) => boolean) | undefined;
  readonly hookDispatcher: HookDispatcher;
  /**
   * Called whenever the computed stream-token speed changes so that main.ts
   * (which owns the render closure) can keep the value up to date.
   */
  readonly onStreamSpeedUpdate: (tokensPerSecond: number) => void;
  /**
   * The wedged-machine check (runtime/daemon-repair.ts). Absent in the narrow
   * test fixtures that only exercise persistence/recovery; when present, a
   * machine whose daemon is off in both places is repaired at once, nothing
   * asked, and the person told in one line (shell/daemon-repair-prompt.ts).
   */
  readonly daemonRepair?: {
    readonly config: DaemonRepairConfig;
    /** Runs the daemon's own CLI for the install step. */
    readonly runDaemonCli?: DaemonCliRunner | undefined;
    /** The connected-host controller's daemon, so the repair adopts the daemon in this session. */
    readonly host?: DaemonHost | undefined;
  } | undefined;
  /**
   * Registers the folder this launch started in when it is not registered yet
   * (the interactive shell sets it: starting the Agent there is the request to
   * work there), and says so in one line. Absent, nothing is registered.
   */
  readonly registersStartedWorkspace?: boolean | undefined;
}

export interface SessionPersistenceAndRecoveryResult {
  /**
   * The sessionId of the offered recovery snapshot when an unsaved session
   * was found and the user prompt was shown; null otherwise. Threading the
   * actual id (not just a found/not-found boolean) lets the caller consume
   * or remove EXACTLY the snapshot it offered, even when more than one
   * snapshot exists on disk, see checkRecoveryFile's RecoveryFileInfo.sessionId.
   */
  recoveryPending: string | null;
  /** The workspace root this launch registered (started there, not registered before), null when it registered none. */
  workspaceRegistered: string | null;
}

/**
 * Tell the person, in one line, that a crash snapshot can be restored (an
 * offer that blocks nothing: terminal-shell recoveryOfferLine): Ctrl+R restores
 * it, Esc discards it, typing starts a new conversation and leaves it for the
 * next launch. The same line at start-up and when a session opened later turns
 * out to have one.
 */
export function announceRecoveryOffer(
  info: Pick<RecoveryFileInfo, 'timestamp' | 'title'>,
  systemMessageRouter: { userAction(message: string, level?: NoticeLevel): void },
  render: () => void,
): void {
  // Drawn under the splash where the person is looking (cleared when the offer closes), and kept in System, Notices.
  setSplashRecoveryLine(recoveryOfferLine(info));
  systemMessageRouter.userAction(recoveryOfferLine(info));
  render();
}

/**
 * Wires streaming-speed event subscriptions, auto-save on turn completion,
 * the session lock, and the post-first-render recovery-file check.
 *
 * Call AFTER the first render() so that:
 * - announceAwayDigest has already run
 * - startHardwareProbe has already fired
 * - The recovery prompt lands as ambient context, not a startup blocker
 */
export function wireSessionPersistenceAndRecovery(
  deps: SessionPersistenceAndRecoveryDeps,
): SessionPersistenceAndRecoveryResult {
  const {
    buildCurrentSessionSnapshot,
    runtime,
    conversation,
    workingDir,
    homeDirectory,
    surface,
    systemMessageRouter,
    render,
    unsubs,
    uiServicesTurns,
    hookDispatcher,
    onStreamSpeedUpdate,
    daemonRepair,
  } = deps;
  const shellPaths = createShellPathService({ workingDirectory: workingDir, homeDirectory });

  // --- Streaming speed + tool preview wiring ---
  let streamStartTime = 0;
  let streamDeltaCount = 0;

  // The session lock tells a second terminal this session is open here, so it
  // neither offers this terminal's live recovery snapshot nor forks the
  // session; the kernel lets it go if this process dies, so nothing refreshes
  // it. Every path that moves the live session id moves it (resume, fork,
  // `/session save <name>`, a recovery restore); the turn moment below is the
  // backstop, one string compare.
  let liveSessionId = runtime.sessionId;
  openSessionHere(surface, liveSessionId);
  const followLiveSession = (): void => {
    const sessionId = runtime.sessionId;
    // Held already: one map lookup. Not held because another process had it (a forced resume): taken now if it left.
    if (sessionId === liveSessionId) { openSessionHere(surface, liveSessionId); return; }
    try {
      moveLiveSessionArtifacts(surface, liveSessionId, sessionId);
    } catch (error) {
      logger.warn('[Recovery] Moving the session lock to the new session id failed', { error: summarizeError(error) });
    }
    liveSessionId = sessionId;
  };
  unsubs.push(() => {
    try {
      closeSessionHere(surface, runtime.sessionId);
    } catch (error) {
      logger.warn('[Recovery] Releasing the session lock failed', { error: summarizeError(error) });
    }
  });

  // The crash snapshot: written when a prompt is accepted and after each tool
  // batch (shared rule, runtime/session-persistence.ts), so a crash mid-turn
  // keeps the turn's work; the session save below is the copy after that and
  // deletes it, so a snapshot on disk always holds something the store does not.
  const writeCrashSnapshot = (moment: CrashSnapshotTurnMoment = 'TURN_COMPLETED'): void => {
    followLiveSession();
    writeRecoveryFile({ ...buildCurrentSessionSnapshot(), turn: crashSnapshotTurn(moment, conversation) }, runtime.sessionId, conversation.title ?? '', { surface });
  };
  const hostedTurn = (event: { readonly turnId?: string } | undefined): boolean =>
    event?.turnId !== undefined && deps.isHostedTurn?.(event.turnId) === true;
  unsubs.push(writeCrashSnapshotAtTurnMoments({
    subscribe: (moment, handler) => uiServicesTurns.on(moment, (event) => { if (!hostedTurn(event)) handler(); }),
    write: writeCrashSnapshot,
  }));

  // One notice per failing streak: a full disk would otherwise repeat it every turn.
  let autosaveFailing = false;
  unsubs.push(uiServicesTurns.on('TURN_COMPLETED', (event) => {
    // A hosted turn's record is the host's transcript, mirrored under its hosted id.
    if (hostedTurn(event)) return;
    // Auto-save after every LLM turn so kills don't lose the session
    try {
      const snapshot = buildCurrentSessionSnapshot();
      persistConversation(
        runtime.sessionId,
        snapshot,
        runtime.model,
        runtime.provider,
        conversation.title || '',
        { surface },
        // Automatic post-turn save, not a user-directed one, stays 'auto' so
        // the retention sweep can reclaim it (see /save's explicit 'user' save
        // in input/commands/session-content.ts).
        'auto',
      );
      deleteRecoveryFile({ surface }, runtime.sessionId);
      autosaveFailing = false;
      hookDispatcher.fire({ path: 'Lifecycle:session:save' as HookEventPath, phase: 'Lifecycle' as HookPhase, category: 'session' as HookCategory, specific: 'save', sessionId: runtime.sessionId, timestamp: Date.now(), payload: { sessionId: runtime.sessionId } }).catch((err: unknown) => logger.debug('hook fire error', { error: summarizeError(err) }));
    } catch (e) {
      logger.warn('auto-save on turn:complete failed', { error: summarizeError(e) });
      // The session file did not take this turn: the crash snapshot keeps it.
      try { writeCrashSnapshot(); } catch (error) {
        logger.warn('[Recovery] Crash snapshot after a failed save also failed', { error: summarizeError(error) });
      }
      if (!autosaveFailing) {
        autosaveFailing = true;
        systemMessageRouter.high('[Session] This session could not be saved after the last turn, so it may be lost if the process stops. Check free disk space and write access to the sessions directory; saving is retried after every turn.', 'error');
      }
    }
  }));

  unsubs.push(uiServicesTurns.on('STREAM_START', () => {
    streamStartTime = Date.now();
    streamDeltaCount = 0;
    onStreamSpeedUpdate(0);
  }));
  unsubs.push(uiServicesTurns.on('STREAM_DELTA', () => {
    streamDeltaCount++;
    const elapsed = (Date.now() - streamStartTime) / 1000;
    // Note: counts stream deltas, not actual tokens. ~1 delta per token for most providers.
    onStreamSpeedUpdate(elapsed > 0 ? streamDeltaCount / elapsed : 0);
  }));

  // Recovery file check: display prompt if an unsaved session exists.
  // Runs after the first render so the message lands as ambient context.
  // A snapshot whose session another terminal has open is that terminal's live
  // state; checkRecoveryFile does not report it, so Ctrl+R can never take and
  // delete a file another terminal is still writing.
  let recoveryPending: string | null = null;
  const recoveryInfo = checkRecoveryFile({ surface });
  if (recoveryInfo) {
    announceRecoveryOffer(recoveryInfo, systemMessageRouter, render);
    // Carry the OFFERED snapshot's sessionId (not just a boolean) so the
    // Ctrl+R/Esc handlers in blocking-input.ts consume/remove exactly this
    // snapshot, never a different one that happens to exist on disk.
    recoveryPending = recoveryInfo.sessionId;
    // Until it is restored or discarded, the live session's writes keep it apart instead of replacing it.
    holdOfferedRecoverySnapshot(surface, recoveryInfo.sessionId);
  }

  // The connection to the daemon on this computer, repaired with nothing asked
  // (as the boot-time autostart starts a stopped daemon): a machine whose
  // "Use the background daemon" is off while no daemon runs gets it turned back
  // on and its service started (installed first when there is none), and one
  // line says what was done, or why it could not be and what to do. The check
  // costs nothing on a healthy machine: it reads one setting and returns, and
  // only consults the service manager once that setting is already false.
  if (daemonRepair) {
    const offer = diagnoseDaemonRepair({ config: daemonRepair.config, host: daemonRepair.host });
    if (offer) {
      repairDaemonConnection({
        offer,
        config: daemonRepair.config,
        systemMessageRouter,
        render,
        host: daemonRepair.host,
        runDaemonCli: daemonRepair.runDaemonCli,
      });
    }
  }

  // Starting the Agent in a folder is the request to work there: a folder not
  // registered yet (or one an earlier build's start question recorded "Not here"
  // for) is registered now, with nothing asked, and the person is told in one
  // line what was registered and where it is undone. A folder already covered
  // (registered here, by the terminal app, or through a registered repository's
  // worktree) is left as it is, and a folder too broad to be a workspace (the
  // home folder, the file system's root) is never registered.
  let workspaceRegistered: string | null = null;
  if (deps.registersStartedWorkspace) {
    const resolution = resolveWorkspaceRegistrationSync(shellPaths, workingDir);
    if ((resolution.status === 'unknown' || resolution.status === 'declined') && !isBroadWorkspaceRoot(shellPaths, workingDir)) {
      // The folder's project (its repository's root when it is in one), never a subfolder of a repository, which
      // would be a project of its own once registered (workspace/project-identity.ts).
      const root = normalizeWorkspaceRoot(projectIdentityOf(workingDir));
      workspaceRegistered = root;
      void registerStartedWorkspace(shellPaths, root, resolution.status === 'declined').then((registered) => {
        const name = registered.root.split('/').filter(Boolean).at(-1) ?? registered.root;
        if (registered.outcome === 'registered') {
          systemMessageRouter.userAction(`[Workspace] Registered ${name} (${registered.root}) as a workspace${registered.overDecline ? ', replacing the "Not here" answered before' : ''}: the Agent works here and keeps automatic checkpoints. To undo: System, Workspaces, unregister.`, 'info');
        } else {
          systemMessageRouter.userAction(`[Workspace] ${name} could not be registered as a workspace: ${registered.reason}. The Agent's work cannot run here until it is; System, Workspaces, "register a folder" tries again.`, 'warning');
        }
        render();
      });
    }
  }

  return { recoveryPending, workspaceRegistered };
}

/**
 * Deps for the setup-incomplete hint, kept narrow so the function is easily
 * testable and doesn't pull in the full bootstrap context.
 */
export interface SetupIncompleteHintDeps {
  /**
   * Shell path service, used to locate onboarding marker files.
   * Must satisfy the minimal interface required by readOnboardingCheckMarker.
   */
  readonly shellPaths: Parameters<typeof readOnboardingCheckMarker>[0];
  /**
   * Whether a model route is currently configured and usable for chat.
   * Pass true when the provider registry has a ready model, false otherwise.
   */
  readonly providerReady: boolean;
  /**
   * Whether a local model route has been detected and is ready for chat.
   * Pass true when the local-model-cookbook status === 'detected-local-route'.
   * Omit or pass false when unavailable. Best-effort: errors should produce false.
   * This mirrors the 'local-model-readiness' plan item in the real buildSetupPlan.
   */
  readonly localReady?: boolean;
  /**
   * Whether the assistant service (connected host) is known to be running.
   * Pass true/false for a confirmed live signal; omit or pass null/undefined
   * when the signal is unreliable or unavailable at startup time.
   */
  readonly hostReady?: boolean | null;
  /** Low-priority message channel, same interface as SystemMessageRouter.low(). */
  readonly systemMessageRouter: { low(message: string): void };
}

/**
 * Derives the current onboarding state from disk markers and, if setup is
 * in-progress, pushes a plain-language hint to the conversation feed.
 *
 * Best-effort: any error is caught silently so startup is never blocked.
 * Call after the first render, alongside announceAwayDigest.
 */
export function wireSetupIncompleteHint(deps: SetupIncompleteHintDeps): void {
  try {
    const { shellPaths, providerReady, localReady, hostReady, systemMessageRouter } = deps;

    const checkMarker = readOnboardingCheckMarker(shellPaths, 'user');
    // The marker that decides "setup is done" everywhere (completion.ts).
    const completionMarker = readOnboardingDoneMarker(shellPaths);

    // Build a minimal plan with BOTH provider-access AND local-model-readiness so
    // that deriveReadyToChat mirrors the onboarding state's canonical definition:
    //   readyToChat = providerItem.ready OR localModelItem.ready
    //
    // local-model-readiness uses blocksAutonomy:false so it never becomes a false
    // blocker when only the local route is available (matching real plan behaviour).
    // We intentionally skip the full buildSetupPlan (requires CommandContext +
    // async collectSnapshot) because this is a best-effort ambient hint.
    const minimalPlan = [
      {
        id: 'provider-access',
        label: 'Model access',
        status: providerReady ? ('ready' as const) : ('blocked' as const),
        priority: 20,
        blocksAutonomy: true,
        reason: '',
        nextAction: 'Choose a model to start chatting.',
        userRoute: 'System, Setup, Choose a model (the menu, Ctrl+G then m)',
        modelRoute: '',
      },
      {
        id: 'local-model-readiness',
        label: 'Local model',
        status: localReady ? ('ready' as const) : ('recommended' as const),
        priority: 25,
        blocksAutonomy: false,
        reason: '',
        nextAction: 'Set up a local model route from Setup, in System in the menu.',
        userRoute: 'System, Setup, Choose a model (the menu, Ctrl+G then m)',
        modelRoute: '',
      },
    ];

    const state = deriveOnboardingState({ plan: minimalPlan, checkMarker, completionMarker });

    const hint = buildSetupIncompleteHint(state, hostReady);
    if (hint === null) return;

    for (const line of hint.lines) {
      systemMessageRouter.low(`[Setup] ${line}`);
    }
  } catch {
    // Never block startup on hint errors.
  }
}
