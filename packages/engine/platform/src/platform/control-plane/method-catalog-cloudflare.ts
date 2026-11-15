/**
 * method-catalog-cloudflare.ts, the Cloudflare control plane.
 *
 * Serves the batch worker's platform (Workers, Queues, Zero Trust, DNS, KV,
 * Durable Objects, Secrets Store, R2) from platform/daemon/http/cloudflare-routes.ts.
 * The routes were called by path from the terminal's own hand-written client;
 * described here, a generated client and the route reconcile can see them.
 *
 * Every verb needs an admin, reads included: the status and token requirements
 * describe credentials and the account layout. Inputs accept a token either
 * inline or by `goodvibes://` reference; prefer the reference, an inline token
 * travels in the request body.
 */
import type { GatewayMethodDescriptor } from './method-catalog-shared.js';
import {
  BOOLEAN_SCHEMA,
  STRING_SCHEMA,
  arraySchema,
  bodyEnvelopeSchema,
  methodDescriptor,
  objectSchema,
  stringEnumSchema,
} from './method-catalog-shared.js';

const OPEN_OBJECT_SCHEMA = objectSchema({}, [], { additionalProperties: true });

const COMPONENT_IDS = ['workers', 'queues', 'zeroTrustTunnel', 'zeroTrustAccess', 'dns', 'kv', 'durableObjects', 'secretsStore', 'r2'] as const;
const COMPONENTS_SCHEMA = objectSchema(Object.fromEntries(COMPONENT_IDS.map((id) => [id, BOOLEAN_SCHEMA])), []);
const COMPONENTS_RESULT_SCHEMA = objectSchema(Object.fromEntries(COMPONENT_IDS.map((id) => [id, BOOLEAN_SCHEMA])), [...COMPONENT_IDS]);

const STEP_SCHEMA = objectSchema({
  name: STRING_SCHEMA,
  status: stringEnumSchema(['ok', 'skipped', 'warning']),
  message: STRING_SCHEMA,
  resourceId: STRING_SCHEMA,
}, ['name', 'status']);

const ACCOUNT_SCHEMA = objectSchema({ id: STRING_SCHEMA, name: STRING_SCHEMA, type: STRING_SCHEMA }, ['id', 'name']);

const TOKEN_REQUIREMENT_SCHEMA = objectSchema({
  component: STRING_SCHEMA,
  scope: STRING_SCHEMA,
  permission: STRING_SCHEMA,
  alternatives: arraySchema(STRING_SCHEMA),
  reason: STRING_SCHEMA,
}, ['component', 'scope', 'permission', 'reason'], { additionalProperties: true });

const CREDENTIAL_PROPERTIES = {
  accountId: STRING_SCHEMA,
  apiToken: STRING_SCHEMA,
  apiTokenRef: STRING_SCHEMA,
};

const TUNNEL_CONNECTOR_SCHEMA = objectSchema({
  state: stringEnumSchema(['not-configured', 'not-installed', 'starting', 'connected', 'failed', 'stopped']),
  detail: STRING_SCHEMA,
  next: arraySchema(STRING_SCHEMA),
}, ['state', 'detail'], { additionalProperties: true });

const VERIFY_RESULT_SCHEMA = objectSchema({
  ok: BOOLEAN_SCHEMA,
  workerHealth: objectSchema({ ok: BOOLEAN_SCHEMA, status: { type: 'number' }, error: STRING_SCHEMA }, ['ok', 'status']),
  daemonBatchProxy: objectSchema({ ok: BOOLEAN_SCHEMA, status: { type: 'number' }, error: STRING_SCHEMA }, ['ok', 'status']),
}, ['ok', 'workerHealth']);

const PROVISION_INPUT_PROPERTIES: Record<string, Record<string, unknown>> = {
  ...CREDENTIAL_PROPERTIES,
  components: COMPONENTS_SCHEMA,
  batchMode: stringEnumSchema(['off', 'explicit', 'eligible-by-default']),
  ...Object.fromEntries([
    'workerName', 'workerSubdomain', 'workerHostname', 'workerBaseUrl', 'daemonBaseUrl', 'daemonHostname',
    'zoneId', 'zoneName', 'queueName', 'deadLetterQueueName', 'tunnelName', 'tunnelId', 'tunnelServiceUrl',
    'tunnelTokenRef', 'accessAppId', 'accessServiceTokenId', 'accessServiceTokenRef', 'kvNamespaceName',
    'kvNamespaceId', 'durableObjectNamespaceName', 'r2BucketName',
    'secretsStoreName', 'secretsStoreId', 'workerCron', 'operatorToken', 'operatorTokenRef',
    'workerClientToken', 'workerClientTokenRef',
  ].map((key) => [key, STRING_SCHEMA])),
  ...Object.fromEntries([
    'storeApiToken', 'storeOperatorToken', 'storeWorkerClientToken', 'returnGeneratedSecrets',
    'enableWorkersDev', 'queueJobPayloads', 'verify', 'persistConfig',
  ].map((key) => [key, BOOLEAN_SCHEMA])),
};

export const builtinGatewayCloudflareMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  methodDescriptor({
    id: 'cloudflare.status',
    title: 'Cloudflare Status',
    description: 'Whether the Cloudflare control plane is enabled and ready, which of its settings and credentials are configured (booleans only, never values), the stored non-secret configuration, and the warnings that explain anything missing. A resource (worker, queues, tunnel, Access, KV, Durable Objects, R2, Secrets Store) reads as configured only when a provision created or confirmed it at Cloudflare. Where this daemon runs the Cloudflare Tunnel connector, `tunnelConnector` says whether it is connected and what to do when it is not; `ready` requires it. `GET /api/cloudflare` returns the same document.',
    category: 'cloudflare',
    scopes: ['read:cloudflare'],
    access: 'admin',
    http: { method: 'GET', path: '/api/cloudflare/status' },
    inputSchema: objectSchema({}, []),
    outputSchema: objectSchema({
      enabled: BOOLEAN_SCHEMA,
      ready: BOOLEAN_SCHEMA,
      configured: objectSchema({}, [], { additionalProperties: true }),
      config: OPEN_OBJECT_SCHEMA,
      warnings: arraySchema(STRING_SCHEMA),
      tunnelConnector: TUNNEL_CONNECTOR_SCHEMA,
    }, ['enabled', 'ready', 'configured', 'config', 'warnings']),
  }),
  methodDescriptor({
    id: 'cloudflare.token.requirements.get',
    title: 'Cloudflare Token Requirements',
    description: 'The Cloudflare API permissions each selected component needs, and how to create the one-off bootstrap token that `cloudflare.token.create` uses. Components default to Workers and Queues. Reads nothing from Cloudflare and changes nothing. Sent as a POST so the component selection travels in the body.',
    category: 'cloudflare',
    scopes: ['read:cloudflare'],
    access: 'admin',
    http: { method: 'POST', path: '/api/cloudflare/token/requirements' },
    inputSchema: bodyEnvelopeSchema({ components: COMPONENTS_SCHEMA, includeBootstrap: BOOLEAN_SCHEMA }, []),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      components: COMPONENTS_RESULT_SCHEMA,
      permissions: arraySchema(TOKEN_REQUIREMENT_SCHEMA),
      bootstrapToken: objectSchema({
        requiredForPlatformCreation: BOOLEAN_SCHEMA,
        storeInGoodVibes: BOOLEAN_SCHEMA,
        instructions: arraySchema(STRING_SCHEMA),
      }, ['requiredForPlatformCreation', 'storeInGoodVibes', 'instructions']),
    }, ['ok', 'components', 'permissions', 'bootstrapToken']),
  }),
  methodDescriptor({
    id: 'cloudflare.token.create',
    title: 'Create Cloudflare Operational Token',
    description: 'Use a temporary bootstrap token (required, used once, never stored) to create a narrower operational token with the permissions `cloudflare.token.requirements.get` lists. With `storeApiToken` the operational token is saved as a `goodvibes://` secret and its reference is returned; the plaintext token comes back only when `returnGeneratedToken` is true. When this daemon already holds the operational token it made for the same account, zone and components, that token is returned with `reused` true and nothing is created (`reuse: false` makes a new one). A new token revokes the one it replaces; `replaced` says whether that worked. Answered 201. Creates a credential in the Cloudflare account unless one is reused.',
    category: 'cloudflare',
    scopes: ['write:cloudflare'],
    access: 'admin',
    dangerous: true,
    http: { method: 'POST', path: '/api/cloudflare/token/create' },
    inputSchema: bodyEnvelopeSchema({
      components: COMPONENTS_SCHEMA,
      includeBootstrap: BOOLEAN_SCHEMA,
      accountId: STRING_SCHEMA,
      zoneId: STRING_SCHEMA,
      zoneName: STRING_SCHEMA,
      bootstrapToken: STRING_SCHEMA,
      tokenName: STRING_SCHEMA,
      expiresOn: STRING_SCHEMA,
      persistConfig: BOOLEAN_SCHEMA,
      storeApiToken: BOOLEAN_SCHEMA,
      returnGeneratedToken: BOOLEAN_SCHEMA,
      reuse: BOOLEAN_SCHEMA,
    }, ['bootstrapToken']),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      tokenId: STRING_SCHEMA,
      tokenName: STRING_SCHEMA,
      tokenSource: STRING_SCHEMA,
      reused: BOOLEAN_SCHEMA,
      replaced: objectSchema({ tokenId: STRING_SCHEMA, revoked: BOOLEAN_SCHEMA, reason: STRING_SCHEMA }, ['tokenId', 'revoked']),
      apiTokenRef: STRING_SCHEMA,
      generatedToken: STRING_SCHEMA,
      accountId: STRING_SCHEMA,
      zoneId: STRING_SCHEMA,
      permissions: arraySchema(TOKEN_REQUIREMENT_SCHEMA),
    }, ['ok', 'tokenName', 'tokenSource', 'accountId', 'permissions']),
  }),
  methodDescriptor({
    id: 'cloudflare.credentials.verify',
    title: 'Validate Cloudflare Credentials',
    description: 'Check that the API token (inline, by reference, or the stored one) is valid and return the account it belongs to. A missing token is refused with CLOUDFLARE_API_TOKEN_REQUIRED (400) and a token Cloudflare rejects fails the call with Cloudflare\'s error. Changes nothing.',
    category: 'cloudflare',
    scopes: ['read:cloudflare'],
    access: 'admin',
    http: { method: 'POST', path: '/api/cloudflare/validate' },
    inputSchema: bodyEnvelopeSchema(CREDENTIAL_PROPERTIES, []),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      account: ACCOUNT_SCHEMA,
      tokenSource: STRING_SCHEMA,
    }, ['ok', 'tokenSource']),
  }),
  methodDescriptor({
    id: 'cloudflare.resources.list',
    title: 'Discover Cloudflare Resources',
    description: 'List what the account already has for the selected components: accounts, zones, the workers.dev subdomain and, with `includeResources`, existing queues, KV namespaces, Durable Object namespaces, R2 buckets, Secrets Stores, tunnels and Access applications. Read-only against Cloudflare; sent as a POST so credentials and the component selection travel in the body.',
    category: 'cloudflare',
    scopes: ['read:cloudflare'],
    access: 'admin',
    http: { method: 'POST', path: '/api/cloudflare/discover' },
    inputSchema: bodyEnvelopeSchema({
      ...CREDENTIAL_PROPERTIES,
      components: COMPONENTS_SCHEMA,
      zoneId: STRING_SCHEMA,
      zoneName: STRING_SCHEMA,
      includeResources: BOOLEAN_SCHEMA,
    }, []),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      tokenSource: STRING_SCHEMA,
      accounts: arraySchema(ACCOUNT_SCHEMA),
      selectedAccount: ACCOUNT_SCHEMA,
      zones: arraySchema(OPEN_OBJECT_SCHEMA),
      selectedZone: OPEN_OBJECT_SCHEMA,
      workerSubdomain: STRING_SCHEMA,
      queues: arraySchema(OPEN_OBJECT_SCHEMA),
      kvNamespaces: arraySchema(OPEN_OBJECT_SCHEMA),
      durableObjectNamespaces: arraySchema(OPEN_OBJECT_SCHEMA),
      r2Buckets: arraySchema(OPEN_OBJECT_SCHEMA),
      secretsStores: arraySchema(OPEN_OBJECT_SCHEMA),
      tunnels: arraySchema(OPEN_OBJECT_SCHEMA),
      accessApplications: arraySchema(OPEN_OBJECT_SCHEMA),
      warnings: arraySchema(STRING_SCHEMA),
    }, ['ok', 'tokenSource', 'accounts', 'zones', 'warnings']),
  }),
  methodDescriptor({
    id: 'cloudflare.provision',
    title: 'Provision Cloudflare Platform',
    description: 'Create or update the selected Cloudflare resources (worker, queues and dead-letter queue, tunnel and its connector on this daemon, Access application and service token, DNS records, KV for queued-job state, Durable Objects for the daily queue budget, R2 for job bodies, Secrets Store for the worker\'s credentials), answered 202 with one step per resource: `ok`, `skipped` or `warning`; `warnings` repeats the message of every warning step. Generated secrets are stored as `goodvibes://` secrets when asked and returned only when `returnGeneratedSecrets` is true. With Workers selected and a worker URL known it then runs the `cloudflare.worker.verify` check unless `verify` is false. `ok` is true, and `cloudflare.enabled` and the Cloudflare batch queue are switched on, only when that check passed (or was turned off) and Access, when asked for, protects the daemon hostname; otherwise a `switch-on` warning step says why nothing was switched. Creates and changes billable resources in the Cloudflare account.',
    category: 'cloudflare',
    scopes: ['write:cloudflare'],
    access: 'admin',
    dangerous: true,
    http: { method: 'POST', path: '/api/cloudflare/provision' },
    inputSchema: bodyEnvelopeSchema(PROVISION_INPUT_PROPERTIES, []),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      dryRun: BOOLEAN_SCHEMA,
      steps: arraySchema(STEP_SCHEMA),
      account: ACCOUNT_SCHEMA,
      worker: OPEN_OBJECT_SCHEMA,
      queues: OPEN_OBJECT_SCHEMA,
      tunnel: OPEN_OBJECT_SCHEMA,
      access: OPEN_OBJECT_SCHEMA,
      dns: OPEN_OBJECT_SCHEMA,
      kv: OPEN_OBJECT_SCHEMA,
      durableObjects: OPEN_OBJECT_SCHEMA,
      r2: OPEN_OBJECT_SCHEMA,
      secretsStore: OPEN_OBJECT_SCHEMA,
      verification: VERIFY_RESULT_SCHEMA,
      generatedSecrets: OPEN_OBJECT_SCHEMA,
      warnings: arraySchema(STRING_SCHEMA),
    }, ['ok', 'dryRun', 'steps']),
  }),
  methodDescriptor({
    id: 'cloudflare.worker.verify',
    title: 'Verify Cloudflare Worker',
    description: 'Check the deployed worker: its `/batch/health` route (`workerHealth`) and its `/api/batch/config` proxy to this daemon (`daemonBatchProxy`), each with `ok`, the HTTP status and any error; `ok` is true only when both pass. A stored worker client token is sent only to the configured `cloudflare.workerBaseUrl`; for any other URL pass `workerClientToken` in the request or the proxy check reports why it was not authenticated. The URL must be https and is required (CLOUDFLARE_WORKER_URL_REQUIRED, 400). Changes nothing.',
    category: 'cloudflare',
    scopes: ['read:cloudflare'],
    access: 'admin',
    http: { method: 'POST', path: '/api/cloudflare/verify' },
    inputSchema: bodyEnvelopeSchema({
      workerBaseUrl: STRING_SCHEMA,
      workerClientToken: STRING_SCHEMA,
      workerClientTokenRef: STRING_SCHEMA,
    }, []),
    outputSchema: VERIFY_RESULT_SCHEMA,
  }),
  methodDescriptor({
    id: 'cloudflare.disable',
    title: 'Disable Cloudflare Worker',
    description: 'Switch the Cloudflare integration off. Always disables it locally (`cloudflare.enabled` false and the batch queue back to `local`; `persistConfig` defaults to true) and stops this daemon\'s tunnel connector, so the daemon stops using the worker. When an API token and account are available it also removes the worker\'s daemon credential (the script secret and its Secrets Store copy), its cron trigger (`disableCron`, default true) and its workers.dev route (`disableWorkerSubdomain`, default true; pass false to keep the route). `remote` is `disabled` only when every Cloudflare step succeeded; otherwise it is `not-disabled`, the deployed worker may keep calling the daemon until it is disabled in the Cloudflare dashboard, and `steps` says which. The worker and the account\'s other resources stay in place; each one still deployed is listed as a `still-deployed` step. With `bootstrapToken` (a token allowed to edit API tokens) it also revokes the operational token this daemon created; without it a `revoke-operational-token` step says that token is still live.',
    category: 'cloudflare',
    scopes: ['write:cloudflare'],
    access: 'admin',
    dangerous: true,
    http: { method: 'POST', path: '/api/cloudflare/disable' },
    inputSchema: bodyEnvelopeSchema({
      ...CREDENTIAL_PROPERTIES,
      bootstrapToken: STRING_SCHEMA,
      workerName: STRING_SCHEMA,
      disableWorkerSubdomain: BOOLEAN_SCHEMA,
      disableCron: BOOLEAN_SCHEMA,
      persistConfig: BOOLEAN_SCHEMA,
    }, []),
    outputSchema: objectSchema({
      ok: BOOLEAN_SCHEMA,
      steps: arraySchema(STEP_SCHEMA),
      remote: stringEnumSchema(['disabled', 'not-disabled']),
    }, ['ok', 'steps', 'remote']),
  }),
];
