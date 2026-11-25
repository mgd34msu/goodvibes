/**
 * Money: your cards, the purchases you allow ahead of time, the addresses
 * purchases use, and what the daemon spent. Everything here is kept by the
 * daemon (the card store, the standing authorisations, the approvals, its
 * settings and its cost records), so every capability runs there, through the
 * daemon method that already does the act (`payments.*`, `config.set`,
 * `cost.attribution.get`), called as the same caller: the method keeps its own
 * scopes, its confirmation (a person's request for the owner's own acts) and
 * its refusals. The handler only words the answer and refuses when the method
 * did nothing. No card number, expiry, security code or name is ever in an
 * answer, a refusal or a log.
 */
import { formatMinorUnits } from '../../payments/message.js';
import { parseCurrencyCode } from '../../payments/types.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type InputDescription, type ListName } from '../types.js';

/** The cards on the daemon (terminal-shell payments-command.ts reads them through `payments.cards`). */
export const PAYMENT_CARDS_LIST = 'payments.cards' as ListName;
/** The repeat purchases you have allowed. */
export const REPEAT_PURCHASES_LIST = 'payments.repeats' as ListName;
/** The shops you have bought from. */
export const PAYMENT_SHOPS_LIST = 'payments.shops' as ListName;

const GROUP = 'money' as const;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

/** Text from another process, with control characters taken out. */
function text(value: unknown): string {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** The daemon method as this same caller; only the daemon's `capabilities.run` gives one. */
function methodOf(caller: CapabilityCaller, what: string): (methodId: string, body: Record<string, unknown>) => Promise<unknown> {
  if (!caller.method) throw new CapabilityRefusal(`${what} was not done: it runs in the daemon, and this caller reached no daemon.`);
  return caller.method;
}

function minor(units: unknown, currency: unknown): string {
  const code = typeof currency === 'string' ? parseCurrencyCode(currency) : null;
  return typeof units === 'number' && Number.isSafeInteger(units) && units >= 0 && code ? formatMinorUnits(units as never, code) : '?';
}

// ---------------------------------------------------------------------------
// Cards and addresses
// ---------------------------------------------------------------------------

/** One card in words, from the metadata the daemon answers (never the number). */
export function describePaymentCard(card: Readonly<Record<string, unknown>>): string {
  const month = String(card.expiryMonth ?? '').padStart(2, '0');
  const cap = typeof card.issuerCapMinorUnits === 'number' ? `, the issuer caps it at ${card.issuerCapMinorUnits} minor units` : '';
  const incomplete = card.materialComplete === false ? '; a stored field is missing, so add the card again' : '';
  return `${text(card.kind)} ${text(card.brand)} ending ${text(card.last4)}, expires ${month}/${text(card.expiryYear)}${cap}${incomplete}`;
}

const ADDRESS_FIELDS = ['name', 'line1', 'line2', 'city', 'region', 'postalCode', 'country'] as const;
type AddressField = (typeof ADDRESS_FIELDS)[number];

const ADDRESS_WORDS: Readonly<Record<AddressField, { readonly label: string; readonly help: string }>> = {
  name: { label: 'Recipient name', help: 'As it goes on the parcel or the card statement' },
  line1: { label: 'Address line 1', help: 'Street and number' },
  line2: { label: 'Address line 2', help: 'Flat, floor or building; blank if none' },
  city: { label: 'City', help: 'Town or city' },
  region: { label: 'State or region', help: 'Blank where there is none' },
  postalCode: { label: 'Postal code', help: 'As the post office writes it' },
  country: { label: 'Country', help: 'Two letters, such as US or DE' },
};

/** The two addresses purchases use, as the daemon's settings hold them. */
function addressesOf(config: unknown): Readonly<Record<'billing' | 'shipping', Readonly<Record<string, string>>>> {
  const payments = record(record(config).payments);
  const one = (kind: 'billing' | 'shipping') => {
    const held = record(payments[`${kind}Address`]);
    return Object.fromEntries(ADDRESS_FIELDS.flatMap((field) => typeof held[field] === 'string' && (held[field] as string).trim() ? [[field, text(held[field]).trim()]] : []));
  };
  return { billing: one('billing'), shipping: one('shipping') };
}

function addressLine(fields: Readonly<Record<string, string>>): string {
  const parts = ADDRESS_FIELDS.flatMap((field) => fields[field] ? [fields[field]!] : []);
  return parts.length > 0 ? parts.join(', ') : 'not set';
}

export const PAYMENTS_CARDS: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.cards', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'see-cards', label: 'See your cards', word: 'cards', inputs: [],
  sentence: 'Shows the payment cards on the daemon (label, kind, last four digits and expiry, never the number) and the billing and shipping addresses purchases use.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['payments.read'], example: {},
  async run(_values, _services, caller) {
    const method = methodOf(caller, 'Reading your cards');
    const answer = record(await method('payments.cards.list', {}));
    const cards = Array.isArray(answer.cards) ? answer.cards.map(record) : [];
    const defaultCardId = typeof answer.defaultCardId === 'string' ? answer.defaultCardId : '';
    let addresses: ReturnType<typeof addressesOf> | undefined;
    try { addresses = addressesOf(await method('config.get', {})); } catch { addresses = undefined; }
    const lines = [cards.length === 0 ? 'No cards on the daemon yet.' : `${cards.length} card${cards.length === 1 ? '' : 's'} on the daemon:`];
    for (const card of cards) lines.push(`  ${text(card.label)}: ${describePaymentCard(card)}${card.id === defaultCardId ? ' (used when a purchase names no card)' : ''}`);
    lines.push(addresses
      ? `Billing address: ${addressLine(addresses.billing)}. Shipping address: ${addressLine(addresses.shipping)}.`
      : 'The addresses could not be read from the daemon\'s settings.');
    return {
      text: lines.join('\n'),
      data: {
        cards: cards.map((card) => ({ ...card, name: text(card.label), detail: describePaymentCard(card), state: card.id === defaultCardId ? 'default' : card.materialComplete === false ? 'incomplete' : 'card' })),
        defaultCardId,
        ...(addresses ? { addresses } : { addressesUnreadable: true }),
      },
    };
  },
};

