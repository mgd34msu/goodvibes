import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { effectivePermissionMode, presetForMode } from '@goodvibes-jev/engine/sdk/platform/gate';

/** Display the same canonical preset the permission owner applies. */
export function describePermissionMode(mode: unknown): { readonly label: string; readonly detail: string } {
  const preset = presetForMode(typeof mode === 'string' ? mode : undefined);
  return { label: preset.label, detail: preset.summary };
}

export function describeConfiguredPermissions(config: Pick<ConfigManager, 'get'>) {
  return describePermissionMode(effectivePermissionMode(config.get('permissions.mode'), config.get('behavior.autoApprove') === true));
}
