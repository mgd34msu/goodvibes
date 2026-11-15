/**
 * cloudflare-control-plane-safety.test.ts, what the Cloudflare control plane
 * refuses to do, and what it reports when it stops half way.
 *
 * Each test drives the manager (or the one resource helper under test) against
 * a recording stand-in for the Cloudflare client, and asserts on the calls that
 * did or did not reach it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { CloudflareControlPlaneManager } from '../platform/src/platform/cloudflare/manager.js';
import { GOODVIBES_CLOUDFLARE_WORKER_MODULE } from '../platform/src/platform/cloudflare/worker-source.js';
import { normalizeProvisionHostnames } from '../platform/src/platform/cloudflare/hostnames.js';
import { configureDns, ensureAccess, ensureKvNamespace, ensureTunnel, type CloudflareProvisioningContext } from '../platform/src/platform/cloudflare/resources.js';
import { CloudflareControlPlaneError } from '../platform/src/platform/cloudflare/types.js';
import type {
  CloudflareAccessApplicationLike,
  CloudflareApiClient,
  CloudflareDnsRecordLike,
  CloudflareProvisionStep,
  CloudflareQueueLike,
  CloudflareTokenPolicyParam,
  CloudflareZoneLike,
} from '../platform/src/platform/cloudflare/types.js';

function makeConfigManager(): ConfigManager {
  const configDir = join(tmpdir(), `gv-cloudflare-safety-${crypto.randomUUID()}`);
  mkdirSync(configDir, { recursive: true });
  return new ConfigManager({ configDir });
}

function makeSecrets(options: { readonly failSet?: boolean; readonly initial?: Record<string, string> } = {}) {
  const values: Record<string, string> = { ...(options.initial ?? {}) };
  return {
    values,
    async get(key: string): Promise<string | null> { return values[key] ?? null; },
    async set(key: string, value: string): Promise<void> {
      if (options.failSet) throw new Error('secret store is read-only');
      values[key] = value;
    },
    getGlobalHome(): string { return tmpdir(); },
  };
}

async function* items<T>(entries: readonly T[]): AsyncIterable<T> {
  for (const entry of entries) yield entry;
}

/** A client that only knows what the token and Worker paths touch, and counts writes. */
function makeClient(options: {
  readonly zones?: readonly CloudflareZoneLike[];
  readonly failSecretUpdate?: boolean;
  readonly failAccountGet?: boolean;
  readonly failScheduleUpdate?: boolean;
  readonly queueCount?: number;
} = {}) {
  const calls = {
    tokenCreates: 0,
    accountGets: 0,
    workerUpdates: [] as Array<Record<string, unknown>>,
    secretUpdates: [] as string[],
    scheduleUpdates: 0,
  };
  const queues: CloudflareQueueLike[] = Array.from({ length: options.queueCount ?? 0 }, (_, index) => ({ queue_id: `q${index}`, queue_name: `queue-${index}` }));
  let lastPolicies: readonly CloudflareTokenPolicyParam[] = [];
  const client = {
    accounts: {
      list() { return items([{ id: 'acct-1', name: 'Test', type: 'standard' }]); },
      async get(params: { account_id: string }) {
        calls.accountGets += 1;
        if (options.failAccountGet) throw new Error('Cloudflare rejected the token');
        return { id: params.account_id, name: 'Test', type: 'standard' };
      },
    },
    user: {
      tokens: {
        async create(params: { name: string; policies: readonly CloudflareTokenPolicyParam[] }) {
          calls.tokenCreates += 1;
          lastPolicies = params.policies;
          return { id: 'token-1', name: params.name, value: 'operational-token', policies: params.policies };
        },
        async get(tokenId: string) { return { id: tokenId, name: 'n', policies: lastPolicies }; },
        async verify() { return { id: 'u', status: 'active' }; },
        permissionGroups: {
          list() {
            return items([
              { id: 'pg-workers', name: 'Workers Scripts Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-queues', name: 'Queues Write', scopes: ['com.cloudflare.api.account'] },
              { id: 'pg-zone-read', name: 'Zone Read', scopes: ['com.cloudflare.api.account.zone'] },
              { id: 'pg-dns', name: 'DNS Write', scopes: ['com.cloudflare.api.account.zone'] },
            ]);
          },
        },
      },
    },
    zones: {
      list(params?: { name?: string }) { return items((options.zones ?? []).filter((zone) => !params?.name || zone.name === params.name)); },
      async get(params: { zone_id: string }) {
        const zone = (options.zones ?? []).find((entry) => entry.id === params.zone_id);
        if (!zone) throw new Error('missing zone');
        return zone;
      },
    },
    queues: {
      list() { return items(queues); },
    },
    workers: {
      subdomains: { async get() { return { subdomain: 'acct' }; }, async update(params: { subdomain: string }) { return { subdomain: params.subdomain }; } },
      scripts: {
        async update(_name: string, params: { metadata: Record<string, unknown> }) { calls.workerUpdates.push(params.metadata); return { id: 'w' }; },
        subdomain: {
          async create() { return { enabled: true }; },
          async delete() { return { enabled: false }; },
          async get() { return { enabled: true }; },
        },
        schedules: {
          async update(_name: string, params: { body: Array<{ cron: string }> }) {
            if (options.failScheduleUpdate) throw new Error('Cloudflare API is unavailable');
            calls.scheduleUpdates += 1;
            return { schedules: params.body };
          },
          async get() { return { schedules: [{ cron: '*/5 * * * *' }] }; },
        },
        secrets: {
          async update(_name: string, params: { name: string }) {
            if (options.failSecretUpdate) throw new Error('token lacks the Worker secrets permission');
            calls.secretUpdates.push(params.name);
            return { name: params.name, type: 'secret_text' };
          },
        },
      },
    },
  } as unknown as CloudflareApiClient;
  return { client, calls };
}

