import { judgmentPort, readFailure } from '@goodvibes/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { requireActingReading } from '../types/judgment-held.js';
/**
 * Opening a connection: what it turned out to be able to do, the ways it can
 * fail to become readable, and what the owner is told when it does.
 *
 * Split out of `imap-client.ts` to keep that file under the repository's
 * per-file line cap, and because these types are what a caller reasons about
 * BEFORE it has a usable client, the failure it has to classify and the
 * capability record it has to read.
 */

import { assertImapReadingCurrent, imapFailureText, imapReadingLease, readImapRefusal, type ImapReadingOptions, type ImapReadingLease } from './imap-readings.js';
import type { ImapMailboxStatus } from './imap-headers.js';
import type { ImapConnection, ImapSession } from './imap-session.js';
import type { ImapClient } from './imap-client.js';

/**
 * What a caller is told when it reads before connecting. Named rather than
 * inlined because two places raise it and one test asserts on it.
 */
export const NOT_OPEN_MESSAGE =
  'The IMAP connection is not open. Call open() before reading from the mailbox.';

/**
 * Why a connection could not be opened, as four distinct facts.
 *
 * They are distinct because they call for different responses, and a caller
 * that cannot tell them apart necessarily gets some of them wrong:
 *
 *   - `authentication-rejected`, the credential was REFUSED as a credential,
 *     or could not be put on the wire at all. TERMINAL. Retrying a rejected
 *     password on a backoff loop is how an account gets locked; the operator
 *     has to change something before this can succeed.
 *   - `mailbox-unavailable`, the credential worked and the named mailbox does
 *     not exist. TERMINAL for the same reason: reconnecting does not create a
 *     folder. Authenticated is not readable, and this is the case that says so.
 *   - `server-unavailable`, the server said no for a reason that is about the
 *     SERVER, not the account: a connection limit, a capacity refusal, a
 *     temporary fault. NOT terminal. This exists because a refusal at the
 *     login step is not necessarily about the login: Gmail answers
 *     `NO [LIMIT] Too many simultaneous connections` right there, and it
 *     clears in seconds. Classifying that as a rejected credential stops a
 *     watcher permanently, and the symptom is a mailbox that looks quiet while
 *     mail piles up behind it, which is the failure this whole capability
 *     exists to end. We reach it routinely on our own account, because
 *     `EmailService` opens a fresh connection per request on top of the one a
 *     watcher holds permanently, and Gmail allows fifteen at once.
 *   - `connection-failed`, the socket, the greeting or the timing. Transient.
 *
 * When the server gives no response code and its wording is ambiguous, the
 * classification is deliberately the NON-terminal one. The asymmetry is not
 * close: guessing terminal stops mail delivery until a human notices, guessing
 * transient costs a retry.
 */
export type ImapOpenFailureReason =
  | 'authentication-rejected'
  | 'mailbox-unavailable'
  | 'server-unavailable'
  | 'connection-failed';

/** Reasons where retrying cannot help; something has to change first. */
const TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'authentication-rejected',
  'mailbox-unavailable',
  'credential-unavailable',
  'store-unreadable',
  'bodies-unfetchable',
]);

/**
 * RFC 3501 / RFC 5530 response codes that describe the SERVER's condition
 * rather than the account's. None of these is a reason to stop.
 *
 * `LIMIT` is Gmail's too-many-connections refusal. `INUSE` is a mailbox
 * another session holds. `UNAVAILABLE` is the server saying so outright.
 * `SERVERBUG` and `CONTACTADMIN` describe a server fault, which is somebody
 * else's to fix and not a reason to stop asking.
 */
const TRANSIENT_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'LIMIT',
  'INUSE',
  'UNAVAILABLE',
  'SERVERBUG',
  'CONTACTADMIN',
  'OVERQUOTA',
]);

/** Response codes that name a credential the server will not accept. */
const AUTH_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'AUTHENTICATIONFAILED',
  'AUTHORIZATIONFAILED',
  'EXPIRED',
  'PRIVACYREQUIRED',
]);

/** Response codes that name a mailbox that is not there. */
const MAILBOX_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'NONEXISTENT',
  'TRYCREATE',
]);

/** The bracketed response code of a `NO`/`BAD` line, upper-cased, or ''. */
function responseCodeOf(serverMessage: string): string {
  const match = /\[([A-Za-z-]+)[\s\]]/.exec(serverMessage);
  return (match?.[1] ?? '').toUpperCase();
}

