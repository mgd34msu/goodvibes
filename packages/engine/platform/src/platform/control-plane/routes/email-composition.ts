import { EmailConfigurationError } from '../../email/email-service.js';
import { EmailCredentialUnavailableError } from '../../email/email-config.js';
import { ImapOpenError } from '../../email/imap-open.js';
import { EmailInputError, SmtpReplyError } from '../../email/smtp-client.js';
/**
 * routes/email-composition.ts, the daemon's own mailbox.
 *
 * Adapts the platform `EmailService` onto the `EmailGatewayService` slice the
 * `email.*` verb handlers are written against. Assembled here rather than in
 * the runtime composition root so one property stays visible: the daemon reads
 * its mail settings and its password from the DAEMON tier and nowhere else, so
 * a setup performed in any surface is usable here the moment it lands and
 * stays usable after that surface exits.
 *
 * Returns `null` when the composition is too narrow to reach a real store, so
 * the verbs stay unregistered rather than half-wired and answering 500s.
 *
 * Three layers, in order, so each is one idea:
 *
 *  1. `createServiceBackedGateway`, the mapping onto `EmailService`, and the
 *     one place its errors become honest statuses. The mail layer throws
 *     typed errors (unfinished setup, a bad field, a refused sign-in, a
 *     missing folder, a send whose outcome is unknown); each is answered by
 *     its type and code, never by reading its wording.
 *  2. `instrumentEmailGateway`, unfinished setup reported in the operator's
 *     own key names, and an operational log line per verb.
 *  3. `createDaemonEmailGatewayService`, which of those a given composition
 *     gets.
 *
 * Operational log fields omit sender and recipient addresses.
 */
import { EmailService, SmtpDeliveryUnconfirmedError, type EmailServiceDeps } from '../../email/index.js';
import {
  getProcessUntrustedContentLedger,
  type UntrustedContentLedger,
} from '../../security/untrusted-content.js';
import type { SurfaceEmailConfigProblem } from '../../email/surface-config.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { resolveOwnerAddresses } from '../../security/owner-identity.js';
import { registerEmailGatewayMethods } from './email.js';
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type {
  EmailGatewayAttachmentContent,
  EmailGatewayDraftList,
  EmailGatewayMessageUpdate,
  EmailGatewayMessageUpdateResult,
  EmailGatewayDraftInput,
  EmailGatewayDraftResult,
  EmailGatewayDraftUpdateInput,
  EmailGatewayDraftUpdateResult,
  EmailGatewayListInput,
  EmailGatewayListResult,
  EmailGatewayMessageDetail,
  EmailGatewaySendInput,
  EmailGatewaySendResult,
  EmailGatewayService,
} from './email.js';

/**
 * One operational log line about a mail verb.
 *
 * Fields describe the operation and its outcome, without message bodies or
 * address-derived correlation tokens.
 */
export type EmailGatewayLog = (
  event: string,
  fields: Readonly<Record<string, string | number | boolean>>,
) => void;

/** The slice of the verb-group deps this composition needs. */
export interface EmailCompositionDeps {
  /** Test seam: overrides the whole service, so no real socket is opened. */
  readonly emailGateway?: EmailGatewayService | undefined;
  /** Everything `EmailService` needs. Absent in narrow compositions. */
  readonly emailServiceDeps?: EmailServiceDeps | undefined;
  /**
   * The ledger a mailbox read is recorded into.
   *
   * Defaults to the process-wide one, the SAME ledger the daemon's browser
   * engine records page reads into (routes/browser-composition.ts). Sharing it
   * is the point: reading a stranger's page and reading a stranger's mail are
   * the same kind of exposure, and a send made afterwards discloses both from
   * one record rather than from two that cannot see each other.
   */
  readonly untrustedContentLedger?: UntrustedContentLedger | undefined;
  /**
   * Why the mailbox is not usable yet, in the operator's own key names.
   *
   * Supplied when the settings come from the daemon's `surfaces.email.*` keys,
   * because the service's own validation reports `email.imapHost is required`,
   * a key that operator does not have and cannot set. Absent for a plain
   * `email.*` composition, where that wording is the correct wording.
   */
  readonly describeEmailConfigProblem?: (() => Promise<SurfaceEmailConfigProblem | null>) | undefined;
  /** Operational log sink. Absent means these verbs log nothing at all. */
  readonly emailLog?: EmailGatewayLog | undefined;
}

