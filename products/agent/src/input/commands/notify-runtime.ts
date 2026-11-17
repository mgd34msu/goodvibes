import { createNotifyRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/notify-runtime-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireWebhookNotifier } from './runtime-services.ts';
const commands = createNotifyRuntimeCommands<CommandContext>(requireWebhookNotifier, {
  description: 'Manage and send configured Agent webhook notifications',
  usage: 'add <url> --yes | remove <n|url> --yes | list [--show --yes] | clear --yes | test --yes | send <message> --yes',
  argsHint: 'list|add --yes|remove --yes|test --yes|send --yes',
  maskUrls: true,
  allowSend: true,
});
export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  commands.registerNotifyRuntimeCommands(registry);
}
