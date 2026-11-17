import type { SessionManager, SessionMeta } from '@goodvibes-jev/engine/platform/platform/sessions';
import {
  describeResumeShortfalls,
  loadSavedSessionIntoLive as loadSavedSession,
  type LoadSavedSessionOptions,
} from '@goodvibes-jev/engine/terminal-shell/session-resume';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext } from '../command-registry.ts';

export interface LoadedSavedSession {
  readonly name: string;
  readonly meta: SessionMeta;
  /** Messages now in the conversation. */
  readonly messageCount: number;
  /** The Agent runs no connected-host agents, so saved agent records are counted and not restored. */
  readonly agentRecordCount: number;
  readonly restoredAnchorCount: number;
  /** Lines for the person about what the load left out (a damaged side branch) or could not recover. */
  readonly notices: readonly string[];
}

/**
 * `/session resume`, `/load`, the `/sessions` list and the session picker: the
 * one resume routine (turn check, liveness marker move, `force`, journal replay,
 * the saved model re-resolved through the provider registry, rewind anchors,
 * footer usage), plus the Agent's hosted-session and last-session bookkeeping
 * and the session-resumed announcement (hooks), so every way of opening a
 * session publishes it the same way.
 */
export async function loadSavedSessionIntoLive(
  ctx: Pick<CommandContext, 'isGenerating' | 'session' | 'abandonHostedSession'> & Partial<Pick<CommandContext, 'clients'>>,
  sessionManager: Pick<SessionManager, 'load' | 'save'>,
  name: string,
  options: LoadSavedSessionOptions = {},
): Promise<LoadedSavedSession> {
  const providerApi = ctx.clients?.providerApi;
  const loaded = await loadSavedSession({
    conversation: ctx.session.conversationManager,
    runtime: ctx.session.runtime,
    surface: ctx.session.surface,
    selectModel: providerApi ? (model) => providerApi.selectModel(model) : undefined,
    hydrateSessionUsage: ctx.session.hydrateSessionUsage,
    isGenerating: ctx.isGenerating,
    afterSwitch: (sessionId) => {
      ctx.abandonHostedSession?.();
      ctx.session.writeLastSessionPointer?.(sessionId);
    },
    recoveryFailed: (sessionId, error) => ctx.session.announceSessionRecoveryFailed?.(sessionId, summarizeError(error)),
  }, sessionManager, name, options);
  ctx.session.announceSessionResumed?.(loaded.name, loaded.messageCount);
  return {
    name: loaded.name,
    meta: loaded.meta,
    messageCount: loaded.messageCount,
    agentRecordCount: loaded.agentRecords.length,
    restoredAnchorCount: loaded.restoredAnchorCount,
    notices: describeResumeShortfalls(loaded),
  };
}
