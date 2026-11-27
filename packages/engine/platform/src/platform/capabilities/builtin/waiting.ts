/**
 * Waiting for you: what waits on the owner's answer, in the one owner inbox
 * (`~/.goodvibes/shared/owner-inbox.sqlite`, the daemon's `inbox.*`), and what
 * was decided for them.
 *
 * Home `daemon` (the inbox is the daemon's, one store for every program):
 * seeing what waits, everything ever asked, one item in full, answering one,
 * withdrawing a request for approval the caller raised, the calls Jev decided, and
 * what each kind of approval asks about. An answer and a withdrawal run
 * through the daemon's own methods (`inbox.answer`, `approvals.cancel`) as the
 * same caller, so a purchase window keeps the authority it is answered under
 * and an approval is decided at the revision shown.
 *
 * Home `session` (held by the program whose gate made them): a choice on a
 * call Jev decided (it is carried out where the decision was made: keep, or
 * never, always and ask, which save a standing rule), and
 * the calls just-vibes held in this program's session.
 *
 * The sends the Agent's content check refused are in the inbox too (posted by
 * the Agent, answered there): seeing them is the daemon's `google.waiting`.
 */
import { formatRefusal } from '@goodvibes/engine/errors';
import { currentRecordReach } from '@goodvibes/engine/daemon-api';
import {
  listEveryOwnerItem, type OwnerAnswerDelivery, type OwnerAnswerOutcome, type OwnerInboxPort, type OwnerItem,
} from '../../control-plane/owner-inbox.js';
import { HELD_SEND_METADATA, processHeldForOwner } from '../../permissions/held-for-owner.js';
import { JEV_DECISION_CHOICES } from '../../permissions/jev-decisions.js';
import { CapabilityRefusal, type CapabilityDefinition, type CapabilityResult, type FixedChoice, type InputDescription, type ListName } from '../types.js';

/** What the daemon's inbox capabilities read: its one owner inbox. */
export interface WaitingCapabilityServices {
  /** The daemon's owner inbox; absent in a daemon that keeps none. */
  readonly ownerInbox?: Pick<OwnerInboxPort, 'list' | 'find'> | undefined;
}

/** What a choice on a decision needs: the program's own inbox, which carries out a choice on a decision its gate made. */
export interface DecisionsCapabilityServices {
  readonly ownerInbox?: Pick<OwnerInboxPort, 'list' | 'find' | 'answer'> | undefined;
}

/** The live lists the inputs choose from (registered in terminal-shell's waiting-lists.ts). */
export const OPEN_INBOX_LIST = 'inbox.open' as ListName;
export const ALL_INBOX_LIST = 'inbox.all' as ListName;
export const MY_REQUESTS_LIST = 'inbox.my-requests' as ListName;
export const OPEN_DECISIONS_LIST = 'inbox.decisions' as ListName;
export const HELD_CALLS_LIST = 'held-calls' as ListName;

const SHORT_ID_CHARS = 14;
const DECISIONS_LIMIT = 30;
const DAY_MS = 86_400_000;
const DURATION_UNITS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };
const PLACE = 'Waiting for you';

