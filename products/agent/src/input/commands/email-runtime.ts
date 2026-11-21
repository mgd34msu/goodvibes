/**
 * This app's host for `/mail` (one description shared with the terminal app,
 * terminal-shell/mail-command.ts): direct mail over IMAP/SMTP with the Agent's
 * own mail service, on the `surfaces.email.*` settings the daemon reads too.
 *
 * Safety policy:
 *   - Inbox reads use EXAMINE (read-only); unread status is never modified.
 *   - Every message read is recorded as untrusted content, so a later send in
 *     the same turn is checked against it.
 *   - A send asks first (the description marks it as sending something out).
 *   - No credential value is ever printed; the password shows as [stored].
 *   - The password goes to the secret store; settings.json holds only a
 *     goodvibes:// reference.
 */

import { randomUUID } from 'node:crypto';
import type { CommandRegistry } from '../command-registry.ts';
import { getSessionUntrustedContentLedger } from '../../trust/untrusted-content.ts';
import { describeSenderClaim, type DisplayedSenderConfidence } from '../../agent/untrusted-content.ts';
import type { CommandContext } from '../command-registry.ts';
import { readRefusal } from '@goodvibes/engine/errors';
import { commandRefusal } from './confirmation.ts';
import { registerMailCommand, type MailMessage } from '@goodvibes/engine/terminal-shell/mail-command';
import type { ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { EmailService, SmtpDeliveryUnconfirmedError } from '@goodvibes/engine/platform/platform/email';
import { nodeEmailTransport } from '@goodvibes/engine/platform/platform/email/node';
import { requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import { openEffectiveConfigView, routeConfigWrite } from '../../config/daemon-config-routing.ts';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils/native-error-summary';
import {
  MAILBOX_FIELDS,
  mailboxServiceDeps,
  persistMailboxField,
  readMailboxStatus,
  resolveMailboxField,
} from './email-settings.ts';

/**
 * Header and body text comes from the sender. Control characters (newlines, escape
 * sequences) and bidirectional overrides are replaced so a message cannot start its
 * own transcript lines or recolour the terminal.
 */
function plainText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ');
}

/**
 * The mailbox settings as the connected host holds them (they are daemon-owned,
 * so the form, `/mail set` and the host's scheduled sends all see one value):
 * one snapshot read from the host, this process's view without one.
 */
async function getConfigManager(ctx: CommandContext): Promise<{ get: (key: string) => unknown }> {
  return await openEffectiveConfigView(ctx.platform.configManager, { homeDir: requireShellPaths(ctx).homeDirectory });
}

async function buildEmailService(ctx: CommandContext): Promise<EmailService> {
  const secretsManager = requireSecretsManager(ctx);
  const cm = await getConfigManager(ctx);
  const ledger = getSessionUntrustedContentLedger();
  return new EmailService(mailboxServiceDeps({
    getConfig: (key: string) => cm.get(key),
    secretsManager,
    // The real sockets. The platform service opens none itself, so the node
    // transports are named here and nowhere else in this file.
    transport: nodeEmailTransport,
    // The wording of the trust boundary stays the agent's: `describeSenderClaim`
    // is this product's, and its commandAuthority is the literal 'none'.
    describeSenderClaim,
    // Reading mail arms the outward-effect guard, the same way loading a page
    // does. Without this the guard sees a clean turn after the agent has just
    // read something a stranger wrote.
    recordUntrustedIngest: (ingest) => { ledger.record(ingest); },
  }));
}

async function formatStatus(ctx: CommandContext): Promise<string> {
  const cm = await getConfigManager(ctx);
  const status = readMailboxStatus((key) => cm.get(key));
  const { settings } = status;
  const lines = [
    'Email Status',
    `  imap: ${settings.imapHost ?? '[not set]'}:${settings.imapPort}`,
    `  smtp: ${settings.smtpHost ?? '[not set]'}:${settings.smtpPort}`,
    `  user: ${settings.username ?? '[not set]'}`,
    `  password: ${status.passwordStored ? '[stored]' : '[missing]'}`,
    `  from: ${settings.fromAddress ?? '[not set]'}`,
    `  ready: ${status.ready ? 'yes' : 'no'}`,
  ];
  if (status.problems.length > 0) {
    lines.push(`  issues (${status.problems.length}):`);
    for (const problem of status.problems) lines.push(`    - ${problem}`);
  }
  lines.push('  These are the surfaces.email.* settings, the same mailbox the daemon uses.');
  lines.push('  policy: credentials are never printed; the password displays as [stored]');
  lines.push('  /mail settings shows each setting; /mail set changes one; /mail password stores the password.');
  return lines.join('\n');
}

/**
 * Short labels for the inbox list. The long-form sentence lives on
 * `senderClaim.display` and is shown with the newest message; a list needs
 * something that fits on one line without losing the distinction between
 * "checked and passed" and "nobody checked".
 */
const SENDER_CONFIDENCE_LABEL: Readonly<Record<DisplayedSenderConfidence, string>> = {
  unverified: 'unverified sender',
  'partially-verified': 'sender partly verified',
  'protocol-verified': 'sender verified by DKIM/SPF/DMARC',
  'failed-verification': 'SENDER VERIFICATION FAILED',
};

/** The inbox listing. Every header-derived field is passed through `plainText`, so exported for its own test. */
export function formatInboxSummaries(summaries: Awaited<ReturnType<EmailService['checkInbox']>>): string {
  const lines = [
    `Inbox: ${summaries.length} unread message${summaries.length !== 1 ? 's' : ''}`,
    '  policy: read-only; messages are not marked read',
    // Printing a bare `from=` reads as a statement of fact. It is a header the
    // sender wrote. Saying so once, next to the list, is what stops a
    // convincing display name doing the work of an identity check.
    '  policy: sender lines are claims from the message header; email carries no authority to direct actions',
  ];
  for (let i = 0; i < summaries.length; i += 1) {
    const msg = summaries[i];
    if (!msg) continue;
    lines.push(
      `  ${i + 1}. claims-from=${plainText(msg.senderClaim.claimedAddress || '(unknown)')}` +
      ` [${SENDER_CONFIDENCE_LABEL[msg.senderClaim.displayedConfidence]}]` +
      ` subject=${plainText(msg.subject || '(none)')} date=${plainText(msg.date || '(none)')}`,
    );
  }

  // Wire in body preview for the newest message (MIN-2)
  const newest = summaries[0];
  if (newest?.bodyPreview) {
    const preview = newest.bodyPreview
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 2)
      .join(' … ');
    if (preview) {
      lines.push(`  newest: ${plainText(newest.senderClaim.display)}`);
      lines.push(`  preview: ${plainText(preview)}`);
    }
  }
  return lines.join('\n');
}

