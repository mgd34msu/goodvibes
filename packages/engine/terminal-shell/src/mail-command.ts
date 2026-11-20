/**
 * `/mail`, described once (command-actions/) for both terminal apps: whether
 * mail is connected, the inbox, one message, a draft, a send, and (in the
 * Agent) the mailbox settings and password. Each app reads and sends mail its
 * own way (the terminal app through the daemon's `email.*` methods, the Agent
 * with its own mail service on the same `surfaces.email.*` settings) and
 * gives it here as a host. A message is To, Subject and Message: three blanks.
 *
 * Message bodies are text a stranger wrote; each host prints them as
 * display-only text and records what it read where its app keeps such a
 * record.
 */
import { commandRefusal } from './command-confirmation.js';
import type { TerminalCommandRegistry } from './command-registry.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, FixedChoice, InputDescription } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
}

/** How one app reads and sends mail. A missing reader refuses its action with `settingsHere`'s reason. */
export interface MailHost<Ctx> {
  /** Whether mail is connected and, if not, the next step. */
  readonly status: (ctx: Ctx) => Promise<string>;
  readonly list: (ctx: Ctx, count: number) => Promise<string>;
  /** The newest messages as rows (value: the message's uid). */
  readonly inbox: (ctx: Ctx) => Promise<readonly ListRow[]>;
  readonly read: (ctx: Ctx, uid: number) => Promise<string>;
  readonly draft: (ctx: Ctx, message: MailMessage) => Promise<string>;
  /** `again`: send even when this exact message was already sent from this session. */
  readonly send: (ctx: Ctx, message: MailMessage, again: boolean) => Promise<string>;
  readonly settings?: ((ctx: Ctx) => Promise<string>) | undefined;
  readonly setField?: ((ctx: Ctx, field: string, value: string) => Promise<string>) | undefined;
  readonly setPassword?: ((ctx: Ctx, password: string) => Promise<string>) | undefined;
}

/** Where the mailbox settings are changed in a program whose host does not change them here. */
const SETTINGS_ELSEWHERE = 'the terminal app changes the mailbox settings (surfaces.email.*) in /settings';

const CREDENTIAL = 'loosens-a-protection' as const;
/** The mailbox settings, each a `surfaces.email.*` key; those that decide where and as whom the password is presented are marked. */
export const MAILBOX_SETTING_CHOICES: readonly FixedChoice[] = [
  { value: 'host', label: 'Mail server (both IMAP and SMTP)', risk: CREDENTIAL },
  { value: 'imap.host', label: 'IMAP server', risk: CREDENTIAL },
  { value: 'imap.port', label: 'IMAP port', risk: CREDENTIAL },
  { value: 'imap.secure', label: 'IMAP over TLS (true or false)', risk: CREDENTIAL },
  { value: 'imap.mailbox', label: 'Mailbox to read' },
  { value: 'smtp.host', label: 'SMTP server', risk: CREDENTIAL },
  { value: 'smtp.port', label: 'SMTP port', risk: CREDENTIAL },
  { value: 'smtp.secure', label: 'SMTP over TLS from the start (true for 465, false for 587)', risk: CREDENTIAL },
  { value: 'user', label: 'User name', risk: CREDENTIAL },
  { value: 'from', label: 'From address' },
];

let hostOf: MailHost<unknown> | undefined;
const INBOX = defineList<unknown>({
  name: 'mail.inbox',
  async read(ctx) {
    if (!hostOf) return [];
    return await hostOf.inbox(ctx);
  },
  operator: { method: 'email.inbox.list', input: {}, rows: { from: 'messages', value: 'uid', label: 'subject', detail: 'from' } },
});

const TO: InputDescription = textInput({ id: 'to', label: 'To', help: 'Who it goes to: an address, or several separated by commas', why: 'an email address', typed: { position: 1 } });
const SUBJECT: InputDescription = textInput({ id: 'subject', label: 'Subject', help: 'The subject line', why: 'your own words', typed: { flag: '--subject' } });
const BODY: InputDescription = textInput({ id: 'body', label: 'Message', help: 'What it says', why: 'your own words', kind: 'long-text', typed: { tail: true } });

function messageOf(values: ActionValues): MailMessage {
  return { to: values.to!, subject: values.subject!, body: values.body! };
}

function countOf(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw commandRefusal(`How many: "${raw}" is not a number of messages.`);
  return Math.min(100, Math.floor(parsed));
}

function uidOf(raw: string | undefined): number {
  const uid = Number(raw);
  if (!Number.isInteger(uid) || uid <= 0) throw commandRefusal(`"${raw}" is not a message: choose one from /mail list.`);
  return uid;
}

