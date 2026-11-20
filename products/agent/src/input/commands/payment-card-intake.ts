import { createCardEntryPrompter, createPaymentCardHost, createPaymentCardCommands, renderCardList, describeCard, describeCardFailure, CARD_ENTRY_FIELDS, CardHostError, type CardField } from '@goodvibes-jev/engine/terminal-shell/card-field-prompts';
import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client/selection-observation';
import { parseDaemonOrigin } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';
import { bindCredential, daemonTarget } from '@goodvibes-jev/engine/platform/platform/runtime/client/daemon-target';
/**
 * /payments, enter the payment instrument and the two addresses at the
 * agent's own terminal.
 *
 * Mirrors the TUI's commands/payment-card-intake.ts deliberately: the owner
 * asked for payment entry on both surfaces ("and in the agent - basically ui
 * should expose it in both"), and two surfaces that ask for a card in two
 * different shapes is how one of them ends up with a weaker rule than the
 * other. Same subcommands, same field order, same concealed-input mechanism,
 * same daemon-scoped storage. What differs is only this surface's identity,
 * `agent-terminal` rather than `tui`, and the guided address flow below,
 * which this surface adds.
 *
 * ── Card material: masked, and stored by the daemon ────────────────────
 *
 * The label, kind, number, expiry (month and year), CVV and cardholder name are
 * each entered through one masked concealed-input prompt. The answers are held
 * in memory only until the last one, then sent in one `payments.cards.create`
 * request to the selected paired daemon, which keeps the card material in its
 * own encrypted secret store and returns metadata only. Nothing about the card
 * is written to this machine's config or secret store, the transcript, the
 * input history file, or a log line; a failure prints fixed text, never the
 * request or the daemon's own message. Esc before the last answer discards
 * everything.
 *
 * The DAEMON is the point, not a detail: it completes an unattended purchase,
 * with every surface closed and this program not running at all, and it can
 * spend only from a card in its own store (the ids `payments.cards.list`
 * returns). `/payments status` lists those cards.
 *
 * ── Addresses: real schema keys, entered in the clear, same command ──────
 *
 * `payments.billingAddress.*` and `payments.shippingAddress.*` are fourteen
 * real CONFIG_SCHEMA string keys. They are entered through a guided chain on
 * this same command (`/payments address billing`), and they are NOT masked. A
 * postal address is not a credential: it is printed on every parcel, it is
 * already visible in the settings modal, and masking it would teach the reflex
 * that bullets mean "safe to type anywhere", the opposite of what the card
 * fields need bullets to mean. They still land at daemon scope, by the same
 * `payments.` prefix rule, so the daemon has an address to ship to.
 *
 * ── Where card details may be typed at all ───────────────────────────────
 *
 * Gated on the platform's own allowlist (platform/payments/entry-surface.ts), never
 * on a literal decided here. Card material may be TYPED only on `tui`,
 * `agent-terminal` or `webui`, never over Telegram, ntfy, Discord, Slack,
 * WhatsApp, Signal, a webhook, or any other remote messaging surface. A card
 * number typed into a hosted chat sits on that provider's servers, in history
 * this program cannot erase, and it passed through their infrastructure before
 * reaching us; encrypting it here afterwards does nothing for a value already
 * copied elsewhere.
 *
 * That is a SEPARATE question from which surfaces may APPROVE or VETO a
 * purchase, every command-authority channel still can, and the two checks are
 * never merged. See the platform module's header.
 *
 * This command always runs in the agent's own composer, which the allowlist
 * accepts, so the gate changes nothing about today's behavior. What it buys is
 * that the refusal already exists the moment a shared command registry ever
 * grows a path that reaches `/payments card` from somewhere else: the check is
 * real and platform-driven, not an implicit "this is a terminal so it's fine".
 */

