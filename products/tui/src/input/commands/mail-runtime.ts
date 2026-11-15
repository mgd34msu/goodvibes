/**
 * mail-runtime.ts, `/mail`, the terminal surface over the daemon's mail
 * capability.
 *
 * This command implements no mail. Every verb here is one call into the
 * gateway method catalog, where `src/daemon/handlers/email/` owns IMAP, SMTP,
 * settings resolution, the credential read, and the confirmation gate. What
 * lives in this file is argument parsing, rendering, and an honest refusal when
 * the capability is not set up, nothing else.
 *
 * ## What is exposed, and what is not
 *
 * Reading (`list`, `read`) and drafting are exposed because checking mail
 * without leaving the terminal is squarely what this product is for, and
 * because a draft changes nothing outside the account's own Drafts folder.
 *
 * Sending is exposed too, a shipped route with no way to reach it is a route
 * that is not wired up, but never without a question. A send cannot be undone,
 * so the command registry asks once, showing exactly what would leave the
 * machine; only the confirming answer (or `--yes` typed by the owner) sets both
 * flags the daemon's gate demands, so the send cannot happen from a typo.
 * Slash commands are not kept in the prompt history, so a recalled line cannot
 * re-send either. The wire has no idempotency key, so this process refuses to
 * send the exact same message twice unless `--again` is given, which covers a
 * retry after a timeout.
 *
 * Message bodies are attacker-controlled text. They are printed as transcript
 * output, which is display-only and never enters the model's message history,
 * so a body cannot smuggle instructions into a turn by being read here.
 */

import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/platform';
import {
  EXPLICIT_WRITE_INVOCATION_CONTEXT,
  claimIrreversibleWrite,
  READ_INVOCATION_CONTEXT,
  errorText,
  probeConnection,
  renderConnectionStatus,
} from './connection-status.ts';

/** Inbox summary, exactly the daemon's `email.inbox.list` item shape. */
interface InboxMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  readonly bodyPreview: string;
}

/** Full message, exactly the daemon's `email.inbox.read` output shape. */
interface FullMessage {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly bodyText?: string;
  readonly attachments?: ReadonlyArray<{ readonly filename: string; readonly sizeBytes: number }>;
}

const DEFAULT_LIST_LIMIT = 15;
const MAX_LIST_LIMIT = 100;

function truncate(value: string, width: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

/** The parts of the `email.inbox.list` output beyond the messages themselves. */
type InboxListOutput = OperatorMethodOutput<'email.inbox.list'>;
type TriageLabel = 'spam' | 'priority' | 'normal';
interface InboxPageNotes {
  readonly total?: InboxListOutput['total'] | undefined;
  readonly unreadable?: InboxListOutput['unreadable'] | undefined;
  /** Triage label by UID, from the daemon's inbox mirror. */
  readonly labels?: ReadonlyMap<number, TriageLabel> | undefined;
}

export function renderInboxList(messages: readonly InboxMessage[], notes: InboxPageNotes = {}): string {
  const unreadable = notes.unreadable ?? [];
  const unreadableLine = unreadable.length > 0
    ? `  ${unreadable.length} message${unreadable.length === 1 ? '' : 's'} on this page could not be read and ${unreadable.length === 1 ? 'is' : 'are'} not shown (${unreadable.map((entry) => entry.detail).join('; ')}). They are not deleted.`
    : undefined;
  if (messages.length === 0) {
    if (unreadableLine) return ['No messages could be shown.', unreadableLine, ...(notes.total ? [`  ${notes.total} matched in the mailbox.`] : [])].join('\n');
    return 'Inbox is empty (nothing matched).';
  }
  const lines = [`Inbox: ${messages.length} message${messages.length === 1 ? '' : 's'}${notes.total !== undefined && notes.total > messages.length ? ` of ${notes.total}` : ''}:`];
  for (const message of messages) {
    const mark = message.unread ? '●' : ' ';
    const label = notes.labels?.get(message.uid);
    const tag = label === 'spam' ? '[spam] ' : label === 'priority' ? '[priority] ' : '';
    lines.push(`  ${mark} ${String(message.uid).padStart(6)}  ${truncate(message.from, 28).padEnd(28)}  ${tag}${truncate(message.subject, 48)}`);
  }
  if (unreadableLine) lines.push(unreadableLine);
  lines.push('', '  /mail read <uid>: open one message');
  return lines.join('\n');
}

export function renderMessage(message: FullMessage): string {
  const lines = [
    `From:    ${message.from}`,
    `Subject: ${message.subject}`,
    `Date:    ${message.date}`,
  ];
  const attachments = message.attachments ?? [];
  if (attachments.length > 0) {
    lines.push(`Files:   ${attachments.map((a) => `${a.filename} (${a.sizeBytes} bytes)`).join(', ')}`);
  }
  lines.push('', message.bodyText && message.bodyText.trim().length > 0
    ? message.bodyText.trimEnd()
    : '(no plain-text body)');
  return lines.join('\n');
}

/**
 * Read `to | subject | body`: the recipient is the text before the first `|`,
 * the subject the text before the second, and the body everything after it,
 * further pipes included. A pipe rather than positional words because a subject
 * and a body both contain spaces. All three are required, so a missing one is a
 * usage error rather than a message sent with an empty subject.
 */
export function parseComposeArgs(raw: string): { to: string; subject: string; body: string } | null {
  const first = raw.indexOf('|');
  const second = first < 0 ? -1 : raw.indexOf('|', first + 1);
  if (second < 0) return null;
  const to = raw.slice(0, first).trim();
  const subject = raw.slice(first + 1, second).trim();
  const body = raw.slice(second + 1).trim();
  if (!to || !subject || !body) return null;
  return { to, subject, body };
}

/**
 * Splits a compose line into the flags typed before its first field and the
 * text. A flag is read only there: the same word inside the subject or body is
 * text and is sent as typed.
 */
export function splitLeadingFlags(rest: readonly string[], known: ReadonlySet<string>): { readonly flags: ReadonlySet<string>; readonly text: string } {
  const flags = new Set<string>();
  let index = 0;
  while (index < rest.length && known.has(rest[index]!)) flags.add(rest[index++]!);
  return { flags, text: rest.slice(index).join(' ') };
}

/** `--again` sends a message identical to one already sent; `--confirm` was the old second step and has no effect. */
const COMPOSE_FLAGS: ReadonlySet<string> = new Set(['--again', '--confirm']);

function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIST_LIMIT;
  return Math.min(MAX_LIST_LIMIT, Math.floor(parsed));
}

