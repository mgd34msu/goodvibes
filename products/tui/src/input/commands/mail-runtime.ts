/**
 * mail-runtime.ts: this app's host for `/mail` (one description shared with the
 * Agent, terminal-shell/mail-command.ts), over the daemon's mail capability.
 *
 * This file implements no mail. Every action is one call into the gateway
 * method catalog, where the daemon's email handlers own IMAP, SMTP, settings
 * resolution, the credential read and the confirmation gate. A send asks
 * first (the description marks it as sending something outside this machine)
 * and only then sets both flags the daemon's gate demands. Each message gets
 * one `clientSendId` when it is first sent, and every repeat of that message
 * carries the same id, so the daemon answers a repeat within ten minutes with
 * the first answer instead of mailing the recipients again. A message that was
 * sent is not sent again unless "Send it again" (`--again`) is chosen, which
 * then sends a new copy under a new id.
 *
 * Message bodies are attacker-controlled text. They are printed as transcript
 * output, which is display-only and never enters the model's message history,
 * so a body cannot smuggle instructions into a turn by being read here.
 */

import { randomUUID } from 'node:crypto';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import type { OperatorMethodOutput } from '@goodvibes/engine/platform';
import { registerMailCommand, type MailMessage } from '@goodvibes/engine/terminal-shell/mail-command';
import type { ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { commandRefusal } from '@goodvibes/engine/terminal-shell/command-confirmation';
import {
  EXPLICIT_WRITE_INVOCATION_CONTEXT,
  READ_INVOCATION_CONTEXT,
  daemonErrorCode,
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
  /** From the daemon's inbox mirror: `not-screened` when only code checked it for credential and card text. */
  readonly screening?: 'screened' | 'not-screened';
  readonly screeningReason?: string;
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
    const tag = `${label === 'spam' ? '[spam] ' : label === 'priority' ? '[priority] ' : ''}${message.screening === 'not-screened' ? '[not screened] ' : ''}`;
    lines.push(`  ${mark} ${String(message.uid).padStart(6)}  ${truncate(message.from, 28).padEnd(28)}  ${tag}${truncate(message.subject, 48)}`);
  }
  const notScreened = messages.filter((message) => message.screening === 'not-screened');
  if (notScreened.length > 0) {
    const reasons = [...new Set(notScreened.map((message) => message.screeningReason).filter((reason): reason is string => typeof reason === 'string'))];
    lines.push(`  Not screened: ${notScreened.length} message${notScreened.length === 1 ? ' was' : 's were'} checked by code only${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}.`);
  }
  if (unreadableLine) lines.push(unreadableLine);
  lines.push('', '  /mail read <uid> opens one message.');
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

type Gateway = NonNullable<CommandContext['workspace']['gatewayMethods']>;

/** Every failure says why and, since "not set up" is far more often the cause than a transient fault, carries the connection status with its next step. */
async function withStatusOnFailure<T>(gateway: Gateway, label: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Error && 'refusal' in error) throw error;
    throw commandRefusal(`${label}: ${errorText(error)}\n${renderConnectionStatus(await probeConnection(gateway, 'mail'))}`);
  }
}

function gatewayOf(ctx: CommandContext): Gateway {
  const gateway = ctx.workspace.gatewayMethods;
  if (!gateway) throw commandRefusal('Mail runs in the daemon, which this terminal is not connected to.', '/mail status says what to do');
  return gateway;
}

/** Triage labels by UID, as `email.inbox.list` carries them (the daemon joins its inbox mirror). */
function triageLabels(messages: readonly { readonly uid: number; readonly triageLabel?: unknown }[]): ReadonlyMap<number, TriageLabel> {
  const labels = new Map<number, TriageLabel>();
  for (const message of messages) {
    const label = message.triageLabel;
    if (label === 'spam' || label === 'priority' || label === 'normal') labels.set(message.uid, label);
  }
  return labels;
}

async function listInbox(gateway: Gateway, limit: number): Promise<InboxListOutput> {
  return await gateway.invoke('email.inbox.list', { ...READ_INVOCATION_CONTEXT, body: { limit } }) as InboxListOutput;
}

