import { createTelegramCursorCommand } from '@goodvibes-jev/engine/terminal-shell/telegram-cursor-command';
import { isDirectOwnerCommandContext, type CommandContext } from '../command-registry.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';

export const openTelegramCursorRecovery = createTelegramCursorCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: context => isDirectOwnerCommandContext(context, 'channel'),
});
