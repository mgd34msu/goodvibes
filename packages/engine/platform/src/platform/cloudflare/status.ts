import type { CloudflareProvisionedResources } from './provisioned.js';
import type { CloudflareTunnelConnectorStatus } from './tunnel-connector.js';
import type {
  CloudflareControlPlaneConfig,
  CloudflareControlPlaneStatus,
  CloudflareResolvedSecret,
} from './types.js';

export interface BuildCloudflareStatusInput {
  readonly config: CloudflareControlPlaneConfig;
  readonly apiToken: CloudflareResolvedSecret;
  readonly workerToken: CloudflareResolvedSecret;
  readonly workerClientToken: CloudflareResolvedSecret;
  /** What provisioning created; resources count as configured only from here. */
  readonly provisioned: CloudflareProvisionedResources | null;
  readonly tunnelConnector?: CloudflareTunnelConnectorStatus | undefined;
}

export function buildCloudflareControlPlaneStatus(input: BuildCloudflareStatusInput): CloudflareControlPlaneStatus {
  const record = input.provisioned && input.provisioned.accountId === input.config.accountId ? input.provisioned : null;
  const configured = {
    accountId: input.config.accountId.length > 0,
    apiToken: input.apiToken.value !== null,
    zone: input.config.zoneId.length > 0 || input.config.zoneName.length > 0,
    workerName: Boolean(record?.worker),
    daemonBaseUrl: input.config.daemonBaseUrl.length > 0,
    daemonHostname: input.config.daemonHostname.length > 0,
    workerBaseUrl: input.config.workerBaseUrl.length > 0,
    workerHostname: input.config.workerHostname.length > 0,
    queueName: Boolean(record?.queues),
    deadLetterQueueName: Boolean(record?.queues),
    workerToken: input.workerToken.value !== null,
    workerClientToken: input.workerClientToken.value !== null,
    tunnel: Boolean(record?.tunnel),
    access: Boolean(record?.access),
    kv: Boolean(record?.kv),
    durableObjects: Boolean(record?.durableObjects),
    r2: Boolean(record?.r2),
    secretsStore: Boolean(record?.secretsStore),
  };
  const warnings: string[] = [];
  if (input.config.enabled && !configured.apiToken) warnings.push('Cloudflare is enabled but no API token is configured.');
  if (input.config.enabled && !configured.daemonBaseUrl) warnings.push('Cloudflare is enabled but no daemonBaseUrl is configured for Worker-to-daemon calls.');
  if (input.config.enabled && !configured.workerToken) warnings.push('Cloudflare is enabled but no Worker-to-daemon operator token is configured.');
  if (input.config.enabled && !configured.workerClientToken) warnings.push('Cloudflare Worker client auth is not configured; provisioning will generate one.');
  if (input.config.enabled && !configured.workerName) warnings.push('Cloudflare is enabled but no Worker has been provisioned from this daemon; run /cloudflare provision.');
  if (record?.worker?.daemonCredential === 'removed') warnings.push('The Worker no longer holds the daemon credential (it was disabled); provision again to restore it.');
  const connector = input.tunnelConnector;
  if (configured.tunnel && connector && connector.state !== 'connected') {
    warnings.push(`The Cloudflare Tunnel connector is ${connector.state}: ${connector.detail}${connector.next?.[0] ? ` Next: ${connector.next[0]}.` : ''}`);
  }
  const ready = input.config.enabled &&
    configured.accountId &&
    configured.apiToken &&
    configured.workerName &&
    configured.daemonBaseUrl &&
    configured.workerBaseUrl &&
    configured.queueName &&
    configured.deadLetterQueueName &&
    configured.workerToken &&
    (!configured.tunnel || !connector || connector.state === 'connected');
  return {
    enabled: input.config.enabled,
    ready,
    configured,
    config: input.config,
    warnings,
    ...(connector ? { tunnelConnector: connector } : {}),
  };
}