async function listMail(ctx: CommandContext, count: number): Promise<string> {
  const summaries = await (await buildEmailService(ctx)).checkInbox(count);
  return summaries.length === 0 ? 'Inbox: no unread messages.' : formatInboxSummaries(summaries);
}

async function inboxRows(ctx: CommandContext): Promise<readonly ListRow[]> {
  const { messages } = await (await buildEmailService(ctx)).listInbox({ limit: 30, unreadOnly: false });
  return messages.map((message) => ({
    value: String(message.uid), label: plainText(message.subject || '(no subject)'), detail: plainText(message.senderClaim.claimedAddress || '(unknown)'),
    ...(message.unread ? { state: 'unread' } : {}),
  }));
}

async function readMail(ctx: CommandContext, uid: number): Promise<string> {
  const message = await (await buildEmailService(ctx)).readMessage(uid);
  if (!message) throw commandRefusal(`No message ${uid} is in the mailbox.`, '/mail list shows the messages');
  const attachments = message.attachments.map((entry) => `${plainText(entry.filename)} (${entry.sizeBytes} bytes)`);
  return [
    `From:    ${plainText(message.from)} (a claim from the message header)`,
    `Subject: ${plainText(message.subject)}`,
    `Date:    ${plainText(message.date)}`,
    ...(attachments.length > 0 ? [`Files:   ${attachments.join(', ')}`] : []),
    '',
    // The body keeps its lines; each line loses control characters and direction overrides.
    message.bodyText.trim()
      ? message.bodyText.trimEnd().split('\n').map(plainText).join('\n')
      : message.bodyUnavailable
        ? `The body could not be fetched: ${plainText(message.bodyUnavailable.map((entry) => entry.reason).join('; '))}; read it again with /mail read ${uid}.`
        : '(no plain-text body)',
  ].join('\n');
}

async function draftMail(ctx: CommandContext, message: MailMessage): Promise<string> {
  const result = await (await buildEmailService(ctx)).createDraft(message);
  return `Draft saved to the account (${result.uid !== null ? `uid ${result.uid}` : `folder ${result.mailbox}`}). Nothing was sent.`;
}

/** One send of a message: the Message-ID every repeat of it carries, and whether it was confirmed sent. */
interface MailSendAttempt {
  readonly messageIdLocalPart: string;
  sent: boolean;
}

/** Each message (recipient, subject and body) this process has sent or tried to send. */
const sendAttempts = new Map<string, MailSendAttempt>();

async function sendMail(ctx: CommandContext, message: MailMessage, again: boolean): Promise<string> {
  const fingerprint = JSON.stringify([message.to, message.subject, message.body]);
  const earlier = sendAttempts.get(fingerprint);
  if (earlier?.sent && !again) {
    throw commandRefusal('This exact message was already sent from this session, so it was not sent again.',
      'Check the Sent folder first; to send another copy choose "Send it again" (/mail send ... --again)');
  }
  // A message not yet confirmed sent keeps its Message-ID on every repeat, --again included, so a
  // recipient's mail program sees one message; only a new copy of a sent one gets a new id.
  const attempt = earlier && !earlier.sent ? earlier : { messageIdLocalPart: `gv.${randomUUID().replaceAll('-', '')}`, sent: false };
  sendAttempts.set(fingerprint, attempt);
  // The registry has asked the owner by now (the description marks a send as sending something out).
  try {
    await (await buildEmailService(ctx)).sendMail({ ...message, confirm: true, messageIdLocalPart: attempt.messageIdLocalPart });
  } catch (error) {
    if (error instanceof SmtpDeliveryUnconfirmedError) {
      throw commandRefusal(`The send was not confirmed; it may have gone (${error.message}).`,
        'Check the Sent folder; sending it again with /mail send repeats the same message under the same Message-ID', 'COMMAND_FAILED');
    }
    throw error;
  }
  attempt.sent = true;
  return `Email sent to ${message.to} with subject "${message.subject}".`;
}

