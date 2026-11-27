/**
 * Mail, calendar and channels: the daemon's one mailbox, one calendar and one
 * set of channels. Every capability here runs in the daemon.
 *
 *  - The calendar's events and the channels run through the daemon method
 *    that already does the act (method-capability.ts: `calendar.events.*`,
 *    `channels.*`); the method keeps its own effects, confirmation and repeat,
 *    and `said` words its answer.
 *  - The mailbox and the days ahead of the calendar are handlers that call
 *    that same method as the caller (`caller.method`: `email.*`,
 *    `calendar.events.list`) and say what it came to: a message's text, the
 *    inbox, a send under one id per message.
 *  - The mailbox settings and password have no method of their own; their
 *    handlers write the daemon's own settings (`surfaces.email.*`, which every
 *    program reads from the daemon's settings file) and its secret store.
 *
 * Lists an input chooses from (`mail.inbox`, `calendar.events`, `channels`,
 * `channels.profiles`) stay registered in terminal-shell under these names.
 */
import { createHash, randomUUID } from 'node:crypto';
import { persistSecretBackedConfigValue } from '../../config/secret-backed-config.js';
import type { ConfigKey } from '../../config/schema-types.js';
import { createSurfaceEmailConfigReader, readEmailConfig, readSurfaceEmailSettings, validateEmailConfig } from '../../email/index.js';
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type FixedChoice, type InputDescription, type ListName } from '../types.js';
import type { MethodCapabilityDefinition } from './method-capability.js';
import { CHANNEL_STATE_WORDS, channelReasonOf, channelStateOf } from '../../channels/channel-state.js';
import { getBuiltinSetupSchema } from '../../channels/builtin/setup-schema.js';
import type { ChannelSetupFieldDescriptor, ChannelSetupSchema, ChannelSurface } from '../../channels/types.js';
import { SESSION_GATE_PRESET_NAMES, gatePresetLabel } from '../../gate/presets.js';

// ── The lists inputs choose from (registered in terminal-shell) ──────────────

export const MAIL_INBOX_LIST = 'mail.inbox' as ListName;
export const CALENDAR_EVENTS_LIST = 'calendar.events' as ListName;
export const CHANNELS_LIST_NAME = 'channels' as ListName;
export const CHANNEL_PROFILES_LIST = 'channels.profiles' as ListName;
/** The registered projects "Project for this channel" chooses from. */
export const CHANNEL_PROJECTS_LIST = 'channels.projects' as ListName;

const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;

function text(id: string, label: string, help: string, why: string, typed: InputDescription['typed'], options: { readonly kind?: InputDescription['kind']; readonly optional?: { readonly default: string; readonly means: string }; readonly step?: number } = {}): InputDescription {
  return {
    id, label, help, kind: options.kind ?? 'text', freeTextReason: why,
    required: options.optional ? { default: options.optional.default, defaultMeans: options.optional.means } : true,
    typed, ...(options.step ? { step: options.step } : {}),
  };
}

function listed(id: string, label: string, help: string, list: ListName, options: { readonly other?: string; readonly optional?: { readonly default: string; readonly means: string }; readonly position?: 1 | 2; readonly step?: number } = {}): InputDescription {
  return {
    id, label, help, kind: 'choice',
    choices: { list, ...(options.other ? { allowOther: { reason: options.other } } : {}) },
    required: options.optional ? { default: options.optional.default, defaultMeans: options.optional.means } : true,
    typed: { position: options.position ?? 1 }, ...(options.step ? { step: options.step } : {}),
  };
}

// ── Mail ─────────────────────────────────────────────────────────────────────

const TO = text('to', 'To', 'Who it goes to: an address, or several separated by commas', 'an email address', { position: 1 });
const SUBJECT = text('subject', 'Subject', 'The subject line', 'your own words', { flag: '--subject' });
const BODY = text('body', 'Message', 'What it says', 'your own words', { tail: true }, { kind: 'long-text' });

/**
 * The daemon method a mail capability's act is, run as the caller of `capabilities.run` (its own admission and
 * confirmation apply). Every door to a daemon capability goes through `capabilities.run`, which sets it.
 */
function methodOf(caller: CapabilityCaller, what = 'Mail'): NonNullable<CapabilityCaller['method']> {
  if (!caller.method) throw new CapabilityRefusal(`${what} is the daemon's, and this run did not come through it, so nothing was done.`);
  return caller.method;
}

/** A header or body a stranger wrote, with its control characters and direction overrides taken out. */
function plainMail(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ') : '';
}
const oneLine = (value: unknown, width: number): string => {
  const flat = plainMail(value).replace(/\s+/g, ' ').trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
};
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export const MAIL_STATUS: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.status', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'status', word: 'status', label: 'See whether mail is connected', inputs: [], ...READ,
  sentence: 'Shows whether the mailbox is set up and reachable, and what to do next if not.', example: {},
  async run(_values, services, caller) {
    const settings = await MAIL_SETTINGS.run({}, services, caller);
    // Reachable: the daemon reads one message summary from the inbox (read-only), and says why when it cannot.
    let reachable = false;
    let said: string;
    // Why it is not reachable, by the refusal's own code and status, so a screen names the next step (set it up, replace
    // the password, the store could not be read) without reading the inbox itself and drawing that refusal.
    let failure: { code?: string; status?: number; message: string } | undefined;
    try {
      await methodOf(caller)('email.inbox.list', { limit: 1 });
      reachable = true;
      said = 'Reachable: yes, the inbox answered.';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = (error as { readonly code?: unknown } | null)?.code;
      const status = (error as { readonly status?: unknown } | null)?.status;
      failure = { message, ...(typeof code === 'string' ? { code } : {}), ...(typeof status === 'number' ? { status } : {}) };
      said = `Reachable: no. ${message}`;
    }
    return { text: `${settings.text}\n${said}`, data: { ...(settings.data ?? {}), reachable, ...(failure ? { failure } : {}) } };
  },
};

export const MAIL_LIST: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.list', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'list', word: 'list', label: 'Check your email inbox', ...READ,
  inputs: [{ id: 'count', label: 'How many', help: 'How many of the newest messages', kind: 'number', required: { default: '15', defaultMeans: 'the newest 15' }, typed: { position: 1 } }],
  sentence: 'Lists the newest email in your inbox, who it is from and its subject; nothing is marked read.', example: { count: '30' },
  async run(values, services, caller) {
    const count = Number(values.count ?? '15');
    if (!Number.isFinite(count) || count <= 0) throw new CapabilityRefusal(`How many: "${values.count}" is not a number of messages.`);
    let answer: unknown;
    try {
      answer = await methodOf(caller)('email.inbox.list', { limit: Math.min(100, Math.floor(count)) });
    } catch (error) {
      // A mailbox never set up is not a failed read: it says so, and what it still needs, naming no setting.
      const code = (error as { readonly code?: unknown } | null)?.code;
      if (code === 'EMAIL_NOT_CONFIGURED') return { text: 'Mail is not set up: no mail server and user name are set.', data: { setUp: false, missing: 'mailbox', messages: [] } };
      if (code === 'EMAIL_CREDENTIALS_MISSING') {
        // The server and user name set already, so setting mail up asks only for the password.
        const settings = readSurfaceEmailSettings((key) => services.mailbox.get(key));
        return { text: 'Mail is not set up: its password is not stored.', data: { setUp: false, missing: 'password', server: settings.imapHost ?? '', user: settings.username ?? '', messages: [] } };
      }
      throw error;
    }
    const body = isRecord(answer) ? answer : {};
    const listed = Array.isArray(body['messages']) ? body['messages'].filter(isRecord) : [];
    const unreadable = Array.isArray(body['unreadable']) ? body['unreadable'].filter(isRecord) : [];
    const total = typeof body['total'] === 'number' ? body['total'] : undefined;
    const lines = listed.length === 0
      ? [unreadable.length > 0 ? 'No message on this page could be shown.' : 'The inbox is empty.']
      : [`The inbox: ${listed.length} message${listed.length === 1 ? '' : 's'}${total !== undefined && total > listed.length ? ` of ${total}` : ''}, newest first (nothing is marked read; a sender is what the message claims):`,
        ...listed.map((message) => `  ${message['unread'] === true ? '●' : ' '} ${String(message['uid']).padStart(6)}  ${oneLine(message['from'], 28).padEnd(28)}  ${message['triageLabel'] === 'spam' ? '[spam] ' : message['triageLabel'] === 'priority' ? '[priority] ' : ''}${message['screening'] === 'not-screened' ? '[not screened] ' : ''}${oneLine(message['subject'], 48) || '(no subject)'}`)];
    if (unreadable.length > 0) lines.push(`${unreadable.length} message${unreadable.length === 1 ? '' : 's'} on this page could not be read and ${unreadable.length === 1 ? 'is' : 'are'} not shown; nothing was deleted.`);
    return {
      text: lines.join('\n'),
      data: {
        setUp: true,
        messages: listed.map((message) => ({
          uid: message['uid'], from: plainMail(message['from']), subject: plainMail(message['subject']), date: plainMail(message['date']), unread: message['unread'] === true,
          // What the place's inbox shows of a message (messages-place.ts): its preview and the daemon's labels.
          ...(typeof message['bodyPreview'] === 'string' ? { bodyPreview: plainMail(message['bodyPreview']) } : {}),
          ...(typeof message['triageLabel'] === 'string' ? { triageLabel: message['triageLabel'] } : {}),
          ...(message['screening'] === 'not-screened' ? { screening: 'not-screened', screeningReason: plainMail(message['screeningReason']) } : {}),
        })),
        ...(total !== undefined ? { total } : {}), unreadable: unreadable.length,
      },
    };
  },
};