function managerFor(client: CloudflareApiClient, extra: Partial<ConstructorParameters<typeof CloudflareControlPlaneManager>[0]> = {}) {
  const configManager = makeConfigManager();
  const secrets = makeSecrets();
  const created: string[] = [];
  const manager = new CloudflareControlPlaneManager({
    configManager,
    secretsManager: secrets,
    createClient: async (token) => { created.push(token); return client; },
    ...extra,
  });
  return { manager, configManager, secrets, created };
}

async function rejection(run: Promise<unknown>): Promise<CloudflareControlPlaneError> {
  try { await run; } catch (error) {
    if (error instanceof CloudflareControlPlaneError) return error;
    throw error;
  }
  throw new Error('expected the call to be refused');
}

describe('operational token scope', () => {
  test('a zone name that matches nothing is refused instead of widening the token to every zone', async () => {
    const { client, calls } = makeClient({ zones: [{ id: 'zone-1', name: 'example.com', status: 'active', type: 'full' }] });
    const { manager } = managerFor(client);
    const error = await rejection(manager.createOperationalToken({
      accountId: 'acct-1', bootstrapToken: 'boot', zoneName: 'typo.com', components: { dns: true },
    }));
    expect(error.code).toBe('CLOUDFLARE_ZONE_NOT_FOUND');
    expect(calls.tokenCreates).toBe(0);
  });

  test('the dns component without any zone is refused', async () => {
    const { client, calls } = makeClient();
    const { manager } = managerFor(client);
    const error = await rejection(manager.createOperationalToken({
      accountId: 'acct-1', bootstrapToken: 'boot', components: { dns: true },
    }));
    expect(error.code).toBe('CLOUDFLARE_ZONE_REQUIRED');
    expect(calls.tokenCreates).toBe(0);
  });

  test('a token that would be created and then discarded is refused before Cloudflare is called', async () => {
    const { client } = makeClient();
    const { manager, created } = managerFor(client);
    const error = await rejection(manager.createOperationalToken({
      accountId: 'acct-1', bootstrapToken: 'boot', storeApiToken: false,
    }));
    expect(error.code).toBe('CLOUDFLARE_TOKEN_UNRECOVERABLE');
    expect(created).toEqual([]);
  });

  test('when the new token cannot be stored the error names it so it can be deleted', async () => {
    const { client, calls } = makeClient();
    const configManager = makeConfigManager();
    const manager = new CloudflareControlPlaneManager({
      configManager,
      secretsManager: makeSecrets({ failSet: true }),
      createClient: async () => client,
    });
    const error = await rejection(manager.createOperationalToken({ accountId: 'acct-1', bootstrapToken: 'boot' }));
    expect(error.code).toBe('CLOUDFLARE_TOKEN_NOT_STORED');
    expect(error.message).toContain('token-1');
    expect(error.message).not.toContain('operational-token');
    expect(calls.tokenCreates).toBe(1);
  });
});

