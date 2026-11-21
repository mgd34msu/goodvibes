/**
 * `/payments`, described once (command-actions/): both terminal apps register
 * this one description, so the guided path, typed line, help, completion,
 * confirmation and the model's catalogue entry are the same in each. What
 * differs between the apps (where the daemon is found, how a card's fields are
 * asked, where an address is written) is the host each app installs when it
 * registers the command.
 *
 * Every action reaches the selected paired daemon through a fresh retained
 * operator connection, checks that it holds the owner's paired payments
 * credential, and closes the connection when it is done. No amount, card or
 * shop is read by a model: the owner types or picks each one.
 */
import { mayOfferCardEntryFlow, describeCardEntryRefusal, formatMinorUnits, parseCurrencyCode } from '@goodvibes/engine/platform/platform/payments';
import type { OperatorApiClient } from '@goodvibes/engine/operator-client';
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, readList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext, CommandDescription, InputDescription } from './command-actions/types.js';
import { CARD_ENTRY_FIELDS, describeCard, describeCardFailure, type CardField, type CardSummary } from './card-field-prompts.js';
import { describeRetainedConnectionFailure, RetainedOperatorConnection } from './retained-operator-connection.js';
import { isPairedOperatorPrincipal } from './native/native-paired-principal.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import type { PaymentWindowCommandContext, PaymentWindowCommandPolicy } from './payment-window-command.js';
import { PAYMENTS_ADDRESS_FIELD_SUFFIXES, type PaymentsAddressKind } from './payments-settings.js';

export type PaymentsCommandContext = CommandActionContext & PaymentWindowCommandContext & { readonly renderRequest: () => void };

