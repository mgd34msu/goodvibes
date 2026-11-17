/** Exact, bounded whole-source acquisition. No partial result is screenable. */
import { attachmentsFromParts } from './imap-bodystructure.js';
import {
  COMPLETE_MESSAGE_HEADER_BYTES,
  COMPLETE_MESSAGE_SOURCE_BYTES,
  COMPLETE_MESSAGE_STRUCTURE_BYTES,
  decodeCompleteTextPart,
  parseCompleteBodyStructure,
} from './imap-bodystructure-complete.js';
import { completeFetchBodyStructure, completeFetchSection, parseImapDateTime } from './imap-fetch-complete.js';
import {
  extractAuthenticationResults,
  extractDeliveryEvidence,
  extractDisplayHeader,
  extractHeader,
} from './imap-headers.js';
import type { ImapSession } from './imap-session.js';
import type { ImapCompleteMessageRead, ImapCompleteTextSection, ImapMessageDetail } from './imap-types.js';
import { MAX_IMAP_UID } from './inbound/source-cursor.js';

/**
 * Why a message's own bytes cannot be shown here. Reading it again returns
 * the same answer, so a reader steps over it instead of waiting on it.
 */
export type CompleteMessageUnreadableReason =
  | 'invalid-uid'
  | 'headers-incomplete'
  | 'bodystructure-incomplete-or-unsupported'
  | 'text-section-incomplete-or-unsupported'
  | 'complete-source-too-large';

/**
 * The strict read's answer, with the distinction a caller needs carried on it
 * rather than re-derived from the reason string: `fromMessage` is true when the
 * message itself is the cause (step over it), false when the command failed
 * (try again). `senderDomain` is the claimed From domain when the headers were
 * readable enough to name one, for telling the owner which message it was.
 */
export type CompleteMessageRead =
  | Exclude<ImapCompleteMessageRead, { readonly outcome: 'incomplete' }>
  | { readonly outcome: 'incomplete'; readonly reason: CompleteMessageUnreadableReason; readonly fromMessage: true; readonly senderDomain?: string }
  | { readonly outcome: 'incomplete'; readonly reason: 'source-fetch-failed'; readonly fromMessage: false };

const unreadable = (reason: CompleteMessageUnreadableReason, rawHeaders?: string | null): CompleteMessageRead => {
  const domain = rawHeaders ? claimedSenderDomain(rawHeaders) : '';
  return Object.freeze({ outcome: 'incomplete', reason, fromMessage: true, ...(domain ? { senderDomain: domain } : {}) });
};

/** The claimed sender's domain, only when it is plainly a hostname. Never the local part or the name. */
function claimedSenderDomain(rawHeaders: string): string {
  const from = extractHeader(rawHeaders, 'From');
  const address = /<([^<>]*)>\s*$/.exec(from)?.[1] ?? from;
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase();
  return address.includes('@') && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/.test(domain)
    && domain.length <= 253 ? domain : '';
}

/** Raw source is retained, not reconstructed from the clipped display parser. */
function completeHeaders(raw: string): boolean {
  if (!raw.endsWith('\r\n\r\n') || /\ufffd|\u0000/.test(raw)
    || Buffer.byteLength(raw, 'utf8') > COMPLETE_MESSAGE_HEADER_BYTES) return false;
  const lines = raw.slice(0, -4).split('\r\n');
  let field = false;
  for (const line of lines) {
    if (/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) return false;
    if (/^[ \t]/.test(line)) { if (!field) return false; continue; }
    if (!/^[\x21-\x39\x3b-\x7e]+:/.test(line)) return false;
    field = true;
  }
  return field;
}

function detailFor(uid: number, mailbox: string, rawHeaders: string,
  textSections: readonly ImapCompleteTextSection[],
  attachments: ImapMessageDetail['attachments'], arrivedAt: number | undefined): ImapMessageDetail {
  const deliveryEvidence = Object.freeze(extractDeliveryEvidence(rawHeaders).map(entry => Object.freeze(entry)));
  return Object.freeze({
    uid, mailbox,
    ...(arrivedAt === undefined ? {} : { arrivedAt }),
    from: extractDisplayHeader(rawHeaders, 'From'),
    subject: extractDisplayHeader(rawHeaders, 'Subject'),
    date: extractHeader(rawHeaders, 'Date'),
    messageId: extractHeader(rawHeaders, 'Message-ID'),
    deliveredTo: Object.freeze(deliveryEvidence.map(entry => entry.address)),
    deliveryEvidence,
    unverifiedToHeaderClaim: extractDisplayHeader(rawHeaders, 'To'),
    authenticationResults: Object.freeze(extractAuthenticationResults(rawHeaders)),
    bodyText: (textSections.find(part => part.contentType === 'text/plain')?.text ?? '').replace(/\r\n/g, '\n'),
    bodyHtml: (textSections.find(part => part.contentType === 'text/html')?.text ?? '').replace(/\r\n/g, '\n'),
    attachments: Object.freeze(attachments.map(attachment => Object.freeze(attachment))),
  });
}