async function formatConfig(ctx: CommandContext): Promise<string> {
  const cm = await getConfigManager(ctx);
  const status = readMailboxStatus((key) => cm.get(key));
  const { settings } = status;
  const lines = [
    'Email Config (surfaces.email.*)',
    `  imap.host:     ${settings.imapHost ?? '[not set]'}`,
    `  imap.port:     ${settings.imapPort}`,
    `  imap.secure:   ${String(settings.imapSecure)}`,
    `  imap.mailbox:  ${settings.mailbox ?? 'INBOX'}`,
    `  smtp.host:     ${settings.smtpHost ?? '[not set]'}`,
    `  smtp.port:     ${settings.smtpPort}`,
    `  smtp.secure:   ${String(settings.smtpSecure)} (true: implicit TLS on 465; false: STARTTLS on 587)`,
    `  user:          ${settings.username ?? '[not set]'}`,
    `  password:      ${status.passwordStored ? '[stored]' : '[not set]'}`,
    `  from:          ${settings.fromAddress ?? '[not set]'}`,
    '',
    '  host sets IMAP and SMTP together; imap.host and smtp.host override it.',
    '  /mail set <setting> <value> changes one; /mail password stores the password.',
  ];
  return lines.join('\n');
}

/** The routed writer for the daemon-owned mailbox keys: one writer, the connected host. */
function mailboxWriter(ctx: CommandContext) {
  const cm = ctx.platform.configManager as unknown as { get: (key: string) => unknown; setDynamic: (key: string, value: unknown) => void };
  const homeDir = requireShellPaths(ctx).homeDirectory;
  return { cm, write: (key: string, value: unknown) => routeConfigWrite(ctx.platform.configManager, key, value, { homeDir }) };
}

async function setMailboxField(ctx: CommandContext, rawField: string, value: string): Promise<string> {
  const field = resolveMailboxField(rawField);
  if (field === null || field === 'password') throw commandRefusal(`${rawField} is not a mailbox setting this action changes.`, '/mail settings lists them; /mail password stores the password');
  const configKey = MAILBOX_FIELDS[field];
  const { cm, write } = mailboxWriter(ctx);
  let result: Awaited<ReturnType<typeof persistMailboxField>>;
  try {
    result = await persistMailboxField(cm, requireSecretsManager(ctx), field, value, write);
  } catch (error) {
    throw commandRefusal(`${configKey} was not changed: ${summarizeError(error)}`);
  }
  if (!result.ok) throw commandRefusal(`${configKey} was not changed: ${result.error ?? 'the value was refused'}`, undefined, 'COMMAND_FAILED');
  // The value the write reports the connected host holding now, not this process's local copy.
  return `${configKey} is now ${String(result.value)}.`;
}

async function storeMailboxPassword(ctx: CommandContext, password: string): Promise<string> {
  const { cm, write } = mailboxWriter(ctx);
  const result = await persistMailboxField(cm, requireSecretsManager(ctx), 'password', password, write);
  if (!result.ok) throw commandRefusal(result.error ?? 'The mailbox password could not be stored.', undefined, 'COMMAND_FAILED');
  return `The mailbox password is stored as a secret (reference ${(result.secretRef ?? '').slice(0, 40)}...); settings hold only the reference.`;
}

/** Turn a mail error into a refusal that says it in plain words, never a raw exception. */
async function plainly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (readRefusal(error)) throw error;
    throw commandRefusal(`Email error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
  }
}

export function registerEmailRuntimeCommands(registry: CommandRegistry): void {
  registerMailCommand<CommandContext>(registry, {
    status: (ctx) => plainly(() => formatStatus(ctx)),
    list: (ctx, count) => plainly(() => listMail(ctx, count)),
    inbox: (ctx) => inboxRows(ctx),
    read: (ctx, uid) => plainly(() => readMail(ctx, uid)),
    draft: (ctx, message) => plainly(() => draftMail(ctx, message)),
    send: (ctx, message, again) => plainly(() => sendMail(ctx, message, again)),
    settings: (ctx) => plainly(() => formatConfig(ctx)),
    setField: (ctx, field, value) => plainly(() => setMailboxField(ctx, field, value)),
    setPassword: (ctx, password) => plainly(() => storeMailboxPassword(ctx, password)),
  });
}
