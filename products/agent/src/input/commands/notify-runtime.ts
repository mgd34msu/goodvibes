import { createNotifyRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/notify-runtime-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireWebhookNotifier } from './runtime-services.ts';
const commands = createNotifyRuntimeCommands<CommandContext>(requireWebhookNotifier, {
  description: 'Manage and send configured Agent webhook notifications',
  usage: 'add <url> --yes | remove <url> --yes | list | clear --yes | test --yes | send <message> --yes',
  argsHint: 'list|add --yes|remove --yes|test --yes|send --yes',
  confirmMutations: true,
  maskUrls: true,
  allowSend: true,
  emptyList: 'No webhook URLs configured.\nUse /notify add <url>',
  emptyTest: 'No webhook URLs configured. Use /notify add <url>',
  listSeparator: '',
  failureSeparator: ', ',
  message: (label, value) => label + ' ' + value,
});
export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  commands.registerNotifyRuntimeCommands(registry);
}
