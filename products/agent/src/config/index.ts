/**
 * Config system barrel export.
 *
 * Provides:
 * - ConfigManager class and all schema types
 * - Pure helpers that derive values from an explicit ConfigManager instance
 */

export { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
export { AgentConfigManager, AGENT_NOTIFICATIONS_METADATA_ONLY_KEY, AGENT_HOSTED_RESEARCH_SCREENING_KEY } from './host-settings.ts';
export type { DeepReadonly } from '@goodvibes-jev/engine/platform/platform/config';
export type { GoodVibesConfig, ConfigKey, ConfigValue, ConfigSetting, PermissionMode, PermissionAction, PermissionsToolConfig, NotificationsConfig } from '@goodvibes-jev/engine/platform/platform/config';
export { DEFAULT_CONFIG, CONFIG_SCHEMA } from '@goodvibes-jev/engine/platform/platform/config';
export { ConfigError } from '@goodvibes-jev/engine/platform/platform/types';

import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { GoodVibesConfig } from '@goodvibes-jev/engine/platform/platform/config';
import { getProviderIdFromModel } from './provider-model.ts';

export function getConfigSnapshot(configManager: Pick<ConfigManager, 'getRaw'>): Readonly<GoodVibesConfig> {
  return configManager.getRaw();
}

export function getConfiguredModelId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.model');
}

export function getConfiguredProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return getProviderIdFromModel(configManager.get('provider.model'));
}

export function getConfiguredEmbeddingProviderId(configManager: Pick<ConfigManager, 'get'>): string {
  return configManager.get('provider.embeddingProvider');
}

export function isAutoApproveEnabled(configManager: Pick<ConfigManager, 'get'>): boolean {
  return configManager.get('behavior.autoApprove');
}

export function getWorkingDirectory(configManager: Pick<ConfigManager, 'getWorkingDirectory'>): string | null {
  return configManager.getWorkingDirectory();
}

export { getConfiguredApiKeys, getConfiguredSystemPrompt, resolveApiKeys } from '@goodvibes-jev/engine/platform/platform/config';

// The daemon-client credential STATUS read (secret-free, honest-degrade).
// Value reads above stay local/env; only the status VISIBILITY path moves to the daemon.
export {
  deriveCredentialAvailability,
  fetchDaemonCredentialAvailability,
} from './credential-status.ts';
export type {
  CredentialAvailability,
  CredentialStatusConnection,
  CredentialStatusEntry,
} from './credential-status.ts';
