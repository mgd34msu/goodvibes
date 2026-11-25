/**
 * `/payments`, described once (command-actions/): both terminal apps register
 * this one description. Every action but one is a Money capability
 * (platform capabilities/builtin/money.ts) that runs in the daemon through
 * `capabilities.run`, as the person's own request when a person typed it or
 * pressed it in the Money place; the daemon's payments methods keep their own
 * scopes and confirmation. The one that stays with the terminal program is the
 * purchases waiting for an answer (Waiting for you). A card is typed in the
 * capability's own form, its number, expiry, security code and name hidden as
 * they are typed, and only on a surface the card-entry allowlist names.
 *
 * No amount, card or shop is read by a model: the owner types or picks each one.
 */
import { mayOfferCardEntryFlow, describeCardEntryRefusal } from '@goodvibes/engine/platform/platform/payments';
import {
  PAYMENTS_ADD_CARD, PAYMENTS_ADDRESS, PAYMENTS_APPROVE, PAYMENTS_CARDS, PAYMENTS_REMOVE_CARD, PAYMENTS_REPEAT, PAYMENTS_REPEATS, PAYMENTS_STOP_REPEAT,
  PAYMENT_CARDS_LIST, PAYMENT_SHOPS_LIST, REPEAT_PURCHASES_LIST,
} from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { daemonCapabilityAction, runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { ActionDescription, CommandActionContext, CommandDescription } from './command-actions/types.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import type { PaymentWindowCommandContext } from './payment-window-command.js';

export type PaymentsCommandContext = CommandActionContext & PaymentWindowCommandContext & { readonly renderRequest: () => void };

/** What one terminal app supplies: how it reaches the daemon, where card details are typed, and the purchases waiting. */
export interface PaymentsHost<Ctx extends PaymentsCommandContext> {
  /** The surface card details are typed on (`tui`, `agent-terminal`), checked against the platform's card-entry allowlist. */
  readonly cardEntrySurface: string;
  /** How this app's slash actions reach the daemon's capabilities (each product's capability-binding.ts). */
  readonly capabilities: DaemonCapabilityBinding<Ctx>;
  /** The purchase windows picker (approve, deny, stop a checkout, type a security code). */
  readonly pending: (ctx: Ctx) => Promise<void>;
}

/**
 * The host of the app this process runs. One app runs per process; the check
 * that loads both registries never runs an action.
 */
let installedHost: PaymentsHost<PaymentsCommandContext> | undefined;

function hostOf(): PaymentsHost<PaymentsCommandContext> {
  if (!installedHost) throw commandRefusal('Payments are not available in this session.');
  return installedHost;
}

/** The daemon binding of the installed app, read when an action runs (the description is built once, before any app registers it). */
const binding: DaemonCapabilityBinding<PaymentsCommandContext> = {
  daemon: (ctx) => hostOf().capabilities.daemon(ctx),
  caller: (ctx) => hostOf().capabilities.caller(ctx),
};

function text(value: unknown): string {
  return stripDangerousAnsi(String(value ?? '')).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function rowsOf(data: Readonly<Record<string, unknown>> | undefined, field: string): readonly Readonly<Record<string, unknown>>[] {
  const rows = data?.[field];
  return Array.isArray(rows) ? rows.filter((row): row is Readonly<Record<string, unknown>> => row !== null && typeof row === 'object') : [];
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

defineList<PaymentsCommandContext>({
  name: PAYMENT_CARDS_LIST,
  async read(ctx) {
    const answer = await runDaemonCapability('payments.cards', {}, ctx, binding);
    return rowsOf(answer.data, 'cards').map((card): ListRow => ({
      value: text(card.id), label: text(card.name), detail: text(card.detail), ...(card.state === 'default' ? { state: 'used by default' } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'payments.cards' }, rows: { from: 'data.cards', value: 'id', label: 'name', detail: 'detail' } },
});

defineList<PaymentsCommandContext>({
  name: REPEAT_PURCHASES_LIST,
  async read(ctx) {
    const answer = await runDaemonCapability('payments.repeats', {}, ctx, binding);
    return rowsOf(answer.data, 'authorizations').map((row): ListRow => ({
      value: text(row.id), label: text(row.name), detail: text(row.detail), ...(row.state === 'ended' ? { state: 'ended' } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'payments.repeats' }, rows: { from: 'data.authorizations', value: 'id', label: 'name', detail: 'detail' } },
});

defineList<PaymentsCommandContext>({
  name: PAYMENT_SHOPS_LIST,
  async read(ctx) {
    const answer = await binding.daemon(ctx).invoke<{ readonly purchases?: unknown }>('payments.purchases.list', {});
    const purchases = Array.isArray(answer.purchases) ? answer.purchases as readonly Readonly<Record<string, unknown>>[] : [];
    const seen = new Map<string, number>();
    for (const purchase of purchases) {
      const shop = text(purchase.merchantDomain);
      if (shop) seen.set(shop, (seen.get(shop) ?? 0) + 1);
    }
    return [...seen].map(([shop, count]): ListRow => ({ value: shop, label: shop, state: `${count} purchase${count === 1 ? '' : 's'}` }));
  },
  operator: { method: 'payments.purchases.list', input: {}, rows: { from: 'purchases', value: 'merchantDomain', label: 'merchantDomain' } },
});

/**
 * "Add a card": the capability's own form (the number, expiry, security code and name hidden as they are typed),
 * stored by the daemon. Card details are typed only on a surface the platform's card-entry allowlist names.
 */
function addCardAction(): ActionDescription<PaymentsCommandContext> {
  const action = daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_ADD_CARD, binding);
  return {
    ...action,
    // The web UI takes a card on its own card form, which checks each field as it is typed.
    operator: { terminalOnly: 'The web UI adds a card on its own card form under Settings > Payments.' },
    async run(values, ctx) {
      const surface = hostOf().cardEntrySurface;
      if (!mayOfferCardEntryFlow(surface)) throw commandRefusal(describeCardEntryRefusal(surface));
      return action.run(values, ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// The description
// ---------------------------------------------------------------------------

export const PAYMENTS_COMMAND: CommandDescription<PaymentsCommandContext> = {
  name: 'payments',
  title: 'Payments',
  summary: 'Cards, purchases, and what may be bought without asking',
  group: 'Payments',
  report: 'see-cards',
  firstScreenRows: [
    'see-cards',
    'see-waiting',
    'approve-ahead',
    { label: 'Repeat purchases', actions: ['allow-repeat', 'see-repeats', 'stop-repeat'] },
    { label: 'Cards and addresses', actions: ['add-card', 'remove-card', 'set-address'] },
  ],
  actions: [
    daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_CARDS, binding),
    {
      id: 'see-waiting', label: 'See what is waiting for your answer', word: 'pending', inputs: [],
      sentence: 'Opens the purchases waiting for you: approve or deny one, stop a checkout, or type a card\'s security code; each answer is asked again before it is sent.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      ownerOnly: { reason: 'answering a purchase is the owner\'s own act', instead: 'Ask the owner to answer it in Waiting for you.' },
      operator: { terminalOnly: 'The web UI answers purchases on its Purchases screen.' }, example: {},
      async run(_values, ctx) {
        await hostOf().pending(ctx);
      },
    },
    daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_APPROVE, binding),
    { ...daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_REPEAT, binding), stepTitles: ['Lets a schedule buy the same thing again without asking you each time.'] },
    daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_REPEATS, binding),
    daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_STOP_REPEAT, binding),
    addCardAction(),
    daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_REMOVE_CARD, binding),
    daemonCapabilityAction<PaymentsCommandContext>(PAYMENTS_ADDRESS, binding),
  ],
};

const PAYMENTS_SLASH_COMMAND = defineCommand(PAYMENTS_COMMAND);

/** Register `/payments` (the one description) with this app's host. */
export function registerPaymentsCommand<Ctx extends PaymentsCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: PaymentsHost<Ctx>): void {
  installedHost = host as unknown as PaymentsHost<PaymentsCommandContext>;
  registry.register(PAYMENTS_SLASH_COMMAND);
}
