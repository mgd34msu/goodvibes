// ---------------------------------------------------------------------------
// acp-runtime.ts, the terminal app's host for `/agents`
// (terminal-shell/agents-command.ts): the Your agents panel, third-party
// coding agents hosted through the daemon's acp.* methods (the same verbs the
// Agents modal's n key uses), team modes and recipes (teamwork-runtime.ts),
// and work contracts (control-room-runtime.ts). Handing work to the terminal
// app is the Agent's; here it is refused with the reason.
//
// A structured spawn failure ({binary, stage, message}) is printed verbatim,
// never left as a hung row: the daemon bounds the handshake and returns a
// 'failed' record with its three honest fields.
// ---------------------------------------------------------------------------

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { registerAgentsCommand } from '@goodvibes-jev/engine/terminal-shell/agents-command';
import { describeOperatorRpcError, getOperatorRpc, type OperatorRpcAvailable } from './operator-rpc.ts';
import { parseViewTarget } from '../views.ts';
import { teamHost } from './teamwork-runtime.ts';
import { contractsHost } from './control-room-runtime.ts';

function rpcOf(ctx: CommandContext): OperatorRpcAvailable {
  const rpc = getOperatorRpc(ctx);
  if (!rpc.available) throw commandRefusal(rpc.reason);
  return rpc;
}

export function registerAcpRuntimeCommands(registry: CommandRegistry): void {
  registerAgentsCommand<CommandContext>(registry, {
    openPanel(ctx, target) {
      if (!ctx.openAgents) throw commandRefusal('Your agents is not available in this session.', '/agents hostable lists the coding agents you can host.');
      ctx.openAgents({ target: target ? parseViewTarget(target) : undefined });
    },
    coding: {
      async list(ctx) {
        try {
          return (await rpcOf(ctx).platformClient.operator.invoke('acp.agents.list', {})).agents;
        } catch (error) {
          throw commandRefusal(describeOperatorRpcError(error));
        }
      },
      async host(ctx, agentId, directory) {
        const cwd = directory ? requireShellPaths(ctx).resolveWorkspacePath(directory) : requireShellPaths(ctx).workingDirectory;
        let answer;
        try {
          answer = await rpcOf(ctx).platformClient.operator.invoke('acp.sessions.create', { agentId, cwd });
        } catch (error) {
          throw commandRefusal(describeOperatorRpcError(error));
        }
        const { hosted, started } = answer;
        // Structured failure, verbatim, never a hung row.
        if (hosted.error) throw commandRefusal(`Could not host ${hosted.title || agentId}: the ${hosted.error.stage} stage failed for ${hosted.error.binary}; ${hosted.error.message}`);
        return `Hosting ${hosted.title || agentId} in ${cwd}${started ? '' : ' (queued)'}; it shows as a row in Your agents, where you steer and stop it.`;
      },
    },
    handOff: { unavailable: 'This is the terminal app: it does coding work itself. Ask for it in the chat, or start an agent with /agents start.' },
    contracts: contractsHost(),
    team: teamHost(),
  });
}
