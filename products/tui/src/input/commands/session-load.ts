import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import { restoreTurnAnchors } from '@goodvibes-jev/engine/platform/platform/rewind';
import {
  loadSavedSessionIntoLive as loadSavedSession,
  type LoadedSavedSession,
} from '@goodvibes-jev/engine/terminal-shell/session-resume';
import type { CommandContext } from '../command-registry.ts';

export type { LoadedSavedSession } from '@goodvibes-jev/engine/terminal-shell/session-resume';

/**
 * The shared restore with turn anchors read from the workspace's session
 * surface, for a context that has no resume routine wired (a test harness).
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

/** What `/load` and Enter in `/sessions` print. */
export type SessionLoadResult =
  | { readonly ok: true; readonly messageCount: number; readonly agentRecordsRestored: number; readonly notices: readonly string[] }
  | { readonly ok: false; readonly message: string };

/**
 * `/load <name>` and Enter in `/sessions`: one way to open a saved session,
 * through the terminal's resume routine (so the last-session pointer, the shared
 * session, the daemon spine and the load hook follow it), with the session's
 * saved agent records replacing the live list. Refused while a turn runs (the
 * caller checks) or while an agent of this session is still running, since
 * replacing the list would drop its record while it kept working.
 */
export async function loadSessionWithAgents(ctx: CommandContext, sessionManager: SessionManager, name: string): Promise<SessionLoadResult> {
  const agentManager = ctx.ops.agentManager;
  if (!agentManager) return { ok: false, message: 'Not loaded: the agent manager is not available in this runtime.' };
  const active = agentManager.listActive?.() ?? [];
  if (active.length > 0) {
    return {
      ok: false,
      message: [
        `Not loaded: ${active.length} agent${active.length === 1 ? ' is' : 's are'} still running in this session, and loading would drop ${active.length === 1 ? 'its record' : 'their records'}.`,
        ...active.map((agent) => `  ${agent.id}  ${agent.status}  ${agent.task.length > 80 ? `${agent.task.slice(0, 77)}...` : agent.task}`),
        `Wait for ${active.length === 1 ? 'it' : 'them'} to finish, or cancel with /ops agent cancel <id>, then load ${name} again.`,
      ].join('\n'),
    };
  }
  try {
    if (ctx.resumeSession) {
      const resumed = await ctx.resumeSession(name, { quiet: true, agents: agentManager });
      if (!resumed) return { ok: false, message: `Not loaded: ${name}. Nothing changed.` };
      return { ok: true, messageCount: resumed.resumedMessageCount, agentRecordsRestored: resumed.agentRecordsRestored, notices: resumed.notices };
    }
    const loaded = loadSavedSessionIntoLive(ctx, sessionManager, name);
    agentManager.clear();
    if (loaded.agentRecords.length > 0) agentManager.importState(loaded.agentRecords);
    return { ok: true, messageCount: loaded.messageCount, agentRecordsRestored: loaded.agentRecords.length, notices: loaded.notices };
  } catch (error) {
    return { ok: false, message: `Failed to load session: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The lines a successful load prints. */
export function describeSessionLoad(name: string, result: Extract<SessionLoadResult, { ok: true }>): string {
  return [
    `Session loaded: ${name} (${result.messageCount} messages)${result.agentRecordsRestored > 0 ? ` [${result.agentRecordsRestored} agent records restored]` : ''}`,
    ...result.notices.map((line) => `  ${line}`),
  ].join('\n');
}