const CARD: InputDescription = {
  id: 'card', label: 'Card', help: 'The cards on the daemon', kind: 'choice', choices: { list: PAYMENT_CARDS_LIST }, required: true, typed: { position: 1 },
};

export const PAYMENTS_REMOVE_CARD: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.remove-card', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'remove-card', label: 'Remove a card', word: 'remove-card', inputs: [CARD],
  sentence: 'Card {card} (its number, expiry, security code and name) will be deleted from the daemon. Cancel it with the issuer too if it should stop working everywhere.',
  done: 'Removed card {card}.',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
  ownerOnly: { reason: 'removing a card is the owner\'s own act', instead: 'Ask the owner to remove it in the Money place.' },
  effects: ['payments.administer', 'record.destroy'],
  example: { card: 'card-1' },
  async run(values, _services, caller) {
    const id = (values.card ?? '').trim();
    // A card the daemon does not hold is refused by the method itself (404, "Card not found"), nothing removed.
    const answer = record(await methodOf(caller, 'Removing the card')('payments.cards.delete', { id }));
    if (answer.deleted !== true) {
      // No card listed under the id any more, but what a failed add left behind under it was cleared.
      return { text: 'It was no longer listed; what it left behind on the daemon was cleared.', data: { id, deleted: false, secretsCleared: answer.secretsCleared } };
    }
    return { text: '', data: { id, deleted: true } };
  },
};

