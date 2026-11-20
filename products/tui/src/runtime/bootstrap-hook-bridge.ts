import { publishResumedSession } from '@goodvibes/engine/terminal-shell/session-resume-publication';
import { activeTokens } from '../renderer/theme.ts';
import type { ConversationManager } from '../core/conversation';
import type { HookDispatcher } from '@goodvibes/engine/platform/platform/hooks';
import type { MutableRuntimeState } from '@/runtime/index.ts';
import type { RuntimeEventBus } from '@/runtime/index.ts';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import { emitSessionResumed } from '@/runtime/index.ts';
import { emitSessionRecoveryFailed } from '@goodvibes/engine/platform/platform/runtime/emitters';
import type { ConfigManager, HelperModel } from '@goodvibes/engine/platform/platform/config';
import type { SharedSessionBroker } from '@goodvibes/engine/platform/platform/control-plane';
import type { SessionSpineClient } from '@goodvibes/engine/platform/platform/runtime/session-spine';
import type { SessionManager } from '@goodvibes/engine/platform/platform/sessions';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { describeResumeShortfalls, resumeSessionCore, type SessionAgentRecordSink, type SessionResumeOutcome } from '../core/session-resume-core.ts';
import type { SessionSurface } from '@/runtime/index.ts';

export interface ResumeSessionOptions {
  readonly runtimeBus: RuntimeEventBus;
  readonly runtime: MutableRuntimeState;
  readonly conversation: ConversationManager;
  readonly requestRender: () => void;
  readonly onSessionIdChanged?: (sessionId: string) => void;
  /** Revokes the replaced session's pending work (command readings). */
  readonly cancelSessionWork?: () => void;
  readonly sharedSessionBroker: Pick<SharedSessionBroker, 'reopenSession'>;
  /** Fire-and-forget daemon-spine mirror. Reopen (not register) is the
   * ONLY resume-time verb, see the platform session-spine client.ts header doc. */
  readonly sessionSpine: Pick<SessionSpineClient, 'reopen'> & Partial<Pick<SessionSpineClient, 'close'>>;
  readonly project: string;
  readonly writeLastSessionPointer: (sessionId: string) => void;
  readonly hookDispatcher: HookDispatcher;
  readonly sessionManager: SessionManager;
  /** The app's declare-once session-storage handle, the same one /session resume threads. */
  readonly surface: SessionSurface;
  /**
   * Multi-instance guard for this seam. Resolves false when the operator
   * declines to fork a session another terminal still has open. Optional so a
   * host without a modal surface keeps the seam's original behavior.
   */
  readonly confirmLiveResume?: (sessionId: string) => Promise<boolean>;
  readonly configManager: Pick<ConfigManager, 'get' | 'getCategory'>;
  /** The runtime's one helper route, for the assisted resume summary. */
  readonly helperModel: Pick<HelperModel, 'chat'>;
  /** See CommandSessionServices.hydrateSessionUsage (command-registry.ts). */
  readonly hydrateSessionUsage?: () => void;
  /**
   * Reselects the resumed session's saved model through the live provider
   * registry once the transcript is committed. Optional so a caller without a
   * provider API wired keeps the saved model id as it is.
   */
  readonly selectModel?: (model: string) => Promise<{ readonly registryKey: string; readonly providerId: string }>;
  readonly isGenerating?: () => boolean;
}

/** How one caller of the resume routine wants it run. */
export interface ResumeSessionCallOptions {
  /**
   * The caller prints its own lines from the returned outcome and wants a
   * failure thrown to it; the routine then logs nothing itself. The session
   * browser leaves this off and the routine reports in the conversation.
   */
  readonly quiet?: boolean | undefined;
  /** The caller already decided about a session open in another terminal (`--force`, or its own check). */
  readonly liveChecked?: boolean | undefined;
  /** Replace the live agent list with the session's saved agent records (`/load`, `/sessions`). */
  readonly agents?: SessionAgentRecordSink | undefined;
}

/** What a resume did, for a caller that prints its own lines. */
export type ResumedSession = SessionResumeOutcome;

/**
 * The terminal app's one resume routine: `/session resume` (and the
 * `--continue`, `--resume` and `sessions resume` start-up flags that run it),
 * `/load`, Enter in `/sessions` and the session browser all come here, so each
 * writes the last-session pointer, reopens the shared session and the daemon
 * spine, fires the `Lifecycle:session:load` hook and announces the resume.
 *
 * The restore itself (transcript, model, rewind anchors, agent
 * records, footer usage) is resumeSessionCore, the routine every terminal app
 * and the headless start-up share. Everything after it is the publication only
 * a running terminal does (hook fire, session-spine mirror, shared-broker
 * reopen, last-session pointer) plus this seam's own log/render idiom.
 */
