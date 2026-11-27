import { taskDetailLines } from '@goodvibes/engine/terminal-shell/task-presentation';
/**
 * The Agent's runtime tasks, listed and changed in the Work place's Tasks here.
 *
 * The rows come from two places. This process's own registry holds the exec,
 * agent and ACP tasks the loop here spawned; the daemon holds the rest,
 * scheduled work, channel-driven runs, tasks other surfaces submitted. The
 * platform's tasks client unions them, local rows winning on a shared id because
 * they are the live copy, and reports the daemon's half as missing rather than
 * failing the whole list when it cannot be reached.
 *
 * A task is changed through the Agent's own task registry (`clients.opsApi`), and paused, gone on with, cancelled or
 * run again through the task intervention plane terminal-shell builds for both programs, as in the terminal app.
 */
import type { CommandContext } from '../command-registry.ts';

import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireOperatorClient, requireShellPaths } from './runtime-services.ts';
import { requireContextValue } from '@goodvibes/engine/terminal-shell/command-service-access';

import { installTasksPolicy, type TasksPolicy } from '@goodvibes/engine/terminal-shell/tasks-runtime-commands';
import type { CommandRegistry } from '../command-registry.ts';
import { backgroundCommandsReport } from './agent-context-reports.ts';

/** The Agent's tasks, shown and changed in the Work place (capabilities/builtin/tasks.ts). */
export function registerTasksRuntimeCommands(_registry: CommandRegistry): void {
  installTasksPolicy<CommandContext>(TASKS_POLICY);
}

const TASKS_POLICY: TasksPolicy<CommandContext> = {
  listTitle: 'Tasks',
  processes: backgroundCommandsReport,
  local: (ctx) => requireOperatorClient(ctx).tasks,
  verbs: (ctx) =>
    createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),

  // The Agent's own task registry: a task is added, started, finished, paused and cancelled here as in the terminal app.
  mutations: (ctx) => requireContextValue(ctx.clients?.opsApi, 'clients.opsApi'),
  row: ({ task, origin }) =>
    `  ${task.id}  ${task.status.padEnd(9)} ${task.kind.padEnd(11)} ${task.owner.padEnd(10)} ${origin.padEnd(6)} ${task.title}`,
  detail(_ctx, entry) {
    return taskDetailLines(
      entry,
      {
        title: '  title ',
        status: '  status ',
        owner: '  owner ',
        runsOn: '  runs on ',
        localOrigin: 'this Agent',
        cancellable: '  cancellable ',
        queued: '  queued at ',
        started: '  started at ',
        ended: '  ended at ',
        parent: '  parent ',
        children: '  children ',
        correlation: '  correlation ID ',
        summary: '  summary ',
      },
      [],
    );
  },
};
