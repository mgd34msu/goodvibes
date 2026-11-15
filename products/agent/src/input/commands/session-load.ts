import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { loadSavedSessionIntoLive as loadSavedSession } from '@goodvibes-jev/engine/terminal-shell/session-resume';
import type { CommandContext } from '../command-registry.ts';

export interface LoadedSavedSession {
  readonly name: string;
  readonly messageCount: number;
  /** The Agent runs no connected-host agents, so saved agent records are counted and not restored. */
  readonly agentRecordCount: number;
  readonly restoredAnchorCount: number;
}

/** `/load`, the `/sessions` list and the session picker: the shared load, plus the Agent's hosted-session and last-session bookkeeping. */
export function loadSavedSessionIntoLive(
  ctx: Pick<CommandContext, 'isGenerating' | 'session' | 'abandonHostedSession'>,
  sessionManager: Pick<SessionManager, 'load'>,
  name: string,
): LoadedSavedSession {
  const loaded = loadSavedSession({
    conversation: ctx.session.conversationManager,
    runtime: ctx.session.runtime,
    surface: ctx.session.surface,
    restoreTurnAnchors: ctx.session.restoreTurnAnchors,
    isGenerating: ctx.isGenerating,
    afterSwitch: (sessionId) => {
      ctx.abandonHostedSession?.();
      ctx.session.writeLastSessionPointer?.(sessionId);
    },
  }, sessionManager, name);
  return {
    name: loaded.name,
    messageCount: loaded.messageCount,
    agentRecordCount: loaded.agentRecords.length,
    restoredAnchorCount: loaded.restoredAnchorCount,
  };
}
