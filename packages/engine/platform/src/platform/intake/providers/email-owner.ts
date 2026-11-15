/** Explicit account-owned email intake over canonical mail and source screening. */
import { types } from 'node:util';
import { ImapOpenError } from '../../email/imap-open.js';
import { EmailCredentialUnavailableError } from '../../email/email-config.js';
import type { EmailService } from '../../email/email-service.js';
import type { EmailMailboxObservation } from '../../email/reply-subject-source.js';
import { createProtectedSourceOwner } from '../../security/source-screening/owner.js';
import type { ProtectedSourceOwnerOptions, ProtectedSource } from '../../security/source-screening/types.js';
import type { OwnedInboxReadLease } from '../registration.js';
import { digestSender, normalizeWhitespace, stripMarkup } from '../text-normalization.js';
import { POLL_CADENCE_MS, type RouteResolver, type ImapUidCheckpoint, type ImapUidTerminalDisposition, type InboundChannelItem, type InboundProviderAdapter, type ProviderPollOptions, type ProviderPollResult } from '../provider-adapter.js';
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
  /** Real canonical service with synchronous account/config/secret lifecycle. */
  readonly service: EmailService;
  readonly screening: ProtectedSourceOwnerOptions;
  readonly assertCurrent: () => void;
  /** Read-only view of the actual durable inbox checkpoint, supplied by its registrar. */
  readonly getCheckpoint: () => ImapUidCheckpoint | null;
  /** Optional metadata-only routing capability captured by the owned poll. */
  readonly resolveRouteId?: RouteResolver;
  /**
   * Called once per message after it passed source screening, with the screened
   * subject and body and the message's own date. It runs before the poll's
   * checkpoint is committed, so a poll that is retried can offer the same message
   * again; observers must tolerate that. It never delays or fails the poll.
   */
  readonly onMail?: (mail: OwnerMailObservation) => void;
  readonly signal?: AbortSignal;
}
/** One screened message on the owner's mailbox. `senderAddress` is the raw From value. */
export interface OwnerMailObservation {
  /** The inbox item id; the same message keeps the same id across polls. */
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
  readonly adapter: InboundProviderAdapter;
  /** Authenticated metadata only; independent of committed UID progress. */
  verifyEligibility?(): Promise<{ readonly signal: AbortSignal; assertCurrent(): void }>;
  assertReadCurrent(): Promise<void>;
  acquireReadLease(): Promise<EmailInboxReadLease>;
  close(): Promise<void>;
}

/** Concrete canonical owner adds metadata eligibility to the legacy read surface. */
export interface VerifiedEmailInboxOwner extends EmailInboxOwner {
  verifyEligibility(): Promise<{ readonly signal: AbortSignal; assertCurrent(): void }>;
}

function captureAccount(input: EmailInboxAccount): EmailInboxAccount {
  if (!input || typeof input !== 'object' || types.isProxy(input)) throw new Error('Email inbox account is invalid');
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== 5 || Object.values(fields).some(field => !('value' in field))) throw new Error('Email inbox account is invalid');
  const { host, username, mailbox, port, security } = input;
  if (![host, username, mailbox].every(value => typeof value === 'string' && value.length > 0 && value.length <= 320 && value.trim() === value)
    || !Number.isInteger(port) || port < 1 || port > 65535 || security !== 'tls') throw new Error('Email inbox account is invalid');
  return Object.freeze({ host, username, mailbox, port, security });
}
function prefix(text: string, length: number): string {
  let end = Math.min(length, text.length);
  if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
  return text.slice(0, end);
}
/** The claimed sender's domain when it is plainly a hostname; '' otherwise. Never the local part or the name. */
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
function sync(assert: () => void): void {
  const result: unknown = assert();
  if (result !== undefined) {
    if (types.isPromise(result)) void result.catch(() => {});
    throw new Error('Email inbox requires synchronous currentness');
  }
}
function unavailable(configured?: boolean, error = 'Email inbox account or complete source is unavailable'): ProviderPollResult {
  return { items: [], state: 'unavailable', error, ...(configured === undefined ? {} : { configured }) };
}

