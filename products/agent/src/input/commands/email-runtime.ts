/**
 * /email command, direct email access via IMAP/SMTP.
 *
 * Subcommands:
 *   status                                        Show config readiness (redacted, no secrets)
 *   config                                        Show current mailbox settings (password redacted)
 *   set <field> <value> [--yes]                   Set a mailbox setting; --yes required for the password
 *   check [n]                                     List up to n unread inbox summaries (default 10);
 *                                                  includes a 2-line body preview of the newest message
 *   send --yes <to> <subject words> -- <body words>  Send a plain-text email; preview without --yes
 *                                                  (--yes before the recipient; inside the text it is text)
 *
 * Settable fields (email-settings.ts), each a `surfaces.email.*` setting, the
 * mailbox the daemon reads too:
 *   host, imap.host, imap.port, imap.secure, imap.mailbox, smtp.host, smtp.port,
 *   smtp.secure, user, from, password (requires --yes)
 *
 * Safety policy:
 *   - All inbox reads use EXAMINE (read-only); unread status is never modified.
 *   - Sending requires explicit --yes; previews are shown without it.
 *   - No credential values are ever printed; the password is displayed as [stored].
 *   - The password goes to the secret store; settings.json holds only a
 *     goodvibes:// reference.
 */

import type { CommandRegistry } from '../command-registry.ts';
import { getSessionUntrustedContentLedger } from '../../trust/untrusted-content.ts';
import { describeSenderClaim, type DisplayedSenderConfidence } from '../../agent/untrusted-content.ts';
import type { CommandContext } from '../command-registry.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal, requireYesFlag, stripLeadingYesFlag, stripYesFlag } from './confirmation.ts';
import { EmailService } from '@goodvibes-jev/engine/platform/platform/email';
import { nodeEmailTransport } from '@goodvibes-jev/engine/platform/platform/email/node';
import { requireSecretsManager, requireShellPaths } from './runtime-services.ts';
import { openEffectiveConfigView, routeConfigWrite } from '../../config/daemon-config-routing.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils/native-error-summary';
import { LOCAL_WRITE_VERB, OUTWARD_VERB, READ_VERB, ownerOnlyVerb, withCommandVerbs, type CommandVerbs } from './command-verbs.ts';
import {
  MAILBOX_CREDENTIAL_FIELDS,
  MAILBOX_FIELDS,
  MAILBOX_FIELD_LIST,
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

function readLimitArg(arg: string | undefined, fallback: number): number {
  if (!arg) return fallback;
  const n = parseInt(arg, 10);
  return isFinite(n) && n > 0 ? Math.min(n, 100) : fallback;
}

/**
 * The mailbox settings as the connected host holds them (they are daemon-owned,
 * so the form, `/email set` and the host's scheduled sends all see one value):
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

async function formatStatus(ctx: CommandContext): Promise<void> {
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
  lines.push('  Usage: /email set <field> <value> [--yes], see /email config');
  ctx.print(lines.join('\n'));
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

async function handleCheck(
  args: readonly string[],
  ctx: CommandContext,
): Promise<void> {
  const limit = readLimitArg(args[0], 10);
  const service = await buildEmailService(ctx);
  const summaries = await service.checkInbox(limit);

  if (summaries.length === 0) {
    ctx.print('Inbox: no unread messages.');
    return;
  }
  ctx.print(formatInboxSummaries(summaries));
}

/**
 * Parse send args with optional body separator.
 * Format: <to> <subject words...> [-- <body words...>]
 * Returns { to, subject, body } or null if to/subject are missing.
 */
function parseSendArgs(args: readonly string[]): { to: string; subject: string; body: string } | null {
  const to = args[0];
  if (!to) return null;

  const rest = args.slice(1);
  const sepIdx = rest.indexOf('--');

  let subjectParts: string[];
  let bodyParts: string[];

  if (sepIdx === -1) {
    subjectParts = rest;
    bodyParts = [];
  } else {
    subjectParts = rest.slice(0, sepIdx);
    bodyParts = rest.slice(sepIdx + 1);
  }

  const subject = subjectParts.join(' ').trim();
  if (!subject) return null;

  const body = bodyParts.join(' ').trim();
  return { to, subject, body };
}

async function formatConfig(ctx: CommandContext): Promise<void> {
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
    `  Settable fields: ${MAILBOX_FIELD_LIST} (password needs --yes)`,
    '  host sets IMAP and SMTP together; imap.host and smtp.host override it.',
    '  Usage: /email set <field> <value> [--yes]',
  ];
  ctx.print(lines.join('\n'));
}

