/**
 * The account's mail inbox, fed by the mailbox reader.
 *
 * The inbound mailbox reader (email/inbound) is the only thing that reads the
 * mailbox. This owner is one of its consumers: it screens each message the
 * reader hands it, stores the redacted row in the account's own mirror, and
 * tells triage and the owner-mail relay. It never opens a mail connection; the
 * complete source is read on the reader's own session, only for a message the
 * mirror does not hold yet.
 */
import { createProtectedSourceOwner } from '../../security/source-screening/owner.js';
import type { ProtectedSourceOwnerOptions, ProtectedSource } from '../../security/source-screening/types.js';
import { MailboxConsumerUnavailableError, type MailboxConsumer, type MailboxReaderState } from '../../email/inbound/mailbox-consumers.js';
import type { GmailInboundMessage, ImapInboundMessage, InboundMailboxMessage, MailboxReadPosition } from '../../email/inbound/ports.js';
import type { OwnedInboxReadLease } from '../registration.js';
import { digestSender, normalizeWhitespace, stripMarkup } from '../text-normalization.js';
import type { InboundChannelItem, InboundProviderAdapter, PushedProviderSink, PushedProviderStatus, RouteResolver } from '../provider-adapter.js';
import { resolveAccountInboxIdentity, type AccountInboxIdentity } from './account-identity.js';

export interface EmailInboxAccount {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly mailbox: string;
  readonly security: 'tls';
}
export interface EmailInboxOwnerOptions {
  readonly identity: AccountInboxIdentity;
  readonly account: EmailInboxAccount;
  readonly screening: ProtectedSourceOwnerOptions;
  /** The selected account's own currentness; throws once its settings or credential changed. */
  readonly assertCurrent: () => void;
  /** Optional metadata-only routing capability. */
  readonly resolveRouteId?: RouteResolver;
  /**
   * Called once per message after it passed source screening and its row was
   * stored, with the screened subject and body and the message's own date. A
   * batch handed over again after a failure can offer the same message again;
   * observers must tolerate that. It never delays or fails the reader.
   */
  readonly onMail?: (mail: OwnerMailObservation) => void;
  readonly signal?: AbortSignal;
}
/** One screened message on the owner's mailbox. `senderAddress` is the raw From value. */
export interface OwnerMailObservation {
  /** The inbox item id; the same message keeps the same id across deliveries. */
  readonly id: string;
  readonly senderAddress: string;
  readonly subject: string;
  readonly body: string;
  readonly receivedAtMs: number;
}
/** Preserve the original asynchronous callable contract while adding a final fence. */
export interface EmailInboxReadLease extends OwnedInboxReadLease {
  (): Promise<void>;
}
export interface EmailInboxOwner {
  readonly account: EmailInboxAccount;
  readonly scopeId: string;
  readonly triageStoreFileName?: string;
  /** The pushed provider the mirror registers; it is never polled. */
  readonly adapter: InboundProviderAdapter;
  /** What the mailbox reader hands this account's mail to. */
  readonly consumer: MailboxConsumer;
  /**
   * Whether the mirror has never been fed by the reader, so the reader should
   * keep the history window for it once. Valid once the mirror is open.
   */
  needsHistory(): boolean;
  assertReadCurrent(): Promise<void>;
  acquireReadLease(): Promise<EmailInboxReadLease>;
  close(): Promise<void>;
}

function prefix(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}
/** The claimed sender's domain when it is plainly a hostname; undefined otherwise. Never the local part or the name. */
function senderDomainOf(from: string): string | undefined {
  const address = /<([^<>]*)>\s*$/.exec(from)?.[1] ?? from;
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase();
  return address.includes('@') && domain.length <= 253
    && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain) ? domain : undefined;
}
/**
 * The message's own time from its Date header, for display order, retention
 * and "arrived after" questions. A missing, unreadable or far-future date
 * falls back to when it was read here.
 */
function messageTime(date: string | undefined, readAt: number): number {
  const parsed = date ? Date.parse(date) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= readAt + 24 * 60 * 60 * 1000 ? parsed : readAt;
}

/** The inbox status while a proxy variable keeps private screening from running; it does not pass by waiting. */
const PROXY_CONFIGURED_TEXT = 'Mail previews are withheld: a proxy variable (HTTP_PROXY, HTTPS_PROXY or ALL_PROXY) '
  + 'is set for the process reading this inbox, and private screening never sends mail text around it. '
  + 'Unset it for the daemon and restart the daemon to read new mail here.';

