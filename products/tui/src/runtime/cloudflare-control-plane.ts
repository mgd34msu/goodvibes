import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveDaemonBaseUrl, resolveDaemonEndpoint } from './client/operator-endpoint.ts';

export const CLOUDFLARE_COMPONENT_IDS = [
  'workers',
  'queues',
  'zeroTrustTunnel',
  'zeroTrustAccess',
  'dns',
  'kv',
  'durableObjects',
  'secretsStore',
  'r2',
] as const;

export type CloudflareComponent = typeof CLOUDFLARE_COMPONENT_IDS[number];
export type CloudflareComponentSelection = Partial<Record<CloudflareComponent, boolean>>;
export type CloudflareBatchMode = 'off' | 'explicit' | 'eligible-by-default';

export const DEFAULT_CLOUDFLARE_COMPONENT_SELECTION: Readonly<Record<CloudflareComponent, boolean>> = {
  workers: true,
  queues: true,
  zeroTrustTunnel: false,
  zeroTrustAccess: false,
  dns: false,
  kv: false,
  durableObjects: false,
  secretsStore: false,
  r2: false,
};

export const CLOUDFLARE_COMPONENT_LABELS: Readonly<Record<CloudflareComponent, string>> = {
  workers: 'Workers',
  queues: 'Queues',
  zeroTrustTunnel: 'Zero Trust Tunnel',
  zeroTrustAccess: 'Zero Trust Access',
  dns: 'DNS hostname',
  kv: 'KV',
  durableObjects: 'Durable Objects',
  secretsStore: 'Secrets Store',
  r2: 'R2 artifacts',
};

export interface CloudflareProvisionStep {
  readonly name: string;
  readonly status: 'ok' | 'skipped' | 'warning';
  readonly message?: string;
  readonly resourceId?: string;
}

export interface CloudflareControlPlaneStatus {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly configured: Record<string, boolean>;
  readonly config: Record<string, unknown>;
  readonly warnings: readonly string[];
  /** The daemon's Cloudflare Tunnel connector; present only where the daemon runs it. */
  readonly tunnelConnector?: { readonly state: string; readonly detail: string; readonly next?: readonly string[] };
}

export interface CloudflareTokenRequirement {
  readonly component: CloudflareComponent | 'bootstrap';
  readonly scope: 'account' | 'zone' | 'user' | 'r2';
  readonly permission: string;
  readonly alternatives?: readonly string[];
  readonly reason: string;
}

export interface CloudflareTokenRequirementsResult {
  readonly ok: true;
  readonly components: Readonly<Record<CloudflareComponent, boolean>>;
  readonly permissions: readonly CloudflareTokenRequirement[];
  readonly bootstrapToken: {
    readonly requiredForPlatformCreation: boolean;
    readonly storeInGoodVibes: false;
    readonly instructions: readonly string[];
  };
}

export interface CloudflareValidateResult {
  readonly ok: boolean;
  readonly account?: {
    readonly id: string;
    readonly name: string;
    readonly type?: string;
  };
  readonly tokenSource: string;
}

export interface CloudflareOperationalTokenResult {
  readonly ok: true;
  readonly tokenId?: string;
  readonly tokenName: string;
  readonly tokenSource: 'bootstrap';
  readonly apiTokenRef?: string;
  readonly generatedToken?: string;
  readonly accountId: string;
  readonly zoneId?: string;
  readonly permissions: readonly CloudflareTokenRequirement[];
}

export interface CloudflareDiscoverResult {
  readonly ok: true;
  readonly tokenSource: string;
  readonly accounts: ReadonlyArray<{ readonly id: string; readonly name: string; readonly type?: string }>;
  readonly selectedAccount?: { readonly id: string; readonly name: string; readonly type?: string };
  readonly zones: ReadonlyArray<{ readonly id: string; readonly name: string; readonly status?: string; readonly type?: string }>;
  readonly selectedZone?: { readonly id: string; readonly name: string; readonly status?: string; readonly type?: string };
  readonly workerSubdomain?: string;
  readonly queues?: ReadonlyArray<{ readonly queue_id?: string; readonly queue_name?: string }>;
  readonly kvNamespaces?: ReadonlyArray<{ readonly id?: string; readonly title?: string }>;
  readonly durableObjectNamespaces?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly class?: string }>;
  readonly r2Buckets?: ReadonlyArray<{ readonly name?: string; readonly storage_class?: string }>;
  readonly secretsStores?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly tunnels?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly status?: string }>;
  readonly accessApplications?: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly domain?: string; readonly type?: string }>;
  readonly warnings: readonly string[];
}