/** SMTP reply codes that refuse the account's sign-in (RFC 4954). */
const SMTP_AUTH_REFUSED = new Set([530, 534, 535]);

/**
 * Each mail failure answered from its own type, by code; no wording is read.
 *
 * Setup that is unfinished, a field the caller got wrong, a refused sign-in
 * and a missing folder are the caller's or the owner's to fix (4xx). A send
 * whose final reply was lost is 409, not a 5xx, because every retry policy
 * treats a 5xx as "try again" and that send may already have been delivered.
 * Only a server that is down or unreachable is 503, the one answer a retry can
 * fix. The mail server refusing the stored password is 424: the request
 * failed on a credential the daemon holds for a third party, not on the
 * caller's own sign-in, so no client treats it as an expired session (401).
 */
function translate(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof EmailConfigurationError && error.kind === 'disabled') {
    throw new GatewayVerbError(message, 'EMAIL_NOT_ENABLED', 400);
  }
  if (error instanceof EmailConfigurationError && error.kind === 'invalid') {
    throw new GatewayVerbError(message, 'EMAIL_NOT_CONFIGURED', 400);
  }
  if (error instanceof EmailCredentialUnavailableError) {
    throw new GatewayVerbError(message, 'EMAIL_NOT_CONFIGURED', 400);
  }
  if (error instanceof EmailInputError) {
    throw new GatewayVerbError(`${message} Nothing was sent.`, 'INVALID_ARGUMENT', 400, error.field);
  }
  if (error instanceof SmtpDeliveryUnconfirmedError) {
    throw new GatewayVerbError(message, 'EMAIL_DELIVERY_UNCONFIRMED', 409);
  }
  if (error instanceof SmtpReplyError) {
    if (error.stage.startsWith('AUTH') && SMTP_AUTH_REFUSED.has(error.code)) {
      throw new GatewayVerbError(
        `${message} The mail server refused the stored password, so nothing was sent. Store a current one and send again.`,
        'EMAIL_CREDENTIALS_REJECTED',
        424,
      );
    }
    if (error.stage === 'RCPT TO' && error.code >= 500) {
      throw new GatewayVerbError(
        `${message} The mail server refused this recipient, so nothing was sent. Check the address.`,
        'EMAIL_RECIPIENT_REJECTED',
        400,
        'to',
      );
    }
    if (error.code >= 400 && error.code < 500) {
      throw new GatewayVerbError(
        `${message} The mail server reported a temporary condition and nothing was sent; send again later.`,
        'EMAIL_SERVER_UNAVAILABLE',
        503,
      );
    }
    throw new GatewayVerbError(`${message} Nothing was sent.`, 'EMAIL_REQUEST_FAILED', 502);
  }
  if (error instanceof ImapOpenError) {
    const owner = error.notice.ownerMessage;
    switch (error.reason) {
      case 'authentication-rejected':
        throw new GatewayVerbError(owner, 'EMAIL_CREDENTIALS_REJECTED', 424);
      case 'mailbox-unavailable':
        throw new GatewayVerbError(owner, 'EMAIL_MAILBOX_UNAVAILABLE', 409);
      case 'server-unavailable':
      case 'connection-failed':
        throw new GatewayVerbError(owner, 'EMAIL_SERVER_UNAVAILABLE', 503);
    }
  }
  throw new GatewayVerbError(message, 'EMAIL_REQUEST_FAILED', 502);
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof GatewayVerbError) throw error;
    return translate(error);
  }
}

