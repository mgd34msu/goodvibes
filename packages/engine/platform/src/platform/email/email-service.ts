export class EmailConfigurationError extends Error {
  constructor(message: string, readonly kind: 'disabled' | 'invalid') { super(message); }
}
/**
 * Email service, config, secret resolution, and orchestration.
 *
 * Config: the mailbox settings, `surfaces.email.*`
 * ───────────────────────────────────────────────
 * The service reads an internal, flat key namespace through its `getConfig`
 * port (`email.imapHost`, `email.passwordRef`, …; see `readEmailConfig`). That
 * namespace is not a setting: every product builds the service with
 * `withSurfaceEmailConfig` (surface-config.ts), which answers it from the one
 * set of mailbox settings, `surfaces.email.*`, and resolves the password from
 * the secret store under the name that setting derives.
 *
 * Everything is injected
 * ──────────────────────
 * Not a line here opens a socket, reads a file or reaches for a global. The
 * transports (`EmailTransportPort`), the config reader, the secret store, the
 * sender-claim describer and the untrusted-ingest recorder all arrive as ports,
 * so the whole service runs against fakes with no machine. The concrete
 * bun/node transport lives in the sibling `email/node` entry.
 */

import type { Secret } from '../security/secret.js';
import { readEmailInboxBatch, type EmailInboxBatchInput, type EmailInboxBatchRead } from './email-inbox-batch.js';
import { assertDeliveryCurrent, type DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { listEmailInbox } from './email-inbox-list.js';
import { readEmailMessage } from './email-message-reader.js';
import type { EmailMailboxObservation, EmailReplySubjectSourceOwner } from './reply-subject-source.js';
import { IMAP_ATTACHMENT_LITERAL_BYTES, type ImapAttachmentContent, type ImapDraftSummary, type ImapMessageAction, type ImapMessageActionResult } from './imap-mailbox-actions.js';
import { withEmailReadConnection } from './email-read-connection.js';
import { SmtpClient, validateSmtpAddress, validateSmtpSubject, validateSmtpThreadHeader } from './smtp-client.js';
import {
  EmailCredentialUnavailableError,
  readEmailConfig,
  resolveEmailPassword,
  smtpPasswordRefFor,
  validateEmailConfig,
  validateEmailInboxConfig,
} from './email-config.js';

// Re-exported so the service stays the one entry point callers already import.
export {
  EmailCredentialUnavailableError,
  readEmailConfig,
  resolveEmailPassword,
  smtpPasswordRefFor,
  validateEmailConfig,
} from './email-config.js';
import type {
  ImapAppendDraftResult,
  ImapMessageDetail,
} from './imap-client.js';
import type { EmailInboxUnreadableResponse, EmailMessageRead } from './email-read-results.js';
import type { SmtpSendResult } from './smtp-client.js';
import type { EmailSenderClaim, EmailSenderClaimDescriber } from './sender-claim.js';
import { mailboxAuthservIds, readSenderAuthentication } from '../google/sender-authentication.js';
import type { Socket } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { DraftAppendUnconfirmedError } from './imap-client.js';

// Re-exported so this module stays the one entry point callers already import.
export type { EmailInboxUnreadableResponse, EmailMessageRead } from './email-read-results.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** SMTP connection security mode. 'auto' = port-based default (465→tls, else starttls). */
export type SmtpSecurityMode = 'tls' | 'starttls' | 'auto';

/**
 * IMAP connection security mode. 'tls' (default) is implicit TLS on the IMAP
 * port; 'plaintext' is an unencrypted connection, legitimate for a localhost or
 * test server, and what `surfaces.email.imap.secure: false` selects. No 'auto':
 * the operator either asked for TLS or asked not to have it.
 */
export type ImapSecurityMode = 'tls' | 'plaintext';

export interface EmailConfig {
  readonly enabled: boolean;
  readonly imapHost: string;
  readonly imapPort: number;
  /**
   * IMAP connection security. Absent means 'tls', which is what every config
   * written before this field existed means. `readEmailConfig` always populates
   * it; it is optional so that adding it does not break an embedder that builds
   * an `EmailConfig` itself.
   */
  readonly imapSecurity?: ImapSecurityMode | undefined;
  readonly smtpHost: string;
  readonly smtpPort: number;
  /** SMTP connection security. Default: 'auto' (port-based). */
  readonly smtpSecurity: SmtpSecurityMode;
  readonly username: string;
  /** Secret reference string, never a raw password. */
  readonly passwordRef: string;
  /**
   * Secret reference for the SMTP password, when the provider issues one that
   * differs from the IMAP password. Empty, the common case, means submission
   * authenticates with `passwordRef` like everything else.
   */
  readonly smtpPasswordRef: string;
  readonly fromAddress: string;
  /**
   * Mailbox to read. Empty, the common case, means INBOX. Set when the
   * account delivers to a folder, which is what a per-signup alias mailbox is.
   */
  readonly mailbox: string;
  /**
   * Drafts folder. Empty means "ask the server", which is the better answer:
   * discovery reads the `\Drafts` special-use flag and gets `[Gmail]/Drafts`
   * right where a hard-coded `Drafts` silently creates a stray folder. Set it
   * only when the server does not advertise one.
   */
  readonly draftsMailbox: string;
  /**
   * Authserv-ids the mailbox's own receiving server writes in
   * `Authentication-Results`, for a provider the program does not already
   * know. Only a top-most header naming one of these is read as a verdict.
   */
  readonly authservIds?: readonly string[] | undefined;
}

export interface EmailSummary {
  /**
   * The IMAP UID this message is read back by. Carried through from the
   * envelope because a listing whose entries cannot be opened is a listing
   * nobody can act on.
   *
   * A UID, and never a sequence number: a listing is read from later, and a
   * sequence number stops naming the same message as soon as anything below it
   * is expunged.
   */
  readonly uid: number;
  /** The `Message-ID` header, for threading and correlation. '' when absent. */
  readonly messageId: string;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  /** First ~4 KB of the plain-text body, fetched read-only. Empty string when unavailable. */
  readonly bodyPreview: string;
  /**
   * The mailbox this message was fetched from. Delivery evidence: a message
   * cannot be talked into arriving in a mailbox that exists only for one
   * signup, which is what makes per-signup aliases worth minting.
   */
  readonly mailbox: string;
  /**
   * Delivery-agent trace, top-most first. Written by the receiving mail
   * server, so, unlike `To:`, a sender cannot set it. Safe to correlate on.
   */
  readonly deliveredTo: readonly string[];
  /**
   * The `To:` header verbatim. **Display only, never evidence.** The sender
   * writes this field, so it proves nothing about where the message landed.
   * Named so that correlating on it reads as obviously wrong.
   */
  readonly unverifiedToHeaderClaim: string;
  /**
   * The `From:` line described as a CLAIM, carrying the receiving server's
   * sender-authentication verdict as DISPLAY confidence.
   *
   * `senderClaim.commandAuthority` is the literal `'none'` and cannot hold any
   * other value. A message that passes DKIM, SPF and DMARC and writes the
   * owner's own address in its From header gets a more confident sentence for
   * a human to read, and exactly the same authority as a stranger's: none.
   */
  readonly senderClaim: EmailSenderClaim;
}

/**
 * Result of a connection verification pass (a connect-wizard "test connection"
 * step). Never includes the raw password; `error` messages come from the
 * underlying client's plain-language exceptions.
 */
export interface EmailConnectionTestResult {
  readonly ok: boolean;
  /** Which stage failed, when ok is false. 'config' means validation failed before any connection was attempted. */
  readonly stage?: 'config' | 'imap' | 'smtp';
  readonly error?: string;
  /** On success: whether sending was checked, or no SMTP host is configured (a receive-only mailbox). */
  readonly smtp?: 'verified' | 'not-configured';
}

export interface SendMailOptions extends DeliveryLifetime {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Message-ID of the message this answers; sent as `In-Reply-To`. No CR/LF. */
  readonly inReplyTo?: string | undefined;
  /** The thread's Message-ID chain; sent as `References`. No CR/LF. */
  readonly references?: string | undefined;
  /** Must be true at the call site; the service rejects sends without it. */
  readonly confirm: boolean;
  /**
   * The left half of the Message-ID, chosen by the caller so a repeated send
   * carries the same id. Letters, digits, `.`, `_` and `-`, 8 to 160 characters.
   */
  readonly messageIdLocalPart?: string | undefined;
}

/** What to list, for `listInbox`. Every field is optional. */
export interface EmailInboxListInput {
  /** Cancellation drains admitted credential/transport work before settling. */
  readonly signal?: AbortSignal | undefined;
  /** Maximum messages to return. Default: 10. */
  readonly limit?: number | undefined;
  /** Restrict to messages the server dates on or after this day. */
  readonly since?: Date | undefined;
  /**
   * Unread messages only. Default: true, the historical behaviour of
   * `checkInbox`. Setting it false lists everything, which is a different
   * SEARCH, not the same one filtered afterwards.
   */
  readonly unreadOnly?: boolean | undefined;
  /** Only messages whose UID is below this one: the page after a page that ended at it. */
  readonly before?: number | undefined;
}

export interface EmailInboxListResult {
  /**
   * The matched messages, **newest first**, capped at `limit`.
   *
   * The order is part of the contract rather than an accident of how IMAP
   * answers a search, because it WAS an accident before and two consumers
   * disagreed about it: one rendered the array as-is and so showed the newest
   * page with the oldest message at the top, the other re-sorted client-side
   * on the `Date:` header. A daemon that does not define an order makes every
   * consumer invent one, and one of those inventions sorted on a field the
   * sender writes.
   *
   * Ordered by UID, which the receiving server assigns, and never by `Date:`,
   * which whoever sent the message wrote, a forged date must not be able to
   * pin a message to the top of the owner's inbox.
   */
  readonly messages: readonly EmailSummary[];
  /**
   * How many messages MATCHED, before `limit` truncated the list.
   *
   * Deliberately not `messages.length`: a caller needs to be able to tell "that
   * is all of them" from "that is the first ten", and a total that always
   * equalled the page size would say there is never any more mail.
   */
  readonly total: number;
  /**
   * FETCH responses on THIS page the client could not read. Absent means none.
   *
   * Here because a short page used to be silent, see
   * `EmailInboxUnreadableResponse` for the two facts that were being collapsed.
   * `total` cannot carry it: `total` counts the SEARCH match, and the loss
   * happens at the FETCH. Omitted when empty, so nothing consuming this shape
   * today sees a change; a caller that wants to know reads `unreadable?.length`.
   */
  readonly unreadable?: readonly EmailInboxUnreadableResponse[] | undefined;
  /**
   * The mailbox generation (UIDVALIDITY) the UIDs on this page belong to, as
   * EXAMINE reported it; absent when the server reported none. A change to a
   * listed message names it with this, so a reset mailbox refuses instead of
   * changing whichever message now holds the UID.
   */
  readonly uidValidity?: number | undefined;
}

/**
 * The fields a draft is composed from. `from` is the only optional one,
 * omitting it uses the configured `email.fromAddress`, which is what a caller
 * that is not choosing an identity should do.
 */
export interface EmailDraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** Defaults to the mailbox's From address (`surfaces.email.from`). */
  readonly from?: string | undefined;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
  /** Overrides Drafts-folder discovery. */
  readonly mailbox?: string | undefined;
}