/** Register `/mail` with how this app reads and sends mail. */
export function registerMailCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, host: MailHost<Ctx>): void {
  hostOf = host as unknown as MailHost<unknown>;
  registry.register({
    ...defineCommand<Ctx>({
    // --yes answers the question only right after the action word: the same word inside a message is text.
    leadingFlagsOnly: true,
    name: 'mail',
    title: 'Mail',
    summary: 'Read your inbox, write a draft and send mail, from the mailbox set up under surfaces.email',
    group: 'Channels',
    report: 'status',
    actions: [
      readAction<Ctx>({
        id: 'status', label: 'See whether mail is connected', word: 'status',
        sentence: 'Shows whether the mailbox is set up and reachable, and what to do next if not.',
        operator: { method: 'email.inbound.status', fields: {} },
        async run(_values, ctx) { return await host.status(ctx); },
      }),
      readAction<Ctx>({
        id: 'list', label: 'See your inbox', word: 'list',
        inputs: [{ id: 'count', label: 'How many', help: 'How many of the newest messages', kind: 'number', required: { default: '15', defaultMeans: 'the newest 15' }, typed: { position: 1 } }],
        sentence: 'Lists the newest messages in the inbox; nothing is marked read.', example: { count: '30' },
        operator: { method: 'email.inbox.list', fields: { 'body.limit': 'count:number' } },
        async run(values, ctx) { return await host.list(ctx, countOf(values.count ?? '15')); },
      }),
      readAction<Ctx>({
        id: 'read', label: 'Read a message', word: 'read',
        inputs: [listInput({ id: 'message', label: 'Message', help: 'The newest messages in the inbox', list: INBOX, other: 'a message uid from the inbox list' })],
        sentence: 'Shows message {message} with its sender, subject and text.', example: { message: '4211' },
        operator: { method: 'email.inbox.read', fields: { 'body.uid': 'message:number' } },
        async run(values, ctx) { return await host.read(ctx, uidOf(values.message)); },
      }),
      {
        id: 'draft', label: 'Save a draft', word: 'draft', inputs: [TO, SUBJECT, BODY],
        sentence: 'A draft to {to}, "{subject}": "{body}", is kept in the account\'s Drafts folder until you change it; nothing is sent.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none',
        operator: { method: 'email.draft.create', fields: { 'body.to': 'to', 'body.subject': 'subject', 'body.body': 'body' } },
        example: { to: 'sam@example.com', subject: 'Build is green', body: 'All gates passed.' },
        async run(values, ctx) { return await host.draft(ctx, messageOf(values)); },
      },
      {
        id: 'send', label: 'Send a message', word: 'send',
        inputs: [TO, SUBJECT, BODY,
          { id: 'again', label: 'Already sent', help: 'Whether to send it when this exact message was already sent from this session', kind: 'choice',
            choices: [{ value: 'no', label: 'Do not send it twice' }, { value: 'yes', label: 'Send it again' }],
            required: { default: 'no', defaultMeans: 'do not send it twice' }, typed: { flag: '--again', switchOn: 'yes' } }],
        sentence: 'This goes to {to} and cannot be recalled: "{subject}": "{body}".', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
        operator: { method: 'email.send', fields: { 'body.to': 'to', 'body.subject': 'subject', 'body.body': 'body', 'body.confirm': '=true' } },
        example: { to: 'sam@example.com', subject: 'Build is green', body: 'All gates passed.' },
        async run(values, ctx) { return await host.send(ctx, messageOf(values), values.again === 'yes'); },
      },
      readAction<Ctx>({
        id: 'settings', label: 'See your mailbox settings', word: 'settings',
        sentence: 'Shows each mailbox setting; the password shows only as stored or not.',
        operator: { terminalOnly: SETTINGS_ELSEWHERE },
        async run(_values, ctx) {
          if (!host.settings) throw commandRefusal(`Mailbox settings are not shown here: ${SETTINGS_ELSEWHERE}.`);
          return await host.settings(ctx);
        },
      }),
      {
        id: 'set', label: 'Change a mailbox setting', word: 'set',
        inputs: [
          { id: 'setting', label: 'Setting', help: 'Which mailbox setting', kind: 'choice', choices: MAILBOX_SETTING_CHOICES, required: true, typed: { position: 1 } },
          textInput({ id: 'value', label: 'Value', help: 'Its new value', why: 'a server name, port, address or name', typed: { tail: true } }),
        ],
        sentence: 'The mailbox setting {setting} becomes {value}, until you change it.', done: '',
        touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: { terminalOnly: SETTINGS_ELSEWHERE },
        example: { setting: 'from', value: 'sam@example.com' },
        async run(values, ctx) {
          if (!host.setField) throw commandRefusal(`Mailbox settings are not changed here: ${SETTINGS_ELSEWHERE}.`);
          return await host.setField(ctx, values.setting!, values.value!);
        },
      },
      {
        id: 'password', label: 'Store the mailbox password', word: 'password',
        inputs: [{ id: 'password', label: 'Password', help: 'The mailbox password; it goes to the secret store and is never shown', kind: 'secret', required: true, typed: { position: 1 } }],
        sentence: 'The mailbox password is kept in the secret store, until you change it; settings hold only a reference to it.', done: '',
        touches: 'credential', lasts: 'kept', risk: 'none',
        ownerOnly: { reason: 'it stores the password the mailbox is opened with', instead: '/mail status says whether a password is stored' },
        operator: { terminalOnly: SETTINGS_ELSEWHERE },
        example: {},
        async run(values, ctx) {
          if (!host.setPassword) throw commandRefusal(`The mailbox password is not stored here: ${SETTINGS_ELSEWHERE}.`);
          return await host.setPassword(ctx, values.password!);
        },
      },
    ],
  }) });
}
