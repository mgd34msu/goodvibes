import {
  createTasksClient,
  type LocalTaskSource,
  type DaemonVerbCaller,
  type UnionTask,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { OpsApi } from '@goodvibes-jev/engine/platform/platform/runtime/bootstrap';
import type { TaskKind } from '@goodvibes-jev/engine/platform/platform/runtime/state';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { sortUnionTasks } from './task-presentation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
interface TaskCommandContext {
  print(message: string): void;
}
export function createTasksRuntimeCommands<Context extends TaskCommandContext>(policy: {
  readonly description: string;
  readonly usage: string;
  readonly hidden?: boolean | undefined;
  readonly listTitle: string;
  readonly local: (context: Context) => LocalTaskSource;
  readonly verbs: (context: Context) => DaemonVerbCaller;
  readonly mutations?: ((context: Context) => Pick<OpsApi, 'tasks'>) | undefined;
  readonly beforeRead: (args: string[], context: Context) => boolean;
  readonly row: (entry: UnionTask) => string;
  readonly detail: (context: Context, entry: UnionTask) => string[];
  readonly unknown: (id: string) => string;
  readonly unknownSubcommand: (subcommand: string) => string;
}) {
  /** The five lifecycle acts the operator contract carries no verb for. */
  const LOCAL_ONLY_ACTS = new Set(['update', 'complete', 'fail', 'pause', 'resume']);

  function refuseDaemonOwnedAct(taskId: string, subcommand: string): string {
    return (
      `${taskId} runs on the daemon, and the operator contract carries no ${subcommand} verb to reach it with. ` +
      "Cancel and retry are available; the rest act on this terminal's own tasks."
    );
  }

  function registerTasksRuntimeCommands(registry: Pick<TerminalCommandRegistry<Context>, 'register'>): void {
    registry.register({
      name: 'tasks',
      aliases: ['task'],
      description: policy.description,
      hidden: policy.hidden,
      usage: policy.usage,
      async handler(args, ctx) {
        if (policy.beforeRead(args, ctx)) return;
        const subcommand = args[0]?.toLowerCase() ?? 'list';
        const tasksClient = createTasksClient({ local: policy.local(ctx), verbs: policy.verbs(ctx) });
        if (subcommand === 'list') {
          const { tasks: union, daemonUnavailable } = await tasksClient.list(500);
          const tasks = sortUnionTasks(union);
          const filter = args[1]?.toLowerCase();
          const filtered = tasks.filter((entry) => !filter || entry.task.status === filter || entry.task.kind === filter);
          // The daemon note rides ALONGSIDE whatever was found rather than
          // replacing it: the local half is real work, and hiding it behind an
          // error would lose tasks that are genuinely running here.
          const daemonNote = daemonUnavailable ? [`  (the daemon's tasks are not included: ${daemonUnavailable})`] : [];
          if (filtered.length === 0) {
            ctx.print([filter ? `No tasks matched "${filter}".` : 'No tasks recorded yet.', ...daemonNote].join('\n'));
            return;
          }
          ctx.print([`${policy.listTitle} (${filtered.length})`, ...filtered.slice(0, 20).map(policy.row), ...daemonNote].join('\n'));
          return;
        }

        if (subcommand === 'show') {
          const taskId = args[1];
          if (!taskId) {
            ctx.print('Usage: /tasks show <taskId>');
            return;
          }
          const found = await tasksClient.get(taskId);
          if (!found) {
            ctx.print(policy.unknown(taskId));
            return;
          }
          ctx.print(policy.detail(ctx, found).join('\n'));
          return;
        }

        if (subcommand === 'output') {
          const taskId = args[1];
          if (!taskId) {
            ctx.print('Usage: /tasks output <taskId>');
            return;
          }
          const found = await tasksClient.get(taskId);
          if (!found) {
            ctx.print(policy.unknown(taskId));
            return;
          }
          const { task } = found;
          const payload =
            typeof task.result === 'string'
              ? task.result
              : task.result !== undefined
                ? JSON.stringify(task.result, null, 2)
                : (task.error ?? task.description ?? task.title);
          ctx.print(String(payload));
          return;
        }

        // Read-only surfaces never obtain a mutation API or dispatch a remote write.
        if (!policy.mutations) {
          ctx.print(policy.unknownSubcommand(subcommand));
          return;
        }
        if (subcommand === 'create') {
          const opsApi = policy.mutations(ctx);
          const kind = args[1];
          const owner = args[2];
          const title = args.slice(3).join(' ').trim();
          if (!kind || !owner || !title) {
            ctx.print('Usage: /tasks create <kind> <owner> <title...>');
            return;
          }
          const validKinds = new Set(['exec', 'agent', 'acp', 'scheduler', 'daemon', 'mcp', 'plugin', 'integration']);
          if (!validKinds.has(kind)) {
            ctx.print(`Unknown task kind: ${kind}`);
            return;
          }
          // Created HERE on purpose: a task this command creates is one this
          // terminal's loop is expected to drive, so it belongs in the registry
          // that drives it. Submitting work TO the daemon is what /schedule and
          // the channel surfaces do.
          const task = opsApi.tasks.create({
            kind: kind as TaskKind,
            owner,
            title,
            description: title,
          });
          ctx.print(`Created task ${task.id} (${task.kind}) for ${task.owner}.`);
          return;
        }

        const taskId = args[1];
        if (!taskId) {
          ctx.print(
            subcommand === 'update'
              ? 'Usage: /tasks update <taskId> <title|description|result> <value...>'
              : `Usage: /tasks ${subcommand} <taskId> [note]`,
          );
          return;
        }

        // Which registry owns this id decides what may be done to it. An act
        // aimed at a daemon task must never be applied to a local record that
        // does not exist, that reports success and changes nothing.
        const found = await tasksClient.get(taskId);
        if (!found) {
          ctx.print(policy.unknown(taskId));
          return;
        }

        if (found.origin === 'daemon') {
          if (LOCAL_ONLY_ACTS.has(subcommand)) {
            ctx.print(refuseDaemonOwnedAct(taskId, subcommand));
            return;
          }
          try {
            switch (subcommand) {
              case 'cancel':
                await tasksClient.cancel(taskId);
                ctx.print(`Cancelled task ${taskId} on the daemon.`);
                return;
              case 'retry':
                await tasksClient.retry(taskId);
                ctx.print(`Re-queued task ${taskId} on the daemon.`);
                return;
              default:
                ctx.print(policy.unknownSubcommand(subcommand));
                return;
            }
          } catch (error) {
            ctx.print(summarizeError(error));
            return;
          }
        }

        const opsApi = policy.mutations(ctx);
        try {
          if (subcommand === 'update') {
            const field = args[2];
            const value = args.slice(3).join(' ').trim();
            if (!field || !value) {
              ctx.print('Usage: /tasks update <taskId> <title|description|result> <value...>');
              return;
            }
            if (field !== 'title' && field !== 'description' && field !== 'result') {
              ctx.print(`Unsupported task update field: ${field}`);
              return;
            }
            opsApi.tasks.update(taskId, field === 'result' ? { result: value } : { [field]: value });
            ctx.print(`Updated task ${taskId} field ${field}.`);
            return;
          }
          if (subcommand === 'complete') {
            opsApi.tasks.complete(taskId, args.slice(2).join(' ').trim() || undefined);
            ctx.print(`Completed task ${taskId}.`);
            return;
          }
          if (subcommand === 'fail') {
            const errorText = args.slice(2).join(' ').trim();
            if (!errorText) {
              ctx.print('Usage: /tasks fail <taskId> <error...>');
              return;
            }
            opsApi.tasks.fail(taskId, { error: errorText });
            ctx.print(`Failed task ${taskId}.`);
            return;
          }
          const note = args.slice(2).join(' ').trim() || undefined;
          switch (subcommand) {
            case 'cancel':
              opsApi.tasks.cancel(taskId, note);
              ctx.print(`Cancelled task ${taskId}.`);
              return;
            case 'pause':
              opsApi.tasks.pause(taskId, note);
              ctx.print(`Paused task ${taskId}.`);
              return;
            case 'resume':
              opsApi.tasks.resume(taskId, note);
              ctx.print(`Resumed task ${taskId}.`);
              return;
            case 'retry':
              opsApi.tasks.retry(taskId, note);
              ctx.print(`Re-queued task ${taskId}.`);
              return;
            default:
              ctx.print(policy.unknownSubcommand(subcommand));
              return;
          }
        } catch (error) {
          ctx.print(summarizeError(error));
        }
      },
    });
  }

  return { registerTasksRuntimeCommands };
}
