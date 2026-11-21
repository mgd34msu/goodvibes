/**
 * Reading ONE whole message by UID, and saying which of three things happened.
 *
 * Split out of `imap-client.ts` because the answer stopped being a message or
 * `null` and became a decision. `ImapClient` is the connection and the command
 * surface; the rules for telling "the server said nothing about this UID" from
 * "the server answered and we could not read the answer" are a separate piece
 * of reasoning with its own failure mode, and it is long enough to have pushed
 * that file past the line cap on its own.
 *
 * The distinction is the point of the module
 * ──────────────────────────────────────────
 * `fetchMessage` returned `ImapMessageDetail | null`, and `null` carried both
 * facts. Its one caller turns `null` into the sentence "no message with UID n
 * is in the mailbox, it may have been moved or deleted since it was listed",
 * which is true for an expunge and a false statement about the owner's mailbox
 * for an unreadable answer: the message is sitting in it, and we have just told
 * them it is gone. Same shape as `ImapEnvelopeBatch.unreadable` draws for a
 * batch fetch, drawn here for a single one.
 */

import {
  attachmentsFromParts,
  decodeTextPart,
  extractBodyStructure,
  extractFetchSection,
  hasFetchResponse,
  parseBodyStructure,
  selectBodyPart,
  type ImapBodyPart,
} from './imap-bodystructure.js';
import {
  assessFetchedBody,
  bodyCapabilityFailure,
  declaredTextOctets,
} from './imap-body-probe.js';
import { type ImapFetchFrame, parseFetchResponses, hasCompleteFetchSection } from './imap-fetch-response.js';
import {
  extractAuthenticationResults,
  extractDeliveryEvidence,
  extractDisplayHeader,
  extractHeader,
  hasCompleteSubjectHeader,
} from './imap-headers.js';
import type { ImapSession } from './imap-session.js';
import type { ImapBodySectionFailure, ImapFetchProblem, ImapMessageDetail, ImapMessageRead } from './imap-types.js';

// Private exact-result evidence. Legacy lenient reads remain readable but do
// not establish UID-bound provenance for a downstream subject snapshot.
const verifiedMessageIdentities = new WeakSet<ImapMessageDetail>();
export function hasVerifiedImapMessageIdentity(detail: ImapMessageDetail): boolean {
  return verifiedMessageIdentities.has(detail);
}

/**
 * The FETCH responses in a single-message header fetch that could not be read.
 *
 * Empty means one of two ordinary things: the server said nothing about this
 * UID (an expunge, the caller's `gone`), or the header block came back and can
 * be read. Non-empty is the third case, which used to have nowhere to go: the
 * server ANSWERED and this client cannot say what it answered.
 *
 * The test for that third case is deliberately "a response arrived and no
 * header text came out of it", not "the response reader reported an error".
 * Two parsers read these lines, `extractFetchSection`, which the payload comes
 * from, and `parseFetchResponses`, which is stricter, and they do not agree on
 * every conformant shape a server sends. Refusing a message because the
 * stricter one objected while the actual payload extracted fine would turn
 * readable mail into "could not be read", which is the same class of false
 * statement in the opposite direction. So the extraction is the verdict, and
 * the strict reader is used only to SAY WHY when the extraction came back with
 * nothing.
 *
 * Empty header text is not a message with no headers; there is no such message.
 * It is the case that used to fall through to `?? ''` and produce a detail with
 * an empty From, Subject, Date and Message-ID, handed to the caller as a
 * successful read.
 */
export function unreadableHeaderResponses(
  lines: readonly (string | ImapFetchFrame)[],
  uid: number,
): ImapFetchProblem[] {
  if (!hasFetchResponse(lines)) return [];
  if ((extractFetchSection(lines) ?? '').trim().length > 0) return [];

  const responses = parseFetchResponses(lines);
  const problems: ImapFetchProblem[] = [];
  for (const response of responses) {
    if (response.parseError === null) continue;
    problems.push({
      seq: response.seq > 0 ? response.seq : null,
      uid: response.uid,
      detail: response.parseError,
    });
  }
  if (problems.length > 0) return problems;
  const first = responses[0];
  return [{
    seq: first !== undefined && first.seq > 0 ? first.seq : null,
    uid: first?.uid ?? null,
    detail: `the FETCH response for UID ${uid} carried no readable header section, so nothing `
      + 'about the message could be read from it',
  }];
}

/**
 * One text part, decoded, or why it could not be fetched.
 *
 * A failure does not fail the read: a message whose body part will not come
 * back is still a message with headers worth returning. It is returned as an
 * error, so the read says the body is missing instead of passing on an empty
 * body as the message's text.
 */
