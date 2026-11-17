import { createPaymentApproveCommand, createPaymentStandingCommand, createPaymentWindowCommand } from '@goodvibes-jev/engine/terminal-shell/payment-window-command';
import { isDirectOwnerCommandContext, type CommandContext } from '../command-registry.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';

export const openPendingPaymentWindows = createPaymentWindowCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: context => isDirectOwnerCommandContext(context, 'payments'),
});

export const approvePurchaseInAdvance = createPaymentApproveCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: context => isDirectOwnerCommandContext(context, 'payments'),
});

export const manageStandingAuthorizations = createPaymentStandingCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: context => isDirectOwnerCommandContext(context, 'payments'),
});