const USAGE = [
  'Usage:',
  '  /mail                       connection status and the latest messages',
  '  /mail status                connection status only',
  '  /mail list [n]              list the n most recent messages (default 15)',
  '  /mail read <uid>            open one message',
  '  /mail draft <to | subject | body>   save a draft to the account',
  '  /mail send [--again] <to | subject | body>   shows the message and asks once, then sends',
  '',
  '  The body is everything after the second |, pipes included. --again goes before the recipient.',
].join('\n');

export function registerMailRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'mail',
    aliases: ['email'],
    description: 'Mail over the daemon: connection status, inbox, read, draft, send',
    usage: '[status|list|read|draft|send] …',
    argsHint: '[status|list <n>|read <uid>|draft|send]',
    subcommands: { status: '', list: '[n]', read: '<uid>', draft: '<to | subject | body>', send: '[--again] <to | subject | body>' },
    confirm(args) {
      if ((args[0] ?? '').toLowerCase() !== 'send') return undefined;
      const parsed = parseComposeArgs(splitLeadingFlags(args.slice(1), COMPOSE_FLAGS).text);
      if (parsed === null) return undefined; // The handler prints the usage; nothing is sent.
      return {
        title: `Send this message to ${parsed.to}?`,
        detail: [`To:      ${parsed.to}`, `Subject: ${parsed.subject}`, '', parsed.body, '', 'A sent message cannot be recalled.'].join('\n'),
        confirmLabel: 'Send',
      };
    },
    async handler(args, ctx) {
      const gateway = ctx.workspace.gatewayMethods;
      const sub = (args[0] ?? '').toLowerCase();

      if (sub === 'status') {
        ctx.print(renderConnectionStatus(await probeConnection(gateway, 'mail')));
        return;
      }

      if (!gateway) {
        ctx.print(renderConnectionStatus(await probeConnection(undefined, 'mail')));
        return;
      }

      if (sub === '' || sub === 'list') {
        await listInbox(ctx, gateway, parseLimit(args[1]), sub === '');
        return;
      }
      if (sub === 'read') {
        await readMessage(ctx, gateway, args[1]);
        return;
      }
      if (sub === 'draft' || sub === 'send') {
        await compose(ctx, gateway, sub, args.slice(1));
        return;
      }
      ctx.print(USAGE);
    },
  });
}

type Gateway = NonNullable<CommandContext['workspace']['gatewayMethods']>;

/**
 * Every failure path renders the connection status rather than a bare error:
 * "not configured" is far more often the real cause than a transient fault,
 * and the status carries the exact next step.
 */
async function withStatusOnFailure(
  ctx: CommandContext,
  gateway: Gateway,
  label: string,
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    ctx.print(`[mail ${label}] ${errorText(error)}`);
    ctx.print(renderConnectionStatus(await probeConnection(gateway, 'mail')));
  }
}

/**
 * Triage labels the daemon's inbox mirror holds for this mailbox, by UID. The
 * mirror names a mail row `email:<account>:<uidvalidity>:<uid>`. Best effort:
 * a mirror that cannot be read leaves the list unlabelled, never failed.
 */
