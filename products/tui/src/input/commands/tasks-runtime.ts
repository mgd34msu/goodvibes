import { taskDetailLines } from '@goodvibes-jev/engine/terminal-shell/task-presentation';
import '@goodvibes-jev/engine/terminal-shell/task-presentation';
/**
 * tasks-runtime.ts, `/tasks`.
 *
 * The reads are a UNION now: this surface's own runtime tasks (the exec, agent
 * and ACP work the loop here spawned) plus the daemon's (scheduled work,
 * channel-driven runs, tasks other surfaces submitted). Before the daemon
 * became its own product one registry held both, and `tasks.list(500)` off the
 * in-process transport answered synchronously. It no longer holds both, so this
 * command crosses a wire and is async, the same shape `/ci` and the fleet act
 * verbs already use.
 *
 * The list output is unchanged for a local-only fleet: same header, same
 * columns, same 20-row cap, same filter semantics. What is added is the daemon
 * half, and one honest line when the daemon could not be reached, a partial
 * list of real tasks beats an error page, but it must not read as complete.
 *
 * Writes do NOT degrade that way. A lifecycle act against a task this terminal
 * does not own is routed to the daemon's verb where one exists (cancel, retry)
 * and refused by name where none does (update, complete, fail, pause and
 * resume have no wire verb). Applying one locally would report success and
 * change nothing on the process that actually runs the task.
 */
import type { CommandContext } from '../command-registry.ts';

import { reviewWorktreeAttachments } from '@/runtime/index.ts';
import { requireOperatorClient, requireOpsApi, requireShellPaths } from './runtime-services.ts';
import '@goodvibes-jev/engine/platform/platform/runtime/client';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';
import '@goodvibes-jev/engine/platform/platform/utils';

import { createTasksRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/tasks-runtime-commands';
export const { registerTasksRuntimeCommands } = createTasksRuntimeCommands<CommandContext>({
  description: 'Inspect and control runtime tasks',
  usage:
    '[list [status|kind] | show <taskId> | output <taskId> | create <kind> <owner> <title...> | update <taskId> <title|description|result> <value...> | complete <taskId> [result] | fail <taskId> <error...> | cancel <taskId> [note] | pause <taskId> [note] | resume <taskId> [note] | retry <taskId> [note]]',
  listTitle: 'Runtime Tasks',
  local: (ctx) => requireOperatorClient(ctx).tasks,
  verbs: (ctx) =>
    createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  mutations: requireOpsApi,
  beforeRead(args, ctx) {
    if (args.length !== 0) return false;
    if (!ctx.openView?.('tasks')) ctx.print('The Agents view is not available in this session; /tasks list prints them.');
    return true;
  },
  row: ({ task }) => `  ${task.id}  ${task.status.padEnd(9)} ${task.kind.padEnd(11)} ${task.owner}  ${task.title}`,
  detail(ctx, entry) {
    const { task } = entry;
    return taskDetailLines(
      entry,
      {
        title: '  title: ',
        status: '  status: ',
        owner: '  owner: ',
        runsOn: '  runs on: ',
        localOrigin: 'this terminal',
        cancellable: '  cancellable: ',
        queued: '  queuedAt: ',
        started: '  startedAt: ',
        ended: '  endedAt: ',
        parent: '  parent: ',
        children: '  children: ',
        correlation: '  correlationId: ',
        summary: '  summary: ',
      },
      (() => {
        const shellPaths = requireShellPaths(ctx);
        const worktrees = reviewWorktreeAttachments('task', task.id, {
          workingDirectory: shellPaths.workingDirectory,
        });
        return worktrees.total > 0
          ? [
              `  worktrees: ${worktrees.total} tracked (${worktrees.active} active / ${worktrees.paused} paused / ${worktrees.pendingCleanup} cleanup)`,
              `  worktree next: /worktree task ${task.id}`,
            ]
          : [];
      })(),
    );
  },
  unknown: (id) => `Unknown task: ${id}`,
  unknownSubcommand: (subcommand) => `Unknown tasks subcommand: ${subcommand}`,
});