/** Text an agent or a channel wrote, shown and never obeyed: no control characters. */
export function plainInboxText(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** An item as every surface names it: its ask's words where the daemon worded it ("Let it run: ...?"), else its own title. */
function titleOf(item: Pick<OwnerItem, 'title' | 'presentation'>): string {
  return plainInboxText(item.presentation?.title || item.title);
}

export function shortInboxId(id: string): string {
  return id.length > SHORT_ID_CHARS ? id.slice(0, SHORT_ID_CHARS) : id;
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

function answerText(item: OwnerItem): string {
  const parts = [item.answer?.option, item.answer?.text].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.length > 0 ? plainInboxText(parts.join(': ')) : '';
}

/** Where an answer is: with its asker, waiting for the asking session, or unable to reach it. */
export function formatInboxDelivery(delivery: OwnerAnswerDelivery): string {
  const to = plainInboxText(delivery.to);
  if (delivery.state === 'delivered') return `delivered to ${to}`;
  if (delivery.state === 'waiting') return `waiting for ${to}`;
  return `not deliverable to ${to}${delivery.reason ? `: ${plainInboxText(delivery.reason)}` : ''}`;
}

/** What the owner is told about an answer they just gave. */
function deliveryNotice(delivery: OwnerAnswerDelivery | undefined): string {
  if (delivery === undefined) return '';
  const to = plainInboxText(delivery.to);
  if (delivery.state === 'delivered') return ` Sent to ${to}.`;
  if (delivery.state === 'waiting') return ` ${delivery.reason ? plainInboxText(delivery.reason) : `Saved; it will be delivered when ${to} is next opened.`}`;
  return ` Saved, not deliverable to ${to}: ${delivery.reason ? plainInboxText(delivery.reason) : 'it cannot be opened again.'}`;
}

/** One line for a list. */
export function formatOwnerItemLine(item: OwnerItem): string {
  const choices = item.status === 'open'
    ? item.options.length > 0 ? ` [${item.options.join(' | ')}]` : ' [written answer]'
    : '';
  const closed = item.status === 'answered'
    ? ` -> ${answerText(item)}${item.answeredBy ? ` (${plainInboxText(item.answeredBy.actor)}, ${plainInboxText(item.answeredBy.surface)})` : ''}`
      + (item.delivery ? ` [${formatInboxDelivery(item.delivery)}]` : '')
    : item.status === 'open' ? '' : ` (${item.status}${item.withdrawnReason ? `: ${plainInboxText(item.withdrawnReason)}` : ''})`;
  return `${shortInboxId(item.id)}  ${item.kind}  ${titleOf(item)}${choices}${closed}`;
}

/** Everything about one item. */
export function formatOwnerItemDetail(item: OwnerItem): string {
  const lines = [
    `${item.kind} ${item.id} · ${item.status}`,
    titleOf(item),
    ...(item.detail ? ['', plainInboxText(item.detail), ''] : []),
    ...(item.askedBy ? [`Asked by: ${plainInboxText(item.askedBy)}`] : []),
    `Asked: ${when(item.createdAt)}`,
    ...(item.expiresAt !== undefined ? [`${item.status === 'open' ? 'Expires' : 'Expired'}: ${when(item.expiresAt)}`] : []),
  ];
  if (item.status === 'open') {
    // A report is a notice: it needs no answer, only to be marked read.
    lines.push(item.kind === 'report' ? 'A notice: it needs no answer; mark it read once you have seen it.'
      : item.options.length > 0 ? `Its answers: ${item.options.join(', ')}.` : 'It takes an answer in your own words.');
  } else if (item.status === 'answered') {
    lines.push(`Answered: ${answerText(item)}${item.answeredBy ? ` by ${plainInboxText(item.answeredBy.actor)} from ${plainInboxText(item.answeredBy.surface)}` : ''}${item.closedAt ? ` at ${when(item.closedAt)}` : ''}`);
    if (item.delivery) {
      lines.push(`Delivery: ${formatInboxDelivery(item.delivery)}`);
      if (item.delivery.state === 'waiting' && item.delivery.reason) lines.push(plainInboxText(item.delivery.reason));
    }
  } else if (item.withdrawnReason) {
    lines.push(`Withdrawn: ${plainInboxText(item.withdrawnReason)}`);
  }
  return lines.join('\n');
}

/** The facts a screen or a script reads about an item (never more than the inbox itself says). */
function itemData(item: OwnerItem): Readonly<Record<string, unknown>> {
  return {
    id: item.id, kind: item.kind, status: item.status, title: titleOf(item), options: item.options,
    createdAt: item.createdAt,
    ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
    ...(item.askedBy ? { askedBy: plainInboxText(item.askedBy) } : {}),
    ...(item.answer ? { answer: answerText(item) } : {}),
    ...(item.closedAt !== undefined ? { closedAt: item.closedAt } : {}),
  };
}

/** An exact id, or a prefix that names exactly one item among `items`. */
function resolveId(raw: string, items: readonly OwnerItem[]): { id: string } | { error: string } {
  const exact = items.find((item) => item.id === raw);
  if (exact) return { id: exact.id };
  const matches = items.filter((item) => item.id.startsWith(raw));
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return { error: `No inbox item starts with "${raw}".` };
  return { error: `"${raw}" matches ${matches.length} items (${matches.slice(0, 4).map((item) => shortInboxId(item.id)).join(', ')}); give more of the id.` };
}

function inboxOf(services: { readonly ownerInbox?: Pick<OwnerInboxPort, 'list' | 'find'> | undefined }): Pick<OwnerInboxPort, 'list' | 'find'> {
  if (!services.ownerInbox) throw new CapabilityRefusal('This daemon keeps no owner inbox, so there is nothing to read or answer here.');
  return services.ownerInbox;
}

async function findItem(inbox: Pick<OwnerInboxPort, 'list' | 'find'>, raw: string, status: 'open' | 'all', kinds?: OwnerItem['kind'][]): Promise<OwnerItem> {
  const wanted = raw.trim();
  const direct = await inbox.find(wanted);
  if (direct && (!kinds || kinds.includes(direct.kind))) return direct;
  const resolved = resolveId(wanted, await listEveryOwnerItem(inbox, { status, ...(kinds ? { kinds } : {}) }));
  if ('error' in resolved) throw new CapabilityRefusal(resolved.error, `${PLACE} lists what waits on you.`, 'NOT_FOUND');
  const item = await inbox.find(resolved.id);
  if (!item) throw new CapabilityRefusal(`${shortInboxId(resolved.id)} is no longer in the inbox.`, undefined, 'NOT_FOUND');
  return item;
}

/** Run a daemon method as the caller, or say that only the daemon's own dispatch can. */
function methodOf(caller: { readonly method?: ((methodId: string, body: Record<string, unknown>) => Promise<unknown>) | undefined }) {
  if (!caller.method) throw new CapabilityRefusal('This runs only in the daemon, through capabilities.run; nothing was done.');
  return caller.method;
}

// ---------------------------------------------------------------------------
// The kinds of approval

/** What each kind of approval asks about, the same words in every program. */
export const APPROVAL_KINDS: readonly FixedChoice[] = [
  { value: 'shell', label: 'Running a command', help: 'What the command changes, and whether it reads a credential.' },
  { value: 'file', label: 'Changing a file', help: 'Which file, and whether it is a settings file or a notebook.' },
  { value: 'network', label: 'Reaching the network', help: 'Which host, and how much of it.' },
  { value: 'delegate', label: 'Starting agents or handing work on', help: 'How many agents, and how deep they may start more.' },
  { value: 'mcp', label: 'Trusting a connected tool server more', help: 'Which server, and which hosts and paths it may then reach.' },
  { value: 'remote', label: 'Sending work to another machine', help: 'Which machine, how far it is trusted, and what comes back.' },
  { value: 'hook', label: 'Running a hook', help: 'Whether the hook may refuse or change what it sees.' },
  { value: 'plugin', label: 'Installing or switching on a plugin', help: 'Where it came from, and what it may do.' },
  { value: 'sandbox', label: 'Changing how commands are contained', help: 'Which isolation, and what leaves it.' },
];

export const APPROVAL_KINDS_CAPABILITY: CapabilityDefinition<unknown> = {
  capability: { id: 'approval.kinds', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'kinds', label: 'See the kinds of approval', word: 'kinds',
  inputs: [{
    id: 'kind', label: 'Kind', help: 'One kind only', kind: 'choice', choices: APPROVAL_KINDS,
    required: { default: '', defaultMeans: 'every kind' }, typed: { position: 1 },
  }],
  sentence: 'Shows what each kind of approval asks about {kind}, and what to check before you answer one.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { kind: 'shell' },
  async run(values) {
    const kinds = values.kind ? APPROVAL_KINDS.filter((kind) => kind.value === values.kind) : APPROVAL_KINDS;
    return {
      text: [
        'Kinds of approval',
        ...kinds.map((kind) => `  ${kind.label} (${kind.value}): ${kind.help ?? ''}`),
        '',
        `One that waits on you is answered in ${PLACE}; rules that answer for you are kept under Permissions and safety.`,
      ].join('\n'),
      data: { kinds: kinds.map((kind) => ({ kind: kind.value, label: kind.label, check: kind.help ?? '' })) },
    };
  },
};

// ---------------------------------------------------------------------------
// What waits on you

const ITEM: InputDescription = {
  id: 'item', label: 'Question', help: 'What waits on you', kind: 'choice',
  choices: { list: OPEN_INBOX_LIST, allowOther: { reason: 'the id of an item already answered' } }, required: true, typed: { position: 1 },
};

/**
 * The inbox items the caller may reach (control-plane/caller-reach.ts): a question waiting for the owner as that
 * question (its project); every other item (an ask, a claim, a purchase window, a decision) is the owner's own: only
 * the owner sees it. The owner in person sees every one.
 */
function reachableItems<T extends Pick<OwnerItem, 'kind' | 'id'>>(items: readonly T[]): T[] {
  const reach = currentRecordReach();
  if (!reach) return [...items];
  return items.filter((item) => item.kind === 'approval' && reach('approval', item.id));
}

async function listed(services: WaitingCapabilityServices, status: 'open' | 'all'): Promise<CapabilityResult> {
  const items = reachableItems(await listEveryOwnerItem(inboxOf(services), { status }));
  const data = { items: items.map(itemData) };
  if (items.length === 0) return { text: status === 'open' ? 'Nothing is waiting on you.' : 'Nothing has been asked of you yet.', data };
  return {
    text: [status === 'open' ? `Waiting on you (${items.length}):` : `Everything asked of you (${items.length}, newest first):`, ...items.map((item) => `  ${formatOwnerItemLine(item)}`)].join('\n'),
    data,
  };
}

export const QUESTIONS_LIST: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'questions.list', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'See everything waiting for your answer', word: 'list', inputs: [],
  sentence: 'Lists what waits on you now: every open question, ask, claim and purchase window, with its answers.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  run: async (_values, services) => await listed(services, 'open'),
};

export const QUESTIONS_ALL: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'questions.all', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'all', label: 'See everything ever asked of you', word: 'all', inputs: [],
  sentence: 'Lists every inbox item, open or answered, newest first, with who answered and where the answer went.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  run: async (_values, services) => await listed(services, 'all'),
};

export const QUESTIONS_SHOW: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'questions.show', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'show', label: 'See one question in full', word: 'show',
  inputs: [{ id: 'item', label: 'Item', help: 'Everything in the inbox', kind: 'choice', choices: { list: ALL_INBOX_LIST }, required: true, typed: { position: 1 } }],
  sentence: 'Shows {item} in full: who asked, when, the answers it takes, and where an answer went.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { item: 'q-41a2' },
  async run(values, services) {
    const item = await findItem(inboxOf(services), values.item!, 'all');
    // The same words as for no item: another project's question is never said to exist.
    if (reachableItems([item]).length === 0) throw new CapabilityRefusal(`item: no question "${values.item!}" is among what this caller may reach (only what belongs to a project the owner gave it)`, undefined, 'RECORD_NOT_YOURS', 403);
    return { text: formatOwnerItemDetail(item), data: { item: itemData(item) } };
  },
};

