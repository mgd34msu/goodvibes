/**
 * What the Agent supplies to the Sessions place (terminal-shell
 * places/sessions-place.ts): its saved sessions in this project with the open
 * one. The Agent keeps one line of conversation and joins no hosted session.
 */
import type { SessionsPlaceHost } from '@goodvibes/engine/terminal-shell/places';
import type { CommandContext } from '../command-registry.ts';
import { requireSessionManager } from './runtime-services.ts';

export function sessionsPlaceHostOf(ctx: CommandContext): SessionsPlaceHost {
  return {
    sessionManager: () => {
      try { return requireSessionManager(ctx); } catch { return null; }
    },
    sessionsDir: () => ctx.workspace.surface?.sessionsDir,
    current: () => ({
      id: ctx.session.runtime.sessionId,
      title: ctx.session.conversationManager.title,
      messages: ctx.session.conversationManager.getMessageCount(),
      model: ctx.session.runtime.model,
      provider: ctx.session.runtime.provider,
    }),
    // The Agent keeps one line of conversation: the list is empty, which is what is true ("This conversation has no branches.").
    branches: () => [],
  };
}
