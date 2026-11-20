/**
 * /questions and /decisions: the owner inbox in a terminal.
 *
 * `/questions` lists what waits on the owner (permission asks, questions agents
 * left, channel claims, purchase windows, queued actions) and answers one.
 * `/decisions` lists what was decided for the owner: the calls Jev decided at
 * the permission gate, which he can still undo (the files the call changed),
 * turn into a standing rule (never, always, always ask me) or keep; and every
 * answered item, by whom and from where, with whether an answer reached the
 * agent or session that asked, waits for that session, or cannot reach it.
 *
 * The products supply where the inbox is (the home's one store, through the
 * daemon's inbox.* verbs while a daemon is reachable and directly otherwise)
 * and who is typing. A command the model runs may read the inbox but never
 * answers it: the owner's answer is the owner's.
 */
import { formatRefusal } from '@goodvibes/engine/errors';
import { listEveryOwnerItem } from '@goodvibes/engine/platform/platform/control-plane';
import type { OwnerAnswerDelivery, OwnerInboxPort, OwnerItem } from '@goodvibes/engine/platform/platform/control-plane';
import type { OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import type { TerminalCommandRegistry } from './command-registry.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, InputDescription } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { JEV_DECISION_CHOICES } from '@goodvibes/engine/platform/platform/permissions';

export interface OwnerInboxCommandContext extends CommandActionContext {
  readonly renderRequest: () => void;
}

export interface OwnerInboxCommandPolicy<Context> {
  /** The inbox this terminal reads, or the reason there is none right now. */
  readonly inbox: (context: Context) => OwnerInboxPort | { readonly unavailable: string };
  /** True only when the owner typed `command` at this terminal. */
  readonly isOwner: (context: Context, command: string) => boolean;
  /** Withdraw a request for approval this owner raised, at the revision shown (`approvals.cancel` on the daemon). */
  readonly withdraw: (context: Context, input: OperatorMethodInput<'approvals.cancel'>) => Promise<OperatorMethodOutput<'approvals.cancel'>>;
}

const SHORT_ID_CHARS = 14;
const DECISIONS_LIMIT = 30;

/** Display-only: strip terminal control sequences from text an agent or a channel wrote. */
function text(value: string): string {
  return stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

export function shortId(id: string): string {
  return id.length > SHORT_ID_CHARS ? id.slice(0, SHORT_ID_CHARS) : id;
}

/** A period `/decisions` shows: from `from` (inclusive) to `to` (exclusive), in local time, and how it was named. */
interface DecisionWindow {
  readonly from: number;
  readonly to: number;
  readonly label: string;
}

const DAY_MS = 86_400_000;
const DURATION_UNITS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };

/** Local midnight of the day `ms` falls on. */
function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `YYYY-MM-DD` as local midnight, or undefined. */
function parseDay(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date.getTime() : undefined;
}

/**
 * The period a `/decisions` line names: `today`, `yesterday`, a day
 * (`2026-11-19`), or `since <day | 30m | 2h | 3d | 1w>`. Undefined when the
 * words name no period; a string when they name one wrongly.
 */
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
  return 'Usage: /decisions since <YYYY-MM-DD | 30m | 2h | 3d | 1w>';
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

function answerText(item: OwnerItem): string {
  const parts = [item.answer?.option, item.answer?.text].filter((part): part is string => typeof part === 'string' && part.length > 0);
  return parts.length > 0 ? text(parts.join(': ')) : '';
}

/** Where an answer is: with its asker, waiting for the asking session, or unable to reach it. */
export function formatDelivery(delivery: OwnerAnswerDelivery): string {
  const to = text(delivery.to);
  if (delivery.state === 'delivered') return `delivered to ${to}`;
  if (delivery.state === 'waiting') return `waiting for ${to}`;
  return `not deliverable to ${to}${delivery.reason ? `: ${text(delivery.reason)}` : ''}`;
}

/** What the owner is told about an answer he just gave. */
function deliveryNotice(delivery: OwnerAnswerDelivery | undefined): string {
  if (delivery === undefined) return '';
  const to = text(delivery.to);
  if (delivery.state === 'delivered') return ` Sent to ${to}.`;
  if (delivery.state === 'waiting') return ` ${delivery.reason ? text(delivery.reason) : `Saved; it will be delivered when ${to} is next opened.`}`;
  return ` Saved, not deliverable to ${to}: ${delivery.reason ? text(delivery.reason) : 'it cannot be opened again.'}`;
}

/** One line for a list. */
export function formatOwnerItemLine(item: OwnerItem): string {
  const choices = item.status === 'open'
    ? item.options.length > 0 ? ` [${item.options.join(' | ')}]` : ' [written answer]'
    : '';
  const closed = item.status === 'answered'
    ? ` -> ${answerText(item)}${item.answeredBy ? ` (${text(item.answeredBy.actor)}, ${text(item.answeredBy.surface)})` : ''}`
      + (item.delivery ? ` [${formatDelivery(item.delivery)}]` : '')
    : item.status === 'open' ? '' : ` (${item.status}${item.withdrawnReason ? `: ${text(item.withdrawnReason)}` : ''})`;
  return `${shortId(item.id)}  ${item.kind}  ${text(item.title)}${choices}${closed}`;
}

/** Everything about one item. */
export function formatOwnerItemDetail(item: OwnerItem): string {
  const lines = [
    `${item.kind} ${item.id} · ${item.status}`,
    text(item.title),
    ...(item.detail ? ['', text(item.detail), ''] : []),
    ...(item.askedBy ? [`Asked by: ${text(item.askedBy)}`] : []),
    ...(item.sessionId ? [`Session: ${text(item.sessionId)}`] : []),
    `Asked: ${when(item.createdAt)}`,
    ...(item.expiresAt !== undefined ? [`${item.status === 'open' ? 'Expires' : 'Expired'}: ${when(item.expiresAt)}`] : []),
  ];
  if (item.status === 'open') {
    lines.push(item.options.length > 0
      ? `Answer: /questions answer ${shortId(item.id)} <${item.options.join('|')}> [note]`
      : `Answer: /questions answer ${shortId(item.id)} <your answer>`);
  } else if (item.status === 'answered') {
    lines.push(`Answered: ${answerText(item)}${item.answeredBy ? ` by ${text(item.answeredBy.actor)} from ${text(item.answeredBy.surface)}` : ''}${item.closedAt ? ` at ${when(item.closedAt)}` : ''}`);
    if (item.delivery) {
      lines.push(`Delivery: ${formatDelivery(item.delivery)}`);
      if (item.delivery.state === 'waiting' && item.delivery.reason) lines.push(text(item.delivery.reason));
    }
  } else if (item.withdrawnReason) {
    lines.push(`Withdrawn: ${text(item.withdrawnReason)}`);
  }
  return lines.join('\n');
}

/** An exact id, or a prefix that names exactly one item among `items`. */
function resolveId(raw: string, items: readonly OwnerItem[]): { id: string } | { error: string } {
  const exact = items.find((item) => item.id === raw);
  if (exact) return { id: exact.id };
  const matches = items.filter((item) => item.id.startsWith(raw));
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length === 0) return { error: `No inbox item starts with "${raw}". /questions lists the open ones.` };
  return { error: `"${raw}" matches ${matches.length} items (${matches.slice(0, 4).map((item) => shortId(item.id)).join(', ')}); type more of the id.` };
}

