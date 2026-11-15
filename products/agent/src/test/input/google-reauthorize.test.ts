import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { bindJudgmentPortAuthority, installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { createJudgmentSourceLifetime } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, type GoogleCommandPort, type GoogleProgressPort } from '@goodvibes-jev/engine/platform/platform/google';
import type { CommandContext } from '../../input/command-registry.ts';
import { googleBrowserFactory, googleConfigPort, googleSecretPort, reauthorizeGoogle } from '../../input/commands/google-connection-actions.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const progress: GoogleProgressPort = { stepStarted() {}, stepFinished() {}, humanActionNeeded() {}, note() {} };
const noCommands: GoogleCommandPort = { run: async () => ({ ok: false, exitCode: 1, stdout: '', stderr: '', timedOut: false, spawnError: 'no process in tests' }) } as unknown as GoogleCommandPort;
let previousPort: ReturnType<typeof installJudgmentPort>;
const disposals: (() => void)[] = [];
beforeEach(() => { previousPort = installJudgmentPort(fakePort(name => { throw new Error(`Unscripted judgment question ${name}`); }).port); });
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); installJudgmentPort(previousPort); });

async function connectedFixture() {
  const root = makeProjectTempDir('google-reauthorize');
  mkdirSync(join(root, 'project'), { recursive: true });
  const config = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json') });
  const secrets = new SecretsManager({ projectRoot: join(root, 'project'), globalHome: join(root, 'home'), daemonHome: join(root, 'daemon'), surfaceRoot: 'synthetic-google', configManager: config });
  const lifetime = createJudgmentSourceLifetime({ config, secrets, env: {} });
  disposals.push(lifetime.dispose);
  bindJudgmentPortAuthority(judgmentPort('test.google'), lifetime.capture);
  const context = {
    workspace: { shellPaths: { homeDirectory: root } },
    session: { runtime: { sessionId: 'reauthorize-session' } },
    platform: { configManager: config, secretsManager: secrets },
  } as unknown as CommandContext;
  googleConfigPort(context).set(GOOGLE_CONFIG_KEYS.oauthClientId, 'client-1.apps.example');
  await secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, 'client-secret-value');
  await secrets.set(GOOGLE_SECRET_KEYS.oauthRefreshToken, 'old-refresh-token');
  return { context, secrets, config };
}

function loopback(outcome: { readonly code: string } | { readonly error: string }) {
  return () => ({
    redirectUri: 'http://127.0.0.1:1/callback',
    waitForCode: async () => {
      if ('error' in outcome) throw new Error(outcome.error);
      return { code: outcome.code } as never;
    },
    close: () => {},
  });
}

describe('/google reauthorize', () => {
  test('a consent that is never completed leaves the working refresh token in place', async () => {
    const { context, secrets } = await connectedFixture();
    const outcome = await reauthorizeGoogle(context, progress, () => {}, {
      commands: noCommands,
      loopback: loopback({ error: 'the consent page was closed' }),
    });
    expect(outcome.connected).toBe(false);
    expect(await secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('old-refresh-token');
    expect(outcome.text).toContain('Paused');
    expect(outcome.text).toContain('previous refresh token was kept');
  });

  test('a completed consent replaces the old token with the one Google issued', async () => {
    const { context, secrets } = await connectedFixture();
    const outcome = await reauthorizeGoogle(context, progress, () => {}, {
      commands: noCommands,
      loopback: loopback({ code: 'auth-code' }),
      fetchPort: { fetch: async () => new Response(JSON.stringify({ access_token: 'access', refresh_token: 'new-refresh-token', expires_in: 3600, scope: 'x', token_type: 'Bearer' }), { status: 200, headers: { 'content-type': 'application/json' } }) },
      proveConnection: async () => ({ ok: true, detail: 'proved' }),
    });
    expect(outcome.connected).toBe(true);
    expect(await secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('new-refresh-token');
    expect(outcome.text).not.toContain('previous refresh token was kept');
  });

  test('a refresh token that cannot be deleted stops the re-authorization instead of reporting it already authorized', async () => {
    const { context, secrets } = await connectedFixture();
    const realDelete = secrets.delete.bind(secrets);
    secrets.delete = async (key: string) => {
      if (key === GOOGLE_SECRET_KEYS.oauthRefreshToken) throw new Error('store is read-only');
      return realDelete(key);
    };
    let consentOpened = false;
    const outcome = await reauthorizeGoogle(context, progress, () => {}, {
      commands: noCommands,
      loopback: () => { consentOpened = true; return loopback({ code: 'auth-code' })(); },
    });
    expect(outcome.connected).toBe(false);
    expect(consentOpened).toBe(false);
    expect(outcome.text).not.toContain('already authorized');
    expect(await secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('old-refresh-token');
  });

  test('with no OAuth client it refuses before touching any credential', async () => {
    const { context, secrets } = await connectedFixture();
    await secrets.delete(GOOGLE_SECRET_KEYS.oauthClientSecret);
    const outcome = await reauthorizeGoogle(context, progress, () => {}, { commands: noCommands });
    expect(outcome.connected).toBe(false);
    expect(await secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('old-refresh-token');
  });
});

describe('google setup browser', () => {
  test('one shell context drives one browser, so a re-run reuses the window the first run left open', async () => {
    const { context } = await connectedFixture();
    const first = googleBrowserFactory(context);
    const second = googleBrowserFactory(context);
    expect(second).toBe(first);
    expect(await second()).toBe(await first());
    const other = (await connectedFixture()).context;
    expect(googleBrowserFactory(other)).not.toBe(first);
  });

  test('the secret port carries the same store the flow reads', async () => {
    const { context, secrets } = await connectedFixture();
    expect(await googleSecretPort(context).get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe(await secrets.get(GOOGLE_SECRET_KEYS.oauthRefreshToken));
  });
});