describe('provisioning order and partial failure', () => {
  const workersOnly = { workers: true, queues: false } as const;

  test('a missing Worker-to-daemon token is refused before anything is written at Cloudflare', async () => {
    const { client, calls } = makeClient();
    const { manager, secrets } = managerFor(client);
    const error = await rejection(manager.provision({
      accountId: 'acct-1', apiToken: 'cf', storeApiToken: true, components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', verify: false,
    }));
    expect(error.code).toBe('CLOUDFLARE_OPERATOR_TOKEN_REQUIRED');
    expect(calls.workerUpdates).toEqual([]);
    expect(calls.accountGets).toBe(0);
    expect(Object.keys(secrets.values)).toEqual([]);
  });

  test('an API token the account rejects never replaces the stored one', async () => {
    const { client } = makeClient({ failAccountGet: true });
    const { manager, secrets, configManager } = managerFor(client);
    await rejection(manager.provision({
      accountId: 'acct-1', apiToken: 'mistyped', storeApiToken: true, operatorToken: 'op', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev',
    })).catch(() => undefined);
    expect(secrets.values['CLOUDFLARE_API_TOKEN']).toBeUndefined();
    expect(configManager.get('cloudflare.apiTokenRef')).toBe('');
  });

  test('persistConfig false stores no credential', async () => {
    const { client } = makeClient();
    const { manager, secrets } = managerFor(client);
    const result = await manager.provision({
      accountId: 'acct-1', apiToken: 'cf', storeApiToken: true, operatorToken: 'op', storeOperatorToken: true,
      components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', persistConfig: false, verify: false,
    });
    expect(secrets.values['CLOUDFLARE_API_TOKEN']).toBeUndefined();
    expect(result.steps.find((step) => step.name === 'store-api-token')?.status).toBe('skipped');
  });

  test('a provision that stops part-way says what it had already done', async () => {
    const { client, calls } = makeClient({ failSecretUpdate: true });
    const { manager } = managerFor(client);
    const error = await rejection(manager.provision({
      accountId: 'acct-1', apiToken: 'cf', operatorToken: 'op', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev',
    }));
    expect(calls.workerUpdates).toHaveLength(1);
    expect(error.partial?.steps.map((step) => step.name)).toContain('deploy-worker');
    expect(error.message).toContain('deploy-worker');
    expect(error.message).toContain('safe');
    expect(error.message).toContain('token lacks the Worker secrets permission');
    expect(error.code).toBe('CLOUDFLARE_ERROR');
  });

  test('using the daemon auth token for the Worker is called out, and plain-text variables survive a redeploy', async () => {
    const { client, calls } = makeClient();
    const { manager } = managerFor(client, { authToken: () => 'daemon-main-token' });
    const result = await manager.provision({
      accountId: 'acct-1', apiToken: 'cf', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', verify: false,
    });
    const step = result.steps.find((entry) => entry.name === 'set-worker-daemon-secret');
    expect(step?.status).toBe('warning');
    expect(step?.message).toContain('auth token');
    expect(calls.workerUpdates[0]?.['keep_bindings']).toEqual(['secret_text', 'plain_text']);
  });
});

describe('verifying a Worker', () => {
  function recordingFetch(respond: () => Response | Promise<Response> = () => new Response('{}', { status: 200 })) {
    const requests: Array<{ url: string; authorization: string | null; signal: boolean; redirect: string | undefined }> = [];
    const impl = Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get('authorization'),
          signal: init?.signal instanceof AbortSignal,
          redirect: init?.redirect,
        });
        return await respond();
      },
      { preconnect: () => {} },
    );
    return { requests, impl };
  }

  function verifier(fetchImpl: typeof fetch) {
    const { client } = makeClient();
    const configManager = makeConfigManager();
    configManager.set('cloudflare.workerBaseUrl', 'https://configured.example.net');
    const secrets = makeSecrets({ initial: { GOODVIBES_CLOUDFLARE_WORKER_TOKEN: 'stored-worker-token' } });
    return new CloudflareControlPlaneManager({ configManager, secretsManager: secrets, createClient: async () => client, fetch: fetchImpl });
  }

  test('the stored Worker token goes only to the configured Worker, and every request is bounded and does not follow redirects', async () => {
    const { requests, impl } = recordingFetch();
    const manager = verifier(impl);
    const result = await manager.verify({});
    expect(result.ok).toBe(true);
    expect(requests.map((request) => request.url)).toEqual([
      'https://configured.example.net/batch/health',
      'https://configured.example.net/api/batch/config',
    ]);
    expect(requests[1]?.authorization).toBe('Bearer stored-worker-token');
    expect(requests.every((request) => request.signal && request.redirect === 'manual')).toBe(true);
  });

  test('a different URL in the request does not receive the stored token', async () => {
    const { requests, impl } = recordingFetch();
    const manager = verifier(impl);
    const result = await manager.verify({ workerBaseUrl: 'https://attacker.example' });
    expect(requests.every((request) => request.authorization === null)).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.daemonBatchProxy?.error).toContain('not the configured');
  });

  test('a token typed into the request is sent where the request points', async () => {
    const { requests, impl } = recordingFetch();
    const manager = verifier(impl);
    await manager.verify({ workerBaseUrl: 'https://other.example.org', workerClientToken: 'typed-token' });
    expect(requests.at(-1)?.authorization).toBe('Bearer typed-token');
  });

  test('a non-https Worker URL is refused', async () => {
    const { requests, impl } = recordingFetch();
    const manager = verifier(impl);
    const error = await rejection(manager.verify({ workerBaseUrl: 'http://configured.example.net' }));
    expect(error.code).toBe('CLOUDFLARE_WORKER_URL_INVALID');
    expect(requests).toEqual([]);
  });

  test('a Worker that times out is reported as not ok instead of hanging', async () => {
    const { impl } = recordingFetch(() => { throw new DOMException('The operation timed out.', 'TimeoutError'); });
    const manager = verifier(impl);
    const result = await manager.verify({});
    expect(result.ok).toBe(false);
    expect(result.workerHealth.status).toBe(0);
    expect(result.workerHealth.error).toContain('timed out');
  });
});

