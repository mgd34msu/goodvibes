/**
 * money-place.ts, the Money place: your cards, the billing and shipping
 * addresses purchases use, the repeat purchases you have allowed, and what
 * the daemon spent on models.
 *
 * Every list is read from the daemon (the card store, its settings, the
 * standing authorisations, its cost records) and follows the `payments` and
 * `spending` list changes, so a card added from the web UI, a repeat purchase
 * stopped by a script or a model call's cost shows here with no key pressed.
 * Every action is a Money capability (platform capabilities/builtin/money.ts),
 * shown only on the list it acts on; approving one purchase ahead of time is
 * on the place itself.
 */
// The browser-safe entry: the web UI draws this declaration too (places/browser.ts).
import { formatMinorUnits, parseCurrencyCode } from '@goodvibes/engine/platform/platform/payments/browser';
import { definePlace, type PlaceDetailLine, type PlaceItem } from './place-types.js';

interface CardItem extends PlaceItem {
  readonly state: 'default' | 'card' | 'incomplete';
  readonly kind: 'card';
  readonly label: string;
  readonly cardKind: string;
  readonly brand: string;
  readonly last4: string;
  readonly expires: string;
  readonly cap?: string | undefined;
  readonly addedAt?: string | undefined;
}

interface AddressItem extends PlaceItem {
  readonly state: 'set' | 'not-set';
  readonly kind: 'address';
  readonly which: 'billing' | 'shipping';
  readonly title: string;
  readonly fields: Readonly<Record<string, string>>;
}

interface RepeatItem extends PlaceItem {
  readonly state: 'allowed' | 'ended';
  readonly kind: 'repeat';
  readonly item: string;
  readonly shops: string;
  readonly each: string;
  readonly perPeriod: string;
  readonly periodDays: string;
  readonly spent: string;
  readonly left: string;
  readonly lastDay?: string | undefined;
  readonly createdAt?: string | undefined;
}

interface SpendItem extends PlaceItem {
  readonly state: 'priced' | 'estimated' | 'unpriced';
  readonly kind: 'spend';
  readonly model: string;
  readonly cost: string;
  readonly tokens: string;
}

type Item = CardItem | AddressItem | RepeatItem | SpendItem;

/** Text from another process, with control characters taken out. */
function plain(value: unknown): string {
  return String(value ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').trim();
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function money(units: unknown, currency: unknown): string {
  const code = typeof currency === 'string' ? parseCurrencyCode(currency) : null;
  return typeof units === 'number' && Number.isSafeInteger(units) && units >= 0 && code ? formatMinorUnits(units as never, code) : 'not said';
}

function day(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------- cards

function cards(output: unknown): readonly CardItem[] {
  const answer = record(output);
  const defaultCardId = typeof answer.defaultCardId === 'string' ? answer.defaultCardId : '';
  return rows(answer.cards).filter((card) => plain(card.id)).map((card): CardItem => ({
    id: plain(card.id),
    kind: 'card',
    state: card.materialComplete === false ? 'incomplete' : card.id === defaultCardId ? 'default' : 'card',
    label: plain(card.label) || 'a card with no label',
    cardKind: card.kind === 'real' ? 'real card' : 'virtual card',
    brand: plain(card.brand) || 'card',
    last4: plain(card.last4),
    expires: `${String(card.expiryMonth ?? '').padStart(2, '0')}/${plain(card.expiryYear)}`,
    ...(typeof card.issuerCapMinorUnits === 'number' ? { cap: `${card.issuerCapMinorUnits} minor units, as you declared it` } : {}),
    ...(day(card.addedAt) ? { addedAt: day(card.addedAt) } : {}),
  }));
}

// ---------------------------------------------------------------------------- addresses

const ADDRESS_FIELDS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'name', label: 'Recipient name' }, { id: 'line1', label: 'Address line 1' }, { id: 'line2', label: 'Address line 2' },
  { id: 'city', label: 'City' }, { id: 'region', label: 'State or region' }, { id: 'postalCode', label: 'Postal code' }, { id: 'country', label: 'Country' },
];

function addresses(output: unknown): readonly AddressItem[] {
  const payments = record(record(output).payments);
  return (['billing', 'shipping'] as const).map((kind): AddressItem => {
    const held = record(payments[`${kind}Address`]);
    const fields = Object.fromEntries(ADDRESS_FIELDS.flatMap((field) => plain(held[field.id]) ? [[field.id, plain(held[field.id])]] : []));
    // The id is not the word the capability takes (`fill` gives that), so an outcome line naming "shipping" is left as it is.
    return { id: `${kind}-address`, kind: 'address', which: kind, state: Object.keys(fields).length > 0 ? 'set' : 'not-set', title: kind === 'billing' ? 'Billing address' : 'Shipping address', fields };
  });
}

// ---------------------------------------------------------------------------- repeat purchases

function repeats(output: unknown): readonly RepeatItem[] {
  return rows(record(output).authorizations).filter((row) => plain(row.id)).map((row): RepeatItem => ({
    id: plain(row.id),
    kind: 'repeat',
    state: row.live === false ? 'ended' : 'allowed',
    item: plain(row.item) || 'not said',
    shops: Array.isArray(row.merchants) ? row.merchants.map(plain).filter(Boolean).join(', ') : '',
    each: money(row.maxPerPurchaseMinorUnits, row.currency),
    perPeriod: money(row.maxPerPeriodMinorUnits, row.currency),
    periodDays: plain(row.periodDays),
    spent: money(row.spentMinorUnits, row.currency),
    left: money(row.leftMinorUnits, row.currency),
    ...(day(row.expiresAt) ? { lastDay: day(row.expiresAt) } : {}),
    ...(day(row.createdAt) ? { createdAt: day(row.createdAt) } : {}),
  }));
}

// ---------------------------------------------------------------------------- spending

function dollars(costUsd: unknown, state: unknown): string {
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || state === 'unpriced') return 'not priced';
  const shown = costUsd > 0 && costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2);
  return `${state === 'estimated' ? 'about ' : ''}$${shown}`;
}

