import { taskDetailLines } from '@goodvibes/engine/terminal-shell/task-presentation';
/**
 * `/tasks`, the Agent's read-only view of runtime tasks.
 *
 * The rows come from two places. This process's own registry holds the exec,
 * agent and ACP tasks the loop here spawned; the daemon holds the rest,
 * scheduled work, channel-driven runs, tasks other surfaces submitted. The
 * platform's tasks client unions them, local rows winning on a shared id because
 * they are the live copy, and reports the daemon's half as missing rather than
 * failing the whole list when it cannot be reached.
 *
 * Every mutation stays blocked here, which is the Agent's own policy and not a
 * limit of the client: normal work belongs in the conversation, durable work in
 * /todo, and implementation work goes to the terminal app through /agents hand-off.
 */
import type { CommandContext } from '../command-registry.ts';

import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireOperatorClient, requireShellPaths } from './runtime-services.ts';

import { installTasksPolicy, type TasksPolicy } from '@goodvibes/engine/terminal-shell/tasks-runtime-commands';
import type { CommandRegistry } from '../command-registry.ts';
import { backgroundCommandsReport } from './agent-context-reports.ts';

/** The Agent's tasks, shown in the Work place (capabilities/builtin/tasks.ts): read only here. */
export function registerTasksRuntimeCommands(_registry: CommandRegistry): void {
  installTasksPolicy<CommandContext>(TASKS_POLICY);
}

const TASKS_POLICY: TasksPolicy<CommandContext> = {
  listTitle: 'Tasks',
  processes: backgroundCommandsReport,
  local: (ctx) => requireOperatorClient(ctx).tasks,
  verbs: (ctx) =>
    createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),

  // Normal work stays in the main conversation, durable work in /todo, and
  // implementation work goes to the terminal app through /agents hand-off.
  mutations: { readOnly: 'Tasks are read only in the Agent: normal work stays in the conversation, lasting work goes on the checklist, and building or fixing goes to the terminal app (hand it off from Work and agents). Nothing was changed.' },
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