export function createResumeSessionHandler(options: ResumeSessionOptions): (sessionId: string, call?: ResumeSessionCallOptions) => Promise<ResumedSession | undefined> {
  return async (sessionId: string, call: ResumeSessionCallOptions = {}): Promise<ResumedSession | undefined> => {
    // Set once the refusal checks passed: a failure from here on is the saved session
    // failing to load or restore, which the ops playbooks read as a recovery failure.
    let restoring = false;
    try {
      // Loading replaces the live conversation, which a running turn is still appending to.
      if (options.isGenerating?.()) throw new Error('A turn is still running, so no session was loaded and the conversation is unchanged. Stop it with Esc or let it finish, then retry.');
      // Multi-instance safety, matching what `/session resume` already does
      // for the text path: never fork a session another terminal is holding
      // open without the operator saying so.
      if (!call.liveChecked && options.confirmLiveResume && !(await options.confirmLiveResume(sessionId))) {
        if (call.quiet) throw new Error('Resume cancelled: the session is still open in another terminal. Nothing changed.');
        options.conversation.log('Resume cancelled: the session is still open in another terminal.', { fg: activeTokens().textMuted });
        options.requestRender();
        return undefined;
      }
      restoring = true;
      // The session this process was running leaves the daemon's live list once a
      // resume replaces it; left open it would keep being kept alive until the
      // daemon's reaper retired it.
      const previousSessionId = options.runtime.sessionId;
      const outcome = await resumeSessionCore(sessionId, {
        sessionManager: options.sessionManager,
        conversation: options.conversation,
        runtime: options.runtime,
        surface: options.surface,
        selectModel: options.selectModel,
        hydrateSessionUsage: options.hydrateSessionUsage,
        canResume: () => !options.isGenerating?.(),
        // After the last refusal check and before the session is replaced: revoked
        // work must land while it still belongs to the old session, and a refused
        // resume must leave it standing.
        beforeRestore: () => options.cancelSessionWork?.(),
        agents: call.agents,
      });
      const { meta } = outcome;
      // Announced only once the resume happened: a refused one must not tell
      // telemetry a session resumed.
      emitSessionResumed(
        options.runtimeBus,
        {
          sessionId: previousSessionId,
          traceId: `${previousSessionId}:session-resume:${sessionId}`,
          source: 'bootstrap',
        },
        {
          sessionId,
          // The saved session's message count.
          turnCount: outcome.savedMessageCount,
        },
      );
      publishResumedSession(options, sessionId, meta, {
        announce: !call.quiet,
        reopen: () => {
          if (previousSessionId !== sessionId) options.sessionSpine.close?.(previousSessionId);
          options.sessionSpine.reopen({ sessionId, project: options.project, title: options.conversation.title || meta.title });
        },
        reentry: (summary) => {
          const lines: string[] = [];
          const runner = summary.remoteRunners?.[0];
          if (runner) lines.push(`Resume: Remote re-entry -> /remote recover ${runner}`);
          if ((summary.worktreePaths?.length ?? 0) > 0) lines.push('Resume: Worktree re-entry -> /worktree review');
          return lines;
        },
        hookError: 'Hook bridge fire error',
      });
      // A quiet caller (/load, /session resume) prints these itself; the picker
      // and the start-up resume rely on this line, so a left-out damaged branch
      // is named before the next save drops it.
      if (!call.quiet) {
        for (const line of describeResumeShortfalls(outcome)) options.conversation.log(line, { fg: activeTokens().warning });
      }
      options.requestRender();
      return outcome;
    } catch (error) {
      const reason = summarizeError(error);
      logger.debug('resumeSession failed', { error: reason });
      if (restoring) {
        emitSessionRecoveryFailed(options.runtimeBus, {
          sessionId: options.runtime.sessionId,
          traceId: `${options.runtime.sessionId}:session-resume:${sessionId}`,
          source: 'bootstrap',
        }, { sessionId, error: reason });
      }
      if (call.quiet) throw error;
      options.conversation.log(`Failed to resume session: ${reason}`, { fg: activeTokens().error });
    }
    options.requestRender();
    return undefined;
  };
}