const UNREADABLE_REASON_TEXT: Readonly<Record<string, string>> = {
  'headers-incomplete': 'its header block is not readable',
  'bodystructure-incomplete-or-unsupported': 'its structure or text encoding is not one this reader can show',
  'text-section-incomplete-or-unsupported': 'its text could not be decoded exactly',
  'complete-source-too-large': 'its text is larger than this reader takes',
  'invalid-uid': 'the server named it with an identifier outside the mailbox range',
  'repeated-read-failure': 'the server did not return it readably on 3 attempts in a row',
  'screening-unsettled': 'privacy screening could not settle what it holds, so it is withheld here',
  'screening-malformed': 'privacy screening did not return a usable answer about it, so it is withheld here',
  'screening-protected-input': 'it holds what looks like a credential or card number, so it is withheld here',
};

/** Reader verdicts after which stored mail is hidden until the reader signs in again. */
const REFUSED_REASONS = new Set(['credentials-rejected', 'credentials-missing', 'mailbox-unreadable']);

/** No credentials, provider calls or mail connections happen here at all. */
export function createEmailInboxOwner(options: EmailInboxOwnerOptions): EmailInboxOwner {
  const account = Object.freeze({ ...options.account });
  const { scopeId, triageFileName: triageStoreFileName } = resolveAccountInboxIdentity(options.identity, { provider: 'email', account });
  const authority = options.screening.authority;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, authority.signal, ...(options.signal ? [options.signal] : [])]);
  let closed = false;
  let closing: Promise<void> | undefined;
  const current = (): void => {
    if (closed || signal.aborted) throw new Error('Email inbox scope is unavailable');
    try { options.assertCurrent(); authority.assertCurrent.call(authority); }
    catch { throw new Error('Email inbox scope is unavailable'); }
  };
  current();
  const screeningOptions = options.screening;
  const screening = createProtectedSourceOwner('kind' in screeningOptions
    ? { ...screeningOptions, authority: { ...screeningOptions.authority, signal, assertCurrent: current } }
    : { ...screeningOptions, authority: { ...screeningOptions.authority, signal, assertCurrent: current } });

  let sink: PushedProviderSink | null = null;
  const requireSink = (): PushedProviderSink => {
    current();
    if (sink === null) throw new MailboxConsumerUnavailableError('The inbox store for this account is not open yet.');
    return sink;
  };

  // What `channels.inbox.list` reports for this provider: the reader's own state and position.
  let readerRunning = false;
  let refused = false;
  let state: PushedProviderStatus['state'] = 'empty';
  let error: string | undefined;
  let configured: boolean | undefined;
  let polled = false;
  let lastPolledAt: number | undefined;
  let itemCount = 0;
  let progress: PushedProviderStatus['mailboxProgress'];
  let history: PushedProviderStatus['mailboxHistory'];
  let skipped: { uid: number; reason: string }[] = [];
  let lastValidity: number | undefined;

  // One batch's screened rows and observations, committed together at `settle`.
  const rows: InboundChannelItem[] = [];
  const observations: OwnerMailObservation[] = [];
  const batchSkipped: { uid: number; reason: string }[] = [];

  const imapItemId = (uidValidity: number, uid: number): string =>
    `email:${scopeId}:${String(uidValidity).padStart(10, '0')}:${String(uid).padStart(10, '0')}`;
  const gmailItemId = (resourceId: string): string => `email:${scopeId}:gmail:${resourceId}`;
  const held = (id: string, target: PushedProviderSink): boolean => target.has(id) || rows.some((row) => row.id === id);

  /** The row that stands in for a message that could not be read here, so it is not lost. */
  const unreadableRow = (id: string, reason: string, senderDomain?: string, receivedAt = Date.now()): InboundChannelItem => ({
    id, provider: 'email', kind: 'dm',
    fromDigest: digestSender(senderDomain ? `email-domain:${senderDomain}` : 'email:unknown sender'),
    subjectPreview: 'A message could not be read here',
    bodyPreview: prefix(`A message${senderDomain ? ` claiming to be from ${senderDomain}` : ''} in ${account.mailbox} `
      + `could not be read here: ${UNREADABLE_REASON_TEXT[reason] ?? 'it could not be read'}. Open it in your mail client.`, 500),
    receivedAt, unread: true,
  });

  /**
   * Screen one message's text and stage its row. A hold about the message
   * itself is final for it (published as withheld); a hold about the route
   * (down, busy, cancelled, a proxy variable) is the consumer being
   * unavailable: the reader keeps the message and hands it over again.
   */
  const screenAndStage = async (input: {
    readonly id: string; readonly parts: readonly string[]; readonly from: string;
    readonly subject: string; readonly body: string; readonly sentAt: number; readonly unread: boolean;
    readonly uid?: number;
  }): Promise<void> => {
    let captured: ProtectedSource | undefined;
    try {
      // Text holding protected input is still captured: its screening answers
      // held('protected-input') below, on the one path every hold takes.
      captured = screening.capture([...input.parts, normalizeWhitespace(stripMarkup(input.subject)), normalizeWhitespace(stripMarkup(input.body))]);
      const judged = await screening.screen(captured);
      current();
      if (judged.status !== 'settled') {
        if (judged.reason === 'unsettled' || judged.reason === 'malformed' || judged.reason === 'protected-input') {
          rows.push(unreadableRow(input.id, `screening-${judged.reason}`, senderDomainOf(input.from), input.sentAt));
          if (input.uid !== undefined) batchSkipped.push({ uid: input.uid, reason: `screening-${judged.reason}` });
          return;
        }
        if (judged.reason === 'proxy-configured') {
          state = 'unavailable'; error = PROXY_CONFIGURED_TEXT;
          throw new MailboxConsumerUnavailableError(PROXY_CONFIGURED_TEXT);
        }
        throw new MailboxConsumerUnavailableError('Privacy screening is unavailable right now; the message is read again on the next drain.');
      }
      const projected = screening.project(judged.receipt);
      const fromDigest = digestSender(`email:${input.from.trim().toLowerCase()}`);
      let routeId: string | undefined;
      if (options.resolveRouteId) {
        try {
          const resolved = await options.resolveRouteId({ provider: 'email', fromDigest, kind: 'dm' });
          if (typeof resolved === 'string' && resolved.length > 0) routeId = resolved;
        } catch { /* Optional routing failure cannot expose source or hold the reader. */ }
        current();
      }
      const subject = projected[projected.length - 2]!;
      const body = projected[projected.length - 1]!;
      rows.push({ id: input.id, provider: 'email', kind: 'dm', fromDigest, ...(routeId === undefined ? {} : { routeId }),
        subjectPreview: prefix(subject, 200), bodyPreview: prefix(body, 500), receivedAt: input.sentAt, unread: input.unread });
      // The message's own date: mail written before a purchase can never confirm it.
      observations.push({ id: input.id, senderAddress: input.from, subject, body, receivedAtMs: input.sentAt });
    } finally {
      if (captured) await screening.release(captured).catch(() => {});
    }
  };

  const deliverImap = async (message: ImapInboundMessage, target: PushedProviderSink): Promise<void> => {
    const id = imapItemId(message.uidValidity, message.uid);
    if (held(id, target)) return;
    if (message.unreadable) {
      rows.push(unreadableRow(id, message.unreadable.reason, message.unreadable.senderDomain));
      batchSkipped.push({ uid: message.uid, reason: message.unreadable.reason });
      return;
    }
    const read = message.readContent
      ? await message.readContent()
      : { outcome: 'incomplete' as const, reason: 'headers-incomplete' as const, fromMessage: true as const };
    current();
    // Expunged between the reader's envelope pass and this read: nothing is left to show.
    if (read.outcome === 'gone') return;
    if (read.outcome === 'incomplete') {
      const domain = 'senderDomain' in read ? read.senderDomain : undefined;
      rows.push(unreadableRow(id, read.reason, domain));
      batchSkipped.push({ uid: message.uid, reason: read.reason });
      return;
    }
    const detail = read.detail;
    const unread = message.readUnread ? await message.readUnread() : true;
    await screenAndStage({
      id, uid: message.uid, from: detail.from, subject: detail.subject, body: detail.bodyText || detail.bodyHtml,
      sentAt: messageTime(detail.date, Date.now()), unread,
      parts: [read.rawHeaders, read.rawBodyStructure, read.textSections.map((section) => section.text).join('\n')],
    });
  };

  const deliverGmail = async (message: GmailInboundMessage, target: PushedProviderSink): Promise<void> => {
    const id = gmailItemId(message.resourceId);
    if (held(id, target)) return;
    const body = message.bodyAvailability === 'full'
      ? message.body
      : 'The connected Google account does not grant message bodies, so only the subject is shown here.';
    await screenAndStage({
      id, from: message.from, subject: message.subject, body, sentAt: messageTime(message.claimedDate, Date.now()), unread: true,
      parts: [`From: ${message.from}\r\nSubject: ${message.subject}\r\n\r\n`, '', message.bodyAvailability === 'full' ? message.body : ''],
    });
  };

  const consumer: MailboxConsumer = {
    id: `inbox:${scopeId}`,
    wantsHistory: true,
    async generation(uidValidity) {
      const target = requireSink();
      lastValidity = uidValidity;
      // The same generation as stored is the ordinary reconnect: no write.
      if (target.generation() !== uidValidity) await target.commit([], uidValidity);
    },
    async deliver(message: InboundMailboxMessage) {
      const target = requireSink();
      if (message.source === 'gmail') await deliverGmail(message, target);
      else await deliverImap(message, target);
    },
    async settle() {
      if (rows.length === 0) return;
      const staged = rows.splice(0);
      const seen = observations.splice(0);
      const passed = batchSkipped.splice(0);
      const target = requireSink();
      const generation = staged.every((row) => row.id.includes(':gmail:')) ? null : lastValidity ?? null;
      itemCount = await target.commit(staged, generation);
      state = 'ready'; error = undefined; polled = true; lastPolledAt = Date.now();
      if (passed.length > 0) skipped = passed;
      if (options.onMail) for (const mail of seen) {
        try { options.onMail(mail); } catch { /* An observer's failure cannot hold the reader or expose the source. */ }
      }
    },
    position(position: MailboxReadPosition) {
      polled = true; lastPolledAt = Date.now();
      if (state !== 'ready' || position.pending > 0) state = position.pending > 0 ? 'pending' : 'empty';
      if (error !== PROXY_CONFIGURED_TEXT) error = undefined;
      progress = { uidValidity: position.uidValidity, pendingMessages: position.pending };
      history = position.history
        ? { kind: position.history.skippedOlderMessages > 0 ? 'bounded-seed' : 'complete',
          lowerBoundUid: position.history.skippedOlderMessages > 0 ? position.history.floorUid : 1,
          skippedOlderMessages: position.history.skippedOlderMessages, uidValidity: position.uidValidity }
        : undefined;
    },
    readerState(reader: MailboxReaderState) {
      readerRunning = reader.running;
      const reason = reader.verdict?.reason;
      refused = reader.verdict?.state === 'insufficient' && reason !== undefined && REFUSED_REASONS.has(reason);
      configured = reason === 'credentials-missing' ? false : reader.verdict === null ? configured : true;
      if (!reader.running && reader.verdict?.state === 'insufficient') {
        state = 'unavailable'; error = reader.reason; polled = true; lastPolledAt = Date.now();
      }
    },
  };

  const adapter: InboundProviderAdapter = {
    id: 'email', pollIntervalMs: 0, checkpointKind: 'pushed',
    async poll() { return { items: [], state: 'empty' }; },
    bind(target) {
      sink = target;
      return () => { if (sink === target) sink = null; };
    },
    status() {
      return {
        state, itemCount, polled,
        ...(error === undefined ? {} : { error }),
        ...(lastPolledAt === undefined ? {} : { lastPolledAt }),
        ...(configured === undefined ? {} : { configured }),
        ...(progress === undefined ? {} : { mailboxProgress: progress }),
        ...(history === undefined ? {} : { mailboxHistory: history }),
        ...(skipped.length === 0 ? {} : { skippedMessages: skipped }),
      };
    },
    isRunning: () => readerRunning,
  };

  /** The mirror's generation, when stored mail may be listed now. All in memory or one indexed read. */
  const assertStoredGeneration = (): number | null => {
    current();
    if (refused) throw new Error('The mail server refused this account\'s sign-in or mailbox; stored mail stays hidden until the reader signs in again');
    const stored = sink?.generation() ?? null;
    if (lastValidity !== undefined && stored !== null && stored !== lastValidity) {
      throw new Error('The mailbox was reset on the server; the reader replaces the stored mail');
    }
    return stored;
  };
  return {
    account, scopeId, triageStoreFileName, adapter, consumer,
    needsHistory: () => sink !== null && !sink.seeded(),
    async assertReadCurrent() { assertStoredGeneration(); },
    async acquireReadLease() {
      const generation = assertStoredGeneration();
      const assertCurrent = (): void => {
        if (assertStoredGeneration() !== generation) throw new Error('Email inbox read generation changed');
      };
      return Object.freeze(Object.assign(async () => { assertCurrent(); }, { assertCurrent }));
    },
    close() {
      if (!closing) {
        closed = true;
        lifetime.abort();
        sink = null;
        closing = screening.close().catch(() => { throw new Error('Email inbox owner did not close cleanly'); });
      }
      return closing;
    },
  };
}