describe('disabling the integration', () => {
  test('a failing Cloudflare call still switches the local configuration off and says the Worker may still run', async () => {
    const { client } = makeClient({ failScheduleUpdate: true });
    const { manager, configManager } = managerFor(client);
    configManager.set('cloudflare.accountId', 'acct-1');
    configManager.set('cloudflare.enabled', true);
    configManager.set('batch.queueBackend', 'cloudflare');
    const result = await manager.disable({ apiToken: 'cf' });
    expect(configManager.get('cloudflare.enabled')).toBe(false);
    expect(configManager.get('batch.queueBackend')).toBe('local');
    expect(result.remote).toBe('not-disabled');
    const warning = result.steps.find((step) => step.status === 'warning');
    expect(warning?.message).toContain('Cloudflare API is unavailable');
  });

  test('with no API token the result says the Worker was not disabled', async () => {
    const { client } = makeClient();
    const { manager, configManager } = managerFor(client);
    configManager.set('cloudflare.enabled', true);
    const result = await manager.disable({});
    expect(configManager.get('cloudflare.enabled')).toBe(false);
    expect(result.remote).toBe('not-disabled');
  });

  test('a successful disable reports the Worker as disabled', async () => {
    const { client } = makeClient();
    const { manager, configManager } = managerFor(client);
    configManager.set('cloudflare.accountId', 'acct-1');
    const result = await manager.disable({ apiToken: 'cf' });
    expect(result.remote).toBe('disabled');
  });
});

describe('discovery', () => {
  test('a list cut off at the cap is reported as partial', async () => {
    const { client } = makeClient({ queueCount: 300 });
    const { manager } = managerFor(client);
    const result = await manager.discover({ apiToken: 'cf', accountId: 'acct-1' });
    expect(result.queues).toHaveLength(250);
    expect(result.warnings.some((warning) => warning.includes('queues') && warning.includes('cut off'))).toBe(true);
  });

  test('a list under the cap carries no warning', async () => {
    const { client } = makeClient({ queueCount: 3 });
    const { manager } = managerFor(client);
    const result = await manager.discover({ apiToken: 'cf', accountId: 'acct-1' });
    expect(result.warnings.some((warning) => warning.includes('cut off'))).toBe(false);
  });
});

describe('existing Cloudflare resources that GoodVibes did not create', () => {
  const zone: CloudflareZoneLike = { id: 'zone-1', name: 'buzz.dev', status: 'active', type: 'full' };

  function dnsClient(existing: CloudflareDnsRecordLike[]) {
    const updates: string[] = [];
    const creates: string[] = [];
    const client = {
      dns: {
        records: {
          list() { return items(existing); },
          async update(id: string, params: { name: string; content: string; type: string }) { updates.push(id); return { id, name: params.name, type: params.type, content: params.content }; },
          async create(params: { name: string; content: string; type: string }) { creates.push(params.name); return { id: 'new', name: params.name, type: params.type, content: params.content }; },
        },
      },
    } as unknown as CloudflareApiClient;
    return { client, updates, creates };
  }

  async function pointDaemon(client: CloudflareApiClient, steps: CloudflareProvisionStep[]) {
    return await configureDns(client, { enabled: true, zone, daemonHostname: 'daemon.buzz.dev', tunnelId: 'tunnel-1', workerHostname: '', workerBaseUrl: '', steps });
  }

  test('a CNAME somebody else made for the hostname is left alone and reported', async () => {
    const { client, updates } = dnsClient([{ id: 'r1', name: 'daemon.buzz.dev', type: 'CNAME', content: 'their-site.example.net', proxied: true }]);
    const steps: CloudflareProvisionStep[] = [];
    await pointDaemon(client, steps);
    expect(updates).toEqual([]);
    expect(steps.find((step) => step.name === 'dns-daemon-hostname')?.status).toBe('warning');
  });

  test('a CNAME GoodVibes made earlier is updated', async () => {
    const { client, updates } = dnsClient([{
      id: 'r1', name: 'daemon.buzz.dev', type: 'CNAME', content: 'old-tunnel.cfargotunnel.com', proxied: true,
      comment: 'Managed by GoodVibes platform Cloudflare provisioning',
    }]);
    const steps: CloudflareProvisionStep[] = [];
    await pointDaemon(client, steps);
    expect(updates).toEqual(['r1']);
    expect(steps.find((step) => step.name === 'dns-daemon-hostname')?.status).toBe('ok');
  });

  function accessClient(app: CloudflareAccessApplicationLike) {
    const updates: string[] = [];
    const creates: string[] = [];
    const client = {
      zeroTrust: {
        access: {
          serviceTokens: {
            list() { return items([{ id: 'st-1', name: 'GoodVibes Daemon', client_id: 'cid', client_secret: 'secret' }]); },
            async create() { return { id: 'st-1' }; },
          },
          applications: {
            list() { return items([app]); },
            async update(id: string) { updates.push(id); return { ...app, id }; },
            async create() { creates.push('create'); return { id: 'new' }; },
          },
        },
      },
    } as unknown as CloudflareApiClient;
    return { client, updates, creates };
  }

  const context: CloudflareProvisioningContext = {
    readConfig: () => { throw new Error('not needed'); },
    setConfig: () => {},
    storeSecret: async () => {},
  };
  const accessInput = (steps: CloudflareProvisionStep[]) => ({
    accountId: 'acct-1', daemonHostname: 'daemon.buzz.dev', accessAppId: '', accessServiceTokenId: '', accessServiceTokenRef: '',
    persist: false, returnGeneratedSecrets: false, steps,
  });

  test('an Access application with someone else\'s login policy is not rewritten', async () => {
    const { client, updates, creates } = accessClient({ id: 'app-1', name: 'Allow my email', domain: 'daemon.buzz.dev' });
    const steps: CloudflareProvisionStep[] = [];
    const result = await ensureAccess(context, client, accessInput(steps));
    expect(updates).toEqual([]);
    expect(creates).toEqual([]);
    expect(result.appId).toBeUndefined();
    const step = steps.find((entry) => entry.name === 'zero-trust-access-app');
    expect(step?.status).toBe('warning');
    expect(step?.message).toContain('Allow my email');
  });

  test('the Access application GoodVibes named is updated', async () => {
    const { client, updates } = accessClient({ id: 'app-1', name: 'GoodVibes Daemon', domain: 'daemon.buzz.dev' });
    const result = await ensureAccess(context, client, accessInput([]));
    expect(updates).toEqual(['app-1']);
    expect(result.appId).toBe('app-1');
  });
});