/** The refusal an answer that was not recorded gives, in the inbox's words. */
function notApplied(outcome: OwnerAnswerOutcome): never {
  if (outcome.applied) throw new Error('unreachable');
  throw new CapabilityRefusal(formatRefusal(outcome.refusal), undefined, outcome.refusal.code);
}

export const QUESTIONS_ANSWER: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'questions.answer', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'answer', label: 'Answer a question left for you', word: 'answer',
  inputs: [ITEM, {
    id: 'answer', label: 'Answer', help: 'One of its answers, then a note if you like; or your written answer', kind: 'long-text',
    freeTextReason: 'your own words', required: true, typed: { tail: true },
  }],
  sentence: '{item} is answered "{answer}" and the answer goes to whoever asked it: the agent, the session or the channel.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
  ownerOnly: { reason: 'the owner\'s answer is the owner\'s', instead: `Ask the owner to answer it in ${PLACE}.` },
  example: { item: 'q-41a2', answer: 'approve' },
  async run(values, services, caller) {
    const call = methodOf(caller);
    const item = await findItem(inboxOf(services), values.item!, 'open');
    if (item.status !== 'open') throw new CapabilityRefusal(`"${titleOf(item)}" is ${item.status}${item.answer ? `: ${answerText(item)}` : ''}; nothing was answered.`, undefined, 'NOT_OPEN');
    const words = (values.answer ?? '').trim();
    if (!words) throw new CapabilityRefusal('An answer needs words: one of its answers, or your own.', undefined, 'INVALID_ARGUMENT');
    // With options, the choice is the longest one the answer starts with (a choice may be several words);
    // the rest, as written, is its note. With none matching, the first word is sent and refused by name.
    const lower = words.toLowerCase();
    const chosen = [...item.options].sort((a, b) => b.length - a.length)
      .find((option) => lower === option.toLowerCase() || lower.startsWith(`${option.toLowerCase()} `));
    const space = words.search(/\s/);
    const choice = chosen ?? (space < 0 ? words : words.slice(0, space));
    const note = words.slice(chosen ? chosen.length : choice.length).trim();
    // An approval is answered at the revision shown: one that moved meanwhile is refused with how it stands now.
    const shown = item.revision !== undefined ? { expectedRevision: item.revision } : {};
    const body = item.options.length > 0
      ? { itemId: item.id, option: choice, ...(note ? { text: note } : {}), ...shown }
      : { itemId: item.id, text: words, ...shown };
    const outcome = await call('inbox.answer', body) as OwnerAnswerOutcome;
    if (!outcome || typeof outcome !== 'object') throw new CapabilityRefusal('The inbox did not say whether the answer was recorded.');
    if (!outcome.applied) notApplied(outcome);
    const said = answerText(outcome.item).trimEnd();
    return {
      text: `Answered "${titleOf(item)}": ${said}${/[.!?]$/.test(said) ? '' : '.'}${deliveryNotice(outcome.delivery)}`,
      data: { item: itemData(outcome.item), ...(outcome.delivery ? { delivery: outcome.delivery } : {}) },
    };
  },
};