/**
 * What a server refusal actually means, read from the refusal itself.
 *
 * The phase a refusal arrived in is a hint, not the answer. A `NO` at the
 * login step is only an authentication failure when it says something about
 * authentication; when it says `[LIMIT]` it is about the server, and treating
 * the two the same is how a transient condition becomes permanent silence.
 * When the refusal states nothing, a non-terminal phase reason is used as is,
 * and a terminal one (a refused LOGIN, a refused EXAMINE) only after
 * `MAX_UNEXPLAINED_REFUSALS` identical refusals in a row; before that it is
 * retried on the long backoff.
 */
export async function classifyServerRefusal(
  serverMessage: string,
  phaseReason: ImapOpenFailureReason,
  options: ImapReadingOptions = {},
): Promise<ImapOpenFailureReason> {
  const reading = await classifyServerRefusalOwned(serverMessage, phaseReason, options);
  reading.assertCurrent();
  return reading.value;
}

/** Internal result keeps the original judgment owner through every caller await. */
export async function classifyServerRefusalOwned(
  serverMessage: string,
  phaseReason: ImapOpenFailureReason,
  options: ImapReadingOptions = {},
): Promise<ImapReadingLease<ImapOpenFailureReason>> {
  const detailed = await classifyServerRefusalDetailed(serverMessage, phaseReason, '', options);
  return imapReadingLease(detailed.value.reason, detailed);
}

/**
 * How many code-less refusals in a row a sign-in or folder open may get before
 * the phase decides. The phase is the evidence when the server names nothing:
 * a refused LOGIN that gives no reason is, after a few tries, a refused
 * password, and retrying it for ever is how an account gets locked.
 */
export const MAX_UNEXPLAINED_REFUSALS = 3;
const unexplainedRefusals = new Map<string, number>();
const MAX_TRACKED_REFUSALS = 64;

/** A sign-in and folder open succeeded for this account: earlier unexplained refusals are over. */
export function noteImapOpenAccepted(account: string): void {
  for (const key of [...unexplainedRefusals.keys()]) {
    if (key.startsWith(`${account}\n`)) unexplainedRefusals.delete(key);
  }
}

interface RefusalClassification {
  readonly reason: ImapOpenFailureReason;
  /** Set when the server named no cause and the phase rule is counting: which attempt this was. */
  readonly unexplainedAttempt?: number;
}

async function classifyServerRefusalDetailed(
  serverMessage: string,
  phaseReason: ImapOpenFailureReason,
  account: string,
  options: ImapReadingOptions,
): Promise<ImapReadingLease<RefusalClassification>> {
  assertImapReadingCurrent(options);
  const owner = options.publication ?? options;
  const code = responseCodeOf(serverMessage);
  if (TRANSIENT_RESPONSE_CODES.has(code)) return imapReadingLease({ reason: 'server-unavailable' }, owner);
  if (AUTH_RESPONSE_CODES.has(code)) return imapReadingLease({ reason: 'authentication-rejected' }, owner);
  if (MAILBOX_RESPONSE_CODES.has(code)) return imapReadingLease({ reason: 'mailbox-unavailable' }, owner);
  const reading = await readImapRefusal(serverMessage, options);
  reading.assertCurrent();
  assertImapReadingCurrent(options);
  if (reading.value === 'server') return imapReadingLease({ reason: 'server-unavailable' }, reading);
  if (reading.value === 'credential') return imapReadingLease({ reason: 'authentication-rejected' }, reading);
  if (reading.value === 'mailbox') return imapReadingLease({ reason: 'mailbox-unavailable' }, reading);
  if (!TERMINAL_REASONS.has(phaseReason)) return imapReadingLease({ reason: phaseReason }, reading);
  // Nothing stated, or no model to read it: the phase decides after a bounded
  // number of identical refusals, and until then it is retried on the long backoff.
  const key = `${account}\n${phaseReason}\n${serverMessage.replace(/^IMAP command failed:\s*\S+\s+/, '').trim().slice(0, 500)}`;
  const attempt = (unexplainedRefusals.get(key) ?? 0) + 1;
  unexplainedRefusals.delete(key); unexplainedRefusals.set(key, attempt);
  if (unexplainedRefusals.size > MAX_TRACKED_REFUSALS) unexplainedRefusals.delete(unexplainedRefusals.keys().next().value!);
  return imapReadingLease({
    reason: attempt >= MAX_UNEXPLAINED_REFUSALS ? phaseReason : 'server-unavailable',
    unexplainedAttempt: attempt,
  }, reading);
}