export const MAIL_READ: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.read', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'read', word: 'read', label: 'Read a message', ...READ,
  inputs: [listed('message', 'Message', 'The newest messages in the inbox', MAIL_INBOX_LIST, { other: 'a message number from the inbox' })],
  sentence: 'Shows message {message} with its sender, subject and text.', example: { message: '4211' },
  async run(values, _services, caller) {
    const uid = Number(values.message);
    if (!Number.isInteger(uid) || uid <= 0) throw new CapabilityRefusal(`"${values.message}" is not a message in the inbox.`, 'Choose one from the inbox');
    const answer = await methodOf(caller)('email.inbox.read', { uid });
    const message = isRecord(answer) ? answer : {};
    const attachments = Array.isArray(message['attachments']) ? message['attachments'].filter(isRecord) : [];
    const unavailable = Array.isArray(message['bodyUnavailable']) ? message['bodyUnavailable'].filter(isRecord) : [];
    const bodyText = plainMail(message['bodyText']);
    return {
      text: [
        `From:    ${oneLine(message['from'], 200)} (as the message says)`,
        `Subject: ${oneLine(message['subject'], 200)}`,
        `Date:    ${oneLine(message['date'], 80)}`,
        ...(attachments.length > 0 ? [`Files:   ${attachments.map((entry) => `${oneLine(entry['filename'], 80)} (${String(entry['sizeBytes'])} bytes)`).join(', ')}`] : []),
        '',
        bodyText.trim()
          ? bodyText.trimEnd()
          : unavailable.length > 0
            ? `The text could not be fetched: ${unavailable.map((entry) => plainMail(entry['reason'])).join('; ')}. Reading it again may work.`
            : '(no plain-text body)',
      ].join('\n'),
      data: { uid, from: plainMail(message['from']), subject: plainMail(message['subject']), date: plainMail(message['date']), attachments: attachments.length },
    };
  },
};

export const MAIL_DRAFT: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.draft', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'draft', word: 'draft', label: 'Save a draft', inputs: [TO, SUBJECT, BODY],
  sentence: 'A draft to {to}, "{subject}": "{body}", is kept in the account\'s Drafts folder until you change it; nothing is sent.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  example: { to: 'sam@example.com', subject: 'Build is green', body: 'All gates passed.' },
  async run(values, _services, caller) {
    const answer = await methodOf(caller)('email.draft.create', { to: values.to!, subject: values.subject!, body: values.body! });
    const result = isRecord(answer) ? answer : {};
    const where = typeof result['uid'] === 'number' ? `message ${result['uid']} in ${String(result['mailbox'] ?? 'Drafts')}` : `the ${String(result['mailbox'] ?? 'Drafts')} folder`;
    return { text: `The draft is kept as ${where}. Nothing was sent.`, data: { draftId: result['draftId'], mailbox: result['mailbox'], ...(typeof result['uid'] === 'number' ? { uid: result['uid'] } : {}) } };
  },
};

/**
 * One id per message (recipients, subject, text) and ten-minute window: the daemon answers a repeat within ten
 * minutes with the first send instead of mailing again (the id is also the Message-ID, so a later send of the same
 * words is a message of its own).
 */
function sendIdOf(values: Readonly<Record<string, string>>): string {
  const digest = createHash('sha256').update(JSON.stringify([values.to, values.subject, values.body])).digest('hex').slice(0, 40);
  // "Send it again" is a new copy, under a new id.
  if (values.again === 'yes') return `gv-${digest.slice(0, 16)}-${randomUUID().replaceAll('-', '')}`;
  return `gv-${digest}-${Math.floor(Date.now() / 600_000)}`;
}