import type { CommandContext } from '../command-registry.ts';
import { approvePurchaseInAdvance, manageStandingAuthorizations, openPendingPaymentWindows } from './payments-pending.ts';
import { ownerOperatorConnectionPolicy } from './operator-connection-policy.ts';
import { agentDaemonConfigClient, agentDaemonConfigClientInstalled, routeDaemonOwnedConfigWrite } from '../../config/daemon-config-routing.ts';
import type { ConfigKey } from '../../config/index.ts';
import '@goodvibes-jev/engine/platform/platform/payments';
import { PAYMENTS_ADDRESS_FIELD_SUFFIXES, paymentsAddressConfigKey, type PaymentsAddressKind } from '../payments-config.ts';

/**
 * This surface's identity in the platform's card-entry allowlist.
 *
 * `agent-terminal`, not `tui`: they are different surfaces with different
 * command registries, and naming this one honestly is what lets the allowlist
 * be the authority instead of each surface assuming it qualifies. Exported so
 * tests assert the real constant rather than a copy of the string.
 */
export const CARD_ENTRY_SURFACE = 'agent-terminal';

const cardHost = createPaymentCardHost<CommandContext>(ownerOperatorConnectionPolicy);

interface AddressField {
  readonly key: ConfigKey;
  readonly label: string;
  readonly placeholder: string;
}

const ADDRESS_FIELD_LABELS: Readonly<Record<string, { label: string; placeholder: string }>> = {
  name: { label: 'Recipient name', placeholder: 'Jane Doe' },
  line1: { label: 'Address line 1', placeholder: '123 Main St' },
  line2: { label: 'Address line 2', placeholder: 'Apt 4B, blank if none' },
  city: { label: 'City', placeholder: 'Springfield' },
  region: { label: 'State / region', placeholder: 'IL' },
  postalCode: { label: 'Postal code', placeholder: '62704' },
  country: { label: 'Country', placeholder: 'US' },
};

function addressFields(kind: PaymentsAddressKind): readonly AddressField[] {
  return PAYMENTS_ADDRESS_FIELD_SUFFIXES.map((field) => {
    const meta = ADDRESS_FIELD_LABELS[field] ?? { label: field, placeholder: '' };
    return { key: paymentsAddressConfigKey(kind, field), label: meta.label, placeholder: meta.placeholder };
  });
}

/**
 * Address values the connected host accepted from this process. A host on
 * another machine keeps its own file, so this process's config cannot read them
 * back; remembering what the host acknowledged keeps /payments status honest.
 */
const hostAcknowledgedAddressValues = new WeakMap<object, Map<string, string>>();

function readConfigString(ctx: CommandContext, key: ConfigKey): string {
  const acknowledged = hostAcknowledgedAddressValues.get(ctx.platform.configManager)?.get(key);
  if (acknowledged !== undefined) return acknowledged;
  try {
    const raw: unknown = ctx.platform.configManager.get(key);
    return typeof raw === 'string' ? raw : '';
  } catch {
    return '';
  }
}

/**
 * Status. Cards come from the daemon's `payments.cards.list`, metadata only:
 * label, kind, brand, last four digits and expiry. No operator path returns the
 * card number, CVV or name, and a status line is not the place to invent one.
 *
 * Address fields DO show their values: they are ordinary config the settings
 * modal already displays, and a shipping address you cannot read back is a
 * shipping address you cannot check before a purchase goes out.
 */
async function renderStatus(ctx: CommandContext): Promise<string[]> {
  const client = agentDaemonConfigClient();
  // The connected host is the authority for an address; ask it, and fall back to what this process knows when it cannot answer.
  const hostValues = new Map<string, string>();
  if (client) {
    const keys = (['billing', 'shipping'] as const).flatMap((kind) => addressFields(kind).map((field) => field.key));
    await Promise.all(keys.map(async (key) => {
      try {
        const raw: unknown = await client.get(key);
        if (typeof raw === 'string') hostValues.set(key, raw);
      } catch {
        // an unreachable host leaves the local reading in place
      }
    }));
  }
  let lines: string[];
  try {
    lines = renderCardList(await cardHost.list(ctx));
  } catch (error: unknown) {
    lines = ['Payment cards on the selected daemon could not be read:', `  ${describeCardFailure(error)}`];
  }
  for (const kind of ['billing', 'shipping'] as const) {
    lines.push('');
    lines.push(`${kind === 'billing' ? 'Billing' : 'Shipping'} address:`);
    for (const field of addressFields(kind)) {
      const value = hostValues.get(field.key) ?? readConfigString(ctx, field.key);
      lines.push(`  ${field.label.padEnd(20)} ${value.length > 0 ? value : '(not set)'}`);
    }
  }
  lines.push('Run /payments pending to review and answer purchase approval/veto windows on the selected paired host.');
  lines.push('Run /payments address billing or /payments address shipping to enter an address (chained prompts, shown as typed).');
  lines.push(
    'Budgets, windows, CVV handling and the rest of the payment capability are ordinary config values: set them via /config payments or the Settings > Payments category.',
  );
  return lines;
}