describe('resources that cannot be confirmed', () => {
  const quietContext: CloudflareProvisioningContext = { readConfig: () => { throw new Error('not needed'); }, setConfig: () => {}, storeSecret: async () => {} };

  test('a configured KV namespace id that is not in the account is reported as unconfirmed', async () => {
    const client = { kv: { namespaces: { list() { return items([{ id: 'other', title: 'elsewhere' }]); }, async create() { throw new Error('must not create'); } } } } as unknown as CloudflareApiClient;
    const steps: CloudflareProvisionStep[] = [];
    const kv = await ensureKvNamespace(quietContext, client, 'acct-1', 'goodvibes-kv', 'stale-id', false, steps);
    expect(kv.id).toBe('stale-id');
    expect(steps.find((step) => step.name === 'kv-namespace')?.status).toBe('warning');
  });

  test('a local-only daemon hostname with no zone is not sent to Tunnel or Access', () => {
    const steps: CloudflareProvisionStep[] = [];
    const names = normalizeProvisionHostnames({
      zoneName: '', workerName: 'w', daemonHostname: 'localhost', workerHostname: '', needsDaemonHostname: true, needsWorkerHostname: false, steps,
    });
    expect(names.daemonHostname).toBe('');
    expect(steps.find((step) => step.name === 'daemon-hostname')?.status).toBe('warning');
  });

  test('an Access service token found without its secret is reported', async () => {
    const client = {
      zeroTrust: {
        access: {
          serviceTokens: { list() { return items([{ id: 'st-1', name: 'GoodVibes Daemon' }]); }, async create() { return { id: 'st-1' }; } },
          applications: { list() { return items([]); }, async create() { return { id: 'app-1' }; }, async update() { return { id: 'app-1' }; } },
        },
      },
    } as unknown as CloudflareApiClient;
    const steps: CloudflareProvisionStep[] = [];
    await ensureAccess(quietContext, client, {
      accountId: 'acct-1', daemonHostname: 'daemon.buzz.dev', accessAppId: '', accessServiceTokenId: '', accessServiceTokenRef: '',
      persist: false, returnGeneratedSecrets: false, steps,
    });
    expect(steps.find((step) => step.name === 'zero-trust-access-service-token-secret')?.status).toBe('warning');
  });
});

