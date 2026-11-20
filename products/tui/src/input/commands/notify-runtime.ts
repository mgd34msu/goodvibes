import { registerNotifyCommands } from '@goodvibes/engine/terminal-shell/notify-runtime-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireWebhookNotifier } from './runtime-services.ts';

/** `/notify` and `/notifications`: one description shared with the Agent (terminal-shell/notify-runtime-commands.ts). */
export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  registerNotifyCommands<CommandContext>(registry, { webhookNotifier: requireWebhookNotifier });
}
