import type { SessionManager } from '@goodvibes/engine/platform/platform/sessions';
import {
  loadSavedSessionIntoLive as loadSavedSession,
  type LoadedSavedSession,
  type SessionAgentRecordSink,
} from '@goodvibes/engine/terminal-shell/session-resume';
import type { CommandContext } from '../command-registry.ts';

export type { LoadedSavedSession } from '@goodvibes/engine/terminal-shell/session-resume';

/**
 * The shared resume routine for a context that has no terminal resume handler
 * wired (a test harness): same transcript restore, model re-resolution, rewind
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
