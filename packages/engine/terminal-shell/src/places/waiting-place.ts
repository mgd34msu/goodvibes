/**
 * waiting-place.ts, the Waiting for you place: what waits on your answer, and
 * what was decided or held for you.
 *
 * Most of it is the daemon's one owner inbox (`inbox.list`), followed through
 * its `owner-inbox-update` and `approval-update` events, so an item answered,
 * withdrawn or expired from the web UI, a phone or another terminal leaves
 * these lists with no key pressed: questions (agents' questions, channel
 * claims, reports), approvals (a request you raised can be withdrawn here),
 * held calls (the calls a gate held for you, which each terminal program
 * posts to the same inbox as the daemon does: places/held-calls-inbox.ts), the
 * sends the Agent's content check refused (posted the same way:
 * places/held-sends-inbox.ts), the calls Jev decided that you can still
 * change, and everything already answered. An item's answers are its own keys
 * on the hint row (the daemon's, the same on every surface), each one the
 * capability that answers it, and they run on the press: the item is the
 * question. Enter lists them, starting on the one the ask opens on (No, for
 * one that loosens a protection).
 *
 * Beside the inbox: the purchases that wait on you (the daemon's payment host
 * with the inbox's purchase windows, `payments.pending`), the Telegram messages
 * held for you (the daemon's delegated intake, `inbound.telegram.list`,
 * followed through its list notices), and what each kind of approval asks about.
 */
import type { PlaceAction, PlaceAnswer, PlaceDetailLine, PlaceProgramName } from './place-types.js';
import { definePlace, type PlaceItem } from './place-types.js';

/** Inbox item metadata marking a send the Agent's content check refused (platform permissions/held-for-owner.ts HELD_SEND_METADATA). */
const HELD_SEND = 'heldSend';

interface InboxItem extends PlaceItem {
  /** `open`; `yours` for a request for approval this program raised and may still withdraw; `notice` for a report (read, never answered in words). */
  readonly state: 'open' | 'yours' | 'notice';
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly options: readonly string[];
  readonly askedBy?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly expiresAt?: number | undefined;
  /** The daemon's words for its choices and their keys (permissions/ask-presentation.ts); `default` is the one the ask opens on. */
  readonly choices: readonly Choice[];
  readonly consequence?: string | undefined;
  readonly why?: string | undefined;
  /** The ask loosens a protection (its presentation's `weakensSafety`, or a card that opens on No). */
  readonly loosens: boolean;
}

interface Choice { readonly key?: string | undefined; readonly label: string; readonly value?: string | undefined; readonly id: string; readonly default?: boolean | undefined }

/** A call Jev decided: its state is the program that can carry a choice out, then which choices it takes (`tui:rules`). */
interface DecisionItem extends PlaceItem {
  readonly title: string;
  readonly detail: string;
  readonly madeIn: string;
  readonly verdict: string;
  readonly createdAt?: number | undefined;
  readonly expiresAt?: number | undefined;
  /** The choices it offers, in words ("keep, never, always, ask me"). */
  readonly choiceWords: string;
}

/** Something already answered, withdrawn or expired. */
interface ClosedItem extends PlaceItem {
  readonly title: string;
  readonly kind: string;
  readonly detail: string;
  readonly answer?: string | undefined;
  readonly answeredBy?: string | undefined;
  readonly delivery?: string | undefined;
  readonly withdrawn?: string | undefined;
  readonly askedBy?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly closedAt?: number | undefined;
}

/** A Telegram message held for you: `waiting` for your decision, `in review` or `read` in the review queue. */
interface TelegramItem extends PlaceItem {
  readonly title: string;
  readonly configurationId?: string | undefined;
  readonly sourceExpiresAt?: number | undefined;
  readonly recordExpiresAt?: number | undefined;
  readonly acceptedAt?: number | undefined;
  /** Its chat, for a message in the review queue: still held, held but keeping no new messages, or handed back. */
  readonly chat?: 'held' | 'keeps-no-new' | 'handed-back' | undefined;
}

/** Every state of a message in the review queue: read or not, with its chat's when that is no longer simply held. */
const TELEGRAM_REVIEW_STATES = ['in review', 'read', 'in review, keeps-no-new', 'read, keeps-no-new', 'in review, handed-back', 'read, handed-back'];

/** A review row's state words: read or not, and its chat when that is no longer simply held. */
const TELEGRAM_CHAT_WORDS: Readonly<Record<NonNullable<TelegramItem['chat']>, string>> = {
  held: '', 'keeps-no-new': 'its chat keeps no new messages', 'handed-back': 'its chat was handed back',
};

/**
 * A purchase that waits on you, one row a purchase, with the ids capabilities/builtin/purchases.ts gives its rows
 * (`window:<purchase>`, `code:<purchase>`, `operation:<operation>`): a window to answer, a code to type, a checkout to
 * stop or to check with the shop, a record that could not be read.
 */