/**
 * Start the card-entry flow, gated on the platform's own entry-surface allowlist
 * rather than an assumption baked into this command. `surface` defaults to this
 * command's real, fixed identity, exposed as a parameter only so tests can
 * drive the refusal path without this program actually being reachable from a
 * remote channel.
 */

/**
 * Chain a plain (unmasked) prompt for each address field.
 *
 * Uses the composer's ordinary submit path via `awaitPlainLine` below rather
 * than the concealed one, see this file's header for why an address is
 * entered in the clear.
 */
function promptAddressFields(
  ctx: CommandContext,
  kind: PaymentsAddressKind,
  fields: readonly AddressField[],
  index: number,
  failed: readonly string[] = [],
): void {
  if (index >= fields.length) {
    const title = kind === 'billing' ? 'Billing' : 'Shipping';
    if (failed.length > 0) {
      ctx.print(`\n[payments] ${title} address only partly saved: ${failed.join(', ')} ${failed.length === 1 ? 'was' : 'were'} NOT saved. Re-run /payments address ${kind} to retry; /payments status shows what is set.`);
    } else {
      ctx.print(`\n[payments] ${title} address saved to the daemon-owned config tier${agentDaemonConfigClientInstalled() ? ' (on the connected host)' : ''}.`);
    }
    ctx.renderRequest();
    return;
  }
  const field = fields[index]!;
  const current = readConfigString(ctx, field.key);
  const currentNote = current.length > 0 ? ` [currently ${current}]` : '';
  ctx.print(`[payments] Enter ${field.label} (e.g. ${field.placeholder})${currentNote}, Enter to save, Esc to stop.`);
  awaitPlainLine(ctx, field, {
    onSubmit: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        ctx.print(`[payments] ${field.label} left as-is.`);
        promptAddressFields(ctx, kind, fields, index + 1, failed);
        return;
      }
      const saved = () => {
        ctx.print(`[payments] ${field.label} set to ${trimmed}.`);
        promptAddressFields(ctx, kind, fields, index + 1, failed);
      };
      const refused = (error: unknown) => {
        ctx.print(`[payments] Failed to set ${field.label}: ${error instanceof Error ? error.message : String(error)}`);
        promptAddressFields(ctx, kind, fields, index + 1, [...failed, field.label]);
      };
      const writeLocally = () => {
        try {
          ctx.platform.configManager.setDynamic(field.key, trimmed);
        } catch (error: unknown) {
          refused(error);
          return;
        }
        saved();
      };
      // The daemon completes the purchase and reads its own settings, so with a
      // connected host the address is written there, the same route the settings
      // modal uses. The next prompt waits for the host's answer.
      if (!agentDaemonConfigClientInstalled()) {
        writeLocally();
        return;
      }
      routeDaemonOwnedConfigWrite(field.key, trimmed).then((routed) => {
        if (routed !== 'daemon') {
          writeLocally();
          return;
        }
        const store = hostAcknowledgedAddressValues.get(ctx.platform.configManager) ?? new Map<string, string>();
        store.set(field.key, trimmed);
        hostAcknowledgedAddressValues.set(ctx.platform.configManager, store);
        saved();
      }, refused);
    },
    onCancel: () => {
      ctx.print(`[payments] Stopped. Re-run /payments address ${kind} to finish the remaining fields.`);
    },
  });
}

