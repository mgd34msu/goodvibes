/**
 * routes/email.ts, the daemon actually serving `email.*`.
 *
 * These four methods shipped cataloged with `invokable: false` because the
 * IMAP/SMTP service that could satisfy them lived inside a single product, so
 * the daemon had nothing to call. The practical consequence was not a 404 on
 * an obscure path: it meant scheduled work, triggers and channel-driven work
 * could not send mail at all, with no product process attached. A reminder
 * that was supposed to arrive by email simply did not.
 *
 * The service is platform capability now (`platform/email`), so this module is
 * the thin part: it maps the descriptors' declared shapes onto a narrow
 * service slice. It performs no I/O, holds no credential, opens no socket, and
 * knows nothing about IMAP or SMTP.
 *
 * Three properties are enforced here rather than merely advertised:
 *
 *  - **`confirm: true` gates the send.** `email.send` is an irreversible
 *    outward effect. The descriptor marks it `dangerous`/`admin` and requires
 *    `confirm` in its schema, and this module refuses without it as well, so
 *    the guarantee does not rest on schema validation being reached by every
 *    transport that can invoke a method.
 *  - **A body is never echoed into an error.** Failures report the stage and
 *    the server's own plain-language reason; the message being sent is not
 *    part of a diagnostic.
 *  - **Read stays read.** `inbox.list`, `inbox.read` and `attachment.get` use
 *    `BODY.PEEK`, so reading over the wire never marks the owner's mail read;
 *    `inbox.update` is the one verb that changes a message, and only the one
 *    UID it names.
 *  - **A repeated send is one send.** `email.send` takes a `clientSendId`; a
 *    repeat with the same id and the same message returns the first answer
 *    instead of mailing the recipients again.
 *
 * Mail read through here is attacker-controlled text, anyone who knows the
 * address can put words in front of whatever consumes this. The service
 * records an untrusted ingest for every message it returns; a caller that
 * feeds a body onward is responsible for keeping that provenance attached.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import {
  UNTRUSTED_CONTENT_RULE,
  getProcessUntrustedContentLedger,
  type UntrustedContentLedger,
} from '../../security/untrusted-content.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { evaluateOutwardEffect } from '../../security/untrusted-content.js';
import { isSendToOwnerOnly } from '../../security/owner-identity.js';
import { refuseNonUserRequest } from './explicit-user-request.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';

/** One inbox message, in the shape `email.inbox.list` advertises. */
export interface EmailGatewayMessageSummary {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly unread: boolean;
  readonly bodyPreview: string;
  readonly messageId: string;
  /** The daemon's triage label, when its inbox mirror holds a settled one for this message. */
  readonly triageLabel?: 'spam' | 'priority' | 'normal';
}

export interface EmailGatewayAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** One message, in the shape `email.inbox.read` advertises. */
export interface EmailGatewayMessageDetail {
  readonly uid: number;
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly messageId: string;
  readonly bodyText: string;
  readonly bodyHtml?: string;
  readonly attachments?: readonly EmailGatewayAttachment[];
}

export interface EmailGatewayListInput {
  readonly limit?: number | undefined;
  readonly since?: string | undefined;
  readonly unreadOnly?: boolean | undefined;
  /** Only messages with a UID below this one: the next page after a page ending at it. */
  readonly before?: number | undefined;
}

/** A FETCH response on the returned page the daemon could not read. */
export interface EmailGatewayUnreadableResponse {
  /** The UID the response named, or absent when it named none legibly. */
  readonly uid?: number;
  readonly detail: string;
}

export interface EmailGatewayListResult {
  readonly messages: readonly EmailGatewayMessageSummary[];
  /** Matches BEFORE `limit` truncation, so a caller can tell there is more. */
  readonly total: number;
  /**
   * Answers on THIS page the daemon could not read. Absent when there were
   * none.
   *
   * Without it a short page is silent, and a caller reading `messages` against
   * `total` cannot tell "that message was deleted between the search and the
   * fetch" from "that message is in the mailbox and we could not read what the
   * server said about it". The first is ordinary; the second means the owner
   * is looking at a list that is missing mail and reading it as complete.
   */
  readonly unreadable?: readonly EmailGatewayUnreadableResponse[];
}

export interface EmailGatewayDraftInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | undefined;
  readonly references?: string | undefined;
}

export interface EmailGatewayDraftResult {
  /** The draft's Message-ID. Always present. */
  readonly draftId: string;
  /**
   * The APPENDUID the server assigned, when it advertises UIDPLUS. Absent
   * otherwise, a server that does not report one has not given us a uid, and
   * inventing a number a later fetch would not resolve is worse than saying so.
   */
  readonly uid?: number;
  /** The Drafts folder the message actually landed in. */
  readonly mailbox: string;
}