/** What one terminal app supplies: where the daemon is, how card fields are asked, and where an address is written. */
export interface PaymentsHost<Ctx extends PaymentsCommandContext> {
  /** The surface card details are typed on (`tui`, `agent-terminal`), checked against the platform's card-entry allowlist. */
  readonly cardEntrySurface: string;
  readonly policy: PaymentWindowCommandPolicy<Ctx>;
  /** What "See your cards" prints: the cards the daemon holds and, where the app keeps them, the addresses. */
  readonly status: (ctx: Ctx) => Promise<readonly string[]>;
  /** Ask the card's fields one at a time, each hidden, and store it on the daemon selected when the first is asked. */
  readonly promptCardFields: (ctx: Ctx, fields: readonly CardField[], index: number) => void;
  readonly listCards: (ctx: Ctx) => Promise<{ readonly cards: readonly CardSummary[]; readonly defaultCardId: string }>;
  readonly removeCard: (ctx: Ctx, id: string) => Promise<{ readonly deleted: boolean }>;
  /** Write the address fields given (a blank one is left as it is); the line says where it was kept. */
  readonly setAddress: (ctx: Ctx, kind: PaymentsAddressKind, fields: Readonly<Record<string, string>>) => Promise<string>;
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

function text(value: unknown): string {
  return stripDangerousAnsi(String(value ?? '')).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/**
 * Run one request on the selected daemon as its paired payments owner. A
 * refusal names what was wrong when the daemon said so in payment words; a
 * transport failure is never echoed (it could quote the request).
 */
async function onDaemon<T>(
  ctx: PaymentsCommandContext,
  scope: 'read:payments' | 'write:payments',
  attempt: string,
  work: (operator: OperatorApiClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const policy = hostOf().policy;
  const lifetime = new AbortController();
  let connection: RetainedOperatorConnection;
  try {
    connection = new RetainedOperatorConnection({
      owner: () => policy.owner(ctx), home: () => policy.home(ctx),
      read: (observation) => policy.read(ctx, observation), files: policy.files,
      environment: policy.environment, fetchImpl: policy.fetchImpl, signal: lifetime.signal,
    });
  } catch (error) {
    throw commandRefusal(`${attempt} was not done: ${describeRetainedConnectionFailure(error, 'try again')}`);
  }
  try {
    const auth = await connection.run((operator, signal) => operator.control.auth.current({}, { signal }));
    if (!isPairedOperatorPrincipal(auth, ['read:payments', scope], connection.expectedPrincipalId)) {
      throw commandRefusal(`${attempt} was not done: the selected daemon does not give this terminal the owner's paired payments credential.`, 'Check the selected host and its pairing (/devices host-status).');
    }
    return await connection.run(work);
  } catch (error) {
    if (error instanceof Error && error.name === 'RefusalError') throw error;
    const said = error instanceof Error && /standing|amount|merchant|item|period|expire|approval|currency|payments\./i.test(error.message) ? ` ${text(error.message)}` : '';
    throw commandRefusal(`${attempt} was not confirmed.${said}`, 'Check the selected host and its pairing, then try again; /payments repeats and /payments cards show what the daemon holds.');
  } finally {
    lifetime.abort();
    await connection.close();
  }
}

const EXPLICIT = { 'x-goodvibes-explicit-user-request': 'true' } as const;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

/** An amount the daemon holds in its currency's minor units, rendered by the platform's one money formatter (its exponent, its symbol). */
function minor(units: unknown, currency: unknown): string {
  const code = typeof currency === 'string' ? parseCurrencyCode(currency) : null;
  return typeof units === 'number' && Number.isSafeInteger(units) && units >= 0 && code ? formatMinorUnits(units, code) : '?';
}

function repeatSummary(row: Readonly<Record<string, unknown>>): string {
  const merchants = Array.isArray(row.merchants) ? row.merchants.map(text).join(', ') : '';
  const until = typeof row.expiresAt === 'string' && row.expiresAt ? `, last day ${text(row.expiresAt).slice(0, 10)}` : '';
  return `"${text(row.item)}" from ${merchants}: at most ${minor(row.maxPerPurchaseMinorUnits, row.currency)} each, ${minor(row.maxPerPeriodMinorUnits, row.currency)} every ${text(row.periodDays)} days${until}; ${minor(row.leftMinorUnits, row.currency)} left this period`;
}

// ---------------------------------------------------------------------------
// Live lists, read only when a guided step or a completion asks
// ---------------------------------------------------------------------------

const PAYMENT_CARDS = defineList<PaymentsCommandContext>({
  name: 'payments.cards',
  async read(ctx) {
    let list;
    try { list = await hostOf().listCards(ctx); } catch (error) { throw commandRefusal(describeCardFailure(error, 'remove')); }
    return list.cards.map((card): ListRow => ({ value: card.id, label: text(card.label), detail: describeCard(card), ...(card.id === list.defaultCardId ? { state: 'used by default' } : {}) }));
  },
  operator: { method: 'payments.cards.list', input: {}, rows: { from: 'cards', value: 'id', label: 'label', detail: 'last4' } },
});

const REPEAT_PURCHASES = defineList<PaymentsCommandContext>({
  name: 'payments.repeats',
  async read(ctx) {
    const answer = record(await onDaemon(ctx, 'read:payments', 'Reading your repeat purchases', (operator, signal) => operator.invoke('payments.standing.list', {}, { signal })));
    const rows = Array.isArray(answer.authorizations) ? answer.authorizations.map(record) : [];
    return rows.map((row): ListRow => ({ value: text(row.id), label: text(row.item), detail: repeatSummary(row), ...(row.live === false ? { state: 'ended' } : {}) }));
  },
  operator: { method: 'payments.standing.list', input: {}, rows: { from: 'authorizations', value: 'id', label: 'item', detail: 'summary' } },
});

const SHOPS = defineList<PaymentsCommandContext>({
  name: 'payments.shops',
  async read(ctx) {
    const answer = record(await onDaemon(ctx, 'read:payments', 'Reading the shops you have bought from', (operator, signal) => operator.invoke('payments.purchases.list', {}, { signal })));
    const purchases = Array.isArray(answer.purchases) ? answer.purchases.map(record) : [];
    const seen = new Map<string, number>();
    for (const purchase of purchases) {
      const shop = text(purchase.merchantDomain);
      if (shop) seen.set(shop, (seen.get(shop) ?? 0) + 1);
    }
    return [...seen].map(([shop, count]): ListRow => ({ value: shop, label: shop, state: `${count} purchase${count === 1 ? '' : 's'}` }));
  },
  operator: { method: 'payments.purchases.list', input: {}, rows: { from: 'purchases', value: 'merchantDomain', label: 'merchantDomain' } },
});

const SHOP: InputDescription = {
  id: 'shop', label: 'Shop', help: 'Shops you have bought from, or type one', kind: 'choice',
  choices: { list: SHOPS, allowOther: { reason: 'a shop you have not bought from yet (its web address, such as shop.example)' } },
  required: true, typed: { position: 1 },
};
const ITEM: InputDescription = {
  id: 'item', label: 'What may be bought', help: 'In your own words; a purchase must name exactly this', kind: 'text',
  freeTextReason: 'your own words for the item', required: true, typed: { tail: true },
};

const ADDRESS_LABELS: Readonly<Record<string, { readonly label: string; readonly help: string }>> = {
  name: { label: 'Recipient name', help: 'As it goes on the parcel or the card statement' },
  line1: { label: 'Address line 1', help: 'Street and number' },
  line2: { label: 'Address line 2', help: 'Flat, floor or building; blank if none' },
  city: { label: 'City', help: 'Town or city' },
  region: { label: 'State or region', help: 'Blank where there is none' },
  postalCode: { label: 'Postal code', help: 'As the post office writes it' },
  country: { label: 'Country', help: 'Two letters, such as US or DE' },
};

const ADDRESS_INPUTS: readonly InputDescription[] = PAYMENTS_ADDRESS_FIELD_SUFFIXES.map((field): InputDescription => ({
  id: field,
  label: ADDRESS_LABELS[field]?.label ?? field,
  help: `${ADDRESS_LABELS[field]?.help ?? field}; blank keeps what is set`,
  kind: 'text',
  freeTextReason: 'part of your address',
  required: { default: '', defaultMeans: 'keep what is set' },
  typed: { flag: `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}` },
  step: 2,
}));

function ownerOnly(what: string): { readonly reason: string; readonly instead: string } {
  return { reason: `${what} is the owner's own act`, instead: 'Ask the owner to choose it from /payments.' };
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
    {
      id: 'see-cards', label: 'See your cards', word: 'cards', inputs: [],
      sentence: 'Shows the payment cards on the selected daemon (label, kind, last four digits and expiry, never the number) and the addresses purchases use.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'payments.cards.list', fields: {} }, example: {},
      async run(_values, ctx) {
        ctx.print((await hostOf().status(ctx)).join('\n'));
      },
    },
    {
      id: 'see-waiting', label: 'See what is waiting for your answer', word: 'pending', inputs: [],
      sentence: 'Opens the purchases waiting for you: approve or deny one, stop a checkout, or type a card\'s security code; each answer is asked again before it is sent.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      ownerOnly: ownerOnly('answering a purchase'),
      operator: { terminalOnly: 'The web UI answers purchases on its Purchases screen.' }, example: {},
      async run(_values, ctx) {
        await hostOf().pending(ctx);
      },
    },
    {
      id: 'approve-ahead', label: 'Approve one purchase ahead of time', word: 'approve',
      inputs: [SHOP, { id: 'most', label: 'At most', help: 'The most it may cost, in your payment currency, such as 25.00', kind: 'money', required: true, typed: { flag: '--most' } }, ITEM],
      sentence: 'One purchase of "{item}" from {shop}, of at most {most}, begun in the next five minutes, will need no further answer; it is used once and lasts for this session only.',
      done: 'Approved ahead of time: "{item}" from {shop}, at most {most}.',
      touches: 'another-machine', lasts: 'session', risk: 'spends-money',
      ownerOnly: ownerOnly('approving a purchase'),
      operator: { method: 'payments.checkout.approve', fields: { merchantDomain: 'shop', item: 'item', amount: 'most', confirm: '=true' } },
      example: { shop: 'shop.example', most: '25.00', item: 'USB-C cable' },
      async run(values, ctx) {
        const answer = record(await onDaemon(ctx, 'write:payments', 'The approval', (operator, signal) => operator.invoke(
          'payments.checkout.approve', { merchantDomain: values.shop!, item: values.item!, amount: values.most!, confirm: true }, { signal, headers: EXPLICIT },
        )));
        if (answer.approved !== true) throw commandRefusal('The daemon did not confirm the approval; nothing was approved.', '/payments pending shows what waits.');
        return `It ends ${new Date(text(answer.expiresAt)).toLocaleString()}; the amount is in ${text(answer.currency)}.`;
      },
    },
    {
      id: 'allow-repeat', label: 'Allow a repeat purchase', word: 'repeat',
      stepTitles: ['Lets a schedule buy the same thing again without asking you each time.'],
      inputs: [
        { ...SHOP, help: 'Shops you have bought from, or type one; more than one with --shop again', typed: { flag: '--shop', repeats: true }, step: 1 },
        { ...ITEM, typed: { flag: '--item' }, step: 1 },
        { id: 'each', label: 'Most per purchase', help: 'In your payment currency, such as 60.00', kind: 'money', required: true, typed: { flag: '--each' }, step: 1 },
        { id: 'per-period', label: 'Most in any period', help: 'All purchases under it together, such as 120.00', kind: 'money', required: true, typed: { flag: '--per-period' }, step: 1 },
        {
          id: 'days', label: 'Period', help: 'How many days the period is', kind: 'choice',
          choices: [{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: 'A year' }],
          required: { default: '30', defaultMeans: '30 days' }, typed: { flag: '--days' }, step: 1,
        },
        { id: 'until', label: 'Last day', help: 'A date such as 2027-06-30; blank for no end date', kind: 'date-time', required: { default: '', defaultMeans: 'no end date' }, typed: { flag: '--until' }, step: 1 },
      ],
      sentence: 'A schedule may buy "{item}" from {shop} without asking: at most {each} each time and {per-period} in any {days} days, until you change it or its last day passes. Every other spending limit still applies.',
      done: 'Allowed: "{item}" from {shop}. Stop it any time: Stop a repeat purchase.',
      touches: 'another-machine', lasts: 'kept', risk: 'spends-money', undoneBy: 'stop-repeat',
      ownerOnly: ownerOnly('allowing a repeat purchase'),
      operator: {
        method: 'payments.standing.create',
        fields: { merchants: 'shop:lines', item: 'item', maxPerPurchase: 'each', maxPerPeriod: 'per-period', periodDays: 'days:number', expires: 'until', confirm: '=true' },
      },
      example: { shop: 'shop.example', item: 'dog food', each: '60.00', 'per-period': '120.00', until: '2027-06-30' },
      async run(values, ctx) {
        const merchants = values.shop!.split('\n').flatMap((shop) => shop.split(',')).map((shop) => shop.trim()).filter(Boolean);
        const days = Number(values.days || '30');
        if (!Number.isInteger(days) || days < 1 || days > 366) throw commandRefusal(`The period is a whole number of days from 1 to 366; "${values.days}" is not. Nothing was allowed.`);
        if (values.until && !/^\d{4}-\d{2}-\d{2}$/.test(values.until)) throw commandRefusal(`The last day is a date such as 2027-06-30; "${values.until}" is not. Nothing was allowed.`);
        const answer = record(await onDaemon(ctx, 'write:payments', 'The repeat purchase', (operator, signal) => operator.invoke('payments.standing.create', {
          merchants, item: values.item!, maxPerPurchase: values.each!, maxPerPeriod: values['per-period']!, periodDays: days,
          ...(values.until ? { expires: values.until } : {}), confirm: true,
        }, { signal, headers: EXPLICIT })));
        const row = record(answer.authorization);
        return `${repeatSummary(row)}. A schedule names it as ${text(row.id)}.`;
      },
    },
    {
      id: 'see-repeats', label: 'See repeat purchases you have allowed', word: 'repeats', inputs: [],
      sentence: 'Shows each repeat purchase you have allowed: what, from which shops, the limits, and what is left this period.', done: '',
      touches: 'reads', lasts: 'not-a-change', risk: 'none',
      operator: { method: 'payments.standing.list', fields: {} }, example: {},
      async run(_values, ctx) {
        const rows = await readList(REPEAT_PURCHASES, ctx, {});
        ctx.print(rows.length === 0
          ? 'No repeat purchases. A schedule can buy only what you allow: /payments, "Allow a repeat purchase".'
          : ['Repeat purchases you have allowed:', ...rows.map((row) => `  ${row.label}${row.state ? ` (${row.state})` : ''}: ${row.detail ?? ''}`)].join('\n'));
      },
    },
    {
      id: 'stop-repeat', label: 'Stop a repeat purchase', word: 'stop-repeat',
      inputs: [{ id: 'repeat', label: 'Repeat purchase', help: 'The repeat purchases you have allowed', kind: 'choice', choices: { list: REPEAT_PURCHASES }, required: true, typed: { position: 1 } }],
      sentence: 'No new purchase will start under {repeat} {lasts}; one already running keeps its window, where you can still stop it.',
      done: 'Stopped {repeat}.',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'allow-repeat',
      operator: { method: 'payments.standing.delete', fields: { id: 'repeat', confirm: '=true' } },
      example: { repeat: 'standing-1' },
      async run(values, ctx) {
        const answer = record(await onDaemon(ctx, 'write:payments', 'Stopping the repeat purchase', (operator, signal) => operator.invoke('payments.standing.delete', { id: values.repeat!, confirm: true }, { signal, headers: EXPLICIT })));
        if (answer.deleted !== true) throw commandRefusal(`The daemon has no repeat purchase ${text(values.repeat)}; nothing was stopped.`, '/payments repeats lists them.');
        return undefined;
      },
    },
    {
      id: 'add-card', label: 'Add a card', word: 'add-card', inputs: [],
      sentence: 'You will be asked the card\'s label, kind, number, expiry, security code and name, each hidden as you type; the card is stored on the selected daemon until you change it.',
      done: '',
      touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-card',
      ownerOnly: { reason: 'card details are typed only by the person at the keyboard', instead: 'Ask the owner to choose "Add a card" in /payments.' },
      operator: { terminalOnly: 'The web UI adds a card on its own card form under Settings > Payments.' }, example: {},
      async run(_values, ctx) {
        const host = hostOf();
        if (!mayOfferCardEntryFlow(host.cardEntrySurface)) throw commandRefusal(describeCardEntryRefusal(host.cardEntrySurface));
        if (!ctx.beginConcealedInput) throw commandRefusal('Hidden entry is not available on this surface, so a card cannot be typed here.', 'Use the terminal app or the web UI.');
        // A daemon that cannot list cards cannot take one: found before any card field is asked.
        try { await host.listCards(ctx); } catch (error) { throw commandRefusal(describeCardFailure(error, 'start')); }
        ctx.print(`Entering ${CARD_ENTRY_FIELDS.length} card fields, each hidden; Esc stops at any point. The card is sent to the selected daemon after the last one.`);
        host.promptCardFields(ctx, CARD_ENTRY_FIELDS, 0);
      },
    },
    {
      id: 'remove-card', label: 'Remove a card', word: 'remove-card',
      inputs: [{ id: 'card', label: 'Card', help: 'The cards on the selected daemon', kind: 'choice', choices: { list: PAYMENT_CARDS }, required: true, typed: { position: 1 } }],
      sentence: 'Card {card} (its number, expiry, security code and name) will be deleted from the selected daemon. Cancel it with the issuer too if it should stop working everywhere.',
      done: 'Removed card {card}.',
      touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
      ownerOnly: ownerOnly('removing a card'),
      operator: { method: 'payments.cards.delete', fields: { id: 'card' } },
      example: { card: 'card-1' },
      async run(values, ctx) {
        let result;
        try { result = await hostOf().removeCard(ctx, values.card!); } catch (error) { throw commandRefusal(describeCardFailure(error, 'remove')); }
        if (!result.deleted) throw commandRefusal(`The daemon holds no card ${text(values.card)}; nothing was removed.`, '/payments cards lists them.');
        return undefined;
      },
    },
    {
      id: 'set-address', label: 'Set your billing or shipping address', word: 'address',
      stepTitles: ['Which address?', 'Blank keeps what is set.'],
      inputs: [
        { id: 'kind', label: 'Address', help: 'Which address purchases use', kind: 'choice', choices: [{ value: 'billing', label: 'Billing address', help: 'Where the card\'s statements go.' }, { value: 'shipping', label: 'Shipping address', help: 'Where parcels go.' }], required: true, typed: { position: 1 }, step: 1 },
        ...ADDRESS_INPUTS,
      ],
      sentence: 'Your {kind} address will be set to what you typed (blank fields keep their value) until you change it.',
      done: 'Set your {kind} address.',
      touches: 'this-machine', lasts: 'kept', risk: 'none',
      ownerOnly: { reason: 'an address is typed only by the person at the keyboard', instead: 'Ask the owner to choose "Set your billing or shipping address" in /payments.' },
      operator: { terminalOnly: 'The web UI sets addresses under Settings > Payments.' },
      example: { kind: 'shipping', city: 'Springfield' },
      async run(values, ctx) {
        const kind = values.kind as PaymentsAddressKind;
        const fields = Object.fromEntries(PAYMENTS_ADDRESS_FIELD_SUFFIXES.flatMap((field) => values[field] ? [[field, values[field]!.trim()]] : []));
        if (Object.keys(fields).length === 0) throw commandRefusal(`No ${kind} address field was given; nothing changed.`);
        return hostOf().setAddress(ctx, kind, fields);
      },
    },
  ],
};

const PAYMENTS_SLASH_COMMAND = defineCommand(PAYMENTS_COMMAND);

/** Register `/payments` (the one description) with this app's host. */
export function registerPaymentsCommand<Ctx extends PaymentsCommandContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: PaymentsHost<Ctx>): void {
  installedHost = host as unknown as PaymentsHost<PaymentsCommandContext>;
  registry.register(PAYMENTS_SLASH_COMMAND);
}
