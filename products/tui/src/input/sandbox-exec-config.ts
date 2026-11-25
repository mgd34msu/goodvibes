/**
 * sandbox-exec-config.ts, the readers of sandbox.egressAllowlist /
 * sandbox.workspaceWritable for the terminal app's exec gate
 * (permissions/sandbox-exec-gate.ts).
 *
 * Both are rows of the platform's settings schema (schema-domain-lists.ts),
 * edited in the one settings screen both programs show (terminal-shell
 * settings-screen) as a one-line list. The per-command exec sandbox reads the
 * same `sandbox` category at tool registration.
 */
import type { ConfigKey, ConfigManager } from '@goodvibes/engine/platform/platform/config';

export const SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY = 'sandbox.egressAllowlist' as ConfigKey;
export const SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY = 'sandbox.workspaceWritable' as ConfigKey;

const SANDBOX_EXEC_LIST_CONFIG_KEYS: ReadonlySet<ConfigKey> = new Set([
  SANDBOX_EGRESS_ALLOWLIST_CONFIG_KEY,
  SANDBOX_WORKSPACE_WRITABLE_CONFIG_KEY,
]);

/** True for the two sandbox exec-boundary list keys, whose stored value is a string array. */
export function isSandboxExecListConfigKey(key: ConfigKey): boolean {
  return SANDBOX_EXEC_LIST_CONFIG_KEYS.has(key);
}

/** Read a config value as a string array (non-array/malformed degrades to empty). */
export function readSandboxExecList(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): string[] {
  const raw = configManager.get(key);
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}