export interface EmailGatewaySendInput {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly inReplyTo?: string | undefined;
  /** The caller's id for this send; a repeat with the same id returns the first answer. */
  readonly clientSendId?: string | undefined;
}

export type EmailGatewayMessageAction = 'seen' | 'unseen' | 'archive' | 'delete';

export interface EmailGatewayMessageUpdate {
  readonly uid: number;
  readonly action: EmailGatewayMessageAction;
  /** The mailbox generation the UID was listed under, when the caller has it. */
  readonly uidValidity?: number | undefined;
}

export interface EmailGatewayMessageUpdateResult {
  readonly uid: number;
  readonly action: EmailGatewayMessageAction;
  /** The folder an archived or deleted message now lives in. */
  readonly movedTo?: string;
}

export interface EmailGatewayAttachmentContent {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly contentBase64: string;
}

export interface EmailGatewayDraftSummary {
  readonly uid: number;
  readonly to: string;
  readonly subject: string;
  readonly date: string;
  readonly inReplyTo: string;
  readonly body: string;
}

export interface EmailGatewayDraftList {
  readonly drafts: readonly EmailGatewayDraftSummary[];
  readonly total: number;
  readonly mailbox: string;
}

export interface EmailGatewaySendResult {
  readonly messageId: string;
  readonly sentAt: string;
}

/**
 * What a mail backend must be able to do to serve these verbs.
 *
 * Failures are reported by throwing `GatewayVerbError` with an honest status:
 * an unconfigured account is a 400 naming what to configure, a rejected
 * credential a 401, an unknown uid a 404.
 */
export interface EmailGatewayService {
  listInbox(input: EmailGatewayListInput): Promise<EmailGatewayListResult>;
  readMessage(uid: number): Promise<EmailGatewayMessageDetail | null>;
  createDraft(input: EmailGatewayDraftInput): Promise<EmailGatewayDraftResult>;
  send(input: EmailGatewaySendInput): Promise<EmailGatewaySendResult>;
  /**
   * Senders of messages this process read whose receiving server authenticated
   * the sender, for the message with this Message-ID. Delivery evidence, never
   * a header the correspondent wrote. Absent or empty: no reply exemption.
   */
  replyEnvelopeSenders?(inReplyTo: string): readonly string[];
  /** Mark read or unread, archive, or move to Trash; absent on a backend that cannot write. */
  updateMessage?(input: EmailGatewayMessageUpdate): Promise<EmailGatewayMessageUpdateResult>;
  /** One attachment's bytes by its position in the read's attachment list; null when the message is gone. */
  readAttachment?(uid: number, index: number): Promise<EmailGatewayAttachmentContent | null>;
  /** The newest drafts in the Drafts folder, each with its body. */
  listDrafts?(limit: number): Promise<EmailGatewayDraftList>;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * A uid is an IMAP UID: a positive integer. A caller that sends `"12"` gets
 * the same answer as one that sends `12`, but `"latest"` is refused rather
 * than coerced to `NaN` and then to some arbitrary message.
 */
function readUid(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    throw new GatewayVerbError('uid (a positive integer IMAP UID) is required', 'INVALID_ARGUMENT', 400, 'uid');
  }
  return parsed;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function readOptionalCount(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return undefined;
  return Math.max(1, Math.trunc(parsed));
}

/** Reads the daemon's own inbox mirror for the listed UIDs (`channels.inbox.list` with `uids`). */
export type EmailTriageLabelReader = (uids: readonly number[]) => Promise<ReadonlyMap<number, NonNullable<EmailGatewayMessageSummary['triageLabel']>>>;

/**
 * The triage labels of these UIDs from the daemon's inbox mirror, in process:
 * one indexed lookup of exactly the listed rows, no feed read and no second
 * request from the client. Best effort: no mirror, or one that cannot be read
 * now, leaves the list unlabelled.
 */
export function catalogTriageLabelReader(catalog: GatewayMethodCatalog): EmailTriageLabelReader {
  return async (uids) => {
    const labels = new Map<number, NonNullable<EmailGatewayMessageSummary['triageLabel']>>();
    if (uids.length === 0 || !catalog.hasHandler('channels.inbox.list')) return labels;
    try {
      const mirror = await catalog.invoke('channels.inbox.list', { body: { provider: 'email', uids: [...uids] }, context: {} }) as {
        readonly items?: readonly { readonly id?: unknown; readonly triageLabel?: unknown }[];
      };
      for (const item of mirror.items ?? []) {
        if (typeof item.id !== 'string') continue;
        const uid = Number(item.id.slice(item.id.lastIndexOf(':') + 1));
        const label = item.triageLabel;
        if (Number.isSafeInteger(uid) && (label === 'spam' || label === 'priority' || label === 'normal')) labels.set(uid, label);
      }
    } catch { /* No mirror now: the list is shown unlabelled. */ }
    return labels;
  };
}

export function createEmailInboxListHandler(service: EmailGatewayService, triageLabels?: EmailTriageLabelReader): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const result = await service.listInbox({
      limit: readOptionalCount(params.limit),
      since: readOptionalString(params.since),
      unreadOnly: readOptionalBoolean(params.unreadOnly),
      ...(params.before === undefined ? {} : { before: readUid(params.before) }),
    });
    if (!triageLabels || result.messages.length === 0) return result;
    const labels = await triageLabels(result.messages.map((message) => message.uid));
    if (labels.size === 0) return result;
    return {
      ...result,
      messages: result.messages.map((message) => {
        const triageLabel = labels.get(message.uid);
        return triageLabel === undefined ? message : { ...message, triageLabel };
      }),
    };
  };
}

