import {
  classifyServiceSettingChange,
  type ServiceSettingChange,
  type ServiceSettingResult,
} from '@goodvibes-jev/engine/terminal-shell/service-setting-change';

import type { CliServiceRuntime } from '../cli/service-posture.ts';

export const AGENT_EXTERNAL_HOST_SERVICE_MESSAGE =
  'GoodVibes Agent uses a connected GoodVibes host and does not install, start, stop, restart, or uninstall it. Manage host lifecycle outside Agent.';

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
