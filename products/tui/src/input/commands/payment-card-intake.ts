import { createCardEntryPrompter, createPaymentCardHost, renderCardList, describeCard, describeCardFailure, CARD_ENTRY_FIELDS, CardHostError, type CardField } from '@goodvibes/engine/terminal-shell/card-field-prompts';
import { createPaymentWindowCommand } from '@goodvibes/engine/terminal-shell/payment-window-command';
import { registerPaymentsCommand } from '@goodvibes/engine/terminal-shell/payments-command';
import { paymentsAddressConfigKey, type PaymentsAddressKind } from '@goodvibes/engine/terminal-shell/payments-settings';
import { OwnedSelectionObservation } from '@goodvibes/engine/platform/platform/runtime/client/selection-observation';
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { bindCredential, daemonTarget } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target';
/**
 * The terminal app's host for `/payments` (terminal-shell/payments-command.ts):
 * "Add a card" captures a payment card through the composer's concealed input
 * mode and stores it on the selected paired daemon with one
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
 * `/payments cards` lists the cards the daemon holds from `payments.cards.list`.
 *
 * Billing and shipping address are ordinary (non-secret) config fields, real
 * structured CONFIG_SCHEMA entries (payments.billingAddress.* and
 * payments.shippingAddress.*); this command points the user at the Payments
 * settings category (or /payments address) for them rather than routing plain
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
 * lets "Add a card" be reached from somewhere else: the check is real
 * and platform-driven, not an implicit "this is the TUI so it's fine" assumption.
 */

import { isDirectOwnerCommandContext, type CommandContext, type CommandRegistry } from '../command-registry.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';


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
  for (const kind of ['billing', 'shipping'] as const) {
    const set = (['name', 'line1', 'city', 'postalCode', 'country'] as const).map((field): unknown => ctx.platform.configManager.get(paymentsAddressConfigKey(kind, field) as never)).filter((value): value is string => typeof value === 'string' && value.length > 0);
    lines.push(`${kind === 'billing' ? 'Billing' : 'Shipping'} address: ${set.length > 0 ? set.join(', ') : 'not set (/payments address)'}`);
  }
  lines.push('/payments pending shows the purchases waiting for your answer; budgets and windows are in Settings > Payments.');
  return lines;
}

/** Card fields in prompt order, exported for tests that need to drive the chain field-by-field. */
export { CARD_ENTRY_FIELDS };

/**
 * The daemon a card entry is for (`DaemonTarget.id`: its origin and the
 * fingerprint of the credential this terminal holds for it), read from the same
 * selection the card host uses, or null when none is usable.
 */
function selectedCardDaemon(ctx: CommandContext): string | null {
  const selection = ownerOperatorConnectionPolicy.read(ctx, new OwnedSelectionObservation());
  const origin = selection ? parseDaemonOrigin(selection.baseUrl) : null;
  return selection && origin ? daemonTarget(origin, bindCredential(origin, selection.token, 'pairing'), false).id : null;
}

/** The daemon each card entry was started for, chosen before its first field. */
const cardEntryDaemons = new WeakMap<CommandContext, string>();

const promptCardChain = createCardEntryPrompter<CommandContext>(
  (ctx, card) => {
    const chosen = cardEntryDaemons.get(ctx);
    cardEntryDaemons.delete(ctx);
    const now = selectedCardDaemon(ctx);
    // The card goes only to the daemon that was selected when its entry began.
    if (!chosen || now !== chosen) {
      const where = (id: string | null | undefined): string => id ? id.replace(/#.*$/, '') : 'none';
      return Promise.reject(new CardHostError(`The selected daemon changed while the card was being entered (it was ${where(chosen)}, now ${where(now)}${chosen && now && where(chosen) === where(now) ? ', with another credential' : ''}). Choose "Add a card" in /payments again to enter it for the daemon selected now.`));
    }
    return cardHost.create(ctx, card);
  },
  {
    prompt: (field) => `[payments] Enter ${field.label} (e.g. ${field.placeholder}): masked; Enter to continue, Esc to stop.`,
    stored: (card) => `\n[payments] Card stored on the selected daemon: ${describeCard(card)}. Set the addresses purchases use with /payments address; budgets and windows are in Settings > Payments.`,
  },
);

/** Card entry: the daemon is resolved before the first field, and the card is created only on that one. */
function promptCardFields(ctx: CommandContext, fields: readonly CardField[], index: number): void {
  if (index === 0) {
    const daemon = selectedCardDaemon(ctx);
    if (!daemon) {
      ctx.print('[payments] No paired daemon is selected, or its credential cannot be read. Check the selected host and pairing (/devices host-status), then choose "Add a card" in /payments again. Nothing was asked or sent.');
      return;
    }
    cardEntryDaemons.set(ctx, daemon);
  }
  promptCardChain(ctx, fields, index);
}

const openPendingPaymentWindows = createPaymentWindowCommand<CommandContext>({
  ...ownerOperatorConnectionPolicy, isOwner: (context) => isDirectOwnerCommandContext(context, 'payments'),
});

/** An address field written to this machine's settings, which the daemon on this machine reads. */
async function setAddress(ctx: CommandContext, kind: PaymentsAddressKind, fields: Readonly<Record<string, string>>): Promise<string> {
  for (const [field, value] of Object.entries(fields)) {
    ctx.platform.configManager.setDynamic(paymentsAddressConfigKey(kind, field as never), value);
  }
  return `Kept in this machine's settings (${Object.keys(fields).length} field${Object.keys(fields).length === 1 ? '' : 's'}).`;
}

/** Register `/payments` with this app's host. */
export function registerPaymentCardCommands(registry: CommandRegistry): void {
  registerPaymentsCommand<CommandContext>(registry, {
    cardEntrySurface: CARD_ENTRY_SURFACE,
    policy: { ...ownerOperatorConnectionPolicy, isOwner: (context) => isDirectOwnerCommandContext(context, 'payments') },
    status: renderCardStatus,
    promptCardFields,
    listCards: (ctx) => cardHost.list(ctx),
    removeCard: (ctx, id) => cardHost.remove(ctx, id),
    setAddress,
    pending: openPendingPaymentWindows,
  });
}