export function createEmailInboxReadHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const uid = readUid(readInvocationParams(invocation).uid);
    const message = await service.readMessage(uid);
    if (message === null) {
      // A uid that no longer resolves is a gone message, not a broken server.
      throw new GatewayVerbError(
        `No message with UID ${String(uid)} is in the mailbox. It may have been moved or deleted since it was listed.`,
        'NOT_FOUND',
        404,
      );
    }
    return message;
  };
}

const MESSAGE_ACTIONS: readonly EmailGatewayMessageAction[] = ['seen', 'unseen', 'archive', 'delete'];

function unsupported(verb: string): never {
  throw new GatewayVerbError(`This daemon's mail backend does not support ${verb}.`, 'NOT_IMPLEMENTED', 501);
}

export function createEmailInboxUpdateHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const uid = readUid(params.uid);
    const action = params.action;
    if (typeof action !== 'string' || !(MESSAGE_ACTIONS as readonly string[]).includes(action)) {
      throw new GatewayVerbError(`action must be one of ${MESSAGE_ACTIONS.join(', ')}`, 'INVALID_ARGUMENT', 400, 'action');
    }
    refuseNonUserRequest(invocation, 'email.inbox.update');
    if (!service.updateMessage) return unsupported('changing a message');
    return service.updateMessage({
      uid,
      action: action as EmailGatewayMessageAction,
      ...(params.uidValidity === undefined ? {} : { uidValidity: readUid(params.uidValidity) }),
    });
  };
}

export function createEmailAttachmentGetHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const uid = readUid(params.uid);
    const index = typeof params.index === 'string' ? Number(params.index) : params.index;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      throw new GatewayVerbError('index (the attachment\'s position, from 0) is required', 'INVALID_ARGUMENT', 400, 'index');
    }
    if (!service.readAttachment) return unsupported('attachment downloads');
    const attachment = await service.readAttachment(uid, index);
    if (attachment === null) {
      throw new GatewayVerbError(
        `No message with UID ${String(uid)} is in the mailbox. It may have been moved or deleted since it was listed.`,
        'NOT_FOUND',
        404,
      );
    }
    return attachment;
  };
}

export function createEmailDraftsListHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    if (!service.listDrafts) return unsupported('listing drafts');
    return service.listDrafts(Math.min(100, readOptionalCount(params.limit) ?? 25));
  };
}

export function createEmailDraftCreateHandler(service: EmailGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    return service.createDraft({
      to: requireStringValue(params.to, 'to'),
      subject: requireStringValue(params.subject, 'subject'),
      body: requireStringValue(params.body, 'body'),
      inReplyTo: readOptionalString(params.inReplyTo),
      references: readOptionalString(params.references),
    });
  };
}

/**
 * Why a send DISCLOSES its untrusted exposure rather than refusing on it.
 *
 * The daemon's browser verbs and its mail verbs record into one ledger (see
 * routes/browser-composition.ts), so "read a page, then send mail" is one
 * composition rather than two unrelated acts. In the agent, that composition
 * is REFUSED: an owner turn has a start, so exposure has a scope, and the
 * refusal's fix, take it to the owner, has someone to take it to.
 *
 * An unattended daemon has neither. Nothing marks a turn boundary, so a single
 * page read would silently disable outbound mail for the life of the process;
 * and "ask the owner" is not available to a job running at 3am, which is the
 * work this capability exists for. Refusing here would break the exact
 * scheduled-work path the browser and mail verbs were served for.
 *
 * So the daemon reports instead of hiding: every send made while the ledger
 * holds untrusted exposure carries the origins that produced it and the
 * standing rule, on the send receipt, where a reader and an audit both see it.
 * The engine's own refusals are untouched, a page this daemon read still
 * cannot cause a form submission, which is the effect page content can reach
 * on its own.
 */