describe('the deployed Worker module', () => {
  async function loadWorker(): Promise<{
    default: {
      fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
      scheduled(event: unknown, env: Record<string, unknown>): Promise<void>;
      queue(batch: { messages: Array<{ body: unknown; ack(): void; retry(): void }> }, env: Record<string, unknown>): Promise<void>;
    };
  }> {
    const file = join(makeProjectTempDir('cloudflare-worker-module'), 'worker.mjs');
    writeFileSync(file, GOODVIBES_CLOUDFLARE_WORKER_MODULE);
    return await import(file);
  }

  async function withFetch<T>(replacement: (url: string) => Response, run: (urls: string[]) => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = Object.assign(async (input: URL | RequestInfo) => { urls.push(String(input)); return replacement(String(input)); }, { preconnect: () => {} });
    try { return await run(urls); } finally { globalThis.fetch = original; }
  }

  const queue = { async send() {} };

  async function deliver(status: number, body: unknown, bodies: string[] = []): Promise<string[]> {
    const worker = await loadWorker();
    const calls: string[] = [];
    const message = { body, ack: () => { calls.push('ack'); }, retry: () => { calls.push('retry'); } };
    const original = globalThis.fetch;
    globalThis.fetch = Object.assign(async (_input: URL | RequestInfo, init?: RequestInit) => { bodies.push(String(init?.body)); return new Response('x', { status }); }, { preconnect: () => {} });
    try {
      await worker.default.queue({ messages: [message] }, { GOODVIBES_DAEMON_URL: 'https://daemon.example' });
    } finally { globalThis.fetch = original; }
    return calls;
  }

  test('queue delivery acks a daemon 400, retries 500 with the same job id, and acks an unknown type without a daemon call', async () => {
    const job = { type: 'batch.job.create', body: { request: {} }, jobId: 'job-1' };
    expect(await deliver(400, job)).toEqual(['ack']);
    const bodies: string[] = [];
    expect(await deliver(500, job, bodies)).toEqual(['retry']);
    expect(await deliver(500, job, bodies)).toEqual(['retry']);
    expect(bodies.map((b) => (JSON.parse(b) as { source: { id: string } }).source.id)).toEqual(['job-1', 'job-1']);
    expect(await deliver(401, job)).toEqual(['retry']);
    const unknown: string[] = [];
    expect(await deliver(500, { type: 'bogus' }, unknown)).toEqual(['ack']);
    expect(unknown).toEqual([]);
  });

  test('an enqueued job payload carries a minted job id', async () => {
    const worker = await loadWorker();
    const sent: Array<Record<string, unknown>> = [];
    const response = await worker.default.fetch(
      new Request('https://w.example/batch/jobs/enqueue', { method: 'POST', headers: { authorization: 'Bearer t' }, body: '{}' }),
      { GOODVIBES_WORKER_TOKEN: 't', GOODVIBES_QUEUE_JOB_PAYLOADS: 'true', GOODVIBES_BATCH_QUEUE: { async send(m: Record<string, unknown>) { sent.push(m); } } },
    );
    expect(response.status).toBe(202);
    expect(typeof sent[0]?.jobId === 'string' && (sent[0].jobId as string).length > 0).toBe(true);
  });

  test('without a client token the Worker refuses instead of proxying with the operator credential', async () => {
    const worker = await loadWorker();
    const response = await worker.default.fetch(new Request('https://w.example/batch/tick/enqueue', { method: 'POST' }), { GOODVIBES_BATCH_QUEUE: queue });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'WORKER_AUTH_NOT_CONFIGURED' });
  });

  test('a wrong token is refused and the right one is accepted', async () => {
    const worker = await loadWorker();
    const env = { GOODVIBES_WORKER_TOKEN: 'right-token', GOODVIBES_BATCH_QUEUE: queue };
    const wrong = await worker.default.fetch(new Request('https://w.example/batch/tick/enqueue', { method: 'POST', headers: { authorization: 'Bearer right-tokeN' } }), env);
    expect(wrong.status).toBe(401);
    const right = await worker.default.fetch(new Request('https://w.example/batch/tick/enqueue', { method: 'POST', headers: { authorization: 'Bearer right-token' } }), env);
    expect(right.status).toBe(202);
  });

  test('a daemon hostname that merely starts with fc or fd is an ordinary host, an IPv6 unique-local address is not', async () => {
    const worker = await loadWorker();
    const headers = { authorization: 'Bearer t' };
    await withFetch(() => new Response('{}', { status: 200 }), async (urls) => {
      for (const host of ['https://fdaemon.example.com', 'https://fcm.example.org']) {
        const response = await worker.default.fetch(new Request('https://w.example/api/batch/config', { headers }), { GOODVIBES_WORKER_TOKEN: 't', GOODVIBES_DAEMON_URL: host });
        expect(response.status).toBe(200);
      }
      expect(urls).toEqual(['https://fdaemon.example.com/api/batch/config', 'https://fcm.example.org/api/batch/config']);
    });
    const blocked = await worker.default.fetch(new Request('https://w.example/api/batch/config', { headers }), { GOODVIBES_WORKER_TOKEN: 't', GOODVIBES_DAEMON_URL: 'https://[fd00::1]' });
    expect(blocked.status).toBe(403);
  });

  test('the Worker switches use the platform grammar: 1 and true are on, other text is off', async () => {
    const worker = await loadWorker();
    const enqueue = (flag: string) => worker.default.fetch(
      new Request('https://w.example/batch/jobs/enqueue', { method: 'POST', headers: { authorization: 'Bearer t' } }),
      { GOODVIBES_WORKER_TOKEN: 't', GOODVIBES_BATCH_QUEUE: queue, GOODVIBES_QUEUE_JOB_PAYLOADS: flag },
    );
    expect((await enqueue('yes')).status).toBe(409);
    expect((await enqueue('false')).status).toBe(409);
    expect((await enqueue('1')).status).not.toBe(409);
    expect((await enqueue('TRUE')).status).not.toBe(409);
  });

  test('a scheduled tick the daemon refuses fails the invocation', async () => {
    const worker = await loadWorker();
    const env = { GOODVIBES_DAEMON_URL: 'https://daemon.buzz.dev', GOODVIBES_OPERATOR_TOKEN: 'op' };
    await withFetch(() => new Response('no', { status: 401 }), async () => {
      await expect(worker.default.scheduled({}, env)).rejects.toThrow('status 401');
    });
    await withFetch(() => new Response('{}', { status: 200 }), async () => {
      await expect(worker.default.scheduled({}, env)).resolves.toBeUndefined();
    });
  });
});