export const MAIL_SEND: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.send', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'send', word: 'send', label: 'Send a message',
  inputs: [TO, SUBJECT, BODY,
    { id: 'again', label: 'Already sent', help: 'Whether to send another copy when this exact message was sent in the last ten minutes', kind: 'choice',
      choices: [{ value: 'no', label: 'Do not send it twice' }, { value: 'yes', label: 'Send it again' }],
      required: { default: 'no', defaultMeans: 'do not send it twice' }, typed: { flag: '--again', switchOn: 'yes' } }],
  sentence: 'This goes to {to} and cannot be recalled: "{subject}": "{body}".', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
  example: { to: 'sam@example.com', subject: 'Build is green', body: 'All gates passed.' },
  async run(values, _services, caller) {
    let answer: unknown;
    try {
      answer = await methodOf(caller)('email.send', { to: values.to!, subject: values.subject!, body: values.body!, confirm: true, clientSendId: sendIdOf(values) });
    } catch (error) {
      const code = (error as { readonly code?: unknown } | null)?.code;
      if (code === 'EMAIL_DELIVERY_UNCONFIRMED') {
        throw new CapabilityRefusal(`The send was not confirmed; it may have gone (${error instanceof Error ? error.message : String(error)}).`,
          'Look in the Sent folder; sending the same message again within ten minutes does not deliver it twice');
      }
      throw error;
    }
    const result = isRecord(answer) ? answer : {};
    // The time it went, as a person reads it (a repeat within ten minutes answers with the first send's time).
    const at = new Date(String(result['sentAt'] ?? ''));
    const when = Number.isNaN(at.getTime()) ? '' : ` at ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
    // A repeat inside the window: the daemon answered with the first send and nothing left this machine now, so no
    // line says something was sent.
    if (result['repeated'] === true) {
      return { text: `Already sent to ${values.to}${when}; nothing was sent again.`, riskDone: '', data: { messageId: result['messageId'], sentAt: result['sentAt'], repeated: true } };
    }
    return { text: `Sent to ${values.to}${when}.`, data: { messageId: result['messageId'], sentAt: result['sentAt'] } };
  },
};

/** The mailbox settings, by the name a person picks, and the setting each writes. */
export const MAILBOX_FIELDS = {
  host: 'surfaces.email.host',
  'imap.host': 'surfaces.email.imap.host',
  'imap.port': 'surfaces.email.imap.port',
  'imap.secure': 'surfaces.email.imap.secure',
  'imap.mailbox': 'surfaces.email.imap.mailbox',
  'smtp.host': 'surfaces.email.smtp.host',
  'smtp.port': 'surfaces.email.smtp.port',
  'smtp.secure': 'surfaces.email.smtp.secure',
  user: 'surfaces.email.user',
  from: 'surfaces.email.from',
} as const;
type MailboxField = keyof typeof MAILBOX_FIELDS;
const MAILBOX_PASSWORD_KEY = 'surfaces.email.password';

const CREDENTIAL = 'loosens-a-protection' as const;
/** What changing one of them did: where the password goes changed, which may as well be safer (TLS turned on) as looser. */
const CREDENTIAL_DONE = 'Your mail password is presented to the server, port and name set now, over TLS only where it is turned on.';
/** The mailbox settings as choices; those that decide where and as whom the password is presented are marked. */
export const MAILBOX_SETTING_CHOICES: readonly FixedChoice[] = [
  { value: 'host', label: 'Mail server (both IMAP and SMTP)', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'imap.host', label: 'IMAP server', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'imap.port', label: 'IMAP port', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'imap.secure', label: 'IMAP over TLS (true or false)', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'imap.mailbox', label: 'Mailbox to read' },
  { value: 'smtp.host', label: 'SMTP server', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'smtp.port', label: 'SMTP port', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'smtp.secure', label: 'SMTP over TLS from the start (true for 465, false for 587)', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'user', label: 'User name', risk: CREDENTIAL, riskDone: CREDENTIAL_DONE },
  { value: 'from', label: 'From address' },
];

/** The daemon's own settings and secret store, as the mailbox capabilities need them. */
export interface MessagesCapabilityServices {
  readonly mailbox: {
    /** One setting of the daemon's, as the daemon reads it. */
    get(key: string): unknown;
    /** Write one daemon setting (the mailbox keys are the daemon's). */
    set(key: string, value: unknown): void;
    /** Keep the mailbox password in the daemon's secret store; the setting holds only its reference. */
    storePassword(password: string): Promise<void>;
    /**
     * Sign in once over IMAP and over SMTP with what is set now, each whatever the other answered; nothing is read or
     * sent (email-service.ts `testEach`). Absent where the daemon was composed without mail.
     */
    test?: (() => Promise<MailboxCheck>) | undefined;
  };
  /** A chat channel's own settings (`surfaces.<channel>.*`, the daemon's) and its secret store, for "Enter a channel's keys". */
  readonly channelKeys?: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    /** Keep a secret in the daemon's secret store; the setting holds only its reference. */
    storeSecret(key: string, value: string): Promise<void>;
  } | undefined;
}

/** One half of a mailbox check: it worked, or why not (`failure` when a person acts on it differently). */
export interface MailboxCheckHalf {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly failure?: 'credentials-rejected' | 'unreachable' | undefined;
  readonly server?: string | undefined;
}

/** A mailbox checked once: a setting problem before anything was tried, or reading and sending each. */
export interface MailboxCheck {
  readonly config?: string | undefined;
  readonly reading?: MailboxCheckHalf | undefined;
  readonly sending?: MailboxCheckHalf | 'not-configured' | undefined;
}

/** A setting's stored form, or why it is not valid: a port is a whole number, a TLS answer true or false. */
function mailboxValue(field: MailboxField, raw: string): unknown {
  if (field === 'imap.port' || field === 'smtp.port') {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new CapabilityRefusal(`${raw} is not a port: give a whole number from 1 to 65535.`);
    return port;
  }
  if (field === 'imap.secure' || field === 'smtp.secure') {
    const lower = raw.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === 'tls') return true;
    if (lower === 'false' || lower === 'no' || (field === 'smtp.secure' && lower === 'starttls')) return false;
    throw new CapabilityRefusal(field === 'smtp.secure'
      ? `"${raw}" is not an answer: true for TLS from the start (port 465), false for STARTTLS (port 587).`
      : `"${raw}" is not an answer: true for TLS (port 993), false for a plain connection (local servers only).`);
  }
  return raw.trim();
}

function stored(get: (key: string) => unknown, key: string): boolean {
  const value = get(key);
  return typeof value === 'string' && value.trim().length > 0;
}

export const MAIL_SETTINGS: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.settings', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'settings', word: 'settings', label: 'See your mailbox settings', inputs: [], ...READ,
  sentence: 'Shows each mailbox setting; the password shows only as stored or not.', example: {},
  async run(_values, services) {
    const get = (key: string): unknown => services.mailbox.get(key);
    const settings = readSurfaceEmailSettings(get);
    const passwordStored = stored(get, MAILBOX_PASSWORD_KEY) || stored(get, 'surfaces.email.imap.password');
    const problems = [...validateEmailConfig(readEmailConfig(createSurfaceEmailConfigReader(get)))]
      .filter((problem) => !problem.startsWith('the mailbox password'));
    if (!passwordStored) problems.push('the mailbox password is not stored');
    const lines = [
      `IMAP server: ${settings.imapHost ?? 'not set'}, port ${settings.imapPort}, ${settings.imapSecure ? 'TLS' : 'plain'}`,
      `Mailbox read: ${settings.mailbox ?? 'INBOX'}`,
      `SMTP server: ${settings.smtpHost ?? 'not set'}, port ${settings.smtpPort}, ${settings.smtpSecure ? 'TLS from the start' : 'STARTTLS'}`,
      `User name: ${settings.username ?? 'not set'}`,
      `From address: ${settings.fromAddress ?? 'not set'}`,
      `Password: ${passwordStored ? 'stored' : 'not stored'}`,
      ...(problems.length > 0 ? [`Still needed: ${problems.join('; ')}.`] : ['Everything the mailbox needs is set.']),
    ];
    return {
      text: lines.join('\n'),
      data: {
        imapHost: settings.imapHost ?? null, imapPort: settings.imapPort, imapSecure: settings.imapSecure, mailbox: settings.mailbox ?? 'INBOX',
        smtpHost: settings.smtpHost ?? null, smtpPort: settings.smtpPort, smtpSecure: settings.smtpSecure,
        user: settings.username ?? null, from: settings.fromAddress ?? null, passwordStored, problems,
      },
    };
  },
};

export const MAIL_SET: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.set', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'set', word: 'set', label: 'Change a mailbox setting',
  inputs: [
    { id: 'setting', label: 'Setting', help: 'Which mailbox setting', kind: 'choice', choices: MAILBOX_SETTING_CHOICES, required: true, typed: { position: 1 } },
    text('value', 'Value', 'Its new value', 'a server name, port, address or name', { tail: true }),
  ],
  sentence: 'The mailbox setting {setting} becomes {value}, until you change it.', done: '',
  touches: 'this-machine', lasts: 'kept', risk: 'none',
  example: { setting: 'from', value: 'sam@example.com' },
  async run(values, services) {
    const field = values.setting as MailboxField;
    const key = MAILBOX_FIELDS[field];
    if (!key) throw new CapabilityRefusal(`${values.setting} is not a mailbox setting.`, 'The choices list every mailbox setting');
    const value = mailboxValue(field, values.value ?? '');
    services.mailbox.set(key, value);
    return { text: `${MAILBOX_SETTING_CHOICES.find((choice) => choice.value === field)?.label ?? field} is now ${String(services.mailbox.get(key) ?? value)}.`, data: { setting: field, key, value } };
  },
};

export const MAIL_PASSWORD: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.password', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'password', word: 'password', label: 'Store the mailbox password',
  inputs: [{ id: 'password', label: 'Password', help: 'The email account\'s password (an app password for Gmail); it goes to the secret store and is never shown', kind: 'secret', required: true, typed: { position: 1 } }],
  sentence: 'Your email mailbox password is kept in the secret store, until you change it; settings hold only a reference to it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none',
  // Writing a credential: the owner's alone, as `/mail password` was at v3.5.0; a model's call is put to the owner, opening on No
  // (never refused outright), and a password the model leaves out is typed by the person on the hidden line.
  ownerOnly: { reason: 'it stores the password the mailbox is opened with', instead: 'Mail status says whether a password is stored.' },
  effects: ['control-plane.write', 'secret.write'],
  example: {},
  async run(values, services) {
    const password = values.password ?? '';
    if (password.length === 0) throw new CapabilityRefusal('No password was given, so nothing was stored.');
    await services.mailbox.storePassword(password);
    return { text: 'The mailbox password is stored in the daemon\'s secret store; the settings hold only its reference.', data: { stored: true } };
  },
};

/** Why a half did not work, as one clause: the server's own words, or what is known when it said nothing. */
function mailboxReason(half: MailboxCheckHalf): string {
  const said = (half.error ?? '').trim().replace(/\.+$/, '');
  if (said) return said;
  return half.failure === 'credentials-rejected' ? 'the server refused the user name and password' : half.failure === 'unreachable' ? 'the server could not be reached' : 'the server gave no reason';
}

/** What to do for a half that did not work, by what failed. */
function mailboxFix(half: MailboxCheckHalf, what: 'reading' | 'sending'): string {
  if (half.failure === 'credentials-rejected') return 'Check the user name and the password (an account with two-step sign-in, Gmail among them, needs an app password), then set up mail again.';
  if (half.failure === 'unreachable') return `Check the server's name, and that it takes ${what === 'reading' ? 'IMAP (port 993 with TLS)' : 'SMTP (port 465 with TLS, or 587)'}; a port or TLS other than the usual is changed with "change a setting".`;
  return 'Check the server, the user name and the password; "mailbox settings" shows each setting and "change a setting" changes one.';
}