interface PurchaseItem extends PlaceItem {
  readonly title: string;
  /** The purchase in words ("a packet of basil seeds from seedhaus.test, $8.85"), as a form and a question name it. */
  readonly what?: string | undefined;
  readonly purchaseId: string;
  readonly windowKind?: 'approval' | 'veto' | undefined;
  readonly deadlineMs?: number | undefined;
  readonly merchant?: string | undefined;
  readonly cardLast4?: string | undefined;
  readonly where: string;
  readonly notice?: string | undefined;
}

/** What one kind of approval asks about. */
interface KindItem extends PlaceItem {
  readonly title: string;
  readonly check: string;
}

type Item = InboxItem | DecisionItem | ClosedItem | TelegramItem | PurchaseItem | KindItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** Text an agent or a channel wrote is shown, never obeyed by the terminal. */
const plain = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
/** The same, keeping its lines (a send's fields, a purchase notice). */
const plainLines = (value: string): string => value.split('\n').map(plain).join('\n');
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function rawItems(output: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const items = record(output).items;
  return Array.isArray(items) ? items.map(record).filter((item) => text(item.id) !== '') : [];
}

const heldSend = (item: Readonly<Record<string, unknown>>): boolean => item.kind === 'queued-action' && record(item.metadata)[HELD_SEND] === true;

function inboxItems(output: unknown, keep: (item: Readonly<Record<string, unknown>>) => boolean): readonly InboxItem[] {
  return rawItems(output)
    .filter((item) => item.status === 'open' && keep(item))
    .map((item): InboxItem => {
      const presentation = record(item.presentation);
      const choices = Array.isArray(presentation.choices) ? presentation.choices as InboxItem['choices'] : [];
      const consequence = text(record(presentation.consequence).text);
      const reading = record(item.reading);
      const yours = record(reading.requester).mine === true && Array.isArray(reading.allowedActions) && reading.allowedActions.includes('cancel');
      return {
        id: text(item.id),
        state: yours ? 'yours' : item.kind === 'report' ? 'notice' : 'open',
        kind: text(item.kind),
        title: plain(text(presentation.title) || text(item.title)),
        detail: heldSend(item) ? plainLines(text(item.detail)) : plain(text(item.detail)),
        options: Array.isArray(item.options) ? (item.options as unknown[]).filter((option): option is string => typeof option === 'string') : [],
        ...(text(item.askedBy) ? { askedBy: plain(text(item.askedBy)) } : {}),
        createdAt: time(item.createdAt),
        expiresAt: time(item.expiresAt),
        choices,
        ...(consequence ? { consequence: plain(consequence) } : {}),
        ...(text(presentation.why) ? { why: plain(text(presentation.why)) } : {}),
        loosens: presentation.weakensSafety === true || choices.some((choice) => choice.default === true && choice.id === 'no'),
      };
    });
}

/** The program a decision was made in, as a person names it. */
function programWords(surface: string): string {
  if (surface === 'tui') return 'the terminal app';
  if (surface === 'agent') return 'the Agent';
  if (surface === 'daemon' || surface === 'hosted') return 'the daemon';
  return surface || 'another program';
}

/** The program that carries out a choice on a decision: the one whose gate made it; the daemon's from any program. */
function decidedIn(surface: string): 'tui' | 'agent' | 'daemon' | 'elsewhere' {
  if (surface === 'tui' || surface === 'agent') return surface;
  if (surface === 'daemon' || surface === 'hosted') return 'daemon';
  return 'elsewhere';
}

function decisionItems(output: unknown): readonly DecisionItem[] {
  return rawItems(output)
    .filter((item) => item.status === 'open' && item.kind === 'decision')
    .map((item): DecisionItem => {
      const options = Array.isArray(item.options) ? item.options : [];
      const rules = options.includes('always');
      const metadata = record(item.metadata);
      const choices = rules ? 'rules' : 'decided';
      return {
        id: text(item.id),
        state: `${decidedIn(text(metadata.surface))}:${choices}`,
        title: plain(text(item.title)),
        detail: plain(text(item.detail)),
        madeIn: programWords(text(metadata.surface)),
        verdict: text(metadata.verdict),
        createdAt: time(item.createdAt),
        expiresAt: time(item.expiresAt),
        choiceWords: ['keep', ...(rules ? ['never', 'always', 'ask me'] : [])].join(', '),
      };
    });
}

/** The principals that are the owner's own credentials by their nature (daemon-api actor.ts: the operator token, the local one). */
const OWNERS_OWN = new Set(['owner', 'shared-token', 'local', 'local-owner']);

/** Who answered, as a person reads it: "you" only when the owner himself answered; anyone else by the name the daemon keeps. */
function answererWords(by: Readonly<Record<string, unknown>>): string {
  const actor = text(by.actor);
  if (by.owner === true || OWNERS_OWN.has(actor)) return 'you';
  if (!actor || actor === 'operator') return 'a caller the daemon did not name';
  if (actor.startsWith('pairing:')) return `the paired device ${plain(actor.slice('pairing:'.length))}`;
  if (actor.startsWith('channel:')) return `a sender on ${plain(actor.split(':')[1] ?? 'a channel')}`;
  return plain(actor);
}