/** Opens one transport connection to a mail host. */
export type EmailSocketFactory = (host: string, port: number) => Promise<Socket>;

/**
 * The real connections this service can need.
 *
 * A port rather than a direct call so that the service half never imports
 * `node:tls`: the concrete implementation is `nodeEmailTransport` in the
 * sibling `email/node` entry, and a test supplies one that throws.
 */
export interface EmailTransportPort {
  /** IMAP over implicit TLS (port 993). */
  readonly connectImapTls: EmailSocketFactory;
  /**
   * IMAP over a plain, unencrypted connection. Reached only when
   * `surfaces.email.imap.secure` is false. OPTIONAL because embedders implement
   * this public type and every existing one predates the member; one that omits
   * it is refused by name rather than quietly upgraded back to TLS.
   */
  readonly connectImapPlain?: EmailSocketFactory | undefined;
  /** SMTP submission over implicit TLS (port 465). */
  readonly connectSmtpTls: EmailSocketFactory;
  /** SMTP submission over a plain connection upgraded with STARTTLS (port 587). */
  readonly connectSmtpStartTls: EmailSocketFactory;
}

export interface EmailServiceDeps {
  /** Optional owned lifetime for canonical read provenance; absence fails closed. */
  readonly replySubjectSourceOwner?: EmailReplySubjectSourceOwner | undefined;
  /** Untyped config getter, reads the `email.*` namespace. */
  readonly getConfig: (key: string) => unknown;
  /** Optional canonical read-only inbox projection; absent preserves generic email.enabled. */
  readonly getInboxConfig?: ((key: string) => unknown) | undefined;
  /** SecretsManager-compatible interface for resolving secret refs. */
  readonly secretsManager: {
    readonly get: (key: string) => Promise<Secret | null>;
  };
  /** The real connections. Required: this module never opens one itself. */
  readonly transport: EmailTransportPort;
  /**
   * Describes a `From:` header as a claim, for display.
   *
   * Every product passes `describeSenderClaimNeutrally` (directly or through
   * its boundary module); it is a port so a test can see what it was handed.
   * Its `commandAuthority` is the literal `'none'`; see `sender-claim.ts`.
   */
  readonly describeSenderClaim: EmailSenderClaimDescriber;
  /** Optional socket factory override for IMAP (injected in tests). */
  readonly imapSocketFactory?: EmailSocketFactory;
  /** Optional socket factory override for SMTP (injected in tests). */
  readonly smtpSocketFactory?: EmailSocketFactory;
  /**
   * Records that untrusted content entered the conversation.
   *
   * Reading a mailbox pulls in text written by anyone who knows the address,
   * which is the same exposure as loading a web page, and the outward-effect
   * guard only fires on exposure it has been told about. Injected rather than
   * reached for globally so the service stays testable and so a caller cannot
   * accidentally record into a different session's ledger.
   */
  readonly recordUntrustedIngest?: (ingest: {
    readonly surface: 'email';
    readonly origin: string;
    readonly at: string;
    /**
     * The message text that was read.
     *
     * Without it the guard downstream can only ask "has this process read
     * mail", which in a daemon is permanently true and therefore decides
     * nothing. With it, an outward action can be checked for DERIVATION from
     * this message, which is the owner's named threat: an injection arriving
     * by email.
     */
    readonly content?: string | undefined;
  }) => void;
}