function untrustedExposureDisclosure(ledger: UntrustedContentLedger): Record<string, unknown> {
  const origins = ledger.originsThisTurn();
  if (origins.length === 0) return {};
  return {
    untrustedContent: {
      originsInScope: [...origins],
      rule: UNTRUSTED_CONTENT_RULE,
      note: 'This process has read content from these sources. The send passed the derivation check, none of its recipient, subject or body repeats what was read, and the provenance travels with the receipt so a reader can still weigh it.',
    },
  };
}

/**
 * Refuse a send whose content derives from something a stranger wrote.
 *
 * The daemon used to only DISCLOSE this, on the reasoning that an unattended
 * process has nobody to take a refusal to. That is backwards for this threat:
 * a disclosure is a note in a receipt nobody reads, on the one surface with no
 * human watching, and an unattended daemon is precisely where a prompt
 * injection pays off. The daemon is the STRICTEST surface now, not the most
 * permissive.
 *
 * The check is on derivation, not exposure, which is what makes strictness
 * affordable: a scheduled report that queries a database and mails a summary
 * derives from nothing anyone wrote at it and proceeds. Disclosure is kept for
 * the sends that do proceed, it stops being the only protection.
 */
async function refuseTaintedSend(
  ledger: UntrustedContentLedger,
  fields: Readonly<Record<string, string | undefined>>,
  description: string,
  replyToEnvelopeSenders: readonly string[] = [],
  ownerAddresses: ReadonlySet<string> = new Set(),
  nextStep?: string,
): Promise<void> {
  // The one exemption: a send whose EVERY recipient is the owner alone.
  //
  // The owner is the trust root, not a third party, and telling them what
  // arrived is the point of an assistant reading their mail. "What came in
  // overnight" is a summary that necessarily reuses the words of what came in,
  // so without this the feature is refused in its most ordinary use.
  //
  // Deliberately narrow: the owner's configured addresses only, not a domain,
  // not a pattern, and not partial. A send to the owner AND anyone else is not
  // exempt, because naming them first and slipping a second recipient in
  // beside them is exactly how this would be abused. Identity comes from configuration
  // and never from anything a message can influence; see
  // security/owner-identity.ts for what an attacker would have to control.
  //
  // Note what is NOT exempted: link validation, the confirmation gate, and the
  // explicit-user-request rule all still apply to a send to the owner.
  if (isSendToOwnerOnly(fields.to, ownerAddresses)) return;
  const decision = await evaluateOutwardEffect({
    request: { toolName: 'email', action: 'email.send', description },
    ledger,
    content: fields,
    taintOptions: {
      // The recipient is where the mail GOES; its verbatim presence in what
      // was read is a finding on its own, before any derivation reading.
      exactMatchFields: ['to'],
      // …with one exemption: replying to where a message actually came from,
      // established from delivery evidence rather than a From: header.
      replyToEnvelopeSenders,
      // A reply quoting what it answers repeats it by design; the reading
      // leaves the quoted copy out.
      stripQuotedFields: ['body'],
    },
  });
  if (decision.allowed) return;
  throw new GatewayVerbError(
    [decision.reason ?? 'Refused.', decision.fix ?? '', nextStep ?? ''].filter((part) => part.length > 0).join(' '),
    'UNTRUSTED_CONTENT_DERIVED',
    403,
  );
}

/** The owner's addresses, or a function that reads them fresh at each send. */
export type OwnerAddressSource = ReadonlySet<string> | (() => ReadonlySet<string>);