/** Where an answer came from, as a person names it. */
function surfaceWords(surface: string): string {
  const named: Readonly<Record<string, string>> = {
    tui: 'the terminal app', agent: 'the Agent', web: 'the web UI', daemon: 'the daemon', local: 'this computer', telegram: 'Telegram', slack: 'Slack', discord: 'Discord',
  };
  return named[surface] ?? plain(surface);
}

function closedItems(output: unknown): readonly ClosedItem[] {
  return rawItems(output)
    .filter((item) => item.status !== 'open')
    .map((item): ClosedItem => {
      const answer = record(item.answer);
      // The choice in the words the ask offered it in ("No"), never the value it stored ("dismiss").
      const choices = Array.isArray(record(item.presentation).choices) ? (record(item.presentation).choices as unknown[]).map(record) : [];
      const option = text(answer.option);
      const offered = option ? choices.find((choice) => choice.value === option) ?? (option === 'approve' ? choices.find((choice) => choice.id === 'once') : option === 'deny' || option === 'dismiss' ? choices.find((choice) => choice.id === 'no') : undefined) : undefined;
      const said = [text(offered?.label) || option, text(answer.text)].filter(Boolean).join(': ');
      const by = record(item.answeredBy);
      const delivery = record(item.delivery);
      const to = plain(text(delivery.to));
      const where = delivery.state === 'delivered' ? `delivered to ${to}` : delivery.state === 'waiting' ? `waiting for ${to}` : delivery.state === 'undeliverable' ? `could not reach ${to}` : '';
      return {
        id: text(item.id),
        state: text(item.status) || 'closed',
        kind: text(item.kind),
        title: plain(text(record(item.presentation).title) || text(item.title)),
        detail: plain(text(item.detail)),
        ...(said ? { answer: plain(said) } : {}),
        ...(text(by.surface) ? { answeredBy: `${answererWords(by)}, from ${surfaceWords(text(by.surface))}` } : {}),
        ...(where ? { delivery: `${where}${text(delivery.reason) ? `: ${plain(text(delivery.reason))}` : ''}` } : {}),
        ...(text(item.withdrawnReason) ? { withdrawn: plain(text(item.withdrawnReason)) } : {}),
        ...(text(item.askedBy) ? { askedBy: plain(text(item.askedBy)) } : {}),
        createdAt: time(item.createdAt),
        closedAt: time(item.closedAt),
      };
    });
}

const REVIEW_ID_PREFIX = 'external-review-';
const APPROVAL_ID_PREFIX = 'approval-';
const SHORT = 8;

function telegramItems(output: unknown): readonly TelegramItem[] {
  const list = record(output);
  const pending = Array.isArray(list.pending) ? list.pending.map(record) : [];
  const records = Array.isArray(list.records) ? list.records.map(record) : [];
  // The owner's chats still held, by configuration: a handed-back chat is not listed (no `x`, no `b`); one that keeps
  // no new messages offers only `b`. An answer without the list (an older daemon) leaves the row's chat as held.
  const chats = Array.isArray(list.chats) ? new Map(list.chats.map(record).map((chat) => [text(chat.configurationId), chat.keepsNewMessages === true] as const)) : undefined;
  const chatOf = (configuration: string): TelegramItem['chat'] => {
    if (chats === undefined) return 'held';
    const keeps = chats.get(configuration);
    return keeps === undefined ? 'handed-back' : keeps ? 'held' : 'keeps-no-new';
  };
  const shown: TelegramItem[] = [];
  for (const entry of pending) {
    // Only a message still waiting for the owner: one accepted is in the review queue below, one refused is gone.
    if (entry.outcome !== undefined && entry.outcome !== 'awaiting-owner') continue;
    // The approval's id after the `approval-` every one shares (capabilities/builtin/telegram.ts telegramPendingShortId).
    const approval = text(entry.approvalId);
    const id = (approval.startsWith(APPROVAL_ID_PREFIX) ? approval.slice(APPROVAL_ID_PREFIX.length) : approval).slice(0, SHORT);
    if (!id) continue;
    const until = time(entry.sourceExpiresAt);
    shown.push({
      id, state: 'waiting',
      title: until !== undefined ? `A held message, kept until ${new Date(until).toLocaleString()}` : 'A held message',
      sourceExpiresAt: until,
    });
  }
  for (const entry of records) {
    const raw = text(entry.id);
    const id = (raw.startsWith(REVIEW_ID_PREFIX) ? raw.slice(REVIEW_ID_PREFIX.length) : raw).slice(0, SHORT);
    if (!id || entry.state === 'cancelled') continue;
    const accepted = time(entry.acceptedAt);
    const read = entry.state === 'reviewed' ? 'read' : 'in review';
    const chat = chatOf(text(entry.configurationId));
    shown.push({
      // The state the keys attach to carries the chat's: `x` only while the chat keeps new messages, `b` while it is held.
      id, state: chat === 'held' ? read : `${read}, ${chat}`, chat,
      title: accepted !== undefined ? `A message you accepted ${new Date(accepted).toLocaleString()}` : 'A message you accepted',
      ...(text(entry.configurationId) ? { configurationId: text(entry.configurationId) } : {}),
      sourceExpiresAt: time(entry.sourceExpiresAt),
      recordExpiresAt: time(entry.recordExpiresAt),
      acceptedAt: accepted,
    });
  }
  return shown;
}

