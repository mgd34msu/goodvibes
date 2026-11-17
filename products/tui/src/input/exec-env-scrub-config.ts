/**
 * exec-env-scrub-config.ts, the settings-modal entry for
 * permissions.execEnvScrubAllowlist.
 *
 * The engine's credential-env scrub removes credential-bearing variable NAMES
 * (AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN, OPENAI_API_KEY, ...) from the environment
 * of every spawned command. Exec, scheduled commands and trigger actions read
 * this allowlist from config at each spawn (tools/exec/credential-env-config.ts),
 * so a change applies to the next command. The scrub itself stays on: this entry
 * edits ONLY the allowlist, variable NAMES kept even though they look
 * credential-bearing (case-insensitive), for a command that genuinely needs one
 * (e.g. a CI runner re-reading its own signing key). Never a value.
 *
 * The key has no CONFIG_SCHEMA row (it is a product-owned leaf the config
 * manager admits), so the modal lists it as a synthetic entry, like
 * worktree.setup.*. It is stored as a JSON array of strings and edited as a
 * comma-separated list in the single-line editor, parsed back into an array on
 * commit (settings-modal-commit.ts). The key and the reader are the engine's,
 * so the modal shows exactly the list commands get.
 */
import type { ConfigKey, ConfigManager, ConfigSetting } from '@goodvibes-jev/engine/platform/platform/config';
import { EXEC_ENV_SCRUB_ALLOWLIST_KEY, configuredCredentialEnvScrub } from '@goodvibes-jev/engine/platform/platform/tools';
import type { SettingEntry, SettingsCategory } from './settings-modal-types.ts';

export const EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY: ConfigKey = EXEC_ENV_SCRUB_ALLOWLIST_KEY;

/** True for the exec env-scrub allowlist key, whose stored value is a string array edited as a comma-separated list. */
export function isExecEnvScrubAllowlistConfigKey(key: ConfigKey): boolean {
  return key === EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY;
}

/** Read the allowlist as a string array (non-array/malformed/unset degrades to empty), the same reading a spawn applies. */
export function readExecEnvScrubAllowlist(configManager: Pick<ConfigManager, 'get'>): string[] {
  return [...(configuredCredentialEnvScrub(configManager).allowlist ?? [])];
}

/** Parse a comma-separated edit-buffer submission back into a string array (trimmed, empties dropped). Same convention as worktree.setup.* / sandbox.egressAllowlist. */
export function parseExecEnvScrubAllowlistInput(text: string): string[] {
  return text.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

export const EXEC_ENV_SCRUB_ALLOWLIST_SYNTHETIC_SETTING: ConfigSetting = {
  key: EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY,
  type: 'string',
  default: [],
  description: 'Comma-separated environment variable NAMES always kept in a spawned exec command\'s environment even when the name looks credential-bearing (case-insensitive). Names only: this never inspects or reports values. The scrub itself stays on; this only widens what it lets through, from the next command. Empty = the built-in credential-name scrub applies with no extra exceptions.',
};

/** Build the synthetic SettingEntry for permissions.execEnvScrubAllowlist. */
export function buildExecEnvScrubAllowlistSyntheticEntry(configManager: Pick<ConfigManager, 'get'>): SettingEntry {
  const currentValue = readExecEnvScrubAllowlist(configManager);
  return {
    setting: EXEC_ENV_SCRUB_ALLOWLIST_SYNTHETIC_SETTING,
    currentValue,
    isDefault: currentValue.length === 0,
  };
}

/**
 * Inject the synthetic entry into the permissions category's SettingEntry
 * list, idempotently. No-op when the category isn't present in `groups`.
 */
export function injectExecEnvScrubSyntheticEntry(
  groups: Map<SettingsCategory, SettingEntry[]>,
  configManager: Pick<ConfigManager, 'get'>,
): void {
  const permissionsEntries = groups.get('permissions');
  if (!permissionsEntries) return;
  if (!permissionsEntries.some((e) => e.setting.key === EXEC_ENV_SCRUB_ALLOWLIST_CONFIG_KEY)) {
    permissionsEntries.push(buildExecEnvScrubAllowlistSyntheticEntry(configManager));
  }
}