/** The owner sentence for a refusal the server gave no reason for. */
function unexplainedRefusalMessage(phaseReason: ImapOpenFailureReason, attempt: number, mailbox: string): string {
  const signIn = phaseReason === 'authentication-rejected';
  const what = signIn ? 'the sign-in' : `opening the folder '${mailbox}'`;
  const remedy = signIn
    ? 'replace the mailbox password (surfaces.email.password) at daemon scope, and reconnect'
    : 'check that surfaces.email.imap.mailbox names a folder that exists on the server';
  if (attempt < MAX_UNEXPLAINED_REFUSALS) {
    return `The mail server refused ${what} without giving a reason (attempt ${String(attempt)} of `
      + `${String(MAX_UNEXPLAINED_REFUSALS)}). It is retried on a longer backoff; if it keeps happening, ${remedy}.`;
  }
  return `The mail server refused ${what} ${String(attempt)} times in a row without giving a reason, so it is `
    + `no longer retried${signIn ? ': repeated refused sign-ins are how an account gets locked' : ''}. To fix it, ${remedy}.`;
}

const failureReadings = new WeakMap<object, ImapReadingLease<unknown>>();
export function assertImapFailureCurrent(error: unknown): void {
  if (error && typeof error === 'object') failureReadings.get(error)?.assertCurrent();
}
export function retainImapFailureReading(error: object, reading: ImapReadingLease<unknown>): void {
  reading.assertCurrent(); failureReadings.set(error, reading);
}

/**
 * An `open()` that did not reach a readable mailbox, with the reason named.
 *
 * Diagnostics contain the typed reason and host summary only. Raw server
 * refusals may contain credentials or private account data and are not retained.
 */
export class ImapOpenError extends Error {
  readonly reason: ImapOpenFailureReason;
  /** Empty for IMAP failures: raw server/private exception text is withheld. */
  readonly serverMessage: string;
  /** The mailbox this attempt was for. */
  readonly mailbox: string;
  /** True only when retrying cannot help; something has to change first. */
  readonly terminal: boolean;
  /**
   * The routable record. A supervisor reads this and delivers it; it does not
   * have to re-derive from a message string what the failure was, and a
   * terminal failure therefore cannot end as a log line nobody reads.
   */
  readonly notice: EmailCapabilityFailureNotice;

  constructor(input: {
    readonly reason: ImapOpenFailureReason;
    readonly summary: string;
    readonly serverMessage: string;
    readonly mailbox: string;
    /** Replaces the reason's standard sentence when this failure has a more exact one. */
    readonly ownerMessage?: string;
  }) {
    super(input.summary);
    this.name = 'ImapOpenError';
    this.reason = input.reason;
    this.serverMessage = '';
    this.mailbox = input.mailbox;
    this.terminal = TERMINAL_REASONS.has(input.reason);
    this.notice = {
      reason: input.reason,
      terminal: this.terminal,
      mailbox: input.mailbox,
      ownerMessage: input.ownerMessage ?? ownerMessageForFailure(input.reason, input.mailbox),
      serverMessage: '',
    };
  }
}

/**
 * What a connection turned out to be able to do, established at open time.
 *
 * Returned by `open()` rather than assumed, because "the socket connected and
 * the password was accepted" answers neither "can I read this mailbox" nor
 * "can this connection be held open with IDLE", and a caller that treats it as
 * though it did has no way to find out it was wrong except by getting nothing.
 */
export interface ImapConnectionReport {
  /**
   * Capability atoms the server volunteered, upper-cased. Empty means it
   * volunteered none, ask `capabilities()`, which will request them.
   */
  readonly advertisedCapabilities: readonly string[];
  /**
   * Whether `IDLE` (RFC 2177) was advertised, as two cases, not three values.
   *
   * A tri-state whose third value can be read as falsy looks careful and
   * behaves carelessly: `if (report.supportsIdle)` would compile and would
   * quietly mean "poll forever against a server that supports push". This
   * shape does not permit that. `.supported` does not exist until `.known` has
   * been narrowed to true, so a caller either handles "the server said
   * nothing" or does not compile.
   *
   * The way to handle it is `resolveIdleSupport(client)`, which answers the
   * unknown case by actually asking.
   */
  readonly idle: ImapIdleSupport;
  /** The mailbox that was EXAMINEd, and what the server said about it. */
  readonly mailbox: ImapMailboxStatus & { readonly name: string };
}

