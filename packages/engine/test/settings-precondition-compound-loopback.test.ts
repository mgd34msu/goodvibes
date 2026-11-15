/** Real transport/config/secret/auth owners; all credentials and stores are synthetic. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { SecretsManager } from '../platform/src/platform/config/secrets.js';
import { daemonSecretKeyFor } from '../platform/src/platform/config/daemon-secret-keys.js';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.js';
import { captureRemoteSettingsPrecondition, resolvePreparedConfigWriteRoute } from '../platform/src/platform/config/settings-precondition-client.js';
import { acquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
import { createDaemonConfigClient } from '../platform/src/platform/runtime/client/config-client.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const key = 'surfaces.telegram.botToken';
const secretKey = daemonSecretKeyFor(key);
function fixture(kind: 'shared' | 'session' = 'shared') {
  const root = mkdtempSync(join(tmpdir(), 'settings-compound-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); const project = join(root, 'project'); const daemon = join(root, 'daemon');
  for (const path of [home, project, daemon]) mkdirSync(path, { recursive: true });
  const config = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(daemon, 'settings.json') });
  const secrets = new SecretsManager({ projectRoot: project, globalHome: home, daemonHome: daemon, surfaceRoot: 'daemon', policy: 'plaintext_allowed' });
  const credentialPath = join(daemon, 'secrets.json');
  writeFileSync(credentialPath, JSON.stringify({ version: 1, secrets: { [secretKey]: 'synthetic-daemon-value', unrelated: 'synthetic-retained' } }));
  const userPath = join(home, '.goodvibes', 'daemon.secrets.json'); mkdirSync(join(home, '.goodvibes'), { recursive: true });
  writeFileSync(userPath, JSON.stringify({ version: 1, secrets: { [secretKey]: 'synthetic-other-scope' } }));
  config.setDynamic(key, `goodvibes://secrets/goodvibes/${secretKey}`);
  const pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const users = new UserAuthManager({ users: [{ username: 'fixture', passwordHash: 'synthetic-unused', roles: ['admin'] }],
    bootstrapFilePath: join(root, 'unused.json'), bootstrapCredentialPath: join(root, 'unused.txt') });
  let lifetime: object | null = {};
  const sharedToken = 'synthetic-loopback-settings';
  const session = users.createSession('fixture');
  const token = kind === 'shared' ? sharedToken : session.token;
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: new GatewayMethodCatalog(), authToken: () => sharedToken, trustProxyEnabled: () => false, pairingTokens: pairing, userAuth: users,
    settingsLifetime: () => lifetime } as unknown as DaemonControlPlaneContext);
  const authority = { settingsLifetime: () => lifetime, captureSettingsAdminAuthority: helper.captureSettingsAdminAuthority.bind(helper), withSettingsAdminAuthority: helper.withSettingsAdminAuthority.bind(helper) };
  const context = { configManager: config, settingsAuthority: authority, secretsManager: secrets, runtimeStore: null,
    userAuth: users, authToken: () => sharedToken, requireAdmin: (req: Request) => helper.requireAdmin(req),
    requireAuthenticatedSession: () => null, extractAuthToken: () => token, describeAuthenticatedPrincipal: () => null, authenticateRequest: () => null,
    controlPlaneGateway: { recordApiRequest() {} }, swapManager: null };
  const router = new DaemonHttpRouter(context as never); cleanup.push(() => router.dispose());
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async req => await router.dispatchApiRoutes(req) ?? new Response('', { status: 404 }) });
  cleanup.push(() => { server.stop(true); });
  let requests = 0; let loseResponse = false;
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => { requests++; const response = await fetch(...args); if (loseResponse && requests > 1) throw new Error('synthetic response loss'); return response; }) as typeof fetch;
  const endpoint = { baseUrl: server.url.origin, token, source: 'synthetic' };
  const client = createDaemonConfigClient({ probe: () => ({ available: true }), invoke: async () => { throw new Error('Legacy route forbidden'); },
    captureSettingsPrecondition: request => captureRemoteSettingsPrecondition(endpoint, request, { fetchImpl }) });
  return { root, home, config, secrets, context, credentialPath, userPath, capability: client.preparedSettings!, requests: () => requests,
    revoke: () => { if (kind === 'shared') pairing.revokeLegacyShared(); else users.revokeSession(session.token); }, restart: () => { lifetime = {}; }, loseResponse: () => { loseResponse = true; } };
}

for (const operation of ['set', 'reset-default'] as const) test(`real loopback compound ${operation} publishes config before clearing the exact credential scope`, async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation, key, ...(operation === 'set' ? { value: '' } : {}), credentialClear: true });
  const facts = f.capability.inspect(prepared);
  expect(facts.credential?.key).toBe(secretKey); expect(facts.credential?.scope).toBe('daemon');
  expect(facts.destinations.map(d => d.operation)).toEqual(['set', 'remove']);
  expect(JSON.stringify(facts)).not.toContain('synthetic-daemon-value');
  const receipt = await f.capability.apply(prepared);
  expect(receipt.status).toBe('committed'); expect(receipt.completedPaths).toEqual(facts.destinations.map(d => d.path));
  expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets).toEqual({ unrelated: 'synthetic-retained' });
  expect(JSON.parse(readFileSync(f.userPath, 'utf8')).secrets[secretKey]).toBe('synthetic-other-scope');
  expect(f.config.get(key)).toBe('');
  await expect(f.capability.apply(prepared)).rejects.toThrow(); expect(f.requests()).toBe(2);
});
for (const change of ['revoke', 'restart', 'replaceConfig', 'replaceSecret'] as const) test(`real loopback ${change} retires compound owner before effect`, async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key, value: '', credentialClear: true });
  if (change === 'replaceConfig') f.context.configManager = new ConfigManager({ configDir: join(f.root, 'other-config') });
  else if (change === 'replaceSecret') f.context.secretsManager = new SecretsManager({ projectRoot: join(f.root, 'project'), globalHome: f.home, surfaceRoot: 'daemon', policy: 'plaintext_allowed' });
  else f[change]();
  expect((await f.capability.apply(prepared)).status).toBe('unknown');
  expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets[secretKey]).toBe('synthetic-daemon-value');
});
test('revocation after the config is published reports it, leaves an orphan credential and stops the credential tail', async () => {
  const f = fixture('session');
  const prepared = await f.capability.capture({ operation: 'set', key, value: '', credentialClear: true });
  const [configDestination, credentialDestination] = f.capability.inspect(prepared).destinations;
  f.config.subscribe(key, f.revoke);
  const receipt = await f.capability.apply(prepared);
  expect(receipt.status).toBe('partial'); expect(receipt.completedPaths).toEqual([configDestination!.path]);
  expect(receipt.uncertainPath).toBe(credentialDestination!.path);
  expect(f.config.get(key)).toBe('');
  // The failure leaves the credential behind, never config pointing at a missing credential.
  expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets[secretKey]).toBe('synthetic-daemon-value');
});
test('response loss after compound effect is unknown, asked once more with the same request id, and cannot replay', async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key, value: '', credentialClear: true });
  f.loseResponse(); expect((await f.capability.apply(prepared)).status).toBe('unknown');
  expect(f.config.get(key)).toBe(''); await expect(f.capability.apply(prepared)).rejects.toThrow(); expect(f.requests()).toBe(3);
});
test('credential reference set is config-only and raw material never leaves the client', async () => {
  const f = fixture();
  await expect(f.capability.capture({ operation: 'set', key, value: 'synthetic-raw-value' })).rejects.toThrow(); expect(f.requests()).toBe(0);
  const prepared = await f.capability.capture({ operation: 'set', key, value: 'goodvibes://secrets/example/other' });
  expect(f.capability.inspect(prepared).credential).toBeUndefined(); expect((await f.capability.apply(prepared)).status).toBe('committed');
  expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets[secretKey]).toBe('synthetic-daemon-value');
});

test('revocation while exact credential file lock is awaited fences both compound effects', async () => {
  const f = fixture(); const prepared = await f.capability.capture({ operation: 'set', key, value: '', credentialClear: true });
  const release = await acquireCrossProcessLock(`${f.credentialPath}.mutation.lock`, { strictOwnership: true });
  const entered = Promise.withResolvers<void>();
  const original = f.secrets.withPreparedScopedDeletion.bind(f.secrets);
  f.secrets.withPreparedScopedDeletion = (handle, operation) => { entered.resolve(); return original(handle, operation); };
  try {
    const applying = f.capability.apply(prepared); await entered.promise;
    f.revoke(); release();
    expect((await applying).status).toBe('unknown');
    expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets[secretKey]).toBe('synthetic-daemon-value');
    expect(f.config.get(key)).not.toBe('');
  } finally { release(); }
});

test('same secret owner replacement after the config is published stops the credential tail', async () => {
  const f = fixture();
  const prepared = await f.capability.capture({ operation: 'set', key, value: '', credentialClear: true });
  const configPath = f.capability.inspect(prepared).destinations[0]!.path;
  let replacing: Promise<void> | undefined;
  const unsubscribe = f.config.subscribe(key, () => { unsubscribe(); replacing = f.secrets.set(secretKey, 'synthetic-replacement', { scope: 'daemon', medium: 'plaintext' }); });
  const receipt = await f.capability.apply(prepared);
  expect(receipt.status).toBe('partial'); expect(receipt.completedPaths).toEqual([configPath]);
  expect(f.config.get(key)).toBe(''); await replacing;
  expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets[secretKey]).toBe('synthetic-replacement');
});

test('external credential store replacement after the config is published cannot authorize the credential tail', async () => {
  const f = fixture();
  const prepared = await f.capability.capture({ operation: 'set', key, value: '', credentialClear: true });
  const configPath = f.capability.inspect(prepared).destinations[0]!.path;
  f.config.subscribe(key, () => { writeFileSync(f.credentialPath, JSON.stringify({ version: 1, secrets: { [secretKey]: 'synthetic-external-replacement' } })); });
  const receipt = await f.capability.apply(prepared);
  expect(receipt.status).toBe('partial'); expect(receipt.completedPaths).toEqual([configPath]);
  expect(JSON.parse(readFileSync(f.credentialPath, 'utf8')).secrets[secretKey]).toBe('synthetic-external-replacement');
});

test('route observation callback cannot replace the captured installation after its guard', async () => {
  let current = true; let observations = 0;
  const assertOwner = () => { if (!current) throw new Error('Synthetic installation replaced'); };
  await expect(resolvePreparedConfigWriteRoute('controlPlane.port', { hostsDaemon: false, daemonHomeDir: '/synthetic',
    readRuntimeRecord: () => { if (++observations === 2) current = false; return null; }, readDaemonBinding: () => null,
  }, assertOwner)).rejects.toThrow();
  expect(observations).toBe(2);
});
