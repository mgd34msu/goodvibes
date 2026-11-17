import type { SessionManager } from '@goodvibes-jev/engine/platform/platform/sessions';
import {
  describeResumeShortfalls,
  loadSavedSessionIntoLive as loadSavedSession,
  type LoadedSavedSession,
  type SessionAgentRecordSink,
} from '@goodvibes-jev/engine/terminal-shell/session-resume';
import type { CommandContext } from '../command-registry.ts';

export type { LoadedSavedSession } from '@goodvibes-jev/engine/terminal-shell/session-resume';

/**
 * The shared resume routine for a context that has no terminal resume handler
 * wired (a test harness): same journal replay, model re-resolution, rewind
 * anchors and agent records, without the publication only a running terminal does.
 */
export function loadSavedSessionIntoLive(
  ctx: Pick<CommandContext, 'session' | 'workspace'> & Partial<Pick<CommandContext, 'clients' | 'isGenerating'>>,
  sessionManager: Pick<SessionManager, 'load' | 'save'>,
  name: string,
  agents?: SessionAgentRecordSink,
): Promise<LoadedSavedSession> {
  const providerApi = ctx.clients?.providerApi;
  return loadSavedSession({
    conversation: ctx.session.conversationManager,
    runtime: ctx.session.runtime,
    surface: ctx.workspace.surface,
    selectModel: providerApi ? (model) => providerApi.selectModel(model) : undefined,
    hydrateSessionUsage: ctx.session.hydrateSessionUsage,
    isGenerating: ctx.isGenerating,
    agents,
  }, sessionManager, name);
}

/** What `/load` and Enter in `/sessions` print. */
export type SessionLoadResult =
  | {
    readonly ok: true;
    readonly messageCount: number;
    readonly agentRecordsRestored: number;
    /** Turns that existed only in the transcript journal and were put back. */
    readonly journalReplayed: number;
    /** What the load left out or could not recover. */
    readonly notices: readonly string[];
  }
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
    const resumed = ctx.resumeSession
      ? await ctx.resumeSession(name, { quiet: true, agents: agentManager })
      : await loadSavedSessionIntoLive(ctx, sessionManager, name, agentManager);
    if (!resumed) return { ok: false, message: `Not loaded: ${name}. Nothing changed.` };
    return {
      ok: true,
      messageCount: resumed.resumedMessageCount,
      agentRecordsRestored: resumed.agentRecordsRestored,
      journalReplayed: resumed.journalReplay.replayed,
      notices: describeResumeShortfalls(resumed),
    };
  } catch (error) {
    return { ok: false, message: `Failed to load session: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The lines a successful load prints. */
export function describeSessionLoad(name: string, result: Extract<SessionLoadResult, { ok: true }>): string {
  return [
    `Session loaded: ${name} (${result.messageCount} messages)${result.agentRecordsRestored > 0 ? ` [${result.agentRecordsRestored} agent records restored]` : ''}`,
    ...(result.journalReplayed > 0
      ? [`  recovered ${result.journalReplayed} turn record${result.journalReplayed === 1 ? '' : 's'} written after the last save`]
      : []),
    ...result.notices.map((line) => `  ${line}`),
  ].join('\n');
}
