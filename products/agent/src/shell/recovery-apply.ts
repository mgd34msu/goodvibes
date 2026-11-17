/**
 * recovery-apply.ts, what accepting a crash-recovery snapshot does in the agent.
 *
 * The Ctrl+R handler calls this with the OFFERED snapshot's session id, whether
 * it was offered at start-up or when a session opened later turned out to have
 * one. It runs the shared restore every terminal app and the headless resume
 * run (terminal-shell session-crash-recovery.ts): the conversation is rebuilt
 * from the snapshot, a turn it ends inside is recorded as interrupted (never
 * re-run), the runtime and the session lock move to the snapshot's session,
 * the result is saved so `sessions resume` can reach it, and the last-session
 * pointer names it. It never throws; the report says what happened.
 */
import { checkRecoveryForSession, confirmRecoveryRestore } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { restoreCrashSnapshot, type CrashRecoveryReport } from '@goodvibes-jev/engine/terminal-shell/session-crash-recovery';
import { writeLastSessionPointer, type SessionSurface } from '@/runtime/index.ts';
import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { ConversationManager } from '../core/conversation.ts';

export interface AgentRecoveryApplyInput {
  readonly surface: SessionSurface;
  readonly sessionManager: Pick<SessionManager, 'save'> & Partial<Pick<SessionManager, 'load'>>;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly conversation: ConversationManager;
  readonly hydrateSessionUsage?: (() => void) | undefined;
}

/**
 * The function the Ctrl+R handler calls with the OFFERED snapshot's session id.
 * Only the owner's key press reaches it, which is what the confirmation stands for.
 */
export function buildAgentRecoveryApply(input: AgentRecoveryApplyInput): (sessionId: string) => CrashRecoveryReport {
  return (sessionId) => {
    const info = checkRecoveryForSession(input.surface, sessionId);
    if (!info) {
      // Saved since it was offered, or another terminal opened that session: nothing here to restore.
      return { sessionId, applied: false, refusal: 'no-snapshot', retired: false, snapshotAt: 0, messageCount: 0, turns: 0, lost: [] };
    }
    return restoreCrashSnapshot({
      surface: input.surface,
      info,
      sessionManager: input.sessionManager,
      runtime: input.runtime,
      conversation: input.conversation,
      confirmation: confirmRecoveryRestore(true)!,
      writeLastSessionPointer: (id) => writeLastSessionPointer(id, { surface: input.surface }),
      hydrateSessionUsage: input.hydrateSessionUsage,
    });
  };
}
