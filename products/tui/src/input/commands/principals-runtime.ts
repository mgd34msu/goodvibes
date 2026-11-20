/**
 * `/principals` is one description shared with the Agent
 * (terminal-shell/principals-command.ts); here its methods go over the operator wire.
 */
import { registerPrincipalsCommand } from '@goodvibes/engine/terminal-shell/principals-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { invokeOperatorMethod } from './operator-rpc.ts';

export function registerPrincipalsRuntimeCommands(registry: CommandRegistry): void {
  registerPrincipalsCommand<CommandContext>(registry, invokeOperatorMethod);
}
