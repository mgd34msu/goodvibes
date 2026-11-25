/**
 * What the terminal app supplies to the Sessions place (terminal-shell
 * places/sessions-place.ts): its saved sessions in this project with the open
 * one, this conversation's branches and bookmarked blocks, the project's
 * cross-session task graph, and the hosted session it joined.
 */
import { projectTaskGraphPath } from '@goodvibes/engine/platform/platform/sessions';
import type { SessionsPlaceHost } from '@goodvibes/engine/terminal-shell/places';
import type { CommandContext } from '../command-registry.ts';
import { requireBookmarkManager, requireSessionManager, requireSessionOrchestration, requireShellPaths } from './runtime-services.ts';
import { getSharedHostedSessionFeed } from '../../views/hosted-session-feed.ts';
import { hostedSessionLabel } from '../../runtime/client/hosted-sessions.ts';
import { renderHostedStatus } from './hosted-runtime.ts';

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
    branches: () => ctx.session.conversationManager.listBranches(),
    bookmarks: () => {
      try { return requireBookmarkManager(ctx).list(); } catch { return []; }
    },
    taskGraph: () => {
      try { return requireSessionOrchestration(ctx); } catch { return null; }
    },
    taskGraphFile: () => {
      try { return projectTaskGraphPath(requireShellPaths(ctx).workingDirectory); } catch { return undefined; }
    },
    joined: () => {
      const feed = getSharedHostedSessionFeed();
      const record = feed.getState().record;
      if (!record) return undefined;
      // The status block's first line names the session; the rest is the detail.
      // The row names it by its title: the status block's id line is left out.
      const lines = renderHostedStatus(feed).split('\n').slice(1).map((line) => line.trim()).filter((line) => !line.startsWith('id '));
      // The tool running now, from the session's own events: "stop the running tool" applies only while there is one.
      const running = feed.getState().runningToolCalls[0]?.tool;
      return { id: record.id, title: hostedSessionLabel(record), lines, ...(running ? { runningTool: running } : {}) };
    },
    onJoinedChange: (listener) => getSharedHostedSessionFeed().subscribe(listener),
  };
}
