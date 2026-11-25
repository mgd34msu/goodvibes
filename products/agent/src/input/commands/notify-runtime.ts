import { registerNotifyCommands } from '@goodvibes/engine/terminal-shell/notify-runtime-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';

/**
 * `/notifications`, and the daemon's webhook addresses and failed notifications as the lists the notify capabilities
 * choose from: one description shared with the terminal app (terminal-shell/notify-runtime-commands.ts).
 */
export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  registerNotifyCommands<CommandContext>(registry, capabilityBinding);
}