/**
 * What the server said about IDLE, in a shape that cannot be read as a boolean
 * by accident.
 *
 * Two cases, not three values: either the server told us (`known: true`, with
 * the answer) or it told us nothing (`known: false`, with no answer to read).
 * `supported` is deliberately absent from the second case rather than present
 * and undefined, present-and-undefined is falsy, which is the exact mistake
 * this shape exists to make impossible.
 */
export type ImapIdleSupport =
  | { readonly known: true; readonly supported: boolean }
  | { readonly known: false };

/** Build the IDLE case from a capability set, empty meaning "said nothing". */
export function idleSupportFrom(capabilities: readonly string[]): ImapIdleSupport {
  if (capabilities.length === 0) return { known: false };
  return { known: true, supported: capabilities.includes('IDLE') };
}

/** Whether IDLE can be used, and how that was established. */
export interface ImapIdleDecision {
  readonly supported: boolean;
  /**
   * `advertised`, the server named IDLE.
   * `not-advertised`, the server listed its capabilities and IDLE was not one.
   * `server-would-not-say`, it never listed them, even when asked. Polling is
   *   the right fallback, and the reason belongs in the surfaced status so the
   *   owner can see WHY it is polling rather than assume the provider cannot
   *   do better.
   */
  readonly reason: 'advertised' | 'not-advertised' | 'server-would-not-say';
}

/**
 * Resolve IDLE support, asking the server when it volunteered nothing.
 *
 * This is the accessor the watcher goes through. It exists so that "the server
 * said nothing" is answered by a `CAPABILITY` command rather than by a
 * shrug, an unknown resolved into a real answer, or into a named reason for
 * not having one.
 */
export async function resolveIdleSupport(
  client: Pick<ImapClient, 'capabilities'>,
): Promise<ImapIdleDecision> {
  const capabilities = await client.capabilities();
  if (capabilities.length === 0) {
    return { supported: false, reason: 'server-would-not-say' };
  }
  return capabilities.includes('IDLE')
    ? { supported: true, reason: 'advertised' }
    : { supported: false, reason: 'not-advertised' };
}

// ---------------------------------------------------------------------------
// Surfacing a failure to the owner
// ---------------------------------------------------------------------------

/**
 * Why a mailbox capability is unavailable, in a form a supervisor can route.
 *
 * `credential-unavailable` sits alongside the three open failures because it
 * is the same fact from one step earlier: there is nothing to sign in with.
 * It is called out separately because its fix is different from a rejected
 * password, the secret is missing rather than wrong.
 *
 * `bodies-unfetchable` sits alongside them from one step LATER: the credential
 * worked, the mailbox opened, and the server will not hand over what is inside
 * a message. It is deliberately not `mailbox-unavailable` and deliberately not
 * a refused fetch, the server answered, and answered with nothing, because
 * its remedy is different from both: the account's access rights, not the
 * folder name and not the password.
 */
export type EmailCapabilityFailureReason =
  | ImapOpenFailureReason
  | 'credential-unavailable'
  /** The secret store this computer holds could not be read: the password may be stored; it is not asked for again. */
  | 'store-unreadable'
  | 'bodies-unfetchable';

/**
 * A terminal failure that must reach the owner, not merely a log line.
 *
 * A watcher that stops permanently has to say so somewhere authoritative and
 * name the step that fixes it. Silence is the failure this whole capability
 * exists to end: an inbox that looks quiet while mail piles up in it is
 * indistinguishable, from the outside, from an inbox with no mail in it.
 */
export interface EmailCapabilityFailureNotice {
  readonly reason: EmailCapabilityFailureReason;
  /** True when retrying cannot help; something has to change first. */
  readonly terminal: boolean;
  /** The mailbox this was about, or '' when it was not about one. */
  readonly mailbox: string;
  /** One or two sentences for the owner, naming the step that fixes it. */
  readonly ownerMessage: string;
  /** The server's own words, or the underlying failure text. '' when neither. */
  readonly serverMessage: string;
}

