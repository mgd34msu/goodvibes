import type { ConfigManager } from '../config/manager.js';
import type { CloudflareControlPlaneConfig } from './types.js';

/**
 * The `cloudflare.*` settings as one typed record. The config manager answers
 * every unset key with its schema default, so there is no fallback here.
 */
export function readCloudflareConfig(configManager: Pick<ConfigManager, 'get'>): CloudflareControlPlaneConfig {
  const get = configManager.get.bind(configManager);
  return {
    enabled: get('cloudflare.enabled'),
    freeTierMode: get('cloudflare.freeTierMode'),
    accountId: get('cloudflare.accountId'),
    apiTokenRef: get('cloudflare.apiTokenRef'),
    zoneId: get('cloudflare.zoneId'),
    zoneName: get('cloudflare.zoneName'),
    workerName: get('cloudflare.workerName'),
    workerSubdomain: get('cloudflare.workerSubdomain'),
    workerHostname: get('cloudflare.workerHostname'),
    workerBaseUrl: get('cloudflare.workerBaseUrl'),
    daemonBaseUrl: get('cloudflare.daemonBaseUrl'),
    daemonHostname: get('cloudflare.daemonHostname'),
    workerTokenRef: get('cloudflare.workerTokenRef'),
    workerClientTokenRef: get('cloudflare.workerClientTokenRef'),
    workerCron: get('cloudflare.workerCron'),
    queueName: get('cloudflare.queueName'),
    deadLetterQueueName: get('cloudflare.deadLetterQueueName'),
    tunnelName: get('cloudflare.tunnelName'),
    tunnelId: get('cloudflare.tunnelId'),
    tunnelTokenRef: get('cloudflare.tunnelTokenRef'),
    accessAppId: get('cloudflare.accessAppId'),
    accessServiceTokenId: get('cloudflare.accessServiceTokenId'),
    accessServiceTokenRef: get('cloudflare.accessServiceTokenRef'),
    kvNamespaceName: get('cloudflare.kvNamespaceName'),
    kvNamespaceId: get('cloudflare.kvNamespaceId'),
    durableObjectNamespaceName: get('cloudflare.durableObjectNamespaceName'),
    durableObjectNamespaceId: get('cloudflare.durableObjectNamespaceId'),
    r2BucketName: get('cloudflare.r2BucketName'),
    secretsStoreName: get('cloudflare.secretsStoreName'),
    secretsStoreId: get('cloudflare.secretsStoreId'),
    maxQueueOpsPerDay: get('cloudflare.maxQueueOpsPerDay'),
  };
}
