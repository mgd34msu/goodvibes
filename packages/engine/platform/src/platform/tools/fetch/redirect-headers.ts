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
 * Public request metadata (Accept, Content-Type, User-Agent and the like)
 * always follows. Any other header the caller set is read by Jev from its
 * NAME alone, never its value (`engine.tools.credential-header`), once per
 * name for the process, and follows only on a no that acts; an unsure, late
 * or unavailable reading drops it, so the redirect itself never waits on or
 * fails for a decision model.
 */
import { headerIsCredential } from '../credential-header-reading.js';

const CREDENTIAL_HEADER_SITE = 'tools.fetch.redirect-header';

/** The header names HTTP itself defines as carrying credentials, lower-cased. */
const PROTOCOL_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization', 'cookie']);

/**
 * The headers that follow a redirect to another origin.
 *
 * @param headers - The headers of the request being redirected.
 * @param toolCredentialHeaders - Lower-cased names of the headers the tool set from `auth` or `service`.
 * @param signal - The fetch's own signal; aborting it rejects.
 */
export async function headersForOtherOrigin(
  headers: Readonly<Record<string, string>>,
  toolCredentialHeaders: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Record<string, string>> {
  const entries = Object.entries(headers).filter(([name]) => {
    const normalized = name.toLowerCase();
    return !PROTOCOL_CREDENTIAL_HEADERS.has(normalized) && !toolCredentialHeaders.has(normalized);
  });
  const credential = await Promise.all(entries.map(([name]) => headerIsCredential(name, { site: CREDENTIAL_HEADER_SITE, signal })));
  return Object.fromEntries(entries.filter((_, index) => !credential[index]));
}