export interface CloudflareProvisionResult {
  readonly ok: boolean;
  readonly dryRun: false;
  readonly steps: readonly CloudflareProvisionStep[];
  readonly account?: { readonly id: string; readonly name: string };
  readonly worker?: { readonly name: string; readonly baseUrl?: string; readonly subdomain?: string; readonly hostname?: string; readonly cron?: string };
  readonly queues?: { readonly queueName: string; readonly queueId: string; readonly deadLetterQueueName: string; readonly deadLetterQueueId: string; readonly consumerId?: string };
  readonly tunnel?: { readonly id: string; readonly name: string; readonly hostname?: string; readonly tokenRef?: string };
  readonly access?: { readonly appId?: string; readonly serviceTokenId?: string; readonly serviceTokenRef?: string };
  readonly dns?: {
    readonly zoneId: string;
    readonly zoneName?: string;
    readonly records: ReadonlyArray<{ readonly id?: string; readonly name?: string; readonly type?: string; readonly content?: string }>;
  };
  readonly kv?: { readonly namespaceName: string; readonly namespaceId: string };
  readonly durableObjects?: { readonly namespaceName: string; readonly namespaceId?: string };
  readonly r2?: { readonly bucketName: string; readonly storageClass: 'Standard' };
  readonly secretsStore?: { readonly storeName: string; readonly storeId: string };
  readonly verification?: CloudflareVerifyResult;
  /** Messages of steps that were skipped or failed; ok stays true for a partial run, so check this too. */
  readonly warnings?: readonly string[];
  readonly generatedSecrets?: {
    readonly workerClientToken?: string;
    readonly tunnelToken?: string;
    readonly accessServiceTokenClientId?: string;
    readonly accessServiceTokenClientSecret?: string;
  };
}

export interface CloudflareVerifyResult {
  readonly ok: boolean;
  readonly workerHealth: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string;
  };
  readonly daemonBatchProxy?: {
    readonly ok: boolean;
    readonly status: number;
    readonly error?: string;
  };
}

export interface CloudflareDisableResult {
  readonly ok: boolean;
  readonly steps: readonly CloudflareProvisionStep[];
  /** `disabled` only when every step at Cloudflare succeeded. */
  readonly remote: 'disabled' | 'not-disabled';
}

export interface CloudflareTokenRequirementsRequest {
  readonly components?: CloudflareComponentSelection;
  readonly includeBootstrap?: boolean;
}

export interface CloudflareOperationalTokenRequest extends CloudflareTokenRequirementsRequest {
  readonly accountId?: string;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly bootstrapToken?: string;
  readonly tokenName?: string;
  readonly expiresOn?: string;
  readonly persistConfig?: boolean;
  readonly storeApiToken?: boolean;
  readonly returnGeneratedToken?: boolean;
}

export interface CloudflareValidateRequest {
  readonly accountId?: string;
  readonly apiToken?: string;
  readonly apiTokenRef?: string;
}

export interface CloudflareDiscoverRequest extends CloudflareValidateRequest {
  readonly components?: CloudflareComponentSelection;
  readonly zoneId?: string;
  readonly zoneName?: string;
  readonly includeResources?: boolean;
}

export interface CloudflareProvisionRequest extends CloudflareDiscoverRequest {
  readonly workerName?: string;
  readonly workerSubdomain?: string;
  readonly workerHostname?: string;
  readonly workerBaseUrl?: string;
  readonly daemonBaseUrl?: string;
  readonly daemonHostname?: string;
  readonly queueName?: string;
  readonly deadLetterQueueName?: string;
  readonly tunnelName?: string;
  readonly tunnelId?: string;
  readonly tunnelServiceUrl?: string;
  readonly tunnelTokenRef?: string;
  readonly accessAppId?: string;
  readonly accessServiceTokenId?: string;
  readonly accessServiceTokenRef?: string;
  readonly kvNamespaceName?: string;
  readonly kvNamespaceId?: string;
  readonly durableObjectNamespaceName?: string;
  readonly r2BucketName?: string;
  readonly secretsStoreName?: string;
  readonly secretsStoreId?: string;
  readonly workerCron?: string;
  readonly operatorToken?: string;
  readonly operatorTokenRef?: string;
  readonly workerClientToken?: string;
  readonly workerClientTokenRef?: string;
  readonly storeApiToken?: boolean;
  readonly storeOperatorToken?: boolean;
  readonly storeWorkerClientToken?: boolean;
  readonly returnGeneratedSecrets?: boolean;
  readonly enableWorkersDev?: boolean;
  readonly queueJobPayloads?: boolean;
  readonly verify?: boolean;
  readonly persistConfig?: boolean;
  readonly batchMode?: CloudflareBatchMode;
}

export interface CloudflareVerifyRequest {
  readonly workerBaseUrl?: string;
  readonly workerClientToken?: string;
  readonly workerClientTokenRef?: string;
}

export interface CloudflareDisableRequest extends CloudflareValidateRequest {
  readonly workerName?: string;
  readonly disableWorkerSubdomain?: boolean;
  readonly disableCron?: boolean;
  readonly persistConfig?: boolean;
}

