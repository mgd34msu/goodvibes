import type { CloudflareComponent } from './types.js';

// Default resource names live in the config schema (DEFAULT_CONFIG.cloudflare);
// readCloudflareConfig returns them for any key nobody set.

/** The Durable Object class the uploaded Worker module exports. Fixed by the module source, not a setting. */
export const COORDINATOR_CLASS_NAME = 'GoodVibesCoordinator';

export const CLOUDFLARE_API_TOKEN_KEY = 'CLOUDFLARE_API_TOKEN';
export const CLOUDFLARE_TUNNEL_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_TUNNEL_TOKEN';
export const CLOUDFLARE_ACCESS_SERVICE_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_ACCESS_SERVICE_TOKEN';
export const CLOUDFLARE_WORKER_CLIENT_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_WORKER_TOKEN';
export const CLOUDFLARE_WORKER_OPERATOR_TOKEN_KEY = 'GOODVIBES_CLOUDFLARE_OPERATOR_TOKEN';

/** Worker secret and binding names the uploaded module reads. */
export const WORKER_OPERATOR_TOKEN_SECRET = 'GOODVIBES_OPERATOR_TOKEN';
export const WORKER_CLIENT_TOKEN_SECRET = 'GOODVIBES_WORKER_TOKEN';
export const WORKER_ACCESS_CLIENT_ID_SECRET = 'GOODVIBES_ACCESS_CLIENT_ID';
export const WORKER_ACCESS_CLIENT_SECRET_SECRET = 'GOODVIBES_ACCESS_CLIENT_SECRET';
/** Secrets Store bindings: the same credentials, read from the account's Secrets Store instead of the script. */
export const WORKER_OPERATOR_TOKEN_STORE_BINDING = 'GOODVIBES_OPERATOR_TOKEN_STORE';
export const WORKER_ACCESS_CLIENT_SECRET_STORE_BINDING = 'GOODVIBES_ACCESS_CLIENT_SECRET_STORE';

export const COMPONENT_ORDER: readonly CloudflareComponent[] = [
  'workers',
  'queues',
  'zeroTrustTunnel',
  'zeroTrustAccess',
  'dns',
  'kv',
  'durableObjects',
  'secretsStore',
  'r2',
];

export const DEFAULT_COMPONENTS: Readonly<Record<CloudflareComponent, boolean>> = {
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