// ---------------------------------------------------------------------------
// EmailService
// ---------------------------------------------------------------------------

export class EmailService {
  private readonly deps: EmailServiceDeps;
  readonly #inboxObservations = new WeakMap<object, EmailMailboxObservation>();

  /** Exact local result only; mailbox evidence is never complete-content authority. */
  getInboxMailboxObservation(result: EmailInboxListResult | EmailInboxBatchRead): EmailMailboxObservation | undefined {
    const observation = this.#inboxObservations.get(result);
    try { observation?.assertCurrent(); return observation; } catch { return undefined; }
  }

  private bindObservation(observation: EmailMailboxObservation, signal?: AbortSignal): EmailMailboxObservation {
    const combined = signal ? AbortSignal.any([signal, observation.signal]) : observation.signal;
    return Object.freeze({ ...observation, signal: combined, assertCurrent() {
      if (combined.aborted) throw new Error('Mailbox observation is no longer current.');
      observation.assertCurrent();
    } });
  }

  /**
   * Message-ID -> the sender address of a message this process read whose
   * receiving server vouched for the sender (DKIM, SPF and DMARC all passed in
   * the `Authentication-Results` the mailbox's own server wrote). `null` marks an ID two different
   * senders have claimed, which proves nothing. A `Message-ID` is written by
   * the sender, so it only ever SELECTS a stored entry; the address returned
   * comes from the verified read, never from what a later message says.
   */
  readonly #replyEvidence = new Map<string, string | null>();