describe('provisioning with a Worker URL and without persisting', () => {
  const workersOnly = { workers: true, queues: false } as const;

  function recordingFetch() {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const impl = Object.assign(
      async (url: URL | RequestInfo, init?: RequestInit) => {
        requests.push({ url: String(url), authorization: new Headers(init?.headers).get('authorization') });
        return new Response('{}', { status: 200 });
      },
      { preconnect: () => {} },
    );
    return { requests, impl };
  }

  test('a Worker URL that is not https is refused before anything is written', async () => {
    const { client, calls } = makeClient();
    const { manager, secrets, configManager } = managerFor(client);
    const error = await rejection(manager.provision({
      accountId: 'acct-1', apiToken: 'cf', operatorToken: 'op', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', workerBaseUrl: 'http://worker.example.org',
    }));
    expect(error.code).toBe('CLOUDFLARE_WORKER_URL_INVALID');
    expect(error.partial).toBeUndefined();
    expect(calls.workerUpdates).toEqual([]);
    expect(Object.keys(secrets.values)).toEqual([]);
    expect(configManager.get('cloudflare.enabled')).toBe(false);
  });

  test('the Worker token this run generated is verified against the Worker URL typed in the same request', async () => {
    const { client } = makeClient();
    const { requests, impl } = recordingFetch();
    const { manager } = managerFor(client, { fetch: impl });
    const result = await manager.provision({
      accountId: 'acct-1', apiToken: 'cf', operatorToken: 'op', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', workerBaseUrl: 'https://worker.example.org',
    });
    expect(result.verification?.ok).toBe(true);
    expect(requests.map((request) => request.url)).toContain('https://worker.example.org/api/batch/config');
    expect(requests.at(-1)?.authorization).toMatch(/^Bearer .+/);
  });

  test('a token stored earlier is not sent to a Worker URL typed in the provision request', async () => {
    const { client } = makeClient();
    const { requests, impl } = recordingFetch();
    const secrets = makeSecrets({ initial: { GOODVIBES_CLOUDFLARE_WORKER_TOKEN: 'stored-worker-token' } });
    const { manager } = managerFor(client, { fetch: impl, secretsManager: secrets });
    await manager.provision({
      accountId: 'acct-1', apiToken: 'cf', operatorToken: 'op', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', workerBaseUrl: 'https://worker.example.org',
    });
    expect(requests.every((request) => request.authorization === null)).toBe(true);
  });

  test('persistConfig false stores nothing and returns the Worker token it generated', async () => {
    const { client } = makeClient();
    const { manager, secrets } = managerFor(client);
    const result = await manager.provision({
      accountId: 'acct-1', apiToken: 'cf', operatorToken: 'op', components: workersOnly, daemonBaseUrl: 'https://daemon.buzz.dev', persistConfig: false, verify: false,
    });
    expect(Object.keys(secrets.values)).toEqual([]);
    expect(result.generatedSecrets?.workerClientToken).toBeTruthy();
    expect(result.steps.find((step) => step.name === 'generate-worker-client-token')?.status).toBe('skipped');
  });
});