/** The `EmailGatewayService` slice, served by a platform `EmailService`. */
export function createServiceBackedGateway(service: EmailService): EmailGatewayService {
  return {
    async listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult> {
      return guard(async () => {
        const since = input.since === undefined ? undefined : new Date(input.since);
        if (since !== undefined && !Number.isFinite(since.getTime())) {
          throw new GatewayVerbError('since must be a parseable date', 'INVALID_ARGUMENT', 400, 'since');
        }
        const result = await service.listInbox({
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          ...(since === undefined ? {} : { since }),
          ...(input.unreadOnly === undefined ? {} : { unreadOnly: input.unreadOnly }),
          ...(input.before === undefined ? {} : { before: input.before }),
        });
        return {
          messages: result.messages.map((message) => ({
            uid: message.uid,
            from: message.from,
            subject: message.subject,
            date: message.date,
            unread: message.unread,
            bodyPreview: message.bodyPreview,
            messageId: message.messageId,
          })),
          total: result.total,
          ...(result.uidValidity === undefined ? {} : { uidValidity: result.uidValidity }),
          ...(result.unreadable !== undefined && result.unreadable.length > 0
            ? {
              unreadable: result.unreadable.map((problem) => ({
                ...(problem.uid === null ? {} : { uid: problem.uid }),
                detail: problem.detail,
              })),
            }
            : {}),
        };
      });
    },

    async readMessage(uid: number): Promise<EmailGatewayMessageDetail | null> {
      return guard(async () => {
        const message = await service.readMessage(uid);
        if (message === null) return null;
        const detail: EmailGatewayMessageDetail = {
          uid: message.uid,
          from: message.from,
          subject: message.subject,
          date: message.date,
          messageId: message.messageId,
          bodyText: message.bodyText,
          ...(message.bodyHtml.length > 0 ? { bodyHtml: message.bodyHtml } : {}),
          ...(message.attachments.length > 0 ? { attachments: message.attachments } : {}),
          ...(message.uidValidity === null ? {} : { uidValidity: message.uidValidity }),
          ...(message.bodyUnavailable === undefined ? {} : { bodyUnavailable: message.bodyUnavailable }),
        };
        return detail;
      });
    },

    async createDraft(input: EmailGatewayDraftInput): Promise<EmailGatewayDraftResult> {
      return guard(async () => {
        const result = await service.createDraft({
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          ...(input.references === undefined ? {} : { references: input.references }),
        });
        return {
          // Built only from what the server actually told us: the folder it
          // landed in, and the APPENDUID when the server advertises UIDPLUS.
          // Without a uid there is no per-draft identifier to hand back, and
          // the mailbox alone is the honest answer, better than a synthetic
          // id that no later fetch could resolve.
          draftId: result.uid === null ? result.mailbox : `${result.mailbox}:${String(result.uid)}`,
          ...(result.uid === null ? {} : { uid: result.uid }),
          ...(result.uidValidity === null ? {} : { uidValidity: result.uidValidity }),
          mailbox: result.mailbox,
        };
      });
    },

    async updateDraft(input: EmailGatewayDraftUpdateInput): Promise<EmailGatewayDraftUpdateResult> {
      return guard(async () => {
        const result = await service.replaceDraft({
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          ...(input.references === undefined ? {} : { references: input.references }),
          uid: input.uid,
          uidValidity: input.uidValidity,
        });
        return {
          draftId: result.uid === null ? result.mailbox : `${result.mailbox}:${String(result.uid)}`,
          ...(result.uid === null ? {} : { uid: result.uid }),
          ...(result.uidValidity === null ? {} : { uidValidity: result.uidValidity }),
          mailbox: result.mailbox,
          replaced: result.replaced,
        };
      });
    },

    replyEnvelopeSenders(inReplyTo: string): readonly string[] {
      return service.getReplyEnvelopeSenders(inReplyTo);
    },

    async send(input: EmailGatewaySendInput): Promise<EmailGatewaySendResult> {
      return guard(async () => {
        const result = await service.sendMail({
          to: input.to,
          subject: input.subject,
          body: input.body,
          ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
          // The handler already refused anything without an explicit
          // confirm: true from the caller; this is the service's own
          // belt-and-braces precondition, not a second decision.
          confirm: true,
          // A repeat of the same send carries the same Message-ID, so a
          // receiving server that saw the first copy can drop the second.
          ...(input.clientSendId === undefined ? {} : { messageIdLocalPart: `gv.${input.clientSendId}` }),
        });
        return { messageId: result.messageId, sentAt: result.sentAt };
      });
    },

    async updateMessage(input: EmailGatewayMessageUpdate): Promise<EmailGatewayMessageUpdateResult> {
      return guard(async () => {
        const result = await service.updateMessage(input.uid, input.action, input.uidValidity);
        return { uid: result.uid, action: result.action, ...(result.movedTo === undefined ? {} : { movedTo: result.movedTo }) };
      });
    },

    async readAttachment(uid: number, index: number): Promise<EmailGatewayAttachmentContent | null> {
      return guard(async () => service.readAttachment(uid, index));
    },

    async listDrafts(limit: number, before?: number): Promise<EmailGatewayDraftList> {
      return guard(async () => {
        const result = await service.listDrafts(limit, before);
        return {
          drafts: result.drafts.map((draft) => ({ ...draft })),
          total: result.total,
          mailbox: result.mailbox,
          ...(result.uidValidity === null ? {} : { uidValidity: result.uidValidity }),
        };
      });
    },
  };
}

