import {
  classifyServiceSettingChange,
  type ServiceSettingChange,
  type ServiceSettingResult,
} from '@goodvibes/engine/terminal-shell/service-setting-change';

import type { CliServiceRuntime } from '../cli/service-posture.ts';

/**
 * The Agent's one host-lifecycle rule, stated where a service setting is refused:
 * it brings the daemon up (a stopped installed service at launch; install and
 * start when the owner accepts the repair question) and never reconfigures,
 * stops, restarts or removes it.
 */
export const AGENT_EXTERNAL_HOST_SERVICE_MESSAGE =
  'This setting was not changed. GoodVibes Agent starts an installed GoodVibes daemon service it finds stopped at launch, and installs and starts it when you accept the start-up repair question; it does not change the service\'s settings, stop, restart or uninstall it. Manage the rest of the host lifecycle outside Agent with goodvibes-daemon (install-service, start-service, stop-service, restart-service, uninstall-service) or the GoodVibes TUI.';

export type ServiceSettingsSyncChange = ServiceSettingChange;

export type ServiceSettingsSyncResult = ServiceSettingResult<'connected-host-blocked' | 'unchanged'>;

export interface ServiceSettingsSyncOptions {
  readonly allowExternalHostMutation?: false;
}

export function syncServiceSettingToPlatform(
  runtime: CliServiceRuntime,
  change: ServiceSettingsSyncChange,
  _options: ServiceSettingsSyncOptions = {},
): ServiceSettingsSyncResult {
  const classification = classifyServiceSettingChange(change);
  if (classification === 'unrelated') return { handled: false };
  if (classification === 'unchanged') {
    return {
      handled: true,
      action: 'unchanged',
      message: 'Connected-host setting unchanged',
    };
  }

  runtime.configManager.setDynamic(change.key, change.previousValue);
  return {
    handled: true,
    action: 'connected-host-blocked',
    message: AGENT_EXTERNAL_HOST_SERVICE_MESSAGE,
    error: 'connected_host_lifecycle_external',
  };
}
