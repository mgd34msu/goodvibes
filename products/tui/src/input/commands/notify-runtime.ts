import { createNotifyRuntimeCommands } from '@goodvibes-jev/engine/terminal-shell/notify-runtime-commands';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireWebhookNotifier } from './runtime-services.ts';
const commands = createNotifyRuntimeCommands<CommandContext>(requireWebhookNotifier, {
  description: 'Manage webhook notification URLs (ntfy.sh format)',
  usage: 'add <url> | remove <url> | list | clear | test',
  argsHint: 'add|remove|list|clear|test',
  confirmMutations: false,
  maskUrls: false,
  allowSend: false,
  emptyList: 'No webhook URLs configured.\nUse: /notify add <url>',
  emptyTest: 'No webhook URLs configured. Use: /notify add <url>',
  listSeparator: ':',
  failureSeparator: ': ',
  message: (label, value) => label + ': ' + value,
});
export function registerNotifyRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'notifications',
    aliases: [],
    description: 'Open the notification history: everything collected, newest first; Enter goes to its subject',
    handler(_args, ctx) {
      if (ctx.openNotifications) ctx.openNotifications();
      else ctx.print('The Notifications view is not available in this session.');
    },
  });
  commands.registerNotifyRuntimeCommands(registry);
}
