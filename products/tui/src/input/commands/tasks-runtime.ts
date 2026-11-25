import { taskDetailLines } from '@goodvibes/engine/terminal-shell/task-presentation';
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
 * and refused by name where none does (start, update, complete, fail, pause
 * and resume have no wire verb). Applying one locally would report success and
 * change nothing on the process that actually runs the task.
 */
import type { CommandContext } from '../command-registry.ts';

import { reviewWorktreeAttachments } from '@/runtime/index.ts';
import { requireOperatorClient, requireOpsApi, requireShellPaths } from './runtime-services.ts';
import { createDaemonVerbCaller } from '../../runtime/client/operator-endpoint.ts';

import { installTasksPolicy, type TasksPolicy } from '@goodvibes/engine/terminal-shell/tasks-runtime-commands';
import type { CommandRegistry } from '../command-registry.ts';

/** The terminal app's tasks, shown in the Work place (capabilities/builtin/tasks.ts): it reads and changes its own. */
export function registerTasksRuntimeCommands(_registry: CommandRegistry): void {
  installTasksPolicy<CommandContext>(TASKS_POLICY);
}

const TASKS_POLICY: TasksPolicy<CommandContext> = {
  listTitle: 'Runtime Tasks',
  local: (ctx) => requireOperatorClient(ctx).tasks,
  verbs: (ctx) =>
    createDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),
  mutations: requireOpsApi,
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
              `  worktrees: ${worktrees.total} tracked (${worktrees.active} active / ${worktrees.paused} paused / ${worktrees.kept} kept)`,
              `  its worktrees: Code and changes, Worktrees ("worktrees of its task")`,
            ]
          : [];
      })(),
    );
  },
};