/** The purchases `payments.pending` answers (its `data.purchases`), read defensively: the answer is another process's. */
function purchaseItems(output: unknown): readonly PurchaseItem[] {
  const data = record(record(output).data);
  const rows = Array.isArray(data.purchases) ? data.purchases.map(record) : [];
  const shown = rows.flatMap((row): PurchaseItem[] => {
    const id = text(row.id);
    const state = text(row.state);
    if (!id || !state) return [];
    return [{
      id, state, title: plain(text(row.title)), purchaseId: text(row.purchaseId), ...(text(row.what) ? { what: plain(text(row.what)) } : {}),
      ...(row.windowKind === 'approval' || row.windowKind === 'veto' ? { windowKind: row.windowKind } : {}),
      deadlineMs: time(row.deadlineMs),
      ...(text(row.merchant) ? { merchant: plain(text(row.merchant)) } : {}),
      ...(text(row.cardLast4) ? { cardLast4: plain(text(row.cardLast4)) } : {}),
      where: plain(text(row.where)),
      ...(text(row.notice) ? { notice: plainLines(text(row.notice)) } : {}),
    }];
  });
  // The payment host's status could not be read: said as a row, never shown as nothing waiting.
  const unread = text(data.unreadable);
  return unread ? [...shown, { id: 'status-unread', state: 'unreadable', title: 'The payment host\'s purchases could not be read', purchaseId: '', where: plain(unread) }] : shown;
}

function kindItems(raw: unknown): readonly KindItem[] {
  return (Array.isArray(raw) ? raw.map(record) : []).flatMap((kind): KindItem[] => text(kind.value)
    ? [{ id: text(kind.value), state: 'kind', title: plain(text(kind.label)), check: plain(text(kind.help)) }] : []);
}

/** The kinds of approval as `approval.kinds` answers them through `capabilities.run` (`data.kinds`: kind, label, check). */
function kindItemsOfRun(output: unknown): readonly KindItem[] {
  const kinds = record(record(output).data).kinds;
  return (Array.isArray(kinds) ? kinds.map(record) : []).flatMap((kind): KindItem[] => text(kind.kind)
    ? [{ id: text(kind.kind), state: 'kind', title: plain(text(kind.label)), check: plain(text(kind.check)) }] : []);
}
/** The answers that say no: the refusing one an ask that loosens a protection opens on. */
const REFUSING = new Set(['deny', 'dismiss', 'stop', 'decline', 'no', 'never', 'drop']);

/**
 * The keys for an item's answers: the daemon's own key for a choice where it
 * gives one (y, n, 1..8), y and n for approve and deny, else 1, 2, ... The
 * one the daemon's card opens on (`default`) is the one the list opens on.
 */
function answersOf(item: Pick<InboxItem, 'options' | 'choices' | 'loosens'>): readonly PlaceAnswer[] {
  const used = new Set<string>(['r', 'w', 'x']);
  const listed = item.options.map((option, index) => {
    const choice = item.choices.find((candidate) => candidate.value === option)
      ?? (option === 'approve' ? item.choices.find((candidate) => candidate.id === 'once') : option === 'deny' ? item.choices.find((candidate) => candidate.id === 'no') : undefined);
    const wanted = choice?.key ?? (option === 'approve' ? 'y' : option === 'deny' ? 'n' : String(index + 1));
    const key = used.has(wanted) ? String(index + 1) : wanted;
    used.add(key);
    return { option, choice, key, refuses: REFUSING.has(option.toLowerCase()) || choice?.id === 'no' };
  });
  // An ask that loosens a protection opens on its refusing answer, whatever else it marks.
  const opensOn = item.loosens ? listed.findIndex((entry) => entry.refuses) : listed.findIndex((entry) => entry.choice?.default === true);
  // A hint's words start in lower case; the rest is the daemon's as written ("until I change it back").
  const lowerFirst = (words: string): string => words.charAt(0).toLowerCase() + words.slice(1);
  return listed.map((entry, index) => ({
    key: entry.key,
    label: lowerFirst(entry.choice?.label ?? entry.option),
    values: { answer: entry.option },
    // The line after the answer names the choice as pressed ("No"), not the option word stored ("deny").
    said: entry.choice?.label ?? entry.option,
    ...(entry.refuses ? { refuses: true as const } : {}),
    ...(index === opensOn ? { opensOn: true as const } : {}),
  }));
}

/**
 * A purchase window's answers, in the words and keys its card uses on every surface (permissions/ask-presentation.ts):
 * inside your limits, let it go ahead (y) or stop it (n); over budget, yes, buy it (y) or no (n). The list opens on the
 * answer that buys nothing.
 */