/** The inbox status while a proxy variable keeps private screening from running; it does not pass by waiting. */
const PROXY_CONFIGURED_TEXT = 'Mail previews are withheld: a proxy variable (HTTP_PROXY, HTTPS_PROXY or ALL_PROXY) '
  + 'is set for the process reading this inbox, and private screening never sends mail text around it. '
  + 'Unset it for the daemon and restart the daemon to read new mail here.';

/**
 * Polls on which one message may fail to read or to be screened before it is
 * stepped over and published as a message that could not be read here. The
 * count lives in memory: after a restart a message gets the same few polls
 * again, which is the bound that matters, no single message holds the mailbox.
 */
const MAX_POLLS_PER_MESSAGE = 3;
/** Bound on the failure counts held at once; the oldest are forgotten first. */
const MAX_TRACKED_FAILURES = 256;

const UNREADABLE_REASON_TEXT: Readonly<Record<string, string>> = {
  'headers-incomplete': 'its header block is not readable',
  'bodystructure-incomplete-or-unsupported': 'its structure or text encoding is not one this reader can show',
  'text-section-incomplete-or-unsupported': 'its text could not be decoded exactly',
  'complete-source-too-large': 'its text is larger than this reader takes',
  'repeated-read-failure': `the server did not return it readably on ${String(MAX_POLLS_PER_MESSAGE)} polls in a row`,
  'screening-unsettled': 'privacy screening could not settle what it holds, so it is withheld here',
  'screening-malformed': 'privacy screening did not return a usable answer about it, so it is withheld here',
  'screening-protected-input': 'it holds what looks like a credential or card number, so it is withheld here',
};

/** No credentials or provider calls happen during construction. */

