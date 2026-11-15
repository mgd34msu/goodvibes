import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LiteralSecretsManager } from '../platform/src/platform/config/secret-literals.js';
import { SecretsManager } from '../platform/src/platform/config/secrets.js';
import { loadOrCreateKeyfile, SecretStoreUnreadableError } from '../platform/src/platform/config/secrets-keyfile.js';
import { SECRET_CONFIG_KEYS } from '../platform/src/platform/config/secret-backed-config.js';
import { SECRET_BEARING_CONFIG_PATHS } from '../platform/src/platform/config/secret-bearing-config-keys.js';
import { buildSecretBackedConfigUpdate } from '../platform/src/platform/config/secret-backed-config.js';
import type { ConfigKey } from '../platform/src/platform/config/schema.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Policy = 'plaintext_allowed' | 'preferred_secure' | 'require_secure';

function fixture(policy: Policy = 'plaintext_allowed') {
  const root = makeProjectTempDir('secrets-store-safety'); roots.push(root);
  const options = { surfaceRoot: 'agent', projectRoot: join(root, 'project'), globalHome: join(root, 'home'), policy } as const;
  mkdirSync(options.projectRoot, { recursive: true }); mkdirSync(options.globalHome, { recursive: true });
  return { root, options, keyfile: join(options.globalHome, '.goodvibes', 'secrets.key'), manager: new SecretsManager(options) };
}

/** Replace a private method for one test and hand back the way to put it back. */
function stubMethod(name: string, replacement: (...args: unknown[]) => unknown): () => void {
  const proto = SecretsManager.prototype as unknown as Record<string, unknown>;
  const original = proto[name];
  proto[name] = replacement;
  return () => { proto[name] = original; };
}

describe('references found in a project store', () => {
  function execRef(marker: string): string {
    return `secretref:${JSON.stringify({ source: 'exec', command: 'sh', args: ['-c', `echo ran > "${marker}"; printf resolved-value`] })}`;
  }

  test('are not executed, and the same reference in the user store still resolves', async () => {
    const f = fixture();
    const marker = join(f.root, 'marker');
    await f.manager.set('SAFETY_TEST_KEY', execRef(marker), { scope: 'project', medium: 'plaintext' });
    expect(await f.manager.get('SAFETY_TEST_KEY')).toBeNull();
    expect(existsSync(marker)).toBe(false);

    await f.manager.delete('SAFETY_TEST_KEY');
    await f.manager.set('SAFETY_TEST_KEY', execRef(marker), { scope: 'user', medium: 'plaintext' });
    expect(await f.manager.get('SAFETY_TEST_KEY')).toBe('resolved-value');
    expect(existsSync(marker)).toBe(true);
  });

  test('in the user store still run when the project sits under the home directory', async () => {
    const root = makeProjectTempDir('secrets-store-safety'); roots.push(root);
    const globalHome = join(root, 'home');
    const projectRoot = join(globalHome, 'Projects', 'x');
    mkdirSync(projectRoot, { recursive: true });
    const manager = new SecretsManager({ surfaceRoot: 'agent', projectRoot, globalHome, policy: 'plaintext_allowed' });
    const marker = join(root, 'marker');
    await manager.set('SAFETY_TEST_KEY', execRef(marker), { scope: 'user', medium: 'plaintext' });
    expect(await manager.get('SAFETY_TEST_KEY')).toBe('resolved-value');
    expect(existsSync(marker)).toBe(true);

    await manager.delete('SAFETY_TEST_KEY');
    const projectMarker = join(root, 'project-marker');
    await manager.set('SAFETY_TEST_KEY', execRef(projectMarker), { scope: 'project', medium: 'plaintext' });
    expect(await manager.get('SAFETY_TEST_KEY')).toBeNull();
    expect(existsSync(projectMarker)).toBe(false);
  });

  test('an env reference in a project store is refused', async () => {
    const f = fixture();
    process.env.SAFETY_ENV_TARGET = 'from-environment';
    try {
      await f.manager.set('SAFETY_ENV_ALIAS', 'goodvibes://secrets/env/SAFETY_ENV_TARGET', { scope: 'project', medium: 'plaintext' });
      expect(await f.manager.get('SAFETY_ENV_ALIAS')).toBeNull();
    } finally {
      delete process.env.SAFETY_ENV_TARGET;
    }
  });

  test('a plain value in a project store never shadows the user store', async () => {
    const f = fixture();
    await f.manager.set('SAFETY_SHADOW_KEY', 'user-real', { scope: 'user', medium: 'plaintext' });
    await f.manager.set('SAFETY_SHADOW_KEY', 'attacker', { scope: 'project', medium: 'plaintext' });
    expect(await f.manager.get('SAFETY_SHADOW_KEY')).toBe('user-real');
    await f.manager.set('SAFETY_ONLY_PROJECT', 'project-value', { scope: 'project', medium: 'plaintext' });
    expect(await f.manager.get('SAFETY_ONLY_PROJECT')).toBe('project-value');
  });

  test('may still point at another GoodVibes secret', async () => {
    const f = fixture();
    await f.manager.set('SAFETY_TARGET', 'plain-target', { scope: 'user', medium: 'plaintext' });
    await f.manager.set('SAFETY_ALIAS', 'goodvibes://secrets/goodvibes/SAFETY_TARGET', { scope: 'project', medium: 'plaintext' });
    expect(await f.manager.get('SAFETY_ALIAS')).toBe('plain-target');
  });
});

