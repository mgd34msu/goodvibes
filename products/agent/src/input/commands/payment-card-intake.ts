import { createPaymentWindowCommand } from '@goodvibes/engine/terminal-shell/payment-window-command';
import { registerPaymentsCommand } from '@goodvibes/engine/terminal-shell/payments-command';
/**
 * /payments at the agent's own terminal: the Agent's host for the one
 * description (terminal-shell/payments-command.ts), the twin of the terminal
 * app's commands/payment-card-intake.ts. Cards, the billing and shipping
 * addresses and the purchases allowed ahead of time are the daemon's Money
 * capabilities, reached through the Agent's capability binding, so both
 * programs and the web UI read and write the one copy the daemon keeps.
 *
 * ── Card material: hidden, and stored by the daemon ────────────────────
 *
 * A card is typed in the capability's own form: the number, expiry, security
 * code and cardholder name are hidden as they are typed, sent once to the
 * daemon, which keeps them in its own encrypted secret store and answers with
 * metadata only. Nothing about the card is written to this machine's config or
 * secret store, the transcript, the input history file, or a log line.
 *
 * ── Where card details may be typed at all ───────────────────────────────
 *
 * Gated on the platform's own allowlist (platform/payments/entry-surface.ts), never
 * on a literal decided here. Card material may be TYPED only on `tui`,
 * `agent-terminal` or `webui`, never over Telegram, ntfy, Discord, Slack,
 * WhatsApp, Signal, a webhook, or any other remote messaging surface. That is a
 * SEPARATE question from which surfaces may APPROVE or VETO a purchase, every
 * command-authority channel still can, and the two checks are never merged.
 */

import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { capabilityBinding } from './capability-binding.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';

/**
 * This surface's identity in the platform's card-entry allowlist.
 *
 * `agent-terminal`, not `tui`: they are different surfaces with different
 * command registries, and naming this one honestly is what lets the allowlist
 * be the authority instead of each surface assuming it qualifies. Exported so
 * tests assert the real constant rather than a copy of the string.
 */
export const CARD_ENTRY_SURFACE = 'agent-terminal';

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
