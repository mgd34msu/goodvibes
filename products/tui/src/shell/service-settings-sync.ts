import {
  classifyServiceSettingChange,
  type ServiceSettingChange,
  type ServiceSettingResult,
} from '@goodvibes-jev/engine/terminal-shell/service-setting-change';
import { mkdirSync } from 'node:fs';
import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { ManagedServiceStatus } from '@goodvibes-jev/engine/platform/platform/daemon';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { createPlatformServiceManager, getServiceStateRoot, type CliServiceRuntime } from '../cli/service-posture.ts';

type ManagedServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status';

export interface ServiceManagerLike {
  status(): ManagedServiceStatus;
  install(): ManagedServiceStatus;
  uninstall(): ManagedServiceStatus;
  start(): ManagedServiceStatus;
  stop(): ManagedServiceStatus;
  restart(): ManagedServiceStatus;
}

export type ServiceSettingsSyncChange = ServiceSettingChange;

export interface ServiceSettingsSyncResult extends ServiceSettingResult<ManagedServiceAction | 'install-start' | 'disable'> {
  readonly status?: ManagedServiceStatus;
}

/**
 * The service manager owns every platform command line (systemctl, launchctl,
 * schtasks) and the time limit on each; this file only decides which manager
 * action a setting change needs and reports the state the manager returns.
 */
export interface ServiceSettingsSyncOptions {
  readonly createManager?: (runtime: CliServiceRuntime) => ServiceManagerLike;
  readonly mkdir?: typeof mkdirSync;
}

/** The two keys whose values say whether an OS service should exist, as they were before the change. */
interface ServiceKeys {
  readonly autostart: unknown;
  readonly enabled: unknown;
}

const SERVICE_DEFINITION_KEYS = new Set<ConfigKey>([
  'service.restartOnFailure',
  'service.platform',
  'service.serviceName',
  'service.logPath',
] as ConfigKey[]);

function restoreKeys(runtime: CliServiceRuntime, keys: ServiceKeys): void {
  runtime.configManager.setDynamic('service.autostart', keys.autostart === true);
  runtime.configManager.setDynamic('service.enabled', keys.enabled === true);
}

function withLingerNote(message: string, status: ManagedServiceStatus): string {
  return status.lingerNote ? `${message}; ${status.lingerNote}` : message;
}

/**
 * A failed disable leaves the settings as they were before the change: the
 * toggle reads ON while the machine may still run the service, and turning it
 * off again retries.
 */
function disableSystemService(
  runtime: CliServiceRuntime,
  manager: ServiceManagerLike,
  keysBefore: ServiceKeys,
): ServiceSettingsSyncResult {
  const before = manager.status();
  let status = before;
  let action: 'stop' | 'disable' = 'disable';
  let error: string | undefined;
  // uninstall() stops what its definition names; a manual-platform process, or
  // a unit whose definition is already gone, is stopped by name first.
  if (before.running && (before.platform === 'manual' || !before.installed)) {
    status = manager.stop();
    action = 'stop';
    error = status.actionError ?? undefined;
  }
  if (!error && before.installed) {
    status = manager.uninstall();
    action = 'disable';
    error = status.actionError ?? undefined;
  }
  if (!error) return { handled: true, action: 'disable', status, message: 'OS service disabled' };
  restoreKeys(runtime, keysBefore);
  return {
    handled: true,
    action,
    status,
    message: `Service disable failed: ${error}. ${status.running ? 'The service is still running, so the' : 'The'} setting stays on; turning it off again retries`,
    error,
  };
}

/**
 * Turning the service on saves the setting before the OS install runs. When the
 * install or start fails, the definition install wrote is removed again and the
 * settings go back to where they were, so the toggle never reads OFF over an
 * installed service and turning it on again retries. When that removal fails
 * too, the settings stay on, because a service is installed.
 */