describe('Tunnel and Access credentials with persistConfig false', () => {
  function tunnelClient(options: { readonly existing?: readonly Record<string, unknown>[] | 'unreadable'; readonly withGet?: boolean }) {
    const updates: Array<Record<string, unknown>> = [];
    const configurations: Record<string, unknown> = {
      async update(_id: string, params: { config: Record<string, unknown> }) { updates.push(params.config); return {}; },
    };
    if (options.withGet !== false) {
      configurations['get'] = async () => {
        if (options.existing === 'unreadable') throw new Error('forbidden');
        return { config: { ingress: options.existing ?? [] } };
      };
    }
    const client = {
      zeroTrust: {
        tunnels: {
          cloudflared: {
            list() { return items([{ id: 't-1', name: 'GoodVibes Daemon' }]); },
            async create() { return { id: 't-new', name: 'GoodVibes Daemon' }; },
            configurations,
            token: { async get() { return 'tunnel-token'; } },
          },
        },
      },
    } as unknown as CloudflareApiClient;
    return { client, updates };
  }

  function recordingContext() {
    const stored: string[] = [];
    const context: CloudflareProvisioningContext = { readConfig: () => { throw new Error('not needed'); }, setConfig: () => {}, storeSecret: async (key) => { stored.push(key); } };
    return { context, stored };
  }

  const tunnelInput = (steps: CloudflareProvisionStep[], persist: boolean) => ({
    accountId: 'acct-1', tunnelName: 'GoodVibes Daemon', tunnelId: '', daemonHostname: 'daemon.buzz.dev', tunnelServiceUrl: 'http://127.0.0.1:3421',
    persist, returnGeneratedSecrets: false, steps,
  });

  test('an existing Tunnel keeps the rules it already had for other hostnames', async () => {
    const { client, updates } = tunnelClient({ existing: [
      { hostname: 'blog.buzz.dev', service: 'http://127.0.0.1:8080' },
      { hostname: 'daemon.buzz.dev', service: 'http://127.0.0.1:1' },
      { service: 'http_status:404' },
    ] });
    const steps: CloudflareProvisionStep[] = [];
    await ensureTunnel(recordingContext().context, client, tunnelInput(steps, true));
    expect(updates).toEqual([{ ingress: [
      { hostname: 'blog.buzz.dev', service: 'http://127.0.0.1:8080' },
      { hostname: 'daemon.buzz.dev', service: 'http://127.0.0.1:3421' },
      { service: 'http_status:404' },
    ] }]);
  });

  test('an existing Tunnel with a non-404 catch-all keeps it once, last, and keeps 404 rules for other hostnames', async () => {
    const { client, updates } = tunnelClient({ existing: [
      { hostname: 'blog.buzz.dev', service: 'http://127.0.0.1:8080' },
      { hostname: 'gone.buzz.dev', service: 'http_status:404' },
      { service: 'http_status:503' },
    ] });
    await ensureTunnel(recordingContext().context, client, tunnelInput([], true));
    expect(updates).toEqual([{ ingress: [
      { hostname: 'blog.buzz.dev', service: 'http://127.0.0.1:8080' },
      { hostname: 'gone.buzz.dev', service: 'http_status:404' },
      { hostname: 'daemon.buzz.dev', service: 'http://127.0.0.1:3421' },
      { service: 'http_status:503' },
    ] }]);
  });

  test('an existing Tunnel whose rules cannot be read is left unchanged and the operator is told', async () => {
    for (const options of [{ existing: 'unreadable' as const }, { withGet: false }]) {
      const { client, updates } = tunnelClient(options);
      const steps: CloudflareProvisionStep[] = [];
      await ensureTunnel(recordingContext().context, client, tunnelInput(steps, true));
      expect(updates).toEqual([]);
      const step = steps.find((entry) => entry.name === 'zero-trust-tunnel-config');
      expect(step?.status).toBe('warning');
      expect(step?.message).toContain('left unchanged');
    }
  });

  test('persistConfig false stores no Tunnel token', async () => {
    const { client } = tunnelClient({ existing: [] });
    const { context, stored } = recordingContext();
    const result = await ensureTunnel(context, client, tunnelInput([], false));
    expect(stored).toEqual([]);
    expect(result.tokenRef).toBeUndefined();
  });

  test('persistConfig false stores no Access service token secret', async () => {
    const client = {
      zeroTrust: {
        access: {
          serviceTokens: {
            list() { return items([{ id: 'st-1', name: 'GoodVibes Daemon', client_id: 'cid', client_secret: 'secret' }]); },
            async create() { return { id: 'st-1' }; },
          },
          applications: { list() { return items([]); }, async update(id: string) { return { id }; }, async create() { return { id: 'app-1' }; } },
        },
      },
    } as unknown as CloudflareApiClient;
    const { context, stored } = recordingContext();
    const steps: CloudflareProvisionStep[] = [];
    const result = await ensureAccess(context, client, {
      accountId: 'acct-1', daemonHostname: 'daemon.buzz.dev', accessAppId: '', accessServiceTokenId: '', accessServiceTokenRef: '',
      persist: false, returnGeneratedSecrets: true, steps,
    });
    expect(stored).toEqual([]);
    expect(result.clientSecret).toBe('secret');
  });
});
