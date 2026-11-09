/**
 * security-link-validation.test.ts
 *
 * Owner: "headers can be spoofed etc… need to validate any domain we 'click'
 * on before we click on it."
 *
 * Every test here is an attack that defeats at least one naive check, so each
 * one is written as the attack rather than as a property. If a future change
 * makes any of these pass, the gate is no longer doing the job it was built
 * for.
 */

import { describe, expect, test } from 'bun:test';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { useSecurityReadings, withSecurityReadings } from './helpers/security-readings.ts';
import {
  MAX_REDIRECT_HOPS,
  followValidatedRedirects,
  validateLinkTarget,
} from '../platform/src/platform/security/link-validation.ts';
import {
  registrableDomain,
  sameRegistrableDomain,
} from '../platform/src/platform/security/public-suffix.ts';

const TARGET = 'google.com';

const readings = useSecurityReadings();

describe('registrable domain: the comparison every naive check gets wrong', () => {
  test.each([
    ['google.com', 'google.com'],
    ['accounts.google.com', 'google.com'],
    ['a.b.c.google.com', 'google.com'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    // Each label under a hosting suffix is a separate registrant.
    ['alice.github.io', 'alice.github.io'],
    ['bob.github.io', 'bob.github.io'],
  ])('%s -> %s', (host, expected) => {
    expect(registrableDomain(host)).toBe(expected);
  });

  test('a public suffix has no registrable domain of its own', () => {
    expect(registrableDomain('co.uk')).toBeNull();
    expect(registrableDomain('com')).toBeNull();
  });

  test('two sites under the same hosting suffix are NOT the same domain', () => {
    // endsWith('github.io') would call these equal.
    expect(sameRegistrableDomain('alice.github.io', 'bob.github.io')).toBe(false);
  });
});

describe('refusals: each defeats a check somebody would otherwise have written', () => {
  test('userinfo: reads as Google, opens evil.example', async () => {
    const result = await validateLinkTarget('https://accounts.google.com@evil.example/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('contains-userinfo');
    // The refusal must name where it ACTUALLY goes, or a reader learns nothing.
    expect(result.message).toContain('evil.example');
  });

  test('homograph: Cyrillic a in accounts', async () => {
    const result = await validateLinkTarget('https://аccounts.google.com/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('lookalike-host');
  });

  test('suffix trick: google.com.evil.example', async () => {
    // endsWith and includes both pass this.
    const result = await validateLinkTarget('https://google.com.evil.example/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('domain-mismatch');
    expect(result.actualDomain).toBe('evil.example');
  });

  test('lookalike registrations: google-verify.example and accounts-google.example', async () => {
    for (const url of ['https://google-verify.example/v', 'https://accounts-google.example/v']) {
      const result = await validateLinkTarget(url, TARGET);
      expect(result.ok, url).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('domain-mismatch');
    }
  });

  test('http is refused, not upgraded', async () => {
    const result = await validateLinkTarget('http://accounts.google.com/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('not-https');
  });

  test('javascript: and data: are refused', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>']) {
      const result = await validateLinkTarget(url, TARGET);
      expect(result.ok, url).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toBe('not-https');
    }
  });

  test('an off-domain shortener refuses locally without needing its semantic classification', async () => {
    const result = await validateLinkTarget('https://bit.ly/3xYz', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('domain-mismatch');
    expect(readings.requests).toHaveLength(0);
  });

  test('matching an authorized shortening domain still refuses as a shortener', async () => {
    const result = await validateLinkTarget('https://bit.ly/3xYz', 'bit.ly');
    if (result.ok) throw new Error('The matching shortener must still refuse');
    expect(result.reason).toBe('known-redirector');
    expect(readings.requests).toHaveLength(1);
  });

  test('a non-443 port is refused', async () => {
    const result = await validateLinkTarget('https://accounts.google.com:8443/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('non-standard-port');
  });

  test('a bare IP host is refused', async () => {
    const result = await validateLinkTarget('https://192.0.2.10/verify', TARGET);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('ip-literal-host');
  });
});

describe('the positive case: a genuine link is opened', () => {
  test('the real link on the exact registrable domain passes', async () => {
    const result = await validateLinkTarget('https://accounts.google.com/verify?token=abc', TARGET);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.registrableDomain).toBe('google.com');
  });

  test('a trailing-dot host still matches, rather than failing a person for a typo', async () => {
    expect((await validateLinkTarget('https://accounts.google.com./verify', TARGET)).ok).toBe(true);
  });
});

describe('redirect chains: the same attack one hop later', () => {
  function probeFrom(map: Readonly<Record<string, { status: number; location: string | null }>>) {
    return async (url: string) => map[url] ?? { status: 200, location: null };
  }

  test('a valid host that redirects cross-domain on hop 2 is refused', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/verify',
      TARGET,
      probeFrom({
        'https://accounts.google.com/verify': { status: 302, location: 'https://evil.example/steal' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.finalUrl).toBeNull();
    expect(result.refusal?.reason).toBe('redirect-left-domain');
    expect(result.refusal?.message).toContain('redirects away');
  });

  test('an in-domain redirect chain is followed and settles', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/verify',
      TARGET,
      probeFrom({
        'https://accounts.google.com/verify': { status: 302, location: 'https://myaccount.google.com/done' },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe('https://myaccount.google.com/done');
    expect(result.chain).toHaveLength(2);
  });

  test('a redirect to a userinfo URL is refused even though the chain started well', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/verify',
      TARGET,
      probeFrom({
        'https://accounts.google.com/verify': { status: 302, location: 'https://accounts.google.com@evil.example/' },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('contains-userinfo');
  });

  test('an endless redirect loop is refused rather than followed forever', async () => {
    const result = await followValidatedRedirects(
      'https://accounts.google.com/a',
      TARGET,
      async (url: string) => ({ status: 302, location: `${url}a` }),
    );
    expect(result.ok).toBe(false);
    expect(result.refusal?.reason).toBe('too-many-redirects');
    expect(result.chain.length).toBeLessThanOrEqual(MAX_REDIRECT_HOPS + 1);
  });

  test('the entry point is gated too: a caller cannot skip validation by starting here', async () => {
    const result = await followValidatedRedirects(
      'https://evil.example/verify',
      TARGET,
      probeFrom({}),
    );
    expect(result.ok).toBe(false);
    expect(result.chain).toHaveLength(0);
    expect(result.refusal?.reason).toBe('domain-mismatch');
  });
});

describe('what the code does with the link-host reading', () => {
  test('code refusals come first and ask nothing', async () => {
    await validateLinkTarget('http://accounts.google.com/verify', TARGET);
    await validateLinkTarget('https://accounts.google.com@evil.example/verify', TARGET);
    await validateLinkTarget('https://192.0.2.10/verify', TARGET);
    await validateLinkTarget('https://google.com.evil.example/verify', TARGET);
    await validateLinkTarget('https://google-verify.example/verify', TARGET);
    await validateLinkTarget('https://bit.ly/verify', TARGET);
    await validateLinkTarget('https://bob.github.io/verify', 'alice.github.io');
    expect(readings.requests).toHaveLength(0);
  });

  test('both questions go in one request with the rendered host', async () => {
    await validateLinkTarget('https://аccounts.google.com/verify', TARGET);
    expect(readings.requests).toHaveLength(1);
    expect(Object.keys(readings.requests[0]!.questions).sort()).toEqual(['lookalike', 'shortener']);
    expect(readings.requests[0]!.state).toMatchObject({ host: 'xn--ccounts-1fg.google.com', rendered: 'аccounts.google.com', authorizedDomain: 'google.com' });
  });

  test('an unsure lookalike reading refuses: only a confident no opens a link', async () => {
    const result = await withSecurityReadings({ lookalike: () => 'unsure' }, () => validateLinkTarget('https://accounts.google.com/verify', TARGET));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('lookalike-host');
  });

  test('a shortener the old list never named is refused by name when the reading says so', async () => {
    const result = await withSecurityReadings({ shortener: (state) => state.registrableDomain === 't.ly' }, () => validateLinkTarget('https://t.ly/abc', 't.ly'));
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('known-redirector');
  });

  test('an exact authorized host does not bypass a semantic lookalike finding', async () => {
    const result = await withSecurityReadings({ lookalike: () => true }, () => validateLinkTarget('https://shop.example/pay', 'shop.example'));
    expect(result).toMatchObject({ ok: false, reason: 'lookalike-host' });
  });

  test('a deterministic mismatch does not consult an unavailable model or downgrade Preferred', async () => {
    let requests = 0;
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await withSecurityReadings({ lookalike: () => { requests++; throw new JudgmentError('unavailable', 'Synthetic unavailable endpoint'); } }, async () => {
        expect(await validateLinkTarget('https://evil.example/verify', TARGET)).toMatchObject({ ok: false, reason: 'domain-mismatch' });
        expect(requests).toBe(0);
        expect(decisionModelPolicyState()).toMatchObject({ operation: 'decision', reason: null });
        expect(await validateLinkTarget('https://accounts.google.com/verify', TARGET)).toMatchObject({ ok: true, provenance: 'classic' });
        expect(requests).toBe(1);
        expect(decisionModelPolicyState()).toMatchObject({ operation: 'classic', reason: 'unavailable' });
      });
    });
  });
});

describe('Classic link guarantees', () => {
  test('matching IDNs and subdomains carry Classic provenance without claiming model assurance', async () => {
    await withDecisionModelPolicy(() => 'Classic - Off', async () => {
      expect(await validateLinkTarget('https://xn--wgv71a119e.jp/help', 'xn--wgv71a119e.jp')).toMatchObject({ ok: true, provenance: 'classic' });
      expect(await validateLinkTarget('https://аccounts.google.com/verify', TARGET)).toMatchObject({ ok: true, provenance: 'classic' });
      expect(await validateLinkTarget('https://bit.ly/abc', 'bit.ly')).toMatchObject({ ok: true, provenance: 'classic' });
      expect(await validateLinkTarget('https://bit.ly/abc', TARGET)).toMatchObject({ ok: false, reason: 'domain-mismatch' });
      expect(await validateLinkTarget('https://bob.github.io/verify', 'alice.github.io')).toMatchObject({ ok: false, reason: 'domain-mismatch' });
    });
    expect(readings.requests).toHaveLength(0);
  });

  test('Classic redirect following checks every target and never probes a mismatched target', async () => {
    const probes: string[] = [];
    const result = await withDecisionModelPolicy(() => 'Classic - Off', () => followValidatedRedirects(
      'https://accounts.google.com/verify', TARGET,
      async url => { probes.push(url); return { status: 302, location: 'https://evil.example/steal' }; },
    ));
    expect(result).toMatchObject({ ok: false, finalUrl: null, refusal: { reason: 'redirect-left-domain' } });
    expect(probes).toEqual(['https://accounts.google.com/verify']);
    expect(readings.requests).toHaveLength(0);
  });
});
