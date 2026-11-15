import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import { checkSessionLiveness, removeLivenessMarker, writeLivenessMarker } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { readConversationMessageSnapshots } from '@goodvibes-jev/engine/terminal-shell/conversation-message-snapshot';
import type { CommandContext } from '../command-registry.ts';
import { restoreLoadedSession } from '../../core/session-resume-core.ts';

export interface LoadedSavedSession {
  readonly messageCount: number;
  readonly agentRecords: ReturnType<SessionManager['load']>['agentRecords'];
}

/**
 * The one way `/load` and the `/sessions` list replace the live conversation with a saved session.
 * It reads and validates the saved messages before touching the live conversation, then moves the
 * session identity the way a resume does, so later autosaves go to the loaded session instead of
 * overwriting the one that was open. A session another running terminal has marked open is refused
 * (`/session resume <name> --force` is the explicit way to take it over), and the liveness marker
 * moves with the identity. Throws with the reason when the load does not happen; the live
 * conversation is untouched then.
 */
export function loadSavedSessionIntoLive(
  ctx: Pick<CommandContext, 'session' | 'workspace'>,
  sessionManager: Pick<SessionManager, 'load'>,
  name: string,
): LoadedSavedSession {
  const surface = ctx.workspace.surface;
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
  restoreLoadedSession(
    name,
    { meta, messages, ...(branches ? { branches } : {}) },
    {
      conversation: ctx.session.conversationManager,
      runtime: ctx.session.runtime,
      surface,
      restoreTurnAnchors: surface ? (sessionId) => restoreTurnAnchors(sessionId, surface) : undefined,
    },
  );
  if (surface && previousSessionId !== name) {
    removeLivenessMarker(surface, previousSessionId);
    writeLivenessMarker(surface, name);
  }
  return { messageCount: messages.length, agentRecords };
}