describe('a credential that looks like a reference', () => {
  test('reads back as written through every local reader', async () => {
    const f = fixture();
    const manager = new LiteralSecretsManager(f.options);
    await manager.set('LITERAL_KEY', 'op://vault/item/field', { scope: 'user', medium: 'plaintext' });
    await manager.set('LITERAL_ALIAS', 'goodvibes://secrets/goodvibes/LITERAL_KEY', { scope: 'user', medium: 'plaintext' });
    expect(await manager.get('LITERAL_KEY')).toBe('op://vault/item/field');
    expect(manager.resolveLocalSecretSync('LITERAL_KEY')).toEqual({ state: 'resolved', value: 'op://vault/item/field' });
    const snapshot = manager.resolveLocalCredentialSnapshot('LITERAL_KEY');
    expect(snapshot.state === 'resolved' && snapshot.value).toBe('op://vault/item/field');
    // The pointer is read by a plain manager over the same files, which has no literal pair installed.
    expect(await f.manager.get('LITERAL_ALIAS')).toBe('op://vault/item/field');
  });

  test('is stored as a literal by an import, so the next read does not run a provider CLI', async () => {
    const f = fixture();
    const handle = f.manager.prepareImport([{ key: 'IMPORTED_KEY', value: 'op://vault/item/field', scope: 'user' }]);
    const receipt = await f.manager.finishPreparedImport(handle, f.manager.beginPreparedImport(handle), () => {});
    expect(receipt.status).toBe('committed');
    expect(await f.manager.get('IMPORTED_KEY')).toBe('op://vault/item/field');
    expect(f.manager.resolveLocalSecretSync('IMPORTED_KEY')).toEqual({ state: 'resolved', value: 'op://vault/item/field' });
  });
});

describe('a committed import', () => {
  test('stays committed, and settles once, when releasing the store lock fails afterwards', async () => {
    const f = fixture();
    const handle = f.manager.prepareImport([{ key: 'SETTLED_KEY', value: 'value-one', scope: 'user' }]);
    const transition = f.manager.beginPreparedImport(handle);
    const proto = SecretsManager.prototype as unknown as { withStoreMutations: (...args: unknown[]) => Promise<unknown> };
    const original = proto.withStoreMutations;
    const restore = stubMethod('withStoreMutations', async function (this: unknown, ...args: unknown[]) {
      await original.apply(this, args);
      throw new Error('lock release failed');
    });
    let receipt;
    try { receipt = await f.manager.finishPreparedImport(handle, transition, () => {}); } finally { restore(); }
    expect(receipt.status).toBe('committed');
    expect(await f.manager.get('SETTLED_KEY')).toBe('value-one');
    // One settle moves the generation by exactly two over the whole import.
    expect(() => f.manager.assertCompletedImport(handle)).not.toThrow();
  });
});

describe('a secure write that fails under preferred_secure', () => {
  test('is refused while an older secure copy would keep winning', async () => {
    const f = fixture('preferred_secure');
    await f.manager.set('ROTATED_KEY', 'old-value', { scope: 'user', medium: 'secure' });
    const restore = stubMethod('writeEncryptedFile', () => { throw new Error('disk error'); });
    try {
      await expect(f.manager.set('ROTATED_KEY', 'new-value', { scope: 'user', medium: 'secure' })).rejects.toThrow('was not changed');
    } finally { restore(); }
    expect(await f.manager.get('ROTATED_KEY')).toBe('old-value');
    expect(existsSync(join(f.options.globalHome, '.goodvibes', 'agent.secrets.json'))).toBe(false);
  });

  test('still falls back to the plaintext store for a key with no secure copy', async () => {
    const f = fixture('preferred_secure');
    const restore = stubMethod('writeEncryptedFile', () => { throw new Error('disk error'); });
    try { await f.manager.set('FRESH_KEY', 'fresh-value', { scope: 'user', medium: 'secure' }); } finally { restore(); }
    expect(await f.manager.get('FRESH_KEY')).toBe('fresh-value');
  });
});