async function triageLabels(gateway: Gateway, shown: number): Promise<ReadonlyMap<number, TriageLabel>> {
  const labels = new Map<number, TriageLabel>();
  if (shown === 0) return labels;
  try {
    const mirror = await gateway.invoke('channels.inbox.list', { ...READ_INVOCATION_CONTEXT, body: { provider: 'email', limit: 500 } }) as {
      items?: readonly { id?: unknown; triageLabel?: unknown }[] };
    for (const item of mirror.items ?? []) {
      const uid = typeof item.id === 'string' ? Number(item.id.slice(item.id.lastIndexOf(':') + 1)) : Number.NaN;
      if (Number.isSafeInteger(uid) && (item.triageLabel === 'spam' || item.triageLabel === 'priority' || item.triageLabel === 'normal')) {
        labels.set(uid, item.triageLabel);
      }
    }
  } catch { /* No mirror, no labels. */ }
  return labels;
}

async function listInbox(ctx: CommandContext, gateway: Gateway, limit: number, withStatus: boolean): Promise<void> {
  await withStatusOnFailure(ctx, gateway, 'list', async () => {
    const result = await gateway.invoke('email.inbox.list', {
      ...READ_INVOCATION_CONTEXT,
      body: { limit },
    }) as InboxListOutput;
    if (withStatus) {
      ctx.print(renderConnectionStatus({
        surface: 'mail',
        state: 'ready',
        detail: 'Mail is connected: the daemon reached the server and returned a result.',
        nextActions: [],
      }));
    }
    const labels = await triageLabels(gateway, (result.messages ?? []).length);
    ctx.print(renderInboxList(result.messages ?? [], { total: result.total, unreadable: result.unreadable, labels }));
  });
}

async function readMessage(ctx: CommandContext, gateway: Gateway, rawUid: string | undefined): Promise<void> {
  const uid = Number(rawUid);
  if (!Number.isFinite(uid) || uid <= 0) {
    ctx.print('Usage: /mail read <uid>; the uid column from /mail list.');
    return;
  }
  await withStatusOnFailure(ctx, gateway, 'read', async () => {
    const message = await gateway.invoke('email.inbox.read', {
      ...READ_INVOCATION_CONTEXT,
      body: { uid },
    }) as FullMessage;
    ctx.print(renderMessage(message));
  });
}

async function compose(ctx: CommandContext, gateway: Gateway, verb: 'draft' | 'send', rest: readonly string[]): Promise<void> {
  const line = splitLeadingFlags(rest, COMPOSE_FLAGS);
  const again = line.flags.has('--again');
  const parsed = parseComposeArgs(line.text);
  if (parsed === null) {
    ctx.print([
      `Usage: /mail ${verb}${verb === 'send' ? ' [--again]' : ''} <to | subject | body>`,
      '  Three fields separated by |; the body is everything after the second |. For example:',
      `  /mail ${verb} me@example.com | Build is green | All gates passed.`,
    ].join('\n'));
    return;
  }

  if (verb === 'draft') {
    await withStatusOnFailure(ctx, gateway, 'draft', async () => {
      // No `confirm` in the body: the platform contract for draft.create does not
      // declare one (its input schema is closed), and the handler is registered
      // without the confirmation wrapper. Sending one would be a field the
      // schema rejects.
      const result = await gateway.invoke('email.draft.create', {
        ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
        body: { to: parsed.to, subject: parsed.subject, body: parsed.body },
      }) as OperatorMethodOutput<'email.draft.create'>;
      // Without UIDPLUS the server returns no uid; name the folder instead of printing "undefined".
      const where = result.uid !== undefined ? `uid ${result.uid}` : `folder ${result.mailbox}`;
      ctx.print(`Draft saved to the account (${where}). Nothing was sent.`);
    });
    return;
  }

  // The registry has asked the owner by now (or the owner typed --yes), so this is the user's own explicit request.
  if (!claimIrreversibleWrite(gateway, `mail.send\0${parsed.to}\0${parsed.subject}\0${parsed.body}`, again)) {
    ctx.print('This exact message was already sent (or a send was attempted and its outcome is unknown) from this session, so it was not sent again. Check the Sent folder first; to send it anyway put --again before the recipient: /mail send --again <to | subject | body>.');
    return;
  }

  await withStatusOnFailure(ctx, gateway, 'send', async () => {
    const result = await gateway.invoke('email.send', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { to: parsed.to, subject: parsed.subject, body: parsed.body, confirm: true },
    }) as OperatorMethodOutput<'email.send'>;
    ctx.print(`Sent to ${parsed.to} at ${result.sentAt} (message id ${result.messageId}).`);
  });
}
