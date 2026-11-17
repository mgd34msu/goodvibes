import { createCardEntryPrompter, createPaymentCardHost, createPaymentCardCommands, renderCardList, describeCard, describeCardFailure, CARD_ENTRY_FIELDS } from '@goodvibes-jev/engine/terminal-shell/card-field-prompts';
/**
 * /payments card, capture a payment card through the composer's concealed
 * input mode and store it on the selected paired daemon with one
 * `payments.cards.create` request.
 *
 * The daemon is what completes a purchase, and it only spends from a card in
 * its own card store (the ids `payments.cards.list` returns). So this command
 * does not keep card material in this machine's config or secret store: it
 * asks for the label, kind, number, expiry (month and year), CVV and cardholder
 * name through masked prompts, holds the answers in memory only until the last
 * one, sends them in one request, and prints only the metadata the daemon
 * returns (label, kind, brand, last four digits, expiry). Esc before the last
 * answer discards everything. A refusal or failure prints fixed text, never the
 * request or the daemon's own message, which could quote what was typed.
 * `/payments status` lists the cards the daemon holds from `payments.cards.list`.
 *
 * Billing and shipping address are ordinary (non-secret) config fields, real
 * structured CONFIG_SCHEMA entries (payments.billingAddress.* and
 * payments.shippingAddress.*); this command points the user at the Payments
 * settings category (or /config payments) for them rather than routing plain
 * text through the concealed (masked) input path where it does not belong.
 *
 * ── Card details are entered only at a local terminal or the webui ────────
 *
 * Owner ruling (see the platform's platform/payments/entry-surface.ts): card
 * material may be TYPED only on `tui`, `agent-terminal`, or `webui`, never
 * over Telegram, ntfy, Discord, Slack, WhatsApp, Signal, a webhook, or any
 * other remote messaging surface. A card number typed into a hosted chat is
 * stored on that provider's own servers, in history this app cannot erase,
 * and it already passed through their infrastructure before reaching us,
 * our own encryption at rest does nothing for a value copied elsewhere on
 * its way in. This is a SEPARATE question from which surfaces may APPROVE or
 * VETO a purchase (every command-authority channel still can); the two are
 * never merged into one check.
 *
 * This command always runs inside the TUI's own composer (CARD_ENTRY_SURFACE
 * below), which the platform's allowlist accepts, so this gate changes nothing
 * about today's behavior. What it buys is that the refusal already exists
 * the moment this app (or a shared command registry) ever grows a path that
 * lets `/payments card` be reached from somewhere else: the check is real
 * and platform-driven, not an implicit "this is the TUI so it's fine" assumption.
 */

import type { CommandContext } from '../command-registry.ts';
import { approvePurchaseInAdvance, manageStandingAuthorizations, openPendingPaymentWindows } from './payments-pending.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';

import '@goodvibes-jev/engine/platform/platform/payments';
import '../payments-config.ts';

/**
 * This command is wired only into the TUI's own composer command registry,
 * it is never reachable from a channel bridge (Telegram, Discord, ...), each
 * of which has its own separate command surface in the daemon. The constant
 * still names the surface explicitly and is checked through the platform's own
 * allowlist below, rather than skipping the check because "this is the TUI".
 */
export const CARD_ENTRY_SURFACE = 'tui';

const cardHost = createPaymentCardHost<CommandContext>(ownerOperatorConnectionPolicy);

async function renderCardStatus(ctx: CommandContext): Promise<string[]> {
  let lines: string[];
  try {
    lines = renderCardList(await cardHost.list(ctx));
  } catch (error: unknown) {
    lines = ['Payment cards on the selected daemon could not be read:', `  ${describeCardFailure(error)}`];
  }
  lines.push('Run /payments pending to review and answer purchase approval/veto windows on the selected paired host.');
  lines.push(
    'Billing/shipping address, budgets, windows and the rest of the payment capability are ordinary config values: set them via /config payments or the Settings > Payments category.',
  );
  return lines;
}

/** Card fields in prompt order, exported for tests that need to drive the chain field-by-field. */
export { CARD_ENTRY_FIELDS };

const promptCardFields = createCardEntryPrompter<CommandContext>(
  (ctx, card) => cardHost.create(ctx, card),
  {
    prompt: (field) => `[payments] Enter ${field.label} (e.g. ${field.placeholder}): masked; Enter to continue, Esc to stop.`,
    stored: (card) => `\n[payments] Card stored on the selected daemon: ${describeCard(card)}. Billing/shipping address and the rest of the payment capability are ordinary config values; set them via /config payments or the Settings > Payments category.`,
  },
);

export const { startCardEntryFlow, runPaymentsCommand, registerPaymentCardCommands } = createPaymentCardCommands<CommandContext>({
  surface: CARD_ENTRY_SURFACE,
  announcement: `Entering ${CARD_ENTRY_FIELDS.length} card field(s): masked; Esc to stop at any point. The card is sent to the selected daemon after the last one.`,
  promptFields: promptCardFields,
  status: renderCardStatus,
  pending: openPendingPaymentWindows,
  approve: approvePurchaseInAdvance,
  standing: manageStandingAuthorizations,
  remove: (ctx, id) => cardHost.remove(ctx, id),
  description: 'Payment card setup, pending purchase approval/veto windows, purchases approved in advance and standing authorisations for scheduled purchases',
  usage: '/payments [card [remove <id>]|status|pending|approve <merchant> <item> <maximum>|standing [list|add <shops> <item> <per-purchase> <per-period> <days> [<last day>]|remove <id>]]',
  argsHint: '[card|status|pending|approve|standing]',
});
