/**
 * Writing one draft: header safety, message composition, Drafts discovery.
 *
 * Headers are built, not concatenated
 * ───────────────────────────────────
 * `appendDraft` turns caller-supplied strings into real RFC 5322 header lines.
 * A bare CR or LF anywhere in `to`, `from`, `subject`, `inReplyTo` or
 * `references` would end the header being written and start one the caller
 * chose, `Bcc:` being the one that matters, because a draft the owner later
 * sends would carry it. Every field is REFUSED rather than sanitized: silently
 * stripping the newline would send something the caller did not ask for, and a
 * caller that meant to inject learns nothing from a rejection but an attacker
 * whose payload was quietly trimmed learns which filter to try next.
 *
 * The address and subject checks are the SMTP module's own
 * (`validateSmtpAddress`, `validateSmtpSubject`), reused rather than restated
 * so that both ways of getting a message out of this module agree on what is
 * allowed.
 *
 * Finding the Drafts folder
 * ─────────────────────────
 * `"Drafts"` is a guess that is wrong on the most common mail host there is:
 * Gmail's is `[Gmail]/Drafts`, and appending to a literal `Drafts` there
 * creates a new stray folder instead. `selectDraftsMailbox` reads the LIST
 * reply and prefers the folder the server itself flagged `\Drafts`
 * (RFC 6154), which is the only answer that is right by construction.
 */

import type { JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { assertImapReadingCurrent, ImapReadingError, imapReadingLease, readImapDrafts, type ImapReadingLease } from './imap-readings.js';
import type { ImapFetchFrame } from './imap-fetch-response.js';
import type { ImapAppendDraftInput } from './imap-client.js';
import { validateSmtpAddress, validateSmtpSubject } from './smtp-client.js';
import { composePlainTextMessage } from './message-compose.js';

export { encodeHeaderValue, formatRfc5322Date } from './message-compose.js';

/**
 * The conventional folder name. The IMAP client never falls back to it: a server
 * that does not say which folder holds drafts is refused rather than guessed at,
 * so a draft is never appended to a stray `Drafts` folder.
 */
export const DEFAULT_DRAFTS_MAILBOX = 'Drafts';

// ---------------------------------------------------------------------------
// Header validation
// ---------------------------------------------------------------------------

/** CR, LF, and the other C0 and C1 control characters, same set as the SMTP side. */
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Validate a header value that is neither an address nor a subject,
 * `In-Reply-To` and `References`, both of which hold message ids.
 *
 * @throws Error with a plain-language message on invalid input.
 */
export function validateDraftHeaderValue(value: string, field: string): void {
  if (CONTROL_CHAR_RE.test(value)) {
    throw new Error(
      `Invalid ${field}: header values must not contain control characters (CR, LF, etc.).`,
    );
  }
}

/**
 * Refuse a draft whose fields would forge headers, before anything is sent.
 * Called by `appendDraft` ahead of any server conversation, and again by
 * `buildDraftMessage` so the composer is safe on its own.
 */
export function validateDraftInput(input: ImapAppendDraftInput): void {
  validateSmtpAddress(input.from, 'from');
  validateSmtpAddress(input.to, 'to');
  validateSmtpSubject(input.subject);
  if (input.inReplyTo !== undefined) {
    validateDraftHeaderValue(input.inReplyTo, 'inReplyTo');
  }
  if (input.references !== undefined) {
    validateDraftHeaderValue(input.references, 'references');
  }
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

/**
 * Compose the RFC 5322 message an APPEND uploads: the same bytes a send would
 * carry (`composePlainTextMessage`), so a draft and the mail sent from it
 * agree on the wire. The caller must count the literal in bytes: this string
 * is longer in bytes than in characters for any body that is not pure ASCII.
 *
 * No `Message-ID` is written. The message has not been sent, and the id that
 * matters is the one the sending path stamps at send time; a second one
 * invented here would never match it.
 *
 * @throws Error when any field would forge a header.
 */
export function buildDraftMessage(input: ImapAppendDraftInput, now: Date): string {
  validateDraftInput(input);
  return composePlainTextMessage(input, now).message;
}

// ---------------------------------------------------------------------------
// LIST reading: which folder is Drafts
// ---------------------------------------------------------------------------

interface MailboxEntry {
  readonly name: string;
  readonly attributes: readonly string[];
  readonly delimiter: string;
}

const LIST_LINE = /^\* (?:LIST|LSUB|XLIST) \(([^)]*)\)\s+(?:"((?:[^"\\]|\\.)*)"|NIL)\s+(.*)$/i;

