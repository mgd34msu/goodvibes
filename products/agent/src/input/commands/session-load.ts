import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { checkSessionLiveness, removeLivenessMarker, writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { CommandContext } from '../command-registry.ts';
import { readConversationMessageSnapshots } from '../../core/conversation-message-snapshot.ts';
import { restoreLoadedSession } from '../../core/session-resume-core.ts';

export interface LoadedSavedSession {
  readonly name: string;
  readonly messageCount: number;
  readonly agentRecordCount: number;
  readonly restoredAnchorCount: number;
}

/**
 * The one way a saved session replaces the live conversation outside `/session resume`
 * (`/load`, the `/sessions` list, the session picker). It refuses while a turn runs, reads
 * and validates the saved messages before touching the live conversation, and then switches
 * the session identity the same way a resume does, so later autosaves go to the loaded
 * session instead of overwriting the one that was open. A session another running terminal has
 * marked open is refused (`/session resume <name> --force` is the explicit way to take it over),
 * and the liveness marker moves with the identity so a second terminal sees the new session
 * as open right away and not the one that was left.
 * Throws with the reason when the load does not happen; the live conversation is untouched then.
 */
export function loadSavedSessionIntoLive(
  ctx: Pick<CommandContext, 'isGenerating' | 'session' | 'abandonHostedSession'>,
  sessionManager: Pick<SessionManager, 'load'>,
  name: string,
): LoadedSavedSession {
  if (ctx.isGenerating?.()) {
    throw new Error('A turn is still running. Stop it with Esc or let it finish, then load the session.');
  }
  const surface = ctx.session.surface;
  if (surface) {
    const liveness = checkSessionLiveness(surface, name);
    if (liveness.live && liveness.pid !== process.pid) {
      throw new Error(
        `Session ${name} appears open in another terminal (pid ${liveness.pid}): loading it here would fork its live state. `
          + `Run \`/session resume ${name} --force\` to take it over anyway.`,
      );
    }
  }
  const { meta, messages, agentRecords, branches } = sessionManager.load(name);
  readConversationMessageSnapshots(messages);
  const previousSessionId = ctx.session.runtime.sessionId;
  const restoredAnchorCount = restoreLoadedSession(
    name,
    { meta, messages, ...(branches ? { branches } : {}) },
    {
      conversation: ctx.session.conversationManager,
      runtime: ctx.session.runtime,
      restoreTurnAnchors: ctx.session.restoreTurnAnchors,
      surface: ctx.session.surface,
    },
  );
  ctx.abandonHostedSession?.();
  if (surface && previousSessionId !== name) {
    removeLivenessMarker(surface, previousSessionId);
    writeLivenessMarker(surface, name);
  }
  ctx.session.writeLastSessionPointer?.(name);
  return { name, messageCount: messages.length, agentRecordCount: agentRecords.length, restoredAnchorCount };
}
