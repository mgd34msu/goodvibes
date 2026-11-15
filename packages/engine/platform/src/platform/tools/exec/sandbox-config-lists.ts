import type { ConfigManager } from '../../config/manager.js';
import { listConfigSettings } from '../../config/schema-domain-lists.js';
import type { ListConfigKey } from '../../config/schema-types-lists.js';
import type { ExecSandboxConfig } from './sandbox.js';

/**
 * The sandbox lists come from a settings file a person can edit by hand, so a value that is not a list
 * (a bare "*" would match as an allow-all substring) or a relative path would otherwise reach the sandbox
 * unchecked. The rule for an entry is the settings row's own validator, the one a write is admitted by;
 * an entry it rejects is left out (the safe side) and named, so the result can say it was ignored.
 */
interface CheckedList {
  readonly entries: string[];
  readonly ignored: string[];
}

function checkedList(key: ListConfigKey, value: unknown): CheckedList {
  const setting = listConfigSettings.find((row) => row.key === key);
  const hint = setting?.validationHint ?? 'a list';
  if (value === undefined) return { entries: [], ignored: [] };
  if (!Array.isArray(value)) return { entries: [], ignored: [`${key} ignored whole: not a list (expects ${hint})`] };
  const entries: string[] = [];
  const ignored: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && (setting?.validate?.([entry]) ?? true)) entries.push(entry);
    else ignored.push(`${key} entry ${JSON.stringify(entry)} ignored (expects ${hint})`);
  }
  return { entries, ignored };
}

export function sandboxCommandNames(value: unknown): string[] {
  return checkedList('sandbox.egressAllowlist', value).entries;
}

export function sandboxAbsolutePaths(value: unknown): string[] {
  return checkedList('sandbox.workspaceWritable', value).entries;
}

/** The sandbox settings as the exec tool reads them: live at each command, with the lists checked. */
export function createSandboxRuntimeConfig(configManager: ConfigManager): ExecSandboxConfig {
  const egress = (): CheckedList => checkedList('sandbox.egressAllowlist', configManager.getCategory('sandbox').egressAllowlist);
  const writable = (): CheckedList => checkedList('sandbox.workspaceWritable', configManager.getCategory('sandbox').workspaceWritable);
  return {
    get enabled() { return configManager.getCategory('sandbox').enabled; },
    get egressAllowlist() { return egress().entries; },
    get workspaceWritable() { return writable().entries; },
    get ignoredEntries() { return [...egress().ignored, ...writable().ignored]; },
    get daemonPort() {
      const port = configManager.get('controlPlane.port');
      return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : undefined;
    },
  };
}
