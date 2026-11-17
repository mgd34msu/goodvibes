/**
 * /questions and /decisions: the owner inbox in a terminal.
 *
 * `/questions` lists what waits on the owner (permission asks, questions agents
 * left, channel claims, purchase windows, queued actions) and answers one.
 * `/decisions` lists what was decided, by whom and from where, and for an
 * answered question whether the answer reached the agent or session that
 * asked, waits for that session to be opened again, or cannot reach it.
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

/** Display-only: strip terminal control sequences from text an agent or a channel wrote. */
function text(value: string): string {
  return stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function shortId(id: string): string {
  return id.length > SHORT_ID_CHARS ? id.slice(0, SHORT_ID_CHARS) : id;
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
          const answer = item.options.length > 0
            ? { option: rest[0]!, ...(rest.length > 1 ? { text: rest.slice(1).join(' ') } : {}) }
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
    description: 'What was decided on your inbox: the answer, who gave it and from where',
    usage: '[<count>]',
    async handler(args, context) {
      const inbox = port(context);
      if (!inbox) return;
      const count = Number(args[0]);
      const limit = Number.isInteger(count) && count > 0 ? Math.min(count, 500) : DECISIONS_LIMIT;
      try {
        const items = await inbox.list({ status: 'closed', limit });
        if (items.length === 0) { say(context, '[inbox] Nothing has been decided yet.'); return; }
        say(context, [
          `Decided (${items.length}, newest first):`,
          ...items.map((item) => `  ${item.closedAt !== undefined ? `${when(item.closedAt)}  ` : ''}${formatOwnerItemLine(item)}`),
          '',
          'Details: /questions show <id>',
        ].join('\n'));
      } catch (error) {
        failed(context, 'read the decisions', error);
      }
    },
  };

  return [questions, decisions];
}
