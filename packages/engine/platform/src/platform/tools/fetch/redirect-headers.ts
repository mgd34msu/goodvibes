/**
 * redirect-headers.ts, which request headers follow a redirect to another
 * origin.
 *
 * Three kinds of header never follow, in code:
 *   - Authorization, Proxy-Authorization and Cookie, which the protocol
 *     defines as credentials (RFC 9110 §11.6 and §11.7, RFC 6265; the Fetch
 *     standard drops Authorization on a cross-origin redirect);
 *   - the headers the tool itself set from the call's `auth` or `service`,
 *     which are credentials because that is where the tool put them.
 * Public request metadata (Accept, Content-Type, User-Agent and the like,
 * the one table in credential-header-reading.ts) always follows with no
 * reading, including the Accept and Content-Type the tool set itself. Any
 * other header the caller set is read by Jev from its NAME alone, never its
 * value (`engine.tools.credential-header`), once per name for the process (a
 * second hop asks nothing), and follows only on a no that acts; an unsure,
 * late or unavailable reading drops it, so the redirect itself never waits on
 * or fails for a decision model. Every dropped name is returned, and the
 * fetch result lists them (`redirect_dropped_headers`) so the caller knows
 * what the final origin did not receive.
 */
import { headerIsCredential } from '../credential-header-reading.js';

const CREDENTIAL_HEADER_SITE = 'tools.fetch.redirect-header';

/** The header names HTTP itself defines as carrying credentials, lower-cased. */
const PROTOCOL_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * The headers that follow a redirect to another origin, and the names that do not.
 *
 * @param headers - The headers of the request being redirected.
 * @param toolCredentialHeaders - Lower-cased names of the headers the tool set from `auth` or `service`.
 * @param signal - The fetch's own signal; aborting it rejects.
 */
export async function headersForOtherOrigin(
  headers: Readonly<Record<string, string>>,
  toolCredentialHeaders: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<{ headers: Record<string, string>; dropped: string[] }> {
  const dropped: string[] = [];
  const entries = Object.entries(headers).filter(([name]) => {
    const normalized = name.toLowerCase();
    const follows = !PROTOCOL_CREDENTIAL_HEADERS.has(normalized) && !toolCredentialHeaders.has(normalized);
    if (!follows) dropped.push(name);
    return follows;
  });
  const credential = await Promise.all(entries.map(([name]) => headerIsCredential(name, { site: CREDENTIAL_HEADER_SITE, signal })));
  const kept: [string, string][] = [];
  entries.forEach((entry, index) => { if (credential[index]) dropped.push(entry[0]); else kept.push(entry); });
  return { headers: Object.fromEntries(kept), dropped };
}