export const QUESTIONS_WITHDRAW: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'questions.withdraw', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'withdraw', label: 'Withdraw a request you raised', word: 'withdraw',
  inputs: [
    { id: 'request', label: 'Request', help: 'Requests for approval you raised that still wait', kind: 'choice', choices: { list: MY_REQUESTS_LIST, allowOther: { reason: 'the id of a request you raised' } }, required: true, typed: { position: 1 } },
    { id: 'note', label: 'Why', help: 'A note kept with it', kind: 'long-text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no note' }, typed: { tail: true } },
  ],
  sentence: 'Your request {request} stops waiting and is cancelled; nobody can approve it any more.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
  ownerOnly: { reason: 'withdrawing a request is the owner\'s act', instead: `Ask the owner to withdraw it in ${PLACE}.` },
  example: { request: 'apr-41a2' },
  async run(values, services, caller) {
    const call = methodOf(caller);
    const item = await findItem(inboxOf(services), values.request!, 'open', ['approval']);
    if (item.kind !== 'approval' || item.status !== 'open' || item.revision === undefined) {
      throw new CapabilityRefusal(`"${titleOf(item)}" is not a request for approval that still waits; nothing was withdrawn.`, undefined, 'NOT_OPEN');
    }
    const note = (values.note ?? '').trim();
    // Sent at the revision shown: a request that moved meanwhile is refused with how it stands now.
    const outcome = await call('approvals.cancel', { approvalId: item.id, expectedRevision: item.revision, ...(note ? { note } : {}) }) as { readonly applied?: boolean; readonly refusal?: { readonly reason?: string } };
    if (outcome?.applied !== true) throw new CapabilityRefusal(`Not withdrawn: ${outcome?.refusal?.reason ?? 'the daemon refused it'}. Nothing was changed.`, undefined, 'NOT_APPLIED');
    return { text: `Withdrew "${titleOf(item)}".`, data: { item: { ...itemData(item), status: 'withdrawn' } } };
  },
};