/** The card-number checksum (ISO/IEC 7812): every issued card number passes it. */
function passesCardChecksum(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** The card's fields, each typed by the owner; the number, expiry, security code and name are secret (hidden as typed, kept out of every answer). */
export const PAYMENTS_ADD_CARD: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.add-card', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'add-card', label: 'Add a card', word: 'add-card',
  inputs: [
    { id: 'label', label: 'Card label', help: 'Your own name for it, such as groceries virtual card', kind: 'text', freeTextReason: 'your own name for the card', required: true, typed: { flag: '--label', untilNextFlag: true } },
    { id: 'kind', label: 'Card kind', help: 'A virtual card with its own spending cap is the safer choice', kind: 'choice',
      choices: [{ value: 'virtual', label: 'Virtual card' }, { value: 'real', label: 'Real card' }], required: { default: 'virtual', defaultMeans: 'a virtual card' }, typed: { flag: '--kind' } },
    { id: 'number', label: 'Card number', help: 'The long number on the card; hidden as you type', kind: 'secret', required: true, typed: { flag: '--number' } },
    { id: 'expiry', label: 'Expiry', help: 'As printed, MM/YY, such as 09/29; hidden as you type', kind: 'secret', required: true, typed: { flag: '--expiry' } },
    { id: 'cvv', label: 'Security code', help: 'The three or four digits on the card; hidden as you type', kind: 'secret', required: true, typed: { flag: '--cvv' } },
    { id: 'cardholderName', label: 'Cardholder name', help: 'As printed on the card; hidden as you type', kind: 'secret', required: true, typed: { flag: '--name' } },
  ],
  sentence: 'Card {label} will be stored on the daemon (its number, expiry, security code and name encrypted, never shown again) until you remove it.',
  done: 'Stored card {label}.',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-card',
  ownerOnly: { reason: 'card details are typed only by the owner', instead: 'Ask the owner to add the card in the Money place.' },
  effects: ['card.enter'],
  example: { label: 'groceries virtual card', kind: 'virtual' },
  async run(values, _services, caller) {
    // Each problem names the field, never what was typed: a rejected card number is still a card number.
    if (!(values.label ?? '').trim()) throw new CapabilityRefusal('A label is required so you can tell cards apart. Nothing was stored.');
    const number = (values.number ?? '').replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(number)) throw new CapabilityRefusal('A card number is 13 to 19 digits. Nothing was stored.');
    if (!passesCardChecksum(number)) throw new CapabilityRefusal('That card number fails the check every card number passes, so a digit is wrong or two are swapped. Nothing was stored.');
    const expiry = /^\s*(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})\s*$/.exec(values.expiry ?? '');
    const month = expiry ? Number(expiry[1]) : 0;
    if (!expiry || month < 1 || month > 12) throw new CapabilityRefusal('Expiry must look like MM/YY, for example 09/29. Nothing was stored.');
    const year = expiry[2]!.length === 2 ? 2000 + Number(expiry[2]) : Number(expiry[2]);
    const now = new Date();
    // A card works through the last day of its expiry month.
    if (year < now.getFullYear() || (year === now.getFullYear() && month < now.getMonth() + 1)) {
      throw new CapabilityRefusal('That expiry date has already passed. Enter the date on the current card. Nothing was stored.');
    }
    if (!/^\d{3,4}$/.test((values.cvv ?? '').trim())) throw new CapabilityRefusal('The security code is 3 or 4 digits. Nothing was stored.');
    if (!(values.cardholderName ?? '').trim()) throw new CapabilityRefusal('Enter the name as printed on the card. Nothing was stored.');
    const answer = record(await methodOf(caller, 'Storing the card')('payments.cards.create', {
      label: (values.label ?? '').trim(), kind: values.kind === 'real' ? 'real' : 'virtual',
      number, expiryMonth: month, expiryYear: year,
      cvv: (values.cvv ?? '').trim(), cardholderName: (values.cardholderName ?? '').trim(), issuerCapMinorUnits: null,
    }));
    const card = record(answer.card);
    return { text: `${text(card.label)}: ${describePaymentCard(card)}.`, data: { card: { id: card.id, label: card.label, brand: card.brand, last4: card.last4, kind: card.kind, materialComplete: card.materialComplete } } };
  },
};

