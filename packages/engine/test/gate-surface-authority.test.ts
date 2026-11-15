/**
 * Surface command-authority declarations.
 *
 * PERMANENT REGRESSION GUARDS. These tests pin a trust boundary, not an
 * implementation detail. If one of them fails, the correct response is
 * almost never to update the test, it is to ask why a surface anyone can
 * write to just gained the ability to direct the agent. The one legitimate
 * reason to edit the expectations here is an owner decision to move a
 * surface between the two categories, and that decision belongs in the diff
 * next to the table edit in packages/engine/platform/src/platform/gate/surface-authority.ts.
 *
 * The property these tests describe, for other surfaces to adopt:
 *   surfaceAuthority(surfaceId) -> 'command' | 'input-only'
 * with 'input-only' as the answer for anything not explicitly declared.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SURFACE_COMMAND_AUTHORITY,
  assertCanConfirm,
  effectPermittedForProvenance,
  listCommandAuthoritySurfaces,
  listDeclaredSurfaces,
  normalizeSurfaceId,
  surfaceAuthority,
  surfaceCarriesCommandAuthority,
  type AgentEffect,
} from '../platform/src/platform/gate/surface-authority.ts';

const UNDERSTANDING_EFFECTS: readonly AgentEffect[] = ['read', 'search', 'analyze'];
const CONSEQUENTIAL_EFFECTS: readonly AgentEffect[] = ['send', 'write', 'exec', 'settings'];

describe('surface command authority', () => {
  test('email is an input-only surface and never carries command authority', () => {
    expect(surfaceAuthority('email')).toBe('input-only');
    expect(surfaceCarriesCommandAuthority('email')).toBe(false);
  });

  test('webhooks are input-only because anyone who learns the URL can post to them', () => {
    expect(surfaceAuthority('webhook')).toBe('input-only');
    expect(surfaceCarriesCommandAuthority('webhook')).toBe(false);
  });

  test('the terminal, the CLI and Telegram carry command authority', () => {
    for (const surface of ['terminal', 'cli', 'tui', 'telegram']) {
      expect(surfaceAuthority(surface)).toBe('command');
      expect(surfaceCarriesCommandAuthority(surface)).toBe(true);
    }
  });

  test('an unknown surface defaults to input-only, so a new surface must opt into authority', () => {
    expect(DEFAULT_SURFACE_COMMAND_AUTHORITY).toBe('input-only');
    for (const surface of ['', 'sms-gateway', 'public-form', 'rss', 'matrix', 'slack', 'web']) {
      expect(surfaceAuthority(surface)).toBe('input-only');
      expect(surfaceCarriesCommandAuthority(surface)).toBe(false);
    }
  });

  test('ntfy messages have no sender identity, so they are input-only and cannot direct the agent', () => {
    expect(surfaceAuthority('ntfy')).toBe('input-only');
    expect(effectPermittedForProvenance('exec', { surfaceId: 'ntfy' }).allowed).toBe(false);
    expect(effectPermittedForProvenance('read', { surfaceId: 'ntfy' }).allowed).toBe(true);
  });

  test('the declared command surfaces are exactly the four that only the owner can write to', () => {
    expect(listCommandAuthoritySurfaces()).toEqual(['cli', 'telegram', 'terminal', 'tui']);
  });

  test('every declared surface answers with one of the two authority values', () => {
    const declared = listDeclaredSurfaces();
    expect(declared.length).toBeGreaterThan(0);
    for (const surface of declared) {
      expect(['command', 'input-only']).toContain(surfaceAuthority(surface));
    }
  });

  test('surface ids are matched after trimming and lowercasing', () => {
    expect(normalizeSurfaceId('  EMAIL  ')).toBe('email');
    expect(surfaceAuthority('  Email ')).toBe('input-only');
    expect(surfaceAuthority('TERMINAL')).toBe('command');
  });
});

describe('confirmation authority', () => {
  test('a confirmation on the terminal is allowed', () => {
    const decision = assertCanConfirm('terminal');
    expect(decision.allowed).toBe(true);
    expect(decision.surfaceId).toBe('terminal');
  });

  test('a confirmation attempted on email is refused and names surfaces that can confirm', () => {
    const decision = assertCanConfirm('email');
    expect(decision.allowed).toBe(false);
    if (decision.allowed) throw new Error('email must never be allowed to confirm');
    expect(decision.problem).toContain('input-only');
    expect(decision.confirmOn).toEqual(['cli', 'telegram', 'terminal', 'tui']);
    expect(decision.fix).toContain('terminal');
    expect(decision.fix).toContain('telegram');
  });

  test('the refusal returns a value instead of throwing so the caller can route the owner', () => {
    expect(() => assertCanConfirm('email')).not.toThrow();
    expect(() => assertCanConfirm('some-brand-new-surface')).not.toThrow();
  });

  test('an unknown surface cannot confirm', () => {
    const decision = assertCanConfirm('partner-portal-callback');
    expect(decision.allowed).toBe(false);
  });
});

describe('effect gate', () => {
  test('reading, searching and analyzing are permitted on input-only provenance', () => {
    for (const effect of UNDERSTANDING_EFFECTS) {
      expect(effectPermittedForProvenance(effect, { surfaceId: 'email' })).toEqual({
        allowed: true,
      });
    }
  });

  test('sending, writing, executing and changing settings are refused on input-only provenance', () => {
    for (const effect of CONSEQUENTIAL_EFFECTS) {
      const decision = effectPermittedForProvenance(effect, { surfaceId: 'email' });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error(`${effect} must be refused for email provenance`);
      expect(decision.problem).toContain('email');
      expect(decision.problem).toContain('input-only');
      expect(decision.fix).toContain('terminal');
    }
  });

  test('every effect is permitted when the request came from a command surface', () => {
    for (const effect of [...UNDERSTANDING_EFFECTS, ...CONSEQUENTIAL_EFFECTS]) {
      expect(effectPermittedForProvenance(effect, { surfaceId: 'telegram' })).toEqual({
        allowed: true,
      });
    }
  });

  test('consequential effects are refused for an undeclared surface', () => {
    for (const effect of CONSEQUENTIAL_EFFECTS) {
      const decision = effectPermittedForProvenance(effect, { surfaceId: 'inbound-form' });
      expect(decision.allowed).toBe(false);
    }
  });
});
