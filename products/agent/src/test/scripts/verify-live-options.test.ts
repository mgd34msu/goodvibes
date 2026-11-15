import { describe, expect, test } from 'bun:test';
import { liveVerificationPasses, resolveVerifyLiveHome } from '../../../scripts/verify-live-options.ts';

describe('verify-live home', () => {
  test('GOODVIBES_HOME is the root the .goodvibes tree sits under, as in the runtime', () => {
    expect(resolveVerifyLiveHome(undefined, { GOODVIBES_HOME: '/tmp/sandbox' })).toBe('/tmp/sandbox/.goodvibes');
  });

  test('--home names a .goodvibes directory directly', () => {
    expect(resolveVerifyLiveHome('/data/.goodvibes', { GOODVIBES_HOME: '/tmp/sandbox' })).toBe('/data/.goodvibes');
  });
});

describe('verify-live result', () => {
  const counts = (skip: number) => ({ pass: 3, warn: 0, fail: 0, skip });

  test('a strict run that skipped checks does not pass', () => {
    expect(liveVerificationPasses({ ok: true, strict: true, counts: counts(4) })).toBe(false);
  });

  test('a non-strict run that skipped checks keeps its own verdict', () => {
    expect(liveVerificationPasses({ ok: true, strict: false, counts: counts(4) })).toBe(true);
  });

  test('a strict run with nothing skipped passes', () => {
    expect(liveVerificationPasses({ ok: true, strict: true, counts: counts(0) })).toBe(true);
  });

  test('a failed run stays failed', () => {
    expect(liveVerificationPasses({ ok: false, strict: false, counts: counts(0) })).toBe(false);
  });
});