const ADDRESS_INPUTS: readonly InputDescription[] = ADDRESS_FIELDS.map((field): InputDescription => ({
  id: field, label: ADDRESS_WORDS[field].label, help: `${ADDRESS_WORDS[field].help}; blank keeps what is set`, kind: 'text',
  freeTextReason: 'part of your address', required: { default: '', defaultMeans: 'keep what is set' },
  typed: { flag: `--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}` as `--${string}` }, step: 2,
}));

export const PAYMENTS_ADDRESS: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.address', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'set-address', label: 'Set your billing or shipping address', word: 'address',
  inputs: [
    { id: 'kind', label: 'Address', help: 'Which address purchases use', kind: 'choice',
      choices: [{ value: 'billing', label: 'Billing address', help: 'Where the card\'s statements go.' }, { value: 'shipping', label: 'Shipping address', help: 'Where parcels go.' }],
      required: true, typed: { position: 1 }, step: 1 },
    ...ADDRESS_INPUTS,
  ],
  sentence: 'Your {kind} address will be set on the daemon to what you typed (blank fields keep their value) until you change it.',
  done: 'Set your {kind} address.',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  ownerOnly: { reason: 'an address is typed only by the owner', instead: 'Ask the owner to set it in the Money place.' },
  example: { kind: 'shipping', city: 'Springfield' },
  async run(values, _services, caller) {
    const kind = values.kind === 'billing' ? 'billing' : 'shipping';
    const given = ADDRESS_FIELDS.flatMap((field) => values[field]?.trim() ? [[field, values[field]!.trim()] as const] : []);
    if (given.length === 0) throw new CapabilityRefusal(`No ${kind} address field was given; nothing changed.`);
    const method = methodOf(caller, `Setting your ${kind} address`);
    const saved: string[] = [];
    try {
      for (const [field, value] of given) {
        await method('config.set', { key: `payments.${kind}Address.${field}`, value });
        saved.push(ADDRESS_WORDS[field].label);
      }
    } catch (error) {
      if (saved.length > 0) noteListChanged({ list: 'payments', change: 'changed', id: `${kind}-address` });
      const said = error instanceof Error ? error.message : String(error);
      throw new CapabilityRefusal(`${saved.length > 0 ? `${saved.join(', ')} ${saved.length === 1 ? 'was' : 'were'} saved; the rest was not` : 'Nothing was saved'}: ${text(said)}`);
    }
    noteListChanged({ list: 'payments', change: 'changed', id: `${kind}-address` });
    return { text: 'Kept in the daemon\'s settings, which every purchase reads.', data: { kind, fields: given.map(([field]) => field) } };
  },
};

// ---------------------------------------------------------------------------
// Purchases allowed ahead of time
// ---------------------------------------------------------------------------

const SHOP: InputDescription = {
  id: 'shop', label: 'Shop', help: 'Shops you have bought from, or type one', kind: 'choice',
  choices: { list: PAYMENT_SHOPS_LIST, allowOther: { reason: 'a shop you have not bought from yet (its web address, such as shop.example)' } },
  required: true, typed: { position: 1 },
};
const ITEM: InputDescription = {
  id: 'item', label: 'What may be bought', help: 'In your own words; a purchase must name exactly this', kind: 'text',
  freeTextReason: 'your own words for the item', required: true, typed: { tail: true },
};

