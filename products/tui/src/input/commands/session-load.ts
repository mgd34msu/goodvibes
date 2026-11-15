import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import {
  loadSavedSessionIntoLive as loadSavedSession,
  type LoadedSavedSession,
} from '@goodvibes-jev/engine/terminal-shell/session-resume';
import type { CommandContext } from '../command-registry.ts';

export type { LoadedSavedSession } from '@goodvibes-jev/engine/terminal-shell/session-resume';

/**
 * `/load` and the `/sessions` list: the shared load, with turn anchors read from the workspace's
 * session surface. Both callers in session-content.ts refuse a load while a turn runs first.
 */
export function loadSavedSessionIntoLive(
  ctx: Pick<CommandContext, 'session' | 'workspace'>,
  sessionManager: Pick<SessionManager, 'load'>,
  name: string,
): LoadedSavedSession {
  const surface = ctx.workspace.surface;
  return loadSavedSession({
    conversation: ctx.session.conversationManager,
    runtime: ctx.session.runtime,
    surface,
    restoreTurnAnchors: surface ? (sessionId) => restoreTurnAnchors(sessionId, surface) : undefined,
  }, sessionManager, name);
}
