/**
 * `/ci` is one description shared with the Agent (terminal-shell/ci-command.ts).
 * Here its methods go over the operator wire (operator-rpc.ts says why HTTP
 * rather than the in-process facade).
 */
import { registerCiCommand } from '@goodvibes/engine/terminal-shell/ci-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { invokeOperatorMethod } from './operator-rpc.ts';

export function registerCiRuntimeCommands(registry: CommandRegistry): void {
  registerCiCommand<CommandContext>(registry, invokeOperatorMethod);
}