export const PAYMENTS_APPROVE: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.approve', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'approve-ahead', label: 'Approve one purchase ahead of time', word: 'approve',
  inputs: [SHOP, { id: 'most', label: 'At most', help: 'The most it may cost, in your payment currency, such as 25.00', kind: 'money', required: true, typed: { flag: '--most' } }, ITEM],
  sentence: 'Approved before it happens: one purchase of "{item}" from {shop}, of at most {most}, begun in the next five minutes, will need no further answer; it is used once and lasts for this session only.',
  done: 'Approved ahead of time: "{item}" from {shop}, at most {most}.',
  touches: 'another-machine', lasts: 'session', risk: 'spends-money',
  // What ran is an approval, not a purchase: nothing was spent.
  riskDone: 'Nothing has been bought yet: one matching purchase may now go ahead without asking you again.',
  ownerOnly: { reason: 'approving a purchase is the owner\'s own act', instead: 'Ask the owner to approve it in the Money place.' },
  effects: ['purchase.approve'],
  example: { shop: 'shop.example', most: '25.00', item: 'USB-C cable' },
  async run(values, _services, caller) {
    const answer = record(await methodOf(caller, 'The approval')('payments.checkout.approve', {
      merchantDomain: (values.shop ?? '').trim(), item: (values.item ?? '').trim(), amount: (values.most ?? '').trim(), confirm: true,
    }));
    if (answer.approved !== true) throw new CapabilityRefusal('The daemon did not confirm the approval; nothing was approved.', 'Waiting for you shows the purchases that wait.');
    const ends = typeof answer.expiresAt === 'string' ? new Date(answer.expiresAt) : null;
    return {
      text: `It ends ${ends && !Number.isNaN(ends.getTime()) ? ends.toLocaleString() : 'in five minutes'}; the amount is in ${text(answer.currency)}.`,
      data: { merchantDomain: answer.merchantDomain, item: answer.item, amount: answer.amount, currency: answer.currency, expiresAt: answer.expiresAt },
    };
  },
};

/** A repeat purchase's line, from the numbers the daemon holds. */
function repeatSummary(row: Readonly<Record<string, unknown>>): string {
  const shops = Array.isArray(row.merchants) ? row.merchants.map(text).join(', ') : '';
  const until = typeof row.expiresAt === 'string' && row.expiresAt ? `, last day ${text(row.expiresAt).slice(0, 10)}` : '';
  return `"${text(row.item)}" from ${shops}: at most ${minor(row.maxPerPurchaseMinorUnits, row.currency)} each, ${minor(row.maxPerPeriodMinorUnits, row.currency)} every ${text(row.periodDays)} days${until}; ${minor(row.leftMinorUnits, row.currency)} left this period`;
}

export const PAYMENTS_REPEAT: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.repeat', group: GROUP, home: 'daemon', repeat: 'unsafe' },
  actionId: 'allow-repeat', label: 'Allow a repeat purchase', word: 'repeat',
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
  done: 'Allowed: "{item}" from {shop}.',
  touches: 'another-machine', lasts: 'kept', risk: 'spends-money', undoneBy: 'stop-repeat',
  // What ran is an allowance, not a purchase: nothing was spent.
  riskDone: 'Nothing has been bought yet: a schedule may now buy it within these limits.',
  ownerOnly: { reason: 'allowing a repeat purchase is the owner\'s own act', instead: 'Ask the owner to allow it in the Money place.' },
  effects: ['purchase.approve'],
  example: { shop: 'shop.example', item: 'dog food', each: '60.00', 'per-period': '120.00', until: '2027-06-30' },
  async run(values, _services, caller) {
    const merchants = (values.shop ?? '').split('\n').flatMap((shop) => shop.split(',')).map((shop) => shop.trim()).filter(Boolean);
    const days = Number(values.days || '30');
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new CapabilityRefusal(`The period is a whole number of days from 1 to 366; "${text(values.days)}" is not. Nothing was allowed.`);
    const until = (values.until ?? '').trim();
    if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) throw new CapabilityRefusal(`The last day is a date such as 2027-06-30; "${text(until)}" is not. Nothing was allowed.`);
    const answer = record(await methodOf(caller, 'The repeat purchase')('payments.standing.create', {
      merchants, item: (values.item ?? '').trim(), maxPerPurchase: (values.each ?? '').trim(), maxPerPeriod: (values['per-period'] ?? '').trim(), periodDays: days,
      ...(until ? { expires: until } : {}), confirm: true,
    }));
    const row = record(answer.authorization);
    return { text: `${repeatSummary(row)}. A schedule names it as ${text(row.id)}.`, data: { authorization: row } };
  },
};

