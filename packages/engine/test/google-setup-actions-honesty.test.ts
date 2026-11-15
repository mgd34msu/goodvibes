/** What the Google setup steps claim about the credential they store, and what they refuse to risk. */
import { describe, expect, test } from 'bun:test';
import { buildGoogleSetupRunners } from '../platform/src/platform/google/setup-actions.ts';
import { stepSpec } from '../platform/src/platform/google/setup-plan.ts';
import { oauthPathComplete } from '../platform/src/platform/google/setup-state.ts';

function deps(overrides: { config?: Record<string, unknown>; secretGet?: () => Promise<string | null>; secretSet?: () => Promise<void>; browser?: () => Promise<never> }) {
  const config = overrides.config ?? {};
  return {
    config: { get: (key: string) => config[key], set: () => undefined },
    secrets: { get: overrides.secretGet ?? (async () => 'stored'), set: overrides.secretSet ?? (async () => undefined) },
    browser: overrides.browser ?? (async () => { throw new Error('unexpected browser'); }),
    commands: { run: async () => { throw new Error('unexpected command'); } },
    fetchPort: { fetch: async () => { throw new Error('unexpected network'); } },
    files: { exists: () => false, readText: () => null },
    loopback: () => { throw new Error('unexpected listener'); },
    homeDirectory: '/synthetic',
    proveConnection: async () => ({ ok: true, detail: 'Read mail and calendar.' }),
  };
}

async function runVerify(config: Record<string, unknown>) {
  const runners = buildGoogleSetupRunners('oauth', deps({ config }) as never);
  return runners.get('oauth-verify')!(stepSpec('oauth-verify'));
}

describe('the seven-day Testing expiry', () => {
  test('an unread publishing status is reported as unchecked, not as a fact', async () => {
    const result = await runVerify({});
    const warnings = result.outcome === 'done' ? (result.warnings ?? []) : [];
    expect(warnings.join(' ')).toContain('was not checked');
    expect(warnings.join(' ')).not.toContain('Publishing status is');
  });

  test('a status read as Testing states the expiry', async () => {
    const result = await runVerify({ 'google.oauth.publishingStatus': 'testing' });
    expect(result.outcome === 'done' ? (result.warnings ?? []).join(' ') : '').toContain('"Testing"');
  });

  test('a published app has no warning', async () => {
    const result = await runVerify({ 'google.oauth.publishingStatus': 'in-production' });
    expect(result.outcome === 'done' ? (result.warnings ?? []) : ['x']).toHaveLength(0);
  });

  test('an unread status does not keep the OAuth path from being complete', () => {
    const base = { oauthClientId: 'c', hasOAuthClientSecret: true, hasRefreshToken: true } as never;
    expect(oauthPathComplete({ ...(base as object), publishingStatus: 'unknown' } as never)).toBe(true);
    expect(oauthPathComplete({ ...(base as object), publishingStatus: 'testing' } as never)).toBe(false);
  });
});

describe('the app password step', () => {
  test('an unreadable secret store is not taken for an empty one, so no second password is created', async () => {
    let browserCalls = 0;
    const runners = buildGoogleSetupRunners('app-password', deps({
      secretGet: async () => { throw new Error('store is locked'); },
      browser: async () => { browserCalls += 1; throw new Error('unexpected browser'); },
    }) as never);
    const result = await runners.get('app-password')!(stepSpec('app-password'));
    expect(result.outcome).toBe('failed');
    expect(browserCalls).toBe(0);
  });
});

describe('the OAuth steps with an unreadable secret store', () => {
  test.each(['oauth-client', 'oauth-authorize'] as const)('%s does not start over when the store cannot be read', async (step) => {
    let browserCalls = 0;
    let writes = 0;
    let listeners = 0;
    const base = deps({
      config: { 'google.oauth.clientId': 'client' },
      secretGet: async () => { throw new Error('store is locked'); },
      secretSet: async () => { writes += 1; },
      browser: async () => { browserCalls += 1; throw new Error('unexpected browser'); },
    });
    const runners = buildGoogleSetupRunners('oauth', { ...base, loopback: () => { listeners += 1; throw new Error('unexpected listener'); } } as never);
    const result = await runners.get(step)!(stepSpec(step));
    expect(result.outcome).toBe('failed');
    expect(browserCalls + writes + listeners).toBe(0);
  });
});

