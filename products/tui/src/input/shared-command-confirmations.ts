/**
 * The irreversible lines of commands this app builds from shared shell code
 * (`/notify`, `/mcp`, `/provider`). Those builders take no `confirm` of their
 * own, so the registry supplies it here, by command name, and asks once
 * through the same rule as every other command (command-confirmation.ts).
 * Reversible lines are not listed and run at once.
 */
import type { CommandConfirmation } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import type { CommandContext } from './command-registry.ts';

type Confirm = (args: readonly string[], context: CommandContext) => CommandConfirmation | undefined;

export const SHARED_COMMAND_CONFIRMATIONS: Readonly<Partial<Record<string, Confirm>>> = {
  notify(args, ctx) {
    if (args[0] !== 'clear') return undefined;
    const urls = ctx.platform.configManager.getCategory('notifications').webhookUrls;
    const count = Array.isArray(urls) ? urls.length : 0;
    if (count === 0) return undefined;
    return {
      title: `Remove all ${count} webhook URL${count === 1 ? '' : 's'}?`,
      detail: 'Every webhook notification URL is removed. They are shown masked, so note any you need before clearing; /notify add <url> adds one back.',
      confirmLabel: 'Clear',
    };
  },
  mcp(args) {
    if (args[0] !== 'remove' || !args[1]) return undefined;
    return {
      title: `Remove MCP server ${args[1]}?`,
      detail: `${args[1]}'s entry (its command, arguments, environment and trust settings) is deleted from the MCP config and its tools stop being offered. Re-adding it means typing the whole /mcp add line again.`,
      confirmLabel: 'Remove',
    };
  },
  provider(args) {
    if ((args[0] !== 'remove' && args[0] !== 'rm') || !args[1]) return undefined;
    return {
      title: `Remove custom provider ${args[1]}?`,
      detail: `The provider file for ${args[1]} (its base URL and model list) is deleted and its models leave the picker. /provider add creates it again.`,
      confirmLabel: 'Remove',
    };
  },
};