export const PAYMENTS_REPEATS: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.repeats', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'see-repeats', label: 'See repeat purchases you have allowed', word: 'repeats', inputs: [],
  sentence: 'Shows each repeat purchase you have allowed: what, from which shops, the limits, and what is left this period.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['payments.read'], example: {},
  async run(_values, _services, caller) {
    const answer = record(await methodOf(caller, 'Reading your repeat purchases')('payments.standing.list', {}));
    const rows = Array.isArray(answer.authorizations) ? answer.authorizations.map(record) : [];
    return {
      text: rows.length === 0
        ? 'No repeat purchases: a schedule asks you before every purchase.'
        : ['Repeat purchases you have allowed:', ...rows.map((row) => `  ${text(row.item)}${row.live === false ? ' (ended)' : ''}: ${repeatSummary(row)}`)].join('\n'),
      data: { authorizations: rows.map((row) => ({ ...row, name: text(row.item), detail: repeatSummary(row), state: row.live === false ? 'ended' : 'allowed' })) },
    };
  },
};

export const PAYMENTS_STOP_REPEAT: CapabilityDefinition<unknown> = {
  capability: { id: 'payments.stop-repeat', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'stop-repeat', label: 'Stop a repeat purchase', word: 'stop-repeat',
  inputs: [{ id: 'repeat', label: 'Repeat purchase', help: 'The repeat purchases you have allowed', kind: 'choice', choices: { list: REPEAT_PURCHASES_LIST }, required: true, typed: { position: 1 } }],
  sentence: 'No new purchase will start under {repeat} {lasts}; one already running keeps its window, where you can still stop it.',
  done: 'Stopped {repeat}.',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'allow-repeat',
  // The method's own effect: withdrawing what may be bought is the owner's, as allowing it is.
  effects: ['purchase.approve'],
  example: { repeat: 'standing-1' },
  async run(values, _services, caller) {
    const id = (values.repeat ?? '').trim();
    const answer = record(await methodOf(caller, 'Stopping the repeat purchase')('payments.standing.delete', { id, confirm: true }));
    if (answer.deleted !== true) throw new CapabilityRefusal(`The daemon has no repeat purchase ${text(id)}; nothing was stopped.`, 'The Money place lists the repeat purchases you have allowed.', 'NOT_FOUND');
    return { text: '', data: { id, deleted: true } };
  },
};

// ---------------------------------------------------------------------------
// What was spent
// ---------------------------------------------------------------------------

/** The splits the daemon's cost records carry; the last three are listed only when they hold something. */
const SPLITS = ['agent', 'model', 'provider', 'session', 'tool', 'hook', 'mcp'] as const;
const OPTIONAL_SPLITS = new Set<string>(['session', 'tool', 'hook', 'mcp']);
const SPLIT_WORDS: Readonly<Record<string, string>> = {
  agent: 'agent', model: 'model', provider: 'provider', session: 'session', tool: 'tool', hook: 'hook', mcp: 'tool server',
};

function dollars(costUsd: unknown, state: unknown): string {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || state === 'unpriced') return 'unpriced';
  const shown = costUsd < 0.01 && costUsd > 0 ? costUsd.toFixed(4) : costUsd.toFixed(2);
  return `${state === 'estimated' ? '~' : ''}$${shown}`;
}

function tokensOf(tokens: unknown): string {
  const held = record(tokens);
  const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `${count(held.inputTokens)} in, ${count(held.outputTokens)} out, ${count(held.cacheReadTokens)} read from cache, ${count(held.cacheWriteTokens)} written to cache`;
}

