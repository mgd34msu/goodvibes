/**
 * waiting-place.ts, the Waiting for you place: what waits on your answer, and
 * what was decided or held for you.
 *
 * Most of it is the daemon's one owner inbox (`inbox.list`), followed through
 * its `owner-inbox-update` and `approval-update` events, so an item answered,
 * withdrawn or expired from the web UI, a phone or another terminal leaves
 * these lists with no key pressed: questions (agents' questions, channel
 * claims, purchase windows, reports), approvals (a request you raised can be
 * withdrawn here), held calls (the calls a gate held for you, which each
 * terminal program posts to the same inbox as the daemon does:
 * places/held-calls-inbox.ts), the calls Jev decided that you can still
 * change, and everything already answered. An item's answers are its own keys
 * on the hint row (the daemon's, the same on every surface), each one the
 * capability that answers it, and they run on the press: the item is the
 * question. Enter lists them, starting on the one the ask opens on (No, for
 * one that loosens a protection).
 *
 * Beside the inbox: the Telegram messages held for you (the daemon's delegated
 * intake, `inbound.telegram.list`, followed through its list notices), the
 * sends the content check refused in the Agent (that program's own, while
 * they wait), and what each kind of approval asks about.
 */
import type { PlaceAnswer, PlaceDetailLine } from './place-types.js';
import { definePlace, type PlaceItem } from './place-types.js';

interface InboxItem extends PlaceItem {
  /** `open`; `yours` for a request for approval this program raised and may still withdraw. */
  readonly state: 'open' | 'yours';
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
  readonly options: readonly string[];
  readonly askedBy?: string | undefined;
  readonly createdAt?: number | undefined;
  readonly expiresAt?: number | undefined;
  /** The daemon's words for its choices and their keys (permissions/ask-presentation.ts); `default` is the one the ask opens on. */
  readonly choices: readonly { readonly key?: string | undefined; readonly label: string; readonly value?: string | undefined; readonly id: string; readonly default?: boolean | undefined }[];
  readonly consequence?: string | undefined;
  readonly why?: string | undefined;
  /** The ask loosens a protection (its presentation's `weakensSafety`, or a card that opens on No). */
  readonly loosens: boolean;
}

/** A call Jev decided: which choices it takes is its state (`decided`, `undo`, `rules`, `undo-rules`). */
interface DecisionItem extends PlaceItem {
  readonly title: string;
  readonly detail: string;
  readonly madeIn: string;
  readonly verdict: string;
  readonly createdAt?: number | undefined;
  readonly expiresAt?: number | undefined;
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
}

/** A send the content check refused in this program. */
interface SendItem extends PlaceItem {
  readonly title: string;
  readonly at?: number | undefined;
  readonly content: readonly { readonly field: string; readonly value: string }[];
}

/** What one kind of approval asks about. */
interface KindItem extends PlaceItem {
  readonly title: string;
  readonly check: string;
}

type Item = InboxItem | DecisionItem | ClosedItem | TelegramItem | SendItem | KindItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** Text an agent or a channel wrote is shown, never obeyed by the terminal. */
const plain = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const record = (value: unknown): Readonly<Record<string, unknown>> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function rawItems(output: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const items = record(output).items;
  return Array.isArray(items) ? items.map(record).filter((item) => text(item.id) !== '') : [];
}