function spending(output: unknown): readonly SpendItem[] {
  return rows(record(output).rows).filter((row) => plain(row.key)).map((row): SpendItem => {
    const tokens = record(row.tokens);
    const count = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
    const state = row.costState === 'unpriced' || row.costState === 'estimated' ? row.costState : 'priced';
    return {
      id: `model:${plain(row.key)}`, kind: 'spend', state, model: plain(row.key), cost: dollars(row.costUsd, row.costState),
      tokens: `${count(tokens.inputTokens)} in, ${count(tokens.outputTokens)} out, ${count(tokens.cacheReadTokens)} read from cache, ${count(tokens.cacheWriteTokens)} written to cache`,
    };
  });
}

/** A card, a repeat purchase or an address changed anywhere; the daemon recorded a model call's cost. */
const MONEY_CHANGES = { domains: ['workspace'], events: [], lists: ['payments', 'spending'] } as const;

export const MONEY_PLACE = definePlace<Item>({
  id: 'money',
  group: 'money',
  title: 'Money',
  lists: [
    {
      id: 'cards',
      label: 'Cards',
      noun: 'your cards',
      source: { kind: 'daemon', method: 'payments.cards.list', input: {}, items: cards },
      follows: MONEY_CHANGES,
      empty: 'No cards yet: a purchase has nothing to pay with.',
      row: (item) => {
        const card = item as CardItem;
        return {
          title: `${card.label} · ${card.brand} ending ${card.last4}`,
          ...(card.state === 'incomplete' ? { right: 'needs adding again' } : card.state === 'default' ? { right: 'used by default' } : {}),
          mark: card.state === 'incomplete' ? 'attention' : 'ok',
        };
      },
      detail: (item) => {
        const card = item as CardItem;
        return [
          { label: 'Kind', text: card.cardKind },
          { label: 'Ends in', text: card.last4 },
          { label: 'Expires', text: card.expires },
          ...(card.cap ? [{ label: 'Issuer cap', text: card.cap }] : []),
          ...(card.addedAt ? [{ label: 'Added', text: card.addedAt }] : []),
          ...(card.state === 'default' ? [{ label: 'Used when', text: 'a purchase names no card' }] : []),
          ...(card.state === 'incomplete' ? [{ label: 'Needs a look', text: 'a stored field of this card is missing, so a purchase cannot use it; remove it and add it again', tone: 'warning' as const }] : []),
          { text: '' },
          { text: 'The number, security code and name are kept encrypted by the daemon and never shown.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'addresses',
      label: 'Addresses',
      noun: 'the addresses purchases use',
      source: { kind: 'daemon', method: 'config.get', input: {}, items: addresses },
      follows: MONEY_CHANGES,
      empty: 'No addresses.',
      row: (item) => {
        const address = item as AddressItem;
        return { title: address.title, ...(address.state === 'not-set' ? { right: 'not set' } : {}), mark: address.state === 'set' ? 'ok' : 'paused' };
      },
      detail: (item) => {
        const address = item as AddressItem;
        const lines: PlaceDetailLine[] = ADDRESS_FIELDS.map((field) => ({ label: field.label, text: address.fields[field.id] ?? 'not set', ...(address.fields[field.id] ? {} : { tone: 'muted' as const }) }));
        return [...lines, { text: '' }, { text: address.which === 'billing' ? 'Where the card\'s statements go.' : 'Where parcels go.', tone: 'muted' }];
      },
    },
    {
      id: 'repeats',
      label: 'Repeat purchases',
      noun: 'the repeat purchases you have allowed',
      source: { kind: 'daemon', method: 'payments.standing.list', input: {}, items: repeats },
      follows: MONEY_CHANGES,
      empty: 'No repeat purchases: a schedule asks you before every purchase.',
      row: (item) => {
        const repeat = item as RepeatItem;
        return { title: `${repeat.item} · ${repeat.shops}`, right: repeat.state === 'ended' ? 'ended' : `${repeat.left} left`, mark: repeat.state === 'ended' ? 'paused' : 'ok' };
      },
      detail: (item) => {
        const repeat = item as RepeatItem;
        return [
          { label: 'What', text: repeat.item },
          { label: 'From', text: repeat.shops || 'not said' },
          { label: 'Most each time', text: repeat.each },
          { label: `Most in ${repeat.periodDays} days`, text: repeat.perPeriod },
          { label: 'Spent this period', text: repeat.spent },
          { label: 'Left this period', text: repeat.left },
          { label: 'Last day', text: repeat.lastDay ?? 'none, until you stop it' },
          ...(repeat.createdAt ? [{ label: 'Allowed on', text: repeat.createdAt }] : []),
          { text: '' },
          { text: 'Every other spending limit still applies to each purchase.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'spending',
      label: 'Spending',
      noun: 'what the daemon spent on models',
      source: { kind: 'daemon', method: 'cost.attribution.get', input: { window: '7d', dimension: 'model' }, items: spending },
      follows: MONEY_CHANGES,
      empty: 'Nothing spent on models in the last 7 days.',
      row: (item) => {
        const spend = item as SpendItem;
        return { title: spend.model, right: spend.cost, mark: spend.state === 'unpriced' ? 'attention' : 'ok' };
      },
      detail: (item) => {
        const spend = item as SpendItem;
        return [
          { label: 'Model', text: spend.model },
          { label: 'In the last 7 days', text: spend.cost },
          { label: 'Tokens', text: spend.tokens },
          ...(spend.state === 'unpriced' ? [{ label: 'Why no amount', text: 'the price list does not know this model, so its cost is not guessed', tone: 'muted' as const }] : []),
          ...(spend.state === 'estimated' ? [{ label: 'About', text: 'some of its calls could not be priced, so the amount is less than the whole', tone: 'muted' as const }] : []),
        ];
      },
    },
  ],
  actions: [
    { key: 'n', list: 'cards', whole: true, capability: 'payments.add-card', label: 'add a card' },
    { key: 'x', list: 'cards', capability: 'payments.remove-card', label: 'remove', fill: { card: 'id' } },
    { key: 'enter', list: 'addresses', capability: 'payments.address', label: 'change', fill: { kind: (item) => (item as AddressItem).which }, form: true },
    { key: 'n', list: 'repeats', whole: true, capability: 'payments.repeat', label: 'allow a repeat purchase' },
    { key: 'x', list: 'repeats', capability: 'payments.stop-repeat', label: 'stop', fill: { repeat: 'id' } },
    // What may be bought without asking: once, ahead of time, beside what a schedule may buy again.
    { key: 'a', list: 'repeats', whole: true, capability: 'payments.approve', label: 'approve one purchase ahead' },
    { key: 'b', list: 'spending', whole: true, capability: 'usage.by-source', label: 'every split' },
    { key: 'u', list: 'spending', whole: true, capability: 'usage.open', label: 'this session' },
    { key: 'w', list: 'spending', whole: true, capability: 'usage.alert', label: 'spending alert' },
  ],
  count: (lists) => {
    const incomplete = (lists.cards ?? []).filter((item) => item.state === 'incomplete').length;
    return incomplete > 0 ? { count: incomplete, words: `${incomplete} card${incomplete === 1 ? '' : 's'} to add again`, tone: 'wrong' } : undefined;
  },
});