async function fetchTextSection(
  session: ImapSession,
  uid: number,
  part: ImapBodyPart,
): Promise<{ readonly text: string; readonly error?: string }> {
  try {
    const lines = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[${part.section}]`);
    const raw = extractFetchSection(lines);
    if (raw === null) {
      return { text: '', error: `the server's answer carried no text for body section ${part.section}` };
    }
    return { text: decodeTextPart(raw, part.encoding, part.charset) };
  } catch (error) {
    return { text: '', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Read one whole message by UID: its headers, its readable text, and a
 * description of what is attached to it.
 *
 * **UID, not sequence number.** A sequence number is only meaningful inside the
 * session that produced it; the caller is holding an identifier from an earlier
 * listing, so anything else risks reading a different message than the one
 * asked for.
 *
 * **Read-only.** Every section is fetched with `BODY.PEEK[...]`. Plain
 * `BODY[...]` sets `\Seen`, which would mean reading the owner's mail marked it
 * read behind their back, for a daemon answering mail unattended, that is a
 * visible change to their mailbox nobody asked for.
 *
 * **Attachments are described, never downloaded.** The parts list comes from
 * BODYSTRUCTURE and only the text/plain and text/html sections are fetched. A
 * message with a 30 MB archive on it costs the same to read as one without.
 *
 * The three outcomes are `read`, `gone` and `unreadable`, see
 * `unreadableHeaderResponses` for how the last two are told apart, which is the
 * whole reason this returns a result rather than a nullable message.
 *
 * `enforceBodyReadable` adds a FOURTH answer that is not an outcome at all: it
 * raises. See the block at the end of the function for why a withheld body is
 * not one of the three, it is a fact about the account rather than about this
 * message, and returning it as a `read` with an empty body is exactly the
 * "quiet mailbox" impostor `imap-body-probe.ts` exists to catch. Off unless a
 * caller asks, because the ordinary mail reader leaves a section it could not
 * fetch empty, names it in `bodyUnavailable`, and returns the rest.
 */
export async function readMessageDetail(
  session: ImapSession,
  uid: number,
  mailbox: string,
  enforceBodyReadable = false,
): Promise<ImapMessageRead> {
  const headerLines = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[HEADER]`);
  const problems = unreadableHeaderResponses(headerLines, uid);
  if (problems.length > 0) return { outcome: 'unreadable', problems };
  if (!hasFetchResponse(headerLines)) return { outcome: 'gone' };
  const rawHeaders = extractFetchSection(headerLines) ?? '';

  const structureLines = await session.commandFrames(`UID FETCH ${uid} BODYSTRUCTURE`);
  const parts = parseBodyStructure(extractBodyStructure(structureLines));

  const textPart = selectBodyPart(parts, 'plain');
  const htmlPart = selectBodyPart(parts, 'html');
  const bodyUnavailable: ImapBodySectionFailure[] = [];
  const fetchPart = async (part: ImapBodyPart | null): Promise<string> => {
    if (part === null) return '';
    const fetched = await fetchTextSection(session, uid, part);
    if (fetched.error !== undefined) bodyUnavailable.push({ section: part.section, reason: fetched.error });
    return fetched.text;
  };
  let bodyText = await fetchPart(textPart);
  let bodyHtml = await fetchPart(htmlPart);

  if (parts.length === 0) {
    // The server's own description of the message was unreadable. Falling back
    // to BODY.PEEK[TEXT] is safe ONLY when the headers say the message is a
    // single text part, on a multipart message that section is every part
    // concatenated, including the encoded attachments this function exists not
    // to download, so it stays unfetched and the read names the body as missing.
    const contentType = extractHeader(rawHeaders, 'Content-Type').toLowerCase();
    if (contentType.length === 0 || contentType.startsWith('text/')) {
      const lines = await session.commandFrames(`UID FETCH ${uid} BODY.PEEK[TEXT]`);
      const section = extractFetchSection(lines);
      if (section === null) {
        bodyUnavailable.push({ section: 'TEXT', reason: 'the server\'s answer carried no text for the message body' });
      } else {
        const raw = section.replace(/\r\n/g, '\n');
        if (contentType.startsWith('text/html')) bodyHtml = raw;
        else bodyText = raw;
      }
    } else {
      bodyUnavailable.push({
        section: 'TEXT',
        reason: contentType.startsWith('multipart/')
          ? 'the server\'s description of this message could not be read and it has several parts, so its text and attachments were not fetched'
          : 'the server\'s description of this message could not be read and it is not a text message, so its content was not fetched',
      });
    }
  }

  // The runtime half of the body-capability check. The connect-time probe
  // cannot run on an empty mailbox, so the same declared-versus-returned
  // comparison runs again on a message actually read: a body that comes back
  // empty for a message whose own BODYSTRUCTURE declared a text part with
  // octets in it is a withheld body, not an empty message, and the difference
  // is the whole of "an inbox that looks quiet".
  if (enforceBodyReadable) {
    const readability = assessFetchedBody({
      responded: true,
      declaredOctets: declaredTextOctets(parts),
      returnedBytes: bodyText.length + bodyHtml.length,
      subject: `UID ${uid} in '${mailbox}'`,
    });
    if (readability.outcome === 'unreadable') {
      throw bodyCapabilityFailure({
        mailbox,
        summary: readability.detail,
        serverMessage: '',
      });
    }
  }

  const deliveryEvidence = extractDeliveryEvidence(rawHeaders);
  const detail: ImapMessageDetail = {
    uid,
    from: extractDisplayHeader(rawHeaders, 'From'),
    subject: extractDisplayHeader(rawHeaders, 'Subject'),
    date: extractHeader(rawHeaders, 'Date'),
    messageId: extractHeader(rawHeaders, 'Message-ID'),
    mailbox,
    deliveredTo: deliveryEvidence.map((entry) => entry.address),
    deliveryEvidence,
    // Display only, see the field docs on ImapEnvelope.
    unverifiedToHeaderClaim: extractDisplayHeader(rawHeaders, 'To'),
    authenticationResults: extractAuthenticationResults(rawHeaders),
    bodyText,
    bodyHtml,
    attachments: attachmentsFromParts(parts),
    ...(bodyUnavailable.length > 0 ? { bodyUnavailable } : {}),
  };
  const responses = parseFetchResponses(headerLines);
  const header = responses[0];
  if (responses.length === 1 && header?.parseError === null && header.uid === uid
    && hasCompleteFetchSection(header, 'HEADER')
    && header.sections.get('HEADER') === rawHeaders
    && hasCompleteSubjectHeader(rawHeaders, detail.subject)) verifiedMessageIdentities.add(detail);
  return { outcome: 'read', detail };
}

// The strict source contract is intentionally separate from lenient display.
export { readCompleteMessageDetail } from './imap-message-complete.js';
