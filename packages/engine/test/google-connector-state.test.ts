/**
 * The Google connector's stored state and its reports about it: what is told
 * as true when a store cannot be read, a client is replaced, a grant fails, a
 * call never reaches Google, or a page is read back.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { googleSetupFixturePort } from './_helpers/google-setup-readings.ts';
import { removeGoogleCredentials } from '../platform/src/platform/google/credential-removal.ts';
import { planGoogleConnection } from '../platform/src/platform/google/discovery.ts';
import { repairHalfLandedGoogleConnection } from '../platform/src/platform/google/connection-repair.ts';
import { storeClientCredentials } from '../platform/src/platform/google/consent-session.ts';
import { diagnoseInvalidGrant } from '../platform/src/platform/google/grant-diagnosis.ts';
import { deliveredRecipientFromDeliveryHeaders } from '../platform/src/platform/google/delivery-evidence.ts';
import { normalizeEmailAddress } from '../platform/src/platform/google/signup-address.ts';
import { parseAuthenticationResults } from '../platform/src/platform/google/sender-authentication.ts';
import { isPermanentFetchProblem } from '../platform/src/platform/google/history-delta.ts';
import { adoptExistingGoogleCredentials } from '../platform/src/platform/google/setup-actions-adoption.ts';
import { buildCloudProjectRunners } from '../platform/src/platform/google/setup-actions-cloud-project.ts';
import type { GoogleSetupActionDeps } from '../platform/src/platform/google/setup-action-deps.ts';
import { createAppPassword } from '../platform/src/platform/google/app-password-flow.ts';
import { createDesktopOAuthClient } from '../platform/src/platform/google/console-flow.ts';
import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS, stepSpec } from '../platform/src/platform/google/setup-plan.ts';
import type {
  GoogleBrowserElement,
  GoogleBrowserPort,
  GoogleCommandPort,
  GoogleCommandResult,
  GoogleConfigPort,
  GoogleSecretPort,
} from '../platform/src/platform/google/types.ts';
import type { GoogleFilePort } from '../platform/src/platform/google/credential-adoption.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(googleSetupFixturePort().port); });
afterEach(() => { installJudgmentPort(previousPort); });

const HOME = '/home/tester';

interface MemorySecrets extends GoogleSecretPort {
  readonly values: Map<string, string>;
  readonly writes: string[];
  failGet: boolean;
  failDeleteOf: string | null;
}

function memorySecrets(initial: Record<string, string> = {}): MemorySecrets {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  const store: MemorySecrets = {
    values,
    writes,
    failGet: false,
    failDeleteOf: null,
    async get(key) {
      if (store.failGet) throw new Error('the keychain is locked');
      return values.get(key) ?? null;
    },
    async set(key, value) {
      writes.push(key);
      values.set(key, value);
    },
    async delete(key) {
      if (store.failDeleteOf === key) throw new Error('keychain refused');
      values.delete(key);
    },
  };
  return store;
}

function memoryConfig(initial: Record<string, string> = {}): GoogleConfigPort & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => { values.set(key, String(value)); },
  };
}

const noCommands: GoogleCommandPort = {
  async run() { return { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'none' }; },
};

describe('credential removal does not mistake a broken store for an empty one', () => {
  test('an unreadable store is refused, not reported as nothing stored', async () => {
    const secrets = memorySecrets({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'token' });
    secrets.failGet = true;
    const result = await removeGoogleCredentials({ secrets, config: memoryConfig() }, { items: ['refresh-token'], confirmed: true });
    expect(result.confirmed).toBe(false);
    expect('refused' in result).toBe(true);
    expect('prompt' in result ? result.prompt : '').not.toContain('none of those credentials');
    expect(secrets.values.has(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe(true);
  });

  test('a delete that fails part way reports what is already gone and what is left', async () => {
    const secrets = memorySecrets({
      [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'token',
      [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'secret',
    });
    secrets.failDeleteOf = GOOGLE_SECRET_KEYS.oauthClientSecret;
    const result = await removeGoogleCredentials(
      { secrets, config: memoryConfig() },
      { items: ['refresh-token', 'client-secret'], confirmed: true },
    );
    expect('partial' in result && result.partial).toBe(true);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0]).toContain('refresh token');
    expect('wouldRemove' in result ? result.wouldRemove : []).toHaveLength(1);
    expect('detail' in result ? result.detail : '').toContain('stopped');
  });
});

describe('planning a connection', () => {
  test('an unreadable store is raised, not routed to a new-client walkthrough', async () => {
    const secrets = memorySecrets();
    secrets.failGet = true;
    await expect(
      planGoogleConnection({ config: memoryConfig(), secrets, commands: noCommands, homeDirectory: HOME }),
    ).rejects.toThrow(/could not be read/);
  });
});

describe('repairing a half-landed connection', () => {
  function files(tokenInFile: string): GoogleFilePort {
    const contents = new Map<string, string>([
      [`${HOME}/.gmail-mcp/gcp-oauth.keys.json`, JSON.stringify({ installed: { client_id: 'abc.apps.googleusercontent.com', client_secret: 'GOCSPX-x' } })],
      [`${HOME}/.gmail-mcp/credentials.json`, JSON.stringify({ refresh_token: tokenInFile })],
    ]);
    return { exists: (path) => contents.has(path), readText: (path) => contents.get(path) ?? null };
  }

  test('files holding a different token are reported as needing a confirmation, not as gone', async () => {
    const secrets = memorySecrets({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'stored-token' });
    const result = await repairHalfLandedGoogleConnection({
      files: files('another-token'), config: memoryConfig(), secrets, homeDirectory: HOME,
    });
    expect(result.outcome).toBe('needs-confirmation');
    expect(secrets.values.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('stored-token');
  });

  test('a client id and secret with no refresh token is not reported complete', async () => {
    const secrets = memorySecrets({ [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'secret' });
    const config = memoryConfig({ [GOOGLE_CONFIG_KEYS.oauthClientId]: 'abc.apps.googleusercontent.com' });
    const result = await repairHalfLandedGoogleConnection({
      files: files('whatever'), config, secrets, homeDirectory: HOME,
    });
    expect(result.outcome).toBe('incomplete');
    expect(result.detail).toContain('refresh token');
  });
});

describe('registering a different OAuth client over a connected one', () => {
  const OLD = 'old-111.apps.googleusercontent.com';
  const NEW = 'new-222.apps.googleusercontent.com';

  test('the refresh token that belonged to the old client is cleared and a new consent is asked for', async () => {
    const secrets = memorySecrets({
      [GOOGLE_SECRET_KEYS.oauthClientSecret]: 'old-secret',
      [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'old-token',
    });
    const config = memoryConfig({ [GOOGLE_CONFIG_KEYS.oauthClientId]: OLD });
    const result = await storeClientCredentials({ config, secrets }, {
      clientId: NEW, clientSecret: 'GOCSPX-new', authUri: 'a', tokenUri: 't',
    });
    expect(result).toMatchObject({ ok: true, consentRequired: true });
    expect(secrets.values.has(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe(false);
    expect(config.values.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe(NEW);
  });

  test('registering the same client again keeps the token', async () => {
    const secrets = memorySecrets({ [GOOGLE_SECRET_KEYS.oauthRefreshToken]: 'token' });
    const config = memoryConfig({ [GOOGLE_CONFIG_KEYS.oauthClientId]: OLD });
    const result = await storeClientCredentials({ config, secrets }, {
      clientId: OLD, clientSecret: 'GOCSPX-new', authUri: 'a', tokenUri: 't',
    });
    expect(result.ok && result.consentRequired).toBeFalsy();
    expect(secrets.values.get(GOOGLE_SECRET_KEYS.oauthRefreshToken)).toBe('token');
  });

  test('a secret the store refuses leaves the configured client id alone', async () => {
    const secrets = memorySecrets();
    secrets.set = async () => { throw new Error('store is read-only'); };
    const config = memoryConfig({ [GOOGLE_CONFIG_KEYS.oauthClientId]: OLD });
    await expect(storeClientCredentials({ config, secrets }, {
      clientId: NEW, clientSecret: 'GOCSPX-new', authUri: 'a', tokenUri: 't',
    })).rejects.toThrow();
    expect(config.values.get(GOOGLE_CONFIG_KEYS.oauthClientId)).toBe(OLD);
  });
});

describe('diagnosing an invalid grant', () => {
  test('a gcloud account that differs from the configured one does not hide a revocation Google reported', async () => {
    const fake = fakePort((name) => noulAnswer(name === 'revoked' ? 0.99 : 0.01));
    installJudgmentPort(fake.port);
    const result = await diagnoseInvalidGrant({
      googleError: 'Token has been expired or revoked.',
      intendedAccount: 'agent@example.com',
      signedInAccount: 'me@example.com',
      publishingStatus: 'unknown',
      credentialOrigin: 'secret-store',
    });
    expect(result.cause).toBe('revoked');
  });
});

describe('delivery evidence', () => {
  test('a Delivered-To header with a display name compares equal to the stored recipient address', () => {
    const evidence = deliveredRecipientFromDeliveryHeaders(['Alias <A@x.test>']);
    expect(evidence?.address).toBe(normalizeEmailAddress('a@x.test'));
  });
});

describe('sender authentication', () => {
  test('a result named only inside a comment is not read as a result', () => {
    const checks = parseAuthenticationResults('mx.example; spf=pass smtp.mailfrom=a.test (was dkim=pass at the edge); dmarc=fail header.from=a.test');
    expect(checks.dkim).toBeUndefined();
    expect(checks.spf).toBe('pass');
    expect(checks.dmarc).toBe('fail');
  });
});

describe('which unreadable-message answers can never clear', () => {
  test('a malformed-id answer is permanent; no status, a refused credential, a rate limit and a server error are not', () => {
    expect(isPermanentFetchProblem({ status: 400 })).toBe(true);
    expect(isPermanentFetchProblem({ status: 410 })).toBe(true);
    expect(isPermanentFetchProblem({ status: null })).toBe(false);
    expect(isPermanentFetchProblem({ status: 401 })).toBe(false);
    expect(isPermanentFetchProblem({ status: 403 })).toBe(false);
    expect(isPermanentFetchProblem({ status: 429 })).toBe(false);
    expect(isPermanentFetchProblem({ status: 503 })).toBe(false);
  });
});

describe('adopting credentials that are present but unusable', () => {
  test('says the file could not be used instead of saying nothing was found', async () => {
    const present = `${HOME}/.gmail-mcp/gcp-oauth.keys.json`;
    const outcome = await adoptExistingGoogleCredentials({
      files: { exists: (path) => path === present, readText: () => null },
      config: memoryConfig(),
      secrets: memorySecrets(),
      homeDirectory: HOME,
    });
    expect(outcome.adopted).toBe(false);
    expect(outcome.detail).toContain('could not be used');
    expect(outcome.detail).not.toContain('No adoptable');
  });
});

describe('a resumed setup finds gcloud where the installer put it', () => {
  test('the sign-in check uses the home-directory gcloud when the installed step did not run in this process', async () => {
    const home = `${HOME}/google-cloud-sdk/bin/gcloud`;
    const calls: string[] = [];
    const commands: GoogleCommandPort = {
      async run(command, args): Promise<GoogleCommandResult> {
        calls.push(`${command} ${args.join(' ')}`);
        if (command === home && args[0] === '--version') return { code: 0, stdout: 'Google Cloud SDK 1.0.0', stderr: '', timedOut: false, spawnError: null };
        if (command === home && args[0] === 'auth') {
          return { code: 0, stdout: JSON.stringify([{ account: 'me@example.com', status: 'ACTIVE' }]), stderr: '', timedOut: false, spawnError: null };
        }
        return { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'not found' };
      },
    };
    const deps = { commands, homeDirectory: HOME, config: memoryConfig() } as unknown as GoogleSetupActionDeps;
    const runner = buildCloudProjectRunners(deps).get('gcloud-authenticated');
    const result = await runner?.(stepSpec('gcloud-authenticated'));
    expect(result?.outcome).toBe('already-done');
    expect(calls.some((call) => call.startsWith(`${home} auth list`))).toBe(true);
  });
});

describe('reading a created credential back from a page', () => {
  function el(ref: string, role: string, name: string): GoogleBrowserElement {
    return { ref, role, name, tag: 'div', value: undefined };
  }

  /** A page whose text changes when `create-btn` is clicked. */
  function pagePort(before: string, after: string): GoogleBrowserPort {
    let clicked = false;
    return {
      navigate: async (url) => ({ url, title: 't' }),
      currentUrl: async () => 'https://myaccount.google.com/apppasswords',
      snapshot: async () => [el('name-field', 'textbox', 'App name'), el('create-btn', 'button', 'Create'), el('create-client-btn', 'button', 'CREATE CLIENT')],
      readText: async () => (clicked ? after : before),
      click: async (ref) => { if (ref === 'create-btn') clicked = true; },
      type: async () => undefined,
    };
  }

  test('four short words of ordinary page text before the click are never taken for the app password', async () => {
    const prose = 'Name that will help with remembering where this is used';
    const result = await createAppPassword(pagePort(prose, prose));
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') expect(result.reason).toBe('result-dialog-not-found');
  });

  test('a password that appears only after the click is read, even with prose before it', async () => {
    const prose = 'Name that will help with remembering where this is used';
    const result = await createAppPassword(pagePort(prose, `${prose}\nwxyz abcd efgh ijkl`));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.password).toBe('wxyzabcdefghijkl');
  });

  test('an older client listed on the page is not paired with the new secret', async () => {
    const OLD = 'older-111.apps.googleusercontent.com';
    const NEW = 'newer-222.apps.googleusercontent.com';
    const pages: Record<string, { url: string; elements: GoogleBrowserElement[]; text: string }> = {
      list: { url: 'https://console.cloud.google.com/auth/clients', elements: [el('create-client-btn', 'button', 'CREATE CLIENT')], text: `Clients\n${OLD}` },
      type: { url: 'https://console.cloud.google.com/auth/clients', elements: [el('type-combobox', 'combobox', 'Application type')], text: `Clients\n${OLD}` },
      options: { url: 'https://console.cloud.google.com/auth/clients', elements: [el('desktop-option', 'option', 'Desktop app')], text: '' },
      form: { url: 'https://console.cloud.google.com/auth/clients', elements: [el('name-field-el', 'textbox', 'Name'), el('create-btn', 'button', 'Create')], text: '' },
      created: { url: 'https://console.cloud.google.com/auth/clients', elements: [], text: `Clients\n${OLD}\nClient ID\n${NEW}\nClient secret\nGOCSPX-fresh-secret` },
    };
    const next: Record<string, Record<string, string>> = {
      list: { 'create-client-btn': 'type' }, type: { 'type-combobox': 'options' },
      options: { 'desktop-option': 'form' }, form: { 'create-btn': 'created' },
    };
    let state = 'list';
    const port: GoogleBrowserPort = {
      navigate: async (url) => ({ url, title: 't' }),
      currentUrl: async () => pages[state]!.url,
      snapshot: async () => pages[state]!.elements,
      readText: async () => pages[state]!.text,
      click: async (ref) => { state = next[state]?.[ref] ?? state; },
      type: async () => undefined,
    };
    const result = await createDesktopOAuthClient(port, { name: 'goodvibes agent' });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.clientId).toBe(NEW);
      expect(result.clientSecret).toBe('GOCSPX-fresh-secret');
    }
  });
});