// ---------------------------------------------------------------------------
// What was decided for you

/** A period the decisions list names: from `from` (inclusive) to `to` (exclusive), in local time, and how it was named. */
interface DecisionWindow {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function parseDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date.getTime() : undefined;
}

const PERIOD_WORDS = 'today, yesterday, a day (2026-11-19), or since a day or 30m, 2h, 3d, 1w';

/** `today`, `yesterday`, a day, or `since <day | 30m | 2h | 3d | 1w>`; undefined for no period, a string for a wrong one. */
function decisionWindow(words: readonly string[], now: number): DecisionWindow | string | undefined {
  const first = (words[0] ?? '').toLowerCase();
  if (first === 'today') return { from: startOfDay(now), to: now + 1, label: 'today' };
  if (first === 'yesterday') {
    const today = startOfDay(now);
    return { from: startOfDay(today - 1), to: today, label: 'yesterday' };
  }
  const day = parseDay(first);
  if (day !== undefined) return { from: day, to: startOfDay(day + DAY_MS + 3_600_000), label: `on ${first}` };
  if (first !== 'since') return undefined;
  const value = (words[1] ?? '').toLowerCase();
  const since = parseDay(value);
  if (since !== undefined) return { from: since, to: now + 1, label: `since ${value}` };
  const duration = /^(\d+)([mhdw])$/.exec(value);
  if (duration) return { from: now - Number(duration[1]) * DURATION_UNITS[duration[2]!]!, to: now + 1, label: `in the last ${value}` };
  return `"since ${value}" is not a period: since takes a day (2026-11-19) or 30m, 2h, 3d, 1w.`;
}

