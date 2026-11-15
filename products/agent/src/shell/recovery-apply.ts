/**
 * recovery-apply.ts, what accepting a crash-recovery snapshot does in the agent.
 *
 * Loading, applying and forgetting a snapshot is a sequence that goes wrong in
 * the middle: a snapshot deleted before the conversation accepted it is lost
 * with the failure, and one applied without the journal tail is older than the
 * last thing the process logged. The platform's `applyRecoverySnapshot` keeps
 * the file until the conversation accepted it, replays the journal on top, and
 * never throws. This module binds it to the agent's live objects and finishes
 * the restore: the runtime moves to the snapshot's session, the restored
 * conversation is persisted so `sessions resume` can reach it, and the
 * last-session pointer names it.
 */
import { applyRecoverySnapshot, confirmRecoveryRestore } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { ApplyRecoverySnapshotResult } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { writeLastSessionPointer, type SessionSurface } from '@/runtime/index.ts';
import type { SessionBranches, SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { ConversationManager, ConversationMessageSnapshot } from '../core/conversation.ts';
import { describeLeftOutBranches, readSavedBranches } from '../core/session-resume-core.ts';

export interface AgentRecoveryApplyInput {
  readonly surface: SessionSurface;
  readonly sessionManager: Pick<SessionManager, 'save'> & Partial<Pick<SessionManager, 'load'>>;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly conversation: ConversationManager;
  readonly hydrateSessionUsage?: (() => void) | undefined;
  /** Shows the person a line about the restore (a side branch left out). */
  readonly notify?: ((line: string) => void) | undefined;
}

/**
 * The function the Ctrl+R handler calls with the OFFERED snapshot's session id.
 * Only the owner's key press reaches it, which is what the confirmation stands for.
 */
export function buildAgentRecoveryApply(input: AgentRecoveryApplyInput): (sessionId: string) => ApplyRecoverySnapshotResult {
  return (sessionId) => {
    // Saving over a session replaces the whole file, so side branches made with
    // /branch are carried across: the live conversation's, or else the saved ones.
    const carriedBranches = (): SessionBranches | undefined => {
      const live = input.conversation.branchState?.();
      if (live && (Object.keys(live.branches).length > 0 || live.currentBranch !== 'main')) return live;
      try {
        return input.sessionManager.load?.(sessionId).branches;
      } catch {
        return undefined;
      }
    };
    const persist = (messages: ConversationMessageSnapshot[]): void => {
      input.sessionManager.save(sessionId, messages as never[], {
        title: input.conversation.title || '',
        model: input.runtime.model,
        provider: input.runtime.provider,
        timestamp: Date.now(),
        // The owner chose to recover this session; a retention sweep must not expire it.
        saveSource: 'user',
      }, undefined, undefined, carriedBranches());
    };
    const result = applyRecoverySnapshot({
      sessionId,
      conversation: input.conversation,
      surface: input.surface,
      persistSnapshot: persist,
      confirmation: confirmRecoveryRestore(true)!,
    });
    if (!result.applied) return result;
    // The transcript journal and every later snapshot key off runtime.sessionId,
    // so it moves only once the restore really happened.
    input.runtime.sessionId = sessionId;
    // The restore reset the live conversation, which dropped the side branches;
    // without them back in memory the next turn's autosave rewrites the session without them.
    const branches = carriedBranches();
    if (branches) {
      const saved = readSavedBranches(sessionId, branches);
      input.conversation.fromJSON({
        messages: input.conversation.getMessageSnapshot(),
        title: input.conversation.title,
        titleSource: input.conversation.getTitleSource(),
        branches: saved.branches,
        currentBranch: branches.currentBranch,
      });
      for (const line of describeLeftOutBranches(saved.leftOut)) input.notify?.(`[Recovery] ${line}`);
    }
    // The snapshot file is gone now; until this lands the recovered conversation
    // exists only in memory.
    persist(input.conversation.getMessageSnapshot() as ConversationMessageSnapshot[]);
    writeLastSessionPointer(sessionId, { surface: input.surface });
    input.hydrateSessionUsage?.();
    return result;
  };
}
