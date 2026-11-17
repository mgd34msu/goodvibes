/** Strict proof over canonical FETCH results; compatibility extraction is untouched. */
import { extractBodyStructure } from './imap-bodystructure.js';
import {
  hasCompleteFetchSection,
  parseFetchResponses,
  type ImapFetchFrame,
} from './imap-fetch-response.js';
import { parseSearchNumbers } from './imap-headers.js';
import { MAX_IMAP_UID } from './inbound/source-cursor.js';

/** Unsupported extra data items/unsolicited responses are refused, not ignored. */
function exactFrames(frames: readonly ImapFetchFrame[], uid: number): readonly ImapFetchFrame[] | null {
  const responses = parseFetchResponses(frames);
  if (responses.length !== 1 || responses[0]?.parseError !== null || responses[0].uid !== uid) return null;
  const last = frames.at(-1);
  const response = last !== undefined && last.literal === undefined && /^\S+ OK\b/.test(last.syntax)
    ? frames.slice(0, -1) : frames;
  if (response.length === 0 || response.length > 2) return null;
  return response;
}

function envelope(prefix: string, suffix: string, item: string, uid: number): boolean {
  const match = /^\* ([1-9][0-9]*) FETCH \((?:UID ([1-9][0-9]*)[ \t]+)?/i.exec(prefix);
  if (match === null || Number(match[1]) > MAX_IMAP_UID || prefix.slice(match[0].length).toUpperCase() !== item.toUpperCase()) return false;
  const tail = /^(?:[ \t]+UID ([1-9][0-9]*))?[ \t]*\)$/i.exec(suffix);
  if (tail === null || (match[2] === undefined) === (tail[1] === undefined)) return false;
  return Number(match[2] ?? tail[1]) === uid;
}

/** Only a whole exact section, with an unambiguous UID and a real value. */
export function completeFetchSection(frames: readonly ImapFetchFrame[], uid: number, section: string): string | null {
  const responseFrames = exactFrames(frames, uid);
  if (responseFrames === null) return null;
  const [response] = parseFetchResponses(frames);
  if (response === undefined || !hasCompleteFetchSection(response, section) || response.sections.size !== 1) return null;
  const first = responseFrames[0]!;
  const item = `BODY[${section}] `;
  if (first.literal !== undefined) {
    const last = responseFrames[1];
    if (responseFrames.length !== 2 || last === undefined || last.literal !== undefined
      || !envelope(first.syntax, last.syntax, item, uid)) return null;
    return first.literal;
  }
  if (responseFrames.length !== 1) return null;
  const marker = first.syntax.toUpperCase().indexOf(item);
  if (marker < 0) return null;
  const start = marker + item.length;
  const quoted = /^"(?:[^"\\\r\n\x00-\x1f\x7f-\uffff]|\\["\\])*"/.exec(first.syntax.slice(start));
  if (quoted === null || !envelope(first.syntax.slice(0, start), first.syntax.slice(start + quoted[0].length), item, uid)) return null;
  return response.sections.get(section.toUpperCase()) ?? null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** An IMAP date-time (`17-Jul-1996 02:44:25 -0700`, RFC 3501) as epoch ms, or undefined. */
export function parseImapDateTime(value: string): number | undefined {
  const match = /^ ?([0-9]{1,2})-([A-Za-z]{3})-([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([+-])([0-9]{2})([0-9]{2})$/.exec(value);
  if (match === null) return undefined;
  const month = MONTHS.indexOf(match[2]!.toLowerCase());
  if (month < 0) return undefined;
  const offsetMinutes = (match[7] === '-' ? -1 : 1) * (Number(match[8]) * 60 + Number(match[9]));
  const ms = Date.UTC(Number(match[3]), month, Number(match[1]), Number(match[4]), Number(match[5]), Number(match[6])) - offsetMinutes * 60_000;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined;
}

/** One `INTERNALDATE "<date-time>"` data item in a span of structural text. */
const INTERNALDATE_ITEM = /INTERNALDATE[ \t]+"([^"\\\r\n]*)"[ \t]*/i;

/** The structure, and the server's arrival time when the command asked for INTERNALDATE too. */
export interface CompleteStructureFetch {
  readonly structure: string;
  readonly internalDate: string | undefined;
}

/**
 * Full structure from the canonical extractor, with exact outer syntax/UID.
 * One INTERNALDATE item beside it (either side, any order) is read and taken
 * out before the outer syntax is checked; any other extra item is refused.
 */
export function completeFetchBodyStructure(frames: readonly ImapFetchFrame[], uid: number): CompleteStructureFetch | null {
  const responseFrames = exactFrames(frames, uid);
  if (responseFrames === null || responseFrames.some(frame => frame.literal !== undefined)) return null;
  const raw = responseFrames.map(frame => frame.syntax).join('\r\n');
  const marker = /BODYSTRUCTURE[ \t]+/i.exec(raw);
  if (marker === null) return null;
  const structure = extractBodyStructure(responseFrames);
  const start = marker.index + marker[0].length;
  if (!structure) return null;
  let prefix = raw.slice(0, marker.index);
  let suffix = raw.slice(start + structure.length);
  let internalDate: string | undefined;
  const before = INTERNALDATE_ITEM.exec(prefix);
  if (before !== null) {
    internalDate = before[1];
    prefix = prefix.slice(0, before.index) + prefix.slice(before.index + before[0].length);
  } else {
    const after = INTERNALDATE_ITEM.exec(suffix);
    if (after !== null) {
      internalDate = after[1];
      suffix = suffix.slice(0, after.index) + suffix.slice(after.index + after[0].length);
    }
  }
  if (!envelope(prefix + 'BODYSTRUCTURE ', suffix, 'BODYSTRUCTURE ', uid)) return null;
  return { structure, internalDate };
}

/**
 * Complete UID SEARCH snapshot. A malformed reply cannot mean an empty inbox.
 * A server may legally interleave other untagged status lines (`* 5 EXISTS`,
 * `* FLAGS (...)`, `* 3 FETCH (...)` from another client, `* VANISHED`)
 * before the tagged OK; those are not the answer and are ignored, but
 * exactly one `* SEARCH` line must be present.
 */
export function completeSearchUids(frames: readonly ImapFetchFrame[]): readonly number[] {
  const failure = (): never => { throw new Error('IMAP UID SEARCH response was incomplete or unsupported'); };
  const tagged = frames.at(-1);
  if (frames.length < 2 || frames.some(frame => frame.literal !== undefined)
    || !/^\S+ OK\b/.test(tagged?.syntax ?? '')) return failure();
  const answers = frames.slice(0, -1).map(frame => frame.syntax).filter(line => /^\* SEARCH(?: |$)/i.test(line));
  const others = frames.slice(0, -1).filter(frame => !/^\* SEARCH(?: |$)/i.test(frame.syntax));
  if (answers.length !== 1 || others.some(frame => !/^\* /.test(frame.syntax))) return failure();
  const response = answers[0]!;
  if (!/^\* SEARCH(?: [1-9][0-9]{0,9})*$/.test(response)) return failure();
  const tokens = response.length === 8 ? [] : response.slice(9).split(' ');
  const uids = parseSearchNumbers([response]);
  if (uids.length !== tokens.length || uids.some(uid => !Number.isSafeInteger(uid) || uid < 1 || uid > MAX_IMAP_UID)
    || new Set(uids).size !== uids.length) return failure();
  return Object.freeze(uids.sort((a, b) => a - b));
}