export const MAIL_SETUP: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'mail.setup', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'setup', word: 'setup', label: 'Set up mail',
  inputs: [
    text('server', 'Mail server', 'The server for reading and sending (imap.example.com, or one name for both)', 'a server name', { position: 1 }),
    text('user', 'User name', 'The account\'s user name, usually its address', 'an address or user name', { position: 2 }),
    { id: 'password', label: 'Password', help: 'The account\'s password (an app password for Gmail); it goes to the secret store and is never shown', kind: 'secret', required: true, typed: { flag: '--password' } },
    text('from', 'From address', 'The address your mail is sent from', 'an email address', { flag: '--from' }, { optional: { default: '', means: 'the user name, when it is an address' } }),
  ],
  sentence: 'Mail is read and sent through {server} as {user}, the password kept in the secret store; the mailbox is checked once (nothing is read or sent), until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none',
  // Writing a credential: a model's call is put to the owner, opening on No, and a password it leaves out is typed by
  // the person on the hidden line.
  effects: ['control-plane.write', 'secret.write'],
  example: { server: 'mail.example.com', user: 'sam@example.com' },
  async run(values, services) {
    const server = (values.server ?? '').trim();
    const user = (values.user ?? '').trim();
    const password = values.password ?? '';
    if (!server) throw new CapabilityRefusal('Nothing was set: the mail server is empty.');
    if (!user) throw new CapabilityRefusal('Nothing was set: the user name is empty.');
    if (password.length === 0) throw new CapabilityRefusal('Nothing was set: no password was given.');
    const from = (values.from ?? '').trim() || (user.includes('@') ? user : '');
    services.mailbox.set(MAILBOX_FIELDS.host, mailboxValue('host', server));
    services.mailbox.set(MAILBOX_FIELDS.user, mailboxValue('user', user));
    if (from) services.mailbox.set(MAILBOX_FIELDS.from, mailboxValue('from', from));
    await services.mailbox.storePassword(password);
    const lines = [`Set: the mail server ${server}, the user name ${user}${from ? `, the from address ${from}` : ''}, and the password (in the secret store).`];
    const check = services.mailbox.test ? await services.mailbox.test() : undefined;
    const data: Record<string, unknown> = { server, user, from: from || null };
    if (!check) {
      lines.push('The mailbox was not checked: this daemon reads no mail. "is it connected" checks it.');
    } else if (check.config) {
      lines.push(`It was not checked yet: ${check.config.replace(/\.$/, '')}. "change a setting" sets what is missing.`);
      data['checked'] = false;
    } else {
      const reading = check.reading;
      if (reading) lines.push(reading.ok ? 'Reading mail: works.' : `Reading mail${reading.server ? ` (${reading.server})` : ''} did not work: ${mailboxReason(reading)}. ${mailboxFix(reading, 'reading')}`);
      const sending = check.sending;
      if (sending === 'not-configured') lines.push('Sending mail: no sending server is set, so it was not checked.');
      else if (sending) lines.push(sending.ok ? 'Sending mail: works.' : `Sending mail${sending.server ? ` (${sending.server})` : ''} did not work: ${mailboxReason(sending)}. ${mailboxFix(sending, 'sending')}`);
      data['reading'] = reading?.ok === true ? 'works' : 'failed';
      data['sending'] = sending === 'not-configured' ? 'not-set' : sending?.ok === true ? 'works' : 'failed';
      data['checked'] = true;
    }
    return { text: lines.join('\n'), data };
  },
};

/** The daemon's mailbox services, over its own settings and secret store. */
export function mailboxServices(configManager: { get(key: string): unknown; setDynamic(key: string, value: unknown): void; validateDynamic?: ((key: string, value: unknown) => void) | undefined },
  secretsManager: Parameters<typeof persistSecretBackedConfigValue>[1]): MessagesCapabilityServices['mailbox'] {
  return {
    get: (key) => configManager.get(key),
    set: (key, value) => {
      configManager.validateDynamic?.(key, value);
      configManager.setDynamic(key, value);
    },
    async storePassword(password) {
      await persistSecretBackedConfigValue(configManager as Parameters<typeof persistSecretBackedConfigValue>[0], secretsManager, MAILBOX_PASSWORD_KEY as ConfigKey, password);
    },
  };
}

// ── What a method's answer says (`said`: capabilities.run's detail, for a model, a script and a place) ──────

const listOf = (answer: Readonly<Record<string, unknown>>, key: string): readonly Readonly<Record<string, unknown>>[] =>
  Array.isArray(answer[key]) ? (answer[key] as unknown[]).filter(isRecord) : [];
const word = (value: unknown): string => (typeof value === 'string' ? plainMail(value).trim() : '');

function eventWhen(value: unknown, allDay: unknown): string {
  const raw = word(value);
  if (!raw) return 'no time given';
  if (allDay === true || !raw.includes('T')) return raw.slice(0, 10);
  // The seconds go (the hour and minute stay, with a zone when one is written).
  return raw.replace('T', ' ').replace(/(\d\d:\d\d):\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, '$1$3');
}

function eventsSaid(answer: Readonly<Record<string, unknown>>): string {
  const events = listOf(answer, 'events');
  if (events.length === 0) return 'Nothing is on the calendar in that window.';
  return [
    `${events.length} event${events.length === 1 ? '' : 's'} (id, start, title):`,
    ...events.map((event) => `  ${word(event['id'])}  ${eventWhen(event['start'], event['allDay'])}  ${word(event['title']) || 'Untitled event'}${word(event['location']) ? `  at ${word(event['location'])}` : ''}`),
    ...(answer['more'] === true ? ['More events are in that window than were read.'] : []),
  ].join('\n');
}

function eventSaid(answer: Readonly<Record<string, unknown>>): string {
  const guests = Array.isArray(answer['attendees']) ? (answer['attendees'] as unknown[]).map(word).filter(Boolean) : [];
  return [
    `Title:  ${word(answer['title']) || 'Untitled event'}`,
    `Starts: ${eventWhen(answer['start'], answer['allDay'])}`,
    ...(word(answer['end']) ? [`Ends:   ${eventWhen(answer['end'], answer['allDay'])}`] : []),
    ...(word(answer['location']) ? [`Where:  ${word(answer['location'])}`] : []),
    ...(guests.length > 0 ? [`Guests: ${guests.join(', ')}`] : []),
    ...(answer['cancelled'] === true ? ['It was removed from the calendar.'] : []),
    ...(word(answer['description']) ? ['', word(answer['description'])] : []),
  ].join('\n');
}

function channelsSaid(answer: Readonly<Record<string, unknown>>): string {
  const channels = listOf(answer, 'channels');
  if (channels.length === 0) return 'The daemon reports no channels.';
  return channels.flatMap((channel) => {
    const reason = channelReasonOf(channel);
    return [`${word(channel['label']) || word(channel['surface'])}: ${CHANNEL_STATE_WORDS[channelStateOf(channel)]}`, ...(reason ? [`  ${reason}`] : [])];
  }).join('\n');
}

