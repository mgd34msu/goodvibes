/**
 * money-place.ts, the Money place: your cards, the billing and shipping
 * addresses purchases use, the repeat purchases you have allowed, and what
 * the daemon spent on models.
 *
 * Spending starts with this conversation (its context, tokens, cost against the
 * spending alert, its turns and its agents), supplied by the program holding
 * it (conversation-spending.ts), above what the daemon recorded, by what it was
 * for (a schedule, a piece of work, a web chat, a shared session), with where
 * the daemon's own runs stand against the alert. A model with no price gets
 * your own price there, as does the model this conversation uses.
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
  /** `none`: the daemon recorded no model call in the window (one row says so). */
  readonly state: 'priced' | 'estimated' | 'unpriced' | 'none';
  readonly kind: 'spend';
  /** What it was for: `schedule "Morning brief"`, `work "Add retries"`, `chat "Plans"`, `conversation`. */
  readonly source: string;
  readonly cost: string;
  readonly tokens: string;
  /** The models that spent it (`provider:model`), each with whether it has a price. */
  readonly models: readonly { readonly key: string; readonly priced: boolean }[];
  /** The first of them with no price: the one its "give it a price" control prices. */
  readonly unpricedModel?: string | undefined;
}

/** The spending alert against what the daemon's own runs cost in the last 24 hours (the daemon warns when they pass it). */
interface AlertItem extends PlaceItem {
  readonly state: 'alert-passed' | 'alert-under';
  readonly kind: 'alert';
  readonly usd: string;
  readonly runs: string;
}

/** This conversation's rows above the daemon's (conversation-spending.ts), supplied by the program holding it. */
interface HereItem extends PlaceItem {
  readonly state: 'conversation' | 'turns' | 'agent';
  readonly kind: 'here';
  readonly title: string;
  readonly right: string;
  readonly attention: boolean;
  readonly lines: readonly PlaceDetailLine[];
  /** The conversation's row: the model in use as `provider:model`. */
  readonly modelKey?: string | undefined;
}

type Item = CardItem | AddressItem | RepeatItem | SpendItem | AlertItem | HereItem;

/** The program source the Spending tab lists above the daemon's records (wirePlaces supplies it). */
export const SPENDING_HERE_SOURCE = 'spending-here';

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
  // Under a dollar, up to four places: $0.0243 is not shown as $0.02 beside an alert of $0.02.
  const shown = costUsd > 0 && costUsd < 1 ? costUsd.toFixed(4).replace(/0{1,2}$/, '') : costUsd.toFixed(2);
  return `${state === 'estimated' ? 'about ' : ''}$${shown}`;
}