function inboxItems(output: unknown, keep: (kind: string) => boolean): readonly InboxItem[] {
  return rawItems(output)
    .filter((item) => item.status === 'open' && keep(text(item.kind)))
    .map((item): InboxItem => {
      const presentation = record(item.presentation);
      const choices = Array.isArray(presentation.choices) ? presentation.choices as InboxItem['choices'] : [];
      const consequence = text(record(presentation.consequence).text);
      const reading = record(item.reading);
      const yours = record(reading.requester).mine === true && Array.isArray(reading.allowedActions) && reading.allowedActions.includes('cancel');
      return {
        id: text(item.id),
        state: yours ? 'yours' : 'open',
        kind: text(item.kind),
        title: plain(text(presentation.title) || text(item.title)),
        detail: plain(text(item.detail)),
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

function decisionItems(output: unknown): readonly DecisionItem[] {
  return rawItems(output)
    .filter((item) => item.status === 'open' && item.kind === 'decision')
    .map((item): DecisionItem => {
      const options = Array.isArray(item.options) ? item.options : [];
      const undo = options.includes('undo');
      const rules = options.includes('always');
      const metadata = record(item.metadata);
      return {
        id: text(item.id),
        state: undo && rules ? 'undo-rules' : undo ? 'undo' : rules ? 'rules' : 'decided',
        title: plain(text(item.title)),
        detail: plain(text(item.detail)),
        madeIn: programWords(text(metadata.surface)),
        verdict: text(metadata.verdict),
        createdAt: time(item.createdAt),
        expiresAt: time(item.expiresAt),
      };
    });
}

/** Who answered, as a person reads it: the owner's own credentials are "you"; anyone else by the name the daemon keeps. */
function answererWords(actor: string): string {
  if (!actor || ['owner', 'shared-token', 'operator', 'local', 'local-owner'].includes(actor)) return 'you';
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
        ...(text(by.surface) ? { answeredBy: `${answererWords(text(by.actor))}, from ${surfaceWords(text(by.surface))}` } : {}),
        ...(where ? { delivery: `${where}${text(delivery.reason) ? `: ${plain(text(delivery.reason))}` : ''}` } : {}),
        ...(text(item.withdrawnReason) ? { withdrawn: plain(text(item.withdrawnReason)) } : {}),
        ...(text(item.askedBy) ? { askedBy: plain(text(item.askedBy)) } : {}),
        createdAt: time(item.createdAt),
        closedAt: time(item.closedAt),
      };
    });
}

const REVIEW_ID_PREFIX = 'external-review-';
const SHORT = 8;

function telegramItems(output: unknown): readonly TelegramItem[] {
  const list = record(output);
  const pending = Array.isArray(list.pending) ? list.pending.map(record) : [];
  const records = Array.isArray(list.records) ? list.records.map(record) : [];
  const shown: TelegramItem[] = [];
  for (const entry of pending) {
    const id = text(entry.approvalId).slice(0, SHORT);
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
    shown.push({
      id, state: entry.state === 'reviewed' ? 'read' : 'in review',
      title: accepted !== undefined ? `A message you accepted ${new Date(accepted).toLocaleString()}` : 'A message you accepted',
      ...(text(entry.configurationId) ? { configurationId: text(entry.configurationId) } : {}),
      sourceExpiresAt: time(entry.sourceExpiresAt),
      recordExpiresAt: time(entry.recordExpiresAt),
      acceptedAt: accepted,
    });
  }
  return shown;
}

function sendItems(raw: unknown): readonly SendItem[] {
  const sends = Array.isArray(raw) ? raw.map(record) : [];
  return sends.flatMap((send): SendItem[] => {
    const id = typeof send.id === 'number' ? String(send.id) : text(send.id);
    if (!id) return [];
    const content = Object.entries(record(send.content)).flatMap(([field, value]) => typeof value === 'string' ? [{ field, value: plain(value) }] : []);
    return [{ id, state: 'waiting', title: plain(text(send.description)) || 'A refused send', at: time(send.at), content }];
  });
}

function kindItems(raw: unknown): readonly KindItem[] {
  return (Array.isArray(raw) ? raw.map(record) : []).flatMap((kind): KindItem[] => text(kind.value)
    ? [{ id: text(kind.value), state: 'kind', title: plain(text(kind.label)), check: plain(text(kind.help)) }] : []);
}
/** The answers that say no: the refusing one an ask that loosens a protection opens on. */
const REFUSING = new Set(['deny', 'dismiss', 'stop', 'decline', 'no', 'never']);

/**
 * The keys for an item's answers: the daemon's own key for a choice where it
 * gives one (y, n, 1..8), y and n for approve and deny, else 1, 2, ... The
 * one the daemon's card opens on (`default`) is the one the list opens on.
 */
function answers(item: InboxItem): readonly PlaceAnswer[] {
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

/** The inbox's frames: an item posted, answered, withdrawn or delivered, and the approval broker's. */
const INBOX_EVENTS = { domains: ['gate'], events: ['owner-inbox-update', 'approval-update'] } as const;
/** Every open item: the open lists keep their kinds (one read for the three). */
const OPEN = { status: 'open' } as const;

const KIND_WORDS: Readonly<Record<string, string>> = {
  question: 'a question', claim: 'a claim', purchase: 'a purchase window', 'queued-action': 'a queued action', report: 'a report', approval: 'an approval',
  decision: 'a decision',
};

function when(ms: number | undefined): string {
  return ms === undefined ? 'not said' : new Date(ms).toLocaleString();
}

const inboxDetail = (item: InboxItem): PlaceDetailLine[] => [
  { label: 'What it is', text: KIND_WORDS[item.kind] ?? item.kind },
  ...(item.askedBy ? [{ label: 'Asked by', text: item.askedBy }] : []),
  { label: 'Asked', text: when(item.createdAt) },
  ...(item.expiresAt !== undefined ? [{ label: 'Waits until', text: when(item.expiresAt), tone: 'warning' as const }] : []),
  ...(item.state === 'yours' ? [{ label: 'Raised by', text: 'you, here: you can withdraw it' }] : []),
  ...(item.consequence ? [{ text: '' }, { label: 'What answering does', text: item.consequence }] : []),
  ...(item.detail ? [{ text: '' }, { text: item.detail }] : []),
  ...(item.why ? [{ text: '' }, { label: 'Why you are asked', text: item.why, tone: 'muted' as const }] : []),
  ...(item.options.length === 0 ? [{ text: '' }, { text: 'It takes an answer in your own words.', tone: 'muted' as const }] : []),
];

export const WAITING_PLACE = definePlace<Item>({
  id: 'waiting',
  group: 'waiting',
  title: 'Waiting for you',
  lists: [
    {
      id: 'questions',
      label: 'Questions',
      noun: 'what waits on you',
      // The three open lists are one read of the inbox (the same method and input are read once per refresh).
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, (kind) => kind !== 'approval' && kind !== 'decision' && kind !== 'queued-action') },
      follows: INBOX_EVENTS,
      empty: 'Nothing is waiting on you.',
      // The tab says these are questions: only another kind (a claim, a purchase window) names itself on its row.
      row: (item) => {
        const inbox = item as InboxItem;
        return { title: inbox.title, ...(inbox.kind !== 'question' ? { right: KIND_WORDS[inbox.kind] ?? inbox.kind } : {}), mark: 'waiting' };
      },
      detail: (item) => inboxDetail(item as InboxItem),
    },
    {
      id: 'approvals',
      label: 'Approvals',
      noun: 'the approvals waiting on you',
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, (kind) => kind === 'approval') },
      follows: INBOX_EVENTS,
      empty: 'No approval is waiting on you.',
      row: (item) => {
        const inbox = item as InboxItem;
        return { title: inbox.title, right: inbox.state === 'yours' ? 'raised by you' : inbox.askedBy ?? 'an approval', mark: 'waiting' };
      },
      detail: (item) => inboxDetail(item as InboxItem),
    },
    {
      id: 'held',
      label: 'Held calls',
      noun: 'the calls held for you',
      // Held by any gate (the daemon's, or a terminal program's: places/held-calls-inbox.ts): queued actions in the inbox.
      source: { kind: 'daemon', method: 'inbox.list', input: OPEN, items: (output) => inboxItems(output, (kind) => kind === 'queued-action') },
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
            text: decision.madeIn === 'the daemon' ? 'A choice on it is carried out by the daemon.' : `A choice on it is carried out in ${decision.madeIn}, while the session that made it is open.`,
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
      row: (item) => ({ title: (item as TelegramItem).title, right: item.state, mark: item.state === 'waiting' ? 'waiting' : item.state === 'read' ? 'ok' : 'paused' }),
      detail: (item) => {
        const message = item as TelegramItem;
        return [
          { label: 'Where it stands', text: message.state === 'waiting' ? 'waiting for your decision' : message.state === 'read' ? 'in the review queue, read' : 'in the review queue, not read yet' },
          ...(message.acceptedAt !== undefined ? [{ label: 'Accepted', text: when(message.acceptedAt) }] : []),
          ...(message.sourceExpiresAt !== undefined ? [{ label: 'Original kept until', text: when(message.sourceExpiresAt), tone: 'warning' as const }] : []),
          ...(message.recordExpiresAt !== undefined ? [{ label: 'Review kept until', text: when(message.recordExpiresAt) }] : []),
          { text: '' },
          { text: message.state === 'waiting' ? 'Nothing in it is run: accepting puts it in your review queue to read.' : 'Nothing in it is run.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'sends',
      label: 'Sends',
      noun: 'the sends waiting for your approval',
      // The Agent's own: the sends its content check refused, kept for five minutes (agent-turn/outward-approvals.ts).
      source: { kind: 'session', name: 'held-sends', items: sendItems },
      empty: 'No send is waiting for your approval.',
      row: (item) => ({ title: (item as SendItem).title, mark: 'paused' }),
      detail: (item) => {
        const send = item as SendItem;
        return [
          ...(send.at !== undefined ? [{ label: 'Refused', text: when(send.at) }] : []),
          { text: '' },
          ...send.content.map((field) => ({ label: field.field, text: field.value })),
          { text: '' },
          { text: 'It goes out exactly as shown only when you approve it; a refused send waits five minutes.', tone: 'muted' as const },
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
      empty: 'No kind of approval is described.',
      row: (item) => ({ title: (item as KindItem).title }),
      detail: (item) => [{ label: 'What it asks about, and what to check before you answer', text: (item as KindItem).check }],
    },
  ],
  actions: [
    // An item's answers are its own keys, and answering the item never asks again (answersItem).
    { key: 'a', list: 'questions', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answers(item as InboxItem) },
    { key: 'w', id: 'answer-in-words', list: 'questions', capability: 'questions.answer', label: 'answer in words', fill: { item: 'id' }, answersItem: true },
    { key: 'a', list: 'approvals', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answers(item as InboxItem) },
    // Withdrawing a request you raised is not an answer to it: it cannot be undone, so it asks first.
    { key: 'x', id: 'withdraw', list: 'approvals', states: ['yours'], capability: 'questions.withdraw', label: 'withdraw', fill: { request: 'id' } },
    { key: 'a', list: 'held', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answers(item as InboxItem) },
    // A choice on a decision is its answer (it never asks again); which choices it takes is its state.
    { key: 'k', id: 'keep', list: 'decisions', capability: 'decisions.keep', label: 'keep', fill: { decision: 'id' }, answersItem: true },
    { key: 'u', id: 'undo', list: 'decisions', states: ['undo', 'undo-rules'], capability: 'decisions.undo', label: 'undo', fill: { decision: 'id' }, answersItem: true },
    { key: 'n', id: 'never', list: 'decisions', states: ['rules', 'undo-rules'], capability: 'decisions.never', label: 'never', fill: { decision: 'id' }, answersItem: true },
    { key: 'a', id: 'always', list: 'decisions', states: ['rules', 'undo-rules'], capability: 'decisions.always', label: 'always', fill: { decision: 'id' }, answersItem: true },
    { key: 's', id: 'ask-me', list: 'decisions', states: ['rules', 'undo-rules'], capability: 'decisions.ask', label: 'ask me', fill: { decision: 'id' }, answersItem: true },
    // Telegram: a held message is accepted for review or refused; one in the queue is read, closed, or its chat let go.
    { key: 'h', id: 'hold-a-chat', list: 'telegram', whole: true, capability: 'telegram.configure', label: 'hold a chat' },
    { key: 'y', id: 'accept-message', list: 'telegram', states: ['waiting'], capability: 'telegram.approve', label: 'accept for review', fill: { message: 'id' } },
    { key: 'n', id: 'refuse-message', list: 'telegram', states: ['waiting'], capability: 'telegram.deny', label: 'refuse', fill: { message: 'id' } },
    { key: 'i', id: 'where-it-stands', list: 'telegram', capability: 'telegram.status', label: 'where it stands', fill: { message: 'id' } },
    { key: 'o', id: 'read-message', list: 'telegram', states: ['in review', 'read'], capability: 'telegram.read', label: 'read it', fill: { message: 'id' } },
    { key: 'c', id: 'close-review', list: 'telegram', states: ['in review', 'read'], capability: 'telegram.cancel', label: 'close', fill: { message: 'id' } },
    { key: 'x', id: 'stop-holding', list: 'telegram', states: ['in review', 'read'], capability: 'telegram.revoke', label: 'hold no new messages', fill: { configuration: (item) => (item as TelegramItem).configurationId ?? '' } },
    { key: 'b', id: 'hand-back', list: 'telegram', states: ['in review', 'read'], capability: 'telegram.release', label: 'hand the chat back', fill: { chat: (item) => (item as TelegramItem).configurationId ?? '' } },
  ],
  count: (lists) => {
    const telegram = (lists.telegram ?? []).filter((item) => item.state === 'waiting').length;
    const count = (lists.questions?.length ?? 0) + (lists.approvals?.length ?? 0) + (lists.held?.length ?? 0) + telegram + (lists.sends?.length ?? 0);
    return count > 0 ? { count, words: `${count} waiting`, tone: 'waiting' } : undefined;
  },
});