export const USAGE_BY_SOURCE: CapabilityDefinition<unknown> = {
  capability: { id: 'usage.by-source', group: GROUP, home: 'daemon', repeat: 'safe' },
  actionId: 'attribution', label: 'See cost by who spent it', word: 'by-source',
  inputs: [
    { id: 'window', label: 'Over', help: 'How far back', kind: 'choice', choices: [{ value: '24h', label: 'The last 24 hours' }, { value: '7d', label: 'The last 7 days' }], required: { default: '24h', defaultMeans: 'the last 24 hours' }, typed: { position: 1 } },
    { id: 'as', label: 'As', help: 'Text, or JSON for programs', kind: 'choice', choices: [{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }], required: { default: 'text', defaultMeans: 'text' }, typed: { flag: '--as' } },
    { id: 'by', label: 'Split by', help: 'One way to split it, or every way', kind: 'choice',
      choices: [{ value: 'all', label: 'Every way' }, ...SPLITS.map((split) => ({ value: split, label: SPLIT_WORDS[split]!.replace(/^./, (first) => first.toUpperCase()) }))],
      required: { default: 'all', defaultMeans: 'every way' }, typed: { flag: '--by' } },
  ],
  sentence: 'Shows what the daemon spent on models, split by agent, model, provider and the other ways it records cost.',
  done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none', effects: ['telemetry.read'], example: { window: '7d' },
  async run(values, _services, caller) {
    const window = values.window === '7d' ? '7d' : '24h';
    const method = methodOf(caller, 'Reading what was spent');
    const splits = values.by && values.by !== 'all' && (SPLITS as readonly string[]).includes(values.by) ? [values.by] : [...SPLITS];
    const results: Readonly<Record<string, unknown>>[] = [];
    for (const dimension of splits) results.push(record(await method('cost.attribution.get', { window, dimension })));
    const rows = results.flatMap((result) => (Array.isArray(result.rows) ? result.rows.map(record) : []).map((row) => ({
      id: `${text(result.dimension)}:${text(row.key)}`, split: text(result.dimension), key: text(row.key),
      cost: dollars(row.costUsd, row.costState), costUsd: typeof row.costUsd === 'number' ? row.costUsd : null, tokens: tokensOf(row.tokens), state: text(row.costState) || 'priced',
    })));
    const data = { window, splits: results, rows };
    if (values.as === 'json') return { text: JSON.stringify(results, null, 2), data };
    const lines = [`What the daemon spent in the last ${window === '7d' ? '7 days' : '24 hours'}`];
    for (const result of results) {
      const dimension = text(result.dimension);
      const listed = Array.isArray(result.rows) ? result.rows.map(record) : [];
      if (OPTIONAL_SPLITS.has(dimension) && listed.length === 0 && splits.length > 1) continue;
      lines.push('', `By ${SPLIT_WORDS[dimension] ?? dimension}:`);
      if (listed.length === 0) lines.push('  nothing recorded in this time');
      for (const row of listed) lines.push(`  ${text(row.key)}: ${dollars(row.costUsd, row.costState)} (${tokensOf(row.tokens)})`);
      if (listed.length > 0) lines.push(`  In all: ${dollars(result.totalCostUsd, result.costState)}; ${text(result.pricedRecordCount)} priced, ${text(result.unpricedRecordCount)} unpriced`);
    }
    return { text: lines.join('\n'), data };
  },
};

/** Every Money capability, in the order the place and find list them. */
export const MONEY_CAPABILITIES: readonly CapabilityDefinition<unknown>[] = [
  PAYMENTS_CARDS, PAYMENTS_ADD_CARD, PAYMENTS_REMOVE_CARD, PAYMENTS_ADDRESS,
  PAYMENTS_APPROVE, PAYMENTS_REPEAT, PAYMENTS_REPEATS, PAYMENTS_STOP_REPEAT, USAGE_BY_SOURCE,
];