export const DECISIONS_LIST: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'decisions.list', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'See what was decided for you', word: 'list',
  inputs: [
    { id: 'when', label: 'When', help: PERIOD_WORDS, kind: 'text', freeTextReason: 'a day or a time span', required: { default: '', defaultMeans: 'the latest' }, typed: { flag: '--when' } },
    { id: 'count', label: 'How many', help: 'How many of the latest to show', kind: 'number', freeTextReason: 'a number', required: { default: '', defaultMeans: String(DECISIONS_LIMIT) }, typed: { flag: '--count' } },
  ],
  sentence: 'Lists the calls Jev decided that you can still change, and what was decided, {when}.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { when: 'today' },
  async run(values, services) {
    const window = values.when ? decisionWindow(values.when.split(/\s+/), Date.now()) : undefined;
    if (typeof window === 'string') throw new CapabilityRefusal(window, undefined, 'INVALID_ARGUMENT');
    if (values.when && window === undefined) throw new CapabilityRefusal(`"${values.when}" is not a period: ${PERIOD_WORDS}.`, undefined, 'INVALID_ARGUMENT');
    const count = Number(values.count);
    // A period reads the whole inbox, a page at a time; a count reads as many as it asks, however far back.
    const limit = window !== undefined ? Number.POSITIVE_INFINITY : Number.isInteger(count) && count > 0 ? count : DECISIONS_LIMIT;
    const inbox = inboxOf(services);
    const [allOpen, allClosed] = await Promise.all([
      listEveryOwnerItem(inbox, { status: 'open', kinds: ['decision'] }),
      listEveryOwnerItem(inbox, { status: 'closed' }),
    ]);
    const inWindow = (at: number): boolean => window === undefined || (at >= window.from && at < window.to);
    // What the caller may reach, before the latest are cut (Jev's decisions are the owner's own: only the owner sees them).
    const open = reachableItems(allOpen).filter((item) => inWindow(item.createdAt)).slice(0, limit);
    const closed = reachableItems(allClosed).filter((item) => inWindow(item.closedAt ?? item.createdAt)).slice(0, limit);
    const data = { open: open.map(itemData), decided: closed.map(itemData) };
    if (open.length === 0 && closed.length === 0) return { text: window === undefined ? 'Nothing has been decided yet.' : `Nothing was decided ${window.label}.`, data };
    const period = window === undefined ? '' : ` ${window.label}`;
    return {
      text: [
        ...(open.length > 0 ? [
          `Jev decided${period}, and you can still change (${open.length}, newest first):`,
          ...open.map((item) => `  ${when(item.createdAt)}  ${formatOwnerItemLine(item)}`),
          '',
          'Each can be kept, or made a standing rule for calls like it (never, always, ask): decisions.keep, decisions.never, decisions.always, decisions.ask.',
          '',
        ] : []),
        ...(closed.length > 0 ? [`Decided${period} (${closed.length}, newest first):`, ...closed.map((item) => `  ${item.closedAt !== undefined ? `${when(item.closedAt)}  ` : ''}${formatOwnerItemLine(item)}`)] : []),
      ].join('\n').trimEnd(),
      data,
    };
  },
};

const DECISION: InputDescription = {
  id: 'decision', label: 'Decision', help: 'Calls Jev decided that you can still change', kind: 'choice',
  choices: { list: OPEN_DECISIONS_LIST }, required: true, typed: { position: 1 },
};

type DecisionWord = keyof typeof JEV_DECISION_CHOICES;

