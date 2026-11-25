/**
 * What the Agent supplies to the Sessions place (terminal-shell
 * places/sessions-place.ts): its saved sessions in this project with the open
 * one, its bookmarked blocks, and the project's cross-session task graph (the
 * Agent changes only its own session's part of it: adds and cancels its own
 * tasks, accepts one handed to it, takes back one handed off from it). The Agent
 * keeps one line of conversation and joins no hosted session.
 */
import { projectTaskGraphPath } from '@goodvibes/engine/platform/platform/sessions';
import type { SessionsPlaceHost } from '@goodvibes/engine/terminal-shell/places';
import type { CommandContext } from '../command-registry.ts';
import { requireBookmarkManager, requireSessionManager, requireSessionOrchestration, requireShellPaths } from './runtime-services.ts';

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
    bookmarks: () => {
      try { return requireBookmarkManager(ctx).list(); } catch { return []; }
    },
    taskGraph: () => {
      try { return requireSessionOrchestration(ctx); } catch { return null; }
    },
    taskGraphFile: () => {
      try { return projectTaskGraphPath(requireShellPaths(ctx).workingDirectory); } catch { return undefined; }
    },
    // The Agent changes only its own session's part of the graph (session.ts `graphOwnTasksOnly`).
    ownTasksOnly: true,
  };
}