async function handleSet(
  args: readonly string[],
  ctx: CommandContext,
): Promise<void> {
  const parsed = stripYesFlag(args);
  const rawArgs = [...parsed.rest];

  const rawKey = rawArgs[0];
  const rawValue = rawArgs.slice(1).join(' ');

  if (!rawKey) {
    throw commandRefusal(`Usage: /email set <field> <value> [--yes]\nFields: ${MAILBOX_FIELD_LIST} (password needs --yes)`);
  }

  // Accepts `imap.host`, `surfaces.email.imap.host`, and the older `imapHost`.
  const field = resolveMailboxField(rawKey);
  if (field === null) {
    throw commandRefusal(`Unknown mailbox field: ${rawKey}\nFields: ${MAILBOX_FIELD_LIST} (password needs --yes)`);
  }
  const configKey = MAILBOX_FIELDS[field];

  // The mailbox password is taken through the masked prompt when the terminal has
  // one, so it is never typed into the command line or kept in input history.
  const maskedPasswordEntry = field === 'password' && rawValue === '' && ctx.beginConcealedInput !== undefined;
  if (rawValue === '' && !maskedPasswordEntry) {
    throw commandRefusal(`Usage: /email set ${configKey} <value>\nValue is required.`);
  }

  const cm = ctx.platform.configManager as unknown as {
    get: (key: string) => unknown;
    setDynamic: (key: string, value: unknown) => void;
  };
  // The mailbox keys are daemon-owned: one writer, the connected host, reached by the routed write.
  const homeDir = requireShellPaths(ctx).homeDirectory;
  const writeRouted = (key: string, value: unknown) => routeConfigWrite(ctx.platform.configManager, key, value, { homeDir });

  if (field === 'password') {
    // Secret path: --yes is required; raw value is routed through SecretsManager
    if (!parsed.yes) {
      const lines = [
        'Email Password Set Preview',
        `  key: ${configKey}`,
        '  value: [redacted, raw password will be stored as a secure secret]',
        '  policy: the raw password is never written to settings.json; only a',
        '          goodvibes:// reference is stored there',
      ];
      ctx.print(lines.join('\n'));
      requireYesFlag(
        ctx,
        'store the mailbox password',
        ctx.beginConcealedInput === undefined ? '/email set password <password> --yes' : '/email set password --yes (the password is then asked for masked)',
      );
      return;
    }

    const secretsManager = requireSecretsManager(ctx);
    const storePassword = async (password: string): Promise<void> => {
      const result = await persistMailboxField(cm, secretsManager, field, password, writeRouted);
      if (!result.ok) {
        throw commandRefusal(result.error ?? `Could not store ${configKey}.`, undefined, 'COMMAND_FAILED');
      }
      ctx.print(
        `Email config updated\n` +
        `  key:  ${configKey}\n` +
        `  value: [stored as secret; reference: ${(result.secretRef ?? '').slice(0, 40)}...]\n` +
        '  policy: raw password stored in secrets manager; settings.json contains only the goodvibes:// ref',
      );
    };
    if (maskedPasswordEntry) {
      ctx.print('[email] Enter the mailbox password (masked), Enter to store, Esc to stop.');
      ctx.beginConcealedInput?.({
        label: 'Email password',
        onSubmit: async (value) => {
          if (value.length === 0) {
            ctx.print('[email] No password entered; nothing was stored.');
            return;
          }
          await storePassword(value);
        },
        onCancel: () => { ctx.print('[email] Stopped. Nothing was stored.'); },
      });
      return;
    }
    if (ctx.beginConcealedInput !== undefined) {
      ctx.print('Note: the password was typed on the command line and may be kept in input history. Next time run /email set password --yes to enter it masked.');
    }
    await storePassword(rawValue);
    return;
  }

  // Non-secret path: coerce, validate, and persist through the shared field helper
  const secretsManager = requireSecretsManager(ctx);
  let result: Awaited<ReturnType<typeof persistMailboxField>>;
  try {
    result = await persistMailboxField(cm, secretsManager, field, rawValue, writeRouted);
  } catch (error) {
    throw commandRefusal(`${configKey} was not changed: ${summarizeError(error)}`);
  }
  if (!result.ok) {
    throw commandRefusal(`${configKey} was not changed: ${result.error ?? 'the value was refused'}`, undefined, 'COMMAND_FAILED');
  }
  // The value the write reports the connected host holding now, not this process's local copy.
  ctx.print(`Email config updated\n  key:   ${configKey}\n  value: ${String(result.value)}`);
}

