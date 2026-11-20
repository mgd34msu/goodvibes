import { registerWorkstreamCommand } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from './confirmation.ts';

/**
 * `/workstream` is one description shared with the terminal app
 * (terminal-shell/workstream-command.ts). In the Agent, work starts by
 * planning it (plan, approve, launch), or by asking for it in a message, which
 * runs delegated work as a contract.
 */
export function registerWorkstreamRuntimeCommands(registry: CommandRegistry): void {
  registerWorkstreamCommand<CommandContext>(registry, async () => {
    throw commandRefusal('The Agent starts work from a plan or a message, not from this line: nothing was started.', 'Plan it with /workstream plan <goal>, then approve and launch the plan; or ask for it in a message, which runs delegated work as a contract.', 'USAGE');
  });
}