async function compose(ctx: CommandContext, verb: 'draft' | 'send', message: MailMessage, again: boolean): Promise<string> {
  const gateway = gatewayOf(ctx);
  if (verb === 'draft') {
    return await withStatusOnFailure(gateway, 'The draft was not saved', async () => {
      // No `confirm` in the body: the contract for draft.create declares none (its input schema is closed).
      const result = await gateway.invoke('email.draft.create', {
        ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
        body: { to: message.to, subject: message.subject, body: message.body },
      }) as OperatorMethodOutput<'email.draft.create'>;
      // Without UIDPLUS the server returns no uid; name the folder instead of printing "undefined".
      return `Draft saved to the account (${result.uid !== undefined ? `uid ${result.uid}` : `folder ${result.mailbox}`}). Nothing was sent.`;
    });
  }
  // The registry has asked the owner by now (or the owner typed --yes), so this is the user's own explicit request.
  const sends = sendIdsOf(gateway);
  const fingerprint = JSON.stringify([message.to, message.subject, message.body]);
  const earlier = sends.get(fingerprint);
  if (earlier?.sent && !again) {
    throw commandRefusal('This exact message was already sent from this session, so it was not sent again.',
      'Check the Sent folder first; to send another copy choose "Send it again" (/mail send ... --again)');
  }
  // A message not yet confirmed sent keeps its id on every repeat, --again included; only a new copy of a sent one gets a new id.
  const attempt = earlier && !earlier.sent ? earlier : { clientSendId: randomUUID().replaceAll('-', ''), sent: false };
  sends.set(fingerprint, attempt);
  try {
    const result = await gateway.invoke('email.send', {
      ...EXPLICIT_WRITE_INVOCATION_CONTEXT,
      body: { to: message.to, subject: message.subject, body: message.body, confirm: true, clientSendId: attempt.clientSendId },
    }) as OperatorMethodOutput<'email.send'>;
    attempt.sent = true;
    return `Sent to ${message.to} at ${result.sentAt} (message id ${result.messageId}).`;
  } catch (error) {
    if (error instanceof Error && 'refusal' in error) throw error;
    if (daemonErrorCode(error) === 'EMAIL_DELIVERY_UNCONFIRMED') {
      throw commandRefusal(`The send was not confirmed; it may have gone (${errorText(error)}).`,
        'Check the Sent folder; sending it again with /mail send repeats the same message, which is not delivered twice within ten minutes');
    }
    throw commandRefusal(`The message was not sent: ${errorText(error)}\n${renderConnectionStatus(await probeConnection(gateway, 'mail'))}`);
  }
}

/** One mail send attempt: the id every repeat of the message carries, and whether it was confirmed sent. */
interface MailSendAttempt {
  readonly clientSendId: string;
  sent: boolean;
}

/** Per gateway, each message (recipient, subject and body) this process has sent or tried to send. */
const mailSendIds = new WeakMap<object, Map<string, MailSendAttempt>>();

function sendIdsOf(gateway: object): Map<string, MailSendAttempt> {
  let sends = mailSendIds.get(gateway);
  if (!sends) {
    sends = new Map();
    mailSendIds.set(gateway, sends);
  }
  return sends;
}

export function registerMailRuntimeCommands(registry: CommandRegistry): void {
  registerMailCommand<CommandContext>(registry, {
    status: async (ctx) => renderConnectionStatus(await probeConnection(ctx.workspace.gatewayMethods, 'mail')),
    async list(ctx, count) {
      const gateway = gatewayOf(ctx);
      return await withStatusOnFailure(gateway, 'The inbox could not be read', async () => {
        const result = await listInbox(gateway, count);
        return renderInboxList(result.messages ?? [], { total: result.total, unreadable: result.unreadable, labels: triageLabels(result.messages ?? []) });
      });
    },
    async inbox(ctx) {
      const result = await listInbox(gatewayOf(ctx), 30);
      return (result.messages ?? []).map((message): ListRow => ({
        value: String(message.uid), label: truncate(message.subject, 60), detail: truncate(message.from, 40), ...(message.unread ? { state: 'unread' } : {}),
      }));
    },
    async read(ctx, uid) {
      const gateway = gatewayOf(ctx);
      return await withStatusOnFailure(gateway, 'The message could not be read', async () =>
        renderMessage(await gateway.invoke('email.inbox.read', { ...READ_INVOCATION_CONTEXT, body: { uid } }) as FullMessage));
    },
    draft: (ctx, message) => compose(ctx, 'draft', message, false),
    send: (ctx, message, again) => compose(ctx, 'send', message, again),
  });
}
