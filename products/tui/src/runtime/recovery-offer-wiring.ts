/**
 * recovery-offer-wiring.ts, binds the crash-recovery offer
 * (runtime/recovery-prompt.ts) to this shell's live objects: the start-up
 * offer, and the offer the resume routine makes when a session opened later
 * (`/load`, `/sessions`, the picker, `/session resume`, `--continue`,
 * `--resume`) has a crash snapshot newer than its saved copy.
 *
 * Kept out of main.ts so the entrypoint stays under the architecture
 * line-count gate, and kept out of recovery-prompt.ts so that module stays a
 * pure flow with injectable edges (which is what makes it testable without a
 * booted runtime).
 *
 * Accepting a snapshot runs the shared restore every terminal app and the
 * headless resume run (terminal-shell session-crash-recovery.ts): the
 * conversation is rebuilt from the snapshot, a turn it ends inside is recorded
 * as interrupted, `runtime.sessionId` and the session lock move to the
 * recovered session once the restore really happened, the result is saved and
 * the last-session pointer names it. This module adds what only a running
 * terminal does: the daemon session spine moves to the recovered session, so
 * the daemon's live list names the session this surface is actually running.
 */
import { confirmRecoveryRestore } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { restoreCrashSnapshot } from '@goodvibes-jev/engine/terminal-shell/session-crash-recovery';
import { offerRecoverySnapshot, type RecoveryPromptDeps, type RecoveryTypeaheadHooks } from './recovery-prompt.ts';
import type { ConversationManager } from '../core/conversation.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { SessionSurface } from '@/runtime/index.ts';
import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import type { SessionSpineClient } from '@goodvibes-jev/engine/platform/platform/runtime/session-spine';

export interface RecoveryOfferWiringInput {
  readonly surface: SessionSurface;
  readonly sessionManager: Pick<SessionManager, 'save'> & Partial<Pick<SessionManager, 'load'>>;
  readonly runtime: { sessionId: string; model: string; provider: string };
  readonly conversation: ConversationManager;
  readonly commandContext: Pick<CommandContext, 'openSelection'> & {
    readonly session?: { readonly hydrateSessionUsage?: (() => void) | undefined } | undefined;
  };
  readonly writeLastSessionPointer: (sessionId: string) => void;
  /**
   * The daemon session spine, when one is wired. Moving to the recovered
   * session closes the boot session and registers the recovered one, the same
   * hand-over `/session resume` performs, so the daemon's live list names the
   * session this surface is actually running.
   */
  readonly sessionSpine?: Pick<SessionSpineClient, 'reopen'> & Partial<Pick<SessionSpineClient, 'close'>>;
  readonly project?: string;
  readonly receipt: (line: string) => void;
  readonly render: () => void;
  /** Holds typeahead out of the offer modal (see RecoveryPromptDeps.typeahead). */
  readonly typeahead?: RecoveryTypeaheadHooks;
}

export function buildRecoveryOfferWiring(input: RecoveryOfferWiringInput): RecoveryPromptDeps {
  return {
    surface: input.surface,
    // Read lazily: wireShellUiOpeners patches `openSelection` onto the command
    // context after this wiring is built, and the offer runs later still.
    get openSelection() { return input.commandContext.openSelection; },
    receipt: input.receipt,
    render: input.render,
    ...(input.typeahead ? { typeahead: input.typeahead } : {}),
    // The user picked "Resume it" in the offer modal; that answer, and nothing
    // else, is what unlocks the restore. A refusal leaves this terminal on its
    // own session with nothing persisted; the prompt turns it into a receipt.
    applySnapshot: (info) => restoreCrashSnapshot({
      surface: input.surface,
      info,
      sessionManager: input.sessionManager,
      runtime: input.runtime,
      conversation: input.conversation,
      confirmation: confirmRecoveryRestore(true)!,
      writeLastSessionPointer: input.writeLastSessionPointer,
      hydrateSessionUsage: input.commandContext.session?.hydrateSessionUsage,
      afterSwitch: (previousSessionId, sessionId) => {
        // The spine keys a session by project, so a surface with no project has nothing to register under.
        if (!input.sessionSpine || input.project === undefined) return;
        if (previousSessionId !== sessionId) input.sessionSpine.close?.(previousSessionId);
        input.sessionSpine.reopen({ sessionId, project: input.project, title: input.conversation.title || 'Recovered session' });
      },
    }),
  };
}

/**
 * What opening a session does here when it has a crash snapshot newer than its
 * saved copy: the same offer the start-up check makes, scoped to that session.
 * The modal opens now; the restore happens on the answer.
 */
export function offerCrashSnapshotOnOpen(deps: RecoveryPromptDeps): (found: { readonly info: { readonly sessionId: string } }) => 'offered' | 'declined' {
  return ({ info }) => {
    if (!deps.openSelection) return 'declined';
    void offerRecoverySnapshot({ ...deps, targetSessionId: info.sessionId });
    return 'offered';
  };
}