function setupSaid(answer: Readonly<Record<string, unknown>>): string {
  // A secret is named once, among the secrets.
  const fields = listOf(answer, 'fields').filter((field) => field['kind'] !== 'secret').map((field) => word(field['label']) || word(field['id'])).filter(Boolean);
  const secrets = listOf(answer, 'secretTargets').map((target) => `${word(target['label']) || word(target['id'])}${target['required'] === true ? '' : ' (optional)'}`);
  if (fields.length === 0 && secrets.length === 0) return 'Nothing is declared for it.';
  return [...(fields.length > 0 ? [`Settings: ${fields.join(', ')}.`] : []), ...(secrets.length > 0 ? [`Secrets: ${secrets.join(', ')}.`] : [])].join('\n');
}

function doctorSaid(answer: Readonly<Record<string, unknown>>): string {
  const checks = listOf(answer, 'checks');
  const repairs = listOf(answer, 'repairActions').map((repair) => word(repair['label']) || word(repair['id'])).filter(Boolean);
  return [
    ...(checks.length === 0 ? ['No checks were reported.'] : checks.map((check) => `${word(check['label']) || word(check['id'])}: ${word(check['status'])}${word(check['detail']) ? `, ${word(check['detail'])}` : ''}`)),
    ...(repairs.length > 0 ? [`Repairs the daemon offers: ${repairs.join(', ')}. Nothing was repaired.`] : []),
  ].join('\n');
}

function accountsSaid(answer: Readonly<Record<string, unknown>>): string {
  const accounts = listOf(answer, 'accounts');
  if (accounts.length === 0) return 'The daemon reports no channel accounts.';
  return accounts.map((account) => {
    const setUp = account['enabled'] === true || listOf(account, 'secrets').some((secret) => secret['configured'] === true);
    const unreadable = listOf(account, 'secrets').some((secret) => secret['source'] === 'unreadable');
    const said = !setUp ? 'not set up' : unreadable ? 'set up, but its secrets could not be read from the secret store (nothing is asked for again)' : `set up${word(account['authState']) ? `; sign-in ${word(account['authState'])}` : ''}`;
    return `${word(account['label']) || word(account['surface'])}: ${said}`;
  }).join('\n');
}

function policySaid(policy: Readonly<Record<string, unknown>>): string {
  const on = (key: string): string => (policy[key] === true ? 'yes' : 'no');
  const names = (key: string): string => {
    const list = Array.isArray(policy[key]) ? (policy[key] as unknown[]).map(word).filter(Boolean) : [];
    return list.length > 0 ? list.join(', ') : 'anyone';
  };
  return `${word(policy['surface'])}: messages ${policy['enabled'] === true ? 'accepted' : 'refused'}; only when mentioned: ${on('requireMention')}; direct messages: ${on('allowDirectMessages')}; groups: ${on('allowGroupMessages')}; users: ${names('allowlistUserIds')}; project: ${projectSaid(policy['project'])}`;
}

/** A channel's project as the rules line names it: the project's folder name, or none ("Project for this channel"). */
function projectSaid(project: unknown): string {
  const folder = word(project);
  if (!folder || folder === 'none') return 'none (conversations here write no file and run no command)';
  return folder.replace(/\/+$/, '').split('/').pop() || folder;
}

function profileSaid(binding: Readonly<Record<string, unknown>>): string {
  const scope = word(binding['channelId']) ? `${word(binding['surfaceKind'])}:${word(binding['channelId'])}` : word(binding['surfaceKind']);
  return `${scope}: model ${word(binding['model']) || 'the host default'}, permission mode ${word(binding['permissionMode']) || 'the host default'}`;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

const EVENT = listed('event', 'Event', 'The events ahead', CALENDAR_EVENTS_LIST, { other: 'an event id from the calendar' });
const TIME_WHY = 'a date (2026-08-01) or an ISO-8601 time (2026-08-01T14:00, with Z or an offset for another zone)';

export const CALENDAR_UPCOMING: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'calendar.upcoming', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'upcoming', word: 'upcoming', label: 'See what is coming up', ...READ,
  inputs: [{ id: 'days', label: 'How many days', help: 'How far ahead', kind: 'number', required: { default: '7', defaultMeans: 'the next seven days' }, typed: { flag: '--days' } }],
  sentence: 'Lists the events of the days ahead, from every calendar the daemon reads.', example: { days: '14' },
  async run(values, _services, caller) {
    const days = Number(values.days ?? '7');
    if (!Number.isInteger(days) || days < 1) throw new CapabilityRefusal(`How many days: "${values.days}" is not a whole number of days.`);
    const from = new Date();
    const to = new Date(from.getTime() + Math.min(days, 366) * 86_400_000);
    // The calendar's own act (calendar.events.list), run as the caller, for the window asked.
    const answer = await methodOf(caller, 'The calendar')('calendar.events.list', { from: from.toISOString(), to: to.toISOString() });
    const body = isRecord(answer) ? answer : {};
    return { text: eventsSaid(body), data: { events: listOf(body, 'events'), more: body['more'] === true } };
  },
};

