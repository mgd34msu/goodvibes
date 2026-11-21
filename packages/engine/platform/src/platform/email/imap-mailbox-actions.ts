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
import { decodeTextPart, extractBodyStructure, extractFetchSection, extractFetchSectionBytes, parseBodyStructure } from './imap-bodystructure.js';
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
    // A message already marked \Deleted may be the half of an earlier archive
    // or delete that stopped after COPY: finish that one instead of copying again.
    if (await carriesDeletedFlag(session, uid)) {
      await finishInterruptedMove(session, mailbox, selected.uidValidity, uid, target);
      return { uid, action, movedTo: target };
    }
    await session.command(`UID COPY ${uid} ${formatMailboxName(target)}`);
    let marked = false;
    try {
      await session.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
      marked = true;
      await session.command(`UID EXPUNGE ${uid}`);
    } catch {
      throw new Error(`The message was copied to '${target}' but is still in '${mailbox}'${marked ? ' (marked deleted)' : ''}, so delete the original in your mail program instead of repeating the action.`);
    }
  }
  return { uid, action, movedTo: target };
}

/** Whether the message's FLAGS carry `\Deleted` (one UID FETCH FLAGS). */
async function carriesDeletedFlag(session: ImapSession, uid: number): Promise<boolean> {
  const lines = await session.command(`UID FETCH ${uid} FLAGS`);
  const flags = lines.map((line) => /^\* \d+ FETCH .*?\bFLAGS \(([^)]*)\)/i.exec(line)?.[1]).find((value) => value !== undefined);
  return flags !== undefined && flags.split(/\s+/).some((flag) => flag.toLowerCase() === '\\deleted');
}

/**
 * Complete an archive or delete that copied the message and marked it deleted
 * but did not expunge it: when the target folder holds a message with the same
 * Message-ID, only the original is expunged. A \Deleted mark another program
 * set, with no copy in the target, is refused with nothing changed, so a
 * message is never expunged without its copy.
 */
