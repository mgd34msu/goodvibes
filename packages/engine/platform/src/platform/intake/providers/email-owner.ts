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
  /** Clock for the read-proof reuse window; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Read-only view of the actual durable inbox checkpoint, supplied by its registrar. */
  readonly getCheckpoint: () => ImapUidCheckpoint | null;
  /** Optional metadata-only routing capability captured by the owned poll. */
  readonly resolveRouteId?: RouteResolver;
  /**
   * Called once per message after it passed source screening, with the screened
   * subject and body. It runs before the poll's checkpoint is committed, so a poll
   * that is retried can offer the same message again; observers must tolerate that.
   * It never delays or fails the poll.
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
function sync(assert: () => void): void {
  const result: unknown = assert();
  if (result !== undefined) {
    if (types.isPromise(result)) void result.catch(() => {});
    throw new Error('Email inbox requires synchronous currentness');
  }
}
function unavailable(configured?: boolean): ProviderPollResult {
  return { items: [], state: 'unavailable', error: 'Email inbox account or complete source is unavailable',
    ...(configured === undefined ? {} : { configured }) };
}

/** No credentials or provider calls happen during construction. */
/** How long a completed read proof may start another read. */
const READ_PROOF_REUSE_MS = 5_000;

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
  const failedRead = (error: unknown): void => {
    if (error instanceof EmailCredentialUnavailableError || (error instanceof ImapOpenError
      && (error.reason === 'authentication-rejected' || error.reason === 'mailbox-unavailable'))) revokeEligibility(true);
  };
  let screeningObservation: EmailMailboxObservation | undefined;
  let commitObservation: EmailMailboxObservation | undefined;
  let pollSignal: AbortSignal | undefined;
  let polling: Promise<ProviderPollResult> | undefined;
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
        const result = await service.readInboxPage({ checkpoint: input.checkpoint, limit: input.limit, signal: operationSignal });
        current(); if (operationSignal.aborted) return unavailable(true);
        if (result.outcome === 'incomplete') return unavailable(true);
        const observation = service.getInboxMailboxObservation(result);
        if (!observation || observation.mailbox !== account.mailbox) return unavailable(true);
        observation.assertCurrent();
        if (result.outcome === 'checkpoint-required') {
          if (epoch !== identityEpoch) return unavailable(true);
          commitObservation = observation; commitEpoch = identityEpoch;
          return { items: [], state: result.pending > 0 ? 'pending' : 'empty', configured: true, pendingMessages: result.pending,
            checkpointAdvance: { kind: 'imap-uid', transition: result.transition, previous: result.previous,
              next: result.next, coveredUids: [], terminal: [] } };
        }
        const items: InboundChannelItem[] = [];
        for (const message of result.messages) {
          current(); observation.assertCurrent(); if (operationSignal.aborted) return unavailable(true);
          screeningObservation = observation;
          const source = message.source;
          const body = source.detail.bodyText || source.detail.bodyHtml;
          let captured: ProtectedSource | undefined;
          let release: Promise<void> | undefined;
          const retire = (): Promise<void> => release ??= captured ? screening.release(captured) : Promise.resolve();
          const abort = (): void => { void retire().catch(() => {}); };
          try {
            captured = screening.capture([source.rawHeaders, source.rawBodyStructure,
              source.textSections.map(section => section.text).join('\n'),
              normalizeWhitespace(stripMarkup(source.detail.subject)), normalizeWhitespace(stripMarkup(body))]);
            operationSignal.addEventListener('abort', abort, { once: true });
            observation.signal.addEventListener('abort', abort, { once: true });
            if (operationSignal.aborted || observation.signal.aborted) abort();
            const judged = await screening.screen(captured);
            current(); observation.assertCurrent();
            if (operationSignal.aborted || judged.status !== 'settled') return unavailable(true);
            const projected = screening.project(judged.receipt);
            const uid = source.detail.uid;
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
              receivedAt: Date.now(), unread: message.unread });
            if (onMail) {
              try { onMail({ id: itemId, senderAddress: source.detail.from, subject: projected[3]!, body: projected[4]!, receivedAtMs: Date.now() }); }
              catch { /* An observer's failure cannot poison the poll or expose the source. */ }
            }
          } finally {
            operationSignal.removeEventListener('abort', abort); observation.signal.removeEventListener('abort', abort);
            await retire(); screeningObservation = undefined;
          }
        }
        current(); observation.assertCurrent(); if (operationSignal.aborted || epoch !== identityEpoch) return unavailable(true);
        commitObservation = observation; commitEpoch = identityEpoch;
        // Messages whose content cannot be proven complete get a terminal
        // 'suppressed' disposition so the checkpoint moves past them instead of
        // re-reading them (and holding back every later message) on each poll.
        const skipped = result.unsupported ?? [];
        const terminal: ImapUidTerminalDisposition[] = [
          ...result.coveredUids.map((uid, index) => ({ uid, disposition: 'published' as const, itemId: items[index]!.id })),
          ...skipped.map((entry) => ({ uid: entry.uid, disposition: 'suppressed' as const })),
        ].sort((a, b) => a.uid - b.uid);
        const coveredUids = terminal.map((entry) => entry.uid);
        const finalUid = coveredUids.at(-1) ?? result.checkpoint.lastTerminalUid;
        // The reader already left page-passed stepped-over messages out of `pending`.
        const lastReadable = result.coveredUids.at(-1);
        const trailing = skipped.filter((entry) => lastReadable === undefined || entry.uid > lastReadable).length;
        return { items, state: items.length > 0 ? 'ready' : 'empty', configured: true,
          pendingMessages: result.pending - result.messages.length - trailing,
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
  const verifyReadOnce = async (): Promise<EmailMailboxObservation> => {
    const observation = await verifyAccount();
    const checkpoint = getCheckpoint();
    if (!checkpoint || checkpoint.uidValidity !== observation.uidValidity) throw new Error('Email inbox generation has not been committed');
    return observation;
  };
  // Each read proof is an IMAP login and select. Readers that arrive while one is in flight share it, so a
  // refreshing client cannot multiply logins into provider lockout. Eligibility proofs never join it.
  let reading: Promise<EmailMailboxObservation> | undefined;
  const now = options.now ?? Date.now;
  // A proof that finished moments ago also covers the next read that starts (a refresh right after a list), so
  // back-to-back lists cost one login each instead of two. A lease's closing validation never reuses it.
  let proven: { observation: EmailMailboxObservation; at: number; authority: number; identity: number } | undefined;
  const verifyRead = (fresh = true): Promise<EmailMailboxObservation> => {
    if (!fresh && proven && now() - proven.at >= 0 && now() - proven.at < READ_PROOF_REUSE_MS
      && proven.authority === authorityEpoch && proven.identity === identityEpoch
      // A mailbox reset commits a new generation; a proof of the old one must not refuse reads of the new one.
      && getCheckpoint()?.uidValidity === proven.observation.uidValidity) {
      const reused = proven.observation;
      return (async () => {
        current(); reused.assertCurrent();
        const checkpoint = getCheckpoint();
        if (!checkpoint || checkpoint.uidValidity !== reused.uidValidity) throw new Error('Email inbox generation has not been committed');
        return reused;
      })();
    }
    if (reading) return reading;
    const authority = authorityEpoch, identity = identityEpoch;
    const shared = verifyReadOnce();
    reading = shared;
    const clear = (): void => { if (reading === shared) reading = undefined; };
    void shared.then(observation => { proven = { observation, at: now(), authority, identity }; clear(); }, clear);
    return shared;
  };
  return {
    account, scopeId, triageStoreFileName, adapter,
    async verifyEligibility() {
      const epoch = authorityEpoch;
      const observation = await verifyAccount();
      current(); observation.assertCurrent();
      if (epoch !== authorityEpoch) throw new Error('Email inbox account verification was revoked');
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
    async assertReadCurrent() { await verifyRead(false); },
    async acquireReadLease() {
      const authorityAtAcquisition = authorityEpoch;
      const original = await verifyRead(false);
      const identityAtAcquisition = identityEpoch;
      const assertCurrent = (): void => {
        current(); original.assertCurrent();
        const checkpoint = getCheckpoint();
        if (authorityAtAcquisition !== authorityEpoch || identityAtAcquisition !== identityEpoch
          || !checkpoint || checkpoint.uidValidity !== original.uidValidity) {
          throw new Error('Email inbox read generation changed');
        }
      };
      assertCurrent();
      return Object.freeze(Object.assign(async () => {
        assertCurrent();
        const latest = await verifyRead();
        assertCurrent();
        if (latest.accountRevision !== original.accountRevision || latest.uidValidity !== original.uidValidity) {
          throw new Error('Email inbox read generation changed');
        }
      }, { assertCurrent }));
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
