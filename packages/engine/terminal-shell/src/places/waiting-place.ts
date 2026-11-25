/**
 * waiting-place.ts, the Waiting for you place: what waits on your answer.
 *
 * Everything here is the daemon's one owner inbox (`inbox.list`), followed
 * through its `owner-inbox-update` and `approval-update` events, so an item
 * answered, withdrawn or expired from the web UI, a phone or another terminal
 * leaves this list with no key pressed: questions (agents' questions, channel
 * claims, purchase windows, reports), approvals, and held calls (the calls a
 * gate held for you, which each terminal program posts to the same inbox as
 * the daemon does: places/held-calls-inbox.ts). An item's answers are its own
 * keys on the hint row (the daemon's, the same on every surface), each one the
 * capability that answers it, and they run on the press: the item is the
 * question. Enter lists them, starting on the one the ask opens on (No, for
 * one that loosens a protection).
 */
import type { PlaceAnswer } from './place-types.js';
import { definePlace, type PlaceItem } from './place-types.js';

interface InboxItem extends PlaceItem {
  readonly state: 'open';
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

type Item = InboxItem;

const text = (value: unknown): string => typeof value === 'string' ? value : '';
const time = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** Text an agent or a channel wrote is shown, never obeyed by the terminal. */
const plain = (value: string): string => value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function inboxItems(output: unknown, keep: (kind: string) => boolean): readonly InboxItem[] {
  const body = (output && typeof output === 'object' ? output : {}) as { readonly items?: unknown };
  const items = Array.isArray(body.items) ? body.items as Array<Readonly<Record<string, unknown>>> : [];
  return items
    .filter((item) => text(item.id) && item.status === 'open' && keep(text(item.kind)))
    .map((item): InboxItem => {
      const presentation = (item.presentation && typeof item.presentation === 'object' ? item.presentation : {}) as Readonly<Record<string, unknown>>;
      const choices = Array.isArray(presentation.choices) ? presentation.choices as InboxItem['choices'] : [];
      const consequence = presentation.consequence && typeof presentation.consequence === 'object' ? text((presentation.consequence as { text?: unknown }).text) : '';
      return {
        id: text(item.id),
        state: 'open',
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

/** The answers that say no: the refusing one an ask that loosens a protection opens on. */
const REFUSING = new Set(['deny', 'dismiss', 'stop', 'decline', 'no', 'never']);

/**
 * The keys for an item's answers: the daemon's own key for a choice where it
 * gives one (y, n, 1..8), y and n for approve and deny, else 1, 2, ... The
 * one the daemon's card opens on (`default`) is the one the list opens on.
 */
function answers(item: InboxItem): readonly PlaceAnswer[] {
  const used = new Set<string>(['r', 'w']);
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
/** Every open item: each list keeps its kinds. */
const OPEN = { status: 'open' } as const;

const KIND_WORDS: Readonly<Record<string, string>> = {
  question: 'a question', claim: 'a claim', purchase: 'a purchase window', 'queued-action': 'a queued action', report: 'a report', approval: 'an approval',
};

function when(ms: number | undefined): string {
  return ms === undefined ? 'not said' : new Date(ms).toLocaleString();
}

const inboxDetail = (item: InboxItem) => [
  { label: 'What it is', text: KIND_WORDS[item.kind] ?? item.kind },
  ...(item.askedBy ? [{ label: 'Asked by', text: item.askedBy }] : []),
  { label: 'Asked', text: when(item.createdAt) },
  ...(item.expiresAt !== undefined ? [{ label: 'Waits until', text: when(item.expiresAt), tone: 'warning' as const }] : []),
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
      // The three lists are one read of the inbox (the same method and input are read once per refresh).
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
      row: (item) => ({ title: (item as InboxItem).title, right: (item as InboxItem).askedBy ?? 'an approval', mark: 'waiting' }),
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
  ],
  actions: [
    // An item's answers are its own keys, and answering the item never asks again (answersItem).
    { key: 'a', list: 'questions', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answers(item as InboxItem) },
    { key: 'w', list: 'questions', capability: 'questions.answer', label: 'answer in words', fill: { item: 'id' }, answersItem: true },
    { key: 'a', list: 'approvals', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answers(item as InboxItem) },
    { key: 'a', list: 'held', capability: 'questions.answer', fill: { item: 'id' }, answers: (item) => answers(item as InboxItem) },
  ],
  count: (lists) => {
    const count = (lists.questions?.length ?? 0) + (lists.approvals?.length ?? 0) + (lists.held?.length ?? 0);
    return count > 0 ? { count, words: `${count} waiting`, tone: 'waiting' } : undefined;
  },
});