let inboxPolicy: OwnerInboxCommandPolicy<unknown> | undefined;
function inboxOf(context: unknown): OwnerInboxPort {
  const inbox = inboxPolicy?.inbox(context) ?? { unavailable: 'No inbox is wired here.' };
  if ('unavailable' in inbox) throw commandRefusal(inbox.unavailable);
  return inbox;
}
function failed(what: string, error: unknown): never {
  throw commandRefusal(`Could not ${what}: ${error instanceof Error ? error.message : String(error)}.`, 'Check the daemon with /status, then retry.');
}
const TERMINAL_ONLY = { terminalOnly: 'The web UI answers the inbox on its own Inbox page.' } as const;

const OPEN_QUESTIONS = defineList<unknown>({
  name: 'inbox.open',
  async read(ctx) {
    return (await listEveryOwnerItem(inboxOf(ctx), { status: 'open' })).map((item): ListRow => ({
      value: shortId(item.id), label: text(item.title), state: item.kind,
      detail: item.options.length > 0 ? `answers: ${item.options.join(', ')}` : 'a written answer',
    }));
  },
  operator: { method: 'inbox.list', input: { status: 'open' }, rows: { from: 'items', value: 'id', label: 'title', state: 'kind' } },
});
const ALL_ITEMS = defineList<unknown>({
  name: 'inbox.all',
  async read(ctx) {
    return (await listEveryOwnerItem(inboxOf(ctx), { status: 'all' })).map((item): ListRow => ({ value: shortId(item.id), label: text(item.title), state: item.status }));
  },
  operator: { method: 'inbox.list', input: { status: 'all' }, rows: { from: 'items', value: 'id', label: 'title', state: 'status' } },
});
/** Open requests for approval the reading says this viewer raised and may still withdraw. */
async function withdrawable(ctx: unknown): Promise<readonly OwnerItem[]> {
  return (await listEveryOwnerItem(inboxOf(ctx), { status: 'open', kinds: ['approval'] }))
    .filter((item) => item.reading?.requester.mine === true && item.reading.allowedActions.includes('cancel'));
}
const MY_REQUESTS = defineList<unknown>({
  name: 'inbox.my-requests',
  async read(ctx) {
    return (await withdrawable(ctx)).map((item): ListRow => ({ value: shortId(item.id), label: text(item.title), detail: when(item.createdAt) }));
  },
  operator: TERMINAL_ONLY,
});

