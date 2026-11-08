import { createPaymentWindowCommand } from '@goodvibes-jev/engine/terminal-shell/payment-window-command';
import { isDirectOwnerCommandContext, type CommandContext } from '../command-registry.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';

export const openPendingPaymentWindows = createPaymentWindowCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: context => isDirectOwnerCommandContext(context, 'payments'),
});
