/**
 * Reading the receiving server's sender-authentication verdict.
 *
 * `Authentication-Results` (RFC 8601) is where a receiving mail server records
 * whether a message travelled the path its domain publishes: DKIM signature,
 * SPF envelope, DMARC alignment. It answers a question about ROUTING.
 *
 * It does not answer whether the message may direct the agent. That is a
 * question about the SURFACE, and email is input-only regardless of how
 * impeccably a message authenticates. Everything here feeds
 * `describeSenderClaim`, whose `commandAuthority` is the literal `'none'` and
 * cannot be anything else. Nothing in this module returns a permission, and
 * nothing downstream may branch on its output to widen one.
 *
 * Whose header is read
 * ---------------------
 * A sender can put their own `Authentication-Results:` line in the message
 * they submit. On a server that stamps its own, the forgery lands BELOW the
 * one the server prepends, exactly like a forged `Delivered-To`, so only the
 * top-most header is read and every occurrence after it is discarded rather
 * than searched for a better answer.
 *
 * On a server that stamps nothing, the top-most header IS the sender's. So the
 * top-most header is accepted only when its authserv-id (the token that opens
 * it, RFC 8601 section 2.2) names the server the mailbox is read from:
 * `mx.google.com` for Gmail. For any other mailbox no server is known to stamp
 * its own verdict, and the result is `unverified`, which is the honest answer
 * rather than a forged "passed".
 */

/**
 * The result of a sender-authentication protocol, as reported by the receiver.
 *
 * Lives here rather than beside a surface's untrusted-content module because
 * the verdict is a property of the mail transport, not of any one product's
 * rendering of it. Surfaces re-export these types so their own boundary
 * modules keep an unchanged public shape.
 */
export type SenderProtocolResult = 'pass' | 'fail' | 'none';

/**
 * DKIM/SPF/DMARC outcomes, if the receiving side computed them.
 *
 * These answer "did this message travel the path its domain publishes?", a
 * question about routing. They do not answer "may this message direct the
 * agent?", which is a question about the surface. A perfectly DKIM-signed
 * email from a domain that passes DMARC is still an email, and email is
 * input-only.
 */
export interface SenderAuthenticationChecks {
  readonly dkim?: SenderProtocolResult;
  readonly spf?: SenderProtocolResult;
  readonly dmarc?: SenderProtocolResult;
}

/** The methods worth surfacing. Others in the header are ignored. */
const METHODS = ['dkim', 'spf', 'dmarc'] as const;

type SenderAuthenticationMethod = (typeof METHODS)[number];

/**
 * Map an RFC 8601 result keyword onto the three outcomes the display layer
 * distinguishes.
 *
 * `softfail`, `permerror` and `policy` are folded into `fail` deliberately:
 * each means the domain's own published policy was not satisfied, and a
 * reader deserves to see that as a failure rather than as an absence. The
 * genuinely-absent cases (`none`, `neutral`, `temperror`) stay `none`, because
 * "we could not tell" must never render as "it passed".
 */
function readResult(keyword: string): SenderProtocolResult {
  const normalized = keyword.trim().toLowerCase();
  if (normalized === 'pass') return 'pass';
  if (normalized === 'fail' || normalized === 'softfail' || normalized === 'permerror' || normalized === 'policy') {
    return 'fail';
  }
  return 'none';
}

/**
 * Parse one `Authentication-Results` value.
 *
 * `dkim` is the first DKIM result the receiver stamped, for whichever domain
 * signed: a message signed by an unrelated domain still reads `pass`. Whether
 * the signing domain matches `From:` is what `dmarc` reports, so `dmarc` is the
 * aligned verdict and `dkim` is a statement about a signature only.
 *
 * Tolerant by design: the header is free-form enough in practice that a strict
 * grammar would reject real mail. Anything unrecognised yields no result for
 * that method, which surfaces as `unverified` rather than as a false pass.
 */
export function parseAuthenticationResults(headerValue: string): SenderAuthenticationChecks {
  const checks: {
    dkim?: SenderProtocolResult;
    spf?: SenderProtocolResult;
    dmarc?: SenderProtocolResult;
  } = {};

  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) return checks;

  // RFC 8601 comments are free text: a "(was dkim=pass earlier)" in one must
  // not be read as a result.
  const withoutComments = headerValue.replace(/\([^()]*\)/g, ' ');

  for (const method of METHODS) {
    // `dkim=pass`, `dkim = pass`, `dkim=pass (good signature)`. The first
    // occurrence of each method wins; a repeated method later in the same
    // header does not get to overwrite it.
    const match = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, 'i').exec(withoutComments);
    if (match?.[1] === undefined) continue;
    checks[method] = readResult(match[1]);
  }

  return checks;
}