async function handleSend(
  args: readonly string[],
  ctx: CommandContext,
): Promise<void> {
  // --yes is read only before the recipient: the same word in the subject or body is text and is sent.
  const parsed = stripLeadingYesFlag(args, 0);
  const remaining = [...parsed.rest];

  const sendArgs = parseSendArgs(remaining);
  if (!sendArgs) {
    throw commandRefusal('Usage: /email send --yes <to> <subject words...> [-- <body words...>]\nRecipient and subject are required; --yes goes before the recipient.');
  }

  const { to, subject, body } = sendArgs;

  if (!parsed.yes) {
    const lines = [
      'Email Send Preview',
      `  to: ${to}`,
      `  subject: ${subject}`,
      `  body: ${body || '(empty)'}`,
      '  policy: this is a preview; rerun with --yes before the recipient to send',
    ];
    ctx.print(lines.join('\n'));
    requireYesFlag(ctx, `send email to ${to}`, `/email send --yes ${to} ${subject}${body ? ` -- ${body}` : ''}`);
    return;
  }

  const service = await buildEmailService(ctx);
  await service.sendMail({
    to,
    subject,
    body,
    confirm: true,
  });
  ctx.print(`Email sent to ${to} with subject "${subject}"`);
}

/**
 * The mail settings that decide where the stored password is presented and
 * how: re-pointing them sends the owner's credential somewhere else, so only
 * the owner's own keystrokes count.
 */
const EMAIL_SERVER_SET = ownerOnlyVerb('credential', 'changes where or as whom the stored mail password is presented, or stores the password');

const EMAIL_VERBS: CommandVerbs = {
  defaultVerb: 'status',
  verbs: {
    status: READ_VERB,
    config: READ_VERB,
    check: OUTWARD_VERB,
    send: OUTWARD_VERB,
    set: (rest) => {
      const key = (rest.find((arg) => !arg.startsWith('-')) ?? '').trim();
      const field = resolveMailboxField(key);
      return field !== null && MAILBOX_CREDENTIAL_FIELDS.has(field) ? EMAIL_SERVER_SET : LOCAL_WRITE_VERB;
    },
  },
  otherwise: READ_VERB,
};

/**
 * Where a `/email set password <value>` line holds the password, under any
 * spelling of the field (`password`, `email.passwordRef`, ...): every word of
 * the value, which `handleSet` joins with spaces.
 */
function mailboxPasswordPositions(args: readonly string[]): number[] {
  if ((args[0] ?? '').trim().toLowerCase() !== 'set') return [];
  const words: number[] = [];
  for (let index = 1; index < args.length; index++) if (args[index] !== '--yes') words.push(index);
  const key = words[0] === undefined ? '' : args[words[0]]!;
  return resolveMailboxField(key) === 'password' ? words.slice(1) : [];
}

export function registerEmailRuntimeCommands(registry: CommandRegistry): void {
  registry.register(withCommandVerbs({
    name: 'email',
    effect: 'external-network',
    aliases: [],
    description: 'Direct IMAP/SMTP email: configure, check inbox, or send a confirmed message',
    usage: 'status | config | set <key> <value> [--yes] | check [n] | send --yes <to> <subject...> [-- <body...>]',
    argsHint: 'status|config|set|check|send',
    secretArgs: { select: mailboxPasswordPositions },
    async handler(args, ctx) {
      const sub = (args[0] ?? 'status').trim().toLowerCase();

      try {
        if (sub === 'status') {
          await formatStatus(ctx);
          return;
        }

        if (sub === 'config') {
          await formatConfig(ctx);
          return;
        }

        if (sub === 'set') {
          await handleSet(args.slice(1), ctx);
          return;
        }

        if (sub === 'check') {
          await handleCheck(args.slice(1), ctx);
          return;
        }

        if (sub === 'send') {
          await handleSend(args.slice(1), ctx);
          return;
        }

        throw commandRefusal('Usage: /email status | config | set <key> <value> [--yes] | check [n] | send --yes <to> <subject...> [-- <body...>]');
      } catch (err) {
        // MIN-3: print config/validation errors as plain language, never a raw exception
        if (readRefusal(err)) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        throw commandRefusal(`Email error: ${msg}`, undefined, 'COMMAND_FAILED');
      }
    },
  }, EMAIL_VERBS));
}
