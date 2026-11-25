import type { CommandContext } from '../command-registry.ts';
import { requireOpsApi } from './runtime-services.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import type { AgentsHost } from '@goodvibes/engine/terminal-shell/agents-command';

/**
 * The agents this app started and stopping them (platform builtin/agents.ts, through terminal-shell/agents-command.ts).
 * What an agent hands over as work runs on the daemon and is seen in Work.
 */
export function contractsHost(): Exclude<AgentsHost<CommandContext>['contracts'], { readonly unavailable: string }> {
  const manager = (ctx: CommandContext) => {
    const agents = ctx.ops.agentManager;
    if (!agents) throw commandRefusal('Agents are not available in this session.');
    return agents;
  };
  return {
    running(ctx) {
      return (manager(ctx).listActive?.() ?? []).map((record) => ({ id: record.id, task: record.task, status: record.status, graphId: record.orchestrationGraphId }));
    },
    started(ctx) {
      // The manager keeps this session's agents (loading another session replaces them), ended ones included. Its saved
      // form says a live agent was cut off by a restart, so the live ones come from the live list.
      const active = manager(ctx).listActive?.() ?? [];
      const live = new Set(active.map((record) => record.id));
      return [...active, ...manager(ctx).exportState().filter((record) => !live.has(record.id))].map((record) => ({
        id: record.id, task: record.task, status: record.status, graphId: record.orchestrationGraphId,
        ...(record.progress ? { progress: record.progress } : {}), ...(record.error ? { error: record.error } : {}),
      }));
    },
    stop(ctx, agentId, note) {
      // Stopping an agent (`x` in Your agents): the agent is asked to stop through this app's ops API, the note kept with it.
      const agent = manager(ctx).getStatus(agentId);
      if (!agent || (agent.status !== 'running' && agent.status !== 'pending')) throw commandRefusal(`${agent ? `"${agent.task}"` : `Agent ${agentId}`} is not running; nothing was stopped.`);
      try {
        requireOpsApi(ctx).agents.cancel(agentId, note || undefined);
      } catch (error) {
        throw commandRefusal(`"${agent.task}" was not stopped: ${summarizeError(error)}`);
      }
      return `Stopped the agent on "${agent.task}".`;
    },
    stopGroup(ctx, graphId) {
      // A group and an agent are named by what they work on, never by their ids.
      const cancelled = manager(ctx).cancelGraph(graphId);
      if (cancelled.length === 0) throw commandRefusal('No agent of that group is running; nothing was stopped.');
      const tasks = cancelled.map((id) => manager(ctx).getStatus(id)?.task).filter((task): task is string => Boolean(task));
      return `Stopped ${cancelled.length} agent${cancelled.length === 1 ? '' : 's'} of the group${tasks.length > 0 ? `: ${tasks.map((task) => `"${task}"`).join(', ')}` : ''}.`;
    },
    stopBranch(ctx, agentId) {
      const task = manager(ctx).getStatus(agentId)?.task;
      const named = task ? `"${task}"` : 'the agent';
      const cancelled = manager(ctx).cancelSubtree(agentId);
      if (cancelled.length === 0) throw commandRefusal(`${task ? `The agent on ${named}` : 'That agent'} and the agents it started were not running; nothing was stopped.`);
      return cancelled.length === 1 ? `Stopped the agent on ${named}.` : `Stopped the agent on ${named} and the ${cancelled.length - 1} agent${cancelled.length === 2 ? '' : 's'} it started.`;
    },
  };
}