const DECISION_ACTIONS: readonly { readonly word: DecisionWord; readonly label: string; readonly sentence: string; readonly risk: 'none' | 'loosens-a-protection' }[] = [
  { word: 'keep', label: 'Leave a decision as Jev made it', sentence: '{decision} stays as Jev decided it, and nothing changes until you change it.', risk: 'none' },
  { word: 'never', label: 'Never allow calls like a decision\'s', sentence: 'Calls like the one in {decision} are refused from now on, until you change it.', risk: 'none' },
  { word: 'always', label: 'Always allow calls like a decision\'s without asking', sentence: 'Calls like the one in {decision} run without asking from now on, until you change it.', risk: 'loosens-a-protection' },
  { word: 'ask', label: 'Ask me every time about calls like a decision\'s', sentence: 'Calls like the one in {decision} are asked of you each time, before they run, from now on, until you change it.', risk: 'none' },
];

function decisionChoice(choice: (typeof DECISION_ACTIONS)[number]): CapabilityDefinition<DecisionsCapabilityServices> {
  return {
    // A decision is carried out by the program whose gate made it (its rule store, its ledger), so it runs there.
    capability: { id: `decisions.${choice.word}`, group: 'waiting', home: 'session', repeat: 'safe' },
    actionId: choice.word, label: choice.label, word: choice.word, inputs: [DECISION],
    sentence: choice.sentence, done: '',
    touches: 'this-machine', lasts: 'kept', risk: choice.risk,
    ownerOnly: { reason: 'what Jev decided for the owner is the owner\'s to change', instead: `Ask the owner to choose it in ${PLACE}.` },
    example: { decision: 'd-7c31' },
    async run(values, services) {
      const inbox = services.ownerInbox;
      if (!inbox) throw new CapabilityRefusal('This program has no owner inbox to change a decision in.');
      const raw = (values.decision ?? '').trim();
      const resolved = resolveId(raw, await listEveryOwnerItem(inbox, { status: 'open', kinds: ['decision'] }));
      if ('error' in resolved) {
        const closed = await inbox.find(raw);
        throw new CapabilityRefusal(closed?.kind === 'decision'
          ? `"${titleOf(closed)}" is ${closed.status}${closed.answer ? `: ${answerText(closed)}` : closed.withdrawnReason ? `: ${plainInboxText(closed.withdrawnReason)}` : ''}; a standing rule is set under Permissions and safety instead.`
          : `No open decision starts with "${raw}".`, undefined, 'NOT_FOUND');
      }
      const item = await inbox.find(resolved.id);
      const outcome = await inbox.answer(resolved.id, { option: choice.word });
      if (!outcome.applied) notApplied(outcome);
      const title = titleOf(item ?? outcome.item);
      return {
        text: `"${title}": ${outcome.item.answer?.text ? plainInboxText(outcome.item.answer.text) : `${choice.word}.`}`,
        data: { item: itemData(outcome.item) },
      };
    },
  };
}

export const [DECISIONS_KEEP, DECISIONS_NEVER, DECISIONS_ALWAYS, DECISIONS_ASK] = DECISION_ACTIONS.map(decisionChoice) as [
  CapabilityDefinition<DecisionsCapabilityServices>, CapabilityDefinition<DecisionsCapabilityServices>,
  CapabilityDefinition<DecisionsCapabilityServices>, CapabilityDefinition<DecisionsCapabilityServices>,
];

// ---------------------------------------------------------------------------
// The calls just-vibes held in this session

const CALLS: InputDescription = {
  id: 'calls', label: 'Held calls', help: 'The calls held for you; several ids separated by spaces, or all', kind: 'choice',
  choices: { list: HELD_CALLS_LIST, allowOther: { reason: 'several ids separated by spaces, or all' } }, required: true, typed: { tail: true },
};

export const HELD_LIST: CapabilityDefinition<unknown> = {
  capability: { id: 'held.list', group: 'waiting', home: 'session', repeat: 'safe' },
  actionId: 'list', label: 'See the calls held for you', word: 'list', inputs: [],
  sentence: 'Lists the calls just-vibes held instead of asking you, with why each was held.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run() {
    const held = processHeldForOwner().list();
    const data = { held: held.map((call) => ({ id: call.id, tool: plainInboxText(call.toolName), summary: plainInboxText(call.summary), reason: plainInboxText(call.reason) })) };
    if (held.length === 0) return { text: 'Nothing is held for you.', data };
    return {
      text: [
        `Held for you (${String(held.length)}, not run):`,
        ...held.map((call) => `  ${call.id}  ${plainInboxText(call.toolName)}: ${plainInboxText(call.summary)} (${plainInboxText(call.reason)})`),
        `Each waits in ${PLACE}, under Held calls, to be approved or set aside.`,
      ].join('\n'),
      data,
    };
  },
};

