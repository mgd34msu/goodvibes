/**
 * This terminal's client for the daemon's Cloudflare routes. The shapes and the
 * route client are shared with the Agent (terminal-shell); this file supplies
 * the daemon this terminal dials and the bearer it presents.
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { createCloudflareRouteClient, type CloudflareDaemonClient } from '@goodvibes/engine/terminal-shell/cloudflare-control-plane';
import { resolveDaemonBaseUrl, resolveDaemonEndpoint } from './client/operator-endpoint.ts';

export {
  CLOUDFLARE_COMPONENT_IDS,
  CLOUDFLARE_COMPONENT_LABELS,
  CloudflareDaemonRouteError,
  DEFAULT_CLOUDFLARE_COMPONENT_SELECTION,
  normalizeCloudflareComponents,
  type CloudflareBatchMode,
  type CloudflareComponent,
  type CloudflareComponentSelection,
  type CloudflareControlPlaneStatus,
  type CloudflareDaemonClient,
  type CloudflareDisableRequest,
  type CloudflareDisableResult,
  type CloudflareDiscoverRequest,
  type CloudflareDiscoverResult,
  type CloudflareOperationalTokenRequest,
  type CloudflareOperationalTokenResult,
  type CloudflareProvisionRequest,
  type CloudflareProvisionResult,
  type CloudflareProvisionStep,
  type CloudflareTokenRequirement,
  type CloudflareTokenRequirementsRequest,
  type CloudflareTokenRequirementsResult,
  type CloudflareValidateRequest,
  type CloudflareValidateResult,
  type CloudflareVerifyRequest,
  type CloudflareVerifyResult,
} from '@goodvibes/engine/terminal-shell/cloudflare-control-plane';

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

export function createCloudflareDaemonClient(options: CloudflareDaemonClientOptions): CloudflareDaemonClient {
  // Resolved per request through the one daemon resolver: nothing is minted for
  // a disabled daemon, the token override applies, and an unwritable state
  // directory is a refusal on the call that needed it, not a throw at construction.
  return createCloudflareRouteClient({
    resolveEndpoint: () => resolveDaemonEndpoint({ configManager: options.configManager, homeDirectory: options.homeDirectory }),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