export interface EmailGatewayInstrumentation {
  readonly describeEmailConfigProblem?: (() => Promise<SurfaceEmailConfigProblem | null>) | undefined;
  readonly emailLog?: EmailGatewayLog | undefined;
}

/**
 * Wrap a mail backend with the two things every caller of these verbs should
 * get regardless of what is behind them: unfinished setup reported in terms the
 * operator can act on, and a log line that says what happened without saying
 * who it happened with.
 */
export function instrumentEmailGateway(
  backend: EmailGatewayService,
  options: EmailGatewayInstrumentation,
): EmailGatewayService {
  const log: EmailGatewayLog = options.emailLog ?? ((): void => {});

  /** Refuse before the mailbox is touched when setup is not finished. */
  async function ready(): Promise<void> {
    const problem = await options.describeEmailConfigProblem?.();
    if (problem) throw new GatewayVerbError(problem.message, problem.code, 400);
  }

  return {
    ...(backend.replyEnvelopeSenders === undefined ? {} : {
      replyEnvelopeSenders: (inReplyTo: string) => backend.replyEnvelopeSenders?.(inReplyTo) ?? [],
    }),
    async listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult> {
      await ready();
      const result = await backend.listInbox(input);
      log('email.inbox.list', {
        count: result.messages.length,
        unreadOnly: input.unreadOnly ?? true,
      });
      return result;
    },

    async readMessage(uid: number): Promise<EmailGatewayMessageDetail | null> {
      await ready();
      const message = await backend.readMessage(uid);
      if (message === null) return null;
      log('email.inbox.read', {
        uid,
        hasHtml: message.bodyHtml !== undefined && message.bodyHtml.length > 0,
        attachments: message.attachments?.length ?? 0,
      });
      return message;
    },

    async createDraft(input: EmailGatewayDraftInput): Promise<EmailGatewayDraftResult> {
      await ready();
      const result = await backend.createDraft(input);
      log('email.draft.create', {
        mailbox: result.mailbox,
        ...(result.uid === undefined ? {} : { uid: result.uid }),
      });
      return result;
    },

    async send(input: EmailGatewaySendInput): Promise<EmailGatewaySendResult> {
      await ready();
      const result = await backend.send(input);
      log('email.send', {
        messageId: result.messageId,
        sentAt: result.sentAt,
      });
      return result;
    },

    ...(backend.updateMessage === undefined ? {} : {
      async updateMessage(input: EmailGatewayMessageUpdate): Promise<EmailGatewayMessageUpdateResult> {
        await ready();
        const result = await backend.updateMessage!(input);
        log('email.inbox.update', { uid: result.uid, action: result.action });
        return result;
      },
    }),

    ...(backend.readAttachment === undefined ? {} : {
      async readAttachment(uid: number, index: number): Promise<EmailGatewayAttachmentContent | null> {
        await ready();
        const result = await backend.readAttachment!(uid, index);
        if (result) log('email.attachment.get', { uid, index, sizeBytes: result.sizeBytes });
        return result;
      },
    }),

    ...(backend.updateDraft === undefined ? {} : {
      async updateDraft(input: EmailGatewayDraftUpdateInput): Promise<EmailGatewayDraftUpdateResult> {
        await ready();
        const result = await backend.updateDraft!(input);
        log('email.draft.update', {
          mailbox: result.mailbox,
          replaced: result.replaced,
          ...(result.uid === undefined ? {} : { uid: result.uid }),
        });
        return result;
      },
    }),

    ...(backend.listDrafts === undefined ? {} : {
      async listDrafts(limit: number, before?: number): Promise<EmailGatewayDraftList> {
        await ready();
        const result = await backend.listDrafts!(limit, before);
        log('email.drafts.list', { count: result.drafts.length, total: result.total });
        return result;
      },
    }),
  };
}

