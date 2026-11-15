/**
 * The subject line of a reply, decided from the leading `Prefix:` chain.
 * Browser-safe: the web UI's Reply and the daemon's drafted replies read the
 * same rule, and no model is asked.
 *
 * A subject already marks a reply when a known reply marker leads it, possibly
 * after forward markers ("Fwd: Re: Lunch"). Anything else, including an unknown
 * short prefix, gets "Re: " in front: a doubled marker is cosmetic, a missing one
 * breaks the reader's threading.
 */

// Localized reply markers mail clients write: English, German, Dutch, Scandinavian,
// Polish, Turkish, Italian, Portuguese, Greek, Chinese.
const REPLY_MARKERS: ReadonlySet<string> = new Set([
  're', 'aw', 'antw', 'antwort', 'sv', 'svar', 'odp', 'ynt', 'rif', 'res', 'απ', 'σχετ', '回复', '回覆', '答复', '答覆',
]);
// Forward markers are skipped so a forwarded reply chain still reads as a reply.
const FORWARD_MARKERS: ReadonlySet<string> = new Set([
  'fwd', 'fw', 'wg', 'tr', 'rv', 'enc', 'doorst', 'vb', 'pd', 'ilt', 'πρθ', '转发', '轉寄',
]);
// A marker is a short run of letters, an optional count ("Re[2]", "Re(2)", "Re^2"), then a colon
// (a space before it is how French clients write it; CJK clients use the full-width colon).
const PREFIX = /^\s*(\p{L}{1,12})(?:\s*(?:\[\d{1,4}\]|\(\d{1,4}\)|\^\d{1,4}))?\s*[:：]/u;
const MAX_CHAIN = 16;

/** True when the subject already marks a reply. */
export function isReplySubject(subject: string): boolean {
  let rest = subject;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    const match = PREFIX.exec(rest);
    if (!match) return false;
    const token = match[1]!.toLowerCase();
    if (REPLY_MARKERS.has(token)) return true;
    if (!FORWARD_MARKERS.has(token)) return false;
    rest = rest.slice(match[0].length);
  }
  return false;
}

/** The subject a reply to `subject` carries: unchanged when it already marks a reply, else "Re: " in front. */
export function replySubjectLine(subject: string): string {
  const trimmed = subject.trim();
  return isReplySubject(trimmed) ? trimmed : `Re: ${trimmed}`;
}