const OPEN_DECISIONS = defineList<unknown>({
  name: 'inbox.decisions',
  async read(ctx) {
    return (await listEveryOwnerItem(inboxOf(ctx), { status: 'open', kinds: ['decision'] })).map((item): ListRow => ({ value: shortId(item.id), label: text(item.title), detail: when(item.createdAt) }));
  },
  operator: { method: 'inbox.list', input: { status: 'open', kinds: 'decision' }, rows: { from: 'items', value: 'id', label: 'title' } },
});

async function findItem(inbox: OwnerInboxPort, raw: string, status: 'open' | 'all'): Promise<OwnerItem> {
  const direct = await inbox.find(raw);
  if (direct) return direct;
  const resolved = resolveId(raw, await listEveryOwnerItem(inbox, { status }));
  if ('error' in resolved) throw commandRefusal(resolved.error);
  const item = await inbox.find(resolved.id);
  if (!item) throw commandRefusal(`${resolved.id} is no longer in the inbox.`);
  return item;
}

/** What each choice on a decision Jev made does, said once (the action's label and sentence). */
const DECISION_ACTIONS: readonly { readonly word: keyof typeof JEV_DECISION_CHOICES; readonly label: string; readonly sentence: string; readonly risk: ActionDescription<never>['risk'] }[] = [
  { word: 'keep', label: 'Leave a decision as Jev made it', sentence: '{decision} stays as Jev decided it, and nothing changes until you change it.', risk: 'none' },
  { word: 'undo', label: 'Undo what a decision did', sentence: 'The files the call in {decision} changed are put back as they were before it, until you change it.', risk: 'none' },
  { word: 'never', label: 'Never allow calls like a decision\'s', sentence: 'Calls like the one in {decision} are refused from now on, until you change it.', risk: 'none' },
  { word: 'always', label: 'Always allow calls like a decision\'s without asking', sentence: 'Calls like the one in {decision} run without asking from now on, until you change it.', risk: 'loosens-a-protection' },
  { word: 'ask', label: 'Ask me about calls like a decision\'s', sentence: 'Calls like the one in {decision} are asked of you from now on, until you change it.', risk: 'none' },
];

