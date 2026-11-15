/**
 * Whether a mail subject already marks a reply, decided from the leading
 * `Prefix:` chain. Browser-safe: the web UI and the daemon read the same rule.
 *
 * - `reply`: a known reply marker leads the subject, possibly after forward markers ("Fwd: Re: Lunch").
 * - `not-reply`: no prefix, only forward markers, or an ordinary word before the colon ("Invoice: May").
 * - `unrecognised-prefix`: a short unknown token before the colon ("Ynt: Lunch") that may be a localized
 *   marker this list does not hold. Only this case is worth a model reading, and only as advice.
 */
export type ReplySubjectMarker = 'reply' | 'not-reply' | 'unrecognised-prefix';

// Localized reply markers mail clients write: English, German, Dutch, Scandinavian,
// Polish, Turkish, Italian, Portuguese, Greek, Chinese.
const REPLY_MARKERS: ReadonlySet<string> = new Set([
  're', 'aw', 'antw', 'antwort', 'sv', 'svar', 'odp', 'ynt', 'rif', 'res', 'απ', 'σχετ', '回复', '回覆', '答复', '答覆',
]);
// Forward markers are skipped so a forwarded reply chain still reads as a reply.
const FORWARD_MARKERS: ReadonlySet<string> = new Set([
  'fwd', 'fw', 'wg', 'tr', 'rv', 'enc', 'doorst', 'vb', 'pd', 'ilt', 'πρθ', '转发', '轉寄',
]);
// Short subject heads that are never reply markers, so they cost no reading.
const ORDINARY_HEADS: ReadonlySet<string> = new Set([
  'fyi', 'info', 'news', 'wip', 'todo', 'note', 'bug', 'fix', 'help', 'ask', 'tip', 'faq', 'q', 'a', 'ad', 'pr', 'cc',
]);
// A marker is a short run of letters, an optional count ("Re[2]", "Re(2)", "Re^2"), then a colon
// (a space before it is how French clients write it; CJK clients use the full-width colon).
const PREFIX = /^\s*(\p{L}{1,12})(?:\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\^\d{1,4}))?\s*[:：]/u;
const MAX_CHAIN = 16;
const MAX_UNKNOWN_MARKER_LENGTH = 4;

export function readReplySubjectMarker(subject: string): ReplySubjectMarker {
  let rest = subject;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    const match = PREFIX.exec(rest);
    if (!match) return 'not-reply';
    const token = match[1]!.toLowerCase();
    if (REPLY_MARKERS.has(token)) return 'reply';
    if (FORWARD_MARKERS.has(token)) { rest = rest.slice(match[0].length); continue; }
    if (ORDINARY_HEADS.has(token) || [...token].length > MAX_UNKNOWN_MARKER_LENGTH) return 'not-reply';
    return 'unrecognised-prefix';
  }
  return 'not-reply';
}
