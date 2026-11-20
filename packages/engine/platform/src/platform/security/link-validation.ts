/**
 * link-validation.ts, the gate a link from an untrusted surface must pass
 * BEFORE anything opens it.
 *
 * Owner's framing: headers can be spoofed, so any domain we are about to click
 * has to be validated first. This is that validation, and it is written as a
 * gate rather than a helper. What runs:
 *
 *  - `checkLinkTarget`, code only, no model: the link is validated before it
 *    is opened, and the page actually reached is validated again by the same
 *    rules before anything is filled (fill-card.ts compares the page address
 *    against the merchant domain admitted to the purchase). There is no
 *    redirect walker: whatever a browser followed, the address it ended on is
 *    what the second check reads.
 *  - `validateLinkTarget`, used once where a domain is ADMITTED (the checkout
 *    url at the start of a purchase): the same code checks, then one reading
 *    of whether the admitted domain is a lookalike or a link shortener. Later
 *    checks of the same purchase compare domains in code against what was
 *    admitted; they never ask again.
 *
 * Every rule below exists because a naive check fails to a specific real
 * attack, and each refusal names which:
 *
 *  - **userinfo**. `https://accounts.google.com@evil.example/verify` parses
 *    with host `evil.example` and reads as Google to a human. Hard reject, not
 *    a warning, because the whole attack is that it looks fine.
 *  - **scheme**. `javascript:` and `data:` execute; `http:` is
 *    interceptable and a downgrade. Only `https:` is opened.
 *  - **registrable domain**. `google.com.evil.example`, `google-verify.example`
 *    and `accounts-google.example` all pass at least one substring or
 *    `endsWith` check. Comparison is on eTLD+1 (see public-suffix.ts). A
 *    different registrable domain refuses in code, which is what stops every
 *    lookalike or shortener that is not the admitted domain itself.
 *  - **homograph and shortener, at admission**. The admitted domain itself can
 *    be a lookalike (`xn--pypal-4ve.com` chosen from page content) or a
 *    shortening service; whether it is, is read by Jev
 *    (`engine.security.link-host`) once, when it is admitted.
 *
 * Classic applies the code rules and marks accepted results as Classic.
 * It does not claim semantic homograph/shortener assurance or ban all IDNs.
 *
 * Refusal is loud and carries both domains, because a refused verification link
 * is often something the owner must complete themselves.
 */

import { judgmentPort } from '@goodvibes/engine/errors';
import { linkHost, linkHostView, renderedHost } from './batteries/link-host.js';
import { registrableDomain } from './public-suffix.js';
import { runDecisionOrClassic as decisionOrClassic } from '@goodvibes/engine/errors';

/** The decision site the link-host reading is logged under. */
export const LINK_HOST_SITE = 'security.link-validation';

export type LinkRefusalReason =
  | 'not-https'
  | 'contains-userinfo'
  | 'ip-literal-host'
  | 'non-standard-port'
  | 'malformed-url'
  | 'lookalike-host'
  | 'known-redirector'
  | 'domain-mismatch';

export interface LinkAccepted {
  readonly provenance?: 'classic';
  readonly ok: true;
  /** The normalized, safe-to-open URL. */
  readonly url: string;
  readonly host: string;
  readonly registrableDomain: string;
}

export interface LinkRefused {
  readonly ok: false;
  readonly reason: LinkRefusalReason;
  /** Plain-language explanation naming both domains where relevant. */
  readonly message: string;
  /** The domain the link actually resolves to, when one could be determined. */
  readonly actualDomain: string | null;
  /** The domain the caller authorized. */
  readonly expectedDomain: string;
}

export type LinkValidation = LinkAccepted | LinkRefused;

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Normalize a host for comparison: lowercase, no trailing dot, NFKC. */
export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').normalize('NFKC');
}

function refuse(
  reason: LinkRefusalReason,
  message: string,
  expectedDomain: string,
  actualDomain: string | null = null,
): LinkRefused {
  return { ok: false, reason, message, actualDomain, expectedDomain };
}

/**
 * Check one link against a domain already admitted, in code: no model request.
 *
 * `authorizedDomain` is the domain the agent is actually transacting with,
 * the service it signed up at, or the service it is logging in to. Comparison
 * is on the registrable domain of both.
 */