function heldAnswer(verb: 'approve' | 'dismiss'): CapabilityDefinition<unknown> {
  const approve = verb === 'approve';
  return {
    capability: { id: `held.${verb}`, group: 'waiting', home: 'session', repeat: 'safe' },
    actionId: verb, label: approve ? 'Approve a held call' : 'Set a held call aside', word: verb, inputs: [CALLS],
    sentence: approve ? '{calls} may run for this session only, when the work carries on.' : '{calls} is set aside and not run, for this session only; the model may make the call again.',
    done: '', touches: 'this-machine', lasts: 'session', risk: approve ? 'loosens-a-protection' : 'none',
    ownerOnly: { reason: 'the answer to a held call is the owner\'s', instead: `Ask the owner to ${approve ? 'approve it' : 'set it aside'} in ${PLACE}.` },
    example: { calls: 'h-1' },
    async run(values) {
      const ledger = processHeldForOwner();
      const wanted = (values.calls ?? '').split(/\s+/).map((arg) => arg.trim()).filter(Boolean);
      const ids = wanted.some((id) => id.toLowerCase() === 'all') ? 'all' as const : wanted;
      const done = approve ? ledger.approve(ids) : ledger.dismiss(ids);
      const missing = ids === 'all' ? [] : ids.filter((id) => !done.includes(id));
      if (done.length === 0) throw new CapabilityRefusal(`No held call ${ids === 'all' ? 'is waiting' : `has the id ${missing.map(plainInboxText).join(', ')}`}. Nothing was changed.`, undefined, 'NOT_FOUND');
      return {
        text: [
          approve
            ? `Approved ${done.join(', ')} for this session: ask to carry on and ${done.length === 1 ? 'it runs' : 'they run'} when made again.`
            : `Set aside ${done.join(', ')}; ${done.length === 1 ? 'it was' : 'they were'} not run.`,
          ...(missing.length > 0 ? [`Not held (already answered or unknown): ${missing.map(plainInboxText).join(', ')}.`] : []),
        ].join('\n'),
        data: { done, missing },
      };
    },
  };
}

export const HELD_APPROVE = heldAnswer('approve');
export const HELD_DISMISS = heldAnswer('dismiss');

// ---------------------------------------------------------------------------
// The sends the content check refused

/** Whether an inbox item is a send the Agent's content check refused (posted by terminal-shell places/held-sends-inbox.ts). */
export function isHeldSend(item: Pick<OwnerItem, 'kind' | 'metadata'>): boolean {
  return item.kind === 'queued-action' && item.metadata?.[HELD_SEND_METADATA] === true;
}

/**
 * The sends the Agent's content check refused, from the owner inbox, where the Agent posts each one with exactly
 * what would go out: every program, the web UI and a phone show them, and the answer there sends or drops it.
 */
export const GOOGLE_WAITING: CapabilityDefinition<WaitingCapabilityServices> = {
  capability: { id: 'google.waiting', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'waiting', label: 'See the refused emails and invitations waiting for you', word: 'waiting', inputs: [],
  sentence: 'Shows each email or calendar invitation the content check refused to send, exactly as it would go out, waiting for you to send it or drop it.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, services) {
    const sends = (await listEveryOwnerItem(inboxOf(services), { status: 'open', kinds: ['queued-action'] })).filter(isHeldSend);
    const data = { sends: sends.map((send) => ({ ...itemData(send), detail: plainInboxText(send.detail) })) };
    if (sends.length === 0) return { text: 'No send is waiting for your approval. A refused send waits five minutes.', data };
    return {
      text: [
        `Refused by the content check, waiting for you to send it as shown or drop it, in ${PLACE} under Sends (${sends.length}):`,
        ...sends.flatMap((send) => [`  ${shortInboxId(send.id)}  ${titleOf(send)}`, ...plainInboxText(send.detail).split('\n').map((line) => `       ${line}`)]),
      ].join('\n'),
      data,
    };
  },
};