function enableSystemService(
  runtime: CliServiceRuntime,
  manager: ServiceManagerLike,
  options: ServiceSettingsSyncOptions,
  keysBefore: ServiceKeys,
): ServiceSettingsSyncResult {
  (options.mkdir ?? mkdirSync)(getServiceStateRoot(runtime), { recursive: true });
  const installed = manager.install();
  const failed = installed.actionError ? { action: 'install' as const, label: 'install', status: installed } : undefined;
  const started = failed ? undefined : manager.start();
  const failure = failed ?? (started?.actionError ? { action: 'install-start' as const, label: 'start', status: started } : undefined);
  if (!failure) {
    return {
      handled: true,
      action: 'install-start',
      status: started!,
      message: withLingerNote('OS service installed and started', installed),
    };
  }

  const error = failure.status.actionError!;
  const removed = failure.status.installed ? manager.uninstall() : failure.status;
  if (failure.status.installed && removed.actionError) {
    return {
      handled: true,
      action: failure.action,
      status: removed,
      message: `Service ${failure.label} failed: ${error}. The service is installed but could not be removed (${removed.actionError}), so the setting stays on`,
      error,
    };
  }
  restoreKeys(runtime, keysBefore);
  return {
    handled: true,
    action: failure.action,
    status: removed,
    message: `Service ${failure.label} failed: ${error}; the setting was turned back off, so turning it on again retries`,
    error,
  };
}

function refreshInstalledSystemService(
  runtime: CliServiceRuntime,
  manager: ServiceManagerLike,
): ServiceSettingsSyncResult {
  const before = manager.status();
  if (!before.installed && runtime.configManager.get('service.autostart') !== true) {
    return {
      handled: true,
      action: 'status',
      status: before,
      message: 'Service setting saved',
    };
  }

  const installed = manager.install();
  if (installed.actionError) {
    return {
      handled: true,
      action: 'install',
      status: installed,
      message: `Service update failed: ${installed.actionError}`,
      error: installed.actionError,
    };
  }

  const next = before.running ? manager.restart() : manager.start();
  const error = next.actionError ?? undefined;
  return {
    handled: true,
    action: before.running ? 'restart' : 'start',
    status: next,
    message: error ? `Service update failed: ${error}` : withLingerNote('OS service updated', installed),
    ...(error ? { error } : {}),
  };
}

export function syncServiceSettingToPlatform(
  runtime: CliServiceRuntime,
  change: ServiceSettingsSyncChange,
  options: ServiceSettingsSyncOptions = {},
): ServiceSettingsSyncResult {
  const classification = classifyServiceSettingChange(change);
  if (classification === 'unrelated') return { handled: false };
  if (classification === 'unchanged') return { handled: true, message: 'Service setting unchanged' };

  const manager = options.createManager?.(runtime) ?? createPlatformServiceManager(runtime);
  const config = runtime.configManager;
  // A manager action that throws (service management turned off, an unwritable
  // definition path) changed nothing on the machine, so the toggle goes back.
  let keysToRestore: ServiceKeys | undefined;

  try {
    if (change.key === 'service.enabled') {
      const keysBefore = { autostart: config.get('service.autostart'), enabled: change.previousValue };
      if (change.value === false) {
        keysToRestore = keysBefore;
        if (config.get('service.autostart') === true) config.setDynamic('service.autostart', false);
        return disableSystemService(runtime, manager, keysBefore);
      }
      if (config.get('service.autostart') === true) {
        keysToRestore = keysBefore;
        return enableSystemService(runtime, manager, options, keysBefore);
      }
      return {
        handled: true,
        action: 'status',
        status: manager.status(),
        message: 'Service mode saved; enable autostart to install the OS service',
      };
    }

    if (SERVICE_DEFINITION_KEYS.has(change.key)) {
      if (config.get('service.enabled') === true && config.get('service.autostart') === true) {
        return refreshInstalledSystemService(runtime, manager);
      }
      return {
        handled: true,
        action: 'status',
        status: manager.status(),
        message: 'Service setting saved; enable autostart to install the OS service',
      };
    }
  } catch (error) {
    const summarized = summarizeError(error);
    logger.error('Settings service sync failed', { key: change.key, error: summarized });
    if (keysToRestore) restoreKeys(runtime, keysToRestore);
    let status: ManagedServiceStatus | undefined;
    try { status = manager.status(); } catch { /* the error above is the account */ }
    return {
      handled: true,
      action: 'status',
      ...(status ? { status } : {}),
      message: `Service sync failed: ${summarized}${keysToRestore ? '; the setting was put back' : ''}`,
      error: summarized,
    };
  }

  return { handled: false };
}