export function checkLinkTarget(rawUrl: string, authorizedDomain: string): LinkValidation {
  const expected = registrableDomain(normalizeHost(authorizedDomain));
  if (expected === null) {
    return refuse(
      'domain-mismatch',
      `Refused: "${authorizedDomain}" is not a domain a link can be checked against.`,
      authorizedDomain,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return refuse('malformed-url', 'Refused: that link is not a parseable URL.', expected);
  }

  if (parsed.protocol !== 'https:') {
    return refuse(
      'not-https',
      `Refused: the link uses "${parsed.protocol}" rather than https. `
      + 'Only https links are opened, http can be intercepted, and data/javascript links execute rather than navigate.',
      expected,
    );
  }

  // Before anything else about the host: userinfo makes the rendered text lie.
  if (parsed.username !== '' || parsed.password !== '') {
    return refuse(
      'contains-userinfo',
      `Refused: the link embeds credentials before the host ("…@${parsed.hostname}"), which makes it read as `
      + `a different site than the one it opens. It actually goes to "${parsed.hostname}".`,
      expected,
      registrableDomain(normalizeHost(parsed.hostname)),
    );
  }

  const host = normalizeHost(parsed.hostname);

  if (IPV4_LITERAL.test(host) || host.startsWith('[')) {
    return refuse('ip-literal-host', 'Refused: the link points at a bare IP address rather than a named host.', expected, null);
  }

  if (parsed.port !== '' && parsed.port !== '443') {
    return refuse(
      'non-standard-port',
      `Refused: the link uses port ${parsed.port} rather than the standard https port.`,
      expected,
      registrableDomain(host),
    );
  }

  const actual = registrableDomain(host);
  if (actual === null) {
    return refuse('malformed-url', `Refused: "${host}" has no registrable domain to check.`, expected, null);
  }

  if (actual !== expected) {
    return refuse(
      'domain-mismatch',
      `Refused: the link goes to "${actual}" but this action is authorized for "${expected}". `
      + 'A near-miss is how a phishing link is built; nothing is opened.',
      expected,
      actual,
    );
  }

  return { ok: true, url: parsed.toString(), host, registrableDomain: actual };
}

/**
 * Admit a domain: the code checks of `checkLinkTarget`, then one reading of
 * whether the admitted domain is a lookalike or a link shortener. Call it once
 * where the domain enters (a purchase's checkout url); later checks of the
 * same action use `checkLinkTarget` against the admitted registrable domain.
 * Without a decision model, this accepts the code match with explicit Classic provenance.
 */
export async function validateLinkTarget(rawUrl: string, authorizedDomain: string, signal?: AbortSignal): Promise<LinkValidation> {
  signal?.throwIfAborted();
  const checked = checkLinkTarget(rawUrl, authorizedDomain);
  if (!checked.ok) return checked;
  const accepted = checked;
  const { host, registrableDomain: actual } = accepted;
  const expected = actual;
  // The admitted domain itself may be an owner/discovery-selected shortener or
  // lookalike. Domain equality does not settle those separate semantic checks.
  return decisionOrClassic<LinkValidation>(async () => {
    const run = await linkHost.run(judgmentPort(LINK_HOST_SITE), linkHostView(host, actual, expected), { site: LINK_HOST_SITE, ...(signal === undefined ? {} : { signal }) });
    signal?.throwIfAborted();
    const refusesOn = (reading: (typeof run.readings)['lookalike']): boolean =>
      !(reading.verdict === 'no' && reading.outcome === 'act');

    if (refusesOn(run.readings.lookalike)) {
      run.recordAction('refused as lookalike');
      return refuse(
        'lookalike-host',
        `Refused: the link's host ("${renderedHost(host)}") uses characters chosen to look like a different name, which is how a `
        + 'lookalike domain is built to render identically to a real one.',
        expected,
        null,
      );
    }

    if (refusesOn(run.readings.shortener)) {
      run.recordAction('refused as shortener');
      return refuse(
        'known-redirector',
        `Refused: "${actual}" is a link shortener, so the address does not say where it goes. `
        + `Matching the authorized domain "${expected}" does not establish the final destination.`,
        expected,
        actual,
      );
    }
    run.recordAction('accepted');
    return accepted;
  }, () => { signal?.throwIfAborted(); return { ...accepted, provenance: 'classic' }; });
}