/** `usage.by-source` split by what it was for, over 7 days (capabilities.run answers `{ data: { rows, alert } }`). */
function spending(output: unknown): readonly (SpendItem | AlertItem)[] {
  const data = record(record(output).data);
  const items: (SpendItem | AlertItem)[] = [];
  // Where the daemon's own runs stand against the spending alert, first when an alert is set.
  const alert = record(data.alert);
  if (typeof alert.usd === 'number' && alert.usd > 0) {
    items.push({
      id: 'alert:runs', kind: 'alert', state: alert.passed === true ? 'alert-passed' : 'alert-under',
      usd: dollars(alert.usd, 'priced'), runs: dollars(typeof alert.runsUsd === 'number' ? alert.runsUsd : 0, 'priced'),
    });
  }
  const recorded = rows(data.rows).filter((row) => plain(row.split) === 'source' && plain(row.key));
  // The daemon recorded no model cost: one row says so, below this conversation's own (which the program lists).
  if (recorded.length === 0) {
    items.push({ id: 'source:none', kind: 'spend', state: 'none', source: 'Daemon, last 7 days', cost: 'nothing recorded', tokens: 'none', models: [] });
    return items;
  }
  for (const row of recorded) {
    const state = row.state === 'unpriced' || row.state === 'estimated' ? row.state : 'priced';
    const models = rows(row.models).filter((model) => plain(model.key)).map((model) => ({ key: plain(model.key), priced: model.priced === true }));
    const unpriced = models.find((model) => !model.priced);
    items.push({
      id: `source:${plain(row.key)}`, kind: 'spend', state, source: plain(row.key) === '(unattributed)' ? 'not named' : plain(row.key),
      cost: dollars(row.costUsd, row.state), tokens: plain(row.tokens), models,
      ...(unpriced ? { unpricedModel: unpriced.key } : {}),
    });
  }
  return items;
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
      // What the daemon recorded over 7 days, by what it was for (a schedule, a piece of work, a web chat, a shared
      // session, a conversation it holds), with where its own runs stand against the spending alert.
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'usage.by-source', inputs: { window: '7d', by: 'source' } }, items: spending },
      // This conversation first (its tokens, context, cost, turns and agents, as the program holding it keeps them): a
      // session source, so the web view, which holds no conversation of a terminal program, lists the daemon's rows alone.
      before: { kind: 'session', name: SPENDING_HERE_SOURCE, items: (raw) => (Array.isArray(raw) ? raw as HereItem[] : []) },
      follows: MONEY_CHANGES,
      empty: 'Nothing spent on models in the last 7 days.',
      row: (item) => {
        if ((item as HereItem).kind === 'here') {
          const here = item as HereItem;
          return { title: here.title, right: here.right, mark: here.attention ? 'attention' : here.state === 'agent' ? 'running' : 'ok' };
        }
        if ((item as AlertItem).kind === 'alert') {
          const alert = item as AlertItem;
          return { title: 'Daemon runs, 24 hours', right: alert.state === 'alert-passed' ? 'over alert' : 'under alert', mark: alert.state === 'alert-passed' ? 'attention' : 'ok' };
        }
        const spend = item as SpendItem;
        if (spend.state === 'none') return { title: spend.source, right: spend.cost, mark: 'paused' };
        // Below the daemon's runs row, each what it was for over 7 days (the detail says so).
        return { title: spend.source, right: spend.cost, mark: spend.state === 'unpriced' ? 'attention' : 'ok' };
      },
      detail: (item) => {
        if ((item as HereItem).kind === 'here') return (item as HereItem).lines;
        if ((item as AlertItem).kind === 'alert') {
          const alert = item as AlertItem;
          return [
            { label: 'Spending alert', text: alert.usd },
            { label: 'Last 24 hours', text: `${alert.runs}, what schedules, work, web chat and shared sessions cost on the daemon`, ...(alert.state === 'alert-passed' ? { tone: 'warning' as const } : {}) },
            alert.state === 'alert-passed'
              ? { text: 'More than the spending alert. The daemon says so once to your notification addresses, if you have set any.', tone: 'warning' as const }
              : { text: 'Under the spending alert. When they pass it, the daemon says so once to your notification addresses, if you have set any.', tone: 'muted' as const },
          ];
        }
        const spend = item as SpendItem;
        if (spend.state === 'none') {
          return [{ text: 'The daemon recorded no model costs in the last 7 days.' }];
        }
        return [
          { label: 'For', text: spend.source },
          { label: 'Daemon, last 7 days', text: spend.cost },
          { label: 'Tokens', text: spend.tokens },
          ...spend.models.map((model) => ({ label: 'Model', text: model.priced ? model.key : `${model.key}, no price` })),
          ...(spend.state === 'unpriced' ? [{ label: 'Why no amount', text: 'the price list does not know its model, so its cost is not guessed; give it your own price', tone: 'muted' as const }] : []),
          ...(spend.state === 'estimated' ? [{ label: 'About', text: 'one of its models has no price, so the amount is less than the whole; give it your own price', tone: 'muted' as const }] : []),
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
    { key: 'w', list: 'spending', whole: true, capability: 'usage.alert', label: 'spending alert' },
    // The conversation's own row: shorten it now (This conversation's control, run where the conversation is).
    { key: 'c', id: 'compact', list: 'spending', states: ['conversation'], capability: 'conversation.compact', label: 'shorten it now' },
    // Your own price: for the model in use, on the conversation's row; for a model with no price, on the daemon's row it spent.
    { key: 'p', id: 'price', list: 'spending', states: ['conversation'], capability: 'usage.price', label: 'your price for this model',
      fill: { model: (item) => (item as HereItem).modelKey ?? '' } },
    { key: 'p', id: 'price-unpriced', list: 'spending', states: ['unpriced', 'estimated'], capability: 'usage.price', label: 'give its model a price',
      fill: { model: (item) => (item as SpendItem).unpricedModel ?? '' } },
  ],
  count: (lists) => {
    const incomplete = (lists.cards ?? []).filter((item) => item.state === 'incomplete').length;
    if (incomplete > 0) return { count: incomplete, words: `${incomplete} card${incomplete === 1 ? '' : 's'} to add again`, tone: 'wrong' };
    // The daemon's own runs cost more than the spending alert in the last 24 hours.
    if ((lists.spending ?? []).some((item) => item.state === 'alert-passed')) return { count: 1, words: 'spending alert passed', tone: 'wrong' };
    return undefined;
  },
});