function purchaseAnswers(item: PurchaseItem): readonly PlaceAnswer[] {
  const [yes, no] = item.windowKind === 'veto'
    ? [{ answer: 'go', said: 'Let it go ahead' }, { answer: 'stop', said: 'Stop it' }]
    : [{ answer: 'approve', said: 'Yes, buy it' }, { answer: 'deny', said: 'No' }];
  return [
    { key: 'y', label: yes.said.toLowerCase(), values: { answer: yes.answer }, said: yes.said },
    { key: 'n', label: no.said.toLowerCase(), values: { answer: no.answer }, said: no.said, refuses: true, opensOn: true },
  ];
}

/** The inbox's frames: an item posted, answered, withdrawn or delivered, and the approval broker's. */
const INBOX_EVENTS = { domains: ['gate'], events: ['owner-inbox-update', 'approval-update'] } as const;
/** Every open item: the open lists keep their kinds (one read for the four). */
const OPEN = { status: 'open' } as const;

const KIND_WORDS: Readonly<Record<string, string>> = {
  question: 'a question', claim: 'a claim', purchase: 'a purchase window', 'queued-action': 'a held action', report: 'a report', approval: 'an approval',
  decision: 'a decision',
};

function when(ms: number | undefined): string {
  return ms === undefined ? 'not said' : new Date(ms).toLocaleString();
}

// A report is a notice, not a question: it is from someone, posted, and here for a reason; nothing waits on an answer.
const inboxDetail = (item: InboxItem): PlaceDetailLine[] => [
  { label: 'What it is', text: item.kind === 'report' ? 'a notice' : KIND_WORDS[item.kind] ?? item.kind },
  ...(item.askedBy ? [{ label: item.kind === 'report' ? 'From' : 'Asked by', text: item.askedBy }] : []),
  { label: item.kind === 'report' ? 'Posted' : 'Asked', text: when(item.createdAt) },
  ...(item.expiresAt !== undefined ? [{ label: 'Waits until', text: when(item.expiresAt), tone: 'warning' as const }] : []),
  ...(item.state === 'yours' ? [{ label: 'Raised by', text: 'you, here: you can withdraw it' }] : []),
  ...(item.consequence ? [{ text: '' }, { label: 'What answering does', text: item.consequence }] : []),
  ...(item.detail ? [{ text: '' }, { text: item.detail }] : []),
  ...(item.why ? [{ text: '' }, { label: item.kind === 'report' ? 'Why it is here' : 'Why you are asked', text: item.why, tone: 'muted' as const }] : []),
  ...(item.options.length === 0 && item.kind !== 'report' ? [{ text: '' }, { text: 'It takes an answer in your own words.', tone: 'muted' as const }] : []),
];

const DECISION_CHOICES = ['decided', 'rules'] as const;

/**
 * A choice on a decision is carried out by the program whose gate made it (its rule store), so its keys show only
 * there: in the terminal app on the terminal app's decisions, in the Agent on the Agent's, and on the daemon's in
 * both. Elsewhere the detail names the program that can. No decision is undone from here: it is posted before its
 * call runs, and the gate never puts a change the program records for undo to Jev (permissions/jev-decisions.ts).
 */
function decisionActions(): readonly PlaceAction<Item>[] {
  const programs: readonly ('tui' | 'agent')[] = ['tui', 'agent'];
  return programs.flatMap((program) => {
    const states = (choices: readonly string[]): string[] => [program, 'daemon'].flatMap((where) => choices.map((choice) => `${where}:${choice}`));
    const here: readonly PlaceProgramName[] = [program];
    return [
      // A choice on a decision is its answer (it never asks again); which choices it takes is its state.
      { key: 'k', id: 'keep', list: 'decisions', states: states(DECISION_CHOICES), programs: here, capability: 'decisions.keep', label: 'keep', fill: { decision: 'id' }, answersItem: true },
      { key: 'n', id: 'never', list: 'decisions', states: states(['rules']), programs: here, capability: 'decisions.never', label: 'never', fill: { decision: 'id' }, answersItem: true },
      { key: 'a', id: 'always', list: 'decisions', states: states(['rules']), programs: here, capability: 'decisions.always', label: 'always', fill: { decision: 'id' }, answersItem: true },
      { key: 's', id: 'ask-me', list: 'decisions', states: states(['rules']), programs: here, capability: 'decisions.ask', label: 'ask me', fill: { decision: 'id' }, answersItem: true },
    ] satisfies PlaceAction<Item>[];
  });
}

const PURCHASE_MARKS: Readonly<Record<string, 'waiting' | 'running' | 'attention' | 'paused' | 'ok'>> = {
  window: 'waiting', code: 'waiting', notice: 'ok', running: 'running', stopping: 'paused', check: 'attention', unreadable: 'attention',
};