export const CALENDAR_GET: MethodCapabilityDefinition = {
  capability: { id: 'calendar.get', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'get', word: 'get', label: 'See one calendar event', ...READ, inputs: [EVENT],
  sentence: 'Shows the details of {event}, a meeting or appointment on your calendar: its times, place, guests and notes.', example: { event: 'evt-42' },
  method: { id: 'calendar.events.get', fields: { eventId: 'event' } },
  said: eventSaid,
};

export const CALENDAR_ADD: MethodCapabilityDefinition = {
  capability: { id: 'calendar.add', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'add', word: 'add', label: 'Add an event to the calendar',
  inputs: [
    text('title', 'Title', 'What it is', 'your own words', { flag: '--title' }),
    text('start', 'Starts', 'When it starts; a time without a zone is read in this machine\'s zone', TIME_WHY, { flag: '--start' }),
    text('end', 'Ends', 'When it ends (the daemon\'s calendar needs one)', TIME_WHY, { flag: '--end' }, { optional: { default: '', means: 'no end time' } }),
    text('location', 'Where', 'Where it is', 'a place in your own words', { flag: '--location' }, { optional: { default: '', means: 'no place' } }),
    text('notes', 'Notes', 'Anything to note with it', 'your own words', { flag: '--notes' }, { optional: { default: '', means: 'no notes' } }),
    { id: 'again', label: 'Already added', help: 'Whether to add it when this exact event was already added from this session', kind: 'choice',
      choices: [{ value: 'no', label: 'Do not add it twice' }, { value: 'yes', label: 'Add it again' }],
      required: { default: 'no', defaultMeans: 'do not add it twice' }, typed: { flag: '--again', switchOn: 'yes' } },
    { id: 'where', label: 'Which calendar', help: 'Your connected calendar (Google, Outlook or CalDAV), or the one on this computer', kind: 'choice',
      choices: [{ value: 'connected', label: 'My connected calendar (this computer\'s when none is connected)' }, { value: 'local', label: 'The calendar on this computer' }],
      required: { default: 'connected', defaultMeans: 'the connected calendar, else this computer\'s' }, typed: { flag: '--calendar' } },
  ],
  sentence: 'The appointment or meeting "{title}" starting {start} is added to your calendar, until you change it; a shared calendar tells its guests.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'delete',
  example: { title: 'Design review', start: '2026-08-01T14:00', end: '2026-08-01T15:00' },
  method: { id: 'calendar.events.create', fields: { title: 'title', start: 'start', end: 'end', location: 'location', description: 'notes', calendarId: 'where:except:connected', confirm: '=true' } },
  // Named by its title, never by its id (the id is the answer's `eventId`).
  said: (answer, values) => `"${values.title}" is on ${word(answer['eventId']).startsWith('local:') ? 'the calendar on this computer' : 'your connected calendar'}.`,
};

export const CALENDAR_CHANGE: MethodCapabilityDefinition = {
  capability: { id: 'calendar.change', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'change', word: 'change', label: 'Move a meeting or change a calendar event',
  inputs: [
    EVENT,
    text('title', 'Title', 'A new title; blank keeps it', 'your own words', { flag: '--title' }, { optional: { default: '', means: 'unchanged' } }),
    text('start', 'Starts', 'A new start; blank keeps it', TIME_WHY, { flag: '--start' }, { optional: { default: '', means: 'unchanged' } }),
    text('end', 'Ends', 'A new end; blank keeps it', TIME_WHY, { flag: '--end' }, { optional: { default: '', means: 'unchanged' } }),
  ],
  sentence: '{event} moves to the new time or takes the new title you gave, until you change it again; its guests are told.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'sends-out',
  example: { event: 'evt-42', start: '2026-08-01T15:00' },
  method: { id: 'calendar.events.update', fields: { eventId: 'event', title: 'title', start: 'start', end: 'end', confirm: '=true' } },
  said: () => 'The event is changed.',
  // An event kept on this computer told no one.
  did: (answer) => (word(answer['eventId']).startsWith('local:') ? '' : undefined),
};

export const CALENDAR_DELETE: MethodCapabilityDefinition = {
  capability: { id: 'calendar.delete', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'delete', word: 'delete', label: 'Cancel or remove a calendar event', inputs: [EVENT],
  sentence: '{event} is cancelled and removed from your calendar; a shared calendar tells its guests.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone',
  example: { event: 'evt-42' },
  method: { id: 'calendar.events.delete', fields: { eventId: 'event', confirm: '=true' } },
  said: (answer) => (answer['deleted'] === false
    ? 'The event was no longer on the calendar; nothing changed.'
    : 'The event is removed from the calendar.'),
};

// ── Channels ─────────────────────────────────────────────────────────────────

const SURFACE_OTHER = 'a channel kind the daemon does not report yet (slack, telegram, discord, ntfy, webhook, ...)';
const CHANNEL = listed('channel', 'Channel', 'One of the daemon\'s channels', CHANNELS_LIST_NAME, { other: SURFACE_OTHER });
const PROFILE_CHANNEL = listed('channel', 'Channel', 'A channel kind; its sessions get the profile', CHANNEL_PROFILES_LIST, { other: SURFACE_OTHER });
const CHANNEL_ID = text('id', 'One conversation', 'The id of one conversation in that channel; blank means the whole channel kind', 'a conversation id on that channel', { position: 2 }, { optional: { default: '', means: 'the whole channel kind' } });

export const CHANNELS_STATUS: MethodCapabilityDefinition = {
  capability: { id: 'channels.status', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'status', word: 'status', label: 'See your channels', inputs: [], ...READ,
  sentence: 'Lists each channel the daemon has and whether it works, and why when it does not.', example: {},
  method: { id: 'channels.status', fields: {} },
  said: channelsSaid,
};

export const CHANNELS_SETUP: MethodCapabilityDefinition = {
  capability: { id: 'channels.setup', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'setup', word: 'setup', label: 'See what a channel needs to be set up', ...READ, inputs: [CHANNEL],
  sentence: 'Lists the settings and secrets {channel} (Slack, Telegram, Discord, ntfy or another chat channel) needs to be set up; no value is shown.', example: { channel: 'slack' },
  method: { id: 'channels.setup.get', fields: { surface: 'channel' } },
  said: setupSaid,
};

export const CHANNELS_DOCTOR: MethodCapabilityDefinition = {
  capability: { id: 'channels.doctor', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'doctor', word: 'doctor', label: 'Check a channel that isn\'t working', ...READ, inputs: [CHANNEL],
  sentence: 'Finds why {channel} (Slack, Telegram, Discord, ntfy or another chat channel) is not working: runs the daemon\'s checks on it and lists the repairs it offers; nothing is repaired.', example: { channel: 'slack' },
  method: { id: 'channels.doctor.get', fields: { surface: 'channel' } },
  said: doctorSaid,
};

export const CHANNELS_TEST: MethodCapabilityDefinition = {
  capability: { id: 'channels.test', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'test', word: 'test', label: 'Send a test message through a channel', inputs: [CHANNEL],
  sentence: 'The daemon sends a real test message through {channel} and reports whether it was delivered.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out', example: { channel: 'slack' },
  method: { id: 'channels.test.send', fields: { surface: 'channel' } },
  said: (answer) => (answer['delivered'] === true
    ? `Delivered${word(answer['address']) ? ` to ${word(answer['address'])}` : ''}.`
    : `Not delivered: ${word(answer['error']) || 'the daemon gave no reason'}.`),
};

export const CHANNELS_ACCOUNTS: MethodCapabilityDefinition = {
  capability: { id: 'channels.accounts', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'accounts', word: 'accounts', label: 'See the accounts behind your channels', inputs: [], ...READ,
  sentence: 'Lists each channel account, whether it is set up and signed in; no secret is shown.', example: {},
  method: { id: 'channels.accounts.list', fields: {} },
  said: accountsSaid,
};

export const CHANNELS_RULES: MethodCapabilityDefinition = {
  capability: { id: 'channels.rules', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'rules', word: 'rules', label: 'See who may reach the assistant', ...READ,
  inputs: [{ ...CHANNEL, required: { default: '', defaultMeans: 'every channel' } }],
  sentence: 'Shows the daemon\'s rules for who may write to the assistant on each channel, or on {channel}.', example: { channel: 'slack' },
  method: { id: 'channels.policies.list', fields: {} },
  said: (answer, values) => {
    const policies = listOf(answer, 'policies').filter((policy) => !values.channel || policy['surface'] === values.channel);
    if (policies.length === 0) return values.channel ? `No rules are kept for ${values.channel}; it uses the defaults.` : 'No rules are kept; every channel uses the defaults.';
    return policies.map(policySaid).join('\n');
  },
};

const ON_OFF: readonly FixedChoice[] = [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }];
const LOOSENING_ON: readonly FixedChoice[] = [{ value: 'on', label: 'On', risk: 'loosens-a-protection' }, { value: 'off', label: 'Off' }];
const CONVERSATION_POLICIES: readonly FixedChoice[] = [
  { value: 'allow', label: 'Allow', risk: 'loosens-a-protection' }, { value: 'deny', label: 'Refuse' }, { value: 'inherit', label: 'As the channel says' },
];
const UNCHANGED = { default: '', means: 'unchanged' };
const ruleSwitch = (id: string, label: string, help: string, choices: readonly FixedChoice[], step: number): InputDescription =>
  ({ id, label, help, kind: 'choice', choices, required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: `--${id}` }, step });
const ruleList = (id: string, label: string, help: string): InputDescription =>
  text(id, label, `${help}; a comma list, or none to clear it`, 'ids on that channel', { flag: `--${id}` }, { optional: UNCHANGED, step: 3 });

/** Each ingress-rule blank and the daemon field it writes (`channels.policies.update`). */
export const CHANNEL_RULE_SWITCHES = { enabled: 'enabled', 'require-mention': 'requireMention', 'allow-dms': 'allowDirectMessages', 'allow-groups': 'allowGroupMessages', 'allow-threads': 'allowThreadMessages', 'commands-without-mention': 'allowTextCommandsWithoutMention', open: 'open' } as const;
export const CHANNEL_RULE_CHOICES = { 'dm-policy': 'dmPolicy', 'group-policy': 'groupPolicy' } as const;
export const CHANNEL_RULE_LISTS = { 'allow-users': 'allowlistUserIds', 'allow-channels': 'allowlistChannelIds', 'allow-group-ids': 'allowlistGroupIds', 'allowed-commands': 'allowedCommands' } as const;

export const CHANNELS_SET_RULES: MethodCapabilityDefinition = {
  capability: { id: 'channels.set-rules', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'set-rules', word: 'set-rules', label: 'Change who may reach the assistant on a channel',
  inputs: [
    { ...CHANNEL, step: 1 },
    ruleSwitch('enabled', 'Accept messages', 'Whether messages on this channel are accepted at all', ON_OFF, 2),
    ruleSwitch('require-mention', 'Only when mentioned', 'Answer only messages that mention the assistant', ON_OFF, 2),
    ruleSwitch('commands-without-mention', 'Commands without a mention', 'Accept typed commands that do not mention the assistant', LOOSENING_ON, 2),
    ruleSwitch('allow-dms', 'Direct messages', 'Accept direct messages', LOOSENING_ON, 2),
    ruleSwitch('allow-groups', 'Group messages', 'Accept messages in groups', LOOSENING_ON, 2),
    ruleSwitch('allow-threads', 'Thread messages', 'Accept messages in threads', LOOSENING_ON, 2),
    ruleSwitch('dm-policy', 'Direct messages from others', 'Whether people not on the lists may write directly', CONVERSATION_POLICIES, 2),
    ruleSwitch('group-policy', 'Groups not on the list', 'Whether groups not on the lists may write', CONVERSATION_POLICIES, 2),
    ruleSwitch('open', 'Open to anyone', 'With no list set, anyone may write and no owner claim is raised', LOOSENING_ON, 3),
    ruleList('allow-users', 'Users', 'The users who may write'),
    ruleList('allow-channels', 'Conversations', 'The conversations the assistant answers in'),
    ruleList('allow-group-ids', 'Groups', 'The groups the assistant answers in'),
    ruleList('allowed-commands', 'Commands', 'The commands people may type there'),
  ],
  sentence: 'Who may write to the assistant on {channel} (Slack, Telegram, Discord, ...), and which messages it answers (only those that mention it, direct messages, groups), changes to what you gave, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'loosens-a-protection',
  // It loosens a protection: a model's call is put to the owner, opening on No (never refused outright).
  // What ran may as well have narrowed who may write: the line says what it set, not that it loosened.
  riskDone: 'Who may write to the assistant on {channel}, and what it answers, is now what you gave.',
  example: { channel: 'slack', 'require-mention': 'on' },
  method: {
    id: 'channels.policies.update',
    fields: {
      surface: 'channel',
      ...Object.fromEntries(Object.entries(CHANNEL_RULE_SWITCHES).map(([input, field]) => [field, `${input}:onoff`])),
      ...Object.fromEntries(Object.entries(CHANNEL_RULE_CHOICES).map(([input, field]) => [field, input])),
      ...Object.fromEntries(Object.entries(CHANNEL_RULE_LISTS).map(([input, field]) => [field, `${input}:commas`])),
    },
  },
  said: (answer) => `Who may write on ${policySaid(answer)}.`,
};

/**
 * "Project for this channel": the registered project a conversation on the channel works in (its files, commands and
 * tool servers). None by default: a turn there that would read or write a file, run a command or reach anything else
 * that needs a place is refused, naming this control (channels/channel-project.ts); nothing is done in the daemon's own
 * folder.
 */
export const CHANNELS_PROJECT: MethodCapabilityDefinition = {
  capability: { id: 'channels.project', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'channel-project', word: 'project', label: 'Project for this channel',
  inputs: [
    { ...CHANNEL, step: 1 },
    { id: 'project', label: 'Project', help: 'A registered project, or none', kind: 'choice',
      choices: { list: CHANNEL_PROJECTS_LIST, allowOther: { reason: 'none, or the full path of a registered project' } },
      required: { default: 'none', defaultMeans: 'none' }, typed: { flag: '--project' }, step: 2 },
  ],
  sentence: 'Conversations on {channel} work in {project}: its files, its commands and its tool servers, as the rules of who may change things there allow. A conversation already going on moves there and keeps its history.',
  // With none chosen (the default), the sentence says what none means, not "work in none".
  sentenceWhen: { input: 'project', values: ['', 'none'], sentence: 'Conversations on {channel} have no project: they read no file, write none and run no command (your own message there gets the conversation a project of its own when it needs one), and a conversation already going on keeps its history.' },
  done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  // Where messages from a channel may change things is the owner's own choice, through every door.
  ownerOnly: { reason: 'it decides which project a channel\'s messages may change', instead: 'Ask the owner to choose it in Mail, calendar and channels, on the channel\'s row.' },
  ownersAct: true,
  example: { channel: 'homeassistant', project: '/home/sam/projects/garden-planner' },
  method: { id: 'channels.policies.update', fields: { surface: 'channel', project: 'project' } },
  said: (answer) => word(answer['project']) && word(answer['project']) !== 'none'
    ? `Conversations on ${word(answer['surface'])} now work in ${word(answer['project'])}.`
    : `Conversations on ${word(answer['surface'])} have no project: they read no file, write none and run no command.`,
};

export const CHANNELS_PROFILES: MethodCapabilityDefinition = {
  capability: { id: 'channels.profiles', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'profiles', word: 'profiles', label: 'See channel profiles', inputs: [], ...READ,
  sentence: 'Lists the model and permission mode each channel\'s sessions are given.', example: {},
  method: { id: 'channels.profiles.list', fields: {} },
  said: (answer) => {
    const bindings = listOf(answer, 'bindings');
    return bindings.length === 0 ? 'No channel has its own profile; sessions get the host\'s defaults.' : bindings.map(profileSaid).join('\n');
  },
};

export const CHANNELS_PROFILE: MethodCapabilityDefinition = {
  capability: { id: 'channels.profile', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'profile', word: 'profile', label: 'See what one channel\'s sessions get', ...READ, inputs: [PROFILE_CHANNEL, CHANNEL_ID],
  sentence: 'Shows the profile of {channel} and the model and permission mode its sessions get, with where each comes from.', example: { channel: 'slack' },
  method: { id: 'channels.profiles.get', fields: { surfaceKind: 'channel', channelId: 'id' } },
  said: (answer) => {
    const effective = isRecord(answer['effective']) && isRecord(answer['effective']['profile']) ? answer['effective']['profile'] : {};
    return `Sessions from it get model ${word(effective['model']) || 'the host default'} and permission mode ${word(effective['permissionMode']) || 'the host default'}.`;
  },
};

const PERMISSION_MODES: readonly FixedChoice[] = SESSION_GATE_PRESET_NAMES.map((name) => ({
  value: name, label: gatePresetLabel(name), ...(name === 'just-vibes' || name === 'yolo' ? { risk: 'loosens-a-protection' as const } : {}),
}));

export const CHANNELS_SET_PROFILE: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'channels.set-profile', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'set-profile', word: 'set-profile', label: 'Give a channel its own model or permission mode',
  inputs: [
    PROFILE_CHANNEL, CHANNEL_ID,
    text('model', 'Model', 'The model its sessions use', 'a model id the host knows', { flag: '--model' }, { optional: UNCHANGED }),
    text('provider', 'Provider', 'The provider of that model', 'a provider id the host knows', { flag: '--provider' }, { optional: UNCHANGED }),
    { id: 'mode', label: 'Permission mode', help: 'How its sessions ask before acting', kind: 'choice', choices: PERMISSION_MODES, required: { default: '', defaultMeans: 'unchanged' }, typed: { flag: '--permission-mode' } },
  ],
  sentence: 'Sessions from {channel} (a Slack, Telegram or other chat channel) use the model and permission mode you gave, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'remove-profile',
  example: { channel: 'slack', mode: 'ask-me' },
  async run(values, _services, caller) {
    if (!values.model && !values.provider && !values.mode) throw new CapabilityRefusal(`Nothing to give ${values.channel}: name a model, a provider or a permission mode.`);
    const method = methodOf(caller, 'A channel\'s profile');
    const surfaceKind = (values.channel ?? '').trim().toLowerCase();
    const channelId = (values.id ?? '').trim();
    // A set replaces the whole binding, so a field left blank ("unchanged") carries the bound value over.
    const listedAnswer = await method('channels.profiles.list', {});
    const bound = listOf(isRecord(listedAnswer) ? listedAnswer : {}, 'bindings')
      .find((binding) => word(binding['surfaceKind']) === surfaceKind && word(binding['channelId']) === channelId);
    // A model and its provider are one choice: a new model does not keep the old model's provider.
    const model = values.model || word(bound?.['model']);
    const provider = values.provider || (values.model ? '' : word(bound?.['provider']));
    // A stored mode this build cannot use is not carried over; the set clears it.
    const mode = values.mode || (bound?.['invalid'] ? '' : word(bound?.['permissionMode']));
    const answer = await method('channels.profiles.set', {
      surfaceKind, ...(channelId ? { channelId } : {}),
      ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(mode ? { permissionMode: mode } : {}),
      ...(isRecord(bound?.['metadata']) ? { metadata: bound?.['metadata'] } : {}),
    });
    const result = isRecord(answer) ? answer : {};
    // A looser mode from a credential that is not the owner's is put to the owner (OWNER_APPROVAL_PENDING).
    if (typeof result['approvalId'] === 'string') return { text: 'Not applied yet: it loosens the permission mode, so it was put to the owner, who answers it in Waiting for you.', data: { approvalId: result['approvalId'] } };
    const binding = isRecord(result['binding']) ? result['binding'] : {};
    return { text: `Set. ${profileSaid(binding)}.`, data: { binding } };
  },
};

export const CHANNELS_REMOVE_PROFILE: MethodCapabilityDefinition = {
  capability: { id: 'channels.remove-profile', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'remove-profile', word: 'remove-profile', label: 'Stop using a channel\'s own profile', inputs: [PROFILE_CHANNEL, CHANNEL_ID],
  sentence: 'Sessions from {channel} (a Slack, Telegram or other chat channel) use the host\'s default model and permission mode again, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', undoneBy: 'set-profile',
  example: { channel: 'slack' },
  method: { id: 'channels.profiles.delete', fields: { surfaceKind: 'channel', channelId: 'id' } },
  said: (answer, values) => (answer['deleted'] === true
    ? `${values.channel}${values.id ? `:${values.id}` : ''} has no profile of its own now; its sessions get the host's defaults.`
    : answer['deleted'] === false ? `${values.channel}${values.id ? `:${values.id}` : ''} had no profile; nothing changed.`
      : 'Not applied yet: it was put to the owner, who answers it in Waiting for you.'),
};

/** The mailbox's capabilities, each a handler (the act is a daemon method's; the handler says what it came to). */
export const MAIL_CAPABILITIES: readonly CapabilityDefinition<MessagesCapabilityServices>[] = [
  MAIL_STATUS, MAIL_LIST, MAIL_READ, MAIL_DRAFT, MAIL_SEND, MAIL_SETTINGS, MAIL_SET, MAIL_PASSWORD, MAIL_SETUP,
];

/** The calendar's handler capabilities (the window of days ahead is the handler's; the act is calendar.events.list). */
export const CALENDAR_HANDLER_CAPABILITIES: readonly CapabilityDefinition<MessagesCapabilityServices>[] = [CALENDAR_UPCOMING];

// ── A channel's own keys, entered on its row ─────────────────────────────────

/** The chat channels a person connects with their own keys: every channel kind but the two the programs are themselves. */
const CONNECTABLE_CHANNELS: readonly ChannelSurface[] = ['slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram', 'google-chat', 'signal',
  'whatsapp', 'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix'];

/** The values a person supplies for a channel (secrets and plain values); switches and choices keep their defaults. */
function channelKeyFields(schema: ChannelSetupSchema): readonly ChannelSetupFieldDescriptor[] {
  return schema.fields.filter((field) => field.configKey !== undefined
    && (field.kind === 'secret' || field.kind === 'string' || field.kind === 'url' || field.kind === 'number'));
}

/** One form input per value of each channel, shown only for that channel (the row gives the channel). */
const CHANNEL_KEY_INPUTS: readonly InputDescription[] = CONNECTABLE_CHANNELS.flatMap((surface) => {
  const schema = getBuiltinSetupSchema(surface);
  return channelKeyFields(schema).map((field): InputDescription => ({
    id: `${surface}.${field.id}`,
    label: field.label,
    help: `${field.detail ?? field.placeholder ?? field.label}${field.required ? ' (needed)' : ''}; blank keeps what is set${field.kind === 'secret' ? '; it goes to the secret store and is never shown' : ''}`,
    kind: field.kind === 'secret' ? 'secret' : field.kind === 'number' ? 'number' : 'text',
    ...(field.kind === 'secret' || field.kind === 'number' ? {} : { freeTextReason: `the ${field.label.toLowerCase()} the channel gives you` }),
    required: { default: '', defaultMeans: 'kept as it is' },
    typed: { flag: `--${`${surface}-${field.id}`.replace(/[^a-zA-Z0-9-]/g, '-')}` as `--${string}` },
    showWhen: { input: 'channel', is: surface },
  }));
});

export const CHANNELS_CONNECT: CapabilityDefinition<MessagesCapabilityServices> = {
  capability: { id: 'channels.connect', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'connect', word: 'connect', label: 'Enter a channel\'s keys and switch it on',
  inputs: [
    { ...CHANNEL, help: 'The chat channel to connect' },
    ...CHANNEL_KEY_INPUTS,
  ],
  sentence: '{channel} gets the values entered (each secret in the secret store, settings holding only its reference) and is switched on once everything it needs is set, until you change it.', done: '',
  touches: 'credential', lasts: 'kept', risk: 'none',
  // Writing a credential: a model's call is put to the owner, opening on No, and a secret it leaves out is typed by the
  // person in the form.
  effects: ['control-plane.write', 'secret.write'],
  example: { channel: 'ntfy' },
  async run(values, services) {
    const surface = (values.channel ?? '').trim() as ChannelSurface;
    if (!CONNECTABLE_CHANNELS.includes(surface)) {
      throw new CapabilityRefusal(`"${values.channel ?? ''}" is not a chat channel that takes keys.`, `Choose one of ${CONNECTABLE_CHANNELS.join(', ')}.`);
    }
    const keys = services.channelKeys;
    if (!keys) throw new CapabilityRefusal('This daemon keeps no channel settings here.');
    const schema = getBuiltinSetupSchema(surface);
    const stored: string[] = [];
    for (const field of channelKeyFields(schema)) {
      const raw = values[`${surface}.${field.id}`] ?? '';
      if (raw.trim().length === 0) continue;
      const key = field.configKey!;
      if (field.kind === 'secret') await keys.storeSecret(key, raw);
      else if (field.kind === 'number') {
        const number = Number(raw);
        if (!Number.isFinite(number)) throw new CapabilityRefusal(`"${raw}" is not a number for ${field.label}; nothing after it was set.`);
        keys.set(key, number);
      } else keys.set(key, raw.trim());
      stored.push(field.label);
    }
    const missing = channelKeyFields(schema).filter((field) => field.required && !stored.includes(field.label)
      && !(typeof keys.get(field.configKey!) === 'string' ? (keys.get(field.configKey!) as string).trim() : keys.get(field.configKey!)));
    const enabledKey = schema.fields.find((field) => field.id === 'enabled' && field.kind === 'boolean')?.configKey;
    const lines = [stored.length > 0 ? `${schema.label}: stored ${stored.join(', ')}.` : `${schema.label}: nothing new was entered.`];
    if (missing.length > 0) {
      lines.push(`It is not switched on yet: it still needs ${missing.map((field) => field.label).join(', ')}.`);
    } else if (enabledKey && keys.get(enabledKey) !== true) {
      keys.set(enabledKey, true);
      lines.push('Everything it needs is set: it is switched on.');
    } else {
      lines.push('Everything it needs is set.');
    }
    return { text: lines.join(' '), data: { channel: surface, stored, missing: missing.map((field) => field.label), enabled: enabledKey ? keys.get(enabledKey) === true : null } };
  },
};

/** The channels' handler capabilities (a profile set keeps what was not changed; the act is channels.profiles.set). */
export const CHANNELS_HANDLER_CAPABILITIES: readonly CapabilityDefinition<MessagesCapabilityServices>[] = [CHANNELS_SET_PROFILE, CHANNELS_CONNECT];

/** Every capability of the group that runs through its own daemon method. */
export const MESSAGES_METHOD_CAPABILITIES: readonly { readonly definition: MethodCapabilityDefinition; readonly command: { readonly name: string; readonly title: string } }[] = [
  ...[CALENDAR_GET, CALENDAR_ADD, CALENDAR_CHANGE, CALENDAR_DELETE].map((definition) => ({ definition, command: { name: 'calendar', title: 'Calendar' } })),
  ...[CHANNELS_STATUS, CHANNELS_SETUP, CHANNELS_DOCTOR, CHANNELS_TEST, CHANNELS_ACCOUNTS, CHANNELS_RULES, CHANNELS_SET_RULES, CHANNELS_PROJECT, CHANNELS_PROFILES, CHANNELS_PROFILE, CHANNELS_REMOVE_PROFILE]
    .map((definition) => ({ definition, command: { name: 'channels', title: 'Channels' } })),
];
