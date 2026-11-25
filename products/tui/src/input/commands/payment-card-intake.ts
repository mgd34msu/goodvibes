import { createPaymentWindowCommand } from '@goodvibes/engine/terminal-shell/payment-window-command';
import { registerPaymentsCommand } from '@goodvibes/engine/terminal-shell/payments-command';
/**
 * The terminal app's host for `/payments` (terminal-shell/payments-command.ts).
 * Cards, addresses and the purchases allowed ahead of time are the daemon's
 * Money capabilities, reached through this app's capability binding; a card is
 * typed in the capability's own form (number, expiry, security code and name
 * hidden as typed) and stored by the daemon, which answers with metadata only.
 *
 * ── Card details are entered only at a local terminal or the webui ────────
 *
 * Owner ruling (see the platform's platform/payments/entry-surface.ts): card
 * material may be TYPED only on `tui`, `agent-terminal`, or `webui`, never
 * over Telegram, ntfy, Discord, Slack, WhatsApp, Signal, a webhook, or any
 * other remote messaging surface. A card number typed into a hosted chat is
 * stored on that provider's own servers, in history this app cannot erase,
 * and it already passed through their infrastructure before reaching us. This
 * is a SEPARATE question from which surfaces may APPROVE or VETO a purchase
 * (every command-authority channel still can); the two are never merged into
 * one check. The check is real and platform-driven (CARD_ENTRY_SURFACE below),
 * not an implicit "this is the TUI so it's fine" assumption.
 */

import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';

/**
 * This command is wired only into the TUI's own composer command registry,
 * it is never reachable from a channel bridge (Telegram, Discord, ...), each
 * of which has its own separate command surface in the daemon. The constant
 * still names the surface explicitly and is checked through the platform's own
 * allowlist, rather than skipping the check because "this is the TUI".
 */
export const CARD_ENTRY_SURFACE = 'tui';

const openPendingPaymentWindows = createPaymentWindowCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: (context) => isDirectOwnerCommandContext(context, 'payments'),
});

/** Register `/payments` with this app's host. */
export function registerPaymentCardCommands(registry: CommandRegistry): void {
  registerPaymentsCommand<CommandContext>(registry, {
    cardEntrySurface: CARD_ENTRY_SURFACE,
    capabilities: capabilityBinding,
    pending: openPendingPaymentWindows,
  });
}
