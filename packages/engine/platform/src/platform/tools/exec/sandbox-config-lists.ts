import { isAbsolute } from 'node:path';
import type { ConfigManager } from '../../config/manager.js';
import type { ExecSandboxConfig } from './sandbox.js';

/**
 * The sandbox lists come from a settings file a person can edit by hand, so a value that is not a list
 * (a bare "*" would match as an allow-all substring) or a relative path would otherwise reach the sandbox
 * unchecked. The write path refuses these; this keeps a hand-edited file from widening the sandbox.
 */
export function sandboxCommandNames(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [];
}

export function sandboxAbsolutePaths(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && isAbsolute(entry)) : [];
}

/** The sandbox settings as the exec tool reads them: live at each command, with the lists checked. */
export function createSandboxRuntimeConfig(configManager: ConfigManager): ExecSandboxConfig {
  return {
    get enabled() { return configManager.getCategory('sandbox').enabled; },
    get egressAllowlist() { return sandboxCommandNames(configManager.getCategory('sandbox').egressAllowlist); },
    get workspaceWritable() { return sandboxAbsolutePaths(configManager.getCategory('sandbox').workspaceWritable); },
    get daemonPort() {
      const port = configManager.get('controlPlane.port');
      return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : undefined;
    },
  };
}