/**
 * A command must prove exact UID, full section, complete syntax and encoding.
 * Every inline text part is read. Attachment bytes are never fetched. A message
 * whose own bytes cannot be shown and a command that failed are both explicit
 * incomplete outcomes, told apart by `fromMessage`, without leaking sender text
 * beyond a plain claimed domain.
 */
export async function readCompleteMessageDetail(session: ImapSession, uid: number,
  mailbox: string): Promise<CompleteMessageRead> {
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > MAX_IMAP_UID) return unreadable('invalid-uid');
  try {
    const headerFrames = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[HEADER]`,
      { maxResponseBytes: COMPLETE_MESSAGE_HEADER_BYTES + 4_096 });
    if (headerFrames.length === 1 && headerFrames[0]?.literal === undefined
      && /^\S+ OK\b/.test(headerFrames[0]?.syntax ?? '')) return Object.freeze({ outcome: 'gone' });
    const rawHeaders = completeFetchSection(headerFrames, uid, 'HEADER');
    // No header section in the answer is the server's failure to answer; a
    // header block that is there and unreadable is the message's own bytes.
    if (rawHeaders === null) return Object.freeze({ outcome: 'incomplete', reason: 'source-fetch-failed', fromMessage: false });
    if (!completeHeaders(rawHeaders)) return unreadable('headers-incomplete', rawHeaders);

    // The arrival time rides on the structure read: the sender writes the Date header, the server writes INTERNALDATE.
    const structureFrames = await session.commandFrames(`UID FETCH ${uid} (INTERNALDATE BODYSTRUCTURE)`,
      { maxResponseBytes: COMPLETE_MESSAGE_STRUCTURE_BYTES + 4_096 });
    const fetched = completeFetchBodyStructure(structureFrames, uid);
    const structure = fetched?.structure ?? null;
    const parts = structure === null ? null : parseCompleteBodyStructure(structure);
    if (parts === null || structure === null) return unreadable('bodystructure-incomplete-or-unsupported', rawHeaders);
    const arrivedAt = fetched?.internalDate === undefined ? undefined : parseImapDateTime(fetched.internalDate);
    const textSections: ImapCompleteTextSection[] = [];
    let sourceBytes = Buffer.byteLength(rawHeaders, 'utf8') + Buffer.byteLength(structure, 'utf8');
    for (const part of parts) {
      if (part.isAttachment) continue;
      const frames = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[${part.section}]`,
        { maxResponseBytes: part.sizeBytes + 4_096 });
      const raw = completeFetchSection(frames, uid, part.section);
      // A section the server did not return is a failed command; one it
      // returned that cannot be decoded exactly is the message's own bytes.
      if (raw === null) return Object.freeze({ outcome: 'incomplete', reason: 'source-fetch-failed', fromMessage: false });
      const text = decodeCompleteTextPart(raw, part);
      if (text === null) return unreadable('text-section-incomplete-or-unsupported', rawHeaders);
      sourceBytes += Buffer.byteLength(text, 'utf8');
      if (sourceBytes > COMPLETE_MESSAGE_SOURCE_BYTES) return unreadable('complete-source-too-large', rawHeaders);
      textSections.push(Object.freeze({ section: part.section,
        contentType: part.subtype === 'html' ? 'text/html' : 'text/plain', text }));
    }
    const frozenSections = Object.freeze(textSections);
    return Object.freeze({ outcome: 'complete', rawHeaders, rawBodyStructure: structure, textSections: frozenSections,
      detail: detailFor(uid, mailbox, rawHeaders, frozenSections, attachmentsFromParts(parts), arrivedAt) });
  } catch {
    return Object.freeze({ outcome: 'incomplete', reason: 'source-fetch-failed', fromMessage: false });
  }
}