export function createDaemonEmailGatewayService(
  deps: EmailCompositionDeps,
): EmailGatewayService | null {
  const ledger = deps.untrustedContentLedger ?? getProcessUntrustedContentLedger();
  const backend = deps.emailGateway
    ?? (deps.emailServiceDeps
      ? createServiceBackedGateway(new EmailService({
        ...deps.emailServiceDeps,
        // Bound here rather than left to the caller: a composition that forgot
        // it would read strangers' mail into nothing, and the exposure a later
        // send discloses would be missing exactly the half that mattered. This
        // is the SAME process-wide ledger the daemon's browser engine records
        // page reads into, so reading a stranger's page and reading a
        // stranger's mail accrue to one record rather than two that cannot see
        // each other. A caller that supplies its own recorder still wins.
        recordUntrustedIngest: deps.emailServiceDeps.recordUntrustedIngest
          ?? ((ingest) => { ledger.record(ingest); }),
      }))
      : null);
  if (backend === null) return null;
  return instrumentEmailGateway(backend, {
    describeEmailConfigProblem: deps.describeEmailConfigProblem,
    emailLog: deps.emailLog,
  });
}

/**
 * Register the daemon's `email.*` verbs, with the owner identity the taint
 * exemption needs.
 *
 * Lives here rather than at the verb-group root so the whole mail composition
 *, service, instrumentation, and now the owner's own addresses, is decided
 * in one file. The addresses are read from the daemon's configuration at each send and from
 * nowhere a message can reach; empty leaves the taint refusal in force rather
 * than guessing at an identity. See security/owner-identity.ts.
 */
export function registerDaemonEmailVerbs(
  catalog: GatewayMethodCatalog,
  deps: EmailCompositionDeps & { readonly configManager?: { get(key: never): unknown } | undefined },
): void {
  const gateway = createDaemonEmailGatewayService(deps);
  if (!gateway) return;
  const getConfig = deps.configManager;
  registerEmailGatewayMethods(
    catalog,
    gateway,
    // The same ledger the mailbox reads were recorded into: with a different
    // one, the taint check at send time would never see what was read.
    deps.untrustedContentLedger,
    // Read at each send, so an address changed in settings takes effect
    // without a restart and a retired one stops being exempt.
    getConfig === undefined
      ? new Set<string>()
      : () => resolveOwnerAddresses((key) => getConfig.get(key as never)),
  );
}
