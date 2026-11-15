/**
 * The mailbox writes and reads a listing only describes: mark a message read or
 * unread, archive it, delete it, hand over one attachment's bytes, and list the
 * Drafts folder.
 *
 * Every write names one UID and checks the mailbox generation (UIDVALIDITY) it
 * was listed under, so a reset mailbox never has the wrong message changed. A
 * delete moves the message to the folder the server marks `\Trash`; a server
 * with no such folder is refused rather than having the message expunged, so a
 * delete from here can always be undone in the account's own Trash.
 */
import type { ImapSession } from './imap-session.js';
import { formatMailboxName } from './imap-names.js';
import { parseMailboxList } from './imap-draft.js';
import { parseMailboxStatus, parseSearchNumbers, readEnvelopeBatch } from './imap-headers.js';
import { decodeTextPart, extractBodyStructure, extractFetchSection, parseBodyStructure } from './imap-bodystructure.js';
import { fetchSection, parseFetchResponses } from './imap-fetch-response.js';

export type ImapMessageAction = 'seen' | 'unseen' | 'archive' | 'delete';

export interface ImapMessageActionResult {
  readonly uid: number;
  readonly action: ImapMessageAction;
  /** The folder an archived or deleted message now lives in; absent for a flag change. */
  readonly movedTo?: string;
}

export interface ImapAttachmentContent {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly contentBase64: string;
}

export interface ImapDraftSummary {
  readonly uid: number;
  readonly to: string;
  readonly subject: string;
  readonly date: string;
  readonly inReplyTo: string;
  readonly body: string;
}

/** Decoded bytes a single attachment may carry when it is handed to a browser. */
export const IMAP_ATTACHMENT_MAX_BYTES = 25 * 1_048_576;
/** The literal a base64 attachment of that size arrives in, with line breaks. */
export const IMAP_ATTACHMENT_LITERAL_BYTES = Math.ceil(IMAP_ATTACHMENT_MAX_BYTES * 1.4);
const DRAFT_BODY_BYTES = 65_536;

function requireUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid < 1 || uid > 0xffffffff) throw new Error('A message UID is one positive integer.');
}

/** The folder the server marks with a special-use attribute (RFC 6154), or null. */
async function specialUseMailbox(session: ImapSession, attribute: '\\archive' | '\\trash' | '\\all'): Promise<string | null> {
  const entries = parseMailboxList(await session.commandFrames('LIST "" "*"'));
  return entries.find((entry) => entry.attributes.includes(attribute) && !entry.attributes.includes('\\noselect'))?.name ?? null;
}

/**
 * Change one message. SELECTs the mailbox read-write (the listing EXAMINEd it),
 * refuses when its UIDVALIDITY differs from `uidValidity`, and confirms a flag
 * change from the server's own FLAGS answer rather than from the OK, which a
 * server sends even for a UID that no longer exists.
 */
export async function applyImapMessageAction(
  session: ImapSession,
  mailbox: string,
  uid: number,
  uidValidity: number | null,
  action: ImapMessageAction,
  capabilities: readonly string[],
): Promise<ImapMessageActionResult> {
  requireUid(uid);
  const selected = parseMailboxStatus(await session.command(`SELECT ${formatMailboxName(mailbox)}`));
  if (uidValidity !== null && selected.uidValidity !== uidValidity) {
    throw new Error(`The mailbox '${mailbox}' was reset since this message was listed, so nothing was changed. Refresh the list and try again.`);
  }
  if (action === 'seen' || action === 'unseen') {
    const lines = await session.command(`UID STORE ${uid} ${action === 'seen' ? '+' : '-'}FLAGS (\\Seen)`);
    const flags = lines.map((line) => /^\* \d+ FETCH .*?\bFLAGS \(([^)]*)\)/i.exec(line)?.[1]).find((value) => value !== undefined);
    if (flags === undefined) throw new Error(`Message ${uid} is no longer in '${mailbox}', so it was not marked.`);
    const seen = flags.split(/\s+/).some((flag) => flag.toLowerCase() === '\\seen');
    if (seen !== (action === 'seen')) throw new Error(`The mail server did not mark message ${uid} ${action === 'seen' ? 'read' : 'unread'}.`);
    return { uid, action };
  }
  const exists = parseSearchNumbers(await session.command(`UID SEARCH UID ${uid}`));
  if (!exists.includes(uid)) throw new Error(`Message ${uid} is no longer in '${mailbox}', so nothing was changed.`);
  const target = action === 'archive'
    ? (await specialUseMailbox(session, '\\archive')) ?? (await specialUseMailbox(session, '\\all'))
    : await specialUseMailbox(session, '\\trash');
  if (target === null) {
    throw new Error(action === 'archive'
      ? 'This mail server marks no folder as Archive, so the message was not moved. Archive it in your mail program.'
      : 'This mail server marks no folder as Trash, so the message was not deleted (deleting here would be permanent). Delete it in your mail program.');
  }
  if (target === mailbox) throw new Error(`The message is already in '${target}'.`);
  const upper = capabilities.map((capability) => capability.toUpperCase());
  if (upper.includes('MOVE')) {
    await session.command(`UID MOVE ${uid} ${formatMailboxName(target)}`);
  } else {
    // COPY then remove only this UID; without UIDPLUS a plain EXPUNGE would
    // also remove every other message already flagged \Deleted.
    if (!upper.includes('UIDPLUS')) {
      throw new Error('This mail server can neither move a message nor expunge one message by UID, so nothing was changed.');
    }
    await session.command(`UID COPY ${uid} ${formatMailboxName(target)}`);
    await session.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    await session.command(`UID EXPUNGE ${uid}`);
  }
  return { uid, action, movedTo: target };
}

