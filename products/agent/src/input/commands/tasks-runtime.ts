import { taskDetailLines } from '@goodvibes/engine/terminal-shell/task-presentation';
import '@goodvibes/engine/terminal-shell/task-presentation';
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

import '@goodvibes/engine/platform/platform/runtime/client';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireOperatorClient, requireShellPaths } from './runtime-services.ts';

import { createTasksRuntimeCommands } from '@goodvibes/engine/terminal-shell/tasks-runtime-commands';
import { commandRefusal } from './confirmation.ts';
import { backgroundCommandsReport } from './agent-context-reports.ts';
export const { registerTasksRuntimeCommands } = createTasksRuntimeCommands<CommandContext>({
  listTitle: 'Tasks',
  processes: backgroundCommandsReport,
  local: (ctx) => requireOperatorClient(ctx).tasks,
  verbs: (ctx) =>
    createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),

  // Normal work stays in the main conversation, durable work in /todo, and
  // implementation work goes to the terminal app through /agents hand-off.
  mutations: { readOnly: 'Tasks are read only in the Agent: normal work stays in the conversation, lasting work goes in /todo, and building or fixing goes to the terminal app with /agents hand-off. Nothing was changed.' },
  open(ctx) {
    if (!ctx.openAgentWorkspace) throw commandRefusal('The Agent workspace needs the interactive shell.', '/tasks list prints them.');
    ctx.openAgentWorkspace('work');
  },
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
});