export class CloudflareDaemonRouteError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'CloudflareDaemonRouteError';
    this.status = status;
    this.code = code;
  }
}

export interface CloudflareDaemonClient {
  status(): Promise<CloudflareControlPlaneStatus>;
  tokenRequirements(input?: CloudflareTokenRequirementsRequest): Promise<CloudflareTokenRequirementsResult>;
  createOperationalToken(input: CloudflareOperationalTokenRequest): Promise<CloudflareOperationalTokenResult>;
  discover(input?: CloudflareDiscoverRequest): Promise<CloudflareDiscoverResult>;
  validate(input?: CloudflareValidateRequest): Promise<CloudflareValidateResult>;
  provision(input: CloudflareProvisionRequest): Promise<CloudflareProvisionResult>;
  verify(input?: CloudflareVerifyRequest): Promise<CloudflareVerifyResult>;
  disable(input?: CloudflareDisableRequest): Promise<CloudflareDisableResult>;
}

export interface CloudflareDaemonClientOptions {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly homeDirectory: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch | undefined;
}

/**
 * Where the Cloudflare routes are dialled: the same address every other operator
 * seam dials (scheme from the TLS mode, wildcard binds mapped to loopback), or
 * null when the daemon is disabled or no address is configured, so the bearer
 * token is never sent to a guessed scheme or port.
 */
export function resolveCloudflareDaemonBaseUrl(configManager: Pick<ConfigManager, 'get'>): string | null {
  return resolveDaemonBaseUrl(configManager);
}

export function buildDefaultCloudflareDaemonBaseUrl(configManager: Pick<ConfigManager, 'get'>): string | null {
  return resolveCloudflareDaemonBaseUrl(configManager);
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown = {};
  if (text.trim().length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      // A proxy or crashed route can answer with HTML or plain text; say what came back instead of a JSON syntax error.
      throw new CloudflareDaemonRouteError(
        `Cloudflare daemon route answered HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 200)}`,
        response.status,
        'CLOUDFLARE_DAEMON_ROUTE_ERROR',
      );
    }
  }
  if (!response.ok) {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const message = typeof record.error === 'string' ? record.error : `Cloudflare daemon route failed with HTTP ${response.status}`;
    const code = typeof record.code === 'string' ? record.code : 'CLOUDFLARE_DAEMON_ROUTE_ERROR';
    throw new CloudflareDaemonRouteError(message, response.status, code);
  }
  return body as T;
}

export function createCloudflareDaemonClient(options: CloudflareDaemonClientOptions): CloudflareDaemonClient {
  // Resolved per request through the one daemon resolver: nothing is minted for
  // a disabled daemon, the token override applies, and an unwritable state
  // directory is a refusal on the call that needed it, not a throw at construction.
  const requestJson = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const endpoint = resolveDaemonEndpoint({ configManager: options.configManager, homeDirectory: options.homeDirectory });
    if (!endpoint.available) {
      throw new CloudflareDaemonRouteError(
        `The daemon is not reachable from here: ${endpoint.reason}`,
        503,
        'CLOUDFLARE_DAEMON_UNAVAILABLE',
      );
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${endpoint.token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await (options.fetch ?? fetch)(`${endpoint.baseUrl}${path}`, { ...init, headers });
    return await readJsonResponse<T>(response);
  };

  const postJson = <T>(path: string, body: unknown): Promise<T> => requestJson<T>(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });

  return {
    status: () => requestJson<CloudflareControlPlaneStatus>('/api/cloudflare/status'),
    tokenRequirements: (input = {}) => postJson<CloudflareTokenRequirementsResult>('/api/cloudflare/token/requirements', input),
    createOperationalToken: (input) => postJson<CloudflareOperationalTokenResult>('/api/cloudflare/token/create', input),
    discover: (input = {}) => postJson<CloudflareDiscoverResult>('/api/cloudflare/discover', input),
    validate: (input = {}) => postJson<CloudflareValidateResult>('/api/cloudflare/validate', input),
    provision: (input) => postJson<CloudflareProvisionResult>('/api/cloudflare/provision', input),
    verify: (input = {}) => postJson<CloudflareVerifyResult>('/api/cloudflare/verify', input),
    disable: (input = {}) => postJson<CloudflareDisableResult>('/api/cloudflare/disable', input),
  };
}

export function normalizeCloudflareComponents(selection: CloudflareComponentSelection | undefined): Record<CloudflareComponent, boolean> {
  const result: Record<CloudflareComponent, boolean> = { ...DEFAULT_CLOUDFLARE_COMPONENT_SELECTION };
  for (const component of CLOUDFLARE_COMPONENT_IDS) {
    if (typeof selection?.[component] === 'boolean') result[component] = selection[component] === true;
  }
  return result;
}