/** The owner-facing sentence for each reason, naming the step that fixes it. */
export function ownerMessageForFailure(
  reason: EmailCapabilityFailureReason,
  mailbox: string,
): string {
  switch (reason) {
    case 'credential-unavailable':
      return 'No mail password is stored where the daemon reads secrets. Nothing '
        + 'will be read until the mailbox password (surfaces.email.password) is '
        + 'stored at daemon scope. A credential saved by another surface is not visible '
        + 'here and is deliberately not searched for, reading one would work on '
        + 'the machine that saved it and fail everywhere else.';
    case 'store-unreadable':
      // The cause is in the error's own words (secret-store-unreadable.ts); this is the sentence without it.
      return 'The secret store on this computer could not be read, so the mailbox password could not be read; '
        + 'nothing already given there is asked for again. Nothing is read from the mailbox until the store can be read.';
    case 'authentication-rejected':
      return 'The mail server rejected the sign-in. Nothing will be read until '
        + 'the stored password is replaced: store a working mailbox password '
        + '(surfaces.email.password) at daemon scope, and reconnect. The '
        + 'rejected credential is not retried, because repeated rejected '
        + 'sign-ins are how an account gets locked.';
    case 'mailbox-unavailable':
      return `Sign-in worked, but the folder '${mailbox}' could not be opened. `
        + 'Nothing will be read from it until surfaces.email.imap.mailbox names a folder that '
        + 'exists on the server.';
    case 'bodies-unfetchable':
      return `This account can sign in and open '${mailbox}' but is not `
        + 'permitted to read message content, so check this account\'s access '
        + `rights on '${mailbox}', and where the provider offers a restricted `
        + 'or metadata-only app password, replace it with one that may read '
        + 'message content.';
    case 'server-unavailable':
      return 'The mail server refused the connection for now, it reported a '
        + 'limit or a fault of its own, not a problem with the account. The '
        + 'usual cause is too many mailbox connections at once. This is retried '
        + 'automatically on a longer backoff; no change is needed unless it '
        + 'keeps happening.';
    case 'connection-failed':
      return 'Could not reach the mail server. This is retried automatically, so '
        + 'no change is needed unless it keeps happening.';
  }
}

/**
 * Read the routable notice off a failure, whatever threw it.
 *
 * Structural rather than `instanceof`, so a credential failure raised before
 * any socket exists, in a module this one must not import, is routed by the
 * same path as an open failure.
 */
export function describeEmailCapabilityFailure(
  error: unknown,
): EmailCapabilityFailureNotice | null {
  if (typeof error !== 'object' || error === null) return null;
  assertImapFailureCurrent(error);
  const candidate = (error as { readonly notice?: unknown }).notice;
  if (typeof candidate !== 'object' || candidate === null) return null;
  const notice = candidate as Partial<EmailCapabilityFailureNotice>;
  if (typeof notice.reason !== 'string' || typeof notice.ownerMessage !== 'string') return null;
  if (typeof notice.terminal !== 'boolean') return null;
  return notice as EmailCapabilityFailureNotice;
}

/**
 * The live wire session of each open client.
 *
 * A module-scoped map rather than a public getter, so `ImapClient`'s method
 * surface stays "the commands this client speaks" and holding a client is not
 * itself a way to put arbitrary bytes on the mailbox connection. Weak, so a
 * client that is dropped without `logout()` does not pin its session here.
 */
const liveConnections = new WeakMap<ImapClient, ImapSession>();

/**
 * The wire connection of an OPEN client, for protocol work that cannot be
 * expressed as "send a command, read its response".
 *
 * IDLE is why this exists: it sends `IDLE`, waits for a `+`, reads untagged
 * responses for up to twenty-seven minutes, sends the bare line `DONE`, and
 * only then collects the completion of the tag it issued at the start.
 *
 * Deliberately a free function, and deliberately not re-exported from
 * `email/index.ts`: it is reachable from the modules that sit beside this one
 * and from nowhere else.
 */
export function imapConnection(client: ImapClient): ImapConnection {
  const session = liveConnections.get(client);
  if (session === undefined) throw new Error(NOT_OPEN_MESSAGE);
  return session;
}

/**
 * The failure for a stored value that cannot be written to an IMAP connection
 * (a CR or LF, or a character outside printable US-ASCII). The server never saw
 * it, so the owner is told what to change rather than that a sign-in was refused.
 */