async function finishInterruptedMove(session: ImapSession, mailbox: string, uidValidity: number | null, uid: number, target: string): Promise<void> {
  const header = parseFetchResponses(await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]`))
    .map((response) => fetchSection(response, (spec) => spec.startsWith('HEADER.FIELDS')))
    .find((section) => section !== undefined && section !== null);
  const messageId = /^Message-ID:\s*(<[^<>"\\\r\n]+>)/im.exec((header ?? '').replace(/\r?\n[ \t]+/g, ' '))?.[1];
  let copied = false;
  if (messageId !== undefined) {
    await session.command(`EXAMINE ${formatMailboxName(target)}`);
    copied = parseSearchNumbers(await session.command(`UID SEARCH HEADER Message-ID "${messageId}"`)).length > 0;
    const reselected = parseMailboxStatus(await session.command(`SELECT ${formatMailboxName(mailbox)}`));
    if (reselected.uidValidity !== uidValidity) {
      throw new Error(`The mailbox '${mailbox}' was reset while this message was being changed, so nothing more was changed. Refresh the list and try again.`);
    }
  }
  if (!copied) {
    throw new Error(`Message ${uid} is already marked deleted in '${mailbox}' and no copy of it is in '${target}', so nothing was changed. Clear the deleted mark or remove it in your mail program.`);
  }
  await session.command(`UID EXPUNGE ${uid}`);
}

/**
 * The bytes of the attachment at `index` in the message's attachment list (the
 * order `email.inbox.read` reports). Read with BODY.PEEK, so it stays unread.
 */
export async function fetchImapAttachment(session: ImapSession, uid: number, index: number): Promise<ImapAttachmentContent | null> {
  requireUid(uid);
  const structure = await session.commandFrames(`UID FETCH ${uid} BODYSTRUCTURE`);
  if (parseFetchResponses(structure).length === 0) return null;
  const parts = parseBodyStructure(extractBodyStructure(structure));
  // An answer whose structure could not be read says nothing about the
  // attachments, and is not reported as a message that has none.
  if (parts.length === 0) {
    throw new Error(`The mail server's description of message ${uid} could not be read, so its attachments cannot be handed over. Open it in your mail program.`);
  }
  const attachments = parts.filter((part) => part.isAttachment);
  const part = attachments[index];
  if (!part) throw new Error(`Message ${uid} has ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}; there is none at position ${index + 1}.`);
  if (part.sizeBytes > IMAP_ATTACHMENT_LITERAL_BYTES) {
    throw new Error(`The attachment ${part.filename || `#${index + 1}`} is larger than ${IMAP_ATTACHMENT_MAX_BYTES / 1_048_576} MB and is not handed over here. Open it in your mail program.`);
  }
  // Taken as octets: an 8bit or binary part is copied byte for byte, base64
  // and quoted-printable are decoded from the bytes, never from UTF-8 text.
  const octets = extractFetchSectionBytes(await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[${part.section}]`, {
    maxResponseBytes: IMAP_ATTACHMENT_LITERAL_BYTES + 4_096,
  }));
  if (octets === null) {
    throw new Error(`The mail server sent no content for the attachment ${part.filename || `#${index + 1}`}; nothing was handed over. Open it in your mail program.`);
  }
  const raw = Buffer.from(octets.buffer, octets.byteOffset, octets.byteLength);
  const bytes = part.encoding === 'base64'
    ? Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
    : part.encoding === 'quoted-printable'
      ? Buffer.from(raw.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1')
      : Buffer.from(raw);
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
/** The newest draft in `mailbox` saved under `messageId` (one EXAMINE and one UID SEARCH), or null when there is none. */
export async function findImapDraftByMessageId(session: ImapSession, mailbox: string, messageId: string): Promise<{ readonly uid: number; readonly uidValidity: number | null } | null> {
  const examined = parseMailboxStatus(await session.command(`EXAMINE ${formatMailboxName(mailbox)}`));
  const uid = await findSelectedDraftByMessageId(session, messageId);
  return uid === null ? null : { uid, uidValidity: examined.uidValidity };
}

/**
 * The newest message saved under `messageId` in the mailbox already selected
 * (one UID SEARCH, the selection is kept), other than `except`, or null.
 */
export async function findSelectedDraftByMessageId(session: ImapSession, messageId: string, except?: number): Promise<number | null> {
  const uids = parseSearchNumbers(await session.command(`UID SEARCH HEADER Message-ID "${messageId}"`));
  return uids.filter((uid) => uid !== except).at(-1) ?? null;
}

export async function listImapDrafts(session: ImapSession, mailbox: string, limit: number, before?: number): Promise<{ drafts: ImapDraftSummary[]; total: number; uidValidity: number | null }> {
  const examined = parseMailboxStatus(await session.command(`EXAMINE ${formatMailboxName(mailbox)}`));
  const uidValidity = examined.uidValidity;
  const uids = parseSearchNumbers(await session.command('UID SEARCH ALL'));
  // `before`: the page of drafts older than that UID, so every draft in the folder is reachable a page at a time.
  const older = before === undefined ? uids : uids.filter((uid) => uid < before);
  const page = older.slice(-Math.max(1, Math.min(limit, 100)));
  if (page.length === 0) return { drafts: [], total: uids.length, uidValidity };
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
  return { drafts, total: uids.length, uidValidity };
}

/**
 * Before a saved draft is replaced: the Drafts folder SELECTed read-write, its
 * UIDVALIDITY the one the draft was listed under, the draft still there, and
 * a way to remove that one message alone (UIDPLUS's UID EXPUNGE; a replaced
 * draft is not moved to Trash, it is superseded). Refuses with nothing
 * changed otherwise.
 */
export async function prepareDraftReplacement(
  session: ImapSession,
  mailbox: string,
  uid: number,
  uidValidity: number,
  capabilities: readonly string[],
): Promise<void> {
  requireUid(uid);
  if (!capabilities.map((capability) => capability.toUpperCase()).includes('UIDPLUS')) {
    throw new Error('This mail server cannot remove one message by UID (it does not offer UIDPLUS), so the saved draft cannot be replaced. Nothing was changed; save it as a new draft and delete the old one in your mail program.');
  }
  const selected = parseMailboxStatus(await session.command(`SELECT ${formatMailboxName(mailbox)}`));
  if (selected.uidValidity !== uidValidity) {
    throw new Error(`The drafts folder '${mailbox}' was reset since this draft was listed, so nothing was changed. List the drafts again and reopen it.`);
  }
  const exists = parseSearchNumbers(await session.command(`UID SEARCH UID ${uid}`));
  if (!exists.includes(uid)) throw new Error(`Draft ${uid} is no longer in '${mailbox}', so nothing was changed. List the drafts again.`);
}

/** Remove the replaced draft, this UID only, after its replacement was appended. */
export async function removeReplacedDraft(session: ImapSession, uid: number): Promise<void> {
  requireUid(uid);
  await session.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
  await session.command(`UID EXPUNGE ${uid}`);
}
