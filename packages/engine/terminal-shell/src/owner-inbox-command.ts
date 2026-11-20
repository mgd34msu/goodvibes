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
import { formatRefusal } from '@goodvibes-jev/engine/errors';
import type { OwnerAnswerDelivery, OwnerInboxPort, OwnerItem } from '@goodvibes-jev/engine/platform/platform/control-plane';
import type { TerminalSlashCommand } from './command-registry.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { JEV_DECISION_CHOICES } from '@goodvibes-jev/engine/platform/platform/permissions';

export interface OwnerInboxCommandContext {
  readonly print: (text: string) => void;
  readonly renderRequest: () => void;
}

export interface OwnerInboxCommandPolicy<Context> {
  /** The inbox this terminal reads, or the reason there is none right now. */
  readonly inbox: (context: Context) => OwnerInboxPort | { readonly unavailable: string };
  /** True only when the owner typed `command` at this terminal. */
  readonly isOwner: (context: Context, command: string) => boolean;
}

const SHORT_ID_CHARS = 14;
const LIST_LIMIT = 50;
const DECISIONS_LIMIT = 30;
/** What the owner can do about a call Jev decided (permissions/jev-decisions.ts). */
const DECISION_CHOICES: ReadonlySet<string> = new Set(Object.values(JEV_DECISION_CHOICES));

