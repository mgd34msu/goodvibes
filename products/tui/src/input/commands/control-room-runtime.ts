import type { CommandRegistry, CommandContext } from '../command-registry.ts';
import '@/runtime/index.ts';
import '@goodvibes-jev/engine/platform/platform/config';
import { requireReadModels } from './runtime-services.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { AgentsHost } from '@goodvibes-jev/engine/terminal-shell/agents-command';

/** Work contracts and stopping agents for `/agents` (terminal-shell/agents-command.ts) in this app. */
export function contractsHost(): Exclude<AgentsHost<CommandContext>['contracts'], { readonly unavailable: string }> {
  const manager = (ctx: CommandContext) => {
    const agents = ctx.ops.agentManager;
    if (!agents) throw commandRefusal('Agents are not available in this session.');
    return agents;
  };
  return {
    list(ctx) {
      return requireReadModels(ctx).contracts.getSnapshot().contracts.map((contract) => ({ id: contract.id, ask: contract.ask, status: contract.status }));
    },
    show(ctx, contractId) {
      const contracts = requireReadModels(ctx).contracts.getSnapshot().contracts;
      const contract = contractId ? contracts.find((entry) => entry.id === contractId) : contracts[0];
      if (!contract) throw commandRefusal(contractId ? `No work contract ${contractId}.` : 'No work contracts recorded yet.');
      return [
        `Contract ${contract.id}`,
        `  asked: ${contract.ask}`,
        `  state: ${contract.status}`,
        `  groups: ${contract.groups.size}`,
        `  units: ${contract.units.size}`,
        ...[...contract.units.values()].slice(0, 12).map((unit) => `  - ${unit.id} ${unit.role ?? 'unit'} ${unit.status}${unit.title ? ` ${unit.title}` : ''}`),
        ...(contract.reason ? [`  reason: ${contract.reason}`] : []),
        `  manage it: /workstream status ${contract.id}`,
      ].join('\n');
    },
    running(ctx) {
      return (manager(ctx).listActive?.() ?? []).map((record) => ({ id: record.id, task: record.task, status: record.status, graphId: record.orchestrationGraphId }));
    },
    stopGroup(ctx, graphId) {
      const cancelled = manager(ctx).cancelGraph(graphId);
      if (cancelled.length === 0) throw commandRefusal(`No running agent is in group ${graphId}; nothing was stopped.`);
      return `Stopped ${cancelled.length} agent${cancelled.length === 1 ? '' : 's'} in group ${graphId}.`;
    },
    stopBranch(ctx, agentId) {
      const cancelled = manager(ctx).cancelSubtree(agentId);
      if (cancelled.length === 0) throw commandRefusal(`Agent ${agentId} and the agents it started were not running; nothing was stopped.`);
      return `Stopped ${cancelled.length} agent${cancelled.length === 1 ? '' : 's'}: ${agentId} and the agents it started.`;
    },
    openView(ctx) {
      if (!ctx.openOrchestrationView) throw commandRefusal('The work contracts view is not available in this session.', '/agents contract shows the newest contract.');
      ctx.openOrchestrationView();
    },
  };
}

export function registerControlRoomRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'communication',
    aliases: ['comms'],
    description: 'Inspect structured agent communication routes and recent activity',
    handler(_args, ctx) {
      if (ctx.openCommunicationView) {
        ctx.openCommunicationView();
        return;
      }
      ctx.print('The Agents view is not available in this runtime.');
    },
  });
}