export function createEmailSendHandler(
  service: EmailGatewayService,
  /**
   * The ledger the daemon's page reads and mailbox reads both record into.
   * Defaults to the process-wide one, which is what production wants; tests
   * pass their own so one case's page read cannot colour the next case's send.
   */
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
  /**
   * The owner's own addresses, from configuration. Empty disables the
   * owner-destination exemption rather than widening it, see
   * security/owner-identity.ts.
   */
  ownerAddresses: OwnerAddressSource = new Set(),
): GatewayMethodHandler {
  const recent = new Map<string, { readonly fingerprint: string; readonly at: number; readonly result: Promise<unknown> }>();
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    if (params.confirm !== true) {
      throw new GatewayVerbError(
        'email.send puts a message on the internet and cannot be recalled. Re-issue with confirm: true once the recipients and body have been reviewed.',
        'CONFIRMATION_REQUIRED',
        400,
        'confirm',
      );
    }
    refuseNonUserRequest(invocation, 'email.send');
    const to = requireStringValue(params.to, 'to');
    const subject = requireStringValue(params.subject, 'subject');
    const body = requireStringValue(params.body, 'body');
    const inReplyTo = readOptionalString(params.inReplyTo);
    const clientSendId = readClientSendId(params.clientSendId);
    if (clientSendId !== undefined) {
      const now = Date.now();
      for (const [id, entry] of recent) if (now - entry.at > SEND_ID_RETENTION_MS) recent.delete(id);
      const fingerprint = JSON.stringify([to, subject, body, inReplyTo ?? '']);
      const earlier = recent.get(clientSendId);
      if (earlier) {
        if (earlier.fingerprint !== fingerprint) {
          throw new GatewayVerbError(
            'This clientSendId was already used for a different message, so nothing was sent. Use a new id for a new message.',
            'CLIENT_SEND_ID_REUSED', 409, 'clientSendId');
        }
        return earlier.result;
      }
      const result = sendOnce(to, subject, body, inReplyTo, clientSendId);
      recent.set(clientSendId, { fingerprint, at: now, result });
      if (recent.size > SEND_ID_CAPACITY) recent.delete(recent.keys().next().value!);
      // A refusal or a failure before the server took the message frees the id
      // for another try; an unconfirmed delivery keeps it, so a repeat answers
      // "unconfirmed" again instead of mailing the recipients a second time.
      result.catch((error: unknown) => {
        if (!(error instanceof GatewayVerbError && error.code === 'EMAIL_DELIVERY_UNCONFIRMED')
          && recent.get(clientSendId)?.result === result) recent.delete(clientSendId);
      });
      return result;
    }
    return sendOnce(to, subject, body, inReplyTo, undefined);
  };

  async function sendOnce(to: string, subject: string, body: string, inReplyTo: string | undefined, clientSendId: string | undefined): Promise<unknown> {
    // Before anything leaves the machine: does what is about to leave derive
    // from what was read? Recipient included, a redirected reply is as much
    // an injection outcome as a rewritten body.
    const replySenders = inReplyTo === undefined ? [] : [...(service.replyEnvelopeSenders?.(inReplyTo) ?? [])];
    await refuseTaintedSend(
      ledger,
      { to, subject, body },
      `sending mail to ${to}`,
      replySenders,
      typeof ownerAddresses === 'function' ? ownerAddresses() : ownerAddresses,
      // The read evidence is kept in memory, so a daemon restart empties it: a
      // reply refused for want of it is answered by reading the message again.
      inReplyTo !== undefined && replySenders.length === 0
        ? 'No verified read of that message in this run; read it again with email.inbox.read, then send the reply.'
        : undefined,
    );
    const sent = await service.send({
      to,
      subject,
      body,
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      ...(clientSendId === undefined ? {} : { clientSendId }),
    });
    return { ...sent, ...untrustedExposureDisclosure(ledger) };
  }
}

/** How long a send's answer is kept for a repeat with the same `clientSendId`. */
const SEND_ID_RETENTION_MS = 10 * 60_000;
const SEND_ID_CAPACITY = 512;
const CLIENT_SEND_ID = /^[A-Za-z0-9_-]{8,128}$/;

function readClientSendId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !CLIENT_SEND_ID.test(value)) {
    throw new GatewayVerbError('clientSendId must be 8 to 128 letters, digits, hyphens or underscores', 'INVALID_ARGUMENT', 400, 'clientSendId');
  }
  return value;
}

/** Attach the email handlers to their registered descriptors (missing = no-op). */
export function registerEmailGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: EmailGatewayService,
  ledger: UntrustedContentLedger = getProcessUntrustedContentLedger(),
  /** See createEmailSendHandler. Empty means the exemption cannot fire. */
  ownerAddresses: OwnerAddressSource = new Set(),
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('email.inbox.list', createEmailInboxListHandler(service, catalogTriageLabelReader(catalog)));
  attach('email.inbox.read', createEmailInboxReadHandler(service));
  attach('email.inbox.update', createEmailInboxUpdateHandler(service));
  attach('email.attachment.get', createEmailAttachmentGetHandler(service));
  attach('email.drafts.list', createEmailDraftsListHandler(service));
  attach('email.draft.create', createEmailDraftCreateHandler(service));
  attach('email.send', createEmailSendHandler(service, ledger, ownerAddresses));
}
