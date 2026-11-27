/**
 * schema-domain-daemon-mailbox.ts, the daemon's OWN mailbox and calendar.
 *
 * These keys live under `surfaces.` and so ride the surface domain's ownership
 * rule, but they are not a chat adapter and they do not belong beside Slack,
 * Discord and Telegram: those describe an external service the daemon talks
 * TO, while these describe the mail account and calendar the daemon speaks AS.
 * Splitting them out keeps `schema-domain-surfaces.ts` a list of adapters and
 * gives this pair a file whose header can say what they are for.
 *
 * ── Why they are declared at all ──────────────────────────────────────────
 *
 * The daemon's email and calendar handlers read these long before anything
 * declared them. `CONFIG_SCHEMA` is what the schema-driven settings modal
 * renders from, so an undeclared key is a key the modal cannot show, and the
 * handlers' own failure text names them:
 *
 *   "Email is not configured. Set surfaces.email.host, surfaces.email.user…"
 *
 * goodvibes-webui's CalendarView points operators at
 * `surfaces.calendar.caldavUrl` / `caldavUser` / `caldavPassword`, and
 * goodvibes-tui's setup guidance points at `surfaces.email.*`, so two products
 * were telling operators to set keys their settings UI had no row for.
 * Declaring them here is what makes those instructions land somewhere real.
 *
 * ── One spelling ──────────────────────────────────────────────────────────
 *
 * Each fact has one key: `host`, `user`, `from`, `password` for the account,
 * and `imap.*` / `smtp.*` for what differs per protocol. Every mail reader
 * resolves them through `readSurfaceEmailSettings` (email/surface-config.ts).
 *
 * ── Why this also fixes credential storage ────────────────────────────────
 *
 * `config-ownership.ts` derives the daemon-owned SECRET set by walking
 * `listDaemonOwnedConfigPaths()`, which is `CONFIG_SCHEMA` keys the daemon
 * owns plus a hand-kept list of non-scalar paths. `surfaces.` has always been
 * a daemon-owned PREFIX, so `isDaemonOwnedConfigKey` already answered true for
 * these, but nothing ENUMERATED them, so the walk produced no daemon-owned
 * credential name for them and `GOODVIBES_SURFACES_EMAIL_PASSWORD` was filed
 * in whichever client silo the operator happened to be sitting in. The daemon
 * reads none of those, so a stored mail password looked set and did nothing.
 * Being real schema keys puts them in that walk, which is why they are here
 * rather than on the non-scalar list in `config-ownership.ts`.
 */

import { type ConfigSettingDefinition, intRange, remotePort } from './schema-shared.js';

/** Validator for a setting that holds JSON text: empty is allowed, anything else must parse and pass `shape`. */
function jsonText(shape: (parsed: unknown) => boolean, hint: string): Pick<ConfigSettingDefinition, 'validate' | 'validationHint'> {
  return {
    validate: (value) => {
      if (typeof value !== 'string') return false;
      if (value.trim() === '') return true;
      try { return shape(JSON.parse(value)); } catch { return false; }
    },
    validationHint: hint,
  };
}

/** Defaults for the daemon's own mail account and calendar. */
export const daemonMailboxConfigDefaults = {
  email: {
    host: '',
    user: '',
    from: '',
    password: '',
    inboxTagging: false,
    imap: {
      host: '',
      port: 993,
      user: '',
      password: '',
      secure: true,
      mailbox: 'INBOX',
      draftsMailbox: '',
      authservIds: [] as string[],
    },
    smtp: {
      host: '',
      port: 465,
      password: '',
      secure: true,
    },
    // The inbound-mail watcher's own settings, the inbound section of
    // surfaces.email. See docs/decisions/2026-07-27-inbound-email-design.md §8 for the ruled defaults;
    // every one of them is the owner's to confirm or overturn.
    inbound: {
      enabled: false,
      accounts: '[]',
      mailboxes: '{}',
      source: 'auto',
      gmailPollSecondsExpecting: 5,
      gmailPollSecondsIdle: 60,
      mode: 'auto',
      pollIntervalSeconds: 120,
      idleReissueMinutes: 27,
      reconnect: {
        maxBackoffSeconds: 300,
      },
      notice: {
        route: 'default',
        mode: 'all',
      },
      expectationWindowMinutes: 15,
      dedupTtlMinutes: 60,
      retentionDays: 30,
      maxRecords: 5000,
      capabilityRecheckMinutes: 60,
      onInsufficientCapability: 'refuse-and-notify',
    },
  },
  calendar: {
    caldavUrl: '',
    caldavUser: '',
    caldavPassword: '',
    defaultCalendarId: '',
    calendars: '',
  },
};

