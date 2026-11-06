import { taskDetailLines } from '@goodvibes-jev/engine/terminal-shell/task-presentation';
import '@goodvibes-jev/engine/terminal-shell/task-presentation';
/**
 * `/tasks`, the Agent's read-only view of runtime tasks.
 *
 * The rows come from two places. This process's own registry holds the exec,
 * agent and ACP tasks the loop here spawned; the daemon holds the rest,
 * scheduled work, channel-driven runs, tasks other surfaces submitted. The
 * SDK's tasks client unions them, local rows winning on a shared id because
 * they are the live copy, and reports the daemon's half as missing rather than
 * failing the whole list when it cannot be reached.
 *
 * Every mutation stays blocked here, which is the Agent's own policy and not a
 * limit of the client: normal work belongs in the conversation, durable work in
 * /workplan, and implementation work goes to the terminal through /delegate.
 */
import type { CommandContext } from '../command-registry.ts';

import '@goodvibes-jev/engine/sdk/platform/runtime/client';
import { createAgentDaemonVerbCaller } from '../../runtime/client/daemon-verbs.ts';
import { requireOperatorClient, requireShellPaths } from './runtime-services.ts';

const BLOCKED_TASK_MUTATIONS: ReadonlySet<string> = new Set(['create', 'update', 'complete', 'fail', 'cancel', 'pause', 'resume', 'retry']);

function printTaskMutationBlocked(print: (text: string) => void, subcommand: string): void {
  print(
    [
      `Task mutation "${subcommand}" is blocked in GoodVibes Agent.`,
      '  policy connected-host tasks are read-only from the Agent TUI; normal work stays in the main conversation.',
      '  durable tasks use /workplan for visible planning and task tracking.',
      '  build/fix/review use /delegate <task> to hand explicit implementation work to GoodVibes TUI.',
      '  result no local task state was changed.',
    ].join('\n'),
  );
}

import { createTasksRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/tasks-runtime-commands';
export const { registerTasksRuntimeCommands } = createTasksRuntimeCommands<CommandContext>({
  description: 'Inspect connected-host tasks without starting or mutating local background work',
  usage: '[list [status|kind] | show <taskId> | output <taskId>]',
  hidden: true,
  listTitle: 'Tasks',
  local: (ctx) => requireOperatorClient(ctx).tasks,
  verbs: (ctx) =>
    createAgentDaemonVerbCaller({ configManager: ctx.platform.configManager, homeDirectory: () => requireShellPaths(ctx).homeDirectory }),

  beforeRead(args, ctx) {
    const subcommand = args[0]?.toLowerCase() ?? 'list';
    if (subcommand === 'open' || subcommand === 'panel') {
      ctx.print(
        'Open Agent Workspace -> Work & Approvals -> Filter host tasks for the workspace view, or run /tasks list for compact command output.',
      );
      return true;
    }
    if (BLOCKED_TASK_MUTATIONS.has(subcommand)) {
      printTaskMutationBlocked(ctx.print, subcommand);
      return true;
    }
    return false;
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
  unknown: (id) => `Unknown task ${id}`,
  unknownSubcommand: (subcommand) => `Unknown tasks subcommand ${subcommand}`,
});