/**
 * The bytes of the attachment at `index` in the message's attachment list (the
 * order `email.inbox.read` reports). Read with BODY.PEEK, so it stays unread.
 */
export async function fetchImapAttachment(session: ImapSession, uid: number, index: number): Promise<ImapAttachmentContent | null> {
  requireUid(uid);
  const structure = await session.commandFrames(`UID FETCH ${uid} BODYSTRUCTURE`);
  if (parseFetchResponses(structure).length === 0) return null;
  const attachments = parseBodyStructure(extractBodyStructure(structure)).filter((part) => part.isAttachment);
  const part = attachments[index];
  if (!part) throw new Error(`Message ${uid} has ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}; there is none at position ${index + 1}.`);
  if (part.sizeBytes > IMAP_ATTACHMENT_LITERAL_BYTES) {
    throw new Error(`The attachment ${part.filename || `#${index + 1}`} is larger than ${IMAP_ATTACHMENT_MAX_BYTES / 1_048_576} MB and is not handed over here. Open it in your mail program.`);
  }
  const raw = extractFetchSection(await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[${part.section}]`, {
    maxResponseBytes: IMAP_ATTACHMENT_LITERAL_BYTES + 4_096,
  })) ?? '';
  const bytes = part.encoding === 'base64'
    ? Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
    : part.encoding === 'quoted-printable'
      ? Buffer.from(raw.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
      : Buffer.from(raw, 'utf8');
  return {
    filename: part.filename,
    contentType: part.type.length > 0 ? `${part.type}/${part.subtype}` : 'application/octet-stream',
    sizeBytes: bytes.length,
    contentBase64: bytes.toString('base64'),
  };
}

/**
 * The newest drafts in `mailbox` (the Drafts folder), newest first, each with
 * its recipient, subject, thread reference and up to 64 KB of body text, so a
 * draft can be opened in a composer without a second request.
 */
export async function listImapDrafts(session: ImapSession, mailbox: string, limit: number): Promise<{ drafts: ImapDraftSummary[]; total: number }> {
  await session.command(`EXAMINE ${formatMailboxName(mailbox)}`);
  const uids = parseSearchNumbers(await session.command('UID SEARCH ALL'));
  const page = uids.slice(-Math.max(1, Math.min(limit, 100)));
  if (page.length === 0) return { drafts: [], total: uids.length };
  const headers = await session.commandFrames(`UID FETCH ${page.join(',')} (UID BODY.PEEK[HEADER.FIELDS (TO SUBJECT DATE IN-REPLY-TO MESSAGE-ID FROM CONTENT-TYPE CONTENT-TRANSFER-ENCODING)])`);
  const batch = readEnvelopeBatch(headers, mailbox, page);
  const rawHeaders = new Map<number, string>();
  for (const response of parseFetchResponses(headers)) {
    const section = response.uid === null ? undefined : fetchSection(response, (spec) => spec.startsWith('HEADER.FIELDS'));
    if (response.uid !== null && section) rawHeaders.set(response.uid, section.replace(/\r?\n[ \t]+/g, ' '));
  }
  const header = (uid: number, name: string): string =>
    new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(rawHeaders.get(uid) ?? '')?.[1]?.trim() ?? '';
  const drafts: ImapDraftSummary[] = [];
  for (const envelope of [...batch.envelopes].reverse()) {
    let body = '';
    try {
      const text = await session.commandFrames(`UID FETCH ${envelope.uid} BODY.PEEK[TEXT]<0.${DRAFT_BODY_BYTES}>`);
      const charset = /charset="?([^";\s]+)/i.exec(header(envelope.uid, 'content-type'))?.[1] ?? 'utf-8';
      body = decodeTextPart(extractFetchSection(text) ?? '', header(envelope.uid, 'content-transfer-encoding').toLowerCase(), charset.toLowerCase());
    } catch { body = ''; }
    drafts.push({
      uid: envelope.uid,
      to: envelope.unverifiedToHeaderClaim,
      subject: envelope.subject,
      date: envelope.date,
      inReplyTo: header(envelope.uid, 'in-reply-to'),
      body,
    });
  }
  return { drafts, total: uids.length };
}