/** Schema rows for the daemon's own mail account and calendar. */
export const daemonMailboxConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'surfaces.email.host', valueKind: 'endpoint',
    label: 'Mail server',
    type: 'string',
    description: 'Mail server hostname used for both IMAP and SMTP unless overridden below',
  },
  {
    key: 'surfaces.email.user',
    label: 'Mail account',
    type: 'string',
    description: 'Mailbox account name the daemon authenticates as',
  },
  {
    key: 'surfaces.email.from',
    label: 'Address mail is sent from',
    type: 'string',
    description: 'From address on mail the daemon sends; defaults to the account name',
  },
  {
    key: 'surfaces.email.password',
    label: 'Mail password',
    type: 'string',
    description: 'Mailbox password or app password. Stored in the daemon secret tier, never in config',
  },
  {
    key: 'surfaces.email.inboxTagging',
    label: 'Label mail with keywords',
    type: 'boolean',
    description: 'Write triage labels (GoodVibes/Spam, Priority, Normal) back to the mailbox as IMAP keywords on the messages they label. '
      + 'Off: labels stay in GoodVibes and channels.inbox.applyLabels refuses for this account.',
  },
  {
    key: 'surfaces.email.imap.host', valueKind: 'endpoint',
    label: 'Incoming mail server',
    type: 'string',
    description: 'IMAP hostname (e.g. imap.gmail.com), overriding surfaces.email.host',
  },
  {
    key: 'surfaces.email.imap.port',
    label: 'Incoming mail port',
    type: 'number',
    description: 'IMAP port',
    ...remotePort(),
  },
  {
    key: 'surfaces.email.imap.user',
    label: 'Incoming mail account',
    type: 'string',
    description: 'IMAP account name, overriding surfaces.email.user',
  },
  {
    key: 'surfaces.email.imap.password',
    label: 'Incoming mail password',
    type: 'string',
    description: 'IMAP password, overriding surfaces.email.password. Daemon secret tier',
  },
  {
    key: 'surfaces.email.imap.secure',
    label: 'Encrypt incoming mail connections',
    type: 'boolean',
    description: 'Connect to IMAP over TLS',
  },
  {
    key: 'surfaces.email.imap.mailbox',
    label: 'Mail folder GoodVibes reads',
    type: 'string',
    description: 'Mailbox the daemon reads',
  },
  {
    key: 'surfaces.email.imap.draftsMailbox',
    label: 'Folder for drafts',
    type: 'string',
    description: 'Mailbox drafts are appended to. Empty (the default) means ask the server which folder carries the \\Drafts flag, which is right for providers such as Gmail whose Drafts folder is not literally named "Drafts"',
  },
  {
    key: 'surfaces.email.smtp.host', valueKind: 'endpoint',
    label: 'Outgoing mail server',
    type: 'string',
    description: 'SMTP hostname, overriding surfaces.email.host',
  },
  {
    key: 'surfaces.email.smtp.port',
    label: 'Outgoing mail port',
    type: 'number',
    description: 'SMTP port',
    ...remotePort(),
  },
  {
    key: 'surfaces.email.smtp.password',
    label: 'Outgoing mail password',
    type: 'string',
    description: 'SMTP password when it differs from the IMAP one. Daemon secret tier',
  },
  {
    key: 'surfaces.email.smtp.secure',
    label: 'Encrypt outgoing mail connections',
    type: 'boolean',
    description: 'Connect to SMTP over TLS',
  },

  // ── Inbound-mail watcher, the inbound section of surfaces.email ──────────
  // See docs/decisions/2026-07-27-inbound-email-design.md §8 for the ruled defaults and the rationale
  // behind each one; every default here is the owner's to confirm.
  {
    key: 'surfaces.email.inbound.enabled', valueKind: 'opening-switch',
    label: 'Tell you when mail arrives',
    type: 'boolean',
    description: 'Turns on inbound notices: arriving mail is matched against open verification expectations, '
      + 'recorded and announced, and further accounts below are watched. Off by default. The daemon\'s own mailbox '
      + 'is read by one reader for the inbox as well whenever it is configured; this switch decides whether that '
      + 'mail is also announced.',
  },
  {
    key: 'surfaces.email.inbound.accounts',
    label: 'Mail accounts to watch',
    type: 'string',
    description: 'JSON array of configured mailbox account identifiers to watch for inbound mail, e.g. '
      + '["primary"]. The first names the daemon\'s own mailbox; empty labels it with the mail user. A list rather than a single '
      + 'switch because one address for signups and another for the owner\'s real mail is the expected shape. '
      + 'The first entry is the daemon\'s own mailbox (surfaces.email.*, or Gmail when Google is connected); '
      + 'every further entry is watched over IMAP with the connection surfaces.email.inbound.mailboxes gives it, '
      + 'and one without an entry there is reported in inbound mail status rather than watched.',
    ...jsonText((parsed) => Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string'), 'a JSON array of account names, e.g. ["primary"]'),
  },
  {
    key: 'surfaces.email.inbound.mailboxes',
    label: 'Mail folders for extra accounts',
    type: 'string',
    description: 'JSON object giving each account after the first in surfaces.email.inbound.accounts its own IMAP '
      + 'mailbox, e.g. {"signups":{"host":"imap.example.com","user":"signups@example.com"}}. Fields: host and user '
      + '(required), port (default 993, or 143 when secure is false), secure (default true; false only for a loopback '
      + 'host), mailbox (default INBOX) and passwordRef, a goodvibes://secrets/goodvibes/<KEY> reference whose key '
      + 'contains EMAIL, MAIL or IMAP as a word. Without passwordRef the password is read from the secret '
      + 'GOODVIBES_EMAIL_INBOUND_<ACCOUNT>_PASSWORD (the account name upper-cased, other characters as _). '
      + 'Each mailbox is watched with the same inbound settings as the first, and a change here takes effect without a restart.',
    ...jsonText(
      (parsed) => parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.values(parsed as Record<string, unknown>).every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
          && typeof (entry as Record<string, unknown>)['host'] === 'string'
          && typeof (entry as Record<string, unknown>)['user'] === 'string'),
      'a JSON object mapping account names to {"host":"…","user":"…"}, with optional port, secure, mailbox and passwordRef',
    ),
  },
  {
    key: 'surfaces.email.inbound.source',
    label: 'How new mail is read',
    type: 'enum',
    description: 'Which mechanism reads the mailbox. "auto" uses Gmail when Google credentials have been adopted '
      + 'and the configured mail account is a Gmail account, and IMAP otherwise, so connecting Google is the '
      + 'whole of the setup and no IMAP host, username or app password has to be found. "gmail" and "imap" force '
      + 'one of them. The two are not equivalent and the difference is a real cost: IMAP holds an IDLE '
      + 'connection, which is true push and delivers in under a second, while Gmail has no push available to a '
      + 'daemon on a home machine and is POLLED on a timer, its worst-case delay is the whole poll interval '
      + 'below, never less. Forcing "gmail" without adopted Google credentials, or on an account that is not a '
      + 'Gmail account, is refused rather than quietly served over IMAP.',
    enumValues: ['auto', 'gmail', 'imap'],
  },
  {
    key: 'surfaces.email.inbound.gmailPollSecondsExpecting',
    label: 'Check Gmail while expecting mail every (seconds)',
    type: 'number',
    description: 'How often the Gmail source asks Google what changed while something is actually being waited '
      + 'for, a signup mid-flight whose verification mail has not arrived yet. This is polling, not push: mail '
      + 'can sit unnoticed for up to this many seconds, and no setting makes Gmail faster than the interval. '
      + 'Five seconds is the floor worth having for a person watching a signup form; the underlying call costs 2 '
      + 'quota units against a daily budget in the billions, so a shorter interval buys latency rather than '
      + 'saving quota. Ignored entirely when the IMAP source is in use, which pushes instead.',
    ...intRange(2, 60),
  },
  {
    key: 'surfaces.email.inbound.gmailPollSecondsIdle',
    label: 'Check Gmail otherwise every (seconds)',
    type: 'number',
    description: 'How often the Gmail source asks Google what changed when nothing is being waited for. Again '
      + 'polling, not push: with nothing pending, mail is noticed up to this many seconds after it arrives. A '
      + 'minute keeps the daemon from asking Google every five seconds all week for mail nobody is waiting on; '
      + 'lowering it narrows that gap at the cost of a request every few seconds around the clock. Ignored '
      + 'entirely when the IMAP source is in use.',
    ...intRange(10, 3600),
  },
  {
    key: 'surfaces.email.inbound.mode',
    label: 'How new mail is noticed',
    type: 'enum',
    description: 'How the IMAP source receives new mail: "idle" holds a persistent IMAP IDLE connection, "poll" '
      + 'checks on a timer, "auto" uses IDLE when the server advertises it and falls back to polling when it '
      + 'does not. Leave at auto unless a specific provider needs to be forced one way. Applies only to the IMAP '
      + 'source; the Gmail source has no IDLE to hold and is always polled, on the two intervals above.',
    enumValues: ['idle', 'poll', 'auto'],
  },
  {
    key: 'surfaces.email.inbound.pollIntervalSeconds',
    label: 'Check for mail every (seconds)',
    type: 'number',
    description: 'How often the fallback poller checks the mailbox when IDLE is unavailable. Lower is more '
      + 'responsive but closer to a provider\'s rate limit; higher delays notice of new mail by up to this many '
      + 'seconds. Only applies when the connection is not using IDLE.',
    ...intRange(30, 3600),
  },
  {
    key: 'surfaces.email.inbound.idleReissueMinutes',
    label: 'Renew the open mail connection every (minutes)',
    type: 'number',
    description: 'How often an open IDLE connection is torn down and re-issued. RFC 2177 advises re-issuing at '
      + 'least every 29 minutes, or the server may silently log the connection off; raising this toward 29 trims '
      + 'reconnect churn but leaves less margin against a slow round trip.',
    ...intRange(5, 29),
  },
  {
    key: 'surfaces.email.inbound.reconnect.maxBackoffSeconds',
    label: 'Longest wait before reconnecting to mail (seconds)',
    type: 'number',
    description: 'Ceiling on the exponential reconnect backoff after a dropped connection or provider error. '
      + 'Raising it tolerates a longer provider outage without hammering it; lowering it shortens the '
      + 'worst-case silence after a disconnect at the cost of retrying a still-down server more often.',
    ...intRange(10, 3600),
  },
  {
    key: 'surfaces.email.inbound.notice.route',
    label: 'Where you hear about new mail',
    type: 'string',
    description: 'Where the owner is told about inbound mail: the literal "default" uses the owner\'s most recently '
      + 'used one-to-one conversation with the daemon (never a group or shared channel); a specific route binding id, '
      + 'shared or not, sends inbound-mail notices there instead. '
      + 'A second place to configure "where to reach me" is a second place to get it wrong, so most '
      + 'installations should leave this at default.',
  },
  {
    key: 'surfaces.email.inbound.notice.mode',
    label: 'Which new mail you hear about',
    type: 'enum',
    description: 'How much inbound mail generates an owner notice: "all" announces every message, '
      + '"expected-only" announces only mail matching a registered expectation (quieter for a high-volume '
      + 'mailbox), "none" announces nothing. Choosing "none" means mail can arrive with no notice at all, a '
      + 'deliberate but silent choice.',
    enumValues: ['all', 'expected-only', 'none'],
  },
  {
    key: 'surfaces.email.inbound.expectationWindowMinutes',
    label: 'How long to wait for an expected email (minutes)',
    type: 'number',
    description: 'Default lifetime, in minutes, of a verification expectation opened for inbound-mail matching '
      + '(for example an account signup awaiting its confirmation email). Raising it gives a slower-to-arrive '
      + 'confirmation more time to match; lowering it shrinks how long a stale expectation can be satisfied by a '
      + 'late message. Hard-capped at 60 to match MAX_VERIFICATION_WINDOW_MS. Applies after the daemon restarts.',
    ...intRange(1, 60),
  },
  {
    key: 'surfaces.email.inbound.dedupTtlMinutes',
    label: 'Remember a seen email for (minutes)',
    type: 'number',
    description: 'How long an inbound message\'s identity is remembered, inside the running daemon, so an '
      + 'overlapping poll or a retried pass does not process it twice. This cache lives in memory only: a '
      + 'restart destroys it rather than expiring it, so no value here prevents a duplicate across a restart, '
      + 'the inbound record store does that, by remembering which messages were already announced. Seconds '
      + 'would be enough for what this covers; a larger value only costs a little memory.',
    ...intRange(5, 1440),
  },
  {
    key: 'surfaces.email.inbound.retentionDays',
    label: 'Keep records of received mail for (days)',
    type: 'number',
    description: 'How many days an inbound mail record (sender, subject, delivery evidence, link verdicts, '
      + 'never the full body) is kept before it is reaped. Longer keeps a longer history to explain "why did I '
      + 'get that message"; shorter bounds how much of the owner\'s mail metadata the daemon retains. Applies after the daemon restarts.',
    ...intRange(1, 365),
  },
  {
    key: 'surfaces.email.inbound.maxRecords',
    label: 'Most records of received mail kept',
    type: 'number',
    description: 'Hard cap on the number of inbound mail records kept regardless of age. Whichever of this and '
      + 'retentionDays is reached first wins, so this bounds worst-case storage even under a burst of mail. Applies after the daemon restarts.',
    ...intRange(100, 100_000),
  },
  {
    key: 'surfaces.email.inbound.capabilityRecheckMinutes',
    label: 'Recheck a mailbox that lacked access every (minutes)',
    type: 'number',
    description: 'How often a mailbox that reported it cannot do what inbound mail requires (for example a '
      + 'Gmail grant that authorizes listing but not reading message bodies, or a mailbox that does not exist) is '
      + 're-probed. Long enough that a refused account is not hammered in a tight loop; short enough that fixing '
      + 'the underlying scope or account problem is noticed without a daemon restart.',
    ...intRange(5, 1440),
  },
  {
    key: 'surfaces.email.inbound.onInsufficientCapability',
    label: 'When a mailbox lacks access',
    type: 'enum',
    description: '"refuse-and-notify" stops the watcher for that account and tells the owner once, naming what '
      + 'is missing and the exact step to fix it, the account is not watched again until the recheck above '
      + 'finds it fixed. "notice-only" is a deliberate downgrade: it keeps announcing that mail arrived using '
      + 'envelope fields alone (sender, subject, delivery evidence), stating plainly in every notice that bodies '
      + 'are unavailable, and it can never satisfy a verification expectation while degraded, an account signup '
      + 'or order confirmation will not work under it. "notice-only" applies to exactly one condition: a Google '
      + 'grant that authorizes message headers and excludes message bodies (the gmail.metadata scope), which is '
      + 'the only case where mail can be seen arriving without being readable. Every other insufficient '
      + 'condition, no stored password, a refused sign-in, a mailbox that will not open, a lost cursor, a '
      + 'refused or unreadable fetch, leaves no envelope fields to announce, so "notice-only" behaves as '
      + '"refuse-and-notify" there and the notice says which one is in force.',
    enumValues: ['refuse-and-notify', 'notice-only'],
  },

  {
    key: 'surfaces.calendar.caldavUrl', valueKind: 'endpoint',
    label: 'Calendar server',
    type: 'string',
    description: 'CalDAV server URL the daemon reads and writes events through',
  },
  {
    key: 'surfaces.calendar.caldavUser',
    label: 'Calendar account',
    type: 'string',
    description: 'CalDAV account name',
  },
  {
    key: 'surfaces.calendar.caldavPassword',
    label: 'Calendar password',
    type: 'string',
    description: 'CalDAV password. Stored in the daemon secret tier, never in config',
  },
  {
    key: 'surfaces.calendar.defaultCalendarId',
    label: 'Calendar used when none is named',
    type: 'string',
    description: 'Calendar used when a request names none',
  },
  {
    key: 'surfaces.calendar.calendars',
    label: 'Calendars and their paths',
    type: 'string',
    description: 'JSON object mapping a calendar id to its collection path, e.g. {"work":"/dav/calendars/work/"}. Empty means the CalDAV URL is the one calendar',
    ...jsonText(
      (parsed) => parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.values(parsed as Record<string, unknown>).every((path) => typeof path === 'string'),
      'a JSON object mapping calendar ids to collection paths',
    ),
  },
];
