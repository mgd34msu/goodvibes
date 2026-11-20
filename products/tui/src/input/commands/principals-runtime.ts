/**
 * `/principals` is one description shared with the Agent
 * (terminal-shell/principals-command.ts); here its methods go over the operator wire.
 */
import { registerPrincipalsCommand } from '@goodvibes-jev/engine/terminal-shell/principals-command';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { describeOperatorRpcError, getOperatorRpc } from './operator-rpc.ts';

export function registerPrincipalsRuntimeCommands(registry: CommandRegistry): void {
  registerPrincipalsCommand<CommandContext>(registry, async (ctx, method, input) => {
    const rpc = getOperatorRpc(ctx);
    if (!rpc.available) throw commandRefusal(rpc.reason);
    try {
      return await rpc.platformClient.operator.invoke(method, input);
    } catch (error) {
      throw commandRefusal(describeOperatorRpcError(error));
    }
  });
}