/** Register `/questions` and `/decisions` (one description each for both apps) over this app's inbox. */
export function registerOwnerInboxCommands<Context extends OwnerInboxCommandContext>(
  registry: Pick<TerminalCommandRegistry<Context>, 'register'>,
  policy: OwnerInboxCommandPolicy<Context>,
): void {
  inboxPolicy = policy as OwnerInboxCommandPolicy<unknown>;
  const ownerOnly = (context: Context, command: string, what: string): void => {
    // The answer is the owner's: a model running this command never answers for him.
    if (!policy.isOwner(context, command)) throw commandRefusal(`Only the owner ${what}. Type /${command} at the terminal.`);
  };

  const ITEM: InputDescription = listInput({ id: 'item', label: 'Question', help: 'What waits on you', list: OPEN_QUESTIONS, other: 'the id of an item already answered' });
  registry.register(defineCommand<Context>({
    name: 'questions',
    // --yes confirms only right after the action word: the same word in the text is text.
    leadingFlagsOnly: true,
    title: 'What waits on you',
    summary: 'Permission asks, questions agents left, claims and purchase windows: see them and answer',
    group: 'Inbox',
    report: 'list',
    actions: [
      readAction<Context>({
        id: 'list', label: 'See what waits on you', word: 'list',
        sentence: 'Lists every open question, ask, claim and purchase window, with its answers.',
        async rowValue(ctx) { try { const open = await listEveryOwnerItem(inboxOf(ctx), { status: 'open' }); return open.length === 0 ? 'nothing waiting' : `${open.length} waiting`; } catch { return ''; } },
        async run(_values, ctx) {
          let items: readonly OwnerItem[];
          try { items = await listEveryOwnerItem(inboxOf(ctx), { status: 'open' }); } catch (error) { return failed('read the inbox', error); }
          if (items.length === 0) return 'Nothing is waiting on you.';
          return [`Waiting on you (${items.length}):`, ...items.map((item) => `  ${formatOwnerItemLine(item)}`), '', 'Show one: /questions show <id>   Answer: /questions answer <id> <choice|text>'].join('\n');
        },
      }),
      readAction<Context>({
        id: 'all', label: 'See everything ever asked of you', word: 'all',
        sentence: 'Lists every inbox item, open or answered, newest first, with who answered and where the answer went.',
        async run(_values, ctx) {
          let items: readonly OwnerItem[];
          try { items = await listEveryOwnerItem(inboxOf(ctx), { status: 'all' }); } catch (error) { return failed('read the inbox', error); }
          if (items.length === 0) return 'Nothing has been asked of you yet.';
          return [`Owner inbox (${items.length}, newest first):`, ...items.map((item) => `  ${formatOwnerItemLine(item)}`)].join('\n');
        },
      }),
      readAction<Context>({
        id: 'show', label: 'See one question in full', word: 'show',
        inputs: [listInput({ id: 'item', label: 'Item', help: 'Everything in the inbox', list: ALL_ITEMS })],
        sentence: 'Shows {item} in full: who asked, when, the answers it takes, and where an answer went.', example: { item: 'q-41a2' },
        async run(values, ctx) {
          try { return formatOwnerItemDetail(await findItem(inboxOf(ctx), values.item!, 'all')); } catch (error) { if (error && typeof error === 'object' && 'refusal' in error) throw error; return failed('read the item', error); }
        },
      }),
      {
        id: 'answer', label: 'Answer a question', word: 'answer',
        inputs: [ITEM, textInput({ id: 'answer', label: 'Answer', help: 'One of its answers, then a note if you like; or your written answer', why: 'your own words', kind: 'long-text', typed: { tail: true } })],
        sentence: '{item} is answered "{answer}" and the answer goes to whoever asked.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        ownerOnly: { reason: 'the owner\'s answer is the owner\'s', instead: 'Ask the owner to answer it with /questions answer.' },
        operator: TERMINAL_ONLY, example: { item: 'q-41a2', answer: 'approve' },
        async run(values, ctx) {
          ownerOnly(ctx, 'questions', 'answers the inbox');
          const inbox = inboxOf(ctx);
          const item = await findItem(inbox, values.item!, 'open');
          const words = values.answer!.trim();
          // With options, the first word is the choice and the rest, as typed, its note.
          const space = words.search(/\s/);
          // An approval is answered at the revision shown: one that moved meanwhile is refused with how it stands now.
          const shown = item.revision !== undefined ? { expectedRevision: item.revision } : {};
          const answer = item.options.length > 0
            ? { option: space < 0 ? words : words.slice(0, space), ...(space < 0 ? {} : { text: words.slice(space).trim() }), ...shown }
            : { text: words, ...shown };
          let outcome;
          try { outcome = await inbox.answer(item.id, answer); } catch (error) { return failed('send the answer', error); }
          if (!outcome.applied) throw commandRefusal(formatRefusal(outcome.refusal));
          ctx.renderRequest();
          return `Answered ${shortId(outcome.item.id)}: ${answerText(outcome.item)}${deliveryNotice(outcome.delivery)}`;
        },
      },
      {
        id: 'withdraw', label: 'Withdraw a request you raised', word: 'withdraw',
        inputs: [
          listInput({ id: 'request', label: 'Request', help: 'Requests for approval you raised that still wait', list: MY_REQUESTS, other: 'the id of a request you raised' }),
          textInput({ id: 'note', label: 'Why', help: 'A note kept with it', why: 'your own words', kind: 'long-text', typed: { tail: true }, optional: { default: '', means: 'no note' } }),
        ],
        sentence: 'Your request {request} stops waiting and is cancelled; nobody can approve it any more.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'cannot-be-undone',
        ownerOnly: { reason: 'withdrawing a request is the owner\'s act', instead: 'Ask the owner to withdraw it with /questions withdraw.' },
        operator: { method: 'approvals.cancel', fields: { approvalId: 'request', note: 'note' } }, example: { request: 'apr-41a2' },
        async run(values, ctx) {
          ownerOnly(ctx, 'questions', 'withdraws a request');
          const mine = await withdrawable(ctx);
          const wanted = values.request!.trim();
          const item = mine.find((entry) => entry.id === wanted || shortId(entry.id) === wanted || entry.id.startsWith(wanted));
          if (!item || item.revision === undefined) throw commandRefusal(`No waiting request you raised is ${wanted}; nothing was withdrawn.`, '/questions withdraw lists the ones you can.');
          let outcome;
          // Sent at the revision shown: a request that moved meanwhile is refused with how it stands now.
          try { outcome = await policy.withdraw(ctx, { approvalId: item.id, expectedRevision: item.revision, ...(values.note ? { note: values.note } : {}) }); } catch (error) { return failed('withdraw the request', error); }
          if (!outcome.applied) throw commandRefusal(`Not withdrawn: ${outcome.refusal?.reason ?? 'the daemon refused it'}. Nothing was changed.`);
          ctx.renderRequest();
          return `Withdrew ${shortId(item.id)}: ${text(item.title)}.`;
        },
      },
    ],
  }));

  const DECISION: InputDescription = listInput({ id: 'decision', label: 'Decision', help: 'Calls Jev decided that you can still change', list: OPEN_DECISIONS });
  registry.register(defineCommand<Context>({
    name: 'decisions',
    title: 'What was decided for you',
    summary: 'Calls Jev decided for you, and every answered inbox item: see them, undo one, or set a standing rule',
    group: 'Inbox',
    report: 'list',
    actions: [
      readAction<Context>({
        id: 'list', label: 'See what was decided for you', word: 'list',
        inputs: [
          textInput({ id: 'when', label: 'When', help: 'today, yesterday, a day (2026-11-19), or since a day or 30m, 2h, 3d, 1w', why: 'a day or a time span', typed: { flag: '--when' }, optional: { default: '', means: 'the latest' } }),
          { id: 'count', label: 'How many', help: 'How many of the latest to show', kind: 'number', freeTextReason: 'a number', required: { default: '', defaultMeans: String(DECISIONS_LIMIT) }, typed: { flag: '--count' } },
        ],
        sentence: 'Lists the calls Jev decided that you can still change, and what was decided, {when}.', example: { when: 'today' },
        async run(values, ctx) {
          const window = values.when ? decisionWindow(values.when.split(/\s+/), Date.now()) : undefined;
          if (typeof window === 'string') throw commandRefusal(window.replace('/decisions since', '--when "since'));
          if (values.when && window === undefined) throw commandRefusal(`"${values.when}" is not a period: today, yesterday, a day (2026-11-19), or since a day or 30m, 2h, 3d, 1w.`);
          const count = Number(values.count);
          // A period reads the whole inbox, a page at a time; a count reads as many as it asks, however far back.
          const limit = window !== undefined ? Number.POSITIVE_INFINITY : Number.isInteger(count) && count > 0 ? count : DECISIONS_LIMIT;
          const inbox = inboxOf(ctx);
          const read = async (filter: { readonly status: 'open' | 'closed'; readonly kinds?: readonly ['decision'] }): Promise<readonly OwnerItem[]> =>
            limit <= DECISIONS_LIMIT ? inbox.list({ ...filter, limit }) : (await listEveryOwnerItem(inbox, filter)).slice(0, limit);
          let allOpen: readonly OwnerItem[], allClosed: readonly OwnerItem[];
          try {
            [allOpen, allClosed] = await Promise.all([read({ status: 'open', kinds: ['decision'] }), read({ status: 'closed' })]);
          } catch (error) { return failed('read the decisions', error); }
          const inWindow = (at: number): boolean => window === undefined || (at >= window.from && at < window.to);
          const open = allOpen.filter((item) => inWindow(item.createdAt));
          const closed = allClosed.filter((item) => inWindow(item.closedAt ?? item.createdAt));
          if (open.length === 0 && closed.length === 0) return window === undefined ? 'Nothing has been decided yet.' : `Nothing was decided ${window.label}.`;
          const period = window === undefined ? '' : ` ${window.label}`;
          return [
            ...(open.length > 0 ? [
              `Jev decided${period}, and you can still change (${open.length}, newest first):`,
              ...open.map((item) => `  ${when(item.createdAt)}  ${formatOwnerItemLine(item)}`),
              '',
              'Change one: /decisions <keep|undo|never|always|ask> <decision>   (undo puts back the files the call changed; never, always and ask set a standing rule for calls like it)',
              '',
            ] : []),
            ...(closed.length > 0 ? [`Decided${period} (${closed.length}, newest first):`, ...closed.map((item) => `  ${item.closedAt !== undefined ? `${when(item.closedAt)}  ` : ''}${formatOwnerItemLine(item)}`), ''] : []),
            'Details: /questions show <id>',
          ].join('\n');
        },
      }),
      ...DECISION_ACTIONS.map((choice): ActionDescription<Context> => ({
        id: choice.word, label: choice.label, word: choice.word, inputs: [DECISION],
        sentence: choice.sentence, done: '',
        touches: 'this-machine', lasts: 'kept', risk: choice.risk,
        ownerOnly: { reason: 'what Jev decided for the owner is the owner\'s to change', instead: `Ask the owner to choose it with /decisions ${choice.word}.` },
        operator: TERMINAL_ONLY, example: { decision: 'd-7c31' },
        async run(values, ctx) {
          ownerOnly(ctx, 'decisions', 'changes what Jev decided');
          const inbox = inboxOf(ctx);
          const raw = values.decision!;
          let resolvedId: string;
          try {
            const resolved = resolveId(raw, await listEveryOwnerItem(inbox, { status: 'open', kinds: ['decision'] }));
            if ('error' in resolved) {
              const closed = await inbox.find(raw);
              throw commandRefusal(closed?.kind === 'decision'
                ? `${shortId(closed.id)} is ${closed.status}${closed.answer ? `: ${answerText(closed)}` : closed.withdrawnReason ? `: ${text(closed.withdrawnReason)}` : ''}. Set a standing rule with /permissions instead.`
                : `No open decision starts with "${raw}". /decisions lists them.`);
            }
            resolvedId = resolved.id;
          } catch (error) {
            if (error && typeof error === 'object' && 'refusal' in error) throw error;
            return failed('read the decisions', error);
          }
          let outcome;
          try { outcome = await inbox.answer(resolvedId, { option: choice.word }); } catch (error) { return failed('apply the choice', error); }
          if (!outcome.applied) throw commandRefusal(formatRefusal(outcome.refusal));
          ctx.renderRequest();
          return `${shortId(outcome.item.id)}: ${outcome.item.answer?.text ? text(outcome.item.answer.text) : `${choice.word}.`}`;
        },
      })),
    ],
  }));
}