/**
 * One line of ORDINARY composer entry, chained like the concealed flow.
 *
 * Goes through `beginPlainInput`, a genuinely separate composer slot from the
 * masked one, rather than a `conceal: false` flag on ConcealedInputRequest.
 * That flag is the obvious design and is rejected on purpose: a boolean
 * controlling whether a card number is echoed is one wrong default, one
 * refactor or one copied call site away from a PAN on screen, and whoever makes
 * that change will not have read this file first. The masked request type
 * therefore carries no masking flag at all, it is masked by its type. See
 * input/plain-line-input.ts.
 *
 * What this means in practice: address fields ARE echoed while being typed,
 * which is correct, they are ordinary config values, the same as typing them
 * through `/config`. Neither kind of guided answer is added to input history:
 * both are consumed by the composer's line-prompt route before the normal
 * submit path runs, so "62704" does not become a chat-recall entry.
 */
function awaitPlainLine(
  ctx: CommandContext,
  field: AddressField,
  handlers: { onSubmit: (value: string) => void; onCancel: () => void },
): void {
  if (!ctx.beginPlainInput) {
    // Name the real config KEY, not the human label, the label is not
    // something /config accepts, and a hint that does not work is worse than
    // no hint.
    ctx.print(`[payments] Guided entry is unavailable on this surface. Set it directly with /config, key ${field.key}.`);
    return;
  }
  ctx.beginPlainInput({ label: field.label, onSubmit: handlers.onSubmit, onCancel: handlers.onCancel });
}

/** Entry point for `/payments [card|address|status]`, exported so tests can drive it without the registry. */

/** Start the guided address flow for one of the two addresses. */
export function startAddressEntryFlow(ctx: CommandContext, kind: PaymentsAddressKind): void {
  const fields = addressFields(kind);
  ctx.print(`Entering ${fields.length} ${kind} address field(s), Esc to stop at any point. Blank keeps the current value.`);
  promptAddressFields(ctx, kind, fields, 0);
}

/** Card fields in prompt order, exported for tests that drive the chain field-by-field. */
export { CARD_ENTRY_FIELDS, addressFields };

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
    prompt: (field) => `[payments] Enter ${field.label} (e.g. ${field.placeholder}), masked; Enter to continue, Esc to stop.`,
    stored: (card) => `\n[payments] Card stored on the selected daemon: ${describeCard(card)}. Set the addresses purchases use with /payments address if they are not set yet.`,
  },
);

/** Card entry: the daemon is resolved before the first field, and the card is created only on that one. */
function promptCardFields(ctx: CommandContext, fields: readonly CardField[], index: number): void {
  if (index === 0) {
    const daemon = selectedCardDaemon(ctx);
    if (!daemon) {
      ctx.print('[payments] No paired daemon is selected, or its credential cannot be read. Check the selected host and pairing (/host), then choose "Add a card" in /payments again. Nothing was asked or sent.');
      return;
    }
    cardEntryDaemons.set(ctx, daemon);
  }
  promptCardChain(ctx, fields, index);
}

export const { startCardEntryFlow, runPaymentsCommand, registerPaymentCardCommands } = createPaymentCardCommands<CommandContext>({
  surface: CARD_ENTRY_SURFACE,
  announcement: `Entering ${CARD_ENTRY_FIELDS.length} card field(s), masked; Esc to stop at any point. The card is sent to the selected daemon after the last one.`,
  promptFields: promptCardFields,
  status: renderStatus,
  pending: openPendingPaymentWindows,
  approve: approvePurchaseInAdvance,
  standing: manageStandingAuthorizations,
  remove: (ctx, id) => cardHost.remove(ctx, id),
  address: startAddressEntryFlow,
  description: 'Payment card/address setup, pending purchase approval/veto windows, purchases approved in advance and standing authorisations for scheduled purchases',
  usage: '/payments [card [remove <id>]|address <billing|shipping>|status|pending|approve <merchant> <item> <maximum>|standing [list|add <shops> <item> <per-purchase> <per-period> <days> [<last day>]|remove <id>]]',
  argsHint: '[card|address|status|pending|approve|standing]',
});