describe('deleting a key held in two stores', () => {
  test('tells listeners once when the second store fails after the first lost the key', async () => {
    const f = fixture();
    await f.manager.set('TWO_COPIES', 'a', { scope: 'project', medium: 'plaintext' });
    await f.manager.set('TWO_COPIES', 'a', { scope: 'user', medium: 'plaintext' });
    const changed: string[] = [];
    f.manager.onDidChange((key) => changed.push(key));
    const original = (SecretsManager.prototype as unknown as { writePlaintextFile: (...args: unknown[]) => void }).writePlaintextFile;
    let writes = 0;
    const restore = stubMethod('writePlaintextFile', function (this: unknown, ...args: unknown[]) {
      writes += 1;
      if (writes === 2) throw new Error('second store failed');
      original.apply(this, args);
    });
    try { await expect(f.manager.delete('TWO_COPIES')).rejects.toThrow('second store failed'); } finally { restore(); }
    expect(changed).toEqual(['TWO_COPIES']);
  });
});

describe('keys named like inherited properties', () => {
  test('are stored and read back as ordinary keys', async () => {
    const f = fixture();
    await f.manager.set('__proto__', 'proto-value', { scope: 'user', medium: 'plaintext' });
    expect(await f.manager.get('__proto__')).toBe('proto-value');
    expect(await f.manager.get('constructor')).toBeNull();
  });
});

describe('the encryption keyfile', () => {
  test('a read never creates one', async () => {
    const f = fixture('require_secure');
    await f.manager.set('KEYFILE_KEY', 'value', { scope: 'user', medium: 'secure' });
    rmSync(f.keyfile);
    const reader = new SecretsManager(f.options);
    expect(await reader.get('KEYFILE_KEY')).toBeNull();
    expect(await reader.list()).toEqual([]);
    expect(existsSync(f.keyfile)).toBe(false);
  });

  test('is published whole, with no temporary file left behind', () => {
    const f = fixture();
    const key = loadOrCreateKeyfile(f.keyfile);
    expect(readFileSync(f.keyfile, 'utf8').trim()).toBe(key.toString('hex'));
    expect(readdirSync(dirname(f.keyfile)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(loadOrCreateKeyfile(f.keyfile).equals(key)).toBe(true);
  });

  test('an empty one is reported as interrupted creation, naming the way out', () => {
    const f = fixture();
    mkdirSync(dirname(f.keyfile), { recursive: true });
    writeFileSync(f.keyfile, '');
    expect(() => loadOrCreateKeyfile(f.keyfile)).toThrow(SecretStoreUnreadableError);
    expect(() => loadOrCreateKeyfile(f.keyfile)).toThrow('delete this file');
  });
});

describe('credential keys', () => {
  // Declared credentials that are deliberately not routed through the secret store by the
  // platform's own set: references by design, or written by a dedicated flow.
  const NOT_ROUTED: ReadonlySet<string> = new Set([
    'calendar.google.clientSecretRef', 'calendar.microsoft.clientSecretRef',
    'calendar.google.icsUrl', 'google.oauth.refreshToken',
    'cloudflare.apiTokenRef', 'cloudflare.workerTokenRef', 'cloudflare.workerClientTokenRef',
    'cloudflare.tunnelTokenRef', 'cloudflare.accessServiceTokenRef',
    'cluster.groupMaterial', 'cluster.secret',
  ]);

  test('every declared credential key is routed through the secret store or listed as deliberately not', () => {
    const unrouted = SECRET_BEARING_CONFIG_PATHS.filter((key) => !SECRET_CONFIG_KEYS.has(key as ConfigKey) && !NOT_ROUTED.has(key));
    expect(unrouted).toEqual([]);
  });

  test('a webhook URL carrying a token is stored as a reference, not in clear', () => {
    const update = buildSecretBackedConfigUpdate('surfaces.webhook.defaultTarget' as ConfigKey, ' https://hooks.example.test/T/B/token\n');
    expect(update.secretValue).toBe('https://hooks.example.test/T/B/token');
    expect(update.configValue.startsWith('goodvibes://secrets/')).toBe(true);
    expect(SECRET_CONFIG_KEYS.has('surfaces.webhook.defaultTarget' as ConfigKey)).toBe(true);
    expect(SECRET_CONFIG_KEYS.has('surfaces.googleChat.webhookUrl' as ConfigKey)).toBe(true);
  });
});