/**
 * The authserv-id that opens an `Authentication-Results` value, lower-cased:
 * the text before the first `;`, without comments and without the optional
 * version number. Empty when the value has no authserv-id (it opens with a
 * result such as `spf=pass`).
 */
export function readAuthservId(headerValue: string): string {
  const head = headerValue.replace(/\([^()]*\)/g, ' ').split(';', 1)[0] ?? '';
  const id = head.trim().split(/\s+/, 1)[0] ?? '';
  return id.includes('=') ? '' : id.toLowerCase();
}

/**
 * IMAP hosts whose server prepends its own verdict, and the authserv-id it
 * writes. An id that starts with "." matches any host under that domain, for
 * providers whose receiving hosts are numbered (mx1, mx2, ...).
 */
const STAMPING_SERVERS: ReadonlyArray<{ readonly imapHost: string; readonly authservId: string }> = [
  { imapHost: 'imap.gmail.com', authservId: 'mx.google.com' },
  { imapHost: 'imap.googlemail.com', authservId: 'mx.google.com' },
  { imapHost: 'imap.fastmail.com', authservId: '.messagingengine.com' },
  { imapHost: 'imap.zoho.com', authservId: 'mx.zohomail.com' },
  { imapHost: 'imappro.zoho.com', authservId: 'mx.zohomail.com' },
  { imapHost: 'imap.mail.yahoo.com', authservId: '.yahoo.com' },
  { imapHost: 'imap.aol.com', authservId: '.yahoo.com' },
];

function normaliseAuthservId(id: string): string {
  const trimmed = id.trim().toLowerCase().replace(/\.$/, '');
  return trimmed.startsWith('*.') ? trimmed.slice(1) : trimmed;
}

/**
 * The authserv-ids whose verdict this mailbox may be shown: the id its own
 * receiving server writes, by the IMAP host it is read from, plus the ids the
 * owner configured for a provider not listed here
 * (`surfaces.email.imap.authservIds`). Empty for a host not known to stamp one
 * and nothing configured, which makes every verdict read `unverified`.
 */
export function mailboxAuthservIds(imapHost: string, configured: readonly string[] = []): readonly string[] {
  const host = imapHost.trim().toLowerCase().replace(/\.$/, '');
  const known = STAMPING_SERVERS.filter((server) => server.imapHost === host).map((server) => server.authservId);
  const extra = configured.map(normaliseAuthservId).filter((id) => id.length > 0 && id !== '.');
  return [...new Set([...known, ...extra])];
}

/** Whether a header's authserv-id is one of the mailbox's own (an entry starting with "." matches its subdomains). */
function isOwnAuthservId(id: string, authservIds: readonly string[]): boolean {
  return authservIds.some((entry) => (entry.startsWith('.') ? id.endsWith(entry) && id.length > entry.length : entry === id));
}

/**
 * Parse the top-most `Authentication-Results` header, and only that one, when
 * the mailbox's own server wrote it.
 *
 * @param headerValues every occurrence in the message, top-most first, exactly
 *   as `ImapEnvelope.authenticationResults` supplies them.
 * @param authservIds the ids the mailbox's own server writes
 *   (`mailboxAuthservIds`). A top-most header naming any other server is the
 *   sender's own, and yields no result.
 */
export function readSenderAuthentication(
  headerValues: readonly string[],
  authservIds: readonly string[],
): SenderAuthenticationChecks {
  const topMost = headerValues[0];
  if (topMost === undefined) return {};
  const id = readAuthservId(topMost);
  if (id === '' || !isOwnAuthservId(id, authservIds)) return {};
  return parseAuthenticationResults(topMost);
}

/**
 * True when the receiving server recorded any verdict at all. Used to tell
 * "checked and passed" apart from "nobody checked", which read identically
 * before this existed.
 */
export function hasAnySenderVerdict(checks: SenderAuthenticationChecks): boolean {
  return checks.dkim !== undefined || checks.spf !== undefined || checks.dmarc !== undefined;
}
