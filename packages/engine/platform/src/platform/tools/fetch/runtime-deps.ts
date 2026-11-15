import type { ConfigManager } from '../../config/manager.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import type { LocalhostFetchApproval } from '../../runtime/permissions/localhost-fetch-approval.js';
import type { FetchRuntimeDeps } from './runtime.js';

/**
 * Split a comma-separated host config value (fetch.trustedHosts / blockedHosts)
 * into a trimmed, non-empty host list. Returns undefined when empty so the fetch
 * runtime keeps its "no default list" semantics.
 */
function splitHostConfig(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined;
  const hosts = value
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return hosts.length > 0 ? hosts : undefined;
}

export interface ConfiguredFetchDepsOptions {
  readonly serviceRegistry: Pick<ServiceRegistry, 'resolveAuth'> | null | undefined;
  readonly featureFlags: Pick<FeatureFlagManager, 'isEnabled'> | null | undefined;
  readonly configManager: Pick<ConfigManager, 'get'>;
  /** The loopback-fetch admission, when the composition already has it. */
  readonly localhostFetchApproval?: LocalhostFetchApproval | undefined;
  /**
   * For a composition that builds its approval handlers after the fetch
   * consumers: read on every loopback request, which is refused until it
   * returns an approval.
   */
  readonly localhostFetchApprovalSource?: (() => LocalhostFetchApproval | undefined) | undefined;
}

/**
 * The fetch runtime's configuration-backed deps, in one place: the fetch tool
 * and every other consumer of the fetch runtime (web search evidence) apply the
 * same sanitize mode, trusted and blocked hosts and loopback approval. Settings
 * are read live, so a change applies to the next request.
 */
export function createConfiguredFetchDeps(options: ConfiguredFetchDepsOptions): FetchRuntimeDeps {
  const { configManager, localhostFetchApproval, localhostFetchApprovalSource } = options;
  const approveLocalhostFetch: LocalhostFetchApproval | undefined = localhostFetchApproval
    ?? (localhostFetchApprovalSource
      ? (input, context) => {
        const approval = localhostFetchApprovalSource();
        return approval ? approval(input, context) : Promise.resolve(false);
      }
      : undefined);
  return {
    serviceRegistry: options.serviceRegistry,
    featureFlags: options.featureFlags,
    defaultSanitizeMode: () => configManager.get('fetch.sanitizeMode'),
    defaultTrustedHosts: () => splitHostConfig(configManager.get('fetch.trustedHosts')),
    defaultBlockedHosts: () => splitHostConfig(configManager.get('fetch.blockedHosts')),
    isLocalhostAllowed: () => configManager.get('fetch.allowLocalhost'),
    ...(approveLocalhostFetch ? { approveLocalhostFetch } : {}),
  };
}