function unquoteMailboxName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    let out = '';
    for (let i = 1; i < trimmed.length; i += 1) {
      const ch = trimmed.charAt(i);
      if (ch === '\\' && i + 1 < trimmed.length) {
        out += trimmed.charAt(i + 1);
        i += 1;
        continue;
      }
      if (ch === '"') break;
      out += ch;
    }
    return out;
  }
  // Atom form, or a literal the session already inlined; take the first token.
  return trimmed.split(/\s+/)[0] ?? '';
}

/** Parse the mailboxes out of a LIST reply. Unreadable lines are skipped. */
export function parseMailboxList(lines: readonly (string | ImapFetchFrame)[]): MailboxEntry[] {
  const entries: MailboxEntry[] = [];
  for (const frame of lines) {
    const line = typeof frame === 'string' ? frame : frame.syntax;
    const match = LIST_LINE.exec(line);
    if (match === null) continue;
    const name = typeof frame !== 'string' && frame.literal !== undefined
      ? frame.literal : unquoteMailboxName(match[3] ?? '');
    if (name.length === 0) continue;
    entries.push({
      name,
      attributes: (match[1] ?? '').split(/\s+/).filter((a) => a.length > 0).map((a) => a.toLowerCase()),
      delimiter: match[2] ?? '',
    });
  }
  return entries;
}

/** Server-declared \Drafts wins; otherwise read the selectable candidates, or none. */
export async function selectDraftsMailbox(lines: readonly string[], options: JudgmentReadingOptions = {}): Promise<string | null> {
  const selection = await selectDraftsMailboxFrames(lines, options);
  selection.assertCurrent();
  return selection.value;
}

/** Internal transport seam; deliberately not exported by the email public index. */
export async function selectDraftsMailboxFrames(lines: readonly (string | ImapFetchFrame)[], options: JudgmentReadingOptions = {}): Promise<ImapReadingLease<string | null>> {
  assertImapReadingCurrent(options);
  const entries = parseMailboxList(lines).filter(
    (entry) => !entry.attributes.includes('\\noselect'),
  );

  for (const entry of entries) {
    if (entry.attributes.includes('\\drafts')) return imapReadingLease(entry.name, options);
  }
  // Screen the entire reply before projecting candidates; no clipping or redaction.
  try { assertJudgmentInput(lines); } catch { throw new ImapReadingError(); }
  return readImapDrafts(entries, options);
}

// ---------------------------------------------------------------------------
// APPENDUID
// ---------------------------------------------------------------------------

const APPENDUID = /\[APPENDUID\s+(\d+)\s+(\d+)\]/i;

/**
 * The UID the server assigned the appended message, when it advertises UIDPLUS
 * (RFC 4315) and says so in its tagged reply.
 *
 * Returns null when it does not. Nothing is guessed: a server that reports no
 * UID leaves the caller with `uid: null`, which is true, rather than with a
 * number that points at a different message.
 */
export function parseAppendUid(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = APPENDUID.exec(line);
    if (match === null) continue;
    const uid = parseInt(match[2] ?? '', 10);
    if (isFinite(uid) && uid > 0) return uid;
  }
  return null;
}

/** The UIDVALIDITY half of an APPENDUID reply, or null when the server reported none. */
export function parseAppendUidValidity(lines: readonly string[]): number | null {
  for (const line of lines) {
    const match = APPENDUID.exec(line);
    if (match === null) continue;
    const validity = parseInt(match[1] ?? '', 10);
    if (isFinite(validity) && validity > 0) return validity;
  }
  return null;
}