  #noteReplyEvidence(messageId: string, claim: EmailSenderClaim): void {
    const id = messageId.trim();
    if (id === '' || claim.displayedConfidence !== 'protocol-verified') return;
    const address = claim.claimedAddress.trim().toLowerCase();
    if (!address.includes('@')) return;
    const known = this.#replyEvidence.get(id);
    if (known !== undefined && known !== address) {
      this.#replyEvidence.set(id, null);
      return;
    }
    // Insertion order is age; bounded so a large mailbox cannot grow it forever.
    this.#replyEvidence.delete(id);
    this.#replyEvidence.set(id, known === null ? null : address);
    if (this.#replyEvidence.size > 2000) {
      const oldest = this.#replyEvidence.keys().next();
      if (!oldest.done) this.#replyEvidence.delete(oldest.value);
    }
  }

  /**
   * The verified sender of the message with this Message-ID, when this process
   * read it and its sender was authenticated by the receiving server; empty
   * otherwise. This is the only evidence a reply to that address may rely on.
   */
  getReplyEnvelopeSenders(inReplyTo: string): readonly string[] {
    const address = this.#replyEvidence.get(inReplyTo.trim());
    return address === undefined || address === null ? [] : [address];
  }

  #noteDetail(
    config: EmailConfig,
    detail: { readonly messageId: string; readonly from: string; readonly authenticationResults: readonly string[] },
  ): void {
    this.#noteReplyEvidence(
      detail.messageId,
      this.deps.describeSenderClaim(
        detail.from,
        readSenderAuthentication(detail.authenticationResults, mailboxAuthservIds(config.imapHost, config.authservIds)),
      ),
    );
  }

  constructor(deps: EmailServiceDeps) {
    this.deps = deps;
  }

  /** Returns a redacted status summary, never includes secret values. */
  getStatus(): { config: EmailConfig; errors: string[]; ready: boolean } {
    const config = readEmailConfig(this.deps.getConfig);
    return this.redactedStatus(config, validateEmailConfig(config));
  }

  /** Read-only readiness; does not enable sends or change ordinary mail status. */
  getInboxReadStatus(): { config: EmailConfig; errors: string[]; ready: boolean } {
    const config = readEmailConfig(this.deps.getInboxConfig ?? this.deps.getConfig);
    return this.redactedStatus(config, validateEmailInboxConfig(config));
  }

  private redactedStatus(config: EmailConfig, errors: string[]): { config: EmailConfig; errors: string[]; ready: boolean } {
    return {
      config: {
        ...config,
        // Redact the ref itself for display; keep structural info only
        passwordRef: config.passwordRef ? '[configured]' : '[missing]',
        // '[shared]' rather than '[missing]': an unset SMTP ref is not an
        // omission, it is the mailbox password doing both jobs.
        smtpPasswordRef: config.smtpPasswordRef ? '[configured]' : '[shared]',
      },
      errors,
      ready: errors.length === 0 && config.enabled,
    };
  }

  /**
   * Fetch up to `limit` unread inbox summaries.
   * Messages are read via EXAMINE (read-only); unread flag is never modified.
   *
   * The unread-only listing, unchanged. `listInbox` is the general form.
   */
  async checkInbox(limit = 10): Promise<EmailSummary[]> {
    const { messages } = await this.listInbox({ limit });
    return [...messages];
  }

  /**
   * List the inbox, NEWEST FIRST: unread only by default, everything when
   * `unreadOnly` is false, optionally bounded by a date.
   *
   * Read-only throughout, the mailbox is EXAMINEd and every fetch peeks, so
   * listing mail never marks it read. Returns the matched `total` alongside
   * the truncated page.
   */
  async listInbox(input: EmailInboxListInput = {}): Promise<EmailInboxListResult> {
    const { signal, limit, since, unreadOnly, before } = input;
    input = { signal, limit, since: since === undefined ? undefined : new Date(since.getTime()), unreadOnly, before };
    if (input.signal?.aborted) throw new Error('Mail read was cancelled.');
    const config = this.getValidatedConfig('read');
    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    const { buildResult, ingest } = await listEmailInbox(this.deps, config, sourceRead, input);
    const current = (): void => {
      if (input.signal?.aborted) throw new Error('Mail read was cancelled.');
      sourceRead?.assertCurrent();
    };
    current();
    for (const entry of ingest) { current(); this.recordIngest([entry], current); }
    current();
    const result = buildResult();
    current();
    for (const message of result.messages) this.#noteReplyEvidence(message.messageId, message.senderClaim);
    const observation = sourceRead?.completeMailboxObservation();
    current();
    if (observation) this.#inboxObservations.set(result, this.bindObservation(observation, input.signal));
    return result;
  }

  /** Complete-source inbox snapshot. No cursor advances here; incomplete content
   * withholds the batch. The caller needs current account authorization and screening.
   */
  async readInboxBatch(input: EmailInboxBatchInput = {}): Promise<EmailInboxBatchRead> {
    const { signal, limit } = input;
    input = { signal, limit };
    if (input.signal?.aborted) throw new Error('Mail read was cancelled.');
    const owner = this.deps.replySubjectSourceOwner;
    if (!owner) throw new Error('Mail snapshot requires an owned account lifetime.');
    const config = this.getValidatedConfig('read');
    const sourceRead = owner.beginRead(config);
    const result = await readEmailInboxBatch(this.deps, config, sourceRead, input);
    const current = (): void => {
      if (input.signal?.aborted) throw new Error('Mail read was cancelled.');
      sourceRead.assertCurrent();
    };
    current();
    if (result.outcome !== 'complete') return result;
    const observation = sourceRead.completeMailboxObservation();
    if (!observation) return Object.freeze({ outcome: 'incomplete', reason: 'Mailbox identity is unavailable.' });
    // A complete-source snapshot goes to privacy screening, never to a model:
    // only its screened previews reach one, through a tool whose result is
    // recorded then. Recording the raw text here would charge every session's
    // next send with mail none of them read.
    for (const message of result.messages) { current(); this.#noteDetail(config, message.source.detail); }
    current();
    this.#inboxObservations.set(result, this.bindObservation(observation, input.signal));
    return result;
  }

  /**
   * Read one whole message by UID, or null when it is no longer there.
   *
   * Read-only (BODY.PEEK throughout) and attachment-metadata only. The full
   * body is MORE attacker-controlled text than a preview, not less, so it
   * records the same untrusted ingest the listing does, one path into the
   * product, one labelling.
   *
   * **`null` means gone, and only gone.** It used to mean gone OR "the server
   * answered and this client could not read the answer", and the one caller of
   * this method turns `null` into the sentence "no message with UID n is in
   * the mailbox, it may have been moved or deleted since it was listed",
   * which in the second case is a false statement about the owner's mailbox.
   * An unreadable answer now THROWS, carrying what could not be read, because
   * every honest thing this signature can say about that case is "not the
   * message" and a caller has to be able to tell that apart from an expunge.
   * `readMessageResult` is the same read without the throw, for a caller that
   * would rather branch than catch.
   */
  async readMessage(uid: number): Promise<(ImapMessageDetail & { readonly uidValidity: number | null }) | null> {
    const read = await this.readMessageResult(uid);
    if (read.outcome === 'read') return { ...read.detail, uidValidity: read.uidValidity };
    if (read.outcome === 'gone') return null;
    throw new Error(
      `The mail server answered the request for UID ${String(uid)} with `
      + `${String(read.problems.length)} response(s) this client could not read `
      + `(${read.problems.map((problem) => problem.detail).join('; ')}). The message has not `
      + 'been shown to be gone, it is the answer about it that could not be read.',
    );
  }

  /**
   * The same read as `readMessage`, with "gone" and "could not be read" as
   * separate outcomes instead of one thrown error and one null.
   */
  async readMessageResult(uid: number): Promise<EmailMessageRead> {
    const config = this.getValidatedConfig('read');
    const read = await readEmailMessage(
      this.deps, config, uid,
      (messages, current) => this.recordIngest(messages, current),
    );
    if (read.outcome === 'read') this.#noteDetail(config, read.detail);
    return read;
  }

  /**
   * Save a draft to the Drafts folder. Nothing is sent: a draft is the outcome
   * that leaves the decision to send with the owner.
   *
   * A draft needs what a read needs plus a From address, never an SMTP host:
   * a receive-only mailbox can save drafts. `from` defaults to the configured
   * `email.fromAddress`. The folder is, in order: the caller's, then
   * `email.draftsMailbox`, then the one this account resolved earlier in this
   * process, then discovery from the server's own `\Drafts` flag.
   */
  async createDraft(input: EmailDraftInput): Promise<ImapAppendDraftResult> {
    const config = this.getValidatedConfig('read');
    input = { ...input };
    const from = input.from !== undefined && input.from.trim().length > 0
      ? input.from
      : config.fromAddress;
    if (from.trim().length === 0) {
      throw new EmailConfigurationError(
        'A draft needs a From address and none is set. Pass from, or set surfaces.email.from.', 'invalid');
    }
    const account = draftsAccountKey(config);
    // A configured name is an operator saying the server's own answer is wrong
    // for them, so it outranks discovery but not an explicit call.
    const chosen = input.mailbox ?? (config.draftsMailbox.length > 0 ? config.draftsMailbox : undefined);
    const remembered = chosen === undefined ? this.#draftsMailboxes.get(account) : undefined;
    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    // One Message-ID per draft, kept for every attempt: after a save whose answer was lost, the
    // next save of the same draft looks for it under that id (one UID SEARCH) before any second APPEND.
    const draftKey = draftIdentityKey(account, { ...input, from, mailbox: chosen });
    const uncertain = this.#unconfirmedDrafts.get(draftKey);
    const messageId = uncertain ?? `<${randomUUID()}@${messageIdDomain(from)}>`;
    try {
      const result = await withEmailReadConnection(this.deps, config, sourceRead, undefined, async (client) => {
        if (uncertain !== undefined) {
          const found = await client.findDraft(messageId, chosen ?? remembered);
          if (found) return found;
        }
        return client.appendDraft({
          to: input.to,
          subject: input.subject,
          body: input.body,
          from,
          inReplyTo: input.inReplyTo,
          references: input.references,
          mailbox: chosen ?? remembered,
          messageId,
        });
      }, { effect: true });
      this.#unconfirmedDrafts.delete(draftKey);
      // Discovery costs a LIST (and, on a server that flags nothing, a model
      // reading); the folder it found does not move between drafts.
      if (chosen === undefined) this.#draftsMailboxes.set(account, result.mailbox);
      return result;
    } catch (error) {
      if (error instanceof DraftAppendUnconfirmedError) rememberBounded(this.#unconfirmedDrafts, draftKey, messageId);
      // A remembered folder that stopped working is discovered again next time.
      if (remembered !== undefined) this.#draftsMailboxes.delete(account);
      throw error;
    }
  }

  /** Drafts whose save got no answer, by what they say: the Message-ID the next save of the same draft looks for first. */
  readonly #unconfirmedDrafts = new Map<string, string>();

  /**
   * Replace one saved draft with an edited one, so the Drafts folder keeps one
   * copy: the draft is named by its UID and the Drafts folder's UIDVALIDITY as
   * `listDrafts` (or `createDraft`) returned them, and a reset folder or a
   * draft that is gone refuses with nothing changed. The folder is found as
   * `createDraft` finds it.
   */
  async replaceDraft(input: EmailDraftInput & { readonly uid: number; readonly uidValidity: number }): Promise<ImapAppendDraftResult & { readonly replaced: number }> {
    const config = this.getValidatedConfig('read');
    input = { ...input };
    const from = input.from !== undefined && input.from.trim().length > 0
      ? input.from
      : config.fromAddress;
    if (from.trim().length === 0) {
      throw new EmailConfigurationError(
        'A draft needs a From address and none is set. Pass from, or set surfaces.email.from.', 'invalid');
    }
    const account = draftsAccountKey(config);
    const chosen = input.mailbox ?? (config.draftsMailbox.length > 0 ? config.draftsMailbox : undefined);
    const remembered = chosen === undefined ? this.#draftsMailboxes.get(account) : undefined;
    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    // As in createDraft: one Message-ID per replacement, kept across attempts, so
    // a retry after a save whose answer was lost finds the edited draft first.
    const draftKey = `${draftIdentityKey(account, { ...input, from, mailbox: chosen })}:${String(input.uid)}:${String(input.uidValidity)}`;
    const uncertain = this.#unconfirmedDrafts.get(draftKey);
    const messageId = uncertain ?? `<${randomUUID()}@${messageIdDomain(from)}>`;
    try {
      const result = await withEmailReadConnection(this.deps, config, sourceRead, undefined, (client) => client.replaceDraft({
        to: input.to,
        subject: input.subject,
        body: input.body,
        from,
        inReplyTo: input.inReplyTo,
        references: input.references,
        mailbox: chosen ?? remembered,
        uid: input.uid,
        uidValidity: input.uidValidity,
        messageId,
        lookFirst: uncertain !== undefined,
      }), { effect: true });
      this.#unconfirmedDrafts.delete(draftKey);
      if (chosen === undefined) this.#draftsMailboxes.set(account, result.mailbox);
      return result;
    } catch (error) {
      if (error instanceof DraftAppendUnconfirmedError) rememberBounded(this.#unconfirmedDrafts, draftKey, messageId);
      throw error;
    }
  }

  /**
   * Mark one message in the read mailbox read or unread, archive it, or move it
   * to Trash. `uidValidity` is the mailbox generation the UID was listed
   * under; a reset mailbox refuses instead of changing another message.
   */
  async updateMessage(uid: number, action: ImapMessageAction, uidValidity: number): Promise<ImapMessageActionResult> {
    const config = this.getValidatedConfig('read');
    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    return withEmailReadConnection(this.deps, config, sourceRead, undefined,
      (client) => client.applyMessageAction(uid, action, uidValidity), { effect: true });
  }

  /**
   * One attachment's bytes, by its position in `readMessage`'s attachment list,
   * or null when the message is gone. `uidValidity` is the mailbox generation
   * the message was read under; a reset mailbox refuses before anything is
   * fetched. The bytes are handed over as a file and never read as text, so
   * nothing is recorded as an untrusted ingest.
   */
  async readAttachment(uid: number, index: number, uidValidity: number): Promise<ImapAttachmentContent | null> {
    const config = this.getValidatedConfig('read');
    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    return withEmailReadConnection(this.deps, config, sourceRead, undefined,
      (client) => client.fetchAttachment(uid, index, uidValidity), { maxLiteralBytes: IMAP_ATTACHMENT_LITERAL_BYTES });
  }

  /** The newest drafts in the account's Drafts folder (older than UID `before` when given), newest first, each with its body. */
  async listDrafts(limit = 25, before?: number): Promise<{ readonly drafts: readonly ImapDraftSummary[]; readonly total: number; readonly mailbox: string; readonly uidValidity: number | null }> {
    const config = this.getValidatedConfig('read');
    const account = draftsAccountKey(config);
    const chosen = config.draftsMailbox.length > 0 ? config.draftsMailbox : this.#draftsMailboxes.get(account);
    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    const result = await withEmailReadConnection(this.deps, config, sourceRead, undefined,
      (client) => client.listDrafts(limit, chosen, before));
    // A draft is the owner's own text, written to be sent, so it is not recorded as an
    // untrusted ingest: recording it would refuse sending the very draft that was opened.
    if (config.draftsMailbox.length === 0) this.#draftsMailboxes.set(account, result.mailbox);
    return result;
  }

  /** Drafts folder per account, resolved once by discovery and kept for the life of this service. */
  readonly #draftsMailboxes = new Map<string, string>();

  /**
   * Record that mail text entered the conversation.
   *
   * Reading a mailbox is an untrusted ingest, exactly as loading a web page is:
   * the text was written by whoever chose to send it. The outward-effect guard
   * can only weigh exposure it has been told about, so it is told here rather
   * than after something has already been sent.
   *
   * Origin is the CLAIMED sender domain, and is labelled as claimed wherever it
   * surfaces. It is a useful label for the owner, never an identity check, the
   * claim is why the content is untrusted, not a reason to trust it.
   */
  private recordIngest(entries: readonly { readonly from: string; readonly text?: string | undefined }[], assertCurrent?: () => void): void {
    const recordIngest = this.deps.recordUntrustedIngest;
    if (!recordIngest) return;
    const at = new Date().toISOString();
    for (const entry of entries) {
      assertCurrent?.();
      const claimed = this.deps.describeSenderClaim(entry.from).claimedAddress;
      assertCurrent?.();
      const domain = claimed.includes('@') ? claimed.slice(claimed.lastIndexOf('@') + 1) : '';
      recordIngest({
        surface: 'email',
        origin: domain.length > 0 ? `email:${domain} (claimed)` : 'email:unknown sender',
        at,
        // The subject and body ARE the injection surface. Recording the origin
        // without them leaves the guard unable to tell a send that repeats an
        // instruction from one that does not.
        ...(entry.text === undefined ? {} : { content: entry.text }),
      });
      assertCurrent?.();
    }
  }

  /**
   * Verify the configured IMAP and SMTP connections without sending mail or
   * reading the inbox, a real connectivity + authentication check for a
   * connect-wizard "test connection" step. It applies the same setup gate as
   * reading mail, so a mailbox the test passes is one every read accepts.
   *
   * Never throws, returns a result describing which stage (if any) failed,
   * with a plain-language error message. Never includes the raw password.
   */
  async testConnection(): Promise<EmailConnectionTestResult> {
    const config = readEmailConfig(this.readConfigFor('read'));
    if (!config.enabled) return { ok: false, stage: 'config', error: NOT_SET_UP_FOR_READING };
    // A mailbox set up for reading only is tested for reading only; the send
    // half is checked when an SMTP host is configured.
    const sends = config.smtpHost.length > 0;
    const errors = sends ? validateEmailConfig(config) : validateEmailInboxConfig(config);
    if (errors.length > 0) {
      return { ok: false, stage: 'config', error: errors.join('; ') };
    }

    const sourceRead = this.deps.replySubjectSourceOwner?.beginRead(config);
    try {
      // EXAMINE the mailbox that will actually be read, so a folder name that
      // does not exist fails the connection test rather than the first real
      // listing. The one owned session does that, and closes the socket on
      // every path.
      await withEmailReadConnection(this.deps, config, sourceRead, undefined, async () => undefined);
    } catch (err) {
      const stage = err instanceof EmailCredentialUnavailableError ? 'config' : 'imap';
      return { ok: false, stage, error: err instanceof Error ? err.message : String(err) };
    }
    if (!sends) return { ok: true, smtp: 'not-configured' };

    let smtpSocket: { destroy(): unknown } | undefined;
    try {
      const smtpPassword = await resolveEmailPassword(smtpPasswordRefFor(config), this.deps.secretsManager, smtpSettingFor(config));
      const socketFactory = this.deps.smtpSocketFactory ?? this.defaultSmtpSocketFactory(config.smtpPort, config.smtpSecurity);
      const socket = await socketFactory(config.smtpHost, config.smtpPort);
      smtpSocket = socket;
      socket.on('error', () => {});
      const client = new SmtpClient({ socket, hostname: config.smtpHost, username: config.username, password: smtpPassword });
      await client.verifyAuth();
    } catch (err) {
      return { ok: false, stage: 'smtp', error: err instanceof Error ? err.message : String(err) };
    } finally {
      smtpSocket?.destroy();
    }

    return { ok: true, smtp: 'verified' };
  }

  /**
   * Send a plain-text email.
   * Requires `confirm: true` at the call site, throws without it.
   *
   * Returns the `Message-ID` the sent message carried and the instant the
   * server accepted it, both taken from the send itself. A caller that needs
   * to say what it sent gets the real values rather than inventing an id that
   * matches nothing in the owner's mailbox.
   */
  async sendMail(opts: SendMailOptions): Promise<SmtpSendResult> {
    if (!opts.confirm) {
      throw new Error('sendMail requires confirm: true at the call site');
    }
    assertDeliveryCurrent(opts);

    const config = this.getValidatedConfig('send');
    const password = await resolveEmailPassword(smtpPasswordRefFor(config), this.deps.secretsManager, smtpSettingFor(config));
    assertDeliveryCurrent(opts);
    validateSmtpAddress(config.fromAddress, 'from');
    validateSmtpAddress(opts.to, 'to');
    validateSmtpSubject(opts.subject);
    if (opts.inReplyTo !== undefined) validateSmtpThreadHeader(opts.inReplyTo, 'inReplyTo');
    if (opts.references !== undefined) validateSmtpThreadHeader(opts.references, 'references');

    const socketFactory = this.deps.smtpSocketFactory ?? this.defaultSmtpSocketFactory(config.smtpPort, config.smtpSecurity);
    const socket = await socketFactory(config.smtpHost, config.smtpPort);
    try { assertDeliveryCurrent(opts); } catch (error) { socket.destroy(); throw error; }

    const client = new SmtpClient({
      socket,
      hostname: config.smtpHost,
      username: config.username,
      password,
    });

    return client.sendMail({
      from: config.fromAddress,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      inReplyTo: opts.inReplyTo,
      references: opts.references,
      ...(opts.messageIdLocalPart === undefined ? {} : { messageIdLocalPart: opts.messageIdLocalPart }),
      signal: opts.signal,
      assertCurrent: opts.assertCurrent,
      withPublication: opts.withPublication,
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * The config reader for what the operation needs. A read is set up once the
   * receiving half is (the inbox reader's answer), so a receive-only mailbox
   * reads; a send needs the sending half too.
   */
  private readConfigFor(purpose: 'read' | 'send'): (key: string) => unknown {
    return purpose === 'read' ? this.deps.getInboxConfig ?? this.deps.getConfig : this.deps.getConfig;
  }

  /**
   * The mail config, validated for what the operation needs: a read (listing,
   * reading, saving a draft) needs the IMAP half only; a send needs SMTP and a
   * From address as well.
   */
  private getValidatedConfig(purpose: 'read' | 'send'): EmailConfig {
    const config = readEmailConfig(this.readConfigFor(purpose));
    if (!config.enabled) {
      throw new EmailConfigurationError(purpose === 'read' ? NOT_SET_UP_FOR_READING : NOT_SET_UP_FOR_SENDING, 'disabled');
    }
    const errors = purpose === 'send' ? validateEmailConfig(config) : validateEmailInboxConfig(config);
    if (errors.length > 0) {
      throw new EmailConfigurationError(`Email config is invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`, 'invalid');
    }
    return config;
  }

  private defaultSmtpSocketFactory(
    port: number,
    security: SmtpSecurityMode,
  ): EmailSocketFactory {
    // Honor an explicit smtpSecurity setting; fall back to port-based auto detection
    if (security === 'tls') return this.deps.transport.connectSmtpTls;
    if (security === 'starttls') return this.deps.transport.connectSmtpStartTls;
    // 'auto': use direct TLS on port 465, STARTTLS otherwise
    if (port === 465) return this.deps.transport.connectSmtpTls;
    return this.deps.transport.connectSmtpStartTls;
  }
}

const NOT_SET_UP_FOR_READING = 'No mailbox is set up for reading. Set surfaces.email.imap.host (or surfaces.email.host) '
  + 'and surfaces.email.user, and store the email password.';
const NOT_SET_UP_FOR_SENDING = 'Sending mail is not set up. Set surfaces.email.smtp.host (or surfaces.email.host), '
  + 'surfaces.email.imap.host and surfaces.email.user, and store the email password.';

/** Which setting holds the SMTP secret reference actually in use, for refusals that name it. */
function smtpSettingFor(config: EmailConfig): string {
  return config.smtpPasswordRef.length > 0 ? 'surfaces.email.smtp.password' : 'surfaces.email.password';
}

/** The mailbox account a drafts folder belongs to. */
function draftsAccountKey(config: EmailConfig): string {
  return JSON.stringify([config.imapHost, config.imapPort, config.username]);
}

/** What makes two saves the same draft: the account, the folder asked for and every field of the message. */
function draftIdentityKey(account: string, draft: { readonly to: string; readonly subject: string; readonly body: string; readonly from: string; readonly inReplyTo?: string | undefined; readonly references?: string | undefined; readonly mailbox?: string | undefined }): string {
  return createHash('sha256').update(JSON.stringify([account, draft.mailbox ?? '', draft.from, draft.to, draft.subject, draft.body, draft.inReplyTo ?? '', draft.references ?? ''])).digest('hex');
}

/** The domain of a From address for a Message-ID, or `goodvibes.invalid` when it has none this id may carry. */
function messageIdDomain(from: string): string {
  const domain = /@([A-Za-z0-9.-]+)>?\s*$/.exec(from.trim())?.[1];
  return domain && domain.length > 0 ? domain.toLowerCase() : 'goodvibes.invalid';
}

/** Remembers at most 128 unconfirmed drafts; the oldest goes first. */
function rememberBounded(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > 128) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}
