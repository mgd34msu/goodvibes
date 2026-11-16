/**
 * The owner's credential-env scrub setting, read where a command is spawned.
 *
 * `permissions.execEnvScrubAllowlist` lists variable NAMES a spawned command
 * keeps even though they look credential-bearing. Exec, scheduled commands and
 * trigger actions read it from the config manager at each spawn, so every
 * registry in the process (the main conversation and every spawned agent)
 * applies the same list, and a change applies to the next command.
 */
import type { ConfigManager } from '../../config/manager.js';
import type { ConfigKey } from '../../config/schema.js';
import type { CredentialEnvScrubConfig } from './credential-env.js';

/** The allowlist setting; a list of variable names, never values. */
export const EXEC_ENV_SCRUB_ALLOWLIST_KEY = 'permissions.execEnvScrubAllowlist' as ConfigKey;

/** The scrub the owner configured: the scrub stays on, with the configured names kept. One config read. */
export function configuredCredentialEnvScrub(configManager: Pick<ConfigManager, 'get'>): CredentialEnvScrubConfig {
  const raw: unknown = configManager.get(EXEC_ENV_SCRUB_ALLOWLIST_KEY);
  if (!Array.isArray(raw)) return {};
  return { allowlist: raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) };
}