export function createEmailInboxOwner(options: EmailInboxOwnerOptions): VerifiedEmailInboxOwner {
  const account = captureAccount(options.account);
  const service = options.service;
  const assertScope = options.assertCurrent;
  const authority = options.screening.authority;
  const assertAuthority = authority.assertCurrent;
  const getCheckpoint = options.getCheckpoint;
  const resolveRouteId = options.resolveRouteId;
  const onMail = options.onMail;
  const { scopeId, triageFileName: triageStoreFileName } = resolveAccountInboxIdentity(options.identity, { provider: 'email', account });
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, options.screening.authority.signal, ...(options.signal ? [options.signal] : [])]);
  const active = new Set<Promise<unknown>>();
  let closed = false, closing: Promise<void> | undefined;
  let identityEpoch = 0;
  // A completed canonical observation may survive a later failed login. Keep
  // that refusal fence separate from UIDVALIDITY retirement, which a fresh
  // successful metadata read can itself legitimately cause.
  let authorityEpoch = 0;
  let commitEpoch: number | undefined;
  let eligibility: { readonly signal: AbortSignal; assertCurrent(): void } | undefined;
  let eligibilityLifetime: AbortController | undefined;
  let eligibilityObservation: EmailMailboxObservation | undefined;
  let detachEligibility: (() => void) | undefined;
  const revokeEligibility = (authorityChanged = false): void => {
    const retired = eligibilityLifetime;
    if (authorityChanged) authorityEpoch += 1;
    identityEpoch += 1; commitEpoch = undefined;
    eligibility = undefined; eligibilityLifetime = undefined; eligibilityObservation = undefined;
    detachEligibility?.(); detachEligibility = undefined;
    retired?.abort();
  };
  // Set when the server refused the account; cleared by the next poll that signs in.
  let authorityRefused = false;
  const failedRead = (error: unknown): void => {
    if (error instanceof EmailCredentialUnavailableError || (error instanceof ImapOpenError
      && (error.reason === 'authentication-rejected' || error.reason === 'mailbox-unavailable'))) { authorityRefused = true; revokeEligibility(true); }
  };
  let screeningObservation: EmailMailboxObservation | undefined;
  let commitObservation: EmailMailboxObservation | undefined;
  let pollSignal: AbortSignal | undefined;
  let polling: Promise<ProviderPollResult> | undefined;
  // Consecutive polls on which a message failed to read or to be screened, by `uidValidity:uid`.
  const failures = new Map<string, number>();
  const failureKey = (uidValidity: number, uid: number): string => `${String(uidValidity)}:${String(uid)}`;
  const noteFailure = (key: string): number => {
    const count = (failures.get(key) ?? 0) + 1;
    failures.delete(key); failures.set(key, count);
    if (failures.size > MAX_TRACKED_FAILURES) failures.delete(failures.keys().next().value!);
    return count;
  };
  /** The item that stands in for a message that could not be read here, so it is not lost. */
  const unreadableItem = (uidValidity: number, uid: number, reason: string, senderDomain?: string, receivedAt = Date.now()): InboundChannelItem => ({
    id: `email:${scopeId}:${String(uidValidity).padStart(10, '0')}:${String(uid).padStart(10, '0')}`,
    provider: 'email', kind: 'dm' as const,
    fromDigest: digestSender(senderDomain ? `email-domain:${senderDomain}` : 'email:unknown sender'),
    subjectPreview: 'A message could not be read here',
    bodyPreview: prefix(`A message${senderDomain ? ` claiming to be from ${senderDomain}` : ''} in ${account.mailbox} `
      + `could not be read here: ${UNREADABLE_REASON_TEXT[reason] ?? 'it could not be read'}. Open it in your mail client.`, 500),
    receivedAt, unread: true,
  });
  // The mailbox generation the last poll saw, for reads of stored rows (no mail session per read).
  let lastSeenValidity: number | undefined;
  const current = (): void => {
    try {
      if (closed || signal.aborted) throw new Error('Email inbox scope is unavailable');
      sync(assertScope);
      const config = service.getInboxReadStatus().config;
      if (!config.enabled || config.imapHost !== account.host || config.imapPort !== account.port
        || config.username !== account.username || (config.mailbox.trim() || 'INBOX') !== account.mailbox
        || (config.imapSecurity ?? 'tls') !== account.security) throw new Error('Email inbox account scope changed');
      sync(() => assertAuthority.call(authority));
      if (closed || signal.aborted) throw new Error('Email inbox scope is unavailable');
    } catch { revokeEligibility(true); throw new Error('Email inbox scope is unavailable'); }
  };
  current();
  const screeningOptions = options.screening;
  const assertScreeningCurrent = () => { current(); sync(() => assertAuthority.call(authority)); screeningObservation?.assertCurrent(); };
  const screening = createProtectedSourceOwner('kind' in screeningOptions
    ? { ...screeningOptions, authority: { ...screeningOptions.authority, signal, assertCurrent: assertScreeningCurrent } }
    : { ...screeningOptions, authority: { ...screeningOptions.authority, signal, assertCurrent: assertScreeningCurrent } });
  const own = <T>(action: () => Promise<T>): Promise<T> => {
    const work = Promise.resolve().then(() => { current(); return action(); });
    active.add(work); void work.then(() => active.delete(work), () => active.delete(work)); return work;
  };
  const adapter: InboundProviderAdapter = {
    id: 'email', pollIntervalMs: POLL_CADENCE_MS.email, checkpointKind: 'imap-uid',
    assertCurrent() {
      current(); sync(() => assertAuthority.call(authority));
      if (!commitObservation || commitEpoch !== identityEpoch || pollSignal?.aborted) throw new Error('Email inbox poll source is unavailable');
      commitObservation.assertCurrent();
    },
    poll(input: ProviderPollOptions): Promise<ProviderPollResult> {
      if (polling) return polling;
      const operationSignal = AbortSignal.any([signal, ...(input.signal ? [input.signal] : [])]);
      commitObservation = undefined; pollSignal = operationSignal;
      const work = own(async (): Promise<ProviderPollResult> => {
        const epoch = identityEpoch;
        if (!service.getInboxReadStatus().ready) return unavailable(false);
        const validity = input.checkpoint?.uidValidity;
        const stepOver = validity === undefined ? [] : [...failures]
          .filter(([key, count]) => key.startsWith(`${String(validity)}:`) && count >= MAX_POLLS_PER_MESSAGE - 1)
          .map(([key]) => Number(key.slice(key.indexOf(':') + 1)));
        const result = await service.readInboxPage({ checkpoint: input.checkpoint, limit: input.limit, signal: operationSignal,
          ...(stepOver.length > 0 ? { stepOver } : {}) });
        current(); if (operationSignal.aborted) return unavailable(true);
        if (result.outcome === 'incomplete') {
          if (result.uid !== undefined && validity !== undefined) noteFailure(failureKey(validity, result.uid));
          return unavailable(true);
        }
        const observation = service.getInboxMailboxObservation(result);
        if (!observation || observation.mailbox !== account.mailbox) return unavailable(true);
        observation.assertCurrent();
        lastSeenValidity = observation.uidValidity; authorityRefused = false;
        if (result.outcome === 'checkpoint-required') {
          if (epoch !== identityEpoch) return unavailable(true);
          commitObservation = observation; commitEpoch = identityEpoch;
          return { items: [], state: result.pending > 0 ? 'pending' : 'empty', configured: true, pendingMessages: result.pending,
            checkpointAdvance: { kind: 'imap-uid', transition: result.transition, previous: result.previous,
              next: result.next, coveredUids: [], terminal: [] } };
        }
        const items: InboundChannelItem[] = [];
        const terminal: ImapUidTerminalDisposition[] = [];
        // Set when a message's screening did not settle and it still has polls
        // left: the page commits what came before it and the next poll starts there.
        let stopAt: number | undefined;
        for (const message of result.messages) {
          current(); observation.assertCurrent(); if (operationSignal.aborted) return unavailable(true);
          screeningObservation = observation;
          const source = message.source;
          const uid = source.detail.uid;
          const key = failureKey(observation.uidValidity, uid);
          const body = source.detail.bodyText || source.detail.bodyHtml;
          let captured: ProtectedSource | undefined;
          let release: Promise<void> | undefined;
          const retire = (): Promise<void> => release ??= captured ? screening.release(captured) : Promise.resolve();
          const abort = (): void => { void retire().catch(() => {}); };
          const sentAt = messageTime(source.detail.date, Date.now());
          try {
            // Text holding protected input is still captured: its screening
            // answers held('protected-input') below, on the one path every hold takes.
            captured = screening.capture([source.rawHeaders, source.rawBodyStructure,
              source.textSections.map(section => section.text).join('\n'),
              normalizeWhitespace(stripMarkup(source.detail.subject)), normalizeWhitespace(stripMarkup(body))]);
            operationSignal.addEventListener('abort', abort, { once: true });
            observation.signal.addEventListener('abort', abort, { once: true });
            if (operationSignal.aborted || observation.signal.aborted) abort();
            const judged = await screening.screen(captured);
            current(); observation.assertCurrent();
            if (operationSignal.aborted) return unavailable(true);
            if (judged.status !== 'settled') {
              // A hold about the message itself is final for it: it is published
              // as withheld and the checkpoint passes it. A hold about the route
              // (down, busy, cancelled) keeps the messages screened before it and
              // the next poll starts here; a route outage never steps a message over.
              if (judged.reason === 'unsettled' || judged.reason === 'malformed' || judged.reason === 'protected-input') {
                const item = unreadableItem(observation.uidValidity, uid, `screening-${judged.reason}`, senderDomainOf(source.detail.from), sentAt);
                items.push(item); terminal.push({ uid, disposition: 'published', itemId: item.id });
                failures.delete(key);
                continue;
              }
              // A proxy variable is a fact about this process, not an outage:
              // nothing is screened until it changes, and the status says so.
              if (judged.reason === 'proxy-configured') return unavailable(true, PROXY_CONFIGURED_TEXT);
              stopAt = uid; break;
            }
            const projected = screening.project(judged.receipt);
            const fromDigest = digestSender(`email:${source.detail.from.trim().toLowerCase()}`);
            let routeId: string | undefined;
            if (resolveRouteId) {
              try {
                const resolved = await resolveRouteId({ provider: 'email', fromDigest, kind: 'dm' });
                if (typeof resolved === 'string' && resolved.length > 0) routeId = resolved;
              } catch { /* Optional routing failure cannot expose source or poison a poll. */ }
              current(); observation.assertCurrent();
              if (operationSignal.aborted || epoch !== identityEpoch) return unavailable(true);
            }
            const itemId = `email:${scopeId}:${String(observation.uidValidity).padStart(10, '0')}:${String(uid).padStart(10, '0')}`;
            items.push({ id: itemId,
              provider: 'email', kind: 'dm' as const, fromDigest,
              ...(routeId === undefined ? {} : { routeId }),
              subjectPreview: prefix(projected[3]!, 200), bodyPreview: prefix(projected[4]!, 500),
              receivedAt: sentAt, unread: message.unread });
            terminal.push({ uid, disposition: 'published', itemId });
            failures.delete(key);
            if (onMail) {
              // The message's own date: mail written before a purchase can never confirm it.
              try { onMail({ id: itemId, senderAddress: source.detail.from, subject: projected[3]!, body: projected[4]!, receivedAtMs: sentAt }); }
              catch { /* An observer's failure cannot poison the poll or expose the source. */ }
            }
          } finally {
            operationSignal.removeEventListener('abort', abort); observation.signal.removeEventListener('abort', abort);
            await retire(); screeningObservation = undefined;
          }
        }
        current(); observation.assertCurrent(); if (operationSignal.aborted || epoch !== identityEpoch) return unavailable(true);
        // A message the reader stepped over is published as an item that says
        // it could not be read here, so the owner knows it exists, and the
        // checkpoint moves past it instead of re-reading it on every poll.
        const skipped = (result.unsupported ?? []).filter((entry) => stopAt === undefined || entry.uid < stopAt);
        for (const entry of skipped) {
          const item = unreadableItem(observation.uidValidity, entry.uid, entry.reason, entry.senderDomain);
          items.push(item); terminal.push({ uid: entry.uid, disposition: 'published', itemId: item.id });
          failures.delete(failureKey(observation.uidValidity, entry.uid));
        }
        if (terminal.length === 0 && stopAt !== undefined) return unavailable(true);
        commitObservation = observation; commitEpoch = identityEpoch;
        terminal.sort((a, b) => a.uid - b.uid);
        const coveredUids = terminal.map((entry) => entry.uid);
        const finalUid = coveredUids.at(-1) ?? result.checkpoint.lastTerminalUid;
        // `result.pending` already left out stepped-over messages below the last readable one.
        const lastReadable = result.coveredUids.at(-1);
        const passed = lastReadable === undefined ? 0
          : (result.unsupported ?? []).filter((entry) => entry.uid < lastReadable).length;
        return { items, state: items.length > 0 ? 'ready' : 'empty', configured: true,
          pendingMessages: Math.max(0, result.pending + passed - terminal.length),
          ...(skipped.length > 0 ? { skippedMessages: skipped.map((entry) => ({ uid: entry.uid, reason: entry.reason })) } : {}),
          checkpointAdvance: { kind: 'imap-uid', transition: 'advance', previous: result.checkpoint,
            next: { ...result.checkpoint, lastTerminalUid: finalUid }, coveredUids, terminal } };
      }).catch((error: unknown) => {
        failedRead(error);
        return unavailable(error instanceof EmailCredentialUnavailableError ? false : undefined);
      });
      polling = work;
      void work.then(() => { if (polling === work) polling = undefined; });
      return work;
    },
  };
  const verifyAccount = (): Promise<EmailMailboxObservation> => own(async () => {
    const epoch = authorityEpoch;
    try {
      const result = await service.readInboxPage({ limit: 1, signal });
      current();
      if (epoch !== authorityEpoch) throw new Error('Email inbox account verification was revoked');
      if (result.outcome === 'incomplete') throw new Error('Email inbox account scope is unavailable');
      const observation = service.getInboxMailboxObservation(result);
      if (!observation || observation.mailbox !== account.mailbox) throw new Error('Email inbox account scope is unavailable');
      observation.assertCurrent(); sync(() => assertAuthority.call(authority));
      return observation;
    } catch (error) { failedRead(error); throw error; }
  });
  /** The checkpoint's generation, when stored mail may be listed now. All in memory. */
  const assertStoredGeneration = (): number => {
    current();
    if (authorityRefused) throw new Error('The mail server refused this account\'s sign-in or mailbox; stored mail stays hidden until a poll signs in again');
    const checkpoint = getCheckpoint();
    if (!checkpoint) throw new Error('Email inbox generation has not been committed; the first poll commits it');
    // The observation itself is retired by the next mail read; only the generation it saw is kept.
    if (lastSeenValidity !== undefined && checkpoint.uidValidity !== lastSeenValidity) {
      throw new Error('The mailbox was reset on the server; the next poll replaces the stored mail');
    }
    return checkpoint.uidValidity;
  };
  return {
    account, scopeId, triageStoreFileName, adapter,
    async verifyEligibility() {
      const epoch = authorityEpoch;
      const observation = await verifyAccount();
      current(); observation.assertCurrent();
      if (epoch !== authorityEpoch) throw new Error('Email inbox account verification was revoked');
      authorityRefused = false;
      // Refresh metadata without needlessly changing the live eligibility signal.
      if (eligibility) {
        try { eligibility.assertCurrent(); } catch { revokeEligibility(); }
      }
      if (!eligibility) {
        const controller = new AbortController();
        eligibilityLifetime = controller;
        eligibility = Object.freeze({ signal: AbortSignal.any([signal, controller.signal]), assertCurrent() {
          current();
          if (controller.signal.aborted || !eligibilityObservation) throw new Error('Email inbox eligibility was revoked');
          try { eligibilityObservation.assertCurrent(); } catch { revokeEligibility(); throw new Error('Email inbox eligibility was revoked'); }
        } });
      }
      detachEligibility?.();
      eligibilityObservation = observation;
      const revoke = (): void => revokeEligibility();
      observation.signal.addEventListener('abort', revoke, { once: true });
      detachEligibility = () => observation.signal.removeEventListener('abort', revoke);
      eligibility.assertCurrent();
      return eligibility;
    },
    // Stored mail is read from this account's own mirror with no mail session:
    // the configured account is checked in memory, and the poll (every minute)
    // owns "is this still the same mailbox", committing a reset generation
    // before stored rows of the old one could be listed again.
    async assertReadCurrent() { assertStoredGeneration(); },
    async acquireReadLease() {
      const authorityAtAcquisition = authorityEpoch;
      const generation = assertStoredGeneration();
      const assertCurrent = (): void => {
        if (assertStoredGeneration() !== generation || authorityAtAcquisition !== authorityEpoch) throw new Error('Email inbox read generation changed');
      };
      return Object.freeze(Object.assign(async () => { assertCurrent(); }, { assertCurrent }));
    },
    close() {
      if (!closing) {
        closed = true;
        let resolve!: () => void, reject!: (reason: unknown) => void;
        closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        revokeEligibility();
        lifetime.abort();
        const retiring = screening.close();
        void Promise.allSettled([...active]).then(() => retiring).then(resolve,
          () => reject(new Error('Email inbox owner did not close cleanly')));
        void retiring.catch(() => {});
      }
      return closing;
    },
  };
}