export const WAITING_PLACE = definePlace<Item>({
  id: 'waiting',
  group: 'waiting',
  title: 'Waiting for you',
  lists: [
    {
      id: 'questions',
      label: 'Questions',
      noun: 'what waits on you',
      // The open lists are one read of the inbox (the same method and input are read once per refresh).
      // A purchase window is the Purchases tab's; a purchase notice (only OK to answer) is no question: it is this
      // program's notice, in System, Notices (purchase-notices-follow.ts), and is neither listed nor counted here.
      // A report needs no answer either: it is a notice, in System, Notices, never a question here.
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, (item) => !['approval', 'decision', 'queued-action', 'purchase', 'report'].includes(text(item.kind))) },
      follows: INBOX_EVENTS,
      empty: 'Nothing is waiting on you.',
      // The tab says these are questions: only another kind (a claim, a report) names itself on its row.
      row: (item) => {
        const inbox = item as InboxItem;
        // A notice (a report) waits on no answer: it is marked as something to read, not as a question.
        return { title: inbox.title, ...(inbox.kind !== 'question' ? { right: inbox.kind === 'report' ? 'a notice' : KIND_WORDS[inbox.kind] ?? inbox.kind } : {}), mark: inbox.kind === 'report' ? 'ok' : 'waiting' };
      },
      detail: (item) => inboxDetail(item as InboxItem),
    },
    {
      id: 'approvals',
      label: 'Approvals',
      noun: 'the approvals waiting on you',
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, (item) => item.kind === 'approval') },
      follows: INBOX_EVENTS,
      empty: 'No approval is waiting on you.',
      row: (item) => {
        const inbox = item as InboxItem;
        // Who asked is said beside it only when short: a long name would cut the question itself (the detail names it).
        const by = inbox.askedBy && inbox.askedBy.length <= 16 ? inbox.askedBy : undefined;
        return { title: inbox.title, ...(inbox.state === 'yours' ? { right: 'raised by you' } : by ? { right: by } : {}), mark: 'waiting' };
      },
      detail: (item) => inboxDetail(item as InboxItem),
    },
    {
      id: 'purchases',
      label: 'Purchases',
      noun: 'the purchases waiting for you',
      // One purchase a row: a window to answer, a security code to type, a checkout to stop or to check with the shop.
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'payments.pending', inputs: {} }, items: purchaseItems },
      // A window posted or answered (the inbox), a checkout admitted or moved on, a code asked for or given (payments).
      follows: { ...INBOX_EVENTS, lists: ['payments'] },
      empty: 'No purchase is waiting for you.',
      row: (item) => {
        const purchase = item as PurchaseItem;
        return { title: purchase.title, mark: PURCHASE_MARKS[purchase.state] ?? 'waiting' };
      },
      // A form, a question and an outcome name the purchase by what it buys, not by its row ("Security code needed: ...").
      name: (item) => (item as PurchaseItem).what ?? '',
      detail: (item) => {
        const purchase = item as PurchaseItem;
        return [
          { label: 'Where it stands', text: purchase.where },
          ...(purchase.deadlineMs !== undefined ? [{ label: purchase.windowKind === 'veto' ? 'Goes ahead at' : 'Waits until', text: when(purchase.deadlineMs), tone: 'warning' as const }] : []),
          ...(purchase.merchant ? [{ label: 'Shop', text: purchase.merchant }] : []),
          ...(purchase.cardLast4 ? [{ label: 'Card', text: `ending ${purchase.cardLast4}` }] : []),
          ...(purchase.notice ? [{ text: '' }, ...purchase.notice.split('\n').map((line) => ({ text: line }))] : []),
          ...(purchase.state === 'code' ? [{ text: '' }, { text: 'The code is typed on a hidden line, handed to this purchase and kept nowhere.', tone: 'muted' as const }] : []),
          ...(purchase.state === 'check' ? [{ text: '' }, { text: 'Look at the shop\'s order history and your card statement first; what you record settles its bookkeeping and orders nothing.', tone: 'muted' as const }] : []),
        ];
      },
    },
    {
      id: 'held',
      label: 'Held calls',
      noun: 'the calls held for you',
      // Held by any gate (the daemon's, or a terminal program's: places/held-calls-inbox.ts): queued actions in the inbox.
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, (item) => item.kind === 'queued-action' && !heldSend(item)) },
      follows: INBOX_EVENTS,
      empty: 'No call is held for you.',
      // The tab says these are held and not run; the row is the call itself.
      row: (item) => ({ title: (item as InboxItem).title, mark: 'paused' }),
      detail: (item) => [
        ...inboxDetail(item as InboxItem),
        { text: '' },
        { text: 'Approving lets this exact call run when the work carries on, for that session only.', tone: 'muted' as const },
      ],
    },
    {
      id: 'sends',
      label: 'Sends',
      noun: 'the sends waiting for your approval',
      // The mails and invitations the Agent's content check refused, posted to the inbox (places/held-sends-inbox.ts).
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, heldSend) },
      follows: INBOX_EVENTS,
      empty: 'No send is waiting for your approval.',
      row: (item) => ({ title: (item as InboxItem).title, mark: 'paused' }),
      detail: (item) => {
        const send = item as InboxItem;
        return [
          { label: 'Refused', text: when(send.createdAt) },
          ...(send.expiresAt !== undefined ? [{ label: 'Can be sent until', text: when(send.expiresAt), tone: 'warning' as const }] : []),
          { text: '' },
          ...send.detail.split('\n').map((line) => ({ text: line })),
          { text: '' },
          { text: 'It goes out exactly as shown, from the Agent, only when you send it; a refused send waits five minutes.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'decisions',
      label: 'Decisions',
      noun: 'the calls Jev decided for you',
      source: { kind: 'daemon', method: 'inbox.list', input: { status: 'open', kinds: ['decision'] }, items: decisionItems },
      follows: INBOX_EVENTS,
      empty: 'Nothing Jev decided is waiting to be changed.',
      row: (item) => ({ title: (item as DecisionItem).title, right: (item as DecisionItem).madeIn, mark: 'ok' }),
      detail: (item) => {
        const decision = item as DecisionItem;
        return [
          { label: 'Decided', text: when(decision.createdAt) },
          { label: 'Made in', text: decision.madeIn },
          ...(decision.expiresAt !== undefined ? [{ label: 'Can be changed until', text: when(decision.expiresAt) }] : []),
          ...(decision.detail ? [{ text: '' }, ...decision.detail.split('\n').map((line) => ({ text: line }))] : []),
          { text: '' },
          {
            text: decision.madeIn === 'the daemon'
              ? 'A choice on it is carried out by the daemon, from any program.'
              : `Only ${decision.madeIn} can carry out a choice on it (${decision.choiceWords}), while the session that made it is open.`,
            tone: 'muted' as const,
          },
        ];
      },
    },
    {
      id: 'telegram',
      label: 'Telegram',
      noun: 'the Telegram messages held for you',
      source: { kind: 'daemon', method: 'inbound.telegram.list', input: {}, items: telegramItems },
      // A chat held or released, a message decided or closed (the intake's list notice); a new message raises an approval.
      follows: { domains: ['gate'], events: ['approval-update'], lists: ['telegram-intake'] },
      empty: 'No Telegram message is held for you.',
      // The row's word is read or not (the chat's state is in the detail); the state keys attach to carries both.
      row: (item) => {
        const word = item.state === 'waiting' ? 'waiting' : item.state.startsWith('read') ? 'read' : 'in review';
        return { title: (item as TelegramItem).title, right: word, mark: word === 'waiting' ? 'waiting' : word === 'read' ? 'ok' : 'paused' };
      },
      detail: (item) => {
        const message = item as TelegramItem;
        const chat = message.chat ? TELEGRAM_CHAT_WORDS[message.chat] : '';
        return [
          { label: 'Where it stands', text: message.state === 'waiting' ? 'waiting for your decision' : message.state.startsWith('read') ? 'in the review queue, read' : 'in the review queue, not read yet' },
          ...(chat ? [{ label: 'Its chat', text: chat.replace(/^its chat /, ''), tone: 'muted' as const }] : []),
          ...(message.acceptedAt !== undefined ? [{ label: 'Accepted', text: when(message.acceptedAt) }] : []),
          ...(message.sourceExpiresAt !== undefined ? [{ label: 'Original kept until', text: when(message.sourceExpiresAt), tone: 'warning' as const }] : []),
          ...(message.recordExpiresAt !== undefined ? [{ label: 'Review kept until', text: when(message.recordExpiresAt) }] : []),
          { text: '' },
          { text: message.state === 'waiting' ? 'Nothing in it is run: accepting puts it in your review queue to read.' : 'Nothing in it is run.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'answered',
      label: 'Answered',
      noun: 'what was asked of you before',
      source: { kind: 'daemon', method: 'inbox.list', input: { status: 'closed', limit: 100 }, items: closedItems },
      follows: INBOX_EVENTS,
      empty: 'Nothing has been answered yet.',
      row: (item) => ({ title: (item as ClosedItem).title, right: item.state, mark: item.state === 'answered' ? 'ok' : 'paused' }),
      detail: (item) => {
        const closed = item as ClosedItem;
        return [
          { label: 'What it was', text: KIND_WORDS[closed.kind] ?? closed.kind },
          ...(closed.askedBy ? [{ label: 'Asked by', text: closed.askedBy }] : []),
          { label: 'Asked', text: when(closed.createdAt) },
          ...(closed.answer ? [{ label: 'Answer', text: closed.answer }] : []),
          ...(closed.answeredBy ? [{ label: 'Answered by', text: closed.answeredBy }] : []),
          ...(closed.closedAt !== undefined ? [{ label: closed.state === 'answered' ? 'Answered' : closed.state === 'expired' ? 'Expired' : 'Closed', text: when(closed.closedAt) }] : []),
          ...(closed.delivery ? [{ label: 'The answer', text: closed.delivery }] : []),
          ...(closed.withdrawn ? [{ label: 'Withdrawn', text: closed.withdrawn }] : []),
          ...(closed.detail ? [{ text: '' }, { text: closed.detail }] : []),
        ];
      },
    },
    {
      id: 'kinds',
      label: 'Kinds',
      noun: 'the kinds of approval',
      // The capability's own list (approval.kinds, capabilities/builtin/waiting.ts), the same words for every door.
      source: { kind: 'program', name: 'approval-kinds', items: kindItems },
      programs: ['tui', 'agent'],
      empty: 'No kind of approval is described.',
      row: (item) => ({ title: (item as KindItem).title }),
      detail: (item) => [{ label: 'What it asks about, and what to check before you answer', text: (item as KindItem).check }],
    },
    // The web view's Kinds: the same capability, run by the daemon (it holds no program of its own to read them from).
    {
      id: 'kinds',
      label: 'Kinds',
      noun: 'the kinds of approval',
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'approval.kinds', inputs: {} }, items: kindItemsOfRun },
      // Follows nothing: the kinds of approval are fixed words of this build; they never change while the place is open.
      programs: ['web'],
      empty: 'No kind of approval is described.',
      row: (item) => ({ title: (item as KindItem).title }),
      detail: (item) => [{ label: 'What it asks about, and what to check before you answer', text: (item as KindItem).check }],
    },
  ],
  actions: [
    // An item's answers are its own keys, and answering the item never asks again (answersItem).
    // A notice posted with no options is marked read like the rest ("read" is what its card's one choice sends).
    { key: 'a', list: 'questions', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answersOf((item as InboxItem).state === 'notice' && (item as InboxItem).options.length === 0 ? { ...(item as InboxItem), options: ['read'] } : item as InboxItem) },
    // A notice (a report) is read, never answered in words.
    { key: 'w', id: 'answer-in-words', list: 'questions', states: ['open', 'yours'], capability: 'questions.answer', label: 'answer in words', fill: { item: 'id' }, answersItem: true },
    { key: 'a', list: 'approvals', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answersOf(item as InboxItem) },
    // Withdrawing a request you raised is not an answer to it: it cannot be undone, so it asks first.
    { key: 'x', id: 'withdraw', list: 'approvals', states: ['yours'], capability: 'questions.withdraw', label: 'withdraw', fill: { request: 'id' } },
    // Purchases: a window is answered on its own keys (yes, buy it or no; let it go ahead or stop it).
    { key: 'a', list: 'purchases', states: ['window'], capability: 'payments.answer-window', fill: { purchase: 'id' }, answers: (item) => purchaseAnswers(item as PurchaseItem) },
    { key: 'c', id: 'type-security-code', list: 'purchases', states: ['code'], capability: 'payments.security-code', label: 'type the security code', fill: { purchase: 'id' } },
    { key: 'x', id: 'stop-checkout', list: 'purchases', states: ['running'], capability: 'payments.stop-checkout', label: 'stop this checkout', fill: { purchase: 'id' } },
    { key: 'f', id: 'record-finding', list: 'purchases', states: ['check'], capability: 'payments.finding', label: 'record what the shop shows', fill: { purchase: 'id' } },
    { key: 'a', list: 'held', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answersOf(item as InboxItem) },
    // A refused send is sent as shown or dropped on its own keys (y, n), from any program: the Agent that refused it sends it.
    { key: 'a', list: 'sends', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answersOf(item as InboxItem) },
    ...decisionActions(),
    // Telegram: a held message is accepted for review or refused; one in the queue is read, closed, or its chat let go.
    { key: 'h', id: 'hold-a-chat', list: 'telegram', whole: true, capability: 'telegram.configure', label: 'hold a chat' },
    { key: 'y', id: 'accept-message', list: 'telegram', states: ['waiting'], capability: 'telegram.approve', label: 'accept for review', fill: { message: 'id' } },
    { key: 'n', id: 'refuse-message', list: 'telegram', states: ['waiting'], capability: 'telegram.deny', label: 'refuse', fill: { message: 'id' } },
    { key: 'i', id: 'where-it-stands', list: 'telegram', capability: 'telegram.status', label: 'where it stands', fill: { message: 'id' } },
    // The original opens whole in the result pane when it is longer than the outcome line (place-modal.ts).
    { key: 'o', id: 'read-message', list: 'telegram', states: TELEGRAM_REVIEW_STATES, capability: 'telegram.read', label: 'read it', fill: { message: 'id' } },
    { key: 'c', id: 'close-review', list: 'telegram', states: TELEGRAM_REVIEW_STATES, capability: 'telegram.cancel', label: 'close', fill: { message: 'id' } },
    // Only where they apply: `x` while the message's chat still keeps new messages, `b` while the chat is held at all.
    { key: 'x', id: 'stop-holding', list: 'telegram', states: ['in review', 'read'], capability: 'telegram.revoke', label: 'keep no new messages', fill: { configuration: (item) => (item as TelegramItem).configurationId ?? '' } },
    { key: 'b', id: 'hand-back', list: 'telegram', states: ['in review', 'read', 'in review, keeps-no-new', 'read, keeps-no-new'], capability: 'telegram.release', label: 'hand the chat back', fill: { chat: (item) => (item as TelegramItem).configurationId ?? '' } },
  ],
  count: (lists) => {
    const telegram = (lists.telegram ?? []).filter((item) => item.state === 'waiting').length;
    const purchases = (lists.purchases ?? []).filter((item) => item.state === 'window' || item.state === 'code' || item.state === 'check').length;
    const count = (lists.questions?.length ?? 0) + (lists.approvals?.length ?? 0) + (lists.held?.length ?? 0) + telegram + purchases + (lists.sends?.length ?? 0);
    return count > 0 ? { count, words: `${count} waiting`, tone: 'waiting' } : undefined;
  },
});
