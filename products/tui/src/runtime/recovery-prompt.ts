/**
 * recovery-prompt.ts, the crash-recovery offer: an offer that blocks nothing.
 *
 * When a conversation stopped before it was saved (a crash snapshot exists),
 * one line says so and names the control that restores it, the same line the
 * Agent says (terminal-shell session-crash-recovery.ts recoveryOfferLine):
 * Ctrl+R restores it, Esc on an empty composer discards it, and typing starts a
 * new conversation, the offer closing quietly for this run with the snapshot
 * kept on disk for the next start. Nothing opens over the composer.
 *
 * Rules this offer keeps:
 *   - Nothing is ever applied without Ctrl+R. The shared restore (terminal-shell
 *     session-crash-recovery.ts, over the platform's `applyRecoverySnapshot`)
 *     runs only then; it reads, retires and applies in one operation, so a
 *     failed read never destroys state that was never recovered.
 *   - The same offer is made at start-up (the newest snapshot) and whenever a
 *     session is opened later by any path (`/load`, `/sessions`, the picker,
 *     `--continue`, `--resume`) with a snapshot newer than its saved copy.
 *   - A snapshot whose session another running terminal has open is not
 *     offered (the platform's recovery checks skip it): it is that instance's
 *     live state.
 *   - Until it is restored or discarded, the live session's writes keep the
 *     offered snapshot apart instead of replacing it.
 */
import { checkRecoveryFile, checkRecoveryForSession, removeRecoveryPoint } from '@/runtime/index.ts';
import { holdOfferedRecoverySnapshot } from '@goodvibes/engine/platform/platform/runtime/operations';
import { describeCrashRecovery, recoveryOfferLine, RESTORE_RECOVERY_KEY, type CrashRecoveryReport } from '@goodvibes/engine/terminal-shell/session-crash-recovery';
import { setSplashRecoveryLine } from '@goodvibes/engine/terminal-shell/first-run';
import type { RecoveryFileInfo, SessionSurface } from '@/runtime/index.ts';

export interface RecoveryPromptDeps {
  readonly surface: SessionSurface;
  /**
   * Apply the offered snapshot to the live conversation and report what
   * happened (the shared restore). Called only on Ctrl+R.
   */
  readonly applySnapshot: (info: RecoveryFileInfo) => CrashRecoveryReport;
  /** The offer's one line, and each outcome's one line, where the person sees it. */
  readonly say: (line: string, level?: 'success' | 'warning' | 'error') => void;
  readonly render: () => void;
}

/** The offer in force in this program: made, then answered by a key or closed by typing. */
export interface RecoveryOffer {
  /** Offer the newest snapshot, or the named session's (a session opened later). */
  offer(targetSessionId?: string): void;
  /**
   * A key from the terminal while an offer stands: Ctrl+R restores, Esc on an
   * empty composer discards (both consumed: true); typing closes the offer
   * quietly and goes to the composer (false). Without an offer: false.
   */
  handleKey(data: string, composerEmpty: boolean): boolean;
}

export function createRecoveryOffer(deps: RecoveryPromptDeps): RecoveryOffer {
  let offered: RecoveryFileInfo | null = null;
  /** Snapshots closed by typing this run: not offered again until the next start. */
  const closed = new Set<string>();
  return {
    offer(targetSessionId) {
      try {
        const info = targetSessionId !== undefined
          ? checkRecoveryForSession(deps.surface, targetSessionId)
          : checkRecoveryFile({ surface: deps.surface });
        if (!info || closed.has(info.sessionId) || offered?.sessionId === info.sessionId) return;
        offered = info;
        holdOfferedRecoverySnapshot(deps.surface, info.sessionId);
        // Drawn under the splash where the person is looking, and kept in System, Notices.
        setSplashRecoveryLine(recoveryOfferLine(info));
        deps.say(recoveryOfferLine(info));
        deps.render();
      } catch {
        // Best-effort by construction: a failed offer leaves the snapshot untouched and the start unharmed.
      }
    },
    handleKey(data, composerEmpty) {
      const info = offered;
      if (!info) return false;
      const close = (): void => { offered = null; setSplashRecoveryLine(undefined); };
      if (data === RESTORE_RECOVERY_KEY) {
        close();
        const result = deps.applySnapshot(info);
        if (result.applied) deps.say(describeCrashRecovery(result), 'success');
        else if (result.refusal === 'apply-failed' || result.refusal === 'no-snapshot') deps.say('[Recovery] The conversation could not be restored; it was left on disk and is offered again at the next start. Nothing was changed in this one.', 'error');
        else deps.say('[Recovery] The saved conversation was damaged and held nothing, so it was discarded. Nothing was changed in this one.', 'warning');
        deps.render();
        return true;
      }
      // A lone Esc byte on an empty composer is the key; a longer escape sequence is a focus or mouse report, an arrow or a paste.
      if (data === '\x1b' && composerEmpty) {
        close();
        const { removed } = removeRecoveryPoint(deps.surface, info.sessionId);
        deps.say(removed ? '[Recovery] Discarded the conversation that was not saved.' : '[Recovery] It was already gone; nothing else was changed.');
        deps.render();
        return true;
      }
      // Reports the terminal sends on its own and navigation keys are not typing: the offer stays.
      if (data.startsWith('\x1b')) return false;
      // Typing starts a new conversation, as the line said: the offer closes quietly; the snapshot stays for the next start.
      close();
      closed.add(info.sessionId);
      return false;
    },
  };
}