/** Display-only: strip terminal control sequences from text an agent or a channel wrote. */
function text(value: string): string {
  return stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function shortId(id: string): string {
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

export function createOwnerInboxCommands<Context extends OwnerInboxCommandContext>(
  policy: OwnerInboxCommandPolicy<Context>,
): readonly TerminalSlashCommand<Context>[] {
  const port = (context: Context): OwnerInboxPort | undefined => {
    const inbox = policy.inbox(context);
    if ('unavailable' in inbox) {
      context.print(`[inbox] ${inbox.unavailable}`);
      return undefined;
    }
    return inbox;
  };
  const say = (context: Context, message: string) => {
    context.print(message);
    context.renderRequest();
  };
  const failed = (context: Context, what: string, error: unknown) => {
    say(context, `[inbox] Could not ${what}: ${error instanceof Error ? error.message : String(error)}. Check the daemon with /status, then retry.`);
  };

  const questions: TerminalSlashCommand<Context> = {
    name: 'questions',
    aliases: ['inbox'],
    description: 'What waits on you: permission asks, questions agents left, claims, purchase windows; answer one',
    usage: '[all] | show <id> | answer <id> <choice|text> [note]',
    argsHint: '[all|show|answer]',
    // Reading the inbox is open to a model; answering is the owner's (the handler checks).
    effect: 'mixed',
    readVerbs: ['', 'all', 'list', 'show'],
    // An answer is free text, delivered as typed.
    rawRest: (args) => (args[0] === 'answer' ? 2 : undefined),
    async handler(args, context) {
      // Read before the first await: a model running this command must not answer for the owner.
      const owner = policy.isOwner(context, 'questions');
      const inbox = port(context);
      if (!inbox) return;
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === '' || sub === 'all' || sub === 'list') {
        try {
          const items = await inbox.list({ status: sub === 'all' ? 'all' : 'open', limit: LIST_LIMIT });
          if (items.length === 0) {
            say(context, sub === 'all' ? '[inbox] Nothing has been asked of you yet.' : '[inbox] Nothing is waiting on you.');
            return;
          }
          say(context, [
            sub === 'all' ? `Owner inbox (${items.length}, newest first):` : `Waiting on you (${items.length}):`,
            ...items.map((item) => `  ${formatOwnerItemLine(item)}`),
            '',
            'Show one: /questions show <id>   Answer: /questions answer <id> <choice|text>',
          ].join('\n'));
        } catch (error) {
          failed(context, 'read the inbox', error);
        }
        return;
      }

      if (sub === 'show') {
        const raw = args[1];
        if (!raw) { say(context, 'Usage: /questions show <id>'); return; }
        try {
          const item = await inbox.find(raw) ?? await (async () => {
            const resolved = resolveId(raw, await inbox.list({ status: 'all', limit: 500 }));
            return 'id' in resolved ? inbox.find(resolved.id) : undefined;
          })();
          say(context, item ? formatOwnerItemDetail(item) : `[inbox] No inbox item starts with "${raw}".`);
        } catch (error) {
          failed(context, 'read the item', error);
        }
        return;
      }

      if (sub === 'answer') {
        if (!owner) {
          say(context, '[inbox] Only the owner answers the inbox. Type /questions answer at the terminal.');
          return;
        }
        const raw = args[1];
        const rest = args.slice(2);
        if (!raw || rest.length === 0) { say(context, 'Usage: /questions answer <id> <choice|text> [note]'); return; }
        try {
          let item = await inbox.find(raw);
          if (!item) {
            const resolved = resolveId(raw, await inbox.list({ status: 'open', limit: 500 }));
            if ('error' in resolved) { say(context, `[inbox] ${resolved.error}`); return; }
            item = await inbox.find(resolved.id);
            if (!item) { say(context, `[inbox] ${resolved.id} is no longer in the inbox.`); return; }
          }
          const words = rest.join(' ').trim();
          // With options, the first word is the choice and the rest, as typed, its note.
          const space = words.search(/\s/);
          const answer = item.options.length > 0
            ? { option: space < 0 ? words : words.slice(0, space), ...(space < 0 ? {} : { text: words.slice(space).trim() }) }
            : { text: words };
          const outcome = await inbox.answer(item.id, answer);
          if (outcome.applied) {
            say(context, `[inbox] Answered ${shortId(outcome.item.id)}: ${answerText(outcome.item)}${deliveryNotice(outcome.delivery)}`);
            return;
          }
          say(context, `[inbox] ${formatRefusal(outcome.refusal)}`);
        } catch (error) {
          failed(context, 'send the answer', error);
        }
        return;
      }

      say(context, 'Usage: /questions [all] | show <id> | answer <id> <choice|text> [note]');
    },
  };

  const decisions: TerminalSlashCommand<Context> = {
    name: 'decisions',
    description: 'What was decided for you: calls Jev decided (undo, never, always, ask, keep) and every answered inbox item',
    usage: '[list] [<count>] | today | yesterday | <YYYY-MM-DD> | since <YYYY-MM-DD|30m|2h|3d|1w> | <keep|undo|never|always|ask> <id>',
    argsHint: '[list|keep|undo|never|always|ask]',
    // Listing reads; a choice on a decision changes files or standing rules and is the owner's (the handler checks).
    effect: 'mixed',
    readVerbs: ['', 'list', 'today', 'yesterday', 'since'],
    async handler(args, context) {
      // Read before the first await: a model running this command must not choose for the owner.
      const owner = policy.isOwner(context, 'decisions');
      const inbox = port(context);
      if (!inbox) return;
      const sub = (args[0] ?? '').toLowerCase();

      if (DECISION_CHOICES.has(sub)) {
        if (!owner) {
          say(context, '[decisions] Only the owner changes what Jev decided. Type /decisions <choice> <id> at the terminal.');
          return;
        }
        const raw = args[1];
        if (!raw) { say(context, `Usage: /decisions ${sub} <id>   (/decisions lists the ids)`); return; }
        try {
          const open = await inbox.list({ status: 'open', kinds: ['decision'], limit: 500 });
          const resolved = resolveId(raw, open);
          if ('error' in resolved) {
            const closed = await inbox.find(raw);
            say(context, closed?.kind === 'decision'
              ? `[decisions] ${shortId(closed.id)} is ${closed.status}${closed.answer ? `: ${answerText(closed)}` : closed.withdrawnReason ? `: ${text(closed.withdrawnReason)}` : ''}. Set a standing rule with /permissions instead.`
              : `[decisions] No open decision starts with "${raw}". /decisions lists them.`);
            return;
          }
          const outcome = await inbox.answer(resolved.id, { option: sub });
          if (outcome.applied) {
            say(context, `[decisions] ${shortId(outcome.item.id)}: ${outcome.item.answer?.text ? text(outcome.item.answer.text) : `${sub}.`}`);
            return;
          }
          say(context, `[decisions] ${formatRefusal(outcome.refusal)}`);
        } catch (error) {
          failed(context, 'apply the choice', error);
        }
        return;
      }

      // A period: today, yesterday, a day, or since a day or a duration; filtered here from the newest 500 of each list.
      const window = decisionWindow(sub === 'list' ? args.slice(1) : args, Date.now());
      if (typeof window === 'string') { say(context, window); return; }
      if (window === undefined && sub !== '' && sub !== 'list' && !/^\d+$/.test(sub)) {
        say(context, 'Usage: /decisions [list] [<count>] | today | yesterday | <YYYY-MM-DD> | since <YYYY-MM-DD|30m|2h|3d|1w> | <keep|undo|never|always|ask> <id>');
        return;
      }
      const count = Number(sub === 'list' ? args[1] : args[0]);
      const limit = window !== undefined ? 500 : Number.isInteger(count) && count > 0 ? Math.min(count, 500) : DECISIONS_LIMIT;
      try {
        const [allOpen, allClosed] = await Promise.all([
          inbox.list({ status: 'open', kinds: ['decision'], limit }),
          inbox.list({ status: 'closed', limit }),
        ]);
        const inWindow = (at: number): boolean => window === undefined || (at >= window.from && at < window.to);
        const open = allOpen.filter((item) => inWindow(item.createdAt));
        const closed = allClosed.filter((item) => inWindow(item.closedAt ?? item.createdAt));
        if (open.length === 0 && closed.length === 0) {
          say(context, window === undefined ? '[inbox] Nothing has been decided yet.' : `[inbox] Nothing was decided ${window.label}.`);
          return;
        }
        const period = window === undefined ? '' : ` ${window.label}`;
        say(context, [
          ...(open.length > 0 ? [
            `Jev decided${period}, and you can still change (${open.length}, newest first):`,
            ...open.map((item) => `  ${when(item.createdAt)}  ${formatOwnerItemLine(item)}`),
            '',
            'Change one: /decisions <keep|undo|never|always|ask> <id>   (undo restores the files the call changed; never, always and ask set a standing rule for calls like it)',
            '',
          ] : []),
          ...(closed.length > 0 ? [
            `Decided${period} (${closed.length}, newest first):`,
            ...closed.map((item) => `  ${item.closedAt !== undefined ? `${when(item.closedAt)}  ` : ''}${formatOwnerItemLine(item)}`),
            '',
          ] : []),
          'Details: /questions show <id>',
        ].join('\n'));
      } catch (error) {
        failed(context, 'read the decisions', error);
      }
    },
  };

  return [questions, decisions];
}