function unsendableValueFailure(errorText: string, mailbox: string): ImapOpenError {
  const why = /must not contain carriage return or newline/.test(errorText)
    ? 'contains a line break'
    : 'contains characters that cannot be sent to an IMAP server (only printable ASCII is supported)';
  if (errorText.startsWith('Invalid IMAP mailbox name:')) {
    return new ImapOpenError({
      reason: 'mailbox-unavailable',
      summary: `The mailbox name '${mailbox}' cannot be sent to a mail server.`,
      serverMessage: '',
      mailbox,
      ownerMessage: `The configured folder name ${why}, so the server was never asked to open it. `
        + 'Nothing will be read until surfaces.email.imap.mailbox names a folder that exists on the server.',
    });
  }
  const username = errorText.startsWith('Invalid IMAP username:');
  return new ImapOpenError({
    reason: 'authentication-rejected',
    summary: 'The stored mail credentials cannot be sent to a mail server.',
    serverMessage: '',
    mailbox,
    ownerMessage: username
      ? `The configured mail user name ${why}, so the server was never contacted with it. `
        + 'Set surfaces.email.imap.user to the mailbox sign-in name, and reconnect.'
      : `The stored mail password ${why}, so the server was never contacted with it. `
        + 'Store a mailbox password made of printable ASCII characters, such as an app password, '
        + 'as surfaces.email.password at daemon scope, and reconnect.',
  });
}

/**
 * Compose a named open failure without retaining private server wording.
 *
 * `refusedReason` is what the failing phase means when the SERVER said no. A
 * phase that timed out or lost the socket instead did not get an answer at
 * all, and calling that a rejected credential would mark a transient network
 * stall terminal and stop a watcher from ever retrying it. So the
 * classification is made on what actually happened, not on which phase it
 * happened in.
 */
export async function composeOpenFailure(input: {
  readonly refusedReason: ImapOpenFailureReason;
  readonly refusedSummary: string;
  readonly error: unknown;
  readonly mailbox: string;
  /** Whose sign-in this was; keys the count of refusals the server gave no reason for. */
  readonly account?: string;
}, options: ImapReadingOptions = {}): Promise<ImapOpenError> {
  assertImapReadingCurrent(options);
  const serverMessage = imapFailureText(input.error);

  // A value that cannot be put on the wire at all never reached the server, so
  // there is no refusal to read: it is the stored value, terminally. The owner
  // sentence names which value it was and never repeats it.
  if (serverMessage.startsWith('Invalid IMAP ')) {
    return unsendableValueFailure(serverMessage, input.mailbox);
  }

  // The server said no. What it said is the authority on what it meant, the
  // phase only supplies the fallback, and only when it is not the terminal
  // guess.
  if (serverMessage.startsWith('IMAP command failed:')) {
    const reading = await classifyServerRefusalDetailed(serverMessage, input.refusedReason, input.account ?? '', options);
    reading.assertCurrent();
    const { reason, unexplainedAttempt } = reading.value;
    assertImapReadingCurrent(options);
    const failure = new ImapOpenError({
      reason,
      summary: reason === input.refusedReason
        ? input.refusedSummary
        : summaryForReason(reason, input.mailbox),
      serverMessage: '',
      mailbox: input.mailbox,
      ...(unexplainedAttempt === undefined ? {} : {
        ownerMessage: unexplainedRefusalMessage(input.refusedReason, unexplainedAttempt, input.mailbox),
      }),
    });
    retainImapFailureReading(failure, reading);
    return failure;
  }

  // No refusal at all: a timeout, a closed socket, a greeting that never came.
  return new ImapOpenError({
    reason: 'connection-failed',
    summary: input.refusedReason === 'connection-failed'
      ? input.refusedSummary
      : `The connection to the mail server failed before the mailbox `
        + `'${input.mailbox}' was open for reading.`,
    serverMessage: '',
    mailbox: input.mailbox,
  });
}

/** The one-line summary for a reason the phase did not predict. */
function summaryForReason(reason: ImapOpenFailureReason, mailbox: string): string {
  switch (reason) {
    case 'authentication-rejected':
      return 'The mail server rejected the stored credentials.';
    case 'mailbox-unavailable':
      return `Signed in, but the mailbox '${mailbox}' could not be opened for reading.`;
    case 'server-unavailable':
      return 'The mail server refused the connection for now.';
    case 'connection-failed':
      return 'The mail server did not answer.';
  }
}

/** Record the live session of a client that has just connected. */
export function rememberConnection(client: ImapClient, session: ImapSession): void {
  liveConnections.set(client, session);
}

/** Forget a client's session; it is no longer usable. */
export function forgetConnection(client: ImapClient): void {
  liveConnections.delete(client);
}
