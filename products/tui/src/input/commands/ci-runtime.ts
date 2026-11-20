/**
 * `/ci` is one description shared with the Agent (terminal-shell/ci-command.ts).
 * Here its methods go over the operator wire (operator-rpc.ts says why HTTP
 * rather than the in-process facade).
 */
import { registerCiCommand } from '@goodvibes-jev/engine/terminal-shell/ci-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';

export function registerCiRuntimeCommands(registry: CommandRegistry): void {
  registerCiCommand<CommandContext>(registry, async (ctx, method, input) => {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) throw commandRefusal(rpc.reason);
    try {
      return await rpc.platformClient.operator.invoke(method, input);
    } catch (error) {
      throw commandRefusal(describeOperatorRpcError(error));
    }
  });
}
